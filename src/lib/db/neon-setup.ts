/**
 * Global Neon resilience config — import this file before any neon() call.
 * Adds a 28-second timeout (enough for cold-start wake-up) and up to 3 retries
 * for transient network errors (ETIMEDOUT, ECONNRESET, fetch failed).
 *
 * Node default TCP connect timeout can be as short as 2–5 s in containers,
 * which is shorter than Neon's cold-start. This wrapper lifts that ceiling.
 */
import { neonConfig } from "@neondatabase/serverless";

const TIMEOUT_MS = 28_000;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1_500;

function isRetryable(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  const msg = err instanceof Error
    ? `${err.message} ${err.cause instanceof Error ? err.cause.message : ""}`
    : String(err);
  return (
    msg.includes("ETIMEDOUT") ||
    msg.includes("fetch failed") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("socket hang up") ||
    msg.includes("Error connecting to database")
  );
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
      const delay = BASE_DELAY_MS * attempt;
      console.warn(`[Neon] attempt ${attempt} failed (${err instanceof Error ? err.message : err}), retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    } finally {
      clearTimeout(tid);
    }
  }
  throw lastErr;
};
