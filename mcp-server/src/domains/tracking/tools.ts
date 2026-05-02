/**
 * tracking.* — раздел "Активность" дашборда. Per-manager event timeline + roll-up'ы.
 *
 * Phase 3a scope (3 tools):
 *   - tracking.workload_summary
 *   - tracking.event_breakdown
 *   - tracking.timeline
 *
 * Источник: tracking_events (отдельный Neon project). Population — Kommo events
 * cache, обновляется ETL'ом каждые ~5 мин.
 *
 * Review-driven (Phase 3a code review):
 *   - dept enum guard на point of use (tagged sql template)
 *   - types[] regex broadened + throw on invalid
 *   - timeline limit configurable + truncated flag
 *   - berlinDayBoundaryHalfOpen helper
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { tracking } from "../../db/connections.js";
import { berlinDayBoundaryHalfOpen } from "../../utils/berlin.js";
import { registerTool } from "../../registry/builder.js";

const Dept = z.enum(["b2g", "b2b"]);
const ISODate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
// Real Kommo event_type names include digits (custom_field_879824_value_changed),
// so name pattern is [a-z][a-z0-9_]*. Manager UUIDs are hex+dash.
const EVENT_TYPE_RE = /^[a-z][a-z0-9_]*$/;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function registerTrackingDomain(server: McpServer): void {
  // ─── tracking.workload_summary ─────────────────────────────────────────────
  registerTool(server, {
    name: "tracking.workload_summary",
    description: `Per-manager workload за период: total_call_min (Σ duration_sec/60 для звонков), total_events (CRM + звонки), distinct_event_types. Используй для "кто меньше всех работает" / "у кого активность упала". Limit 200 managers.`,
    inputShape: {
      dept: Dept,
      from: ISODate,
      to: ISODate,
    },
    policy: {},
    deptArg: ({ dept }) => dept,
    handler: async ({ dept, from, to }) => {
      const range = berlinDayBoundaryHalfOpen(from, to);
      const result = await tracking.execute(sql`
        SELECT
          manager_id,
          COUNT(*)::int AS total_events,
          COUNT(DISTINCT event_type)::int AS distinct_event_types,
          COUNT(*) FILTER (WHERE event_type IN ('outgoing_call','incoming_call'))::int AS calls,
          ROUND(SUM(duration_sec) FILTER (WHERE event_type IN ('outgoing_call','incoming_call')) / 60.0)::int AS total_call_min,
          MIN(created_at)::timestamptz AS first_event_at,
          MAX(created_at)::timestamptz AS last_event_at
        FROM tracking_events
        WHERE department = ${dept}
          AND created_at >= ${range.fromExpr}
          AND created_at <  ${range.toExclusiveExpr}
        GROUP BY manager_id
        ORDER BY total_events DESC
        LIMIT 200
      `);
      return {
        dept,
        period: { from, to },
        rows: result.rows ?? result,
      };
    },
  });

  // ─── tracking.event_breakdown ──────────────────────────────────────────────
  registerTool(server, {
    name: "tracking.event_breakdown",
    description: `Распределение событий по event_type за период. Optional фильтр manager_id и types[]. Throws если type содержит invalid characters (не [a-z][a-z0-9_]*). Используй для "что менеджер делает чаще всего" / "какие events происходят".`,
    inputShape: {
      dept: Dept,
      from: ISODate,
      to: ISODate,
      manager_id: z.string().optional().describe("UUID master_managers.id (как text, формат UUID)"),
      types: z.array(z.string()).optional().describe("Опциональный whitelist event_type (имена из tracking/sync.ts EVENT_TYPES)"),
    },
    policy: {},
    deptArg: ({ dept }) => dept,
    handler: async ({ dept, from, to, manager_id, types }) => {
      const range = berlinDayBoundaryHalfOpen(from, to);
      if (manager_id && !UUID_RE.test(manager_id)) {
        throw new Error(`invalid manager_id format: ${manager_id} (need UUID)`);
      }
      let validatedTypes: string[] | null = null;
      if (types && types.length > 0) {
        const invalid = types.filter((t) => !EVENT_TYPE_RE.test(t));
        if (invalid.length > 0) {
          throw new Error(
            `invalid event_type values: ${invalid.join(", ")} — must match /^[a-z][a-z0-9_]*$/`,
          );
        }
        validatedTypes = types;
      }

      // Tagged sql composition — separate fragments combined.
      const managerCond = manager_id ? sql`AND manager_id = ${manager_id}` : sql``;
      const typesCond =
        validatedTypes && validatedTypes.length > 0
          ? sql`AND event_type IN (${sql.join(
              validatedTypes.map((t) => sql`${t}`),
              sql`, `,
            )})`
          : sql``;

      const result = await tracking.execute(sql`
        SELECT
          event_type,
          COUNT(*)::int AS count,
          ROUND(AVG(duration_sec))::int AS avg_duration_sec
        FROM tracking_events
        WHERE department = ${dept}
          AND created_at >= ${range.fromExpr}
          AND created_at <  ${range.toExclusiveExpr}
          ${managerCond}
          ${typesCond}
        GROUP BY event_type
        ORDER BY count DESC
        LIMIT 50
      `);
      return {
        dept,
        period: { from, to },
        manager_id: manager_id ?? null,
        types_filter: validatedTypes,
        rows: result.rows ?? result,
      };
    },
  });

  // ─── tracking.timeline ─────────────────────────────────────────────────────
  registerTool(server, {
    name: "tracking.timeline",
    description: `Хронология событий одного менеджера за один день. Возвращает события по порядку с timestamp, type, duration_sec, entity_type, lead/contact/company id. Configurable limit (default 500, max 2000). Если результат hits limit, возвращает truncated=true.`,
    inputShape: {
      dept: Dept,
      manager_id: z.string().describe("UUID master_managers.id"),
      date: ISODate,
      limit: z.number().int().min(1).max(2000).default(500),
    },
    policy: {},
    deptArg: ({ dept }) => dept,
    handler: async ({ dept, manager_id, date, limit }) => {
      if (!UUID_RE.test(manager_id)) {
        throw new Error(`invalid manager_id format: ${manager_id} (need UUID)`);
      }
      const range = berlinDayBoundaryHalfOpen(date, date);
      const result = await tracking.execute(sql`
        SELECT
          created_at::timestamptz AS at,
          event_type,
          duration_sec,
          entity_type,
          entity_id,
          note_id
        FROM tracking_events
        WHERE department = ${dept}
          AND manager_id = ${manager_id}
          AND created_at >= ${range.fromExpr}
          AND created_at <  ${range.toExclusiveExpr}
        ORDER BY created_at ASC
        LIMIT ${limit}
      `);
      const rows = (result.rows ?? result) as unknown[];
      const truncated = Array.isArray(rows) && rows.length >= limit;
      return {
        dept,
        manager_id,
        date,
        limit,
        count: Array.isArray(rows) ? rows.length : 0,
        truncated,
        rows,
        notes: truncated
          ? `Hit limit=${limit}. Pass higher limit (max 2000) to see more events.`
          : undefined,
      };
    },
  });
}
