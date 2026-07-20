/**
 * Обобщённый read-only клиент Google Sheets под сервис-аккаунт — тот же
 * паттерн, что src/lib/enps/sheets.ts (см. там подробный разбор), коротко:
 * на прод-хосте запросы к sheets.googleapis.com ИЗ ПРОЦЕССА приложения
 * перехватываются парковочным сервером (ниже уровня http/tls), поэтому лист
 * читается в СВЕЖЕМ дочернем node-процессе, где перехвата нет.
 *
 * Отличие от enps/sheets.ts: spreadsheetId и range передаются параметрами
 * (через env дочернего процесса — секреты и параметры не попадают в argv).
 * eNPS-клиент намеренно не трогаем — он живёт на своих env и работает.
 *
 * Env: GOOGLE_OAUTH_JSON — полный JSON ключа сервис-аккаунта.
 * Таблица должна быть расшарена на client_email (Читатель).
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

export function googleSheetsConfigured(): boolean {
  return Boolean(readServiceAccount());
}

// Скрипт дочернего процесса: подписывает JWT, меняет на access token, читает
// диапазон и печатает сырой JSON Sheets API в stdout. Параметры — из env
// SHEETS_READ_SPREADSHEET_ID / SHEETS_READ_RANGE.
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
  const url = "/v4/spreadsheets/" + encodeURIComponent(process.env.SHEETS_READ_SPREADSHEET_ID) +
    "/values/" + encodeURIComponent(process.env.SHEETS_READ_RANGE) + "?majorDimension=ROWS";
  const sh = await req({ hostname: "sheets.googleapis.com", path: url, method: "GET", headers: { Authorization: "Bearer " + token } });
  if (sh.status < 200 || sh.status >= 300) throw new Error("sheets HTTP " + sh.status + " " + sh.body.slice(0, 200));
  process.stdout.write(sh.body);
})().catch((e) => { console.error(e && e.message ? e.message : String(e)); process.exit(1); });
`;

/**
 * Читает диапазон значений листа. Возвращает сырые строки values (массив
 * массивов строк, как отдаёт Sheets API). Бросает при отсутствии кредов.
 */
export function readSheetRange(spreadsheetId: string, range: string): Promise<string[][]> {
  if (!googleSheetsConfigured()) {
    return Promise.reject(new Error("Google Sheets не сконфигурирован (GOOGLE_OAUTH_JSON)"));
  }
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["-e", CHILD_SCRIPT],
      {
        env: {
          ...process.env,
          SHEETS_READ_SPREADSHEET_ID: spreadsheetId,
          SHEETS_READ_RANGE: range,
        },
        timeout: 30_000,
        maxBuffer: 32 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || "").trim() || err.message;
          return reject(new Error(`Sheets read failed: ${detail.slice(0, 200)}`));
        }
        try {
          const json = JSON.parse(stdout) as { values?: string[][] };
          resolve(json.values ?? []);
        } catch {
          reject(new Error(`Sheets read: не-JSON ответ (${stdout.slice(0, 120)})`));
        }
      },
    );
  });
}
