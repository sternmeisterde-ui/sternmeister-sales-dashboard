/**
 * Минимальный read-only клиент Google Sheets под сервис-аккаунт.
 *
 * Единственная задача — прочитать диапазон значений из таблицы eNPS.
 * Сознательно без @googleapis/*: OAuth2-flow сервис-аккаунта — это один
 * подписанный JWT (RS256) + обмен на access token, node:crypto достаточно.
 *
 * ⚠️ Почему через ДОЧЕРНИЙ процесс, а не обычный fetch/https в этом же процессе:
 * на прод-хосте (self-hosted Dokploy) ЛЮБОЙ запрос к `sheets.googleapis.com`
 * из процесса Next-приложения приходит на домен-парковочный сервер
 * (`HTTP 400 <ppConfig>`) вместо ответа Google. Раскопали до дна:
 *   • fetch / https.request(hostname) / https.request(литеральный IPv4) /
 *     даже сырой tls.connect — ВСЁ бьётся в парковку внутри процесса аппа;
 *   • тот же код в ЧИСТОМ `node -e` (свежий процесс) → настоящий Google
 *     (валидный серт Google Trust Services, 200 + данные).
 * То есть перехват процесс-специфичен и живёт ниже уровня http/tls (что-то в
 * рантайме приложения — Sentry/OTel/патчи модулей — уводит соединения к
 * sheets.googleapis.com). Транспортом это не обходится. Поэтому читаем лист в
 * СВЕЖЕМ дочернем `node`-процессе: `NODE_OPTIONS` в контейнере пуст, значит
 * `node -e` не грузит instrumentation.ts и ходит в Google напрямую.
 *
 * Env:
 *   GOOGLE_OAUTH_JSON     — полный JSON ключа сервис-аккаунта (client_email + private_key)
 *   ENPS_SPREADSHEET_ID   — id Google-таблицы eNPS
 *   ENPS_SHEET_RANGE      — опционально, дефолт «'eNPS Gov'!A2:E»
 *
 * Таблица должна быть расшарена на client_email сервис-аккаунта (Читатель).
 */

import { execFile } from "node:child_process";

const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

function readServiceAccount(): ServiceAccountKey | null {
  const raw = process.env.GOOGLE_OAUTH_JSON;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ServiceAccountKey>;
    if (!parsed.client_email || !parsed.private_key) return null;
    return parsed as ServiceAccountKey;
  } catch {
    return null;
  }
}

export function enpsSheetsConfigured(): boolean {
  return Boolean(readServiceAccount() && process.env.ENPS_SPREADSHEET_ID);
}

// Скрипт, исполняемый в СВЕЖЕМ дочернем node-процессе (см. верхний комментарий).
// Сам подписывает JWT, меняет на access token и читает лист, печатая сырой
// JSON Sheets API в stdout. Конфиг берёт из унаследованного process.env
// (GOOGLE_OAUTH_JSON / ENPS_SPREADSHEET_ID / ENPS_SHEET_RANGE) — секреты не
// уходят в argv. Обычный https в свежем процессе достаёт настоящий Google.
const CHILD_SCRIPT = `
const https = require("https");
const { createSign } = require("crypto");
const sa = JSON.parse(process.env.GOOGLE_OAUTH_JSON);
const b64 = (s) => Buffer.from(s).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const header = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
const claims = b64(JSON.stringify({
  iss: sa.client_email,
  scope: "${SCOPE}",
  aud: "https://oauth2.googleapis.com/token",
  iat: now,
  exp: now + 3600,
}));
const signer = createSign("RSA-SHA256");
signer.update(header + "." + claims);
const assertion = header + "." + claims + "." + b64(signer.sign(sa.private_key));
const req = (opts, body) => new Promise((resolve, reject) => {
  const r = https.request(opts, (res) => {
    let d = "";
    res.on("data", (c) => (d += c));
    res.on("end", () => resolve({ status: res.statusCode, body: d }));
  });
  r.on("error", reject);
  if (body) r.write(body);
  r.end();
});
(async () => {
  const tok = await req(
    { hostname: "oauth2.googleapis.com", path: "/token", method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
  );
  if (tok.status < 200 || tok.status >= 300) throw new Error("token HTTP " + tok.status + " " + tok.body.slice(0, 200));
  const token = JSON.parse(tok.body).access_token;
  const range = process.env.ENPS_SHEET_RANGE || "'eNPS Gov'!A2:E";
  const url = "/v4/spreadsheets/" + encodeURIComponent(process.env.ENPS_SPREADSHEET_ID) +
    "/values/" + encodeURIComponent(range) + "?majorDimension=ROWS";
  const sh = await req({ hostname: "sheets.googleapis.com", path: url, method: "GET", headers: { Authorization: "Bearer " + token } });
  if (sh.status < 200 || sh.status >= 300) throw new Error("sheets HTTP " + sh.status + " " + sh.body.slice(0, 200));
  process.stdout.write(sh.body);
})().catch((e) => { console.error(e && e.message ? e.message : String(e)); process.exit(1); });
`;

/** Запускает CHILD_SCRIPT в свежем node-процессе, возвращает его stdout. */
function runChildFetch(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["-e", CHILD_SCRIPT],
      { env: process.env, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || "").trim() || err.message;
          return reject(new Error(`Sheets values read failed: ${detail.slice(0, 200)}`));
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Читает диапазон ответов eNPS. Возвращает сырые строки values
 * (массив массивов строк, как отдаёт Sheets API).
 */
export async function fetchEnpsSheetRows(): Promise<string[][]> {
  const sa = readServiceAccount();
  const spreadsheetId = process.env.ENPS_SPREADSHEET_ID;
  if (!sa || !spreadsheetId) {
    throw new Error("eNPS sheets not configured (GOOGLE_OAUTH_JSON / ENPS_SPREADSHEET_ID)");
  }
  const stdout = await runChildFetch();
  const json = JSON.parse(stdout) as { values?: string[][] };
  return json.values ?? [];
}
