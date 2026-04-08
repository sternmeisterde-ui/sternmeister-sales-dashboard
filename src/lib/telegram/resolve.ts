import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

let client: TelegramClient | null = null;
let connectionPromise: Promise<TelegramClient | null> | null = null;

async function connectClient(): Promise<TelegramClient | null> {
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;
  const session = process.env.TELEGRAM_SESSION;

  if (!apiId || !apiHash || !session) {
    console.error("[Telegram MTProto] Missing env vars:", {
      TELEGRAM_API_ID: apiId ? "set" : "MISSING",
      TELEGRAM_API_HASH: apiHash ? "set" : "MISSING",
      TELEGRAM_SESSION: session ? `set (${session.length} chars)` : "MISSING",
    });
    return null;
  }

  try {
    console.log("[Telegram MTProto] Connecting...");
    client = new TelegramClient(new StringSession(session), apiId, apiHash, {
      connectionRetries: 5,
      timeout: 15,
    });
    await client.connect();
    console.log("[Telegram MTProto] Connected successfully");
    return client;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Telegram MTProto] Connection failed:", msg);
    client = null;
    return null;
  }
}

async function getClient(): Promise<TelegramClient | null> {
  if (client?.connected) return client;

  // Reset stale client
  if (client && !client.connected) {
    console.log("[Telegram MTProto] Client disconnected, reconnecting...");
    client = null;
  }

  if (!connectionPromise) {
    connectionPromise = connectClient().finally(() => {
      connectionPromise = null;
    });
  }
  return connectionPromise;
}

/**
 * Resolve a Telegram username to numeric user ID via MTProto API.
 * Returns { id, error } — always provides diagnostic info.
 */
export async function resolveTelegramUsername(username: string): Promise<string | null> {
  const clean = username.replace(/^@/, "").trim();
  if (!clean) {
    console.error("[Telegram MTProto] Empty username provided");
    return null;
  }

  const tg = await getClient();
  if (!tg) {
    console.error(`[Telegram MTProto] No client — cannot resolve @${clean}`);
    return null;
  }

  try {
    console.log(`[Telegram MTProto] Resolving @${clean}...`);
    const result = await tg.invoke(
      new Api.contacts.ResolveUsername({ username: clean })
    );
    if (result.users.length > 0) {
      const rawId = result.users[0].id;
      const idStr = String(rawId);
      if (/^\d+$/.test(idStr)) {
        console.log(`[Telegram MTProto] @${clean} → ${idStr}`);
        return idStr;
      }
      console.error(`[Telegram MTProto] Non-numeric ID for @${clean}: ${idStr}`);
      return null;
    }
    console.error(`[Telegram MTProto] @${clean} — no users in response`);
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Telegram MTProto] Failed to resolve @${clean}: ${msg}`);
    return null;
  }
}

/**
 * Diagnostic: test connection and optionally resolve a username.
 * Returns detailed status for debugging.
 */
export async function diagnoseTelegram(username?: string): Promise<{
  envVars: { apiId: boolean; apiHash: boolean; session: boolean; sessionLength: number };
  connected: boolean;
  connectError?: string;
  resolve?: { username: string; telegramId: string | null; error?: string };
}> {
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;
  const session = process.env.TELEGRAM_SESSION;

  const result: any = {
    envVars: {
      apiId: !!apiId,
      apiHash: !!apiHash,
      session: !!session,
      sessionLength: session?.length || 0,
    },
    connected: false,
  };

  const tg = await getClient();
  if (!tg) {
    result.connectError = "Failed to connect (check logs)";
    return result;
  }

  result.connected = true;

  if (username) {
    const clean = username.replace(/^@/, "").trim();
    try {
      const resolved = await resolveTelegramUsername(clean);
      result.resolve = { username: clean, telegramId: resolved };
    } catch (err) {
      result.resolve = { username: clean, telegramId: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  return result;
}
