// GET /api/analytics/debug?dept=b2g&from=2026-04-01&to=2026-04-28
//
// Returns per-day call counts from analytics.communications for the requested
// window — for diagnosing "this date shows 0 in dashboard but should have
// calls". Compares dashboard SQL semantics against raw row counts.

import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";
import { getPipelineIds } from "@/lib/kommo/pipeline-config";

export const dynamic = "force-dynamic";

function parseDate(s: string | null, fallback: Date): Date {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return fallback;
  return new Date(`${s}T00:00:00Z`);
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const dept = url.searchParams.get("dept") || url.searchParams.get("department");
    if (dept !== "b2g" && dept !== "b2b") {
      return NextResponse.json({ error: "dept=b2g|b2b required" }, { status: 400 });
    }

    const today = new Date();
    today.setUTCHours(23, 59, 59, 999);
    const monthAgo = new Date(today.getTime() - 30 * 86_400_000);
    const from = parseDate(url.searchParams.get("from"), monthAgo);
    const to = parseDate(url.searchParams.get("to"), today);
    to.setUTCHours(23, 59, 59, 999);

    const pipelineIds = getPipelineIds(dept);
    const pipelineList = sql.join(
      pipelineIds.map((id) => sql`${id}`),
      sql`, `,
    );

    // Per-day breakdown — raw counts BEFORE the dashboard's manager-name filter,
    // so we can tell apart "no rows in DB at all" from "rows exist but have
    // empty manager string and got filtered out by the dashboard SQL".
    const result = await (analyticsDb as unknown as {
      execute: <T>(q: unknown) => Promise<{ rows: T[] }>;
    }).execute<{
      day: string;
      total_rows: number;
      call_rows: number;
      call_with_manager: number;
      call_with_pipeline: number;
      distinct_managers: number;
    }>(sql`
      SELECT
        TO_CHAR(created_at AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD')              AS day,
        COUNT(*)::int                                                                AS total_rows,
        COUNT(*) FILTER (WHERE communication_type LIKE 'call%')::int                 AS call_rows,
        COUNT(*) FILTER (WHERE communication_type LIKE 'call%' AND manager <> '')::int AS call_with_manager,
        COUNT(*) FILTER (WHERE communication_type LIKE 'call%'
                          AND (pipeline_id IN (${pipelineList}) OR pipeline_id IS NULL))::int AS call_with_pipeline,
        COUNT(DISTINCT manager) FILTER (WHERE manager <> '')::int                    AS distinct_managers
      FROM analytics.communications
      WHERE created_at >= ${from}
        AND created_at <= ${to}
      GROUP BY day
      ORDER BY day
    `);

    return NextResponse.json({
      department: dept,
      window: { from: from.toISOString(), to: to.toISOString() },
      pipelineIds,
      perDay: result.rows.map((r) => ({
        day: r.day,
        total: Number(r.total_rows),
        calls: Number(r.call_rows),
        callsWithManager: Number(r.call_with_manager),
        callsCounted: Number(r.call_with_pipeline),
        managers: Number(r.distinct_managers),
      })),
    });
  } catch (err) {
    console.error("[analytics/debug] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
