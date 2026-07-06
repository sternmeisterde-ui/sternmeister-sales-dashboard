// GET /api/dashboard/berater-statuses
//
// Returns the currently observed BERATER pipeline statuses straight from the
// analytics mirror (analytics.leads_cohort.status_id + status), so the
// Termin-section filter UI always reflects whatever Kommo has — names and IDs
// — without baking either into the frontend.
//
// Notes / known limits:
//   - `status` text is denormalised on every lead row at sync time. We pick
//     the most-recently-seen variant per status_id via DISTINCT ON (...) so
//     stale renames don't linger.
//   - Statuses with zero current leads in this mirror won't appear; they're
//     unreachable by the filter anyway. If a brand-new Kommo status hasn't
//     had a lead transition through it yet, ETL hasn't recorded it — the UI
//     just won't list it until the first lead lands there.
//   - lead_count is informative ("how many sit there right now"), useful as
//     a small badge in the multiselect.
//
// Returns:
//   { statuses: [{ id, name, leadCount }] }

import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";
import { getBeraterPipelineIds, type Vertical } from "@/lib/kommo/pipeline-config";

/** Вертикаль b2g из query (buh/med/all). Иначе undefined = буховый (legacy). */
function parseTerminVertical(raw: string | null): Vertical | undefined {
  return raw === "buh" || raw === "med" || raw === "all" ? raw : undefined;
}

interface RawRow {
  status_id: string | number;
  status_name: string | null;
  lead_count: string | number;
}

export async function GET(request: Request) {
  // Статус-пикер Термина — статусы бератер-воронки выбранной вертикали. Иначе
  // (undefined) — буховый набор (legacy). id соответствуют лидам этой вертикали,
  // поэтому termins-роут корректно фильтрует по ним в любом режиме.
  const vertical = parseTerminVertical(new URL(request.url).searchParams.get("vertical"));
  const pipelineList = sql.join(
    getBeraterPipelineIds(vertical).map((id) => sql`${id}`),
    sql`, `,
  );

  const result = await (
    analyticsDb as { execute: <T>(q: unknown) => Promise<{ rows: T[] }> }
  ).execute<RawRow>(sql`
    WITH latest AS (
      SELECT DISTINCT ON (status_id)
        status_id,
        status AS status_name,
        created_at AS last_seen_at
      FROM analytics.leads_cohort
      WHERE pipeline_id IN (${pipelineList})
        AND status IS NOT NULL
      ORDER BY status_id, created_at DESC
    ),
    counts AS (
      SELECT status_id, COUNT(*)::bigint AS lead_count
      FROM analytics.leads_cohort
      WHERE pipeline_id IN (${pipelineList})
      GROUP BY status_id
    )
    SELECT
      l.status_id,
      l.status_name,
      COALESCE(c.lead_count, 0) AS lead_count
    FROM latest l
    LEFT JOIN counts c ON c.status_id = l.status_id
    ORDER BY l.status_id ASC
  `);

  const statuses = result.rows.map((r) => ({
    id: Number(r.status_id),
    name: r.status_name ?? `Статус ${r.status_id}`,
    leadCount: Number(r.lead_count ?? 0),
  }));

  return NextResponse.json(
    { statuses },
    { headers: { "Cache-Control": "private, max-age=300" } },
  );
}
