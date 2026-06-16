/**
 * Call Transcription Pipeline
 *
 * Flow: parse Kommo URL → fetch leads → fetch calls → transcribe → save files
 *
 * Call sourcing priority:
 *   1. Kommo lead notes (call_in/call_out) — ~80%
 *   2. OKK DB (D2/R2) by kommo_lead_id — fallback
 *   3. Dedup by recording URL/ID
 *
 * The Grok-based per-call analysis + aggregate summary were removed
 * (2026-06-14) — this tab is now used purely for transcription. Legacy DB
 * columns `mode` / `result_summary` are kept for old rows but no longer
 * written with analysis content.
 */

import { and, eq, sql } from "drizzle-orm";
import { getDbForDepartment as getMainDb } from "@/lib/db";
import { callAnalyses, callAnalysisFiles, masterManagers } from "@/lib/db/schema-existing";
import { KOMMO } from "@/lib/config/tenant";
import { kommoFetchPath } from "@/lib/kommo/client";
import { parseDateBoundary } from "@/lib/utils/date";
import { captureAnalysisException, captureAnalysisMessage } from "./sentry";

const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY || "";
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
// Hard ceiling to avoid runaway ElevenLabs cost. Raised 500 → 1000 (2026-06-14)
// for larger filters; the run is chunked + checkpointed (SOFT_DEADLINE_MS), so
// it spans multiple cron ticks rather than one request — wall-clock grows
// (~6-8h at 1000) but stability doesn't. Main constraint is the transcription
// bill, not runtime.
const MAX_CALLS = 1000;
// Concurrency limits per external service. Kommo is the strictest
// (7 req/s per docs, we stay well under). Scribe tolerates 10+ parallel.
const KOMMO_CONCURRENCY = 5;
const TRANSCRIBE_CONCURRENCY = 4;

// ==================== CHUNKED EXECUTION / CHECKPOINTS ====================
// Large runs (hundreds of leads at the GLOBAL 1 req/sec Kommo budget shared
// with the ETL cron — see src/lib/kommo/client.ts) cannot finish inside one
// request lifetime. Platform timeouts are no help: `maxDuration` is a Vercel
// hint that Dokploy's standalone node server ignores, so the old failure mode
// was an unbounded run that died only with the process (deploy/crash) and
// then restarted discovery from zero — forever. Instead the pipeline
// time-boxes itself: work ~SOFT_DEADLINE, checkpoint into `_manifest.json`,
// yield; the next /process (or cron tick) claim resumes from the checkpoint.
const SOFT_DEADLINE_MS =
  Number(process.env.ANALYSIS_SOFT_DEADLINE_MS) > 0
    ? Number(process.env.ANALYSIS_SOFT_DEADLINE_MS)
    : 20 * 60_000;
// Hard ceiling for the in-pipeline heartbeat: soft deadline + the worst-case
// in-flight unit (15-min Scribe + drain margin). Past it the
// heartbeat STOPS REFRESHING itself, so even a pipeline frozen in a way the
// per-request timeouts didn't catch goes stale and becomes reclaimable.
const HARD_DEADLINE_EXTRA_MS = 45 * 60_000;
// Must stay well under the 2-min staleness window in claimNextAnalysis()
// (src/lib/analysis/worker.ts) — a live run may never look stale.
const HEARTBEAT_INTERVAL_MS = 20_000;
// Discovery checkpoint, stored as a row in call_analysis_files (no schema
// change needed; the (analysis_id, filename) unique index already exists).
// Excluded from the details/download endpoints; deleted when the run is done.
const MANIFEST_FILENAME = "_manifest.json";
const MANIFEST_FILE_TYPE = "manifest";
// When >10% of leads fail the call-note scan (Kommo token down / outage) we
// refuse to freeze a half-empty call list and retry next chunk — but give up
// loudly after this many consecutive failed chunks instead of looping forever.
const MAX_DISCOVERY_FAIL_STREAK = 3;
// Feature flag: batched discovery via the bulk /leads/notes + /contacts/notes
// endpoints with filter[entity_id][] (50 ids per request) instead of 2-3
// requests PER LEAD. At the global 1 req/sec Kommo budget that's ~2 min vs
// ~40+ min for a 769-deal filter. Behind a flag (default OFF) so a Kommo API
// surprise (entity_id filter silently ignored, like the created_at gotcha on
// /notes) can be rolled back from Dokploy env without a deploy. Verify before
// enabling: bulk response counts must match the per-entity path on a couple
// of known contacts (see dev_docs/18, Phase 5 verification).
const ANALYSIS_BATCH_DISCOVERY = process.env.ANALYSIS_BATCH_DISCOVERY === "1";

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
interface KommoNote { id: number; note_type: string; params: { duration?: number; link?: string }; created_at: number; responsible_user_id: number; entity_id?: number }

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

/**
 * Batched alternative to fetchCallNotesForEntity: one bulk request per ~50
 * entity ids via `/{entity}/notes?filter[entity_id][]=…` instead of one
 * request per entity. Returns notes bucketed by entity_id. Same note_type
 * filter as the per-entity path; the response's `entity_id` field maps each
 * note back to its owner. Used only when ANALYSIS_BATCH_DISCOVERY=1.
 *
 * NOTE the Kommo /notes filter gotcha precedent (filter[created_at] is
 * silently ignored there — cost a week, commit f4bd662): if filter[entity_id]
 * were silently ignored too, this would return the account-wide note firehose.
 * Guard: any note whose entity_id is missing or not in `ids` is dropped, and
 * if >50% of a page is dropped we throw so the caller falls back to marking
 * the batch failed rather than silently mis-attributing calls.
 */
async function fetchNotesBulk(
  entity: "leads" | "contacts",
  ids: number[],
): Promise<Map<number, KommoNote[]>> {
  const byEntity = new Map<number, KommoNote[]>();
  if (ids.length === 0) return byEntity;
  const idSet = new Set(ids);
  const qs = ids.map((id) => `filter[entity_id][]=${id}`).join("&");
  // Page cap: 40 × 250 = 10k notes per batch — far beyond any real 50-entity
  // call history; hitting it means the filter is being ignored (see guard).
  for (let page = 1; page <= 40; page++) {
    const data = await kommoFetchPath(
      `/${entity}/notes?limit=250&page=${page}` +
        `&filter[note_type][]=call_in&filter[note_type][]=call_out&${qs}`,
    ) as { _embedded?: { notes?: KommoNote[] } } | null;
    const batch = data?._embedded?.notes ?? [];
    if (batch.length === 0) break;
    let dropped = 0;
    for (const n of batch) {
      if (!n.entity_id || !idSet.has(n.entity_id)) { dropped++; continue; }
      const arr = byEntity.get(n.entity_id);
      if (arr) arr.push(n);
      else byEntity.set(n.entity_id, [n]);
    }
    if (dropped > batch.length / 2) {
      throw new Error(
        `bulk ${entity}/notes: ${dropped}/${batch.length} notes outside the requested entity_id set — filter likely ignored`,
      );
    }
    if (batch.length < 250) break;
  }
  return byEntity;
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

/**
 * Превратить блоки «**Speaker A:** … / **Speaker B:** …» в диалог
 * «**Продавец:** … / **Клиент:** …» — выгрузка читается как переписка в
 * мессенджере. Кто продавец, определяем по направлению звонка (та же эвристика,
 * что в ОКК, src/app/api/okk/calls/[callId]/route.ts):
 *   исходящий → первым отвечает Клиент → продавец = второй спикер;
 *   входящий  → первым отвечает Менеджер → продавец = первый спикер.
 */
function formatChatTranscript(speakers: string, direction: string): string {
  const blocks: { speaker: string; text: string }[] = [];
  const re = /\*\*Speaker ([A-Z]):\*\*\s*([\s\S]*?)(?=\n\n\*\*Speaker [A-Z]:\*\*|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(speakers)) !== null) {
    const text = m[2].trim();
    if (text) blocks.push({ speaker: m[1], text });
  }
  if (blocks.length === 0) return speakers.trim();

  const isInbound = direction === "входящий" || direction === "inbound";
  const firstSpeaker = blocks[0].speaker;
  const managerSpeaker = isInbound
    ? firstSpeaker
    : (blocks.find((b) => b.speaker !== firstSpeaker)?.speaker ?? firstSpeaker);

  return blocks
    .map((b) => `**${b.speaker === managerSpeaker ? "Продавец" : "Клиент"}:** ${b.text}`)
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

// ==================== CHECKPOINT MANIFEST ====================

type Db = ReturnType<typeof getMainDb>;

interface CallRecord {
  leadId: number;
  leadName: string;
  duration: number;
  url: string;
  date: Date;
  direction: string;
  /** Kommo user id ответственного за заметку звонка → ФИ менеджера в шапке
   *  выгрузки. На старых манифестах поле отсутствует → имя «—». */
  responsibleUserId?: number;
}
// Same shape with `date` as an ISO string (JSON-serializable).
interface ManifestCall extends Omit<CallRecord, "date"> { date: string }
// Slimmed lead — only the fields the discovery loop reads (~150 bytes/lead,
// so even 5000 leads stay well under Postgres text-column comfort).
interface ManifestLead {
  id: number;
  name: string;
  created_at: number;
  closed_at: number; // 0 = open deal
  contacts: number[];
}
interface AnalysisManifest {
  version: 1;
  /** "discovery" = scanning leads for calls; "calls" = call list frozen. */
  phase: "discovery" | "calls";
  minDuration: number;
  leads: ManifestLead[];
  scannedLeadIds: number[];
  failedLeadIds: number[];
  foundCalls: ManifestCall[];
  /** Deduped + sorted + capped final list; only present when phase="calls".
   * Freezing it pins the call_NN numbering across resumes — re-running
   * discovery after Kommo data changed could shift indexes and orphan
   * already-saved call files. */
  callsManifest?: ManifestCall[];
  discoveryFailStreak: number;
}

function manifestCallToRecord(c: ManifestCall): CallRecord {
  return { ...c, date: new Date(c.date) };
}

/**
 * Filter a lead's raw call notes down to qualifying calls.
 *
 * Lower bound on call date: a call attributed to a lead must have happened
 * DURING that lead's lifetime, not before. Contact-level notes (which is
 * where PBX integrations log calls — see fetchCallNotes) include the
 * contact's entire call history across ALL of the contact's deals. Without
 * this guard a new lead inherits every old call the contact ever had,
 * polluting the analysis. Upper bound: closed deals — only count calls up to
 * the close date (closed_at = 0 for open deals → no upper bound).
 */
function matchCallsFromNotes(lead: ManifestLead, notes: KommoNote[], minDuration: number): ManifestCall[] {
  const leadCreatedAt = lead.created_at || 0;
  const leadClosedAt = lead.closed_at > 0 ? lead.closed_at : Number.POSITIVE_INFINITY;
  const matched: ManifestCall[] = [];
  for (const n of notes) {
    const dur = n.params?.duration || 0;
    const link = n.params?.link;
    if (dur < minDuration || !link) continue;
    if (link.includes("localhost")) continue;
    if (n.created_at < leadCreatedAt) continue;
    if (n.created_at > leadClosedAt) continue;
    matched.push({
      leadId: lead.id,
      leadName: lead.name,
      duration: dur,
      url: link,
      date: new Date(n.created_at * 1000).toISOString(),
      direction: n.note_type === "call_in" ? "входящий" : "исходящий",
      responsibleUserId: n.responsible_user_id,
    });
  }
  return matched;
}

async function loadManifest(db: Db, analysisId: string): Promise<AnalysisManifest | null> {
  const rows = await db
    .select({ content: callAnalysisFiles.content })
    .from(callAnalysisFiles)
    .where(and(
      eq(callAnalysisFiles.analysisId, analysisId),
      eq(callAnalysisFiles.filename, MANIFEST_FILENAME),
    ));
  if (rows.length === 0) return null;
  try {
    const parsed = JSON.parse(rows[0].content) as AnalysisManifest;
    if (parsed.version !== 1 || !Array.isArray(parsed.leads)) {
      throw new Error("unexpected manifest shape");
    }
    return parsed;
  } catch (err) {
    // Corrupt manifest → treat as absent: discovery restarts from zero.
    // Bounded cost, no crash — but loud in Sentry because it should never
    // happen (we are the only writer).
    captureAnalysisMessage(
      `Corrupt ${MANIFEST_FILENAME}, restarting discovery: ${err instanceof Error ? err.message : String(err)}`,
      "warning",
      { step: "discovery", severity: "non_fatal", extra: { analysisId } },
    );
    return null;
  }
}

async function saveManifest(db: Db, analysisId: string, manifest: AnalysisManifest): Promise<void> {
  const content = JSON.stringify(manifest);
  await db
    .insert(callAnalysisFiles)
    .values({ analysisId, filename: MANIFEST_FILENAME, content, fileType: MANIFEST_FILE_TYPE })
    .onConflictDoUpdate({
      target: [callAnalysisFiles.analysisId, callAnalysisFiles.filename],
      set: { content },
    });
}

async function deleteManifest(db: Db, analysisId: string): Promise<void> {
  await db
    .delete(callAnalysisFiles)
    .where(and(
      eq(callAnalysisFiles.analysisId, analysisId),
      eq(callAnalysisFiles.filename, MANIFEST_FILENAME),
    ));
}

// ==================== MAIN PIPELINE ====================

export async function runAnalysisPipeline(
  analysisId: string,
  opts?: { softDeadlineMs?: number },
): Promise<void> {
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
  if (!ELEVENLABS_KEY) {
    const msg = "Не настроена переменная окружения: ELEVENLABS_API_KEY. Добавьте в Dokploy Environment.";
    await db.update(callAnalyses).set({ status: "error", errorMessage: msg }).where(eq(callAnalyses.id, analysisId));
    console.error(`[Analysis ${analysisId}] ${msg}`);
    return;
  }

  // ---- Time-boxing + liveness ----
  // Soft deadline: workers stop picking up new units past it; the run
  // checkpoints and yields (status stays 'processing', next claim resumes).
  const softDeadlineMs = opts?.softDeadlineMs ?? SOFT_DEADLINE_MS;
  const softDeadlineAt = Date.now() + softDeadlineMs;
  const hardDeadlineAt = softDeadlineAt + HARD_DEADLINE_EXTRA_MS;
  // Set by the heartbeat when the row vanished or left 'processing'
  // (cancelled/deleted by the user) — workers drain without new work.
  let aborted = false;
  const shouldStop = () => aborted || Date.now() >= softDeadlineAt;

  // The pipeline owns its DB heartbeat (the old SSE-route heartbeat died with
  // the browser connection while the pipeline kept running, letting a second
  // claim start a DUPLICATE run). Every beat:
  //   • bumps updated_at so claimNextAnalysis() sees this run as alive;
  //   • the conditional WHERE doubles as the cancel/delete detector — zero
  //     rows back means the row is gone or no longer 'processing';
  //   • past hardDeadlineAt it stops refreshing, so a pipeline frozen in a
  //     way the per-request timeouts didn't catch goes stale and gets
  //     reclaimed instead of looking alive forever.
  const heartbeat = setInterval(() => {
    if (Date.now() >= hardDeadlineAt) {
      clearInterval(heartbeat);
      console.warn(`[Analysis ${analysisId}] hard deadline passed — heartbeat stopped, run is reclaimable`);
      return;
    }
    db.update(callAnalyses)
      .set({ updatedAt: sql`now()` })
      .where(sql`${callAnalyses.id} = ${analysisId} AND status = 'processing'`)
      .returning({ id: callAnalyses.id })
      .then((rows) => {
        if (rows.length === 0) {
          aborted = true;
          console.log(`[Analysis ${analysisId}] row cancelled/deleted — draining workers`);
        }
      })
      // A missed bump only risks a harmless reclaim attempt the next beat corrects.
      .catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);

  // Graceful yield: stop the heartbeat FIRST (otherwise a beat 20s later
  // would un-stale the row again), then backdate updated_at past the 2-min
  // staleness window so the very next claim resumes this run without waiting.
  const yieldRun = async (message: string) => {
    clearInterval(heartbeat);
    await db.update(callAnalyses)
      .set({ errorMessage: message, updatedAt: sql`now() - interval '3 minutes'` })
      .where(sql`${callAnalyses.id} = ${analysisId} AND status = 'processing'`)
      .catch(() => {});
    console.log(`[Analysis ${analysisId}] yielded: ${message}`);
  };

  try {
    // Conditional on purpose: a cancel/delete landing in the claim→start gap
    // must not be resurrected back to 'processing' by this write.
    await db.update(callAnalyses)
      .set({ status: "processing", updatedAt: sql`now()` })
      .where(sql`${callAnalyses.id} = ${analysisId} AND status IN ('pending', 'processing')`);

    // Parse minDuration from URL hash
    const hashMatch = analysis.kommoUrl.match(/#minDur=(\d+)/);
    const minDuration = hashMatch ? Number(hashMatch[1]) * 60 : DEFAULT_MIN_DURATION;
    const cleanUrl = analysis.kommoUrl.replace(/#minDur=\d+/, "");

    // ---- Load checkpoint manifest (resume support) ----
    let manifest = await loadManifest(db, analysisId);

    let cappedCalls: CallRecord[];
    if (manifest?.phase === "calls" && manifest.callsManifest) {
      // Call list already frozen by an earlier chunk — reuse it verbatim and
      // skip discovery entirely (this is what makes resumes cheap: zero Kommo
      // requests, and the call_NN numbering can't drift).
      cappedCalls = manifest.callsManifest.map(manifestCallToRecord);
      console.log(`[Analysis ${analysisId}] Resumed from manifest: ${cappedCalls.length} calls (discovery skipped)`);
    } else {
      // 1. Fetch leads from Kommo (or reuse the checkpointed list)
      let leads: ManifestLead[];
      if (manifest) {
        leads = manifest.leads;
        console.log(`[Analysis ${analysisId}] Resumed discovery: ${manifest.scannedLeadIds.length}/${leads.length} leads scanned`);
      } else {
        await db.update(callAnalyses).set({ errorMessage: "Загрузка лидов из Kommo..." }).where(eq(callAnalyses.id, analysisId));
        console.log(`[Analysis ${analysisId}] Fetching leads (minDur=${minDuration/60}min)...`);
        const fetched = await fetchLeadsFromUrl(cleanUrl);
        console.log(`[Analysis ${analysisId}] Found ${fetched.length} leads`);

        if (fetched.length === 0) {
          await db.update(callAnalyses).set({
            status: "error",
            errorMessage: "Не найдено лидов по указанной ссылке. Проверьте фильтр в Kommo.",
          }).where(eq(callAnalyses.id, analysisId));
          return;
        }

        // Checkpoint the lead list immediately (slimmed to what the scan
        // reads) — a resume must not re-pull 20 pages of leads from Kommo.
        leads = fetched.map((l) => ({
          id: l.id,
          name: (l.name || "").substring(0, 60),
          created_at: l.created_at || 0,
          closed_at: l.closed_at && l.closed_at > 0 ? l.closed_at : 0,
          contacts: (l._embedded?.contacts ?? []).map((c) => c.id),
        }));
        manifest = {
          version: 1,
          phase: "discovery",
          minDuration,
          leads,
          scannedLeadIds: [],
          failedLeadIds: [],
          foundCalls: [],
          discoveryFailStreak: 0,
        };
        await saveManifest(db, analysisId, manifest);
      }

      // 2. Fetch call notes for each unscanned lead in parallel (bounded),
      //    checkpointing every 25 leads. Dedup across leads happens at the
      //    freeze step below (same recording can appear on several leads).
      //
      //    Note on date semantics: the URL's filter_date_from/to is applied at
      //    the LEAD level via Kommo API (when filter_date_switch is present) to
      //    narrow which deals enter the pipeline. The call notes themselves are
      //    NOT additionally filtered by date — the user's mental model is
      //    "filter narrows deals; then pick all qualifying calls (by duration)
      //    in those deals regardless of when the calls were made." If you ever
      //    want to add a call-date filter, do it as a separate UI option, not
      //    silently coupled to the URL date range.
      // Non-null alias: TS can't narrow the `let manifest` capture inside the
      // async worker closure below, but at this point it is always set
      // (loaded above, or freshly created in the branch we just left).
      const mf: AnalysisManifest = manifest;
      const scannedSet = new Set(mf.scannedLeadIds);
      const failedSet = new Set(mf.failedLeadIds);
      const foundCalls = mf.foundCalls;
      const toScan = leads.filter((l) => !scannedSet.has(l.id));
      let scanned = scannedSet.size;
      let multiCallLeads = 0;
      let discoveryYielded = false;

      await db.update(callAnalyses)
        .set({ errorMessage: `Поиск звонков в ${leads.length} сделках...`, updatedAt: sql`now()` })
        .where(eq(callAnalyses.id, analysisId));

      // Checkpoint + progress + liveness in one beat. Concurrent workers may
      // interleave these writes; last-write-wins can lose ≤ one checkpoint
      // interval of scan state — harmless (re-scanned next chunk), so no
      // locking. Errors swallowed: a missed checkpoint only costs a re-scan.
      const checkpoint = async () => {
        mf.scannedLeadIds = [...scannedSet];
        mf.failedLeadIds = [...failedSet];
        await saveManifest(db, analysisId, mf).catch(() => void 0);
        await db
          .update(callAnalyses)
          .set({ errorMessage: `Поиск звонков: ${scanned}/${leads.length} сделок...`, updatedAt: sql`now()` })
          .where(eq(callAnalyses.id, analysisId))
          .catch(() => void 0);
      };

      if (ANALYSIS_BATCH_DISCOVERY) {
        // Batched path: 2 bulk requests per 50 leads (leads + their contacts)
        // instead of ~2.6 requests PER LEAD — see the flag comment up top.
        const BATCH = 50;
        for (let i = 0; i < toScan.length; i += BATCH) {
          if (shouldStop()) { discoveryYielded = true; break; }
          const batch = toScan.slice(i, i + BATCH);
          try {
            const leadNotes = await fetchNotesBulk("leads", batch.map((l) => l.id));
            const contactIds = [...new Set(batch.flatMap((l) => l.contacts))];
            const contactNotes = await fetchNotesBulk("contacts", contactIds);
            for (const lead of batch) {
              // Merge lead-level + contact-level notes, dedup by note id —
              // Kommo PBX integrations sometimes attach the same call to
              // several entities (same rule as fetchCallNotes).
              const seen = new Set<number>();
              const notes: KommoNote[] = [];
              for (const n of leadNotes.get(lead.id) ?? []) {
                if (!seen.has(n.id)) { seen.add(n.id); notes.push(n); }
              }
              for (const cid of lead.contacts) {
                for (const n of contactNotes.get(cid) ?? []) {
                  if (!seen.has(n.id)) { seen.add(n.id); notes.push(n); }
                }
              }
              const matched = matchCallsFromNotes(lead, notes, minDuration);
              foundCalls.push(...matched);
              if (matched.length > 1) multiCallLeads++;
              scannedSet.add(lead.id);
              failedSet.delete(lead.id);
              scanned++;
            }
          } catch (e: unknown) {
            console.warn(`[Analysis ${analysisId}] bulk notes batch failed:`, e);
            for (const lead of batch) {
              if (failedSet.has(lead.id)) {
                // Second failure: give up (scanned, zero calls) so a broken
                // batch can't block the freeze forever.
                scannedSet.add(lead.id);
                failedSet.delete(lead.id);
                scanned++;
              } else {
                // First failure: leave unscanned — the next chunk retries.
                failedSet.add(lead.id);
              }
            }
          }
          await checkpoint();
        }
      } else {
        await mapConcurrent(toScan, KOMMO_CONCURRENCY, async (lead) => {
          // Soft-deadline / cancel check at unit pickup: returning without work
          // lets the pool drain naturally (in-flight units finish, no new starts).
          if (shouldStop()) { discoveryYielded = true; return; }

          let notes: KommoNote[];
          try {
            notes = await fetchCallNotes({
              id: lead.id,
              name: lead.name,
              created_at: lead.created_at,
              closed_at: lead.closed_at,
              _embedded: { contacts: lead.contacts.map((id) => ({ id })) },
            } as KommoLead);
          } catch (e: unknown) {
            console.warn(`[Analysis ${analysisId}] fetchCallNotes(${lead.id}) failed:`, e);
            if (!failedSet.has(lead.id)) {
              // First failure: leave the lead unscanned — the next chunk retries it.
              failedSet.add(lead.id);
              return;
            }
            // Second failure: give up on this lead (scanned, zero calls) so a
            // permanently broken lead can't block the freeze forever.
            notes = [];
          }

          const matched = matchCallsFromNotes(lead, notes, minDuration);
          foundCalls.push(...matched);
          if (matched.length > 1) multiCallLeads++;
          scannedSet.add(lead.id);
          failedSet.delete(lead.id);
          scanned++;
          if (scanned % 25 === 0 || scanned === leads.length) {
            await checkpoint();
          }
        });
      }

      // Persist the final scan state before deciding what happens next.
      mf.scannedLeadIds = [...scannedSet];
      mf.failedLeadIds = [...failedSet];

      if (discoveryYielded || aborted) {
        await saveManifest(db, analysisId, mf).catch(() => void 0);
        await yieldRun(`Пауза: просканировано ${scannedSet.size}/${leads.length} сделок — продолжится автоматически...`);
        return;
      }

      const unscanned = leads.length - scannedSet.size;
      if (unscanned > 0 && unscanned > Math.ceil(leads.length * 0.1)) {
        // Mass discovery failure (Kommo token down / outage): refuse to
        // freeze a half-empty call list — that would silently produce
        // "0 звонков" or a truncated analysis. Retry next chunk, give up
        // loudly after MAX_DISCOVERY_FAIL_STREAK consecutive failed chunks.
        mf.discoveryFailStreak = (mf.discoveryFailStreak || 0) + 1;
        await saveManifest(db, analysisId, mf).catch(() => void 0);
        if (mf.discoveryFailStreak >= MAX_DISCOVERY_FAIL_STREAK) {
          await db.update(callAnalyses).set({
            status: "error",
            errorMessage: `Kommo не отдал звонки по ${unscanned} из ${leads.length} сделок после ${MAX_DISCOVERY_FAIL_STREAK} попыток. Проверьте доступ к Kommo и нажмите «Повторить».`,
          }).where(eq(callAnalyses.id, analysisId));
          return;
        }
        await yieldRun(`Сбой Kommo: не просканировано ${unscanned} сделок — авто-повтор (попытка ${mf.discoveryFailStreak}/${MAX_DISCOVERY_FAIL_STREAK})...`);
        return;
      }
      mf.discoveryFailStreak = 0;

      if (multiCallLeads > 0) {
        console.log(
          `[Analysis ${analysisId}] ${multiCallLeads} lead(s) had >1 qualifying call — all will be transcribed`,
        );
      }

      // 3. Freeze the call list: global dedup by URL (same recording in
      //    several leads → count once), cap at MAX_CALLS (most recent first)
      //    and log how many were trimmed so the user knows the filter needs
      //    tightening if it hit the ceiling.
      const seenUrls = new Set<string>();
      const calls: ManifestCall[] = [];
      for (const c of foundCalls) {
        if (seenUrls.has(c.url)) continue;
        seenUrls.add(c.url);
        calls.push(c);
      }
      // ISO-8601 strings sort lexicographically = chronologically.
      calls.sort((a, b) => b.date.localeCompare(a.date));
      const capped = calls.slice(0, MAX_CALLS);
      if (calls.length > MAX_CALLS) {
        console.warn(
          `[Analysis ${analysisId}] filter produced ${calls.length} calls, trimmed to ${MAX_CALLS} most recent`,
        );
      }

      if (capped.length === 0) {
        await db.update(callAnalyses).set({
          status: "error",
          errorMessage: `Не найдено звонков ≥${minDuration/60} мин среди ${leads.length} сделок.`,
        }).where(eq(callAnalyses.id, analysisId));
        return;
      }

      mf.phase = "calls";
      mf.callsManifest = capped;
      mf.foundCalls = []; // superseded by callsManifest — keep the row slim
      await saveManifest(db, analysisId, mf);
      cappedCalls = capped.map(manifestCallToRecord);
    }

    await db.update(callAnalyses)
      .set({ totalCalls: cappedCalls.length, errorMessage: null, updatedAt: sql`now()` })
      .where(eq(callAnalyses.id, analysisId));
    console.log(`[Analysis ${analysisId}] ${cappedCalls.length} calls to process`);

    // 3. Transcribe each call
    // Resume support: skip files that already exist so a re-run doesn't re-pay
    // for transcription on already-done calls.
    const existingFiles = await db
      .select({ filename: callAnalysisFiles.filename })
      .from(callAnalysisFiles)
      .where(eq(callAnalysisFiles.analysisId, analysisId));
    const existingSet = new Set(existingFiles.map(f => f.filename));

    // Карта kommo_user_id → ФИ менеджера для шапки выгрузки. Берём всех
    // менеджеров отдела (включая уволенных), чтобы исторический звонок всё
    // равно получил имя. master_managers живёт в D1 — это тот же `db`.
    const mgrRows = await db
      .select({ kommoUserId: masterManagers.kommoUserId, name: masterManagers.name })
      .from(masterManagers)
      .where(eq(masterManagers.department, analysis.department));
    const managerNameByKommoId = new Map<number, string>();
    for (const r of mgrRows) {
      if (r.kommoUserId != null) managerNameByKommoId.set(r.kommoUserId, r.name);
    }

    // Concurrency is the difference between a ~30-min run and a 3-hour run.
    // Scribe is synchronous, but a single 60-min call still takes 3-5min on
    // their side; running N in parallel reclaims most of that wait, so a
    // small worker pool gives a big speed-up.
    let processed = analysis.processedCalls || 0;
    const perCallLimit = TRANSCRIBE_CONCURRENCY;

    // Per-call failure isolation. A single transcription error records itself
    // as ⚠️ and lets the rest finish — it must never abort the whole run via
    // Promise.all aggregation. Track failures to surface a degraded final
    // status without poisoning the run.
    let transcribeFailures = 0;
    let processingYielded = false;

    await mapConcurrent(cappedCalls, perCallLimit, async (call, idx) => {
      // Soft-deadline / cancel check at unit pickup: in-flight calls finish
      // (their files get saved), no new transcriptions start, pool drains.
      if (shouldStop()) { processingYielded = true; return; }

      const num = String(idx + 1).padStart(2, "0");
      const dateStr = call.date.toLocaleDateString("ru-RU");
      const filename = `call_${num}_lead${call.leadId}.md`;

      if (existingSet.has(filename)) {
        console.log(`[Analysis ${analysisId}] [${num}] Skip (already done)`);
        return;
      }

      // Шапка — только: Дата звонка, ФИ менеджера, ссылка на сделку.
      const managerName = (call.responsibleUserId != null
        ? managerNameByKommoId.get(call.responsibleUserId)
        : null) ?? "—";
      const dealUrl = `https://${KOMMO.host}/leads/detail/${call.leadId}`;
      let md = `**Дата звонка:** ${dateStr}\n`;
      md += `**ФИ менеджера:** ${managerName}\n`;
      md += `**Ссылка на сделку:** ${dealUrl}\n\n`;

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
        md += `⚠️ Не удалось транскрибировать запись.\n`;
      } else if (!transcript.text) {
        // Scribe responded but the audio is silent or unintelligible.
        md += `⚠️ Запись транскрибирована, но текст пустой (тишина / неразборчивый звук).\n`;
      } else {
        // Диалог «Продавец/Клиент» — выгрузка читается как переписка.
        md += `${formatChatTranscript(transcript.speakers, call.direction)}\n`;
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
          step: "transcription", // file persistence for a transcribed call
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

    if (processingYielded || aborted) {
      // Per-call progress lives in call_analysis_files (idempotent skip on
      // resume) — no extra checkpoint needed here, just yield.
      await yieldRun(`Пауза: обработано ${processed}/${cappedCalls.length} звонков — продолжится автоматически...`);
      return;
    }

    // 4. Final status. Mark the run as 'done' so the user can download the
    // transcripts. Surface degraded state via error_message (kept alongside
    // status='done' for the UI to render as a warning chip) so the operator
    // knows some recordings failed to transcribe.
    const degradedMsg = transcribeFailures > 0
      ? `Завершено с предупреждениями: не удалось транскрибировать ${transcribeFailures} запис(и/ей)`
      : null;
    await db.update(callAnalyses).set({
      status: "done",
      progress: 100,
      errorMessage: degradedMsg,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    }).where(eq(callAnalyses.id, analysisId));

    // Checkpoint no longer needed — drop it so the files list stays clean
    // even if an exclusion filter is missed somewhere.
    await deleteManifest(db, analysisId).catch(() => void 0);

    console.log(
      `[Analysis ${analysisId}] ✅ Complete! ${cappedCalls.length} calls transcribed ` +
        `(transcribe fails: ${transcribeFailures}).`,
    );

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Analysis ${analysisId}] ERROR:`, msg);
    await db.update(callAnalyses).set({ status: "error", errorMessage: msg }).where(eq(callAnalyses.id, analysisId));
  } finally {
    // Idempotent: yieldRun may have cleared it already. Without this, a
    // throw path would leave the interval alive, bumping updated_at forever
    // on an 'error' row (harmless for claims, but a leaked timer per run).
    clearInterval(heartbeat);
  }
}
