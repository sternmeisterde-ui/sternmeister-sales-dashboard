import { NextRequest, NextResponse } from "next/server";
import { getOkkDbForDepartment } from "@/lib/db/okk";
import { okkCalls, okkEvaluations } from "@/lib/db/schema-okk";
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

    // ── Per-manager aggregate ────────────────────────────────
    const managerAggRows = await db
      .select({
        managerId: okkCalls.managerId,
        managerName: okkCalls.managerName,
        count: sql<number>`count(distinct ${okkCalls.id})::int`,
        evaluatedCount: sql<number>`count(${okkEvaluations.id})::int`,
        avgScore: sql<number>`round(avg(${okkEvaluations.totalScore}))::int`,
      })
      .from(okkCalls)
      .leftJoin(okkEvaluations, eq(okkCalls.id, okkEvaluations.callId))
      .where(whereClause)
      .groupBy(okkCalls.managerId, okkCalls.managerName)
      .orderBy(desc(sql`count(distinct ${okkCalls.id})`));

    // ── Convert to ManagerCall[] format (server-side, like queries-existing) ──
    const calls = rows.map((row) => {
      const dSec = row.durationSeconds || 0;
      const mins = Math.floor(dSec / 60);
      const secs = dSec % 60;

      // Convert evaluation blocks to UI block format
      const blocks = (row.evaluationJson?.blocks || [])
        .filter(
          (b) =>
            (b.block_score ?? b.score ?? 0) > 0 ||
            (b.max_block_score ?? b.max_score ?? 0) > 0
        )
        .map((b, i) => ({
          id: String(i),
          name: b.name || "",
          score: b.block_score ?? b.score ?? 0,
          maxScore: b.max_block_score ?? b.max_score ?? 0,
          feedback: b.criteria
            ? b.criteria
                .filter((c) => c.score === 0 && c.max_score > 0)
                .map((c) => `❌ ${c.name}`)
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
        transcript: row.transcript || "",
        aiFeedback: row.recommendations || "",
        summary: row.mistakes || "",
        blocks,
      };
    });

    // ── Convert to ManagerStat[] format ──────────────────────
    const managers = managerAggRows.map((m) => ({
      id: m.managerId || m.managerName || "",
      name: m.managerName || "—",
      avatarUrl: "",
      totalCalls: Number(m.count) || 0,
      avgScore: Number(m.avgScore) || 0,
      avgDuration: "—",
      conversionRate: "—",
    }));

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
