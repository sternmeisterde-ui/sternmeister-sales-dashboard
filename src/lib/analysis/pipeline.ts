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
import {
  FAILURE_PER_CALL_PROMPT, SUCCESS_PER_CALL_PROMPT,
  FAILURE_SUMMARY_PROMPT, SUCCESS_SUMMARY_PROMPT,
  PER_CALL_MODEL, SUMMARY_MODEL,
  PER_CALL_MAX_TOKENS, SUMMARY_MAX_TOKENS,
} from "./prompts";

const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_API_KEY || "";
const XAI_API_KEY = process.env.XAI_API_KEY || "";
const KOMMO_TOKEN = process.env.KOMMO_ACCESS_TOKEN || "";
const MIN_DURATION = 300; // 5 min
const MAX_CALLS = 100;

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
  const res = await fetch(`https://sternmeister.kommo.com/api/v4${path}`, {
    headers: { Authorization: `Bearer ${KOMMO_TOKEN}` },
  });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`Kommo API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

interface KommoLead { id: number; name: string; responsible_user_id: number; status_id: number; pipeline_id: number }
interface KommoNote { id: number; note_type: string; params: { duration?: number; link?: string }; created_at: number; responsible_user_id: number }

async function fetchLeadsFromUrl(kommoUrl: string): Promise<KommoLead[]> {
  const parsed = new URL(kommoUrl);
  if (parsed.hostname !== "sternmeister.kommo.com") throw new Error("Invalid Kommo URL domain");
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

    // 1. Fetch leads from Kommo
    console.log(`[Analysis ${analysisId}] Fetching leads...`);
    const leads = await fetchLeadsFromUrl(analysis.kommoUrl);
    console.log(`[Analysis ${analysisId}] Found ${leads.length} leads`);

    // 2. Fetch call notes for each lead, dedup, filter
    const seenUrls = new Set<string>();
    interface CallRecord { leadId: number; leadName: string; duration: number; url: string; date: Date; direction: string }
    const calls: CallRecord[] = [];

    for (const lead of leads) {
      const notes = await fetchCallNotes(lead.id);
      for (const n of notes) {
        const dur = n.params?.duration || 0;
        const link = n.params?.link;
        if (dur < MIN_DURATION || !link) continue;
        if (link.includes("localhost")) continue; // skip CallGear internal URLs
        if (seenUrls.has(link)) continue;
        seenUrls.add(link);
        calls.push({
          leadId: lead.id,
          leadName: (lead.name || "").substring(0, 60),
          duration: dur,
          url: link,
          date: new Date(n.created_at * 1000),
          direction: n.note_type === "call_in" ? "входящий" : "исходящий",
        });
      }
      await sleep(150);
    }

    // Cap at MAX_CALLS
    calls.sort((a, b) => b.date.getTime() - a.date.getTime());
    const cappedCalls = calls.slice(0, MAX_CALLS);

    if (cappedCalls.length === 0) {
      await db.update(callAnalyses).set({
        status: "error",
        errorMessage: `Не найдено звонков ≥5 мин (лидов: ${leads.length}, notes: ${calls.length})`,
      }).where(eq(callAnalyses.id, analysisId));
      return;
    }

    await db.update(callAnalyses).set({ totalCalls: cappedCalls.length }).where(eq(callAnalyses.id, analysisId));
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

    let processed = analysis.processedCalls || 0;

    for (const call of cappedCalls) {
      const num = String(cappedCalls.indexOf(call) + 1).padStart(2, "0");
      const dateStr = call.date.toLocaleDateString("ru-RU");
      const durMin = Math.round(call.duration / 60);
      const filename = `call_${num}_lead${call.leadId}.md`;

      // Skip already processed
      if (existingSet.has(filename)) {
        console.log(`[Analysis ${analysisId}] [${num}] Skip (already done)`);
        continue;
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
        await db.insert(callAnalysisFiles).values({
          analysisId, filename, content: md, fileType: "transcript", leadId: String(call.leadId),
        });
      } else {
        md += `## Транскрипт\n\n${transcript.speakers}\n\n`;

        // Grok per-call analysis
        console.log(`[Analysis ${analysisId}] [${num}] Analyzing with Grok...`);
        const analysis_text = await callGrok(perCallPrompt, md, PER_CALL_MODEL, PER_CALL_MAX_TOKENS);
        md += `## Анализ\n\n${analysis_text}\n`;
        allAnalyses.push(`### Звонок ${num} (Lead ${call.leadId}, ${dateStr}, ${durMin} мин)\n\n${analysis_text}`);

        await db.insert(callAnalysisFiles).values({
          analysisId, filename, content: md, fileType: "transcript", leadId: String(call.leadId),
        });
      }

      processed++;
      const progress = Math.round((processed / cappedCalls.length) * 90); // reserve 10% for summary
      await db.update(callAnalyses).set({ processedCalls: processed, progress }).where(eq(callAnalyses.id, analysisId));

      await sleep(1000); // rate limit between calls
    }

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

    // Save index file
    let indexMd = `# Индекс звонков\n\n`;
    indexMd += `| # | Дата | Длительность | Lead ID |\n|---|------|-------------|--------|\n`;
    for (let i = 0; i < cappedCalls.length; i++) {
      const c = cappedCalls[i];
      indexMd += `| ${i + 1} | ${c.date.toLocaleDateString("ru-RU")} | ${Math.round(c.duration / 60)} мин | ${c.leadId} |\n`;
    }
    await db.insert(callAnalysisFiles).values({ analysisId, filename: "INDEX.md", content: indexMd, fileType: "index" });

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
