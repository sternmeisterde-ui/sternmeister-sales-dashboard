/**
 * In-memory TTL cache for Kommo API responses.
 *
 * Prevents redundant API calls when:
 *  - User switches tabs and comes back
 *  - User clicks refresh within TTL window
 *  - Multiple components request same data
 *
 * Cache is per-process (Next.js server). Entries auto-expire by TTL.
 */

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const store = new Map<string, CacheEntry<unknown>>();

// Dedup: in-flight requests by key (prevents parallel duplicate fetches)
const inflight = new Map<string, Promise<unknown>>();

/** Default TTLs in milliseconds */
export const CACHE_TTL = {
  /** Active leads snapshot — status distribution changes slowly */
  LEADS_SNAPSHOT: 5 * 60 * 1000,
  /** Date-filtered leads (WON/LOST by closed_at) */
  LEADS_FILTERED: 3 * 60 * 1000,
  /** Call notes (date-filtered) */
  CALLS: 3 * 60 * 1000,
  /** Tasks — overdue count changes slowly */
  TASKS: 5 * 60 * 1000,
} as const;

/**
 * Get a cached value or fetch it.
 * Deduplicates concurrent requests for the same key.
 */
export async function cached<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>
): Promise<T> {
  // Check cache
  const existing = store.get(key) as CacheEntry<T> | undefined;
  if (existing && existing.expiresAt > Date.now()) {
    return existing.data;
  }

  // Dedup: if same key is already being fetched, wait for it
  const running = inflight.get(key) as Promise<T> | undefined;
  if (running) {
    return running;
  }

  // Fetch and cache
  const promise = fetcher().then((data) => {
    store.set(key, { data, expiresAt: Date.now() + ttlMs });
    inflight.delete(key);
    return data;
  }).catch((err) => {
    inflight.delete(key);
    throw err;
  });

  inflight.set(key, promise);
  return promise;
}

/** Invalidate all cache entries (e.g. after plan save) */
export function clearCache(): void {
  store.clear();
  // Don't clear inflight — let running requests complete
}

/** Cleanup expired entries (called periodically) */
export function purgeExpired(): void {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) {
      store.delete(key);
    }
  }
}

// Auto-purge every 5 minutes
if (typeof setInterval !== "undefined") {
  setInterval(purgeExpired, 5 * 60 * 1000);
}
