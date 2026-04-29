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
import {
  FAILURE_PER_CALL_PROMPT, SUCCESS_PER_CALL_PROMPT,
  FAILURE_SUMMARY_PROMPT, SUCCESS_SUMMARY_PROMPT,
  PER_CALL_MODEL, SUMMARY_MODEL,
  PER_CALL_MAX_TOKENS, SUMMARY_MAX_TOKENS,
} from "./prompts";

const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_API_KEY || "";
const XAI_API_KEY = process.env.XAI_API_KEY || "";
const DEFAULT_MIN_DURATION = 300; // 5 min
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

interface KommoLead { id: number; name: string; responsible_user_id: number; status_id: number; pipeline_id: number }
interface KommoNote { id: number; note_type: string; params: { duration?: number; link?: string }; created_at: number; responsible_user_id: number }

/**
 * Translates Kommo *frontend* URL params into Kommo *API v4* filter params.
 *
 * The frontend uses a different filter syntax than the public API. Pasting
 * a frontend URL straight into /api/v4/leads silently ignores everything
 * (params it doesn't recognize) and returns every lead in the account up to
 * the pagination cap — that's why the pipeline used to scan ~5000 deals
 * even when the Kommo UI showed 596.
 *
 * Mappings handled here:
 *   • `filter[pipe][PIPELINE_ID][]=STATUS_ID` (one or many)
 *       → `filter[statuses][N][pipeline_id]=PIPELINE_ID`
 *         `filter[statuses][N][status_id]=STATUS_ID`
 *   • `filter[cf][FIELD_ID][]=ENUM_ID` (one or many per field)
 *       → `filter[custom_fields_values][FIELD_ID][values][N][enum_id]=ENUM_ID`
 *   • `filter_date_switch=closed|created|updated` + `filter_date_from=DD.MM.YYYY`
 *     + `filter_date_to=DD.MM.YYYY`
 *       → `filter[<api_field>][from]=<unix>` + `filter[<api_field>][to]=<unix>`
 *   • path `/pipeline/<PIPELINE_ID>/` as fallback when no status filter is set
 *       → `filter[pipeline_id]=PIPELINE_ID`
 *
 * Any frontend params we don't recognise are dropped — narrowing the result
 * is always safer than passing unrecognised filters and getting an over-wide
 * dataset back. Things like `useFilter=y` are decorative and intentionally
 * ignored. Returns the full search-string (without leading `?`).
 */
function buildLeadsApiQuery(kommoUrl: string): string {
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
  if (!hasStatusFilter) {
    const pathPipeline = parsed.pathname.match(/\/pipeline\/(\d+)/)?.[1];
    if (pathPipeline) out.set("filter[pipeline_id]", pathPipeline);
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

  // 3. Custom-field enum filters — group by field, index by position per field.
  const CF_RE = /^filter\[cf\]\[(\d+)\]\[\]$/;
  const cfByField = new Map<string, string[]>();
  for (const [key, value] of fp.entries()) {
    const m = key.match(CF_RE);
    if (!m) continue;
    const fieldId = m[1];
    if (!cfByField.has(fieldId)) cfByField.set(fieldId, []);
    cfByField.get(fieldId)!.push(value);
  }
  for (const [fieldId, enumIds] of cfByField) {
    enumIds.forEach((enumId, i) => {
      out.append(
        `filter[custom_fields_values][${fieldId}][values][${i}][enum_id]`,
        enumId,
      );
    });
  }

  return out.toString();
}

function parseRuDate(s: string, endOfDay: boolean): number | null {
  // Accepts DD.MM.YYYY (Kommo frontend default). Returns Unix seconds at UTC.
  // Account-level TZ drift (Kommo accounts are typically Europe/Berlin or
  // Europe/Moscow) shifts the boundary by a few hours, but for "find calls
  // in this date range" purposes that's fine — far better than fetching all
  // leads in the account because the filter was untranslated.
  const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const time = endOfDay ? "23:59:59Z" : "00:00:00Z";
  const ts = Date.parse(`${yyyy}-${mm}-${dd}T${time}`);
  return Number.isFinite(ts) ? Math.floor(ts / 1000) : null;
}

async function fetchLeadsFromUrl(kommoUrl: string): Promise<KommoLead[]> {
  const apiQuery = buildLeadsApiQuery(kommoUrl);

  const allLeads: KommoLead[] = [];
  for (let page = 1; page <= 20; page++) {
    const apiUrl = `/leads?${apiQuery}&limit=250&page=${page}`;
    const data = await kommoFetchPath(apiUrl) as { _embedded?: { leads?: KommoLead[] } } | null;
    if (!data?._embedded?.leads?.length) break;
    allLeads.push(...data._embedded.leads);
  }
  return allLeads;
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
    });
    const { id, error } = await submitRes.json() as { id?: string; error?: string };
    if (error || !id) return null;

    for (let i = 0; i < 120; i++) {
      await sleep(10000);
      const pollRes = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
        headers: { Authorization: ASSEMBLYAI_KEY },
      });
      const r = await pollRes.json() as { status: string; text?: string; utterances?: Array<{ speaker: string; text: string }>; error?: string };
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
  // Retry on transient 429 / 5xx with exponential backoff. xAI returns
  // Retry-After on real rate limits; respect it. Quota-exhaustion (no
  // Retry-After + body matches QUOTA_EXHAUSTED_RE) bails immediately so
  // partially-done runs save their state via the caller's try/catch and the
  // user can resume after topping up the account.
  const body = JSON.stringify({
    model,
    max_tokens: maxTokens,
    temperature: 0.1,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent.substring(0, 25000) },
    ],
  });

  let waitMs = 1000;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${XAI_API_KEY}`, "Content-Type": "application/json" },
      body,
    });
    if (res.ok) {
      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      return data.choices?.[0]?.message?.content || "";
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
