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
 *
 * Without `kommoUserIds`, fetches the whole account — slow on busy accounts
 * (was the cause of dashboard department-switch hangs after we raised
 * maxPages to 100). When the caller knows whose tasks it actually needs,
 * pass them as `kommoUserIds` to use Kommo's filter[responsible_user_id][]
 * (capped at 10 IDs per request, batched). For 16 managers this typically
 * cuts the response size 50–200×.
 */
export async function getTasks(
  isCompleted: boolean = false,
  kommoUserIds?: number[],
  maxPages = 20
): Promise<KommoTask[]> {
  const sortedIds = kommoUserIds && kommoUserIds.length > 0
    ? [...kommoUserIds].sort((a, b) => a - b).join(",")
    : "all";
  const cacheKey = `tasks:${isCompleted}:${sortedIds}:${maxPages}`;

  return cached(cacheKey, CACHE_TTL.TASKS, async () => {
    if (!kommoUserIds || kommoUserIds.length === 0) {
      // Account-wide fetch (legacy behaviour) — keep as a fallback for any
      // ad-hoc caller that doesn't have a manager list.
      const params: Record<string, string> = {};
      if (!isCompleted) params["filter[is_completed]"] = "0";
      return kommoGetAll<KommoTask>("/tasks", "tasks", params, maxPages);
    }

    // Filter by responsible_user_id — Kommo caps this filter at 10 IDs per
    // call, so batch and dedup by task id. Comma-separated form is what
    // works in practice on this Kommo account; an indexed-array attempt
    // (filter[responsible_user_id][0]=…) appeared to cause "период не
    // прогружается" — likely the Kommo parser was treating "0" as a
    // string key and the filter was effectively dropped, so we either
    // got an unfiltered fetch (slow) or empty results.
    const USER_BATCH = 10;
    const seen = new Map<number, KommoTask>();
    for (let i = 0; i < kommoUserIds.length; i += USER_BATCH) {
      const batch = kommoUserIds.slice(i, i + USER_BATCH);
      const params: Record<string, string> = {};
      if (!isCompleted) params["filter[is_completed]"] = "0";
      params["filter[responsible_user_id]"] = batch.join(",");
      const batchTasks = await kommoGetAll<KommoTask>("/tasks", "tasks", params, maxPages);
      for (const t of batchTasks) {
        if (!seen.has(t.id)) seen.set(t.id, t);
      }
    }
    return Array.from(seen.values());
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

    type CallEventRecord = {
      userId: number;
      type: "call_in" | "call_out";
      noteId: number;
      entityType: "contact" | "lead" | "company" | "customer";
      entityId: number;
      createdAt: number;
    };

    // Phase 1: Events API — delegate to fetchRawEvents so we get the entity
    // loop (contact/company/customer calls included) + bisect + retries.
    // Previously duplicated a stripped-down /events fetch here which missed
    // non-lead calls entirely, so duration lookup failed and every non-lead
    // call rendered as a missed call on the Tracking timeline.
    const raw = await fetchRawEvents(dateFrom, dateTo, {
      kommoUserIds,
      types: ["incoming_call", "outgoing_call"],
      maxPages,
    });
    const eventList: CallEventRecord[] = [];
    for (const ev of raw) {
      if (ev.noteId === null) continue;
      // Route to the correct /{entity}s/notes endpoint in Phase 2. "unsorted"
      // entities have notes attached as leads (they become leads once
      // sorted), so map them to "lead".
      const rawType = ev.entityType;
      const entityType: CallEventRecord["entityType"] =
        rawType === "lead" || rawType === "company" || rawType === "customer"
          ? rawType
          : rawType === "unsorted"
            ? "lead"
            : "contact";
      eventList.push({
        userId: ev.createdBy,
        type: ev.type === "incoming_call" ? "call_in" : "call_out",
        noteId: ev.noteId,
        entityType,
        entityId: ev.entityId,
        createdAt: ev.createdAt,
      });
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
      // /events filter[type] per docs is comma-separated string. With a
      // single value it doesn't matter but this aligns with the rest of
      // the file. Limit raised 100 → 250 (Kommo max) to halve page count.
      url.searchParams.set("filter[type]", "lead_status_changed");
      url.searchParams.set("filter[created_at][from]", String(dateFrom));
      url.searchParams.set("filter[created_at][to]", String(dateTo));
      url.searchParams.set("limit", "250");
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
export interface CallNoteRow {
  type: "call_in" | "call_out";
  noteId: number;
  entityType: string;
  entityId: number;
  /** User who created the note. For PBX-integrated calls this can be a
   *  service user, not the manager who actually picked up. */
  createdBy: number;
  /** Note's responsible_user — typically the lead/contact's owner. Use as
   *  fallback attribution when createdBy is a service account that isn't in
   *  master_managers. */
  responsibleUserId: number;
  createdAt: number;
  duration: number;
  callStatus: number | undefined;
}

export async function getAllCallNotesByDate(
  dateFrom: number,
  dateTo: number,
  maxPages = 500,
): Promise<CallNoteRow[]> {
  const baseUrl = await getBaseUrl();
  const headers = await getAuthHeaders();

  const result: CallNoteRow[] = [];

  // Track seen note IDs to deduplicate across entity endpoints
  const seen = new Set<number>();

  // Iterate every entity type Kommo's /notes accepts. Each entity is
  // wrapped in try/catch so a single endpoint failure (account without
  // permission, endpoint not supported for that entity, or 5xx after
  // retries) doesn't abort the whole call-fetch — losing one entity's
  // worth of calls is much better than losing all of them and watching
  // dashboard call counts go to zero.
  for (const entityType of ["contacts", "leads", "companies"] as const) {
    try {
      let page = 1;
      while (page <= maxPages) {
        const url = new URL(`${baseUrl}/${entityType}/notes`);
        url.searchParams.append("filter[note_type][]", "call_in");
        url.searchParams.append("filter[note_type][]", "call_out");
        // Kommo /notes docs only document filter[updated_at][from/to] —
        // filter[created_at] is NOT a recognized filter on this endpoint.
        // Sending it appears to be silently ignored, so the endpoint
        // returned the most recent notes (dominated by chat messages on
        // busy accounts) regardless of date range — that's why dashboard
        // call counts collapsed to ~0 even on workdays. Note that
        // updated_at == created_at for any note that's never been edited
        // (almost all PBX-written call notes), so this preserves call-time
        // semantics in practice. The note's `created_at` field in the
        // response still holds the actual call timestamp.
        // Order ascending so pagination doesn't drop oldest calls past the
        // 250-row page limit on busy accounts.
        url.searchParams.set("filter[updated_at][from]", String(dateFrom));
        url.searchParams.set("filter[updated_at][to]", String(dateTo));
        url.searchParams.set("order[updated_at]", "asc");
        url.searchParams.set("limit", "250");
        url.searchParams.set("page", String(page));

        const res = await rateLimitedFetch(url.toString(), { headers });
        if (res.status === 204) break;
        if (!res.ok) {
          const text = await res.text();
          // Soft-skip 4xx for this entity (e.g. account doesn't have
          // /companies/notes enabled, or note_type filter not supported
          // there) — fall through to the next entity instead of taking
          // down the whole call fetch.
          if (res.status >= 400 && res.status < 500) {
            console.warn(
              `[getAllCallNotesByDate] ${entityType}/notes ${res.status} — skipping entity: ${text.slice(0, 200)}`,
            );
            break;
          }
          // 5xx → throw into the per-entity catch so one entity's outage
          // doesn't take down the others.
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
            entityType:
              entityType === "contacts"
                ? "contact"
                : entityType === "companies"
                  ? "company"
                  : "lead",
            entityId: n.entity_id,
            createdBy: n.created_by,
            responsibleUserId: n.responsible_user_id,
            createdAt: n.created_at,
            duration: Number(n.params?.duration) || 0,
            callStatus: n.params?.call_status,
          });
        }

        if (!data._links?.next) break;
        page++;
      }
    } catch (err) {
      // Per-entity isolation — log and move on. The other entities still
      // contribute to `result`, and the next sync can re-attempt this one.
      console.error(
        `[getAllCallNotesByDate] ${entityType}/notes failed, continuing with other entities:`,
        err instanceof Error ? err.message : String(err),
      );
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
  // Delegate to fetchRawEvents so we automatically pick up the entity loop
  // (covers calls on contacts/companies/customers — previously missed when
  // Kommo's default lead-only scope silently filtered them out) + bisect +
  // 5xx retry + rate-limit-aware request pacing.
  const raw = await fetchRawEvents(dateFrom, dateTo, {
    types: ["incoming_call", "outgoing_call"],
    maxPages,
  });
  const result: Array<{
    type: "call_in" | "call_out";
    noteId: number;
    entityType: string;
    entityId: number;
    createdBy: number;
    createdAt: number;
  }> = [];
  for (const ev of raw) {
    if (ev.noteId === null) continue;
    result.push({
      type: ev.type === "incoming_call" ? "call_in" : "call_out",
      noteId: ev.noteId,
      entityType: ev.entityType,
      entityId: ev.entityId,
      createdBy: ev.createdBy,
      createdAt: ev.createdAt,
    });
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
  // Delegate to fetchRawEvents for entity-loop + bisect + retry. Downstream
  // (sync-communications) maps entity_id → leadId; to keep the existing
  // contract we filter here to only lead-scoped messages. Contact/customer-
  // scoped messages could be surfaced via the same contactMap mapping that
  // call events use, but that's a separate ETL enhancement — not done here
  // to avoid changing sync-communications' message-row semantics.
  const raw = await fetchRawEvents(dateFrom, dateTo, {
    types: ["incoming_chat_message", "outgoing_chat_message"],
    maxPages,
  });
  const result: Array<{
    type: "outgoing_chat_message" | "incoming_chat_message";
    messageId: string;
    leadId: number;
    createdBy: number;
    createdAt: number;
  }> = [];
  for (const ev of raw) {
    const msgWrap = (ev.raw as { value_after?: Array<Record<string, unknown>> })
      .value_after?.[0];
    const msg = msgWrap?.message as { id?: string } | undefined;
    if (!msg?.id || ev.entityType !== "lead") continue;
    result.push({
      type: ev.type === "incoming_chat_message" ? "incoming_chat_message" : "outgoing_chat_message",
      messageId: msg.id,
      leadId: ev.entityId,
      createdBy: ev.createdBy,
      createdAt: ev.createdAt,
    });
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
    // /events filter[type] is comma-sep per Kommo docs. Single value here
    // so the form doesn't matter; keeping .set() for consistency.
    url.searchParams.set("filter[type]", "lead_status_changed");
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

// Kommo /events requires filter[entity] to be a single value. Per docs the
// only valid values are: lead, contact, company, task, catalog_{LIST_ID}.
// `customer` IS a Kommo entity type elsewhere in the API, but the /events
// filter rejects it — every request was 400ing, every customer_* type got
// blacklisted under it, and customer events were never available anyway.
// `catalog_{LIST_ID}` is omitted because we don't track per-account list IDs;
// catalog/customer events would need a separate fetch path if surfaced later.
const KOMMO_ENTITIES = ["lead", "contact", "company", "task"] as const;
type KommoEntity = (typeof KOMMO_ENTITIES)[number];

// Per-entity blacklist: (entity, type) pairs Kommo rejected for that entity.
// Must be per-entity because the same type is often valid for one entity and
// not another (e.g. `segment_added` works on customer but 400s on lead). A
// single global Set would permanently lose types that are actually reachable
// via a different entity. Cleared on process restart — re-learned in ~5
// extra bisect requests per (entity, type) pair.
const INVALID_BY_ENTITY = new Map<KommoEntity, Set<string>>(
  KOMMO_ENTITIES.map((e) => [e, new Set<string>()]),
);

/** Snapshot of the current per-entity blacklist — for observability/logs. */
export function getInvalidEventTypes(): Record<KommoEntity, string[]> {
  const out = {} as Record<KommoEntity, string[]>;
  for (const e of KOMMO_ENTITIES) {
    out[e] = Array.from(INVALID_BY_ENTITY.get(e) ?? []).sort();
  }
  return out;
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
  entity: KommoEntity,
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
    // filter[entity] is single-value in Kommo. Caller (fetchRawEvents) loops
    // KOMMO_ENTITIES so contact/company/customer/task events all get covered.
    url.searchParams.set("filter[entity]", entity);
    // Max per docs is 250, not 100 — 2.5× fewer pages per batch, less risk
    // of hitting the pagination cap on busy managers.
    url.searchParams.set("limit", "250");
    url.searchParams.set("page", String(page));
    // Kommo docs specify filter[created_by] and filter[type] as comma-
    // separated STRING values, not PHP-style repeated `[]` keys. Keep .set()
    // (single key) with join.
    if (userBatch.length > 0) {
      url.searchParams.set("filter[created_by]", userBatch.join(","));
    }
    if (typeBatch && typeBatch.length > 0) {
      url.searchParams.set("filter[type]", typeBatch.join(","));
    }

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
      // Kommo reports per-type validation failures via two different detail
      // strings depending on the failure class — both must route to bisect
      // so tryFetchBatchBisected can narrow the batch down to the single
      // offending type and blacklist it for this entity:
      //   • "Invalid params passed to filter" — the type doesn't exist in
      //     this Kommo account at all (deprecated / never enabled).
      //   • "Given filter conflict with other params" (nested:
      //     "Entity doesn't match type filter") — the type's entity scope
      //     doesn't match filter[entity]. With the per-entity outer loop
      //     this is the dominant rejection class and MUST be bisected; if
      //     it falls through to skip, whole 20-type batches get dropped
      //     and lots of valid-for-this-entity types are lost.
      // Kommo's text has "does't" (sic) in some responses and "doesn't"
      // in others — match the shared prefix "Entity does" to cover both.
      if (
        res.status === 400 &&
        (text.includes("Invalid params passed to filter") ||
          text.includes("Given filter conflict") ||
          text.includes("Entity does"))
      ) {
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
  entity: KommoEntity,
  userBatch: number[],
  typeBatch: string[] | null,
  maxPages: number,
): Promise<RawKommoEventRow[]> {
  // Re-filter against the (possibly grown) per-entity blacklist every
  // recursion level, so the second half of a bisect doesn't re-encounter a
  // type the first half just blacklisted. Also keeps later batches in the
  // same `fetchRawEvents` call from repeating bisect for the same (entity,
  // type) pair.
  const invalidForEntity = INVALID_BY_ENTITY.get(entity)!;
  if (typeBatch && typeBatch.length > 0 && invalidForEntity.size > 0) {
    const filtered = typeBatch.filter((t) => !invalidForEntity.has(t));
    if (filtered.length === 0) return [];
    if (filtered.length < typeBatch.length) typeBatch = filtered;
  }

  const result = await fetchBatchPages(
    baseUrl, headers, dateFrom, dateTo, entity, userBatch, typeBatch, maxPages,
  );

  if (result.status === "ok") return result.events;

  if (result.status === "skip") {
    console.warn(
      `[fetchRawEvents] batch skipped: entity=${entity} users=[${userBatch.join(",")}] ` +
        `types=[${typeBatch?.join(",") ?? "*"}] — ${result.reason}`,
    );
    return [];
  }

  // invalid_type — Kommo rejected either a type that doesn't exist in the
  // account OR a type whose scope doesn't match this entity (handled the
  // same way: narrow the batch until the culprit is isolated, then mark it
  // as invalid for THIS entity only — the same type may still work for
  // another entity in a later iteration).
  if (!typeBatch || typeBatch.length === 0) {
    // Entity-level rejection (e.g. account doesn't support customer events).
    // Mark the entity by blacklisting all known requested types so we don't
    // keep hammering it. With typeBatch=null we can't know which types, so
    // just log and move on — the outer loop will try other entities.
    console.error(
      `[fetchRawEvents] entity=${entity} rejected outright, skipping: ${result.body.slice(0, 200)}`,
    );
    return [];
  }
  if (typeBatch.length === 1) {
    const bad = typeBatch[0];
    invalidForEntity.add(bad);
    console.warn(
      `[fetchRawEvents] blacklisting ${entity}:${bad} — invalid for this entity ` +
        `(may still be valid for another; other entities still try it)`,
    );
    return [];
  }

  const mid = Math.floor(typeBatch.length / 2);
  const [leftEvents, rightEvents] = await Promise.all([
    tryFetchBatchBisected(baseUrl, headers, dateFrom, dateTo, entity, userBatch, typeBatch.slice(0, mid), maxPages),
    tryFetchBatchBisected(baseUrl, headers, dateFrom, dateTo, entity, userBatch, typeBatch.slice(mid), maxPages),
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

  // User batches — `filter[created_by]` caps at 10. Empty list = caller
  // signalled "no managers" and we short-circuit. Missing = unfiltered
  // (legacy path used by ETL callers pulling account-wide call events).
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

  const requestedTypes = opts?.types;
  const byId = new Map<number, RawKommoEventRow>();

  // Outer loop: KOMMO_ENTITIES. Kommo's /events requires filter[entity] as a
  // single value, so the only way to cover events across all entities is to
  // loop here. Per-entity blacklist pre-filters types so after the first
  // sync this loop costs ~1 request per (entity, user batch) pair on avg.
  for (const entity of KOMMO_ENTITIES) {
    // Pre-filter against the per-entity blacklist — types known to be invalid
    // for THIS entity never go into filter[type] again. (The same type may
    // still be valid for a different entity in a later iteration.)
    let entityTypes = requestedTypes;
    if (entityTypes && entityTypes.length > 0) {
      const invalidForEntity = INVALID_BY_ENTITY.get(entity)!;
      if (invalidForEntity.size > 0) {
        const filtered = entityTypes.filter((t) => !invalidForEntity.has(t));
        const dropped = entityTypes.length - filtered.length;
        if (dropped > 0) {
          console.info(
            `[fetchRawEvents] entity=${entity}: pre-filtered ${dropped} blacklisted type(s)`,
          );
        }
        if (filtered.length === 0) continue; // nothing to query for this entity
        entityTypes = filtered;
      }
    }

    // Type batches — chunk for URL-length safety.
    const typeBatches: (string[] | null)[] = [];
    if (entityTypes && entityTypes.length > 0) {
      for (let i = 0; i < entityTypes.length; i += TYPE_BATCH) {
        typeBatches.push(entityTypes.slice(i, i + TYPE_BATCH));
      }
    } else {
      typeBatches.push(null);
    }

    for (const userBatch of idBatches) {
      for (const typeBatch of typeBatches) {
        const batchEvents = await tryFetchBatchBisected(
          baseUrl, headers, dateFrom, dateTo, entity, userBatch, typeBatch, maxPages,
        );

        // Streaming persistence hook: caller gets this batch's events before
        // we even finish the next one. Errors in the caller's persistence
        // layer still abort the whole call — if you can't write, subsequent
        // batches must not run either.
        if (opts?.onBatch && batchEvents.length > 0) {
          await opts.onBatch(batchEvents);
        }

        for (const ev of batchEvents) {
          if (!byId.has(ev.id)) byId.set(ev.id, ev);
        }
      }
    }
  }

  return Array.from(byId.values());
}
