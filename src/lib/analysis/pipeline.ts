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
import {
  FAILURE_PER_CALL_PROMPT, SUCCESS_PER_CALL_PROMPT,
  FAILURE_SUMMARY_PROMPT, SUCCESS_SUMMARY_PROMPT,
  PER_CALL_MODEL, SUMMARY_MODEL,
  PER_CALL_MAX_TOKENS, SUMMARY_MAX_TOKENS,
} from "./prompts";

const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_API_KEY || "";
const XAI_API_KEY = process.env.XAI_API_KEY || "";
const KOMMO_TOKEN = process.env.KOMMO_ACCESS_TOKEN || "";
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

async function kommoGet(path: string): Promise<unknown> {
  // Retry on 429 / 5xx with exponential backoff. Each attempt honours
  // Retry-After when present; otherwise doubles the wait.
  let waitMs = 500;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${KOMMO.apiBaseUrl}${path}`, {
      headers: { Authorization: `Bearer ${KOMMO_TOKEN}` },
    });
    if (res.status === 204) return null;
    if (res.ok) return res.json();
    const retriable = res.status === 429 || res.status >= 500;
    if (!retriable || attempt === 4) {
      throw new Error(`Kommo API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const retryAfter = Number(res.headers.get("retry-after") ?? "0");
    const backoff = retryAfter > 0 ? retryAfter * 1000 : waitMs;
    await sleep(backoff);
    waitMs *= 2;
  }
  throw new Error("Kommo API: exhausted retries");
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

interface KommoLead { id: number; name: string; responsible_user_id: number; status_id: number; pipeline_id: number }
interface KommoNote { id: number; note_type: string; params: { duration?: number; link?: string }; created_at: number; responsible_user_id: number }

async function fetchLeadsFromUrl(kommoUrl: string): Promise<KommoLead[]> {
  const parsed = new URL(kommoUrl);
  if (parsed.hostname !== KOMMO.host) throw new Error("Invalid Kommo URL domain");
  const filterParams = parsed.search;
  const pipelineMatch = parsed.pathname.match(/pipeline\/(\d+)/);

  let allLeads: KommoLead[] = [];
  for (let page = 1; page <= 20; page++) {
    const apiUrl = `/leads?${filterParams.substring(1)}&limit=250&page=${page}`;
    const data = await kommoGet(apiUrl) as { _embedded?: { leads?: KommoLead[] } } | null;
    if (!data?._embedded?.leads?.length) break;
    allLeads.push(...data._embedded.leads);
    await sleep(200);
  }
  return allLeads;
}

async function fetchCallNotes(leadId: number): Promise<KommoNote[]> {
  const data = await kommoGet(`/leads/${leadId}/notes?limit=100&filter[note_type]=call_in,call_out`) as { _embedded?: { notes?: KommoNote[] } } | null;
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

async function callGrok(systemPrompt: string, userContent: string, model: string, maxTokens: number): Promise<string> {
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${XAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature: 0.1,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent.substring(0, 25000) },
      ],
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Grok API ${res.status}: ${errText.substring(0, 200)}`);
  }
  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content || "";
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

  // Validate API keys — save error to DB if missing
  const missingKeys = [];
  if (!ASSEMBLYAI_KEY) missingKeys.push("ASSEMBLYAI_API_KEY");
  if (!XAI_API_KEY) missingKeys.push("XAI_API_KEY");
  if (!KOMMO_TOKEN) missingKeys.push("KOMMO_ACCESS_TOKEN");
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

    const allAnalyses: string[] = [];
    // Recover analyses from already-processed files
    for (const f of existingFiles) {
      if (f.content.includes("## Анализ")) {
        const match = f.content.match(/## Анализ\n\n([\s\S]+)$/);
        if (match) allAnalyses.push(match[1].trim());
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
        allAnalyses.push(`### Звонок ${num} (Lead ${call.leadId}, ${dateStr}, ${durMin} мин)\n\n${analysisText}`);
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
