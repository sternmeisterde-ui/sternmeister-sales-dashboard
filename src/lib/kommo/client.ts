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

const RATE_LIMIT_MS = 100; // ~10 req/sec (Kommo allows 10 on most plans)

let lastRequestTime = 0;
let rateLimitMutex: Promise<void> = Promise.resolve();

async function rateLimitedFetch(url: string, options: RequestInit): Promise<Response> {
  // Acquire mutex
  const prevMutex = rateLimitMutex;
  let releaseMutex: () => void;
  rateLimitMutex = new Promise<void>((resolve) => { releaseMutex = resolve; });
  await prevMutex;

  // Wait if needed
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await new Promise<void>((r) => setTimeout(r, RATE_LIMIT_MS - elapsed));
  }
  lastRequestTime = Date.now();
  releaseMutex!(); // Release — allow next request to start timing

  // Fetch with 1 retry on socket/network errors
  try {
    return await fetch(url, options);
  } catch (err) {
    // Retry once on network errors (socket closed, timeout, etc.)
    await new Promise<void>((r) => setTimeout(r, 500));
    return fetch(url, options);
  }
}

// ==================== HELPERS ====================

function getAuthHeaders(): HeadersInit {
  const token = process.env.KOMMO_ACCESS_TOKEN;
  if (!token) throw new Error("KOMMO_ACCESS_TOKEN not set");
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function getBaseUrl(): string {
  const domain = process.env.KOMMO_API_DOMAIN || "api-c.kommo.com";
  return `https://${domain}/api/v4`;
}

async function kommoGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${getBaseUrl()}${path}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }
  const res = await rateLimitedFetch(url.toString(), { headers: getAuthHeaders() });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Kommo API ${res.status}: ${text}`);
  }
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

  while (page <= maxPages) {
    const url = new URL(`${getBaseUrl()}${path}`);
    if (params) {
      Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    }
    url.searchParams.set("page", String(page));
    url.searchParams.set("limit", "250");

    const res = await rateLimitedFetch(url.toString(), { headers: getAuthHeaders() });

    if (res.status === 204) break;
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Kommo API ${res.status}: ${text}`);
    }

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
    const url = new URL(`${getBaseUrl()}/leads`);
    if (pipelineIds && pipelineIds.length > 0) {
      pipelineIds.forEach((id) => url.searchParams.append("filter[pipeline_id][]", String(id)));
    }
    if (statusIds) {
      statusIds.forEach((s) => url.searchParams.append("filter[statuses][][status_id]", String(s)));
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

      const res = await rateLimitedFetch(pageUrl.toString(), { headers: getAuthHeaders() });
      if (res.status === 204) break;
      if (!res.ok) break;

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
    // Phase 1: Events API
    const eventsUrl = new URL(`${getBaseUrl()}/events`);
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
          headers: getAuthHeaders(),
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
      const notesUrl = new URL(`${getBaseUrl()}/contacts/notes`);
      batch.forEach((id) =>
        notesUrl.searchParams.append("filter[id][]", String(id))
      );
      notesUrl.searchParams.set("limit", "250");

      const res = await rateLimitedFetch(notesUrl.toString(), {
        headers: getAuthHeaders(),
      });
      if (res.status === 204) continue;
      if (!res.ok) continue;

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
