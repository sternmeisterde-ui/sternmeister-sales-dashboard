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

// Kommo's 7 req/sec is account-wide (per subdomain), shared with okk and any
// other company integrators on the same account regardless of token (different
// OAuth tokens go into the SAME bucket).
//
// Policy: each of OUR processes self-caps at 1 req/sec (1000 ms gap). Worst
// case both Dashbord + okk burst simultaneously = 2 req/sec total from us,
// leaving 5 req/sec for the other integrators. Conservative on purpose —
// bumping this requires coordinating with the okk client at
// /Users/user/okk/src/services/kommo.ts (RATE_LIMIT_MS) so the combined
// ceiling stays ≤ 2 req/sec.
// KOMMO_RATE_LIMIT_MS может только ЗАМЕДЛИТЬ (floor 1000 мс) — для локальных
// массовых прогонов (drain-enrich и т.п.), идущих параллельно с прод-кроном:
// ставим 2500-3000, чтобы суммарная нагрузка от нас оставалась щадящей.
// Ускорить через env нельзя намеренно (правило владельца: ≤1 rps на процесс).
const RATE_LIMIT_MS = Math.max(1000, Number(process.env.KOMMO_RATE_LIMIT_MS) || 1000);
// Per-request timeout for Kommo. Most calls complete in <2s; setting 30s
// guards against socket stalls without rejecting the legitimate slow tail
// (lead-list pages with `with=` joins occasionally take 10-15s on large
// accounts). A stalled connection here would otherwise block the global
// mutex queue indefinitely on long ETL runs.
const KOMMO_REQUEST_TIMEOUT_MS = 30_000;

let lastRequestTime = 0;
let rateLimitMutex: Promise<void> = Promise.resolve();

function fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
  // Compose the caller's signal (if any) with our default 30s timeout via
  // AbortSignal.any — both can fire and abort the request. Earlier version
  // skipped the timeout when caller passed a signal, which would silently
  // remove the stall guard for any future request-scoped AbortController.
  const timeoutSignal = AbortSignal.timeout(KOMMO_REQUEST_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  return fetch(url, { ...options, signal });
}

export async function rateLimitedFetch(url: string, options: RequestInit): Promise<Response> {
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

  // Fetch with 1 retry on socket/network errors (timeouts included via
  // AbortSignal.timeout — they surface as a TimeoutError/AbortError DOMException
  // that the catch block treats the same as any other transient network issue).
  let res: Response;
  try {
    res = await fetchWithTimeout(url, options);
  } catch {
    // Retry once on network errors (socket closed, timeout, etc.)
    await new Promise<void>((r) => setTimeout(r, 500));
    res = await fetchWithTimeout(url, options);
  }

  // 429 Too Many Requests — wait and retry through the mutex so the retry
  // still respects the global rate limit (bare fetch would race the next caller).
  // Honour HTTP Retry-After header first (seconds or HTTP-date per RFC 7231),
  // then JSON body's `retry_after`, then a 1.5 s default.
  if (res.status === 429) {
    let retryAfterMs = 1500;
    const headerVal = res.headers.get("retry-after");
    if (headerVal) {
      const asInt = Number.parseInt(headerVal, 10);
      if (Number.isFinite(asInt) && asInt > 0) {
        retryAfterMs = asInt * 1000;
      } else {
        const asDate = Date.parse(headerVal);
        if (Number.isFinite(asDate)) {
          retryAfterMs = Math.max(0, asDate - Date.now());
        }
      }
    } else {
      try {
        const body = await res.clone().json() as { retry_after?: number };
        if (body.retry_after) retryAfterMs = body.retry_after * 1000;
      } catch { /* use default */ }
    }
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
/**
 * Sticky flag: env token produced a 401, so skip the env source until process
 * restart (or 30-min refresh window — see CONFIG_REFRESH_MS) and use DB.
 *
 * Why this exists: Dokploy's KOMMO_ACCESS_TOKEN was set once and is never
 * rotated, while the kommo_tokens table is updated by the OAuth refresh
 * flow on every renewal. When the env value goes stale (Kommo OAuth tokens
 * are typically 24h-lived), every request hammers api-c with the bad token
 * and gets 401 — `resetKommoConfig()` would just re-load the same bad env
 * value on the next attempt, so we'd loop infinitely. Marking env as failed
 * lets the second attempt fall through to the DB token.
 */
let _envTokenAuthFailed = false;

/** Re-check token from DB every 30 minutes (picks up refreshed tokens without restart) */
const CONFIG_REFRESH_MS = 30 * 60 * 1000;

/** Track consecutive API failures for diagnostics */
let _consecutiveFailures = 0;
export function getKommoHealth() {
  const envSet = !!process.env.KOMMO_ACCESS_TOKEN;
  const skipEnv = process.env.KOMMO_TOKEN_SOURCE === "db" || _envTokenAuthFailed;
  const effectiveSource = envSet && !skipEnv ? "env" : (_cachedToken ? "db" : "none");
  return {
    consecutiveFailures: _consecutiveFailures,
    tokenLoadedAt: _configLoadedAt ? new Date(_configLoadedAt).toISOString() : null,
    domain: _cachedDomain,
    tokenSource: effectiveSource,
    envTokenAuthFailed: _envTokenAuthFailed,
    tokenSourceOverride: process.env.KOMMO_TOKEN_SOURCE ?? null,
  };
}

function ensureKommoConfig(): Promise<void> {
  const needsRefresh = _configLoadedAt > 0 && (Date.now() - _configLoadedAt) > CONFIG_REFRESH_MS;

  if (!_configPromise || needsRefresh) {
    // If refreshing, don't null out _configPromise until new one resolves
    // (prevents concurrent requests from all hitting DB at once)
    const newPromise = (async () => {
      // KOMMO_TOKEN_SOURCE=db: explicit operator-controlled override that
      // skips the env token entirely and goes straight to kommo_tokens DB.
      // Use when env contains a stale/wrong token but you can't (or don't
      // want to) unset it from Dokploy — set KOMMO_TOKEN_SOURCE=db once,
      // restart, done.
      // _envTokenAuthFailed: same bypass triggered automatically after a
      // 401 on the env token, so the next reload self-heals to DB.
      const skipEnv = process.env.KOMMO_TOKEN_SOURCE === "db" || _envTokenAuthFailed;

      // 1. Check env vars first
      if (process.env.KOMMO_ACCESS_TOKEN && !skipEnv) {
        _cachedToken = process.env.KOMMO_ACCESS_TOKEN;
        // Honour KOMMO_API_DOMAIN verbatim — empirically this Kommo account
        // works on `${subdomain}.kommo.com` and 401s on `api-c.kommo.com`,
        // even though the JWT's `api_domain` claim says api-c. The auto-pick
        // is just a fallback for when no env override is provided.
        _cachedDomain = process.env.KOMMO_API_DOMAIN || "api-c.kommo.com";
        _configLoadedAt = Date.now();
        return;
      }

      // 2. Fallback: load from kommo_tokens table in D1 (main branch DB).
      // Host resolution priority:
      //   (a) KOMMO_API_DOMAIN env override (operator-controlled),
      //   (b) `${subdomain}.kommo.com` from the DB row (matches what the
      //       integration was provisioned against — empirically this is
      //       the host that actually accepts the token on SternMeister's
      //       account; the JWT's `api_domain` hint pointing at api-c is
      //       misleading and 401s for this account).
      try {
        const { db } = await import("../db/index");
        const { kommoTokens } = await import("../db/schema-existing");
        const rows = await db.select().from(kommoTokens).limit(1);
        if (rows.length > 0) {
          _cachedToken = rows[0].accessToken;
          _cachedDomain = process.env.KOMMO_API_DOMAIN || `${rows[0].subdomain}.kommo.com`;
          _configLoadedAt = Date.now();
          console.log(`[Kommo] Token loaded from DB (account=${rows[0].subdomain}, host=${_cachedDomain}, expires=${rows[0].expiresAt?.toISOString() ?? "unknown"})`);
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

/**
 * Mark the env token as bad (called on 401 by callers that know the env
 * token was the one in flight). The next ensureKommoConfig() will skip
 * env and go to DB. Sticky for this process.
 */
function markEnvTokenAuthFailed(): void {
  if (_envTokenAuthFailed) return;
  _envTokenAuthFailed = true;
  console.warn(
    "[Kommo] env-token authentication failed — switching to DB-stored token for the rest of this process " +
      "(set KOMMO_TOKEN_SOURCE=db in Dokploy to skip env from the start)",
  );
}

/**
 * Heuristic: a 403 with nginx-shaped HTML body is Kommo's response to a
 * revoked token at `${subdomain}.kommo.com`, not a permission denial.
 * Per commit 1d3af60 incident notes: "nginx returns 403 HTML on revoked
 * tokens at ${subdomain}.kommo.com, not because the host is wrong but
 * because the token is dead." We treat such responses the same as a 401
 * for failover purposes — env→DB token swap, retry — instead of bubbling
 * a permanent error and looping the cron forever.
 *
 * A genuine permission-403 from Kommo's app server returns JSON, not
 * nginx HTML, so this signature stays narrow.
 */
function isNginxAuthFailure(status: number, body: string): boolean {
  if (status !== 403) return false;
  const lc = body.slice(0, 512).toLowerCase();
  return lc.includes("<html") && lc.includes("nginx") && lc.includes("forbidden");
}

/**
 * True iff the currently-cached token came from process.env (vs. DB).
 * Used by 401 handlers to decide whether to mark env as failed.
 */
function envTokenInUse(): boolean {
  return !!process.env.KOMMO_ACCESS_TOKEN
    && !_envTokenAuthFailed
    && process.env.KOMMO_TOKEN_SOURCE !== "db"
    && _cachedToken === process.env.KOMMO_ACCESS_TOKEN;
}

// ==================== HELPERS ====================

export async function getAuthHeaders(): Promise<HeadersInit> {
  await ensureKommoConfig();
  return {
    Authorization: `Bearer ${_cachedToken}`,
    "Content-Type": "application/json",
  };
}

export async function getBaseUrl(): Promise<string> {
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
    const text = await res.text();
    if (res.status === 401 || isNginxAuthFailure(res.status, text)) {
      const reason = res.status === 401 ? "401 Unauthorized" : "403 nginx (revoked token)";
      console.error(`[Kommo] ${reason} — resetting cached config for re-load`);
      if (envTokenInUse()) markEnvTokenAuthFailed();
      resetKommoConfig();
    }
    throw new Error(`Kommo API ${res.status}: ${text}`);
  }
  _consecutiveFailures = 0;
  return res.json();
}

/**
 * Public helper for ad-hoc Kommo API requests (analysis pipeline, debug tools).
 * Accepts a path-with-query string (e.g. `/leads?filter[...]=...&page=1`) and
 * runs it through the same auth + rate-limit + 5xx retry stack the rest of the
 * dashboard uses. Returns parsed JSON, or null on 204.
 *
 * Intentionally separate from `kommoGet<T>` so callers passing a fully-formed
 * Kommo frontend URL's search string (with PHP-style nested filters) don't
 * have to deconstruct it back into a params object.
 *
 * Auth is re-resolved on every attempt — important after a 401 forces a
 * `resetKommoConfig`, so retries pick up the freshly-loaded token instead of
 * sending the stale one cached at the start of the loop.
 */
export async function kommoFetchPath(pathWithQuery: string): Promise<unknown> {
  // Validate via URL constructor so malformed PHP-bracket params surface here
  // (clear stack trace) instead of inside fetch with a cryptic message. The
  // URL is resolved inside the loop so a config refresh between attempts gets
  // applied to the next request.
  let waitMs = 500;
  for (let attempt = 0; attempt < 5; attempt++) {
    const baseUrl = await getBaseUrl();
    const headers = await getAuthHeaders();
    const rawUrl = `${baseUrl}${pathWithQuery}`;
    let url: string;
    try {
      // Validate by parsing — surfaces malformed input here instead of via a
      // cryptic fetch error. Concatenation (not URL(rel, base)) preserves the
      // /api/v4 path prefix; URL constructor with a leading-slash relative
      // would replace it.
      url = new URL(rawUrl).toString();
    } catch (e) {
      throw new Error(`kommoFetchPath: invalid URL "${rawUrl}": ${e instanceof Error ? e.message : e}`);
    }
    const res = await rateLimitedFetch(url, { headers });
    if (res.status === 204) return null;
    if (res.ok) {
      _consecutiveFailures = 0;
      return res.json();
    }
    _consecutiveFailures++;
    // Read body once so we can inspect it for the nginx-revoked-token
    // signature without consuming the stream twice. The body is small
    // (<512 chars for the 403 case, JSON body otherwise), so this is cheap.
    const text = await res.text();
    const isNginx403 = isNginxAuthFailure(res.status, text);
    if (res.status === 401 || isNginx403) {
      const reason = res.status === 401 ? "401 Unauthorized" : "403 nginx (revoked token)";
      console.error(`[Kommo] ${reason} — resetting cached config for re-load`);
      if (envTokenInUse()) markEnvTokenAuthFailed();
      resetKommoConfig();
    }
    // 403-nginx is treated as retriable too — once env→DB swap fires, the
    // next attempt picks up the live DB token without bubbling a permanent
    // error.
    const retriable = res.status === 429 || res.status >= 500 || res.status === 401 || isNginx403;
    if (!retriable || attempt === 4) {
      // Include host in the error so a 403 nginx HTML body is unambiguously
      // attributable to the wrong API host vs. an actual auth/permission
      // problem on the right host. Caller (DB error_message) sees the host.
      const host = new URL(url).host;
      throw new Error(`Kommo API ${res.status} [${host}]: ${text.slice(0, 300)}`);
    }
    const retryAfter = Number(res.headers.get("retry-after") ?? "0");
    const backoff = retryAfter > 0 ? retryAfter * 1000 : waitMs;
    await new Promise<void>((r) => setTimeout(r, backoff));
    waitMs *= 2;
  }
  throw new Error("Kommo API: exhausted retries");
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
      const text = await res.text();
      if (res.status === 401 || isNginxAuthFailure(res.status, text)) {
        const reason = res.status === 401 ? "401 Unauthorized" : "403 nginx (revoked token)";
        console.error(`[Kommo] ${reason} in paginated request — resetting config`);
        if (envTokenInUse()) markEnvTokenAuthFailed();
        resetKommoConfig();
      }
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

export interface KommoContactSnapshot {
  id: number;
  name: string | null;
  first_name: string | null;
  last_name: string | null;
  responsible_user_id: number | null;
  created_at: number | null;
  updated_at: number | null;
  custom_fields_values: Array<{
    field_id: number;
    field_name: string;
    field_code: string | null;
    field_type: string;
    values: Array<{ value: unknown; enum_id?: number; enum_code?: string }>;
  }> | null;
}

/**
 * Batch-fetch full contact snapshots by ID. Used by sync-contacts to mirror
 * Kommo Contact data (name, phones from custom_fields_values) into
 * analytics.contacts. Each batch is one Kommo request at the configured rps;
 * 250 contact IDs per request is the URL-length sweet spot (well under the
 * 8KB header limit on Kommo's side).
 */
export async function getContactsByIds(
  contactIds: number[],
): Promise<KommoContactSnapshot[]> {
  if (contactIds.length === 0) return [];

  const baseUrl = await getBaseUrl();
  const headers = await getAuthHeaders();
  const result: KommoContactSnapshot[] = [];

  const BATCH = 250;
  for (let i = 0; i < contactIds.length; i += BATCH) {
    const batch = contactIds.slice(i, i + BATCH);
    const url = new URL(`${baseUrl}/contacts`);
    url.searchParams.set("limit", "250");
    batch.forEach((id) => url.searchParams.append("filter[id][]", String(id)));

    const res = await rateLimitedFetch(url.toString(), { headers });
    if (res.status === 204) continue;
    if (!res.ok) {
      console.warn(
        `[Kommo] getContactsByIds batch ${i}-${i + BATCH} failed with ${res.status}`,
      );
      continue;
    }

    const data = (await res.json()) as {
      _embedded?: { contacts?: KommoContactSnapshot[] };
    };

    const contacts = data._embedded?.contacts ?? [];
    result.push(...contacts);
  }

  return result;
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
 * Resolve a phone number to its Kommo contact + linked leads. Used by the
 * telephony enrichment ETL: CDR rows arrive without lead context (PBX writes
 * the call before any Kommo lead exists for the phone), so this lookup
 * fans them out to one row per linked lead.
 *
 * Strategy: Kommo's `?filter[query]=<phone>` is fuzzy-matched across all
 * contact fields (name, email, phone, custom). Phone digits are the most
 * specific signal so we pass them in three normalized variants (E.164 with
 * +, digits-only, last-9-digits) and union the results. `with=leads` returns
 * each contact's linked leads inline — no second round-trip.
 *
 * Returns Map<inputPhone, leadIds[]> ordered by Kommo's relevance ranking
 * (most-related contact first). Phones with zero matches map to empty array.
 *
 * Rate cost: 1 request per phone (Kommo's relevance limits how usefully we
 * can batch — different phones share no caching). Use sparingly; the ETL
 * caches results in-process.
 */
export async function searchContactsByPhone(
  phones: string[],
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (phones.length === 0) return out;

  const baseUrl = await getBaseUrl();
  const headers = await getAuthHeaders();

  // De-dup before issuing requests; same phone may appear on multiple CDR rows.
  const uniqPhones = Array.from(new Set(phones.filter((p) => p && p.trim() !== "")));

  let timeoutSkipped = 0;
  for (const phone of uniqPhones) {
    // Pick the most specific normalization that Kommo's fuzzy matcher
    // tolerates. Try digits-only first — that hits both +491234… and
    // 491234… and 0049… stored variants. If 0 hits, fall back to last-9
    // (handles country-code drift where contact stored without +49).
    const digits = phone.replace(/[^0-9]/g, "");
    const variants = [digits];
    if (digits.length >= 9) variants.push(digits.slice(-9));

    const seenLeadIds = new Set<number>();
    let foundAny = false;
    // We only call `out.set(phone, ...)` once we've gotten a real response
    // from Kommo (200 / 204 / non-2xx with body — anything that isn't a
    // network exception). That distinction matters downstream: the
    // enrich-telephony-leads skip-list trusts an entry in `out` to mean
    // "Kommo definitively had no match" and would otherwise blacklist a
    // phone that merely timed out this round.
    let gotAnyResponse = false;

    for (const variant of variants) {
      if (foundAny) break;
      const url = new URL(`${baseUrl}/contacts`);
      url.searchParams.set("filter[query]", variant);
      url.searchParams.set("with", "leads");
      url.searchParams.set("limit", "10");

      // Per-phone try/catch: a single 30s timeout on a Kommo /contacts call
      // used to bubble all the way out of enrichTelephonyLeads and abort the
      // whole tick (DASHBOARD-4, DASHBOARD-N). Now we just skip this phone
      // and continue — its row stays lead_id=NULL and the next enrichment
      // tick retries it via the 7-day lookback sweep.
      let res: Response;
      try {
        res = await rateLimitedFetch(url.toString(), { headers });
      } catch (err) {
        const isTimeout =
          err instanceof DOMException && err.name === "TimeoutError" ||
          err instanceof DOMException && err.name === "AbortError" ||
          (err instanceof Error && /timeout|abort/i.test(err.message));
        if (isTimeout) {
          timeoutSkipped++;
          console.warn(
            `[searchContactsByPhone] ${phone} (${variant}): network timeout — skipping`,
          );
          break; // skip remaining variants for this phone too
        }
        throw err;
      }
      gotAnyResponse = true;
      if (res.status === 204) continue;
      if (!res.ok) {
        console.warn(`[searchContactsByPhone] ${phone} (${variant}): ${res.status} — skipping`);
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
      for (const c of data._embedded?.contacts ?? []) {
        for (const lead of c._embedded?.leads ?? []) {
          if (!seenLeadIds.has(lead.id)) {
            seenLeadIds.add(lead.id);
            foundAny = true;
          }
        }
      }
    }

    // Only record an entry for phones we actually got a Kommo response for.
    // Timeouts / network failures leave the phone absent from `out`, so the
    // caller can retry next tick rather than blacklisting it.
    if (gotAnyResponse) {
      out.set(phone, Array.from(seenLeadIds));
    }
  }

  if (timeoutSkipped > 0) {
    console.warn(
      `[searchContactsByPhone] ${timeoutSkipped} phone(s) skipped on timeout — will retry next tick`,
    );
  }

  return out;
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
  // Full Kommo params — captured for cross-reference with telephony CDR
  // (uniq), recording playback (link), debug (phone, source), and analytics
  // (callResult). Stored in tracking_events.raw JSONB; no schema migration.
  uniq?: string;
  pbxSource?: string;
  link?: string;
  phone?: string;
  callResult?: string;
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
            uniq: n.params?.uniq,
            pbxSource: n.params?.source,
            link: n.params?.link,
            phone: n.params?.phone,
            callResult: n.params?.call_result,
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
