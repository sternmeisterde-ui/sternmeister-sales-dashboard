/**
 * GET /api/okk/audit?dept=b2g|b2b&from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Returns three sections for the OKK Audit panel:
 *   - coverage: per-manager-per-day webhook coverage from phantom_history
 *   - overrides: aggregated override impact per prompt_type from override_metadata
 *   - signal_quality: split of evals by follow-up signal source (lead_id reliable
 *     vs phone_fallback vs no CRM data)
 *
 * Admin-only.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getOkkDbForDepartment } from "@/lib/db/okk";
import { sql } from "drizzle-orm";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const dept = req.nextUrl.searchParams.get("dept") === "b2b" ? "b2b" : "b2g";
  const today = new Date();
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const from =
    req.nextUrl.searchParams.get("from") || fourteenDaysAgo.toISOString().slice(0, 10);
  const to = req.nextUrl.searchParams.get("to") || today.toISOString().slice(0, 10);

  const db = getOkkDbForDepartment(dept);

  try {
    const coverage = await db.execute(sql`
      SELECT manager_name, date, okk_count, phantom_count, coverage_pct
      FROM phantom_history
      WHERE date >= ${from} AND date <= ${to}
      ORDER BY date DESC, manager_name
    `);

    const overrides = await db.execute(sql`
      SELECT
        prompt_type,
        count(*)::int AS total_evals,
        count(*) FILTER (WHERE jsonb_array_length(override_metadata->'overrides_applied') > 0)::int AS override_fired_count,
        round(avg(
          (override_metadata->>'score_after_override')::int -
          (override_metadata->>'score_before_override')::int
        ) FILTER (WHERE override_metadata->>'score_before_override' IS NOT NULL)::numeric, 1) AS avg_score_delta
      FROM evaluations
      WHERE created_at >= ${from}::date AND created_at < (${to}::date + interval '1 day')
        AND override_metadata IS NOT NULL
      GROUP BY 1
      ORDER BY override_fired_count DESC
    `);

    const signalQuality = await db.execute(sql`
      SELECT
        coalesce(override_metadata->>'followup_signal_source', 'no_signal') AS source,
        count(*)::int AS n
      FROM evaluations
      WHERE created_at >= ${from}::date AND created_at < (${to}::date + interval '1 day')
        AND override_metadata IS NOT NULL
      GROUP BY 1
      ORDER BY 2 DESC
    `);

    const callTypes = await db.execute(sql`
      SELECT
        coalesce(override_metadata->>'call_type', 'unknown') AS call_type,
        count(*)::int AS n
      FROM evaluations
      WHERE created_at >= ${from}::date AND created_at < (${to}::date + interval '1 day')
        AND override_metadata IS NOT NULL
      GROUP BY 1
      ORDER BY 2 DESC
    `);

    return NextResponse.json({
      dept,
      from,
      to,
      coverage: (coverage as { rows?: unknown[] }).rows ?? coverage,
      overrides: (overrides as { rows?: unknown[] }).rows ?? overrides,
      signal_quality: (signalQuality as { rows?: unknown[] }).rows ?? signalQuality,
      call_types: (callTypes as { rows?: unknown[] }).rows ?? callTypes,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
