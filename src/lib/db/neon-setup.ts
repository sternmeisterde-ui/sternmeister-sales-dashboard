/**
 * Global Neon resilience config — import this file before any neon() call.
 *
 * Why this exists: Neon serverless uses HTTP-over-QUIC under the hood, which
 * occasionally drops `fetch failed` / `ECONNRESET` for a few seconds while
 * the compute warms up or a routing layer reconnects. The default Node fetch
 * has no retry and a TCP-connect timeout as short as 2–5 s in containers,
 * which is shorter than Neon's cold-start. This wrapper:
 *
 *   - lifts the timeout ceiling to TIMEOUT_MS,
 *   - retries up to MAX_RETRIES with exponential-ish backoff + jitter,
 *   - covers every transient pattern we've actually seen in Sentry.
 *
 * Worst-case wait per query: roughly TIMEOUT_MS × MAX_RETRIES + sum of
 * backoff = ~157 s. That's longer than the 28 s default but still inside
 * the cron's 300 s maxDuration, so a stuck Neon won't drop a tick.
 */
import { neonConfig } from "@neondatabase/serverless";

const TIMEOUT_MS = 28_000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 8_000;

function isRetryable(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  const msg = err instanceof Error
    ? `${err.message} ${err.cause instanceof Error ? err.cause.message : ""}`
    : String(err);
  return (
    msg.includes("ETIMEDOUT") ||
    msg.includes("ENETUNREACH") ||
    msg.includes("EAI_AGAIN") ||
    msg.includes("fetch failed") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("EPIPE") ||
    msg.includes("socket hang up") ||
    msg.includes("other side closed") ||
    msg.includes("Error connecting to database") ||
    msg.includes("terminating connection") ||
    msg.includes("Connection terminated unexpectedly")
  );
}

function backoffDelay(attempt: number): number {
  const base = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
  // Full jitter — prevents thundering herd when many queries reconnect at once.
  return Math.floor(base * (0.5 + Math.random() * 0.5));
}

neonConfig.fetchFunction = async (
  url: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: ctrl.signal });
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === MAX_RETRIES) throw err;
      const delay = backoffDelay(attempt);
      console.warn(
        `[Neon] attempt ${attempt}/${MAX_RETRIES} failed (${err instanceof Error ? err.message : err}), retrying in ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    } finally {
      clearTimeout(tid);
    }
  }
  throw lastErr;
};
