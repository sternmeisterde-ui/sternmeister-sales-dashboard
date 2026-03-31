import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

let client: TelegramClient | null = null;
let connectionPromise: Promise<TelegramClient | null> | null = null;

async function connectClient(): Promise<TelegramClient | null> {
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;
  const session = process.env.TELEGRAM_SESSION;

  if (!apiId || !apiHash || !session) return null;

  try {
    client = new TelegramClient(new StringSession(session), apiId, apiHash, {
      connectionRetries: 3,
    });
    await client.connect();
    return client;
  } catch (err) {
    console.error("[Telegram MTProto] Connection failed:", err);
    client = null;
    return null;
  }
}

async function getClient(): Promise<TelegramClient | null> {
  if (client?.connected) return client;
  // Promise-based mutex — prevents double-connection race
  if (!connectionPromise) {
    connectionPromise = connectClient().finally(() => {
      connectionPromise = null;
    });
  }
  return connectionPromise;
}

/**
 * Resolve a Telegram username to numeric user ID via MTProto API.
 * Works for any public username — no bot interaction required.
 */
export async function resolveTelegramUsername(username: string): Promise<string | null> {
  const tg = await getClient();
  if (!tg) return null;

  try {
    const result = await tg.invoke(
      new Api.contacts.ResolveUsername({ username: username.replace(/^@/, "") })
    );
    if (result.users.length > 0) {
      const rawId = result.users[0].id;
      // Handle bigint, Long objects, or plain numbers
      const idStr = String(rawId);
      // Validate it's a numeric string
      if (/^\d+$/.test(idStr)) return idStr;
      console.error(`[Telegram MTProto] Non-numeric ID for @${username}: ${idStr}`);
      return null;
    }
    return null;
  } catch (err) {
    console.error(`[Telegram MTProto] Failed to resolve @${username}:`, err);
    return null;
  }
}
