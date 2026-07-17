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
import { connect as tlsConnect } from "node:tls";
import { lookup } from "node:dns/promises";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

/**
 * HTTPS request over a RAW TLS socket (node:tls), bypassing the http/https
 * module entirely.
 *
 * Долгая история. На прод-хосте (self-hosted Dokploy) любой запрос к
 * `sheets.googleapis.com` ИЗ ПРОЦЕССА ПРИЛОЖЕНИЯ приходит на домен-парковочный
 * сервер (`HTTP 400 <ppConfig>`) вместо ответа Google. Раскопали до дна:
 *   • global `fetch` (undici) → парковка;
 *   • `https.request({hostname, family:4})` → тоже парковка;
 *   • `https.request` к ЛИТЕРАЛЬНОМУ гугловому IPv4 → ВСЁ РАВНО парковка;
 *   • НО тот же `https.get` к тому же IP из чистого `node -e` → настоящий
 *     Google (403/401). Все 8 A-адресов Google из контейнера сырым сокетом
 *     дают настоящий Google — перехвата по IP/DNS/family НЕТ.
 * Значит перехватывает рантайм приложения на уровне модуля http/https
 * (Sentry/OpenTelemetry инструментируют именно http/https). `tls.connect` они
 * НЕ трогают — поэтому говорим HTTP/1.1 руками поверх сырого TLS к литеральному
 * IPv4. `servername` = SNI + валидация сертификата на реальное имя, заголовок
 * `Host` — маршрутизация Google. undici как модуль не резолвится (Node-internal),
 * так что кастомный dispatcher невозможен — это самый низкий доступный уровень.
 */
async function ipv4Request(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  const u = new URL(url);
  const { address: ip } = await lookup(u.hostname, { family: 4 });
  return new Promise((resolve, reject) => {
    const socket = tlsConnect(
      { host: ip, port: Number(u.port) || 443, servername: u.hostname },
      () => {
        const cert = socket.getPeerCertificate();
        console.log(
          `[enps] TLS ${u.hostname} → ${socket.remoteAddress} authorized=${socket.authorized} CN=${cert?.subject?.CN ?? "?"}`,
        );
        const headers: Record<string, string> = {
          Host: u.hostname,
          Connection: "close",
          "Accept-Encoding": "identity",
          ...(opts.headers ?? {}),
        };
        if (opts.body) headers["Content-Length"] = String(Buffer.byteLength(opts.body));
        const head =
          `${opts.method ?? "GET"} ${u.pathname + u.search} HTTP/1.1\r\n` +
          Object.entries(headers)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\r\n") +
          "\r\n\r\n";
        socket.write(head);
        if (opts.body) socket.write(opts.body);
      },
    );
    const chunks: Buffer[] = [];
    socket.on("data", (d) => chunks.push(d));
    socket.on("error", reject);
    socket.on("end", () => {
      const raw: Buffer = Buffer.concat(chunks);
      const sep = raw.indexOf("\r\n\r\n");
      if (sep < 0) return reject(new Error("Malformed HTTP response (no header terminator)"));
      const headText = raw.subarray(0, sep).toString("latin1");
      const rawBody = raw.subarray(sep + 4) as Buffer;
      const body = /^transfer-encoding:\s*chunked/im.test(headText) ? dechunk(rawBody) : rawBody;
      const status = Number(headText.match(/^HTTP\/\d\.\d (\d{3})/)?.[1] ?? 0);
      resolve({ status, body: body.toString("utf8") });
    });
  });
}

/** Decode HTTP/1.1 chunked transfer-encoding into the raw body bytes. */
function dechunk(buf: Buffer): Buffer {
  const out: Buffer[] = [];
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf("\r\n", i);
    if (nl < 0) break;
    const size = parseInt(buf.subarray(i, nl).toString("latin1").trim(), 16);
    if (!Number.isFinite(size) || size <= 0) break;
    const start = nl + 2;
    out.push(buf.subarray(start, start + size) as Buffer);
    i = start + size + 2; // skip the chunk's trailing CRLF
  }
  return Buffer.concat(out);
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
