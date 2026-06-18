import { NextRequest, NextResponse } from "next/server";
import { getOkkDbForDepartment } from "@/lib/db/okk";
import { okkCalls, okkEvaluations, okkManagers } from "@/lib/db/schema-okk";
import { eq, and, gte, lte, desc, sql, or } from "drizzle-orm";
import { cached } from "@/lib/kommo/cache";
import { formatCallDate, parseDateBoundary } from "@/lib/utils/date";
import { promptTypeForLine } from "@/lib/config/tenant";

// ─── GET handler ─────────────────────────────────────────────
// Returns data in the SAME shape as /api/calls:
//   { success: true, data: { calls: ManagerCall[], managers: ManagerStat[] } }

const OKK_CACHE_TTL = 2 * 60 * 1000; // 2 min

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const deptParam = sp.get("department") ?? "b2g";
    const department = (deptParam === "b2b" ? "b2b" : "b2g") as "b2g" | "b2b";

    const cacheKey = `okk-calls:${department}:${sp.get("from") || ""}:${sp.get("to") || ""}:${sp.get("status") || ""}:${sp.get("manager_id") || ""}:${sp.get("line") || ""}`;
    const result = await cached(cacheKey, OKK_CACHE_TTL, () => buildOkkResponse(department, sp));
    return NextResponse.json(result);
  } catch (error) {
    console.error("[OKK Calls API] Error:", error);
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

async function buildOkkResponse(department: "b2g" | "b2b", sp: URLSearchParams) {
    const db = getOkkDbForDepartment(department);

    // Build WHERE conditions
    const conditions: ReturnType<typeof eq>[] = [];

    const fromParam = sp.get("from");
    if (fromParam) {
      const fromDate = parseDateBoundary(fromParam, "start");
      if (fromDate) conditions.push(gte(okkCalls.callCreatedAt, fromDate));
    }

    const toParam = sp.get("to");
    if (toParam) {
      const toDate = parseDateBoundary(toParam, "end");
      if (toDate) conditions.push(lte(okkCalls.callCreatedAt, toDate));
    }

    const statusParam = sp.get("status");
    if (statusParam) {
      conditions.push(eq(okkCalls.status, statusParam));
    } else {
      // By default only show completed calls: "notified" (OKK pipeline) or "evaluated"
      conditions.push(
        sql`${okkCalls.status} IN ('notified', 'evaluated', 'completed')`
      );
    }

    // Only show calls that have been evaluated AND have a linked manager
    conditions.push(sql`${okkCalls.id} IN (SELECT call_id FROM evaluations WHERE total_score IS NOT NULL)`);
    conditions.push(sql`${okkCalls.managerId} IS NOT NULL`);

    // Hide calls withdrawn by audit/cleanup. Plain processing tags like
    // "Retro CRM-fetch ...", "Skipped: ..." stay visible — those are status
    // notes, not withdrawals. Withdrawal markers always start with "Removed"
    // or "Cleanup" (see scripts/preliminary-remove-complaint-evals.ts and
    // prior dual-filter cleanups of 2026-05-16 / 2026-05-20 in OKK repo).
    conditions.push(sql`
      (${okkCalls.errorMessage} IS NULL
       OR (${okkCalls.errorMessage} NOT ILIKE 'Removed%'
           AND ${okkCalls.errorMessage} NOT ILIKE 'Cleanup%'))
    `);

    const managerIdParam = sp.get("manager_id");
    if (managerIdParam) {
      conditions.push(eq(okkCalls.managerId, managerIdParam));
    }

    // B2B line filter → filter by prompt_type in evaluations.
    // B2G uses the manager.line column (not prompt_type), so skip here.
    const lineParam = sp.get("line");
    if (lineParam && department === "b2b") {
      const pt = promptTypeForLine(department, lineParam);
      if (pt) {
        conditions.push(sql`${okkCalls.id} IN (SELECT call_id FROM evaluations WHERE prompt_type = ${pt})`);
      }
    }

    const whereClause =
      conditions.length > 0 ? and(...conditions) : undefined;

    // ── All 3 queries in PARALLEL ────────────────────────────
    const [rows, allManagerRows, managerAggRows] = await Promise.all([
      // Query 1: Calls — LIGHT fields only (no transcript, no full evaluationJson)
      db
        .select({
          id: okkCalls.id,
          managerId: okkCalls.managerId,
          managerName: okkCalls.managerName,
          durationSeconds: okkCalls.durationSeconds,
          recordingUrl: okkCalls.recordingUrl,
          direction: okkCalls.direction,
          kommoLeadUrl: okkCalls.kommoLeadUrl,
          callCreatedAt: okkCalls.callCreatedAt,
          // Evaluation — only score + blocks summary (no transcript/mistakes/recommendations)
          totalScore: okkEvaluations.totalScore,
          evaluationJson: okkEvaluations.evaluationJson,
          callNumber: okkEvaluations.callNumber,
        })
        .from(okkCalls)
        .leftJoin(okkEvaluations, eq(okkCalls.id, okkEvaluations.callId))
        .where(whereClause)
        // Order by eval createdAt DESC so first row per call is the latest evaluation
        .orderBy(desc(okkCalls.callCreatedAt), desc(okkEvaluations.createdAt))
        // Cap at 5k to bound payload — a B2G month is ~600 evaluated calls,
        // so 5k covers ~8 months even with re-evaluation duplicates. Past
        // that the consumer should switch to a paginated query, not silently
        // truncate (which used to drop early-period calls from the per-manager
        // counters and broke payroll attribution).
        .limit(5000),

      // Query 2: Managers visible in the dropdown — active right now OR
      // historically attributed to ≥1 evaluated call inside the selected
      // window. Without the historical leg, anyone fired mid-period (e.g.
      // Нина Маркелова, deactivated 2026-04-30) drops out of the dropdown
      // and her calls become orphans for payroll attribution. The historical
      // leg uses the same whereClause as Query 1, so the dropdown lines up
      // with the evaluated-call set the dashboard is rendering.
      db
        .select({
          id: okkManagers.id,
          name: okkManagers.name,
          role: okkManagers.role,
          line: okkManagers.line,
        })
        .from(okkManagers)
        .where(
          and(
            sql`${okkManagers.role} IN ('manager', 'teamlead', 'rop')`,
            or(
              eq(okkManagers.isActive, true),
              sql`${okkManagers.id} IN (
                SELECT DISTINCT ${okkCalls.managerId} FROM ${okkCalls}
                LEFT JOIN ${okkEvaluations} ON ${okkCalls.id} = ${okkEvaluations.callId}
                WHERE ${whereClause ?? sql`TRUE`}
                  AND ${okkCalls.managerId} IS NOT NULL
              )`,
            ),
          ),
        )
        .orderBy(okkManagers.name),

      // Query 3: Per-manager call aggregates
      db
        .select({
          managerId: okkCalls.managerId,
          count: sql<number>`count(distinct ${okkCalls.id})::int`,
          evaluatedCount: sql<number>`count(${okkEvaluations.id})::int`,
          avgScore: sql<number>`round(avg(${okkEvaluations.totalScore}))::int`,
        })
        .from(okkCalls)
        .leftJoin(okkEvaluations, eq(okkCalls.id, okkEvaluations.callId))
        .where(whereClause)
        .groupBy(okkCalls.managerId),
    ]);

    // ── Deduplicate: keep only the first (latest eval) row per call ID ──
    // No slice() here — we used to truncate to 200 which silently dropped
    // early-period calls from per-manager counters in the consumer (and
    // therefore from payroll attribution). The query's limit(5000) is the
    // single source of truth for payload size.
    const seenCallIds = new Set<string>();
    const uniqueRows = rows.filter((row) => {
      if (seenCallIds.has(row.id)) return false;
      seenCallIds.add(row.id);
      return true;
    });

    // ── Convert to ManagerCall[] format (server-side, like queries-existing) ──
    const calls = uniqueRows.map((row) => {
      const dSec = row.durationSeconds || 0;
      const mins = Math.floor(dSec / 60);
      const secs = dSec % 60;

      // Extract client scoring and raw max score from evaluation JSON
      const evalJson = row.evaluationJson as Record<string, unknown> | null;
      const clientScoring = (evalJson?.client_scoring as unknown) || null;
      const totalMaxScore =
        typeof evalJson?.total_max_score === "number" ? evalJson.total_max_score : undefined;

      // LIGHT blocks: only id/name/score/maxScore — no criteria (loaded on-demand via /api/okk/calls/[callId])
      const blocks = (row.evaluationJson?.blocks || [])
        .filter((b) => (b.criteria && b.criteria.length > 0) || b.feedback)
        .map((b, i) => ({
          id: String(i),
          name: b.name || "",
          score: b.block_score ?? b.score ?? 0,
          maxScore: b.max_block_score ?? b.max_score ?? 0,
          criteria: [] as { id: number; name: string; score: number; maxScore: number; feedback: string; quote: string }[],
          feedback: "",
        }));

      return {
        id: row.id,
        name: row.managerName || "—",
        avatarUrl: "",
        callDuration: `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`,
        callNumber: row.callNumber || "",
        date: formatCallDate(row.callCreatedAt),
        // Raw ISO so clients can filter without round-tripping the display string.
        startedAtIso: row.callCreatedAt ? new Date(row.callCreatedAt).toISOString() : null,
        score: row.totalScore || 0,
        totalMaxScore,
        hasRecording: !!row.recordingUrl,
        audioUrl: row.recordingUrl
          ? `/api/okk/audio/${row.id}?dept=${department}`
          : "#",
        kommoUrl: row.kommoLeadUrl || "",
        // Heavy fields empty — loaded on-demand via /api/okk/calls/[callId]
        transcript: "",
        aiFeedback: "",
        summary: "",
        evalSummary: "",
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
        line: m.line || null,
      };
    });

    // ── Same response shape as /api/calls ────────────────────
    return {
      success: true,
      data: { calls, managers },
    };
}
