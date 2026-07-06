/**
 * Минимальный read-only клиент Google Sheets под сервис-аккаунт.
 *
 * Единственная задача — прочитать диапазон значений из таблицы eNPS.
 * Сознательно без @googleapis/*: OAuth2-flow сервис-аккаунта — это один
 * подписанный JWT (RS256) + обмен на access token, node:crypto достаточно.
 * (Существующий src/lib/gdrive/client.ts — другой случай: OAuth от имени
 * пользователя для записи, там библиотека оправдана.)
 *
 * Env:
 *   GOOGLE_OAUTH_JSON     — полный JSON ключа сервис-аккаунта (client_email + private_key)
 *   ENPS_SPREADSHEET_ID   — id Google-таблицы eNPS
 *   ENPS_SHEET_RANGE      — опционально, дефолт «'eNPS Gov'!A2:E»
 *
 * Таблица должна быть расшарена на client_email сервис-аккаунта (Читатель).
 */

import { createSign } from "node:crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
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

const b64url = (input: string | Buffer) =>
  Buffer.from(input).toString("base64url");

// Access token живёт час — кешируем в модуле, чтобы не подписывать JWT на
// каждый тик синка. Модульный кеш переживает запросы внутри одного процесса,
// после рестарта просто получим новый токен.
let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(sa: ServiceAccountKey): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const signature = b64url(signer.sign(sa.private_key));
  const assertion = `${header}.${claims}.${signature}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Google token exchange failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    token: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  return cachedToken.token;
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
  const range = process.env.ENPS_SHEET_RANGE ?? "'eNPS Gov'!A2:E";

  const token = await getAccessToken(sa);
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}` +
    `/values/${encodeURIComponent(range)}?majorDimension=ROWS`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Sheets values read failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { values?: string[][] };
  return json.values ?? [];
}
