/**
 * termin.* — раздел "Термин" дашборда (B2G-only).
 *
 * Cohort-чарт: средний срок от создания deal Бух Бератер → assigned «Дата
 * термина ДЦ» / «Дата термина АА». TERM_DC_DONE-aware: AA baseline = MIN
 * event_at WHERE status_id=93886075 (Термин ДЦ выполнен) когда есть.
 *
 * Phase 3a scope (1 tool): termin.cohort_chart
 *
 * Review-driven (Phase 3a SQL audit):
 *   - Correlated sub-query → pre-aggregated CTE (10× speedup)
 *   - Tagged sql template (not sql.raw)
 *   - berlinDayBoundaryHalfOpen helper
 *   - aa_with_dc_fallback_count для transparency
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { analytics } from "../../db/connections.js";
import { berlinDayBoundaryHalfOpen } from "../../utils/berlin.js";
import { registerTool } from "../../registry/builder.js";

const ISODate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const PIPELINE_BUH_BERATER = 12154099;
const TERM_DC_DONE_STATUS_ID = 93886075;

export function registerTerminDomain(server: McpServer): void {
  registerTool(server, {
    name: "termin.cohort_chart",
    description: `Cohort line chart для B2G Бух Бератер pipeline (12154099). Per-day средний срок (в днях) от создания лида до termin_date (DC) и от TERM_DC_DONE → aa_termin_date (AA, fallback на created_at если нет TERM_DC_DONE event'а). NULL termin'ы исключены, отрицательные тоже. Round to 1 decimal. Включает aa_with_dc_fallback_count для прозрачности когда AA baseline = created_at vs dc_done_at.`,
    inputShape: {
      from: ISODate,
      to: ISODate,
    },
    policy: {},
    handler: async ({ from, to }) => {
      const range = berlinDayBoundaryHalfOpen(from, to);
      const result = await analytics.execute(sql`
        WITH cohort AS (
          SELECT
            lc.lead_id,
            lc.created_at,
            lc.termin_date,
            lc.aa_termin_date
          FROM analytics.leads_cohort lc
          WHERE lc.pipeline_id = ${PIPELINE_BUH_BERATER}
            AND lc.created_at >= ${range.fromExpr}
            AND lc.created_at <  ${range.toExclusiveExpr}
        ),
        dc_done_times AS (
          -- Pre-aggregated subquery instead of correlated SELECT — drops
          -- runtime ~10× by collapsing N lookups into one hash-aggregate.
          SELECT lead_id, MIN(event_at) AS dc_done_at
          FROM analytics.lead_status_changes
          WHERE status_id = ${TERM_DC_DONE_STATUS_ID}
            AND lead_id IN (SELECT lead_id FROM cohort)
          GROUP BY lead_id
        ),
        with_metrics AS (
          SELECT
            (c.created_at AT TIME ZONE 'Europe/Berlin')::date AS cohort_date,
            CASE WHEN c.termin_date IS NOT NULL THEN
              EXTRACT(EPOCH FROM (c.termin_date - c.created_at)) / 86400.0
            END AS dc_days,
            CASE WHEN c.aa_termin_date IS NOT NULL THEN
              EXTRACT(EPOCH FROM (c.aa_termin_date - COALESCE(ddt.dc_done_at, c.created_at))) / 86400.0
            END AS aa_days,
            (ddt.dc_done_at IS NULL AND c.aa_termin_date IS NOT NULL) AS aa_used_created_fallback
          FROM cohort c
          LEFT JOIN dc_done_times ddt ON ddt.lead_id = c.lead_id
        )
        SELECT
          cohort_date::text AS date,
          ROUND(AVG(dc_days) FILTER (WHERE dc_days IS NOT NULL AND dc_days >= 0)::numeric, 1) AS avg_dc_days,
          COUNT(*) FILTER (WHERE dc_days IS NOT NULL AND dc_days >= 0)::int AS dc_count,
          ROUND(AVG(aa_days) FILTER (WHERE aa_days IS NOT NULL AND aa_days >= 0)::numeric, 1) AS avg_aa_days,
          COUNT(*) FILTER (WHERE aa_days IS NOT NULL AND aa_days >= 0)::int AS aa_count,
          COUNT(*) FILTER (WHERE aa_days IS NOT NULL AND aa_days >= 0 AND aa_used_created_fallback)::int AS aa_with_created_fallback,
          COUNT(*)::int AS leads_in_cohort
        FROM with_metrics
        GROUP BY cohort_date
        HAVING COUNT(*) FILTER (WHERE dc_days IS NOT NULL AND dc_days >= 0) > 0
            OR COUNT(*) FILTER (WHERE aa_days IS NOT NULL AND aa_days >= 0) > 0
        ORDER BY cohort_date
      `);
      const rows = (result.rows ?? result) as unknown[];
      return {
        dept: "b2g",
        pipeline_id: PIPELINE_BUH_BERATER,
        period: { from, to },
        count: Array.isArray(rows) ? rows.length : 0,
        rows,
      };
    },
  });
}
