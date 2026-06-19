// Google Drive клиент для выгрузки звонков (фича «папка по оплате»).
//
// Авторизация — OAuth от имени пользователя (refresh-token), область `drive.file`
// (доступ только к файлам/папкам, которые создаёт само приложение). Поэтому
// корневую папку приложение создаёт и владеет САМО — писать в чужую, заранее
// созданную папку область drive.file не позволяет. См. Фазу 0 / dev_docs.
//
// Env:
//   GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN
//   GDRIVE_ROOT_FOLDER_NAME (опц., по умолчанию «Оплаты Коммерсы»)

import { drive as driveApi, auth as gauth } from "@googleapis/drive";
import type { drive_v3 } from "@googleapis/drive";
import { Readable } from "node:stream";

const DEFAULT_ROOT_NAME = "Оплаты Коммерсы";

// Лениво-инициализируемый singleton — токен/клиент создаём один раз на процесс.
let driveSingleton: drive_v3.Drive | null = null;

function getDrive(): drive_v3.Drive {
  if (driveSingleton) return driveSingleton;

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Google Drive не настроен: нужны GOOGLE_OAUTH_CLIENT_ID / " +
        "GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REFRESH_TOKEN",
    );
  }

  const oauth2 = new gauth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });
  driveSingleton = driveApi({ version: "v3", auth: oauth2 });
  return driveSingleton;
}

/** Настроен ли Drive (есть ли все три OAuth-переменные). Дёшево, без сети. */
export function isGdriveConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_OAUTH_CLIENT_ID &&
      process.env.GOOGLE_OAUTH_CLIENT_SECRET &&
      process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
  );
}

// Экранируем апостроф в значении для Drive query language (q=name = '...').
function escapeQ(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** Найти папку по точному имени (среди созданных приложением — drive.file видит
 *  только свои), иначе создать. Возвращает folderId. Идемпотентно. */
export async function ensureFolder(name: string, parentId?: string): Promise<string> {
  const drive = getDrive();
  const qParts = [
    "mimeType = 'application/vnd.google-apps.folder'",
    "trashed = false",
    `name = '${escapeQ(name)}'`,
    parentId ? `'${escapeQ(parentId)}' in parents` : null,
  ].filter(Boolean);

  const found = await drive.files.list({
    q: qParts.join(" and "),
    fields: "files(id, name)",
    pageSize: 1,
    spaces: "drive",
  });
  const existing = found.data.files?.[0]?.id;
  if (existing) return existing;

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      ...(parentId ? { parents: [parentId] } : {}),
    },
    fields: "id",
  });
  if (!created.data.id) throw new Error(`Drive: не удалось создать папку «${name}»`);
  return created.data.id;
}

/** Корневая папка приложения (создаётся один раз, дальше переиспользуется). */
export async function ensureRootFolder(): Promise<string> {
  const name = process.env.GDRIVE_ROOT_FOLDER_NAME || DEFAULT_ROOT_NAME;
  return ensureFolder(name);
}

/** Есть ли уже файл с таким именем в папке (для пропуска повторной заливки). */
export async function fileExists(parentId: string, name: string): Promise<boolean> {
  const drive = getDrive();
  const res = await drive.files.list({
    q: `name = '${escapeQ(name)}' and '${escapeQ(parentId)}' in parents and trashed = false`,
    fields: "files(id)",
    pageSize: 1,
    spaces: "drive",
  });
  return Boolean(res.data.files?.length);
}

/** Залить файл в папку. body — Buffer или Readable. Возвращает fileId. */
export async function uploadFile(
  parentId: string,
  name: string,
  mimeType: string,
  body: Buffer | Readable,
): Promise<string> {
  const drive = getDrive();
  const stream = Buffer.isBuffer(body) ? Readable.from(body) : body;
  const created = await drive.files.create({
    requestBody: { name, parents: [parentId] },
    media: { mimeType, body: stream },
    fields: "id",
  });
  if (!created.data.id) throw new Error(`Drive: не удалось залить файл «${name}»`);
  return created.data.id;
}
