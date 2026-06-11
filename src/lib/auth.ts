import { cookies } from "next/headers";

export interface SessionUser {
  userId: string;
  name: string;
  // Access gate — kept as "admin" | "manager" so every existing permission
  // check (`session.role === "admin"`) keeps working. ROPs and teamleads get
  // access as admin but the master-table role stays on `masterRole` for UI
  // display.
  role: "admin" | "manager";
  // Raw role from master_managers (single source of truth from the Managers
  // tab). Use this to label the user in the UI ("РОП" vs "Тимлид" vs "Админ"
  // vs "Менеджер") without changing any access gate.
  masterRole: "admin" | "rop" | "teamlead" | "manager";
  department: "b2g" | "b2b";
  telegramUsername: string;
  line: string | null;
  kommoUserId: number | null;
}

export const SESSION_COOKIE_NAME = "sm_session";

// ─── HMAC signing ───────────────────────────────────────────────
//
// Cookie format: `<base64url(JSON payload)>.<base64url(HMAC-SHA256 signature)>`
// Both the server (Node) and middleware (Edge) runtimes ship Web Crypto,
// so using it here keeps one implementation for both. A shared symmetric
// secret in SESSION_SECRET is required; we refuse to sign or verify
// anything if it's missing so a missing/rotated key never silently turns
// into "anyone can forge a session."

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Lazy-initialised per-process ephemeral secret for dev mode. Never use this
// in production — it's a fallback so local boots don't die without .env.local.
// Sessions signed with it invalidate on every restart.
let ephemeralDevSecret: string | null = null;

function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (secret && secret.length >= 32) return secret;

  if (process.env.NODE_ENV === "production") {
    // Fail loudly in prod — we'd rather show a 500 on /api/auth/login than
    // silently accept forged cookies because someone forgot to set the env
    // var on the deploy target.
    throw new Error(
      "SESSION_SECRET env var is missing or too short (>= 32 chars) in production. " +
        "Generate one with: openssl rand -base64 48 — then set it on Dokploy / your host.",
    );
  }

  if (!ephemeralDevSecret) {
    // Web Crypto getRandomValues works in Node ≥18 and Edge runtimes alike.
    const bytes = new Uint8Array(48);
    crypto.getRandomValues(bytes);
    ephemeralDevSecret = toBase64Url(bytes);
    console.warn(
      "[auth] SESSION_SECRET is unset — using an ephemeral dev-only secret. " +
        "All sessions will invalidate on restart. Set SESSION_SECRET in .env.local to persist.",
    );
  }
  return ephemeralDevSecret;
}

function toBase64Url(bytes: Uint8Array): string {
  // btoa works in both Node and Edge runtimes
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - (padded.length % 4)) % 4;
  const base64 = padded + "=".repeat(padding);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signSession(session: SessionUser): Promise<string> {
  const key = await importKey(getSecret());
  const payload = toBase64Url(encoder.encode(JSON.stringify(session)));
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(payload)),
  );
  return `${payload}.${toBase64Url(signature)}`;
}

// Constant-time comparison to avoid timing attacks on the signature check.
// crypto.subtle.verify already does this internally — we wrap it so callers
// get a plain boolean and the key-import error path is handled here.
async function verifySignature(payload: string, signatureB64: string): Promise<boolean> {
  try {
    const key = await importKey(getSecret());
    const sigBytes = fromBase64Url(signatureB64);
    // Copy into a fresh ArrayBuffer — Web Crypto's typings reject the generic
    // Uint8Array<ArrayBufferLike> that fromBase64Url returns under strict TS.
    const sigBuffer = sigBytes.buffer.slice(
      sigBytes.byteOffset,
      sigBytes.byteOffset + sigBytes.byteLength,
    ) as ArrayBuffer;
    return await crypto.subtle.verify(
      "HMAC",
      key,
      sigBuffer,
      encoder.encode(payload),
    );
  } catch {
    return false;
  }
}

export async function verifySession(cookieValue: string): Promise<SessionUser | null> {
  const dot = cookieValue.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = cookieValue.slice(0, dot);
  const signature = cookieValue.slice(dot + 1);

  const valid = await verifySignature(payload, signature);
  if (!valid) return null;

  try {
    const json = decoder.decode(fromBase64Url(payload));
    const parsed = JSON.parse(json) as Partial<SessionUser>;
    if (!parsed.userId || !parsed.name || !parsed.role || !parsed.department) {
      return null;
    }
    // Older sessions (signed before masterRole was introduced) only carry
    // `role`. Derive a sensible default so the UI doesn't crash, then rely
    // on next login to populate the real master_managers role.
    const masterRole = parsed.masterRole ?? (parsed.role === "admin" ? "admin" : "manager");
    return { ...parsed, masterRole } as SessionUser;
  } catch {
    return null;
  }
}

export async function getSession(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!raw) return null;
  return verifySession(raw);
}
