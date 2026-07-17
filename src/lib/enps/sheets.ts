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
import { request as httpsRequest } from "node:https";
import { resolve4 } from "node:dns/promises";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

/**
 * IPv4-pinned HTTPS request that connects to a LITERAL IPv4 address.
 *
 * Почему так, а не global fetch и даже не `https.request({family:4})`:
 * на прод-хосте (self-hosted Dokploy) глобальный `fetch` (встроенный undici)
 * для `sheets.googleapis.com` садится на домен-парковочный сервер (`HTTP 400
 * <ppConfig>`) вместо ответа Google. Раскопали пошагово:
 *   • `fetch(...)` → парковка;
 *   • raw `https.get({host, family:4})` в чистом `node -e` → настоящий Google;
 *   • но ТО ЖЕ `https.request({hostname, family:4})` ВНУТРИ приложения → снова
 *     парковка. Разница — рантайм Next: `Sentry.init()` через OpenTelemetry
 *     инструментирует http/https и теряет опцию `family`, запрос уходит
 *     dual-stack и попадает на перехваченный IPv6.
 * Поэтому резолвим хост в литеральный IPv4 сами и коннектимся прямо к IP —
 * тогда никакой family/dual-stack развилки не остаётся, инструментировать
 * нечего. SNI (`servername`) и заголовок `Host` держат TLS/маршрутизацию на
 * реальном имени. undici отдельным модулем не резолвится, dispatcher невозможен.
 */
async function ipv4Request(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  const u = new URL(url);
  const ips = await resolve4(u.hostname);
  if (ips.length === 0) throw new Error(`No A record for ${u.hostname}`);
  const ip = ips[0];
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: ip, // literal IPv4 — no family/dual-stack decision to strip
        port: u.port || 443,
        path: u.pathname + u.search,
        method: opts.method ?? "GET",
        headers: { ...(opts.headers ?? {}), Host: u.hostname },
        servername: u.hostname, // SNI + cert validation against the real name
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          // Diagnostic: which peer did we actually reach? (real Google vs parked)
          console.log(
            `[enps] ${u.hostname} → ${res.socket?.remoteAddress} (${res.socket?.remoteFamily}) HTTP ${res.statusCode}`,
          );
          resolve({ status: res.statusCode ?? 0, body: data });
        });
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

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

  const res = await ipv4Request(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Google token exchange failed: HTTP ${res.status} ${res.body.slice(0, 200)}`);
  }
  const json = JSON.parse(res.body) as { access_token: string; expires_in: number };
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
  const res = await ipv4Request(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Sheets values read failed: HTTP ${res.status} ${res.body.slice(0, 200)}`);
  }
  const json = JSON.parse(res.body) as { values?: string[][] };
  return json.values ?? [];
}
