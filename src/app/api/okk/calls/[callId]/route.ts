import { NextRequest, NextResponse } from "next/server";
import { getOkkDbForDepartment } from "@/lib/db/okk";
import { okkCalls, okkEvaluations, TranscriptSpeakerSegment } from "@/lib/db/schema-okk";
import { eq, desc } from "drizzle-orm";

// ─── Helper: format date ─────────────────────────────────────────────────────

function formatDate(date: Date | null): string {
  if (!date) return "—";
  const tz = "Europe/Moscow";
  const callDate = new Date(date);
  const now = new Date();

  const nowMsk = now.toLocaleDateString("en-CA", { timeZone: tz });
  const callMsk = callDate.toLocaleDateString("en-CA", { timeZone: tz });

  const hours = callDate.toLocaleString("ru-RU", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  if (callMsk === nowMsk) {
    return `Сегодня, ${hours}`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayMsk = yesterday.toLocaleDateString("en-CA", { timeZone: tz });
  if (callMsk === yesterdayMsk) {
    return `Вчера, ${hours}`;
  }

  const day = callDate.toLocaleString("ru-RU", { timeZone: tz, day: "2-digit" });
  const month = callDate.toLocaleString("ru-RU", { timeZone: tz, month: "2-digit" });
  return `${day}.${month}, ${hours}`;
}

// ─── Helper: build speaker-labelled transcript ───────────────────────────────
// AssemblyAI returns speakers as "A", "B", etc.
// We determine who is the manager based on call direction:
//   outbound → manager called the client → client picks up first → Speaker A = Клиент
//   inbound  → client called the company → manager answers first → Speaker A = Менеджер
// Fallback: assume outbound (most sales calls are outbound).

function buildSpeakerTranscript(
  speakersRaw: unknown,
  direction: string | null,
): string {
  // transcript_speakers is stored as { utterances: [...] }
  const utterances: TranscriptSpeakerSegment[] = (() => {
    if (!speakersRaw) return [];
    if (Array.isArray(speakersRaw)) return speakersRaw;
    if (
      typeof speakersRaw === "object" &&
      "utterances" in (speakersRaw as Record<string, unknown>)
    ) {
      return (speakersRaw as { utterances: TranscriptSpeakerSegment[] }).utterances ?? [];
    }
    return [];
  })();

  if (utterances.length === 0) return "";

  // Determine which speaker label is the manager
  const isOutbound = direction !== "inbound"; // default outbound
  // outbound: first speaker (A) = Client, second (B) = Manager
  // inbound:  first speaker (A) = Manager, second (B) = Client
  const firstSpeaker = utterances[0]?.speaker ?? "A";
  const managerSpeaker = isOutbound
    ? (utterances.find((u) => u.speaker !== firstSpeaker)?.speaker ?? "B")
    : firstSpeaker;

  return utterances
    .map((u) => {
      const role = u.speaker === managerSpeaker ? "[Продавец]" : "[Клиент]";
      return `${role}: ${u.text}`;
    })
    .join("\n");
}

// ─── GET /api/okk/calls/[callId] ─────────────────────────────────────────────
// Query params:
//   dept  — "b2g" | "b2b"  (default: "b2g")

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ callId: string }> },
) {
  try {
    const { callId } = await params;

    if (!callId) {
      return NextResponse.json(
        { success: false, error: "callId is required" },
        { status: 400 },
      );
    }

    const sp = request.nextUrl.searchParams;
    const deptParam = sp.get("dept") ?? "b2g";
    const department = (deptParam === "b2b" ? "b2b" : "b2g") as "b2g" | "b2b";

    const db = getOkkDbForDepartment(department);

    // ── Single call LEFT JOIN evaluation ─────────────────────
    const rows = await db
      .select({
        // Call fields
        id: okkCalls.id,
        managerId: okkCalls.managerId,
        managerName: okkCalls.managerName,
        durationSeconds: okkCalls.durationSeconds,
        recordingUrl: okkCalls.recordingUrl,
        transcript: okkCalls.transcript,
        transcriptSpeakers: okkCalls.transcriptSpeakers,
        direction: okkCalls.direction,
        kommoLeadUrl: okkCalls.kommoLeadUrl,
        callCreatedAt: okkCalls.callCreatedAt,
        // Evaluation fields (may be null when no evaluation exists yet)
        totalScore: okkEvaluations.totalScore,
        evaluationJson: okkEvaluations.evaluationJson,
        mistakes: okkEvaluations.mistakes,
        recommendations: okkEvaluations.recommendations,
      })
      .from(okkCalls)
      .leftJoin(okkEvaluations, eq(okkCalls.id, okkEvaluations.callId))
      .where(eq(okkCalls.id, callId))
      .orderBy(desc(okkEvaluations.createdAt))
      .limit(1);

    if (rows.length === 0) {
      return NextResponse.json(
        { success: false, error: "Call not found" },
        { status: 404 },
      );
    }

    const row = rows[0];

    // ── Duration formatting ───────────────────────────────────
    const dSec = row.durationSeconds || 0;
    const mins = Math.floor(dSec / 60);
    const secs = dSec % 60;

    // ── Client scoring and narrative summary from evaluation JSON ─────────
    const evalJson = row.evaluationJson as Record<string, unknown> | null;
    const clientScoring =
      (evalJson?.client_scoring as unknown) ||
      null;

    // Narrative summary string from evaluationJson.summary
    const evalSummary =
      typeof evalJson?.summary === "string" ? evalJson.summary : null;

    // Raw max score for displaying fraction (e.g. "8/33 (24%)")
    const totalMaxScore =
      typeof evalJson?.total_max_score === "number" ? evalJson.total_max_score : null;

    // ── Evaluation blocks with full criteria ──────────────────
    // Includes: name, score, maxScore, and per-criterion feedback/quote
    const blocks = (row.evaluationJson?.blocks ?? [])
      .filter((b) => (b.criteria && b.criteria.length > 0) || b.feedback)
      .map((b, i) => ({
        id: String(i),
        name: b.name || "",
        score: b.block_score ?? b.score ?? 0,
        maxScore: b.max_block_score ?? b.max_score ?? 0,
        criteria: b.criteria
          ? b.criteria.map((c, idx) => ({
              id: idx + 1,
              name: c.name || "",
              score: (() => {
                if (typeof c.score === "number") return c.score;
                if ((c.score as unknown) === "1") return 1;
                if ((c.score as unknown) === "0") return 0;
                console.warn(`[OKK] Unexpected criterion score: ${JSON.stringify(c.score)} for "${c.name}"`);
                return null;
              })(),
              maxScore:
                typeof c.max_score === "number"
                  ? c.max_score
                  : c.max_score === 1
                    ? 1
                    : 0,
              feedback: c.feedback || "",
              quote: c.quote || "",
            }))
          : [],
        // Derived summary of failed binary criteria for quick display
        feedback: b.criteria
          ? b.criteria
              .filter((c) => c.score === 0 && c.max_score > 0)
              .map((c) => `❌ ${c.name}`)
              .join("\n")
          : b.feedback || "",
      }));

    // ── Build final call object ───────────────────────────────
    const callData = {
      id: row.id,
      name: row.managerName || "—",
      avatarUrl: "",
      callDuration: `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`,
      date: formatDate(row.callCreatedAt),
      score: row.totalScore || 0,
      hasRecording: !!row.recordingUrl,
      audioUrl: row.recordingUrl
        ? `/api/okk/audio/${row.id}?dept=${department}`
        : "#",
      kommoUrl: row.kommoLeadUrl || "",
      transcript:
        buildSpeakerTranscript(row.transcriptSpeakers, row.direction) ||
        row.transcript ||
        "",
      aiFeedback: row.recommendations || "",
      summary: row.mistakes || "",
      evalSummary: evalSummary || "",
      totalMaxScore: totalMaxScore ?? undefined,
      blocks,
      clientScoring,
    };

    return NextResponse.json({ success: true, data: callData });
  } catch (error) {
    console.error("[OKK Call Detail API] Error:", error);
    const message =
      error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }
}
