// Kommo CRM API Client with rate limiting + caching
import type {
  KommoEvent,
  KommoLead,
  KommoTask,
  KommoUser,
  KommoPipeline,
  KommoAccount,
  KommoCallNote,
  KommoPaginatedResponse,
} from "./types";
import { cached, CACHE_TTL } from "./cache";

// ==================== RATE LIMITER ====================
// Mutex-based: ensures at most 1 HTTP request per RATE_LIMIT_MS,
// even when multiple parallel chains call rateLimitedFetch concurrently.

const RATE_LIMIT_MS = 145; // ~6.9 req/sec (Kommo limit is 7 req/sec)

let lastRequestTime = 0;
let rateLimitMutex: Promise<void> = Promise.resolve();

async function rateLimitedFetch(url: string, options: RequestInit): Promise<Response> {
  // Acquire mutex
  const prevMutex = rateLimitMutex;
  let releaseMutex: () => void = () => {};
  rateLimitMutex = new Promise<void>((resolve) => { releaseMutex = resolve; });

  try {
    await prevMutex;

    // Wait if needed
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < RATE_LIMIT_MS) {
      await new Promise<void>((r) => setTimeout(r, RATE_LIMIT_MS - elapsed));
    }
    lastRequestTime = Date.now();
  } finally {
    releaseMutex(); // Guaranteed release — never blocks the chain
  }

  // Fetch with 1 retry on socket/network errors
  let res: Response;
  try {
    res = await fetch(url, options);
  } catch (err) {
    // Retry once on network errors (socket closed, timeout, etc.)
    await new Promise<void>((r) => setTimeout(r, 500));
    res = await fetch(url, options);
  }

  // 429 Too Many Requests — wait and retry once
  if (res.status === 429) {
    let retryAfterMs = 1500;
    try {
      const body = await res.clone().json() as { retry_after?: number };
      if (body.retry_after) retryAfterMs = body.retry_after * 1000;
    } catch { /* use default */ }
    console.warn(`[Kommo] 429 rate limited, retrying after ${retryAfterMs}ms`);
    await new Promise<void>((r) => setTimeout(r, retryAfterMs));
    return fetch(url, options);
  }

  return res;
}

// ==================== KOMMO CONFIG (env → DB fallback) ====================
// Same pattern as R1_DATABASE_URL auto-derive: Dokploy only passes DATABASE_URL,
// so we load Kommo credentials from the kommo_tokens DB table when env vars are missing.

let _configPromise: Promise<void> | null = null;
let _cachedToken: string | null = null;
let _cachedDomain: string | null = null;
let _configLoadedAt = 0;

/** Re-check token from DB every 30 minutes (picks up refreshed tokens without restart) */
const CONFIG_REFRESH_MS = 30 * 60 * 1000;

/** Track consecutive API failures for diagnostics */
let _consecutiveFailures = 0;
export function getKommoHealth() {
  return { consecutiveFailures: _consecutiveFailures, tokenLoadedAt: _configLoadedAt ? new Date(_configLoadedAt).toISOString() : null };
}

function ensureKommoConfig(): Promise<void> {
  const needsRefresh = _configLoadedAt > 0 && (Date.now() - _configLoadedAt) > CONFIG_REFRESH_MS;

  if (!_configPromise || needsRefresh) {
    // If refreshing, don't null out _configPromise until new one resolves
    // (prevents concurrent requests from all hitting DB at once)
    const newPromise = (async () => {
      // 1. Check env vars first
      if (process.env.KOMMO_ACCESS_TOKEN) {
        _cachedToken = process.env.KOMMO_ACCESS_TOKEN;
        _cachedDomain = process.env.KOMMO_API_DOMAIN || "api-c.kommo.com";
        _configLoadedAt = Date.now();
        return;
      }

      // 2. Fallback: load from kommo_tokens table in D1 (main branch DB)
      try {
        const { db } = await import("../db/index");
        const { kommoTokens } = await import("../db/schema-existing");
        const rows = await db.select().from(kommoTokens).limit(1);
        if (rows.length > 0) {
          _cachedToken = rows[0].accessToken;
          _cachedDomain = `${rows[0].subdomain}.kommo.com`;
          _configLoadedAt = Date.now();
          console.log(`[Kommo] Token loaded from DB (expires: ${rows[0].expiresAt?.toISOString() ?? "unknown"})`);
          return;
        }
      } catch (e) {
        console.error("[Kommo] Failed to load token from DB:", e);
      }

      throw new Error(
        "KOMMO_ACCESS_TOKEN not set and no token found in kommo_tokens table"
      );
    })();

    _configPromise = newPromise.catch((err) => {
      _configPromise = null; // allow retry on next call instead of permanently broken
      throw err;
    });
  }
  return _configPromise;
}

/** Force re-load config on next call (e.g. after detecting 401) */
export function resetKommoConfig(): void {
  _configPromise = null;
  _configLoadedAt = 0;
}

// ==================== HELPERS ====================

async function getAuthHeaders(): Promise<HeadersInit> {
  await ensureKommoConfig();
  return {
    Authorization: `Bearer ${_cachedToken}`,
    "Content-Type": "application/json",
  };
}

async function getBaseUrl(): Promise<string> {
  await ensureKommoConfig();
  const domain = _cachedDomain || process.env.KOMMO_API_DOMAIN || "api-c.kommo.com";
  return `https://${domain}/api/v4`;
}

async function kommoGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  const baseUrl = await getBaseUrl();
  const url = new URL(`${baseUrl}${path}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }
  const res = await rateLimitedFetch(url.toString(), { headers: await getAuthHeaders() });
  if (!res.ok) {
    _consecutiveFailures++;
    if (res.status === 401) {
      console.error("[Kommo] 401 Unauthorized — resetting cached config for re-load");
      resetKommoConfig();
    }
    const text = await res.text();
    throw new Error(`Kommo API ${res.status}: ${text}`);
  }
  _consecutiveFailures = 0;
  return res.json();
}

// Paginate through all results
async function kommoGetAll<T>(
  path: string,
  embeddedKey: string,
  params?: Record<string, string>,
  maxPages = 20
): Promise<T[]> {
  const all: T[] = [];
  let page = 1;

  const baseUrl = await getBaseUrl();
  const headers = await getAuthHeaders();

  while (page <= maxPages) {
    const url = new URL(`${baseUrl}${path}`);
    if (params) {
      Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    }
    url.searchParams.set("page", String(page));
    url.searchParams.set("limit", "250");

    const res = await rateLimitedFetch(url.toString(), { headers });

    if (res.status === 204) break;
    if (!res.ok) {
      _consecutiveFailures++;
      if (res.status === 401) {
        console.error("[Kommo] 401 Unauthorized in paginated request — resetting config");
        resetKommoConfig();
      }
      const text = await res.text();
      throw new Error(`Kommo API ${res.status}: ${text}`);
    }
    _consecutiveFailures = 0;

    const data = (await res.json()) as KommoPaginatedResponse<T>;
    const items = data._embedded?.[embeddedKey] || [];
    all.push(...items);

    if (!data._links?.next) break;
    page++;
  }

  return all;
}

// ==================== Public API (with caching) ====================

export async function getAccount(): Promise<KommoAccount> {
  return kommoGet<KommoAccount>("/account");
}

export async function getUsers(): Promise<KommoUser[]> {
  return kommoGetAll<KommoUser>("/users", "users");
}

/**
 * Fetch leads with optional pipeline, status, and date filters.
 * Results are cached by parameters.
 */
export async function getLeads(
  pipelineIds?: number[],
  statusIds?: number[],
  maxPages = 10,
  dateFilter?: { field: "created_at" | "updated_at" | "closed_at"; from: number; to: number }
): Promise<KommoLead[]> {
  // Build cache key from params
  const cacheKey = `leads:${JSON.stringify({ pipelineIds, statusIds, maxPages, dateFilter })}`;
  const ttl = dateFilter ? CACHE_TTL.LEADS_FILTERED : CACHE_TTL.LEADS_SNAPSHOT;

  return cached(cacheKey, ttl, async () => {
    const baseUrl = await getBaseUrl();
    const headers = await getAuthHeaders();
    const url = new URL(`${baseUrl}/leads`);
    if (pipelineIds && pipelineIds.length > 0) {
      pipelineIds.forEach((id, i) => url.searchParams.append(`filter[pipeline_id][${i}]`, String(id)));
    }
    if (statusIds && statusIds.length > 0) {
      // Kommo requires status filter paired with pipeline_id for correct filtering
      let idx = 0;
      if (pipelineIds && pipelineIds.length > 0) {
        for (const pid of pipelineIds) {
          for (const sid of statusIds) {
            url.searchParams.append(`filter[statuses][${idx}][status_id]`, String(sid));
            url.searchParams.append(`filter[statuses][${idx}][pipeline_id]`, String(pid));
            idx++;
          }
        }
      } else {
        for (const sid of statusIds) {
          url.searchParams.append(`filter[statuses][${idx}][status_id]`, String(sid));
          idx++;
        }
      }
    }
    if (dateFilter) {
      url.searchParams.set(`filter[${dateFilter.field}][from]`, String(dateFilter.from));
      url.searchParams.set(`filter[${dateFilter.field}][to]`, String(dateFilter.to));
    }
    url.searchParams.set("limit", "250");

    const all: KommoLead[] = [];
    let page = 1;

    while (page <= maxPages) {
      const pageUrl = new URL(url.toString());
      pageUrl.searchParams.set("page", String(page));

      const res = await rateLimitedFetch(pageUrl.toString(), { headers });
      if (res.status === 204) break;
      if (!res.ok) {
        console.warn(`getLeads: page ${page} failed with ${res.status}, stopping pagination`);
        break;
      }

      const data = (await res.json()) as KommoPaginatedResponse<KommoLead>;
      const items = data._embedded?.leads || [];
      all.push(...items);
      if (!data._links?.next) break;
      page++;
    }

    return all;
  });
}

/**
 * Fetch tasks. Results cached for 5 minutes.
 */
export async function getTasks(
  isCompleted: boolean = false,
  maxPages = 10
): Promise<KommoTask[]> {
  const cacheKey = `tasks:${isCompleted}:${maxPages}`;

  return cached(cacheKey, CACHE_TTL.TASKS, () => {
    const params: Record<string, string> = {};
    if (!isCompleted) {
      params["filter[is_completed]"] = "0";
    }
    return kommoGetAll<KommoTask>("/tasks", "tasks", params, maxPages);
  });
}

export async function getPipelines(): Promise<KommoPipeline[]> {
  return kommoGetAll<KommoPipeline>("/leads/pipelines", "pipelines");
}

/**
 * Fetch call data for managers using a two-phase approach.
 * Results cached for 2 minutes.
 *
 * Phase 1: Events API (supports filter[created_by]) → get call events
 *   attributed to our managers, collecting note IDs.
 * Phase 2: Notes API (batch by ID) → get duration/call_status for each note.
 */
export async function getCallNotes(
  dateFrom: number,
  dateTo: number,
  kommoUserIds?: number[],
  maxPages = 20
): Promise<KommoCallNote[]> {
  const cacheKey = `calls:${dateFrom}:${dateTo}:${kommoUserIds?.join(",") ?? "all"}:${maxPages}`;

  return cached(cacheKey, CACHE_TTL.CALLS, async () => {
    const baseUrl = await getBaseUrl();
    const headers = await getAuthHeaders();

    // Phase 1: Events API
    const eventsUrl = new URL(`${baseUrl}/events`);
    eventsUrl.searchParams.append("filter[type][]", "outgoing_call");
    eventsUrl.searchParams.append("filter[type][]", "incoming_call");
    eventsUrl.searchParams.set("filter[created_at][from]", String(dateFrom));
    eventsUrl.searchParams.set("filter[created_at][to]", String(dateTo));
    eventsUrl.searchParams.set("limit", "100");

    const eventList: Array<{
      userId: number;
      type: "call_in" | "call_out";
      noteId: number | null;
    }> = [];

    // Kommo limits filter[created_by][] to 10 IDs
    const USER_BATCH = 10;
    const idBatches: number[][] = [];
    if (kommoUserIds && kommoUserIds.length > 0) {
      for (let i = 0; i < kommoUserIds.length; i += USER_BATCH) {
        idBatches.push(kommoUserIds.slice(i, i + USER_BATCH));
      }
    } else {
      idBatches.push([]);
    }

    for (const batch of idBatches) {
      const batchUrl = new URL(eventsUrl.toString());
      batch.forEach((id) =>
        batchUrl.searchParams.append("filter[created_by][]", String(id))
      );

      let page = 1;
      while (page <= maxPages) {
        const pageUrl = new URL(batchUrl.toString());
        pageUrl.searchParams.set("page", String(page));

        const res = await rateLimitedFetch(pageUrl.toString(), {
          headers,
        });
        if (res.status === 204) break;
        if (!res.ok) {
          if (res.status === 404) break;
          const text = await res.text();
          throw new Error(`Kommo events API ${res.status}: ${text}`);
        }

        const data = (await res.json()) as KommoPaginatedResponse<KommoEvent>;
        const items = data._embedded?.events || [];

        for (const ev of items) {
          const noteType = ev.type === "incoming_call" ? "call_in" : "call_out";
          const noteId = ev.value_after?.[0]?.note?.id ?? null;
          eventList.push({ userId: ev.created_by, type: noteType, noteId });
        }

        if (!data._links?.next) break;
        page++;
      }
    }

    if (eventList.length === 0) return [];

    // Phase 2: Batch-fetch notes by ID
    const noteIds = eventList
      .map((e) => e.noteId)
      .filter((id): id is number => id !== null);

    const noteParamsMap = new Map<
      number,
      { duration: number; call_status: number | undefined }
    >();

    const BATCH_SIZE = 100;
    for (let i = 0; i < noteIds.length; i += BATCH_SIZE) {
      const batch = noteIds.slice(i, i + BATCH_SIZE);
      const notesUrl = new URL(`${baseUrl}/leads/notes`);
      batch.forEach((id) =>
        notesUrl.searchParams.append("filter[id][]", String(id))
      );
      notesUrl.searchParams.set("limit", "250");

      const res = await rateLimitedFetch(notesUrl.toString(), {
        headers,
      });
      if (res.status === 204) continue;
      if (!res.ok) {
        console.warn(`getCallNotes: batch notes fetch failed with ${res.status}, skipping batch`);
        continue;
      }

      const data = (await res.json()) as KommoPaginatedResponse<KommoCallNote>;
      const notes = data._embedded?.notes || [];
      for (const n of notes) {
        noteParamsMap.set(n.id, {
          duration: n.params?.duration ?? 0,
          call_status: n.params?.call_status,
        });
      }
    }

    // Phase 3: Merge
    return eventList.map((ev) => {
      const noteParams = ev.noteId ? noteParamsMap.get(ev.noteId) : undefined;
      return {
        id: ev.noteId ?? 0,
        entity_id: 0,
        created_by: ev.userId,
        updated_by: ev.userId,
        created_at: dateFrom,
        updated_at: dateFrom,
        responsible_user_id: ev.userId,
        group_id: 0,
        note_type: ev.type,
        params: {
          duration: noteParams?.duration ?? 0,
          call_status: noteParams?.call_status,
        },
        account_id: 0,
      };
    });
  });
}

/**
 * Get lead_status_changed events for a date range.
 * Returns count of leads that moved INTO specified target statuses.
 */
export async function getStatusChangeCount(
  dateFrom: number,
  dateTo: number,
  targetPipelineId: number,
  targetStatusIds: number[],
  maxPages = 30
): Promise<number> {
  const cacheKey = `status-changes:${dateFrom}:${dateTo}:${targetPipelineId}:${targetStatusIds.join(",")}`;

  return cached(cacheKey, CACHE_TTL.CALLS, async () => {
    const baseUrl = await getBaseUrl();
    const headers = await getAuthHeaders();

    const targetSet = new Set(targetStatusIds);
    let count = 0;
    let page = 1;

    while (page <= maxPages) {
      const url = new URL(`${baseUrl}/events`);
      url.searchParams.append("filter[type][]", "lead_status_changed");
      url.searchParams.set("filter[created_at][from]", String(dateFrom));
      url.searchParams.set("filter[created_at][to]", String(dateTo));
      url.searchParams.set("limit", "100");
      url.searchParams.set("page", String(page));

      const res = await rateLimitedFetch(url.toString(), { headers });
      if (res.status === 204) break;
      if (!res.ok) {
        if (res.status === 404) break;
        _consecutiveFailures++;
        const text = await res.text();
        console.error(`[Kommo] Status change events API ${res.status}: ${text}`);
        break;
      }

      const data = (await res.json()) as KommoPaginatedResponse<KommoEvent>;
      const events = data._embedded?.events || [];

      for (const ev of events) {
        for (const va of ev.value_after || []) {
          const ls = (va as Record<string, unknown>).lead_status as { id?: number; pipeline_id?: number } | undefined;
          if (ls && ls.pipeline_id === targetPipelineId && targetSet.has(ls.id ?? 0)) {
            count++;
          }
        }
      }

      if (!data._links?.next) break;
      page++;
    }

    return count;
  });
}
