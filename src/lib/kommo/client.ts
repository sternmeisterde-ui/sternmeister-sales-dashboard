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

  // 429 Too Many Requests — wait and retry through the mutex so the retry
  // still respects the global rate limit (bare fetch would race the next caller).
  if (res.status === 429) {
    let retryAfterMs = 1500;
    try {
      const body = await res.clone().json() as { retry_after?: number };
      if (body.retry_after) retryAfterMs = body.retry_after * 1000;
    } catch { /* use default */ }
    console.warn(`[Kommo] 429 rate limited, retrying after ${retryAfterMs}ms`);
    await new Promise<void>((r) => setTimeout(r, retryAfterMs));
    return rateLimitedFetch(url, options);
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
  dateFilter?: { field: "created_at" | "updated_at" | "closed_at"; from: number; to: number },
  withContacts = false,
): Promise<KommoLead[]> {
  // Build cache key from params
  const cacheKey = `leads:${JSON.stringify({ pipelineIds, statusIds, maxPages, dateFilter, withContacts })}`;
  const ttl = dateFilter ? CACHE_TTL.LEADS_FILTERED : CACHE_TTL.LEADS_SNAPSHOT;

  return cached(cacheKey, ttl, async () => {
    const baseUrl = await getBaseUrl();
    const headers = await getAuthHeaders();
    const url = new URL(`${baseUrl}/leads`);
    if (withContacts) url.searchParams.set("with", "contacts");
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
  // Sort user IDs before joining — two callers passing the same IDs in
  // different order would otherwise hit different cache entries and burst
  // Kommo twice for the same data.
  const sortedIds = kommoUserIds
    ? [...kommoUserIds].sort((a, b) => a - b).join(",")
    : "all";
  const cacheKey = `calls:${dateFrom}:${dateTo}:${sortedIds}:${maxPages}`;

  return cached(cacheKey, CACHE_TTL.CALLS, async () => {
    const baseUrl = await getBaseUrl();
    const headers = await getAuthHeaders();

    // Phase 1: Events API — capture entity_type + real timestamp
    const eventsUrl = new URL(`${baseUrl}/events`);
    eventsUrl.searchParams.append("filter[type][]", "outgoing_call");
    eventsUrl.searchParams.append("filter[type][]", "incoming_call");
    eventsUrl.searchParams.set("filter[created_at][from]", String(dateFrom));
    eventsUrl.searchParams.set("filter[created_at][to]", String(dateTo));
    eventsUrl.searchParams.set("limit", "100");

    type CallEventRecord = {
      userId: number;
      type: "call_in" | "call_out";
      noteId: number;
      entityType: "contact" | "lead" | "company" | "customer";
      entityId: number;
      createdAt: number;
    };
    const eventList: CallEventRecord[] = [];

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
          // Skip events without a note ID — they inflate callsTotal and contribute nothing.
          if (noteId === null) continue;
          // Route to correct /{entity}s/notes endpoint. "unsorted" entities have notes
          // attached as leads (they become leads once sorted), so map them to "lead".
          const rawType = ev.entity_type;
          const entityType: CallEventRecord["entityType"] =
            rawType === "lead" || rawType === "company" || rawType === "customer"
              ? rawType
              : rawType === "unsorted"
                ? "lead"
                : "contact";
          eventList.push({
            userId: ev.created_by,
            type: noteType,
            noteId,
            entityType,
            entityId: ev.entity_id,
            createdAt: ev.created_at,
          });
        }

        if (!data._links?.next) break;
        page++;
      }
    }

    if (eventList.length === 0) return [];

    // Phase 2: Batch-fetch notes by ID from the correct entity endpoint.
    // Kommo calls are attached to the entity the event fired on — usually contacts
    // for inbound/outbound call notes. The /leads/notes endpoint returns 204 for
    // contact-owned notes, so we must route each note id to its matching endpoint.
    const noteParamsMap = new Map<
      number,
      { duration: number; call_status: number | undefined }
    >();

    const byEntity = new Map<string, number[]>();
    for (const ev of eventList) {
      const key = ev.entityType;
      if (!byEntity.has(key)) byEntity.set(key, []);
      byEntity.get(key)!.push(ev.noteId);
    }

    const BATCH_SIZE = 100;
    for (const [entityType, ids] of byEntity) {
      // Kommo endpoint path: /contacts/notes, /leads/notes, /companies/notes
      // Note: "company" + "s" would produce "companys" — use explicit mapping instead.
      const entityPlural: Record<string, string> = { contact: "contacts", lead: "leads", company: "companies", customer: "customers" };
      const endpointPath = `/${entityPlural[entityType] ?? `${entityType}s`}/notes`;
      const uniqIds = Array.from(new Set(ids));

      for (let i = 0; i < uniqIds.length; i += BATCH_SIZE) {
        const batch = uniqIds.slice(i, i + BATCH_SIZE);
        const notesUrl = new URL(`${baseUrl}${endpointPath}`);
        batch.forEach((id) =>
          notesUrl.searchParams.append("filter[id][]", String(id))
        );
        notesUrl.searchParams.set("limit", "250");

        // Kommo paginates even single-batch filtered responses; keep walking until no next link.
        let notesPage = 1;
        let batchFailed = false;
        while (!batchFailed) {
          const pageUrl = new URL(notesUrl.toString());
          pageUrl.searchParams.set("page", String(notesPage));

          const res = await rateLimitedFetch(pageUrl.toString(), { headers });
          if (res.status === 204) break;
          if (!res.ok) {
            console.warn(`getCallNotes: ${endpointPath} batch failed with ${res.status}, skipping batch`);
            batchFailed = true;
            break;
          }

          const data = (await res.json()) as KommoPaginatedResponse<KommoCallNote>;
          const notes = data._embedded?.notes || [];
          for (const n of notes) {
            noteParamsMap.set(n.id, {
              duration: Number(n.params?.duration) || 0,
              call_status: n.params?.call_status,
            });
          }
          if (!data._links?.next) break;
          notesPage++;
        }
      }
    }

    // Phase 3: Merge — preserve real event timestamp so day-grouping works
    return eventList.map((ev) => {
      const noteParams = noteParamsMap.get(ev.noteId);
      return {
        id: ev.noteId,
        entity_id: ev.entityId,
        created_by: ev.userId,
        updated_by: ev.userId,
        created_at: ev.createdAt,
        updated_at: ev.createdAt,
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

/**
 * Fetch tasks for specific lead IDs.
 * Used in ETL to sync tasks for a set of leads.
 */
export async function getLeadTasks(
  leadIds: number[],
  maxPages = 50,
): Promise<Array<{
  id: number;
  entityId: number;
  entityType: string;
  createdAt: number;
  updatedAt: number;
  isCompleted: boolean;
  completeTill: number;
  responsibleUserId: number;
  result: { createdAt?: number } | null;
}>> {
  if (leadIds.length === 0) return [];

  const baseUrl = await getBaseUrl();
  const headers = await getAuthHeaders();
  const result: Array<{
    id: number;
    entityId: number;
    entityType: string;
    createdAt: number;
    updatedAt: number;
    isCompleted: boolean;
    completeTill: number;
    responsibleUserId: number;
    result: { createdAt?: number } | null;
  }> = [];

  const BATCH = 50;
  for (let i = 0; i < leadIds.length; i += BATCH) {
    const batch = leadIds.slice(i, i + BATCH);
    const url = new URL(`${baseUrl}/tasks`);
    url.searchParams.set("limit", "250");
    url.searchParams.set("filter[entity_type]", "leads");
    batch.forEach((id) => url.searchParams.append("filter[entity_id][]", String(id)));

    let page = 1;
    while (page <= maxPages) {
      const pageUrl = new URL(url.toString());
      pageUrl.searchParams.set("page", String(page));
      const res = await rateLimitedFetch(pageUrl.toString(), { headers });
      if (res.status === 204) break;
      if (!res.ok) {
        console.warn(`[ETL] tasks batch ${i} page ${page}: ${res.status}`);
        break;
      }
      const data = (await res.json()) as {
        _embedded?: { tasks?: Array<{
          id: number; entity_id: number; entity_type: string;
          created_at: number; updated_at: number; is_completed: boolean;
          complete_till: number; responsible_user_id: number;
          result?: { created_at?: number } | null;
        }> };
        _links?: { next?: unknown };
      };
      for (const t of data._embedded?.tasks ?? []) {
        result.push({
          id: t.id,
          entityId: t.entity_id,
          entityType: t.entity_type,
          createdAt: t.created_at,
          updatedAt: t.updated_at,
          isCompleted: t.is_completed,
          completeTill: t.complete_till,
          responsibleUserId: t.responsible_user_id,
          result: t.result ? { createdAt: t.result.created_at } : null,
        });
      }
      if (!data._links?.next) break;
      page++;
    }
  }

  return result;
}

export async function getLossReasons(): Promise<Array<{ id: number; name: string }>> {
  const data = await kommoGet<{ _embedded?: { loss_reasons?: Array<{ id: number; name: string }> } }>(
    "/leads/loss_reasons",
    { limit: "250" },
  );
  return data._embedded?.loss_reasons ?? [];
}

/**
 * Fetch enum (select) options for a Kommo lead custom field, e.g. 879824
 * "Причина закрытия Госники". Returns a map of enum_id → enum value text so
 * downstream refusal-reason aggregations can label leads by human-readable
 * reason instead of raw enum id.
 */
export async function getLeadCustomFieldEnums(
  fieldId: number,
): Promise<Array<{ id: number; value: string; sort: number }>> {
  try {
    const data = await kommoGet<{
      enums?: Array<{ id: number; value: string; sort: number }>;
    }>(`/leads/custom_fields/${fieldId}`);
    return data.enums ?? [];
  } catch (e) {
    console.warn(`[Kommo] getLeadCustomFieldEnums(${fieldId}) failed:`, e);
    return [];
  }
}

/**
 * Batch-fetch contacts by ID with their linked leads.
 * Used in ETL to resolve contact_id → lead_id[] for call events.
 */
export async function getContactsWithLeads(
  contactIds: number[],
): Promise<Map<number, number[]>> {
  if (contactIds.length === 0) return new Map();

  const baseUrl = await getBaseUrl();
  const headers = await getAuthHeaders();
  const result = new Map<number, number[]>();

  const BATCH = 50; // Kommo allows up to 250 but filter[id][] URL gets long
  for (let i = 0; i < contactIds.length; i += BATCH) {
    const batch = contactIds.slice(i, i + BATCH);
    const url = new URL(`${baseUrl}/contacts`);
    url.searchParams.set("with", "leads");
    url.searchParams.set("limit", "250");
    batch.forEach((id) => url.searchParams.append("filter[id][]", String(id)));

    const res = await rateLimitedFetch(url.toString(), { headers });
    if (res.status === 204) continue;
    if (!res.ok) {
      console.warn(`[ETL] contacts batch ${i}-${i + BATCH} failed with ${res.status}`);
      continue;
    }

    const data = (await res.json()) as {
      _embedded?: {
        contacts?: Array<{
          id: number;
          _embedded?: { leads?: Array<{ id: number }> };
        }>;
      };
    };

    for (const contact of data._embedded?.contacts ?? []) {
      const leads = contact._embedded?.leads?.map((l) => l.id) ?? [];
      result.set(contact.id, leads);
    }
  }

  return result;
}

/**
 * Fetch all call events (outgoing_call + incoming_call) for a date range.
 * No user filter — returns all events for all managers.
 * Includes note_id for Phase 2 resolution.
 */
/**
 * Fetch ALL call notes directly from /contacts/notes and /leads/notes by date range.
 * More complete than getCallEvents (Events API misses ~18% of calls that lack event entries).
 * Returns unified shape identical to what getCallEvents used to return.
 */
export async function getAllCallNotesByDate(
  dateFrom: number,
  dateTo: number,
  maxPages = 500,
): Promise<Array<{
  type: "call_in" | "call_out";
  noteId: number;
  entityType: string;
  entityId: number;
  createdBy: number;
  createdAt: number;
  duration: number;
  callStatus: number | undefined;
}>> {
  const baseUrl = await getBaseUrl();
  const headers = await getAuthHeaders();

  const result: Array<{
    type: "call_in" | "call_out";
    noteId: number;
    entityType: string;
    entityId: number;
    createdBy: number;
    createdAt: number;
    duration: number;
    callStatus: number | undefined;
  }> = [];

  // Track seen note IDs to deduplicate across entity endpoints
  const seen = new Set<number>();

  for (const entityType of ["contacts", "leads"] as const) {
    let page = 1;
    while (page <= maxPages) {
      const url = new URL(`${baseUrl}/${entityType}/notes`);
      url.searchParams.append("filter[note_type][]", "call_in");
      url.searchParams.append("filter[note_type][]", "call_out");
      url.searchParams.set("filter[created_at][from]", String(dateFrom));
      url.searchParams.set("filter[created_at][to]", String(dateTo));
      url.searchParams.set("limit", "250");
      url.searchParams.set("page", String(page));

      const res = await rateLimitedFetch(url.toString(), { headers });
      if (res.status === 204) break;
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Kommo ${entityType}/notes ${res.status}: ${text}`);
      }

      const data = (await res.json()) as KommoPaginatedResponse<KommoCallNote>;
      const notes = data._embedded?.notes ?? [];

      for (const n of notes) {
        if (seen.has(n.id)) continue;
        seen.add(n.id);
        result.push({
          type: n.note_type,
          noteId: n.id,
          entityType: entityType === "contacts" ? "contact" : "lead",
          entityId: n.entity_id,
          createdBy: n.created_by,
          createdAt: n.created_at,
          duration: Number(n.params?.duration) || 0,
          callStatus: n.params?.call_status,
        });
      }

      if (!data._links?.next) break;
      page++;
    }
  }

  return result;
}

/** @deprecated Use getAllCallNotesByDate instead — Events API misses ~18% of calls */
export async function getCallEvents(
  dateFrom: number,
  dateTo: number,
  maxPages = 200,
): Promise<Array<{
  type: "call_in" | "call_out";
  noteId: number;
  entityType: string;
  entityId: number;
  createdBy: number;
  createdAt: number;
}>> {
  const baseUrl = await getBaseUrl();
  const headers = await getAuthHeaders();
  const result: Array<{
    type: "call_in" | "call_out";
    noteId: number;
    entityType: string;
    entityId: number;
    createdBy: number;
    createdAt: number;
  }> = [];

  let page = 1;
  while (page <= maxPages) {
    const url = new URL(`${baseUrl}/events`);
    url.searchParams.append("filter[type][]", "outgoing_call");
    url.searchParams.append("filter[type][]", "incoming_call");
    url.searchParams.set("filter[created_at][from]", String(dateFrom));
    url.searchParams.set("filter[created_at][to]", String(dateTo));
    url.searchParams.set("limit", "250");
    url.searchParams.set("page", String(page));

    const res = await rateLimitedFetch(url.toString(), { headers });
    if (res.status === 204) break;
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Kommo call events ${res.status}: ${text}`);
    }

    const data = (await res.json()) as KommoPaginatedResponse<KommoEvent>;
    const items = data._embedded?.events ?? [];

    for (const ev of items) {
      const noteId = ev.value_after?.[0]?.note?.id ?? null;
      if (noteId === null) continue;
      result.push({
        type: ev.type === "incoming_call" ? "call_in" : "call_out",
        noteId,
        entityType: ev.entity_type,
        entityId: ev.entity_id,
        createdBy: ev.created_by,
        createdAt: ev.created_at,
      });
    }

    if (!data._links?.next) break;
    page++;
  }

  return result;
}

/**
 * Fetch message events (outgoing + incoming chat messages) for a date range.
 */
export async function getMessageEvents(
  dateFrom: number,
  dateTo: number,
  maxPages = 200,
): Promise<Array<{
  type: "outgoing_chat_message" | "incoming_chat_message";
  messageId: string;
  leadId: number;
  createdBy: number;
  createdAt: number;
}>> {
  const baseUrl = await getBaseUrl();
  const headers = await getAuthHeaders();
  const result: Array<{
    type: "outgoing_chat_message" | "incoming_chat_message";
    messageId: string;
    leadId: number;
    createdBy: number;
    createdAt: number;
  }> = [];

  let page = 1;
  while (page <= maxPages) {
    const url = new URL(`${baseUrl}/events`);
    url.searchParams.append("filter[type][]", "outgoing_chat_message");
    url.searchParams.append("filter[type][]", "incoming_chat_message");
    url.searchParams.set("filter[created_at][from]", String(dateFrom));
    url.searchParams.set("filter[created_at][to]", String(dateTo));
    url.searchParams.set("limit", "250");
    url.searchParams.set("page", String(page));

    const res = await rateLimitedFetch(url.toString(), { headers });
    if (res.status === 204) break;
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Kommo message events ${res.status}: ${text}`);
    }

    const data = (await res.json()) as KommoPaginatedResponse<KommoEvent>;
    const items = data._embedded?.events ?? [];

    for (const ev of items) {
      const msgId = (ev.value_after?.[0] as Record<string, unknown>)?.message as
        | { id: string }
        | undefined;
      if (!msgId?.id || ev.entity_type !== "lead") continue;
      result.push({
        type: ev.type === "incoming_chat_message" ? "incoming_chat_message" : "outgoing_chat_message",
        messageId: msgId.id,
        leadId: ev.entity_id,
        createdBy: ev.created_by,
        createdAt: ev.created_at,
      });
    }

    if (!data._links?.next) break;
    page++;
  }

  return result;
}

/**
 * Fetch lead_status_changed events for a date range.
 */
export async function getStatusChangeEvents(
  dateFrom: number,
  dateTo: number,
  maxPages = 200,
): Promise<Array<{
  eventId: string;
  leadId: number;
  createdAt: number;
  createdBy: number;
  afterStatusId: number;
  afterPipelineId: number;
  beforeStatusId: number;
  beforePipelineId: number;
}>> {
  const baseUrl = await getBaseUrl();
  const headers = await getAuthHeaders();
  const result: Array<{
    eventId: string;
    leadId: number;
    createdAt: number;
    createdBy: number;
    afterStatusId: number;
    afterPipelineId: number;
    beforeStatusId: number;
    beforePipelineId: number;
  }> = [];

  let page = 1;
  while (page <= maxPages) {
    const url = new URL(`${baseUrl}/events`);
    url.searchParams.append("filter[type][]", "lead_status_changed");
    url.searchParams.set("filter[created_at][from]", String(dateFrom));
    url.searchParams.set("filter[created_at][to]", String(dateTo));
    url.searchParams.set("limit", "250");
    url.searchParams.set("page", String(page));

    const res = await rateLimitedFetch(url.toString(), { headers });
    if (res.status === 204) break;
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Kommo status events ${res.status}: ${text}`);
    }

    const data = (await res.json()) as KommoPaginatedResponse<KommoEvent>;
    const items = data._embedded?.events ?? [];

    for (const ev of items) {
      const after = (ev.value_after?.[0] as Record<string, unknown>)?.lead_status as
        | { id: number; pipeline_id: number }
        | undefined;
      const before = (ev.value_before?.[0] as Record<string, unknown>)?.lead_status as
        | { id: number; pipeline_id: number }
        | undefined;
      if (!after) continue;

      result.push({
        eventId: String(ev.id),
        leadId: ev.entity_id,
        createdAt: ev.created_at,
        createdBy: ev.created_by,
        afterStatusId: after.id,
        afterPipelineId: after.pipeline_id,
        beforeStatusId: before?.id ?? 0,
        beforePipelineId: before?.pipeline_id ?? 0,
      });
    }

    if (!data._links?.next) break;
    page++;
  }

  return result;
}

/**
 * Batch-fetch contact notes by note ID from the contacts endpoint.
 */
/**
 * Fetch call note params (duration, call_status) for a list of note IDs.
 * Splits by entity type so each batch hits the correct endpoint
 * (contact notes → /contacts/notes, lead notes → /leads/notes).
 * This avoids wasted 204 responses that caused the old single-endpoint approach
 * to take 20+ minutes on large datasets.
 */
export async function getCallNoteParams(
  notes: ReadonlyArray<{ noteId: number; entityType: string }>,
): Promise<Map<number, { duration: number; callStatus: number | undefined }>> {
  if (notes.length === 0) return new Map();

  const baseUrl = await getBaseUrl();
  const headers = await getAuthHeaders();
  const result = new Map<number, { duration: number; callStatus: number | undefined }>();

  // Group note IDs by entity endpoint
  const byEndpoint = new Map<string, number[]>();
  for (const n of notes) {
    const entityPlurals: Record<string, string> = { lead: "leads", contact: "contacts", company: "companies", customer: "customers" };
    const endpoint = entityPlurals[n.entityType] ?? "contacts";
    if (!byEndpoint.has(endpoint)) byEndpoint.set(endpoint, []);
    byEndpoint.get(endpoint)!.push(n.noteId);
  }

  const BATCH = 100;
  for (const [endpoint, ids] of byEndpoint) {
    const uniqIds = [...new Set(ids)];
    for (let i = 0; i < uniqIds.length; i += BATCH) {
      const batch = uniqIds.slice(i, i + BATCH);
      const url = new URL(`${baseUrl}/${endpoint}/notes`);
      url.searchParams.set("limit", "250");
      batch.forEach((id) => url.searchParams.append("filter[id][]", String(id)));

      let page = 1;
      while (true) {
        const pageUrl = new URL(url.toString());
        pageUrl.searchParams.set("page", String(page));
        const res = await rateLimitedFetch(pageUrl.toString(), { headers });
        if (res.status === 204) break;
        if (!res.ok) {
          console.warn(`[ETL] ${endpoint}/notes batch failed: ${res.status}`);
          break;
        }
        const data = (await res.json()) as KommoPaginatedResponse<KommoCallNote>;
        for (const n of data._embedded?.notes ?? []) {
          result.set(n.id, {
            duration: Number(n.params?.duration) || 0,
            callStatus: n.params?.call_status,
          });
        }
        if (!data._links?.next) break;
        page++;
      }
    }
  }

  return result;
}

// ==================== Generic events fetch (for Tracking tab) ====================

export interface RawKommoEventRow {
  id: number;
  type: string;
  createdBy: number;
  createdAt: number;
  entityType: string;
  entityId: number;
  noteId: number | null;
  raw: Record<string, unknown>;
}

/**
 * Fetch all events for a date range, optionally filtered by creator (manager
 * Kommo user IDs) and/or event types. No type-specific shaping — consumers
 * classify as needed.
 *
 * Resilience model (see `tryFetchBatchBisected` + `fetchBatchPages`):
 *  - Auth errors (401/403) abort the whole call — fix credentials.
 *  - Unknown event type (400 "Invalid params" value=<T>) → bisect the type
 *    batch until the culprit is isolated, then blacklist it in-process so
 *    future calls skip it. Other types in the batch still sync.
 *  - 5xx errors → retried up to 3× with exponential backoff; then the batch
 *    is skipped (logged) and the next batch proceeds.
 *  - Other 4xx → batch skipped, logged.
 *  - Pagination cap hit → batch truncated, logged.
 *
 * Streaming mode: if `onBatch` is provided, it fires after every successful
 * (user × type) batch with that batch's deduped events. Lets callers
 * incrementally persist — no more "lost 30k events because page 50 threw".
 * Return value still contains all events (legacy callers unchanged).
 *
 * Kommo `/events` batching constraints we respect:
 *  - `filter[created_by][]` capped at 10 IDs per call → USER_BATCH=10.
 *  - Without `filter[type][]`, pages are dominated by system/robot events
 *    we can't attribute. Callers MUST pass `types` explicitly.
 *  - `filter[type][]` has no hard cap but URL length matters → TYPE_BATCH=20.
 */
const TYPE_BATCH = 20;
const USER_BATCH = 10;

// Process-level blacklist of types Kommo has rejected at least once this
// lifetime. Learned lazily via bisect; cleared on restart (by design — forces
// a re-verification in case Kommo re-enables a type). Not per-department:
// both B2G and B2B use the same Kommo account / same API schema.
const INVALID_EVENT_TYPES = new Set<string>();

/** Snapshot of the current blacklist — for observability/logs/admin endpoints. */
export function getInvalidEventTypes(): string[] {
  return Array.from(INVALID_EVENT_TYPES).sort();
}

type RawBatchResult =
  | { status: "ok"; events: RawKommoEventRow[]; truncated: boolean }
  | { status: "invalid_type"; body: string }
  | { status: "skip"; reason: string };

/**
 * Fetch all pages for one (userBatch, typeBatch) pair. Retries transient
 * failures (5xx) up to 3× per page with exponential backoff. Returns a
 * discriminated result so the caller can react to "invalid type in filter"
 * with bisection instead of giving up.
 */
async function fetchBatchPages(
  baseUrl: string,
  headers: HeadersInit,
  dateFrom: number,
  dateTo: number,
  userBatch: number[],
  typeBatch: string[] | null,
  maxPages: number,
): Promise<RawBatchResult> {
  const events: RawKommoEventRow[] = [];
  const seen = new Set<number>();
  let truncated = false;
  let page = 1;

  while (page <= maxPages) {
    const url = new URL(`${baseUrl}/events`);
    url.searchParams.set("filter[created_at][from]", String(dateFrom));
    url.searchParams.set("filter[created_at][to]", String(dateTo));
    // Max per docs is 250, not 100 — 2.5× fewer pages per batch, less risk
    // of hitting the pagination cap on busy managers.
    url.searchParams.set("limit", "250");
    url.searchParams.set("page", String(page));
    // Kommo docs specify filter[created_by] and filter[type] as comma-
    // separated STRING values, not PHP-style repeated `[]` keys. The `[]`
    // form sometimes works but silently narrows results for multi-entity
    // event types — major cause of under-reported CRM activity on the
    // timeline before we switched. Keep .set() (single key) with join.
    if (userBatch.length > 0) {
      url.searchParams.set("filter[created_by]", userBatch.join(","));
    }
    if (typeBatch && typeBatch.length > 0) {
      url.searchParams.set("filter[type]", typeBatch.join(","));
    }
    // Without filter[entity], /events returns only lead-scoped events by
    // default — contact/company/customer/task events (contact_linked,
    // task_completed, custom_field_value_changed on non-leads, etc.) never
    // come through, which is ~half of CRM-activity minute coverage.
    url.searchParams.set("filter[entity]", "lead,contact,company,customer,task");

    // Per-page retry loop for 5xx. 429 is handled inside rateLimitedFetch;
    // network errors are retried once there but still surface if the retry
    // also fails, so we catch here and convert to a `skip` result instead of
    // letting the exception kill the whole sync.
    let res: Response | null = null;
    let lastErr = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        res = await rateLimitedFetch(url.toString(), { headers });
      } catch (networkErr) {
        lastErr = networkErr instanceof Error ? networkErr.message : String(networkErr);
        const backoffMs = 1000 * 2 ** attempt;
        console.warn(
          `[fetchRawEvents] network error on page ${page} (attempt ${attempt + 1}/3), ` +
            `backing off ${backoffMs}ms — ${lastErr}`,
        );
        await new Promise<void>((r) => setTimeout(r, backoffMs));
        continue;
      }
      if (res.status < 500 || res.status === 501) break;
      lastErr = `${res.status} ${res.statusText}`;
      const backoffMs = 1000 * 2 ** attempt;
      console.warn(
        `[fetchRawEvents] 5xx on page ${page} (attempt ${attempt + 1}/3), ` +
          `backing off ${backoffMs}ms — ${lastErr}`,
      );
      await new Promise<void>((r) => setTimeout(r, backoffMs));
    }
    if (!res) return { status: "skip", reason: `no response after 3 attempts: ${lastErr}` };

    if (res.status === 204) break;
    if (res.status === 404) break;
    if (res.status >= 500) {
      return { status: "skip", reason: `5xx after retries: ${lastErr}` };
    }
    if (res.status === 401 || res.status === 403) {
      // Fatal — not our problem to paper over. Caller's try/catch will surface
      // it to the operator (credentials need rotating / scope adjusted).
      throw new Error(`Kommo events API ${res.status}: auth/permission`);
    }
    if (!res.ok) {
      const text = await res.text();
      // Kommo returns the error detail either with or without a trailing
      // period depending on the version, and sometimes wraps it in different
      // quoting. Match the stable prefix without quotes so both variants hit.
      if (res.status === 400 && text.includes("Invalid params passed to filter")) {
        return { status: "invalid_type", body: text };
      }
      return { status: "skip", reason: `${res.status}: ${text.slice(0, 200)}` };
    }

    const data = (await res.json()) as KommoPaginatedResponse<KommoEvent>;
    const items = data._embedded?.events ?? [];

    for (const ev of items) {
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      const noteId = ev.value_after?.[0]?.note?.id ?? null;
      events.push({
        id: ev.id,
        type: ev.type,
        createdBy: ev.created_by,
        createdAt: ev.created_at,
        entityType: ev.entity_type,
        entityId: ev.entity_id,
        noteId,
        raw: { value_after: ev.value_after },
      });
    }

    if (!data._links?.next) break;
    page++;
    if (page > maxPages) {
      truncated = true;
      console.warn(
        `[fetchRawEvents] pagination cap hit (${maxPages} pages) for ` +
          `users=[${userBatch.join(",")}] types=[${typeBatch?.join(",") ?? "*"}] ` +
          `range=${new Date(dateFrom * 1000).toISOString()}..${new Date(dateTo * 1000).toISOString()} ` +
          `— further events from this batch dropped`,
      );
    }
  }

  return { status: "ok", events, truncated };
}

/**
 * Attempts to fetch a batch; on "invalid type" rejection, recursively bisects
 * the type batch to isolate the offender, blacklists it, and retries the good
 * halves. Parallel recursion is safe — rateLimitedFetch serializes at the HTTP
 * layer. With a 20-type batch, bisect adds at most ~5 extra requests to find
 * the single bad type; subsequent calls skip it entirely.
 */
async function tryFetchBatchBisected(
  baseUrl: string,
  headers: HeadersInit,
  dateFrom: number,
  dateTo: number,
  userBatch: number[],
  typeBatch: string[] | null,
  maxPages: number,
): Promise<RawKommoEventRow[]> {
  // Re-filter against the (possibly grown) blacklist every recursion level,
  // so the second half of a bisect doesn't re-encounter a type the first half
  // just blacklisted. Also keeps later batches in the same `fetchRawEvents`
  // call from repeating the bisect for the same known-bad type.
  if (typeBatch && typeBatch.length > 0 && INVALID_EVENT_TYPES.size > 0) {
    const filtered = typeBatch.filter((t) => !INVALID_EVENT_TYPES.has(t));
    if (filtered.length === 0) return [];
    if (filtered.length < typeBatch.length) typeBatch = filtered;
  }

  const result = await fetchBatchPages(
    baseUrl, headers, dateFrom, dateTo, userBatch, typeBatch, maxPages,
  );

  if (result.status === "ok") return result.events;

  if (result.status === "skip") {
    console.warn(
      `[fetchRawEvents] batch skipped: users=[${userBatch.join(",")}] ` +
        `types=[${typeBatch?.join(",") ?? "*"}] — ${result.reason}`,
    );
    return [];
  }

  // invalid_type — need to bisect to find the culprit
  if (!typeBatch || typeBatch.length === 0) {
    // Can only happen if Kommo rejects something unrelated to filter[type][]
    // with that error message. Treat as skip — not our call to make.
    console.error(
      `[fetchRawEvents] invalid_type response with no type filter, skipping: ${result.body.slice(0, 200)}`,
    );
    return [];
  }
  if (typeBatch.length === 1) {
    const bad = typeBatch[0];
    INVALID_EVENT_TYPES.add(bad);
    console.warn(
      `[fetchRawEvents] blacklisting unsupported event type "${bad}" — ` +
        `will be skipped from all future Kommo /events requests this process`,
    );
    return [];
  }

  const mid = Math.floor(typeBatch.length / 2);
  const [leftEvents, rightEvents] = await Promise.all([
    tryFetchBatchBisected(baseUrl, headers, dateFrom, dateTo, userBatch, typeBatch.slice(0, mid), maxPages),
    tryFetchBatchBisected(baseUrl, headers, dateFrom, dateTo, userBatch, typeBatch.slice(mid), maxPages),
  ]);
  return [...leftEvents, ...rightEvents];
}

export async function fetchRawEvents(
  dateFrom: number,
  dateTo: number,
  opts?: {
    kommoUserIds?: number[];
    types?: string[];
    maxPages?: number;
    /**
     * Fires after every successful (user × type) batch. Events are deduped
     * within the batch but NOT across batches — the caller is expected to
     * rely on its own idempotent persistence (ON CONFLICT DO NOTHING). Use
     * this to stream events into the DB so partial failures don't lose
     * already-fetched data.
     */
    onBatch?: (events: RawKommoEventRow[]) => Promise<void>;
  },
): Promise<RawKommoEventRow[]> {
  const baseUrl = await getBaseUrl();
  const headers = await getAuthHeaders();
  const maxPages = opts?.maxPages ?? 100;

  // Pre-filter against the process-level blacklist. Types we already know
  // Kommo rejects never go into a filter[type][] list again.
  let effectiveTypes = opts?.types;
  if (effectiveTypes && effectiveTypes.length > 0 && INVALID_EVENT_TYPES.size > 0) {
    const filtered = effectiveTypes.filter((t) => !INVALID_EVENT_TYPES.has(t));
    const dropped = effectiveTypes.length - filtered.length;
    if (dropped > 0) {
      console.info(
        `[fetchRawEvents] pre-filtered ${dropped} blacklisted type(s): ` +
          `${effectiveTypes.filter((t) => INVALID_EVENT_TYPES.has(t)).join(",")}`,
      );
    }
    // If every requested type is blacklisted, return empty. Crucially, do NOT
    // fall through to the null-types path below — that would hit Kommo
    // unfiltered and flood us with events the caller didn't ask for (plus
    // burn the page budget on system/robot noise).
    if (filtered.length === 0) return [];
    effectiveTypes = filtered;
  }

  // User batches — `filter[created_by][]` caps at 10. Empty list = caller
  // signalled "no managers" and we short-circuit. Missing = unfiltered (legacy).
  const idBatches: number[][] = [];
  const userIdsProvided = opts?.kommoUserIds !== undefined;
  if (userIdsProvided && (opts!.kommoUserIds!.length === 0)) {
    return [];
  }
  if (opts?.kommoUserIds && opts.kommoUserIds.length > 0) {
    for (let i = 0; i < opts.kommoUserIds.length; i += USER_BATCH) {
      idBatches.push(opts.kommoUserIds.slice(i, i + USER_BATCH));
    }
  } else {
    idBatches.push([]);
  }

  // Type batches — chunk for URL-length safety. `null` = no filter[type][]
  // (kept for ad-hoc callers, but the JSDoc strongly discourages it).
  const typeBatches: (string[] | null)[] = [];
  if (effectiveTypes && effectiveTypes.length > 0) {
    for (let i = 0; i < effectiveTypes.length; i += TYPE_BATCH) {
      typeBatches.push(effectiveTypes.slice(i, i + TYPE_BATCH));
    }
  } else {
    typeBatches.push(null);
  }

  const byId = new Map<number, RawKommoEventRow>();

  for (const userBatch of idBatches) {
    for (const typeBatch of typeBatches) {
      const batchEvents = await tryFetchBatchBisected(
        baseUrl, headers, dateFrom, dateTo, userBatch, typeBatch, maxPages,
      );

      // Streaming persistence hook: caller gets this batch's events before we
      // even finish the next one. Errors in the caller's persistence layer
      // still abort the whole sync — if you can't write, the watermark must
      // not advance past the last durable insert.
      if (opts?.onBatch && batchEvents.length > 0) {
        await opts.onBatch(batchEvents);
      }

      for (const ev of batchEvents) {
        if (!byId.has(ev.id)) byId.set(ev.id, ev);
      }
    }
  }

  return Array.from(byId.values());
}
