/**
 * looker.* — упрощённые Phase 3a tools для cohort/SLA анализа.
 *
 * Phase 3a scope (3 tools):
 *   - looker.all_calls
 *   - looker.cohorts
 *   - looker.sla_outliers
 *
 * Упрощения относительно UI Looker route:
 *   - Без alias-folding (Maksim/Latin-C/Ukrainian-Є). Имена менеджеров —
 *     как в analytics.communications.manager (см. payload.name_drift_aliases).
 *   - Без integrator-snapshot SLA fallback (sla_*_integrator) — Phase 4.
 *   - Без per-pipeline status whitelist для SLA gating.
 *   - Filter по pipeline_id (bigint) — hit'ит idx_lc_pipeline_created.
 *
 * Review-driven (Phase 3a code+DB review):
 *   - tagged sql templates, не sql.raw inline (SQL injection defense)
 *   - pipeline_id вместо pipeline text (10x faster)
 *   - berlinDayBoundaryHalfOpen helper (consistency с analytics domain)
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { analytics } from "../../db/connections.js";
import { berlinDayBoundaryHalfOpen } from "../../utils/berlin.js";
import { registerTool } from "../../registry/builder.js";

const Dept = z.enum(["b2g", "b2b"]);
const ISODate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// Pipeline IDs verified in production (Neon analytics.leads_cohort).
// Numeric filter hits idx_lc_pipeline_created; text filter ('Бух Гос') doesn't.
const PIPELINE_IDS_BY_DEPT: Record<"b2g" | "b2b", readonly number[]> = {
  b2g: [10935879 /* Бух Гос */, 12154099 /* Бух Бератер */],
  b2b: [10631243 /* Бух Комм */, 13209983 /* Мед Комм */],
};

// Known name-drift aliases between analytics.communications.manager (integrator)
// and master_managers.name (our SoT). Surfaced in tool payloads so the agent
// can fold them when reasoning about results.
const NAME_DRIFT_ALIASES: ReadonlyArray<{ analytics: string; canonical: string }> = [
  { analytics: "Maksim Alekperov", canonical: "Максим Алекперов" },
  // Latin-C / Ukrainian-Є cases known but exact spellings live in
  // src/lib/daily/name-aliases.ts; agent can request the canonical lookup
  // via managers.find_by_name on the analytics-side spelling if needed.
];

function pipelineIdList(dept: "b2g" | "b2b"): import("drizzle-orm").SQL<unknown> {
  const ids = PIPELINE_IDS_BY_DEPT[dept];
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
}

export function registerLookerDomain(server: McpServer): void {
  // ─── looker.all_calls ──────────────────────────────────────────────────────
  registerTool(server, {
    name: "looker.all_calls",
    description: `Per-manager сводка звонков за период: total/outbound/incoming, success% (≥10s), messages, total_duration. Аналог Looker tab "All Calls" но без alias-fold (имена менеджеров — как в analytics.communications.manager). Berlin civil-day boundaries. Limit 200 managers.`,
    inputShape: {
      dept: Dept,
      from: ISODate,
      to: ISODate,
    },
    policy: {},
    deptArg: ({ dept }) => dept,
    handler: async ({ dept, from, to }) => {
      const range = berlinDayBoundaryHalfOpen(from, to);
      const pipes = pipelineIdList(dept);
      const result = await analytics.execute(sql`
        WITH cohort AS (
          SELECT lead_id, manager
          FROM analytics.leads_cohort
          WHERE pipeline_id IN (${pipes})
            AND created_at >= ${range.fromExpr}
            AND created_at <  ${range.toExclusiveExpr}
        )
        SELECT
          c.manager,
          COUNT(*) FILTER (WHERE comm.communication_type LIKE 'call%')::int AS total_calls,
          COUNT(*) FILTER (WHERE comm.communication_type = 'call_out')::int AS outgoing_calls,
          COUNT(*) FILTER (WHERE comm.communication_type = 'call_in')::int AS incoming_calls,
          COUNT(*) FILTER (WHERE comm.communication_type LIKE '%message%')::int AS messages,
          COUNT(*) FILTER (WHERE comm.duration >= 10 AND comm.communication_type LIKE 'call%')::int AS success_calls,
          ROUND(100.0 * COUNT(*) FILTER (WHERE comm.duration >= 10 AND comm.communication_type LIKE 'call%')
            / NULLIF(COUNT(*) FILTER (WHERE comm.communication_type LIKE 'call%'), 0), 0)::int AS success_pct,
          COALESCE(SUM(comm.duration) FILTER (WHERE comm.communication_type LIKE 'call%'), 0)::int AS total_duration_sec
        FROM cohort c
        LEFT JOIN analytics.communications comm ON comm.lead_id = c.lead_id
        GROUP BY c.manager
        ORDER BY total_calls DESC NULLS LAST
        LIMIT 200
      `);
      return {
        dept,
        period: { from, to },
        rows: result.rows ?? result,
        name_drift_aliases: NAME_DRIFT_ALIASES,
      };
    },
  });

  // ─── looker.cohorts ────────────────────────────────────────────────────────
  registerTool(server, {
    name: "looker.cohorts",
    description: `Cohort-анализ за период: per-manager lead_count + outgoing_calls + success_pct + avg_calls_per_lead + avg_sla_first_call_seconds. Лид считается "своим" если он в когорте created_at∈period. Упрощённый — без integrator-snapshot SLA fallback (Phase 4). Limit 200 managers.`,
    inputShape: {
      dept: Dept,
      from: ISODate,
      to: ISODate,
    },
    policy: {},
    deptArg: ({ dept }) => dept,
    handler: async ({ dept, from, to }) => {
      const range = berlinDayBoundaryHalfOpen(from, to);
      const pipes = pipelineIdList(dept);
      const result = await analytics.execute(sql`
        WITH cohort AS (
          SELECT lead_id, manager
          FROM analytics.leads_cohort
          WHERE pipeline_id IN (${pipes})
            AND created_at >= ${range.fromExpr}
            AND created_at <  ${range.toExclusiveExpr}
        ),
        comm_agg AS (
          SELECT lead_id,
            COUNT(*) FILTER (WHERE communication_type LIKE 'call%')::int AS total_calls,
            COUNT(*) FILTER (WHERE communication_type = 'call_out')::int AS outgoing_calls,
            COUNT(*) FILTER (WHERE duration >= 10 AND communication_type LIKE 'call%')::int AS success_calls
          FROM analytics.communications
          WHERE lead_id IN (SELECT lead_id FROM cohort)
          GROUP BY lead_id
        )
        SELECT
          c.manager,
          COUNT(c.lead_id)::int AS lead_count,
          COALESCE(SUM(ca.outgoing_calls), 0)::int AS outgoing_calls,
          COALESCE(SUM(ca.total_calls), 0)::int AS total_calls,
          COALESCE(SUM(ca.success_calls), 0)::int AS success_calls,
          ROUND(100.0 * COALESCE(SUM(ca.success_calls), 0)
            / NULLIF(COALESCE(SUM(ca.total_calls), 0), 0), 0)::int AS success_pct,
          ROUND(COALESCE(SUM(ca.total_calls), 0)::numeric / NULLIF(COUNT(c.lead_id), 0), 2) AS avg_calls_per_lead,
          ROUND(AVG(s.sla_first_call_seconds) FILTER (WHERE s.first_call_out_at IS NOT NULL))::int AS avg_sla_first_call_sec,
          COUNT(*) FILTER (WHERE s.first_call_out_at IS NOT NULL)::int AS sla_lead_count
        FROM cohort c
        LEFT JOIN comm_agg ca ON ca.lead_id = c.lead_id
        LEFT JOIN analytics.sla s ON s.lead_id = c.lead_id
        GROUP BY c.manager
        ORDER BY lead_count DESC
        LIMIT 200
      `);
      return {
        dept,
        period: { from, to },
        rows: result.rows ?? result,
        name_drift_aliases: NAME_DRIFT_ALIASES,
      };
    },
  });

  // ─── looker.sla_outliers ───────────────────────────────────────────────────
  registerTool(server, {
    name: "looker.sla_outliers",
    description: `Менеджеры с avg SLA первого звонка ≥ threshold_minutes. Используй для "у кого SLA хуже 10 минут стабильно". HAVING требует минимум 5 leads-with-SLA на менеджера (otherwise single-lead outliers). Median считается с FILTER чтобы NULL не skewil. Limit 30 managers.`,
    inputShape: {
      dept: Dept,
      from: ISODate,
      to: ISODate,
      threshold_minutes: z.number().int().min(1).max(180).default(10),
      min_leads: z.number().int().min(1).max(100).default(5).describe("Минимум leads-with-SLA для попадания"),
    },
    policy: {},
    deptArg: ({ dept }) => dept,
    handler: async ({ dept, from, to, threshold_minutes, min_leads }) => {
      const range = berlinDayBoundaryHalfOpen(from, to);
      const pipes = pipelineIdList(dept);
      const thresholdSec = threshold_minutes * 60;
      const result = await analytics.execute(sql`
        WITH cohort AS (
          SELECT lead_id, manager
          FROM analytics.leads_cohort
          WHERE pipeline_id IN (${pipes})
            AND created_at >= ${range.fromExpr}
            AND created_at <  ${range.toExclusiveExpr}
        )
        SELECT
          c.manager,
          COUNT(*) FILTER (WHERE s.first_call_out_at IS NOT NULL)::int AS sla_lead_count,
          ROUND(AVG(s.sla_first_call_seconds) FILTER (WHERE s.first_call_out_at IS NOT NULL))::int AS avg_sla_sec,
          ROUND(AVG(s.sla_first_call_seconds) FILTER (WHERE s.first_call_out_at IS NOT NULL) / 60.0, 1) AS avg_sla_min,
          PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY s.sla_first_call_seconds)
            FILTER (WHERE s.first_call_out_at IS NOT NULL) AS median_sla_sec
        FROM cohort c
        LEFT JOIN analytics.sla s ON s.lead_id = c.lead_id
        GROUP BY c.manager
        HAVING ROUND(AVG(s.sla_first_call_seconds) FILTER (WHERE s.first_call_out_at IS NOT NULL))::int >= ${thresholdSec}
           AND COUNT(*) FILTER (WHERE s.first_call_out_at IS NOT NULL) >= ${min_leads}
        ORDER BY avg_sla_sec DESC
        LIMIT 30
      `);
      return {
        dept,
        period: { from, to },
        threshold_minutes,
        min_leads,
        rows: result.rows ?? result,
        name_drift_aliases: NAME_DRIFT_ALIASES,
      };
    },
  });
}
