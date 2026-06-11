/**
 * Call Analysis Pipeline
 *
 * Flow: parse Kommo URL → fetch leads → fetch calls → transcribe → analyze → summary
 *
 * Call sourcing priority:
 *   1. Kommo lead notes (call_in/call_out) — ~80%
 *   2. OKK DB (D2/R2) by kommo_lead_id — fallback
 *   3. Dedup by recording URL/ID
 */

import { eq, sql } from "drizzle-orm";
import { getDbForDepartment as getMainDb } from "@/lib/db";
import { callAnalyses, callAnalysisFiles } from "@/lib/db/schema-existing";
import { KOMMO } from "@/lib/config/tenant";
import { kommoFetchPath } from "@/lib/kommo/client";
import { parseDateBoundary } from "@/lib/utils/date";
import {
  FAILURE_PER_CALL_PROMPT, SUCCESS_PER_CALL_PROMPT,
  FAILURE_SUMMARY_PROMPT, SUCCESS_SUMMARY_PROMPT,
  PER_CALL_MODEL, SUMMARY_MODEL,
  PER_CALL_MAX_TOKENS, SUMMARY_MAX_TOKENS,
  PER_CALL_MAX_INPUT_CHARS, SUMMARY_MAX_INPUT_CHARS,
} from "./prompts";
import { captureAnalysisException, captureAnalysisMessage } from "./sentry";

const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY || "";
const XAI_API_KEY = process.env.XAI_API_KEY || "";
const DEFAULT_MIN_DURATION = 300; // 5 min

// Per-request fetch timeouts. AbortSignal.timeout is Node 20+ / Next.js 16
// runtime native; no manual setTimeout/clearTimeout dance needed. Without
// these, a stalled TCP connection (rare but real on long runs) holds a
// concurrency slot indefinitely — at 50 calls a single zombie worker doesn't
// crash the run but quietly drops throughput by 33%.
//
// ElevenLabs Scribe v2 is a SYNCHRONOUS endpoint — one request returns the
// full transcript when the job finishes. Typical timing: ~30-60s for a
// 15-min call, ~3-5min for a 60-min call. We give it 15min headroom so a
// long call doesn't fail spuriously.
const SCRIBE_TIMEOUT_MS = 15 * 60 * 1000;
// Raised from 120s/180s after the 2026-05-22 incident: a single 60-min
// transcript per-call analysis tripped the 120s per-attempt ceiling on grok-4
// and exhausted the 180s total budget on a single attempt, throwing
// "Grok API timeout after 120000ms" and (pre-isolation) killing the whole
// 74-call run on the 8th call. 180s/attempt + 360s total gives two real
// attempts at the long tail of generation while still bounding worker
// freezes — and the per-call try/catch added in the same patch ensures one
// stuck call never aborts the rest regardless.
const GROK_TIMEOUT_MS = 180_000;
const GROK_TOTAL_TIMEOUT_MS = 360_000;
// Hard ceiling to avoid runaway cost — raised from 100 because filters with
// 300–500 qualifying deals commonly yield 150–300 matching calls and dropping
// the tail silently hid "older" qualifying calls. Still fits in ~30 min window.
const MAX_CALLS = 500;
// Concurrency limits per external service. Kommo is the strictest
// (7 req/s per docs, we stay well under). Scribe tolerates 10+ parallel.
const KOMMO_CONCURRENCY = 5;
const TRANSCRIBE_CONCURRENCY = 4;
const GROK_CONCURRENCY = 3;

// Minimal worker-pool helper — keeps memory flat (results array pre-sized)
// and cancels-on-throw behaviour, unlike naive Promise.all that fans out
// all `map` tasks immediately.
//
// Throw policy: callers are expected to handle their own per-item errors. As
// a defensive backstop, if `fn` throws anyway we log + skip that slot rather
// than aborting the whole batch through Promise.all rejection. This is the
// "any future code change that adds a new unguarded await in the worker
// shouldn't be able to kill 60+ calls' worth of work" guarantee.
async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        // Log but don't abort the pool. Caller-level catches should handle
        // their own observability; this is purely the "stop one bad worker
        // from cancelling the others" backstop.
        console.warn(
          `[mapConcurrent] worker[${i}] threw and was suppressed: ${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}`,
        );
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

// ==================== URL PARSER ====================

export function parseKommoUrl(url: string): { pipelineId: string; filters: Record<string, string[]> } | null {
  try {
    const parsed = new URL(url);
    const params = parsed.searchParams;
    const pipelineId = parsed.pathname.match(/pipeline\/(\d+)/)?.[1] || "";

    const filters: Record<string, string[]> = {};
    for (const [key, value] of params.entries()) {
      if (key.startsWith("filter")) {
        if (!filters[key]) filters[key] = [];
        filters[key].push(value);
      }
    }

    return { pipelineId, filters };
  } catch {
    return null;
  }
}

// ==================== KOMMO API ====================
// Uses the shared kommo/client.ts helper so the analysis pipeline:
//   • hits api-c.kommo.com (Kommo's API host) — not the user-facing
//     subdomain, which a CDN/WAF can 403 with bare nginx HTML;
//   • picks up rotated tokens from the kommo_tokens DB table when env is empty;
//   • shares the same global rate-limiter + 401-resets-config behaviour the
//     rest of the dashboard relies on.

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

interface KommoLeadCustomFieldValue { value?: string; enum_id?: number; enum_code?: string }
interface KommoLeadCustomField { field_id: number; values: KommoLeadCustomFieldValue[] }
interface KommoEmbeddedContact { id: number }
interface KommoLead {
  id: number;
  name: string;
  responsible_user_id: number;
  status_id: number;
  pipeline_id: number;
  created_at: number;
  closed_at?: number | null;
  custom_fields_values?: KommoLeadCustomField[] | null;
  _embedded?: { contacts?: KommoEmbeddedContact[] };
}
interface KommoNote { id: number; note_type: string; params: { duration?: number; link?: string }; created_at: number; responsible_user_id: number }

/** Result of translating a Kommo frontend URL: the API query string (filters
 * that Kommo's API understands) and the client-side filter rules that the API
 * doesn't (custom-field enums — silently dropped by /api/v4/leads even though
 * the structure is documented for create/update payloads). */
interface ParsedKommoFilter {
  apiQuery: string;
  /** Map<fieldId, Set<enumId>>. Lead passes if for every field, at least one
   * of its values' enum_id is in the corresponding set (AND-across-fields,
   * OR-within-field — same semantics the Kommo UI applies). */
  cfEnumFilter: Map<number, Set<number>>;
  /** Set of fieldIds for which the URL includes `filter[cf][FIELD_ID][]=empty`.
   * Means: a lead with no value for that CF still matches (OR'd with the
   * enum-id set). Kommo's UI behavior — picking specific enums + checking
   * "Пусто" means "any of these OR unset". Without this, picking "Пусто" in
   * the UI would silently exclude leads that match it (the user verified
   * count: 104 leads in CRM ↔ API result was 18 without `empty` support,
   * 104 with). */
  cfAllowEmpty: Set<number>;
  /** True when the URL resolved to a date-bounded API query (either explicit
   * filter_date_from/to or a recognised filter[date_preset]). Used downstream
   * to decide whether it's safe to keep paging through the result set: an
   * unbounded query can return up to ~5k leads per pipeline+status and was
   * the historical cause of "transcribed 435 calls from 5000 deals" runs. */
  hasDateFilter: boolean;
}

/**
 * Translates Kommo *frontend* URL params into Kommo *API v4* filter params,
 * plus a client-side filter rule for things the API can't filter on.
 *
 * The frontend uses a different filter syntax than the public API. Pasting
 * a frontend URL straight into /api/v4/leads silently ignores everything
 * (params it doesn't recognize) and returns every lead in the account up to
 * the pagination cap — that's why the pipeline used to scan ~5000 deals
 * even when the Kommo UI showed 596.
 *
 * Mappings handled by the API:
 *   • `filter[pipe][PIPELINE_ID][]=STATUS_ID` (one or many)
 *       → `filter[statuses][N][pipeline_id]=PIPELINE_ID`
 *         `filter[statuses][N][status_id]=STATUS_ID`
 *   • `filter_date_switch=closed|created|updated` + `filter_date_from=DD.MM.YYYY`
 *     + `filter_date_to=DD.MM.YYYY`
 *       → `filter[<api_field>][from]=<unix>` + `filter[<api_field>][to]=<unix>`
 *   • path `/pipeline/<PIPELINE_ID>/` as fallback when no status filter is set
 *       → `filter[pipeline_id][]=PIPELINE_ID`
 *
 * Handled CLIENT-SIDE (not in the API query):
 *   • `filter[cf][FIELD_ID][]=ENUM_ID` — Kommo's /api/v4/leads endpoint does
 *     NOT support filter[custom_fields_values] in GET requests despite that
 *     param being documented for create/update payloads. Sending it has no
 *     effect (confirmed via amocrm/amocrm-api-php#339 + Kommo developers
 *     forum). We extract the cf rules and apply them in-memory after the
 *     leads come back, reading each lead's `custom_fields_values` array.
 *
 * Any frontend params we don't recognise are dropped — narrowing the result
 * is always safer than passing unrecognised filters and getting an over-wide
 * dataset back. Things like `useFilter=y` are decorative and intentionally
 * ignored.
 */
function buildLeadsApiQuery(kommoUrl: string): ParsedKommoFilter {
  const parsed = new URL(kommoUrl);
  if (parsed.hostname !== KOMMO.host) throw new Error("Invalid Kommo URL domain");

  const fp = parsed.searchParams;
  const out = new URLSearchParams();

  // 1. Status pairs from filter[pipe][PID][]=SID
  const PIPE_RE = /^filter\[pipe\]\[(\d+)\]\[\]$/;
  let statusIdx = 0;
  let hasStatusFilter = false;
  for (const [key, value] of fp.entries()) {
    const m = key.match(PIPE_RE);
    if (!m) continue;
    out.append(`filter[statuses][${statusIdx}][pipeline_id]`, m[1]);
    out.append(`filter[statuses][${statusIdx}][status_id]`, value);
    statusIdx++;
    hasStatusFilter = true;
  }

  // 1b. Pipeline-only fallback from URL path. If the user filtered just by
  // pipeline tab without picking a status, use the path pipeline so we don't
  // pull leads from other pipelines. When statuses are present they already
  // pin a pipeline, so we skip this branch then.
  // Param name is `filter[pipeline_id][]` per docs (array form), NOT
  // `filter[pipeline_id]` — single-value form is silently ignored.
  if (!hasStatusFilter) {
    const pathPipeline = parsed.pathname.match(/\/pipeline\/(\d+)/)?.[1];
    if (pathPipeline) out.append("filter[pipeline_id][]", pathPipeline);
  }

  // 2. Date filter. Translates Kommo *frontend* URL date params into the
  // *API*'s `filter[<field>][from/to]` form. The frontend uses
  // `filter_date_from/to` (DD.MM.YYYY) + optional `filter_date_switch`
  // selecting which date field. Per Kommo CRM behavior the default sidebar
  // filter is by "Дата создания" (created_at), so we default `dateSwitch`
  // to "created" when the param is missing — matches what the user sees
  // when they paste a filter URL whose UI date picker was left at default.
  //
  // Important: this MUST be applied at the lead level (Kommo API). If we
  // skip it, the API returns the most-recently-updated 5k leads matching
  // status+cf, and we'd then scan ~2k+ irrelevant deals for call notes.
  // With the date applied, the API returns exactly the deals created in
  // the window — typically tens to low hundreds.
  //
  // Three URL shapes we have to recognise (Kommo emits all three depending
  // on what the user picked in the date dropdown):
  //   1. Explicit range: `filter_date_from=01.05.2026&filter_date_to=31.05.2026`
  //   2. Preset:        `filter[date_preset]=current_month` (and the rare
  //                      `filter_date_preset=current_month` shape some Kommo
  //                      builds emit)
  //   3. No date:        nothing — leave the API call unfiltered by date.
  //
  // Preset support is the one that historically broke the pipeline: a user
  // pastes a URL with `date_preset=current_month`, the code ignored it,
  // /api/v4/leads returned every lead in the pipeline+status (~5k) and we
  // burned the MAX_CALLS budget on irrelevant deals. Map every preset Kommo
  // exposes to an explicit (from, to) range in Europe/Berlin so this never
  // silently drops the date constraint again.
  const dateSwitch = fp.get("filter_date_switch") || "created";
  const apiField = dateSwitch === "closed" ? "closed_at"
    : dateSwitch === "created" ? "created_at"
    : dateSwitch === "updated" ? "updated_at"
    : "created_at"; // any unrecognized value also falls back to created_at

  const datePreset = fp.get("filter[date_preset]") ?? fp.get("filter_date_preset");
  const dateFrom = fp.get("filter_date_from");
  const dateTo = fp.get("filter_date_to");
  let resolvedFromTs: number | null = null;
  let resolvedToTs: number | null = null;
  if (dateFrom && dateTo) {
    resolvedFromTs = parseRuDate(dateFrom, false);
    resolvedToTs = parseRuDate(dateTo, true);
  } else if (datePreset) {
    const range = resolveKommoDatePreset(datePreset);
    if (range) {
      resolvedFromTs = range.fromTs;
      resolvedToTs = range.toTs;
    } else {
      // Unknown preset → loud warning in logs so the gap shows up before the
      // pipeline burns a full Grok run on the wrong dataset. Cheaper to fail
      // discoverable than silently scan 5k deals.
      console.warn(`[Analysis] Unknown filter[date_preset]=${datePreset} — date constraint NOT applied`);
    }
  }
  const hasDateFilter = resolvedFromTs !== null && resolvedToTs !== null;
  if (hasDateFilter) {
    out.set(`filter[${apiField}][from]`, String(resolvedFromTs));
    out.set(`filter[${apiField}][to]`, String(resolvedToTs));
  }

  // 3. Custom-field enum filters — collected for client-side application.
  // We deliberately do NOT add them to `out`: Kommo /api/v4/leads ignores
  // `filter[custom_fields_values]` on GET, so attempting to filter via the
  // API would not narrow the dataset and would just bloat the URL.
  //
  // Special value `empty` means "include leads where this CF is unset" —
  // OR'd with the enum_id set for that field.
  const CF_RE = /^filter\[cf\]\[(\d+)\]\[\]$/;
  const cfEnumFilter = new Map<number, Set<number>>();
  const cfAllowEmpty = new Set<number>();
  for (const [key, value] of fp.entries()) {
    const m = key.match(CF_RE);
    if (!m) continue;
    const fieldId = Number(m[1]);
    if (!Number.isFinite(fieldId)) continue;
    if (value === "empty") {
      cfAllowEmpty.add(fieldId);
      continue;
    }
    const enumId = Number(value);
    if (!Number.isFinite(enumId)) continue;
    if (!cfEnumFilter.has(fieldId)) cfEnumFilter.set(fieldId, new Set());
    cfEnumFilter.get(fieldId)!.add(enumId);
  }

  return { apiQuery: out.toString(), cfEnumFilter, cfAllowEmpty, hasDateFilter };
}

/**
 * Apply client-side custom-field-enum filter (the part Kommo's API ignores).
 * Same semantics as the Kommo UI: AND across fields, OR within a field.
 * A lead passes only if every requested field is satisfied — either at least
 * one value's enum_id is in the requested set, OR the field is unset and
 * `cfAllowEmpty` includes that field id.
 */
function passesCfFilter(
  lead: KommoLead,
  cfEnumFilter: Map<number, Set<number>>,
  cfAllowEmpty: Set<number>,
): boolean {
  if (cfEnumFilter.size === 0 && cfAllowEmpty.size === 0) return true;
  const fields = lead.custom_fields_values ?? [];
  const allFieldIds = new Set<number>([...cfEnumFilter.keys(), ...cfAllowEmpty]);
  for (const fid of allFieldIds) {
    const f = fields.find((cf) => cf.field_id === fid);
    const isEmpty = !f || !f.values || f.values.length === 0;
    if (cfAllowEmpty.has(fid) && isEmpty) continue;
    const allowed = cfEnumFilter.get(fid);
    if (!isEmpty && allowed && f!.values.some(
      (v) => v.enum_id !== undefined && allowed.has(v.enum_id),
    )) continue;
    return false;
  }
  return true;
}

/**
 * Translate Kommo's frontend date presets (the "Сегодня / Текущая неделя / …"
 * options in the filter sidebar) into an explicit [from, to] Unix-seconds
 * range in Europe/Berlin — the same wall-clock the rest of the pipeline uses.
 *
 * Presets observed in the wild (`filter[date_preset]=...`):
 *   today, yesterday,
 *   current_week, last_week,
 *   current_month, last_month,
 *   current_quarter, last_quarter,
 *   current_year, last_year
 *
 * Week boundary: Monday → Sunday (ISO 8601 / Kommo UI default). Day-of-week
 * arithmetic uses Berlin civil date so DST transitions don't shift the start.
 *
 * Returns null for unknown presets so the caller can log + continue without
 * a date filter (failing loudly is fine; silently scanning 5k leads is not).
 */
function resolveKommoDatePreset(preset: string): { fromTs: number; toTs: number } | null {
  const todayCivil = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Berlin" });
  // Compute "day - n" / "day + n" via civil-date arithmetic, then resolve
  // back to a Unix instant in Berlin TZ at the day boundary.
  const shiftCivil = (civil: string, days: number): string => {
    const [y, m, d] = civil.split("-").map(Number);
    const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
    const o = new Date(t);
    return `${o.getUTCFullYear()}-${String(o.getUTCMonth() + 1).padStart(2, "0")}-${String(o.getUTCDate()).padStart(2, "0")}`;
  };
  const toUnix = (civil: string, kind: "start" | "end"): number => {
    const b = parseDateBoundary(civil, kind);
    if (!b) throw new Error(`bad civil ${civil}`);
    return Math.floor(b.getTime() / 1000);
  };
  // ISO day-of-week (Mon=1 … Sun=7) for a Berlin civil date.
  const isoDow = (civil: string): number => {
    const [y, m, d] = civil.split("-").map(Number);
    const utcDow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun … 6=Sat
    return utcDow === 0 ? 7 : utcDow;
  };

  const [yStr, mStr] = todayCivil.split("-");
  const todayY = Number(yStr);
  const todayM = Number(mStr);
  const startOfMonth = (y: number, m: number): string => `${y}-${String(m).padStart(2, "0")}-01`;
  const lastDayOfMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();
  const endOfMonth = (y: number, m: number): string => `${y}-${String(m).padStart(2, "0")}-${String(lastDayOfMonth(y, m)).padStart(2, "0")}`;
  const addMonths = (y: number, m: number, delta: number): { y: number; m: number } => {
    const total = y * 12 + (m - 1) + delta;
    return { y: Math.floor(total / 12), m: (total % 12) + 1 };
  };

  switch (preset) {
    case "today":
      return { fromTs: toUnix(todayCivil, "start"), toTs: toUnix(todayCivil, "end") };
    case "yesterday": {
      const y = shiftCivil(todayCivil, -1);
      return { fromTs: toUnix(y, "start"), toTs: toUnix(y, "end") };
    }
    case "current_week": {
      const dow = isoDow(todayCivil); // 1..7
      const monday = shiftCivil(todayCivil, -(dow - 1));
      const sunday = shiftCivil(monday, 6);
      return { fromTs: toUnix(monday, "start"), toTs: toUnix(sunday, "end") };
    }
    case "last_week": {
      const dow = isoDow(todayCivil);
      const thisMonday = shiftCivil(todayCivil, -(dow - 1));
      const lastMonday = shiftCivil(thisMonday, -7);
      const lastSunday = shiftCivil(thisMonday, -1);
      return { fromTs: toUnix(lastMonday, "start"), toTs: toUnix(lastSunday, "end") };
    }
    case "current_month":
      return {
        fromTs: toUnix(startOfMonth(todayY, todayM), "start"),
        toTs: toUnix(endOfMonth(todayY, todayM), "end"),
      };
    case "last_month": {
      const lm = addMonths(todayY, todayM, -1);
      return {
        fromTs: toUnix(startOfMonth(lm.y, lm.m), "start"),
        toTs: toUnix(endOfMonth(lm.y, lm.m), "end"),
      };
    }
    case "current_quarter": {
      const qStart = Math.floor((todayM - 1) / 3) * 3 + 1; // 1, 4, 7, 10
      const qEnd = qStart + 2;
      return {
        fromTs: toUnix(startOfMonth(todayY, qStart), "start"),
        toTs: toUnix(endOfMonth(todayY, qEnd), "end"),
      };
    }
    case "last_quarter": {
      const qStart = Math.floor((todayM - 1) / 3) * 3 + 1;
      const prev = addMonths(todayY, qStart, -3);
      const prevEnd = addMonths(prev.y, prev.m, 2);
      return {
        fromTs: toUnix(startOfMonth(prev.y, prev.m), "start"),
        toTs: toUnix(endOfMonth(prevEnd.y, prevEnd.m), "end"),
      };
    }
    case "current_year":
      return { fromTs: toUnix(`${todayY}-01-01`, "start"), toTs: toUnix(`${todayY}-12-31`, "end") };
    case "last_year":
      return { fromTs: toUnix(`${todayY - 1}-01-01`, "start"), toTs: toUnix(`${todayY - 1}-12-31`, "end") };
    default:
      return null;
  }
}

function parseRuDate(s: string, endOfDay: boolean): number | null {
  // Accepts DD.MM.YYYY (Kommo frontend default) and treats the wall-clock as
  // Europe/Berlin (per APP_TZ rule — business operates in Berlin time and
  // matching the Kommo UI's date picker semantics keeps the analysis result
  // set identical to what the user sees in the Kommo filter). Returns Unix
  // seconds. parseDateBoundary handles DST automatically.
  const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const boundary = parseDateBoundary(`${yyyy}-${mm}-${dd}`, endOfDay ? "end" : "start");
  return boundary ? Math.floor(boundary.getTime() / 1000) : null;
}

/**
 * Kommo emits filter params in two different places depending on the page:
 *   - /leads/list/?pipeline/.../?filter[...]   → searchParams
 *   - /events/list/?with_filter=y#filter[...]  → hash (after `#`)
 *
 * Merge both into a single URLSearchParams so the rest of the parsing code
 * doesn't have to care where the user copied the URL from. Hash takes
 * precedence if both define the same key (events URLs typically only use
 * the hash, and decorative `?with_filter=y` lives in the search).
 */
function mergedParams(parsed: URL): URLSearchParams {
  // Hash takes precedence over search for the SAME key — Kommo events list
  // puts live filter state in the hash and sometimes leaves a stale
  // `filter_date_from` echo in the search. If both define `filter_date_from`,
  // `params.get()` must return the hash value (the actual live filter), not
  // the search echo. Single-value keys: drop search entries before appending
  // hash. Repeated keys (filter[main_user][], filter[event_type][]): keep
  // both so we don't lose multi-value semantics.
  const merged = new URLSearchParams();
  const hashRaw = parsed.hash && parsed.hash.length > 1 ? parsed.hash.slice(1) : "";
  const hashKeys = new Set<string>();
  if (hashRaw) {
    for (const k of new URLSearchParams(hashRaw).keys()) hashKeys.add(k);
  }
  for (const [k, v] of parsed.searchParams.entries()) {
    // Drop search-side keys that the hash will overwrite, except multi-value
    // array keys (`...[]`) where the consumer always calls getAll().
    if (hashKeys.has(k) && !k.endsWith("[]")) continue;
    merged.append(k, v);
  }
  if (hashRaw) {
    for (const [k, v] of new URLSearchParams(hashRaw).entries()) {
      merged.append(k, v);
    }
  }
  return merged;
}

/**
 * Determine whether the URL is the leads list (current default flow) or the
 * events list (`/events/list/`). Events URLs filter changes-of-state instead
 * of deals, so we resolve them through /api/v4/events and then load only the
 * matched leads.
 */
function isEventsListUrl(parsed: URL): boolean {
  return parsed.pathname.includes("/events/list");
}

interface KommoStatusValue { lead_status?: { id: number; pipeline_id: number } }
interface KommoEventRow {
  id: string;
  type: string;
  entity_id: number;
  entity_type: string;
  created_by: number;
  created_at: number;
  value_before: KommoStatusValue[] | null;
  value_after: KommoStatusValue[] | null;
}

/**
 * Translate a Kommo events-list URL into a set of matching lead IDs.
 *
 * The events list shows changes-of-state (status transitions, calls, etc.).
 * The user typically narrows it to:
 *   - filter[event_type][]=14   → status changes (API: `lead_status_changed`)
 *   - filter[entity][]=2        → entity=lead (API: `entity=lead`)
 *   - filter_date_from/to       → window
 *   - filter[value_before/after][status_lead][]=PIPE:STATUS  → status pair
 *   - filter[main_user][]=USER  → restricted by responsible user (applied
 *                                 lead-side after we load the leads, since
 *                                 events don't carry the responsible).
 *
 * The Kommo /api/v4/events endpoint supports filter[type], filter[entity],
 * filter[created_at][from/to], filter[entity_id] (≤10), filter[created_by]
 * (≤10) — but NOT filter[value_before]/[value_after] (verified: HTTP 400
 * "Filter can not be empty."). So we pull all status-change events in the
 * window and filter by before/after status_id in memory. For a 2.5-month
 * window this is ~12k events / ~50 paginated requests ≈ 6-8 seconds, vs an
 * unbounded scan that would burn through MAX_CALLS=500 worth of irrelevant
 * deals.
 */
async function fetchLeadIdsFromEventsUrl(parsed: URL): Promise<{
  leadIds: Set<number>;
  mainUserIds: Set<number>;
  hasDateFilter: boolean;
}> {
  const params = mergedParams(parsed);

  // Event type mapping: Kommo UI uses numeric ids (event_type=14 is "status
  // changed"), the API uses string slugs. We support the handful that map
  // cleanly to call-related analysis; everything else falls back to the
  // status-changed flow because that's the one the user actually pastes.
  const UI_TO_API_EVENT_TYPE: Record<string, string> = {
    "14": "lead_status_changed",
    // Other types kept for future use; analysis pipeline only really needs
    // status changes today.
    "4": "outgoing_call",
    "5": "incoming_call",
  };
  const uiEventTypes = params.getAll("filter[event_type][]");
  const apiTypes = new Set<string>();
  for (const t of uiEventTypes) {
    const slug = UI_TO_API_EVENT_TYPE[t];
    if (slug) apiTypes.add(slug);
  }
  // Default to lead_status_changed — that's the only event type whose
  // before/after value carries the (pipeline, status) pair we filter on.
  if (apiTypes.size === 0) apiTypes.add("lead_status_changed");

  // Date window: events URLs use the same filter_date_from/to + filter[date_preset]
  // shapes the leads URL does.
  const dateFrom = params.get("filter_date_from");
  const dateTo = params.get("filter_date_to");
  const datePreset = params.get("filter[date_preset]") ?? params.get("filter_date_preset");
  let fromTs: number | null = null;
  let toTs: number | null = null;
  if (dateFrom && dateTo) {
    fromTs = parseRuDate(dateFrom, false);
    toTs = parseRuDate(dateTo, true);
  } else if (datePreset) {
    const r = resolveKommoDatePreset(datePreset);
    if (r) { fromTs = r.fromTs; toTs = r.toTs; }
  }
  const hasDateFilter = fromTs !== null && toTs !== null;

  // before/after status pairs from filter[value_before|after][status_lead][]=PIPE:STATUS
  // Both halves are optional; if the user only sets one we still narrow.
  const parseStatusPairs = (key: string): Array<{ pipelineId: number; statusId: number }> => {
    const raw = params.getAll(`filter[${key}][status_lead][]`);
    const out: Array<{ pipelineId: number; statusId: number }> = [];
    for (const v of raw) {
      const m = v.match(/^(\d+):(\d+)$/);
      if (!m) continue;
      out.push({ pipelineId: Number(m[1]), statusId: Number(m[2]) });
    }
    return out;
  };
  const beforePairs = parseStatusPairs("value_before");
  const afterPairs = parseStatusPairs("value_after");

  // main_user filter — applied later on the loaded leads, not on events.
  const mainUserIds = new Set<number>(
    params.getAll("filter[main_user][]").map(Number).filter(Number.isFinite),
  );

  // Pull events page by page. /api/v4/events caps at 250/page; we set a hard
  // ceiling of 100 pages (25k events ≈ ~30s wall clock) so a misconfigured
  // multi-month window can't run away. If we hit it, the warning is loud
  // enough that the user notices and tightens the window.
  const MAX_PAGES = 100;
  const events: KommoEventRow[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const qs = new URLSearchParams();
    for (const t of apiTypes) qs.append("filter[type][]", t);
    qs.set("filter[entity]", "lead");
    if (hasDateFilter) {
      qs.set("filter[created_at][from]", String(fromTs));
      qs.set("filter[created_at][to]", String(toTs));
    }
    qs.set("limit", "250");
    qs.set("page", String(page));
    const data = await kommoFetchPath(`/events?${qs.toString()}`) as
      { _embedded?: { events?: KommoEventRow[] } } | null;
    const batch = data?._embedded?.events ?? [];
    if (batch.length === 0) break;
    events.push(...batch);
    if (batch.length < 250) break;
    if (page === MAX_PAGES) {
      console.warn(
        `[Analysis] Events pagination hit ceiling of ${MAX_PAGES} pages (${MAX_PAGES * 250} events). ` +
          "Narrow the date range in the Kommo URL for better results.",
      );
    }
  }

  // Client-side filter by value_before / value_after status pairs.
  const matchesPair = (sv: KommoStatusValue[] | null | undefined, pairs: Array<{ pipelineId: number; statusId: number }>): boolean => {
    if (pairs.length === 0) return true;
    if (!sv || sv.length === 0) return false;
    return sv.some((s) => {
      const ls = s.lead_status;
      if (!ls) return false;
      return pairs.some((p) => p.pipelineId === ls.pipeline_id && p.statusId === ls.id);
    });
  };

  const leadIds = new Set<number>();
  for (const e of events) {
    if (!matchesPair(e.value_before, beforePairs)) continue;
    if (!matchesPair(e.value_after, afterPairs)) continue;
    leadIds.add(e.entity_id);
  }

  console.log(
    `[Analysis] events URL: pulled ${events.length} ${[...apiTypes].join("/")} events → ${leadIds.size} distinct leads ` +
      `(before=${beforePairs.length ? beforePairs.map((p) => `${p.pipelineId}:${p.statusId}`).join(",") : "*"}, ` +
      `after=${afterPairs.length ? afterPairs.map((p) => `${p.pipelineId}:${p.statusId}`).join(",") : "*"})`,
  );

  return { leadIds, mainUserIds, hasDateFilter };
}

/**
 * Bulk-load leads by id. Kommo's /api/v4/leads accepts `filter[id][]=N` repeated
 * and caps at ~40 ids per request before silently truncating; we chunk to 40
 * to stay safe. Uses `with=contacts` so the downstream call-note fetcher can
 * walk contact-level notes (where PBX integrations log calls — see
 * fetchCallNotes for the long-form explanation).
 */
async function fetchLeadsByIds(ids: number[]): Promise<KommoLead[]> {
  if (ids.length === 0) return [];
  const CHUNK = 40;
  const out: KommoLead[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const qs = new URLSearchParams();
    for (const id of slice) qs.append("filter[id][]", String(id));
    qs.set("with", "contacts");
    qs.set("limit", "250");
    const data = await kommoFetchPath(`/leads?${qs.toString()}`) as
      { _embedded?: { leads?: KommoLead[] } } | null;
    if (data?._embedded?.leads?.length) out.push(...data._embedded.leads);
  }
  return out;
}

async function fetchLeadsFromUrl(kommoUrl: string): Promise<KommoLead[]> {
  const parsed = new URL(kommoUrl);
  if (parsed.hostname !== KOMMO.host) throw new Error("Invalid Kommo URL domain");

  // Events-list URL: resolve via /api/v4/events → matched lead IDs → load
  // those leads with `with=contacts`. This is the path the user pastes from
  // Аналитика → "Список событий" in Kommo.
  if (isEventsListUrl(parsed)) {
    const { leadIds, mainUserIds, hasDateFilter } = await fetchLeadIdsFromEventsUrl(parsed);
    if (!hasDateFilter) {
      // Throw with a descriptive message so the user sees the real cause in
      // call_analyses.error_message instead of the generic "не найдено лидов"
      // copy the caller falls back to on empty results.
      throw new Error(
        "Events URL не содержит фильтр по дате. Откройте Kommo → Аналитика → Список событий, " +
          "выберите диапазон дат (или пресет вроде «Текущий месяц») и скопируйте ссылку заново.",
      );
    }
    if (leadIds.size === 0) return [];
    let leads = await fetchLeadsByIds([...leadIds]);
    if (mainUserIds.size > 0) {
      // Kommo events don't carry responsible_user_id; apply that filter once
      // we have the lead bodies. main_user in the Kommo UI = lead responsible.
      const before = leads.length;
      leads = leads.filter((l) => mainUserIds.has(l.responsible_user_id));
      console.log(
        `[Analysis] events URL: main_user filter (${mainUserIds.size} users) narrowed ${before} → ${leads.length} leads`,
      );
    }
    return leads;
  }

  const { apiQuery, cfEnumFilter, cfAllowEmpty, hasDateFilter } = buildLeadsApiQuery(kommoUrl);
  const hasCfFilter = cfEnumFilter.size > 0 || cfAllowEmpty.size > 0;

  // Embed contacts so we can pull contact-level call notes downstream.
  // Kommo PBX/VoIP integrations attach call notes to the CONTACT entity
  // (matched by the dialed phone number's last 10 digits, per Kommo docs),
  // not to the lead — so reading only `/leads/{id}/notes` misses 100% of
  // dialer-originated calls. Including contacts in the leads response (`with=contacts`)
  // is one request per page rather than one per lead.
  //
  // Pagination cap: 20 pages × 250 = 5000 leads ceiling when a date filter
  // narrows the dataset. When NO date filter is in play (rare; only legit
  // case is a pipeline+status pull with intentional full history), drop the
  // cap to 5 pages (1250 leads). Hitting it without a date filter is almost
  // always a misread URL — the previous behaviour silently scanned 5k leads
  // and burned the Grok budget. Loud cap + warning makes that visible.
  const maxPages = hasDateFilter ? 20 : 5;
  if (!hasDateFilter) {
    console.warn(
      "[Analysis] No date filter resolved from URL — capping paginated lead pull to " +
        `${maxPages} pages (${maxPages * 250} leads). Add filter[date_preset]=... or ` +
        "filter_date_from/to to the Kommo URL to widen the cap.",
    );
  }
  const apiLeads: KommoLead[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const apiUrl = `/leads?${apiQuery}&with=contacts&limit=250&page=${page}`;
    const data = await kommoFetchPath(apiUrl) as { _embedded?: { leads?: KommoLead[] } } | null;
    if (!data?._embedded?.leads?.length) break;
    apiLeads.push(...data._embedded.leads);
  }

  if (!hasCfFilter) return apiLeads;

  const filtered = apiLeads.filter((l) => passesCfFilter(l, cfEnumFilter, cfAllowEmpty));
  console.log(
    `[Analysis] CF filter: ${apiLeads.length} leads from API → ${filtered.length} after custom-field filter ` +
      `(fields: ${[...cfEnumFilter.keys()].join(",")}${cfAllowEmpty.size ? `; allow_empty: ${[...cfAllowEmpty].join(",")}` : ""})`,
  );
  return filtered;
}

async function fetchCallNotesForEntity(
  entity: "leads" | "contacts",
  entityId: number,
): Promise<KommoNote[]> {
  const all: KommoNote[] = [];
  for (let page = 1; page <= 10; page++) {
    const data = await kommoFetchPath(
      `/${entity}/${entityId}/notes?limit=250&page=${page}` +
        `&filter[note_type][]=call_in&filter[note_type][]=call_out`,
    ) as { _embedded?: { notes?: KommoNote[] } } | null;
    const batch = data?._embedded?.notes ?? [];
    if (batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 250) break;
  }
  return all;
}

/**
 * Collect call notes for a lead by gathering notes attached to the lead AND
 * to each of its embedded contacts. Per Kommo docs, PBX/VoIP integrations
 * route inbound/outbound calls to the contact entity (matched on the last 10
 * digits of the phone number) — leads typically have zero call notes of
 * their own when calls come through a dialer, while their contacts hold the
 * full call history. Reading only the lead would silently miss 100% of
 * dialer-originated calls (verified: 113 leads in this sample had 0 lead-
 * notes vs 2036 contact-notes total).
 *
 * Notes are tagged with their source (`__source`) so downstream code can
 * surface where the recording came from. Duplicate notes across multiple
 * contacts of the same lead are deduped by note.id — Kommo PBX integrations
 * sometimes attach the same call to several entities when a contact-lead
 * link triggers multiple "add to entity card" rules.
 */
async function fetchCallNotes(lead: KommoLead): Promise<KommoNote[]> {
  const all: KommoNote[] = [];
  const seen = new Set<number>();

  const push = (notes: KommoNote[]) => {
    for (const n of notes) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      all.push(n);
    }
  };

  push(await fetchCallNotesForEntity("leads", lead.id));
  const contacts = lead._embedded?.contacts ?? [];
  for (const c of contacts) {
    push(await fetchCallNotesForEntity("contacts", c.id));
  }
  return all;
}

// ==================== TRANSCRIPTION ====================

async function transcribeAudio(audioUrl: string): Promise<{ text: string; speakers: string } | null> {
  // Three outcomes for tryTranscribe:
  //   - non-null result with non-empty text → success, return immediately
  //   - non-null result with empty text     → Scribe responded but audio
  //                                           is silent / unintelligible.
  //                                           Don't trigger fallback (the
  //                                           network worked), don't fire
  //                                           a fatal — the per-attempt
  //                                           warning was already sent by
  //                                           tryTranscribe. Return as-is.
  //   - null                                → genuine failure (network /
  //                                           HTTP / body-read). Try S3
  //                                           fallback if applicable.
  let result = await tryTranscribe(audioUrl);
  if (result) return result;

  let s3Url: string | undefined;
  if (audioUrl.includes("cloudtalk.io/r/play/")) {
    const id = audioUrl.split("/").pop();
    s3Url = `https://s3-nl.hostkey.com/be7f6465-cloudtalknl/cloudtalk-recordings/${id}.mp3`;
    result = await tryTranscribe(s3Url);
    if (result) return result;
  }

  // Both primary and (when applicable) S3 fallback failed at the network /
  // HTTP layer. One error-level event per missed call so the Sentry
  // dashboard surfaces dropped-transcription count cleanly — per-attempt
  // warnings with HTTP/network diagnostics were already sent by tryTranscribe.
  captureAnalysisMessage("Transcription failed for both primary and fallback URL", "error", {
    step: "transcription",
    severity: "fatal",
    extra: {
      primaryUrl: audioUrl,
      s3FallbackUrl: s3Url ?? "(not applicable — non-CloudTalk URL)",
    },
  });
  return null;
}

interface ScribeWord {
  text: string;
  start?: number;
  end?: number;
  type: "word" | "spacing" | "audio_event";
  speaker_id?: string | null;
}
interface ScribeResponse {
  text: string;
  words?: ScribeWord[];
  language_code?: string;
  audio_duration_secs?: number;
  detail?: unknown; // error envelope
}

/**
 * Convert Scribe's word-level output (`words[]` with per-word `speaker_id`)
 * into the speaker-block format the rest of the pipeline expects:
 *
 *   **Speaker A:** ...text...
 *
 *   **Speaker B:** ...text...
 *
 * Scribe returns one entry per word + spacing token, with `speaker_id` like
 * "speaker_0"/"speaker_1". We group consecutive same-speaker tokens, swallow
 * `audio_event` tokens (we set `tag_audio_events: false` so there shouldn't
 * be any, but defensive), and remap speaker_0→A, speaker_1→B, etc. — the
 * downstream code (manager/client mapping in callers, OKK speaker labelling
 * in CLAUDE.md:219) reads the resulting blocks unchanged.
 */
function formatSpeakerBlocks(words: ScribeWord[] | undefined): string {
  if (!words || words.length === 0) return "";
  const blocks: { speaker: string; text: string }[] = [];
  let current: { speaker: string; text: string } | null = null;
  for (const w of words) {
    if (w.type === "audio_event") continue;
    const speaker: string = w.speaker_id ?? current?.speaker ?? "speaker_0";
    if (!current || current.speaker !== speaker) {
      if (current) blocks.push(current);
      current = { speaker, text: "" };
    }
    current.text += w.text;
  }
  if (current) blocks.push(current);

  const speakerMap = new Map<string, string>();
  let nextLetter = 0;
  return blocks
    .map((b) => {
      let label = speakerMap.get(b.speaker);
      if (!label) {
        label = String.fromCharCode(65 + nextLetter++);
        speakerMap.set(b.speaker, label);
      }
      return `**Speaker ${label}:** ${b.text.trim()}`;
    })
    .filter((s) => s.length > "**Speaker A:** ".length)
    .join("\n\n");
}

async function tryTranscribe(url: string): Promise<{ text: string; speakers: string } | null> {
  // ElevenLabs Scribe v2 — synchronous batch transcription.
  //   - `cloud_storage_url` instead of file upload (CloudTalk S3 mp3s are
  //     publicly fetchable; ElevenLabs pulls the audio server-side).
  //   - `language_code: "rus"` — ISO-639-3 (NOT "ru"; that's ISO-639-1 and
  //     Scribe treats unknown codes as auto-detect, which on Russian-with-
  //     German-loanwords audio sometimes mislabels as German).
  //   - `no_verbatim: true` — drops "ээ"/"мм" filler. Cleaner transcript →
  //     Grok analyses the actual content of what was said, not noise.
  //   - `tag_audio_events: false` — no `[laughter]`/`[cough]` tokens in
  //     business-call transcripts.
  //   - `diarize: true` — multi-speaker labels per word.
  // Single fetch with a 15-min wall-clock fence so a stuck job releases its
  // concurrency slot rather than wedging the worker.
  const form = new FormData();
  form.append("model_id", "scribe_v2");
  form.append("cloud_storage_url", url);
  form.append("language_code", "rus");
  form.append("diarize", "true");
  form.append("no_verbatim", "true");
  form.append("tag_audio_events", "false");
  form.append("timestamps_granularity", "word");

  let res: Response;
  try {
    res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": ELEVENLABS_KEY },
      body: form,
      signal: AbortSignal.timeout(SCRIBE_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[tryTranscribe] Scribe ${isTimeout ? "timeout" : "network error"}: ${msg.slice(0, 200)}`);
    captureAnalysisException(err, {
      step: "transcription",
      severity: "non_fatal",
      extra: { url, kind: isTimeout ? "timeout" : "network_error", timeoutMs: SCRIBE_TIMEOUT_MS },
    });
    return null;
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.warn(`[tryTranscribe] Scribe ${res.status}: ${errText.slice(0, 300)}`);
    // 5xx is ElevenLabs-side; 4xx is usually our fault (bad URL, quota, auth).
    // Both useful but split severity so the dashboard can route 5xx to ops
    // and 4xx to engineering without an alert storm cross-pollinating them.
    captureAnalysisMessage(`Scribe HTTP ${res.status}`, res.status >= 500 ? "error" : "warning", {
      step: "transcription",
      severity: "non_fatal",
      extra: { url, status: res.status, body: errText.slice(0, 1000) },
    });
    return null;
  }

  let data: ScribeResponse;
  try {
    data = await res.json() as ScribeResponse;
  } catch (err: unknown) {
    // Body-read abort race — same risk as the Grok call: AbortSignal stays
    // armed after fetch resolves, body chunks can be aborted mid-drain on
    // long transcriptions. Treat as null result, the URL fallback in the
    // caller (`transcribeAudio`) will attempt the S3 direct URL if applicable.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[tryTranscribe] Scribe body read failed: ${msg.slice(0, 200)}`);
    captureAnalysisException(err, {
      step: "transcription",
      severity: "non_fatal",
      extra: { url, kind: "body_read_aborted" },
    });
    return null;
  }

  const text = data.text || "";
  if (!text) {
    // Empty transcript on a 200 response — Scribe accepted but produced
    // nothing (silent audio, unintelligible, or 0-byte file). Fire a
    // warning so a pattern (e.g. a CDN bucket misconfig) becomes visible,
    // but RETURN the empty result rather than null — the caller treats
    // null as a network/HTTP failure and would (a) try the S3 fallback
    // unnecessarily, doubling the bill, and (b) raise a misleading
    // "both URLs failed" fatal event when the network was actually fine.
    captureAnalysisMessage("Scribe returned empty transcript", "warning", {
      step: "transcription",
      severity: "non_fatal",
      extra: {
        url,
        audioDurationSecs: data.audio_duration_secs,
        languageCode: data.language_code,
      },
    });
    return { text: "", speakers: "" };
  }
  const speakers = formatSpeakerBlocks(data.words) || text;
  return { text, speakers };
}

// ==================== GROK ANALYSIS ====================

// xAI quota-exhausted responses don't set Retry-After (the 429 isn't transient
// rate-limit; it's a billing condition). Detect them and fail fast — burning
// 4 attempts against a known-out account just delays the operator-visible
// error by ~10 seconds and adds noise to logs.
const QUOTA_EXHAUSTED_RE = /spending limit|out of credit|insufficient[_ ]?(?:credit|funds|quota)|exhausted/i;

async function callGrok(
  systemPrompt: string,
  userContent: string,
  model: string,
  maxTokens: number,
  maxInputChars: number = PER_CALL_MAX_INPUT_CHARS,
): Promise<string> {
  // Two-level timeout strategy:
  //   • Per-fetch (GROK_TIMEOUT_MS = 120s): bounds a single attempt against
  //     a stuck connection.
  //   • Total (GROK_TOTAL_TIMEOUT_MS = 180s): bounds the whole retry chain.
  //     Without this, 4 consecutive timeouts would block a worker for ~487s
  //     (4 × 120s + backoff), and 3 such cascading workers could freeze the
  //     pipeline for ~8 min during a partial xAI outage.
  //
  // 429 / 5xx with exponential backoff. xAI returns Retry-After on real
  // rate limits; respect it. Quota-exhaustion (no Retry-After + body matches
  // QUOTA_EXHAUSTED_RE) bails immediately so partially-done runs save their
  // state via the caller's try/catch and the user can resume after topping
  // up the account.
  const body = JSON.stringify({
    model,
    max_tokens: maxTokens,
    temperature: 0.1,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent.substring(0, maxInputChars) },
    ],
  });

  const overallDeadline = Date.now() + GROK_TOTAL_TIMEOUT_MS;
  let waitMs = 1000;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (Date.now() >= overallDeadline) {
      throw new Error(`Grok API: total budget ${GROK_TOTAL_TIMEOUT_MS}ms exceeded after ${attempt} attempt(s)`);
    }
    // Squeeze the per-attempt timeout into whatever's left of the overall
    // budget so the last attempt can't blow past the cap.
    const perAttemptMs = Math.min(GROK_TIMEOUT_MS, overallDeadline - Date.now());

    let res: Response;
    try {
      res = await fetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${XAI_API_KEY}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(perAttemptMs),
      });
    } catch (err: unknown) {
      // Treat timeout / abort like a transient network error: retry within
      // the same retry budget instead of aborting the whole run on one
      // stuck connection. Other unexpected errors (TLS, DNS) get the same
      // treatment for the same reason.
      const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      const errMsg = err instanceof Error ? err.message : String(err);
      if (attempt === 3 || Date.now() >= overallDeadline) {
        throw new Error(`Grok API ${isTimeout ? `timeout after ${perAttemptMs}ms` : "network error"}: ${errMsg.slice(0, 200)}`);
      }
      console.warn(`[callGrok] ${isTimeout ? "timeout" : "network error"} (attempt ${attempt + 1}/4): ${errMsg.slice(0, 100)}`);
      await sleep(waitMs);
      waitMs *= 2;
      continue;
    }
    if (res.ok) {
      // res.json() is awaited here, but AbortSignal.timeout keeps observing
      // the signal even after fetch() resolves — if the timer fires while
      // body chunks are still draining (Grok generates near the 120s
      // deadline, body arrives a few hundred ms later), undici aborts the
      // body read and throws AbortError. That throw must be caught here so
      // it's classified as transient and retried, not bubbled up to the
      // outer pipeline catch which would fail the whole run.
      try {
        const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
        return data.choices?.[0]?.message?.content || "";
      } catch (err: unknown) {
        const isAbort = err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
        if (attempt === 3 || Date.now() >= overallDeadline) {
          throw new Error(`Grok body read ${isAbort ? "aborted" : "failed"}: ${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}`);
        }
        console.warn(`[callGrok] body read ${isAbort ? "aborted" : "failed"} (attempt ${attempt + 1}/4) — retrying`);
        await sleep(waitMs);
        waitMs *= 2;
        continue;
      }
    }
    const errText = await res.text().catch(() => "");
    const retryAfter = Number(res.headers.get("retry-after") ?? "0");
    const isQuotaExhausted = res.status === 429 && retryAfter === 0 && QUOTA_EXHAUSTED_RE.test(errText);
    const retriable = (res.status === 429 || res.status >= 500) && !isQuotaExhausted;
    if (!retriable || attempt === 3) {
      const tag = isQuotaExhausted ? " (quota exhausted — top up xAI account or rotate XAI_API_KEY)" : "";
      throw new Error(`Grok API ${res.status}${tag}: ${errText.substring(0, 200)}`);
    }
    const backoff = retryAfter > 0 ? retryAfter * 1000 : waitMs;
    console.warn(`[callGrok] ${res.status} (attempt ${attempt + 1}/4), retrying in ${backoff}ms`);
    await sleep(backoff);
    waitMs *= 2;
  }
  throw new Error("Grok API: exhausted retries");
}

// ==================== MAIN PIPELINE ====================

export async function runAnalysisPipeline(analysisId: string): Promise<void> {
  const db = getMainDb("b2g"); // analyses stored in D1 (main DB)

  const [analysis] = await db
    .select()
    .from(callAnalyses)
    .where(eq(callAnalyses.id, analysisId));

  if (!analysis) throw new Error("Analysis not found");

  // Guard: only process pending or processing (resume after timeout)
  if (analysis.status !== "pending" && analysis.status !== "processing") {
    console.warn(`[Analysis ${analysisId}] Status ${analysis.status}, skipping`);
    return;
  }

  // Validate API keys — save error to DB if missing.
  // KOMMO_ACCESS_TOKEN is no longer required as an env var: kommoFetchPath()
  // falls back to the kommo_tokens DB table when the env is empty (same path
  // the rest of the dashboard uses). Missing-token errors will surface from
  // ensureKommoConfig() at the first Kommo API call instead, with a clearer
  // message than "env var not set".
  const missingKeys = [];
  if (!ELEVENLABS_KEY) missingKeys.push("ELEVENLABS_API_KEY");
  if (!XAI_API_KEY) missingKeys.push("XAI_API_KEY");
  if (missingKeys.length > 0) {
    const msg = `Не настроены переменные окружения: ${missingKeys.join(", ")}. Добавьте в Dokploy Environment.`;
    await db.update(callAnalyses).set({ status: "error", errorMessage: msg }).where(eq(callAnalyses.id, analysisId));
    console.error(`[Analysis ${analysisId}] ${msg}`);
    return;
  }

  const mode = analysis.mode as "success" | "failure";
  const perCallPrompt = mode === "success" ? SUCCESS_PER_CALL_PROMPT : FAILURE_PER_CALL_PROMPT;
  const summaryPrompt = mode === "success" ? SUCCESS_SUMMARY_PROMPT : FAILURE_SUMMARY_PROMPT;

  try {
    await db.update(callAnalyses).set({ status: "processing", updatedAt: sql`now()` }).where(eq(callAnalyses.id, analysisId));

    // Parse minDuration from URL hash
    const hashMatch = analysis.kommoUrl.match(/#minDur=(\d+)/);
    const minDuration = hashMatch ? Number(hashMatch[1]) * 60 : DEFAULT_MIN_DURATION;
    const cleanUrl = analysis.kommoUrl.replace(/#minDur=\d+/, "");

    // 1. Fetch leads from Kommo
    await db.update(callAnalyses).set({ errorMessage: "Загрузка лидов из Kommo..." }).where(eq(callAnalyses.id, analysisId));
    console.log(`[Analysis ${analysisId}] Fetching leads (minDur=${minDuration/60}min)...`);
    const leads = await fetchLeadsFromUrl(cleanUrl);
    console.log(`[Analysis ${analysisId}] Found ${leads.length} leads`);

    if (leads.length === 0) {
      await db.update(callAnalyses).set({
        status: "error",
        errorMessage: "Не найдено лидов по указанной ссылке. Проверьте фильтр в Kommo.",
      }).where(eq(callAnalyses.id, analysisId));
      return;
    }

    // 2. Fetch call notes for each lead in parallel (bounded), dedup across
    //    leads (same recording can appear on several leads in Kommo), filter
    //    by duration. Progress is updated every 25 leads so the UI shows
    //    movement even when the filter returns thousands of deals.
    //
    //    Note on date semantics: the URL's filter_date_from/to is applied at
    //    the LEAD level via Kommo API (when filter_date_switch is present) to
    //    narrow which deals enter the pipeline. The call notes themselves are
    //    NOT additionally filtered by date — the user's mental model is
    //    "filter narrows deals; then pick all qualifying calls (by duration)
    //    in those deals regardless of when the calls were made." If you ever
    //    want to add a call-date filter, do it as a separate UI option, not
    //    silently coupled to the URL date range.
    await db.update(callAnalyses).set({ errorMessage: `Поиск звонков в ${leads.length} сделках...` }).where(eq(callAnalyses.id, analysisId));

    interface CallRecord { leadId: number; leadName: string; duration: number; url: string; date: Date; direction: string }
    let scanned = 0;
    let multiCallLeads = 0;
    const perLeadResults = await mapConcurrent(leads, KOMMO_CONCURRENCY, async (lead) => {
      const notes = await fetchCallNotes(lead).catch((e: unknown) => {
        console.warn(`[Analysis ${analysisId}] fetchCallNotes(${lead.id}) failed:`, e);
        return [] as KommoNote[];
      });
      const matched: CallRecord[] = [];
      // Lower bound on call date: a call attributed to a lead must have
      // happened DURING that lead's lifetime, not before. Contact-level
      // notes (which is where PBX integrations log calls — see
      // fetchCallNotes) include the contact's entire call history across
      // ALL of the contact's deals. Without this guard a new lead inherits
      // every old call the contact ever had, polluting the analysis.
      const leadCreatedAt = lead.created_at || 0;
      // Upper bound: closed deals — only count calls up to the close date
      // (`closed_at` is 0 for open deals; ignore in that case).
      const leadClosedAt = lead.closed_at && lead.closed_at > 0 ? lead.closed_at : Number.POSITIVE_INFINITY;
      for (const n of notes) {
        const dur = n.params?.duration || 0;
        const link = n.params?.link;
        if (dur < minDuration || !link) continue;
        if (link.includes("localhost")) continue;
        if (n.created_at < leadCreatedAt) continue;
        if (n.created_at > leadClosedAt) continue;
        matched.push({
          leadId: lead.id,
          leadName: (lead.name || "").substring(0, 60),
          duration: dur,
          url: link,
          date: new Date(n.created_at * 1000),
          direction: n.note_type === "call_in" ? "входящий" : "исходящий",
        });
      }
      if (matched.length > 1) multiCallLeads++;
      scanned++;
      if (scanned % 25 === 0 || scanned === leads.length) {
        await db
          .update(callAnalyses)
          .set({ errorMessage: `Поиск звонков: ${scanned}/${leads.length} сделок...` })
          .where(eq(callAnalyses.id, analysisId))
          .catch(() => void 0);
      }
      return matched;
    });
    if (multiCallLeads > 0) {
      console.log(
        `[Analysis ${analysisId}] ${multiCallLeads} lead(s) had >1 qualifying call — all will be transcribed`,
      );
    }

    // Global dedup by URL — same recording in several leads → count once.
    const seenUrls = new Set<string>();
    const calls: CallRecord[] = [];
    for (const bucket of perLeadResults) {
      for (const c of bucket) {
        if (seenUrls.has(c.url)) continue;
        seenUrls.add(c.url);
        calls.push(c);
      }
    }

    // Cap at MAX_CALLS (most recent first) and log how many were trimmed
    // so the user knows the filter needs tightening if it hit the ceiling.
    calls.sort((a, b) => b.date.getTime() - a.date.getTime());
    const cappedCalls = calls.slice(0, MAX_CALLS);
    if (calls.length > MAX_CALLS) {
      console.warn(
        `[Analysis ${analysisId}] filter produced ${calls.length} calls, trimmed to ${MAX_CALLS} most recent`,
      );
    }

    if (cappedCalls.length === 0) {
      await db.update(callAnalyses).set({
        status: "error",
        errorMessage: `Не найдено звонков ≥${minDuration/60} мин среди ${leads.length} сделок.`,
      }).where(eq(callAnalyses.id, analysisId));
      return;
    }

    await db.update(callAnalyses).set({ totalCalls: cappedCalls.length, errorMessage: null }).where(eq(callAnalyses.id, analysisId));
    console.log(`[Analysis ${analysisId}] ${cappedCalls.length} calls to process`);

    // 3. Transcribe + analyze each call
    // Resume support: check which files already exist
    const existingFiles = await db
      .select({ filename: callAnalysisFiles.filename, content: callAnalysisFiles.content })
      .from(callAnalysisFiles)
      .where(eq(callAnalysisFiles.analysisId, analysisId));
    const existingSet = new Set(existingFiles.map(f => f.filename));

    // Index-keyed slot array — preserves call order in the final summary
    // regardless of which concurrent worker finished first. Pre-populate from
    // already-saved files (resume) and from any newly-processed call below.
    const allAnalysesByIdx: (string | null)[] = new Array(cappedCalls.length).fill(null);

    // Recover analyses from already-processed files. The filename is
    // `call_NN_leadXXXX.md` where NN matches the index+1 in cappedCalls.
    // Using a regex on filename is more robust than trying to match by leadId
    // (a single lead can have multiple matching calls; lead-id is not unique).
    const fileByName = new Map(existingFiles.map((f) => [f.filename, f.content]));
    for (let i = 0; i < cappedCalls.length; i++) {
      const num = String(i + 1).padStart(2, "0");
      const fname = `call_${num}_lead${cappedCalls[i].leadId}.md`;
      const content = fileByName.get(fname);
      if (!content) continue;
      const match = content.match(/## Анализ\n\n([\s\S]+)$/);
      if (match) {
        const dateStr = cappedCalls[i].date.toLocaleDateString("ru-RU");
        const durMin = Math.round(cappedCalls[i].duration / 60);
        allAnalysesByIdx[i] = `### Звонок ${num} (Lead ${cappedCalls[i].leadId}, ${dateStr}, ${durMin} мин)\n\n${match[1].trim()}`;
      }
    }

    // Concurrency is the difference between a ~30-min run and a 3-hour run.
    // Scribe is synchronous, but a single 60-min call still takes 3-5min on
    // their side; running N in parallel reclaims most of that wait, so a
    // small worker pool gives a big speed-up. Use the narrower of
    // TRANSCRIBE / GROK limits.
    let processed = analysis.processedCalls || 0;
    const perCallLimit = Math.min(TRANSCRIBE_CONCURRENCY, GROK_CONCURRENCY);

    // Per-call failure isolation. Historically a single xAI timeout (one stuck
    // generation past GROK_TOTAL_TIMEOUT_MS=180s) bubbled out of the worker
    // through Promise.all and aborted the entire run — losing 60+ already-
    // transcribed calls' worth of work. Wrap callGrok/transcribe in per-call
    // try/catch so one bad call records itself as ⚠️ and the rest finish.
    // Track failure counts to detect a partial xAI outage and surface it in
    // the final status without poisoning the run.
    let transcribeFailures = 0;
    let grokFailures = 0;

    await mapConcurrent(cappedCalls, perCallLimit, async (call, idx) => {
      const num = String(idx + 1).padStart(2, "0");
      const dateStr = call.date.toLocaleDateString("ru-RU");
      const durMin = Math.round(call.duration / 60);
      const filename = `call_${num}_lead${call.leadId}.md`;

      if (existingSet.has(filename)) {
        console.log(`[Analysis ${analysisId}] [${num}] Skip (already done)`);
        return;
      }

      let md = `# Звонок ${num} — Lead ${call.leadId}\n\n`;
      md += `- **Дата:** ${dateStr}\n`;
      md += `- **Длительность:** ${durMin} мин\n`;
      md += `- **Направление:** ${call.direction}\n`;
      md += `- **Lead:** ${call.leadName}\n\n`;

      // Transcription: failures are already non-throwing (returns null), but
      // wrap defensively so an unexpected error (e.g. fetch DNS hiccup that
      // slips past AbortSignal) doesn't propagate out of the worker.
      let transcript: { text: string; speakers: string } | null = null;
      try {
        console.log(`[Analysis ${analysisId}] [${num}/${cappedCalls.length}] Transcribing lead ${call.leadId}...`);
        transcript = await transcribeAudio(call.url);
      } catch (err) {
        transcribeFailures++;
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(`[Analysis ${analysisId}] [${num}] transcribe threw: ${errMsg.slice(0, 200)}`);
        captureAnalysisException(err, {
          step: "transcription",
          severity: "non_fatal",
          extra: { analysisId, callIdx: idx, leadId: call.leadId, url: call.url.slice(0, 200) },
        });
      }

      if (!transcript) {
        // Network/HTTP failure for both primary and fallback URL.
        md += `## Транскрипт\n\n⚠️ Не удалось транскрибировать запись.\n`;
      } else if (!transcript.text) {
        // Scribe responded but the audio is silent or unintelligible. Skip
        // Grok analysis on empty content — saves the API call and avoids a
        // misleading "patterns of failure" entry in the summary.
        md += `## Транскрипт\n\n⚠️ Запись транскрибирована, но текст пустой (тишина / неразборчивый звук).\n`;
      } else {
        md += `## Транскрипт\n\n${transcript.speakers}\n\n`;
        console.log(`[Analysis ${analysisId}] [${num}] Analyzing with Grok...`);
        try {
          const analysisText = await callGrok(perCallPrompt, md, PER_CALL_MODEL, PER_CALL_MAX_TOKENS);
          md += `## Анализ\n\n${analysisText}\n`;
          allAnalysesByIdx[idx] = `### Звонок ${num} (Lead ${call.leadId}, ${dateStr}, ${durMin} мин)\n\n${analysisText}`;
        } catch (err) {
          grokFailures++;
          const errMsg = err instanceof Error ? err.message : String(err);
          console.warn(`[Analysis ${analysisId}] [${num}] Grok per-call failed: ${errMsg.slice(0, 200)}`);
          captureAnalysisException(err, {
            step: "grok-per-call",
            severity: "non_fatal",
            extra: { analysisId, callIdx: idx, leadId: call.leadId, duration: call.duration },
          });
          // Persist the failure inline so the user can see WHICH call broke
          // and the rest of the pipeline (file save + progress update + final
          // summary) keeps moving.
          md += `## Анализ\n\n⚠️ Grok API недоступен для этого звонка: ${errMsg.slice(0, 200)}\n`;
        }
      }

      // DB ops MUST NOT throw out of the worker — that would kill the whole
      // run via Promise.all aggregation, exactly the failure mode the per-
      // call try/catch above is trying to prevent. Neon HTTP occasionally
      // returns transient 5xx on compute cold-start (~2s); swallow + log so
      // one bad write loses one call's record, not the entire batch.
      try {
        await db
          .insert(callAnalysisFiles)
          .values({
            analysisId,
            filename,
            content: md,
            fileType: "transcript",
            leadId: String(call.leadId),
          })
          .onConflictDoUpdate({
            target: [callAnalysisFiles.analysisId, callAnalysisFiles.filename],
            set: { content: md },
          });
      } catch (err) {
        console.warn(
          `[Analysis ${analysisId}] [${num}] DB insert failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}`,
        );
        captureAnalysisException(err, {
          step: "grok-per-call", // closest existing step tag; file persistence
          severity: "non_fatal",
          extra: { analysisId, callIdx: idx, leadId: call.leadId, kind: "db_insert" },
        });
      }

      processed++;
      const progress = Math.round((processed / cappedCalls.length) * 90);
      await db
        .update(callAnalyses)
        .set({ processedCalls: processed, progress, updatedAt: sql`now()` })
        .where(eq(callAnalyses.id, analysisId))
        .catch((err: unknown) => {
          // Progress-update failures are cosmetic — the next worker's update
          // will overwrite or correct. Never let one bad PATCH abort the run.
          console.warn(
            `[Analysis ${analysisId}] [${num}] progress update failed: ${err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120)}`,
          );
        });
    });

    // 4. Generate aggregate summary. Only if we have at least one successful
    // per-call analysis — otherwise we'd burn another Grok call on an empty
    // input and get back generic noise.
    console.log(`[Analysis ${analysisId}] Generating summary...`);
    const allAnalyses = allAnalysesByIdx.filter((s): s is string => s !== null);
    let summary = "";
    let summaryError: string | null = null;
    if (allAnalyses.length === 0) {
      summary = `⚠️ Ни один звонок не удалось проанализировать (Grok timeouts: ${grokFailures}, transcribe failures: ${transcribeFailures}). Запустите Resume позже, когда xAI восстановится, либо проверьте Sentry на детали.`;
    } else {
      const allAnalysesText = allAnalyses.join("\n\n---\n\n");
      try {
        summary = await callGrok(
          summaryPrompt,
          `Всего проанализировано ${allAnalyses.length} звонков из ${cappedCalls.length}.\n\n${allAnalysesText}`,
          SUMMARY_MODEL,
          SUMMARY_MAX_TOKENS,
          SUMMARY_MAX_INPUT_CHARS,
        );
      } catch (err) {
        // Summary Grok call failed too — keep the run as 'done' with all
        // per-call files saved and a placeholder summary, so the user doesn't
        // lose hours of transcription work to a single end-of-run timeout.
        summaryError = err instanceof Error ? err.message : String(err);
        console.warn(`[Analysis ${analysisId}] summary Grok failed: ${summaryError.slice(0, 200)}`);
        captureAnalysisException(err, {
          step: "grok-summary",
          severity: "non_fatal",
          extra: { analysisId, perCallCount: allAnalyses.length },
        });
        summary = `⚠️ Сводный анализ Grok не удался: ${summaryError.slice(0, 200)}. Per-call analyses (${allAnalyses.length}) сохранены в файлах ниже.`;
      }
    }

    // Save summary file. Use onConflictDoUpdate against the same
    // (analysis_id, filename) unique index the per-call files use — without
    // this, a Resume run hitting an already-existing SUMMARY.md would crash
    // with a duplicate-key violation and lose the whole batch's progress.
    await db
      .insert(callAnalysisFiles)
      .values({
        analysisId,
        filename: "SUMMARY.md",
        content: `# Сводный анализ\n\n${summary}`,
        fileType: "summary",
      })
      .onConflictDoUpdate({
        target: [callAnalysisFiles.analysisId, callAnalysisFiles.filename],
        set: { content: `# Сводный анализ\n\n${summary}` },
      });

    // Final status. Even if some Grok calls failed, mark the run as 'done'
    // so the user can read what we have. Surface degraded state via
    // error_message (kept alongside status='done' for the UI to render as a
    // warning chip) so the operator knows to inspect failures.
    const degraded = grokFailures > 0 || transcribeFailures > 0 || summaryError;
    const degradedMsg = degraded
      ? `Завершено с предупреждениями: Grok timeouts ${grokFailures}, transcribe ошибок ${transcribeFailures}` +
        (summaryError ? `, summary failed (${summaryError.slice(0, 60)})` : "")
      : null;
    await db.update(callAnalyses).set({
      status: "done",
      progress: 100,
      resultSummary: summary,
      errorMessage: degradedMsg,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    }).where(eq(callAnalyses.id, analysisId));

    console.log(
      `[Analysis ${analysisId}] ✅ Complete! ${allAnalyses.length}/${cappedCalls.length} calls analyzed ` +
        `(grok fails: ${grokFailures}, transcribe fails: ${transcribeFailures}).`,
    );

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Analysis ${analysisId}] ERROR:`, msg);
    await db.update(callAnalyses).set({ status: "error", errorMessage: msg }).where(eq(callAnalyses.id, analysisId));
  }
}
