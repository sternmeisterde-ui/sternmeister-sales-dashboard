import { NextRequest, NextResponse } from "next/server";
import { getOkkDbForDepartment } from "@/lib/db/okk";
import { okkCalls, okkEvaluations, okkManagers, TranscriptSpeakerSegment } from "@/lib/db/schema-okk";
import { eq, and, gte, lte, desc, sql } from "drizzle-orm";

// ─── Helper: format date (same pattern as queries-existing.ts) ──────

function formatDate(date: Date | null): string {
  if (!date) return "—";
  const now = new Date();
  const callDate = new Date(date);
  const diffMs = now.getTime() - callDate.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  const hours = callDate.getHours().toString().padStart(2, "0");
  const minutes = callDate.getMinutes().toString().padStart(2, "0");

  if (diffDays === 0) {
    return `Сегодня, ${hours}:${minutes}`;
  } else if (diffDays === 1) {
    return `Вчера, ${hours}:${minutes}`;
  } else {
    const day = callDate.getDate().toString().padStart(2, "0");
    const month = (callDate.getMonth() + 1).toString().padStart(2, "0");
    return `${day}.${month}, ${hours}:${minutes}`;
  }
}

// ─── Helper: build speaker-labelled transcript ──────────────────────
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
    if (typeof speakersRaw === "object" && "utterances" in (speakersRaw as any)) {
      return (speakersRaw as any).utterances ?? [];
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

// ─── GET handler ─────────────────────────────────────────────
// Returns data in the SAME shape as /api/calls:
//   { success: true, data: { calls: ManagerCall[], managers: ManagerStat[] } }

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const department = (sp.get("department") ?? "b2g") as "b2g" | "b2b";

    const db = getOkkDbForDepartment(department);

    // Build WHERE conditions
    const conditions: ReturnType<typeof eq>[] = [];

    const fromParam = sp.get("from");
    if (fromParam) {
      const fromDate = new Date(fromParam);
      if (!isNaN(fromDate.getTime())) {
        conditions.push(gte(okkCalls.callCreatedAt, fromDate));
      }
    }

    const toParam = sp.get("to");
    if (toParam) {
      const toDate = new Date(toParam);
      if (!isNaN(toDate.getTime())) {
        toDate.setHours(23, 59, 59, 999);
        conditions.push(lte(okkCalls.callCreatedAt, toDate));
      }
    }

    const statusParam = sp.get("status");
    if (statusParam) {
      conditions.push(eq(okkCalls.status, statusParam));
    }

    const managerIdParam = sp.get("manager_id");
    if (managerIdParam) {
      conditions.push(eq(okkCalls.managerId, managerIdParam));
    }

    const whereClause =
      conditions.length > 0 ? and(...conditions) : undefined;

    // ── Main query: ALL calls left-joined with evaluations ────
    const rows = await db
      .select({
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
        // Evaluation (may be null)
        totalScore: okkEvaluations.totalScore,
        evaluationJson: okkEvaluations.evaluationJson,
        mistakes: okkEvaluations.mistakes,
        recommendations: okkEvaluations.recommendations,
      })
      .from(okkCalls)
      .leftJoin(okkEvaluations, eq(okkCalls.id, okkEvaluations.callId))
      .where(whereClause)
      .orderBy(desc(okkCalls.callCreatedAt))
      .limit(200);

    // ── All managers from managers table (only role='manager', active) ──
    const allManagerRows = await db
      .select({
        id: okkManagers.id,
        name: okkManagers.name,
        role: okkManagers.role,
      })
      .from(okkManagers)
      .where(
        and(
          eq(okkManagers.isActive, true),
          eq(okkManagers.role, "manager"),
        )
      )
      .orderBy(okkManagers.name);

    // ── Per-manager call aggregate (for scored stats) ────────
    const managerAggRows = await db
      .select({
        managerId: okkCalls.managerId,
        count: sql<number>`count(distinct ${okkCalls.id})::int`,
        evaluatedCount: sql<number>`count(${okkEvaluations.id})::int`,
        avgScore: sql<number>`round(avg(${okkEvaluations.totalScore}))::int`,
      })
      .from(okkCalls)
      .leftJoin(okkEvaluations, eq(okkCalls.id, okkEvaluations.callId))
      .where(whereClause)
      .groupBy(okkCalls.managerId);

    // ── Convert to ManagerCall[] format (server-side, like queries-existing) ──
    const calls = rows.map((row) => {
      const dSec = row.durationSeconds || 0;
      const mins = Math.floor(dSec / 60);
      const secs = dSec % 60;

      // Extract client scoring from evaluation JSON
      const evalJson = row.evaluationJson as any;
      const clientScoring = evalJson?.client_scoring || evalJson?.summary?.client_scoring || null;

      // Convert evaluation blocks to UI block format (keep ALL blocks including informational)
      const blocks = (row.evaluationJson?.blocks || [])
        .filter((b) => (b.criteria && b.criteria.length > 0) || b.feedback)
        .map((b, i) => ({
          id: String(i),
          name: b.name || "",
          score: b.block_score ?? b.score ?? 0,
          maxScore: b.max_block_score ?? b.max_score ?? 0,
          criteria: b.criteria
            ? b.criteria.map((c: any, idx: number) => ({
                id: idx + 1,
                name: c.name || '',
                score: typeof c.score === 'number' ? c.score : (c.score === '1' ? 1 : c.score === '0' ? 0 : -1),
                maxScore: typeof c.max_score === 'number' ? c.max_score : (c.max_score === 1 ? 1 : 0),
                feedback: c.feedback || '',
                quote: c.quote || '',
              }))
            : [],
          feedback: b.criteria
            ? b.criteria
                .filter((c: any) => c.score === 0 && c.max_score > 0)
                .map((c: any) => `❌ ${c.name}`)
                .join("\n")
            : b.feedback || "",
        }));

      return {
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
        blocks,
        clientScoring,
      };
    });

    // ── Merge managers table with call aggregates ────────────
    const aggByManagerId = new Map(
      managerAggRows.map((m) => [m.managerId, m])
    );

    const managers = allManagerRows.map((m) => {
      const agg = aggByManagerId.get(m.id);
      return {
        id: m.id,
        name: m.name || "—",
        avatarUrl: "",
        totalCalls: Number(agg?.count) || 0,
        avgScore: Number(agg?.avgScore) || 0,
        avgDuration: "—",
        conversionRate: "—",
        role: m.role || "manager",
      };
    });

    // ── Same response shape as /api/calls ────────────────────
    return NextResponse.json({
      success: true,
      data: { calls, managers },
    });
  } catch (error) {
    console.error("[OKK Calls API] Error:", error);
    const message =
      error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
