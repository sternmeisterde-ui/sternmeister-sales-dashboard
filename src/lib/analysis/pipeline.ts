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

import { eq } from "drizzle-orm";
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
} from "./prompts";

const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_API_KEY || "";
const XAI_API_KEY = process.env.XAI_API_KEY || "";
const DEFAULT_MIN_DURATION = 300; // 5 min

// Per-request fetch timeouts. AbortSignal.timeout is Node 20+ / Next.js 16
// runtime native; no manual setTimeout/clearTimeout dance needed. Without
// these, a stalled TCP connection (rare but real on long runs) holds a
// concurrency slot indefinitely — at 50 calls a single zombie worker doesn't
// crash the run but quietly drops throughput by 33%.
const ASSEMBLYAI_SUBMIT_TIMEOUT_MS = 60_000;   // POST that triggers AssemblyAI's own slow CDN fetch (1h MP3 from CloudTalk S3 can take 30-60s before they respond)
const ASSEMBLYAI_POLL_TIMEOUT_MS = 15_000;     // single status read between 10s sleeps
const ASSEMBLYAI_JOB_MAX_MS = 15 * 60 * 1000;  // hard wall-clock per transcription job (AssemblyAI sometimes gets stuck in 'processing' on their side; reclaim the slot)
const GROK_TIMEOUT_MS = 120_000;               // single-attempt timeout: 25k-char prompts on grok-beta regularly hit 45-90s
const GROK_TOTAL_TIMEOUT_MS = 180_000;         // overall callGrok budget across retries — bounds worker-freeze cascade if xAI partially outages
// Hard ceiling to avoid runaway cost — raised from 100 because filters with
// 300–500 qualifying deals commonly yield 150–300 matching calls and dropping
// the tail silently hid "older" qualifying calls. Still fits in ~30 min window.
const MAX_CALLS = 500;
// Concurrency limits per external service. Kommo is the strictest
// (7 req/s per docs, we stay well under). AssemblyAI tolerates 10+ parallel.
const KOMMO_CONCURRENCY = 5;
const TRANSCRIBE_CONCURRENCY = 4;
const GROK_CONCURRENCY = 3;

// Minimal worker-pool helper — keeps memory flat (results array pre-sized)
// and cancels-on-throw behaviour, unlike naive Promise.all that fans out
// all `map` tasks immediately.
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
      results[i] = await fn(items[i], i);
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
interface KommoLead {
  id: number;
  name: string;
  responsible_user_id: number;
  status_id: number;
  pipeline_id: number;
  custom_fields_values?: KommoLeadCustomField[] | null;
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

  // 2. Date filter
  const dateSwitch = fp.get("filter_date_switch");
  const dateFrom = fp.get("filter_date_from");
  const dateTo = fp.get("filter_date_to");
  if (dateSwitch && dateFrom && dateTo) {
    const apiField = dateSwitch === "closed" ? "closed_at"
      : dateSwitch === "created" ? "created_at"
      : dateSwitch === "updated" ? "updated_at"
      : null;
    const fromTs = parseRuDate(dateFrom, false);
    const toTs = parseRuDate(dateTo, true);
    if (apiField && fromTs !== null && toTs !== null) {
      out.set(`filter[${apiField}][from]`, String(fromTs));
      out.set(`filter[${apiField}][to]`, String(toTs));
    }
  }

  // 3. Custom-field enum filters — collected for client-side application.
  // We deliberately do NOT add them to `out`: Kommo /api/v4/leads ignores
  // `filter[custom_fields_values]` on GET, so attempting to filter via the
  // API would not narrow the dataset and would just bloat the URL.
  const CF_RE = /^filter\[cf\]\[(\d+)\]\[\]$/;
  const cfEnumFilter = new Map<number, Set<number>>();
  for (const [key, value] of fp.entries()) {
    const m = key.match(CF_RE);
    if (!m) continue;
    const fieldId = Number(m[1]);
    const enumId = Number(value);
    if (!Number.isFinite(fieldId) || !Number.isFinite(enumId)) continue;
    if (!cfEnumFilter.has(fieldId)) cfEnumFilter.set(fieldId, new Set());
    cfEnumFilter.get(fieldId)!.add(enumId);
  }

  return { apiQuery: out.toString(), cfEnumFilter };
}

/**
 * Apply client-side custom-field-enum filter (the part Kommo's API ignores).
 * Same semantics as the Kommo UI: AND across fields, OR within a field.
 * A lead passes only if every requested field has at least one of its
 * values' enum_ids in the requested set.
 */
function passesCfFilter(
  lead: KommoLead,
  cfEnumFilter: Map<number, Set<number>>,
): boolean {
  if (cfEnumFilter.size === 0) return true;
  const fields = lead.custom_fields_values ?? [];
  for (const [requiredFieldId, allowedEnumIds] of cfEnumFilter) {
    const f = fields.find((cf) => cf.field_id === requiredFieldId);
    if (!f) return false;
    const hasMatch = f.values.some(
      (v) => v.enum_id !== undefined && allowedEnumIds.has(v.enum_id),
    );
    if (!hasMatch) return false;
  }
  return true;
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

async function fetchLeadsFromUrl(kommoUrl: string): Promise<KommoLead[]> {
  const { apiQuery, cfEnumFilter } = buildLeadsApiQuery(kommoUrl);
  const hasCfFilter = cfEnumFilter.size > 0;

  // When a CF filter is in play, we must over-fetch and post-filter, so let
  // the API return everything matching pipeline+status+date, then narrow
  // locally. Without CF filtering, what comes back is already final.
  // `with=` adds nothing here — `custom_fields_values` is included in
  // /api/v4/leads responses by default.
  const apiQueryFull = apiQuery;

  const apiLeads: KommoLead[] = [];
  for (let page = 1; page <= 20; page++) {
    const apiUrl = `/leads?${apiQueryFull}&limit=250&page=${page}`;
    const data = await kommoFetchPath(apiUrl) as { _embedded?: { leads?: KommoLead[] } } | null;
    if (!data?._embedded?.leads?.length) break;
    apiLeads.push(...data._embedded.leads);
  }

  if (!hasCfFilter) return apiLeads;

  const filtered = apiLeads.filter((l) => passesCfFilter(l, cfEnumFilter));
  console.log(
    `[Analysis] CF filter: ${apiLeads.length} leads from API → ${filtered.length} after custom-field filter ` +
      `(fields: ${[...cfEnumFilter.keys()].join(",")})`,
  );
  return filtered;
}

async function fetchCallNotes(leadId: number): Promise<KommoNote[]> {
  const data = await kommoFetchPath(
    `/leads/${leadId}/notes?limit=100&filter[note_type]=call_in,call_out`,
  ) as { _embedded?: { notes?: KommoNote[] } } | null;
  return data?._embedded?.notes || [];
}

// ==================== TRANSCRIPTION ====================

async function transcribeAudio(audioUrl: string): Promise<{ text: string; speakers: string } | null> {
  // Try primary URL
  let result = await tryTranscribe(audioUrl);
  if (result) return result;

  // Fallback: if CloudTalk play URL, try S3 direct
  if (audioUrl.includes("cloudtalk.io/r/play/")) {
    const id = audioUrl.split("/").pop();
    const s3Url = `https://s3-nl.hostkey.com/be7f6465-cloudtalknl/cloudtalk-recordings/${id}.mp3`;
    result = await tryTranscribe(s3Url);
    if (result) return result;
  }

  return null;
}

async function tryTranscribe(url: string): Promise<{ text: string; speakers: string } | null> {
  try {
    const submitRes = await fetch("https://api.assemblyai.com/v2/transcript", {
      method: "POST",
      headers: { Authorization: ASSEMBLYAI_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ audio_url: url, language_code: "ru", speaker_labels: true }),
      signal: AbortSignal.timeout(ASSEMBLYAI_SUBMIT_TIMEOUT_MS),
    });
    const { id, error } = await submitRes.json() as { id?: string; error?: string };
    if (error || !id) return null;

    // Wall-clock fence — 120 × 10s = 20 min loop budget already, but a job
    // stuck on AssemblyAI's side can sit in `processing` indefinitely. Bail
    // at 15 min (the typical p99 for 1-hour audio is ~5 min) so a single
    // stuck job doesn't sit on a concurrency slot for the whole pipeline.
    const jobStartedAt = Date.now();

    for (let i = 0; i < 120; i++) {
      await sleep(10000);
      if (Date.now() - jobStartedAt > ASSEMBLYAI_JOB_MAX_MS) {
        console.warn(`[tryTranscribe] AssemblyAI job ${id} exceeded ${ASSEMBLYAI_JOB_MAX_MS / 60000}min — abandoning slot`);
        return null;
      }
      // Per-poll timeout shorter than the 10s sleep cadence so a hanging
      // socket doesn't burn the whole 20-min poll budget on one bad request.
      const pollRes = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
        headers: { Authorization: ASSEMBLYAI_KEY },
        signal: AbortSignal.timeout(ASSEMBLYAI_POLL_TIMEOUT_MS),
      }).catch((e: unknown) => {
        // A timed-out poll isn't fatal — AssemblyAI's job continues on their
        // side, we just retry on the next iteration. Returning null lets the
        // loop continue so we don't lose all progress to one slow poll.
        const isTimeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
        if (!isTimeout) throw e;
        return null;
      });
      if (!pollRes) continue;
      // Same body-read-abort risk as Grok (AbortSignal stays armed after
      // fetch resolves). For AssemblyAI it's far less likely (status payload
      // is <500B), but skip the iteration on abort instead of letting it
      // bubble out to the outer `catch { return null }` and discard the
      // whole transcript.
      let r: { status: string; text?: string; utterances?: Array<{ speaker: string; text: string }>; error?: string };
      try {
        r = await pollRes.json();
      } catch {
        continue;
      }
      if (r.status === "completed") {
        const speakers = r.utterances?.map(u => `**Speaker ${u.speaker}:** ${u.text}`).join("\n\n") || r.text || "";
        return { text: r.text || "", speakers };
      }
      if (r.status === "error") return null;
    }
    return null;
  } catch {
    return null;
  }
}

// ==================== GROK ANALYSIS ====================

// xAI quota-exhausted responses don't set Retry-After (the 429 isn't transient
// rate-limit; it's a billing condition). Detect them and fail fast — burning
// 4 attempts against a known-out account just delays the operator-visible
// error by ~10 seconds and adds noise to logs.
const QUOTA_EXHAUSTED_RE = /spending limit|out of credit|insufficient[_ ]?(?:credit|funds|quota)|exhausted/i;

async function callGrok(systemPrompt: string, userContent: string, model: string, maxTokens: number): Promise<string> {
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
      { role: "user", content: userContent.substring(0, 25000) },
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
  if (!ASSEMBLYAI_KEY) missingKeys.push("ASSEMBLYAI_API_KEY");
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
    await db.update(callAnalyses).set({ status: "processing" }).where(eq(callAnalyses.id, analysisId));

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
    await db.update(callAnalyses).set({ errorMessage: `Поиск звонков в ${leads.length} сделках...` }).where(eq(callAnalyses.id, analysisId));

    interface CallRecord { leadId: number; leadName: string; duration: number; url: string; date: Date; direction: string }
    let scanned = 0;
    const perLeadResults = await mapConcurrent(leads, KOMMO_CONCURRENCY, async (lead) => {
      const notes = await fetchCallNotes(lead.id).catch((e: unknown) => {
        console.warn(`[Analysis ${analysisId}] fetchCallNotes(${lead.id}) failed:`, e);
        return [] as KommoNote[];
      });
      const matched: CallRecord[] = [];
      for (const n of notes) {
        const dur = n.params?.duration || 0;
        const link = n.params?.link;
        if (dur < minDuration || !link) continue;
        if (link.includes("localhost")) continue;
        matched.push({
          leadId: lead.id,
          leadName: (lead.name || "").substring(0, 60),
          duration: dur,
          url: link,
          date: new Date(n.created_at * 1000),
          direction: n.note_type === "call_in" ? "входящий" : "исходящий",
        });
      }
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

    // Global dedup by URL — same recording in several leads → count once,
    // attributed to the first lead we saw it on.
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
    // Transcription waits on AssemblyAI polling (blocking I/O), so small N
    // parallel = big speed-up. Use the narrower of TRANSCRIBE / GROK limits.
    let processed = analysis.processedCalls || 0;
    const perCallLimit = Math.min(TRANSCRIBE_CONCURRENCY, GROK_CONCURRENCY);

    await mapConcurrent(cappedCalls, perCallLimit, async (call, idx) => {
      const num = String(idx + 1).padStart(2, "0");
      const dateStr = call.date.toLocaleDateString("ru-RU");
      const durMin = Math.round(call.duration / 60);
      const filename = `call_${num}_lead${call.leadId}.md`;

      if (existingSet.has(filename)) {
        console.log(`[Analysis ${analysisId}] [${num}] Skip (already done)`);
        return;
      }

      console.log(`[Analysis ${analysisId}] [${num}/${cappedCalls.length}] Transcribing lead ${call.leadId}...`);
      const transcript = await transcribeAudio(call.url);

      let md = `# Звонок ${num} — Lead ${call.leadId}\n\n`;
      md += `- **Дата:** ${dateStr}\n`;
      md += `- **Длительность:** ${durMin} мин\n`;
      md += `- **Направление:** ${call.direction}\n`;
      md += `- **Lead:** ${call.leadName}\n\n`;

      if (!transcript) {
        md += `## Транскрипт\n\n⚠️ Не удалось транскрибировать запись.\n`;
      } else {
        md += `## Транскрипт\n\n${transcript.speakers}\n\n`;
        console.log(`[Analysis ${analysisId}] [${num}] Analyzing with Grok...`);
        const analysisText = await callGrok(perCallPrompt, md, PER_CALL_MODEL, PER_CALL_MAX_TOKENS);
        md += `## Анализ\n\n${analysisText}\n`;
        allAnalysesByIdx[idx] = `### Звонок ${num} (Lead ${call.leadId}, ${dateStr}, ${durMin} мин)\n\n${analysisText}`;
      }

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

      processed++;
      const progress = Math.round((processed / cappedCalls.length) * 90);
      await db
        .update(callAnalyses)
        .set({ processedCalls: processed, progress })
        .where(eq(callAnalyses.id, analysisId));
    });

    // 4. Generate aggregate summary
    console.log(`[Analysis ${analysisId}] Generating summary...`);
    const allAnalyses = allAnalysesByIdx.filter((s): s is string => s !== null);
    const allAnalysesText = allAnalyses.join("\n\n---\n\n");
    const summary = await callGrok(
      summaryPrompt,
      `Всего проанализировано ${processed} звонков.\n\n${allAnalysesText}`,
      SUMMARY_MODEL,
      SUMMARY_MAX_TOKENS,
    );

    // Save summary file
    await db.insert(callAnalysisFiles).values({
      analysisId,
      filename: "SUMMARY.md",
      content: `# Сводный анализ\n\n${summary}`,
      fileType: "summary",
    });

    // Done
    await db.update(callAnalyses).set({
      status: "done",
      progress: 100,
      resultSummary: summary,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    }).where(eq(callAnalyses.id, analysisId));

    console.log(`[Analysis ${analysisId}] ✅ Complete! ${processed} calls analyzed.`);

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Analysis ${analysisId}] ERROR:`, msg);
    await db.update(callAnalyses).set({ status: "error", errorMessage: msg }).where(eq(callAnalyses.id, analysisId));
  }
}
