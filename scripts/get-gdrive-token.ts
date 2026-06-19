// Разовое получение Google OAuth refresh-token для выгрузки звонков на Drive.
//
// Приложение будет работать ОТ ИМЕНИ твоего Google-аккаунта (файлы — в твоём
// хранилище). Область доступа — минимальная `drive.file`: доступ только к
// файлам/папкам, которые создаёт само приложение.
//
// ── Перед запуском (в Google Cloud Console, тот же проект, что и раньше) ──
//   1. APIs & Services → OAuth consent screen:
//        • User type: External → создать.
//        • Заполни обязательные поля (название, твой email) → Save.
//        • PUBLISH APP (Publish to production) → Confirm. Это убирает
//          7-дневный срок жизни refresh-token. Для `drive.file` (не
//          «чувствительная» область) проверка Google НЕ требуется.
//   2. APIs & Services → Credentials → Create credentials → OAuth client ID:
//        • Application type: **Desktop app** → Create.
//        • Скопируй Client ID и Client secret.
//   3. Положи их в .env.local:
//        GOOGLE_OAUTH_CLIENT_ID=...
//        GOOGLE_OAUTH_CLIENT_SECRET=...
//
// ── Запуск ──
//   npx tsx scripts/get-gdrive-token.ts
//   → скрипт напечатает ссылку. Открой её в браузере, войди под нужным
//     аккаунтом, разреши доступ. Браузер вернётся на http://localhost — скрипт
//     поймает код и напечатает GOOGLE_OAUTH_REFRESH_TOKEN. Скопируй его в
//     .env.local (и в прод).

import { config } from "dotenv";
import { resolve } from "node:path";
import http from "node:http";
import { auth as gauth } from "@googleapis/drive";

config({ path: resolve(process.cwd(), ".env.local") });

const PORT = 53682; // фиксированный порт для loopback-редиректа
const REDIRECT_URI = `http://localhost:${PORT}`;
const SCOPE = "https://www.googleapis.com/auth/drive.file";

async function main() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "Нет GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET в .env.local.\n" +
      "Создай OAuth client ID типа «Desktop app» (см. шапку файла) и впиши их.",
    );
  }

  const oauth2 = new gauth.OAuth2(clientId, clientSecret, REDIRECT_URI);
  const url = oauth2.generateAuthUrl({
    access_type: "offline",       // нужен refresh-token
    prompt: "consent",            // форсируем выдачу refresh-token даже при повторе
    scope: [SCOPE],
  });

  console.log("\n1) Открой эту ссылку в браузере и разреши доступ:\n");
  console.log("   " + url + "\n");
  console.log("2) После подтверждения браузер вернётся на localhost — жду код…\n");

  const code = await new Promise<string>((resolveCode, rejectCode) => {
    const server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url ?? "/", REDIRECT_URI);
        const c = u.searchParams.get("code");
        const err = u.searchParams.get("error");
        if (err) {
          res.end("Ошибка авторизации: " + err + ". Можно закрыть вкладку.");
          server.close();
          rejectCode(new Error(err));
          return;
        }
        if (!c) { res.statusCode = 400; res.end("Нет ?code"); return; }
        res.end("Готово! Токен получен. Можно закрыть эту вкладку и вернуться в терминал.");
        server.close();
        resolveCode(c);
      } catch (e) {
        rejectCode(e instanceof Error ? e : new Error(String(e)));
      }
    });
    server.listen(PORT);
    server.on("error", rejectCode);
  });

  const { tokens } = await oauth2.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      "Google не вернул refresh_token. Обычно это значит, что доступ уже был\n" +
      "выдан ранее. Зайди на https://myaccount.google.com/permissions, удали\n" +
      "доступ этого приложения и запусти скрипт снова.",
    );
  }

  console.log("\n✅ Готово. Добавь в .env.local и в прод:\n");
  console.log("GOOGLE_OAUTH_REFRESH_TOKEN=" + tokens.refresh_token + "\n");
}

main().catch((e) => {
  console.error("\n❌ Не получилось:", e instanceof Error ? e.message : e);
  process.exit(1);
});
