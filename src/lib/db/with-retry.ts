/**
 * Application-level retry wrapper for DB operations on top of the
 * fetch-level retries in `neon-setup.ts`.
 *
 * Why two layers: the fetch wrapper can only retry the *transport* call.
 * Some Neon failures bubble up wrapped in `NeonDbError: Failed query: ...`
 * after the underlying fetch already exhausted its retries. By retrying
 * one more layer up — at the SQL-statement level — we survive longer
 * outages without poisoning the caller. Combined ceiling is well under
 * the cron's 300 s maxDuration.
 */

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_MS = 1_500;
const DEFAULT_MAX_DELAY_MS = 6_000;

export function isTransientDbError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  const msg = err instanceof Error
    ? `${err.message} ${err.cause instanceof Error ? err.cause.message : ""}`
    : String(err);
  return (
    msg.includes("fetch failed") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("EAI_AGAIN") ||
    msg.includes("ENETUNREACH") ||
    msg.includes("EPIPE") ||
    msg.includes("socket hang up") ||
    msg.includes("other side closed") ||
    msg.includes("Error connecting to database") ||
    msg.includes("terminating connection") ||
    msg.includes("Connection terminated unexpectedly") ||
    // Neon control-plane returns 5xx during compute restart
    msg.includes("503 Service Unavailable") ||
    msg.includes("502 Bad Gateway") ||
    msg.includes("504 Gateway Timeout")
  );
}

interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Tag for log lines so it's clear which call is retrying. */
  label?: string;
}

export async function withDbRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelay = opts.baseDelayMs ?? DEFAULT_BASE_MS;
  const maxDelay = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const label = opts.label ?? "db";

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientDbError(err) || attempt === maxAttempts) throw err;
      const exp = Math.min(baseDelay * 2 ** (attempt - 1), maxDelay);
      const delay = Math.floor(exp * (0.5 + Math.random() * 0.5));
      console.warn(
        `[${label}] attempt ${attempt}/${maxAttempts} failed (${err instanceof Error ? err.message : err}), retrying in ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
