// Smoke-test записи на Google Drive под OAuth (Фаза 0, после получения токена).
//
// Повторяет реальную форму выгрузки:
//   1. найти/создать корневую папку приложения ("Оплаты Коммерсы");
//   2. создать подпапку контакта "{Имя} {дата оплаты}";
//   3. залить аудио (бинарь) и транскрипт (.txt).
// Проверяет, что OAuth-доступ под `drive.file` реально пишет файлы в твой диск.
//
//   npx tsx scripts/smoke-gdrive-oauth.ts

import { config } from "dotenv";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { drive as driveApi, auth as gauth } from "@googleapis/drive";

config({ path: resolve(process.cwd(), ".env.local") });

const ROOT_FOLDER_NAME = "Оплаты Коммерсы";

async function main() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Нет GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN в .env.local");
  }

  const oauth2 = new gauth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });
  const drive = driveApi({ version: "v3", auth: oauth2 });

  // helper: найти папку по имени среди созданных приложением (drive.file видит
  // только свои файлы), иначе создать.
  async function ensureFolder(name: string, parentId?: string): Promise<string> {
    const q = [
      "mimeType = 'application/vnd.google-apps.folder'",
      "trashed = false",
      `name = '${name.replace(/'/g, "\\'")}'`,
      parentId ? `'${parentId}' in parents` : null,
    ].filter(Boolean).join(" and ");
    const found = await drive.files.list({ q, fields: "files(id,name)", pageSize: 1 });
    if (found.data.files?.[0]?.id) return found.data.files[0].id!;
    const created = await drive.files.create({
      requestBody: {
        name,
        mimeType: "application/vnd.google-apps.folder",
        ...(parentId ? { parents: [parentId] } : {}),
      },
      fields: "id",
    });
    return created.data.id!;
  }

  console.log("[1/4] Корневая папка приложения…");
  const rootId = await ensureFolder(ROOT_FOLDER_NAME);
  console.log("   ✓", ROOT_FOLDER_NAME, "→", rootId);

  console.log("[2/4] Подпапка контакта…");
  const contactFolderId = await ensureFolder("SMOKE Иван Петров 2026-06-15", rootId);
  console.log("   ✓ folder id:", contactFolderId);

  console.log("[3/4] Заливаю «аудио» (бинарь)…");
  const fakeAudio = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x01, 0x02, 0x03]);
  const audio = await drive.files.create({
    requestBody: { name: "2026-06-10_14-30_outgoing.mp3", parents: [contactFolderId] },
    media: { mimeType: "audio/mpeg", body: Readable.from(fakeAudio) },
    fields: "id, size",
  });
  console.log("   ✓ audio id:", audio.data.id, "| size:", audio.data.size);

  console.log("[4/4] Заливаю транскрипт (.txt)…");
  const txt = await drive.files.create({
    requestBody: { name: "2026-06-10_14-30_outgoing.txt", parents: [contactFolderId] },
    media: { mimeType: "text/plain", body: Readable.from("[Продавец]: Алло\n[Клиент]: Да\n") },
    fields: "id",
  });
  console.log("   ✓ txt id:", txt.data.id);

  console.log("\nСсылка на папку контакта:");
  console.log("   https://drive.google.com/drive/folders/" + contactFolderId);
  console.log("\n✅ OAuth-запись на Drive работает. Тестовую подпапку «SMOKE …» удали вручную.");
}

main().catch((e) => {
  console.error("\n❌ Smoke-тест упал:", e instanceof Error ? e.message : e);
  process.exit(1);
});
