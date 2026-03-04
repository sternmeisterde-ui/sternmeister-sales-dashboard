import { NextRequest, NextResponse } from "next/server";
import { getOkkDbForDepartment } from "@/lib/db/okk";
import { okkCalls, okkEvaluations } from "@/lib/db/schema-okk";
import { eq, and, gte, lte, desc, sql } from "drizzle-orm";

// ─── Response types ──────────────────────────────────────────
export interface OkkEvaluationRow {
  // Evaluation fields
  evaluationId: string;
  callId: string;
  managerId: string | null;
  managerName: string | null;
  totalScore: number | null;
  evaluationJson: import("@/lib/db/schema-okk").EvaluationJson | null;
  mistakes: string | null;
  recommendations: string | null;
  modelUsed: string | null;
  evaluationCreatedAt: string | null;

  // Call fields
  contactPhone: string | null;
  durationSeconds: number | null;
  direction: string | null;
  recordingUrl: string | null;
  transcriptSpeakers: import("@/lib/db/schema-okk").TranscriptSpeakerSegment[] | null;
  transcript: string | null;
  kommoLeadUrl: string | null;
  kommoStatusName: string | null;
  callCreatedAt: string | null;
}

export interface OkkStats {
  totalCalls: number;
  avgScore: number;
  maxScore: number;
  minScore: number;
}

export interface OkkManagerStat {
  managerId: string | null;
  managerName: string | null;
  count: number;
  avgScore: number;
  maxScore: number;
  minScore: number;
}

export interface OkkApiResponse {
  evaluations: OkkEvaluationRow[];
  stats: OkkStats;
  byManager: OkkManagerStat[];
}

// ─── GET handler ─────────────────────────────────────────────
export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const department = (sp.get("department") ?? "b2g") as "b2g" | "b2b";
    const fromParam = sp.get("from");
    const toParam = sp.get("to");
    const managerIdParam = sp.get("manager_id");

    const db = getOkkDbForDepartment(department);

    // Build WHERE conditions
    const conditions = [];

    if (fromParam) {
      const fromDate = new Date(fromParam);
      if (!isNaN(fromDate.getTime())) {
        conditions.push(gte(okkEvaluations.createdAt, fromDate));
      }
    }

    if (toParam) {
      const toDate = new Date(toParam);
      if (!isNaN(toDate.getTime())) {
        // Include the full end day
        toDate.setHours(23, 59, 59, 999);
        conditions.push(lte(okkEvaluations.createdAt, toDate));
      }
    }

    if (managerIdParam) {
      conditions.push(eq(okkEvaluations.managerId, managerIdParam));
    }

    const whereClause =
      conditions.length > 0 ? and(...conditions) : undefined;

    // ── Main query: evaluations joined with calls ──────────────
    const rows = await db
      .select({
        // Evaluation
        evaluationId: okkEvaluations.id,
        callId: okkEvaluations.callId,
        managerId: okkEvaluations.managerId,
        totalScore: okkEvaluations.totalScore,
        evaluationJson: okkEvaluations.evaluationJson,
        mistakes: okkEvaluations.mistakes,
        recommendations: okkEvaluations.recommendations,
        modelUsed: okkEvaluations.modelUsed,
        evaluationCreatedAt: okkEvaluations.createdAt,
        // Call
        managerName: okkCalls.managerName,
        contactPhone: okkCalls.contactPhone,
        durationSeconds: okkCalls.durationSeconds,
        direction: okkCalls.direction,
        recordingUrl: okkCalls.recordingUrl,
        transcript: okkCalls.transcript,
        transcriptSpeakers: okkCalls.transcriptSpeakers,
        kommoLeadUrl: okkCalls.kommoLeadUrl,
        kommoStatusName: okkCalls.kommoStatusName,
        callCreatedAt: okkCalls.callCreatedAt,
      })
      .from(okkEvaluations)
      .leftJoin(okkCalls, eq(okkEvaluations.callId, okkCalls.id))
      .where(whereClause)
      .orderBy(desc(okkEvaluations.createdAt))
      .limit(100);

    // ── Per-manager aggregate ────────────────────────────────
    const managerAggRows = await db
      .select({
        managerId: okkEvaluations.managerId,
        managerName: okkCalls.managerName,
        count: sql<number>`count(*)::int`,
        avgScore: sql<number>`round(avg(${okkEvaluations.totalScore}))::int`,
        maxScore: sql<number>`max(${okkEvaluations.totalScore})`,
        minScore: sql<number>`min(${okkEvaluations.totalScore})`,
      })
      .from(okkEvaluations)
      .leftJoin(okkCalls, eq(okkEvaluations.callId, okkCalls.id))
      .where(whereClause)
      .groupBy(okkEvaluations.managerId, okkCalls.managerName)
      .orderBy(desc(sql`round(avg(${okkEvaluations.totalScore}))`));

    // ── Global stats ─────────────────────────────────────────
    const scores = rows
      .map((r) => r.totalScore)
      .filter((s): s is number => s !== null);

    const stats: OkkStats = {
      totalCalls: rows.length,
      avgScore:
        scores.length > 0
          ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
          : 0,
      maxScore: scores.length > 0 ? Math.max(...scores) : 0,
      minScore: scores.length > 0 ? Math.min(...scores) : 0,
    };

    // ── Serialize response ───────────────────────────────────
    const evaluations: OkkEvaluationRow[] = rows.map((r) => ({
      evaluationId: r.evaluationId,
      callId: r.callId ?? "",
      managerId: r.managerId,
      managerName: r.managerName,
      totalScore: r.totalScore,
      evaluationJson: r.evaluationJson,
      mistakes: r.mistakes,
      recommendations: r.recommendations,
      modelUsed: r.modelUsed,
      evaluationCreatedAt: r.evaluationCreatedAt
        ? r.evaluationCreatedAt.toISOString()
        : null,
      contactPhone: r.contactPhone,
      durationSeconds: r.durationSeconds,
      direction: r.direction,
      recordingUrl: r.recordingUrl,
      transcript: r.transcript,
      transcriptSpeakers: r.transcriptSpeakers,
      kommoLeadUrl: r.kommoLeadUrl,
      kommoStatusName: r.kommoStatusName,
      callCreatedAt: r.callCreatedAt ? r.callCreatedAt.toISOString() : null,
    }));

    const byManager: OkkManagerStat[] = managerAggRows.map((r) => ({
      managerId: r.managerId,
      managerName: r.managerName,
      count: Number(r.count),
      avgScore: Number(r.avgScore),
      maxScore: Number(r.maxScore),
      minScore: Number(r.minScore),
    }));

    const response: OkkApiResponse = { evaluations, stats, byManager };
    return NextResponse.json(response);
  } catch (error) {
    console.error("[OKK API] Error:", error);
    const message =
      error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
