/**
 * analytics.* — отчёт по AI-оценкам OKK через периоды/менеджеров.
 *
 * Phase 2b scope (3 tools):
 *   - analytics.scores_by_period(dept, source, line?, from, to, groupBy)
 *   - analytics.scores_by_manager(dept, source, period)
 *   - analytics.criterion_drift(dept, source, period, criterionName)
 *
 * source = 'okk' (D2/R2) | 'roleplay' (D1.d1_calls / R1.r1_calls).
 *
 * Phase 3 расширение: per-block / per-criterion агрегаты с reuse processBlocks
 * helper из dashboard. Phase 2b делает простое avg(total_score).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { and, desc, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { z } from "zod";

import {
  okkForDept,
  okkSchema,
  roleplayForDept,
  dashSchema,
} from "../../db/connections.js";
import { registerTool } from "../../registry/builder.js";
import { berlinDateTruncExpr, berlinDayBoundaryHalfOpen } from "../../utils/berlin.js";

const { okkCalls, okkEvaluations, okkManagers } = okkSchema;
const { d1Calls, d1Users, r1Calls, r1Users } = dashSchema;

const Dept = z.enum(["b2g", "b2b"]);
const Source = z.enum(["okk", "roleplay"]);
const Line = z.enum(["all", "1", "2", "3"]).default("all");
const ISODate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const GroupBy = z.enum(["day", "week", "month"]).default("week");

export function registerAnalyticsDomain(server: McpServer): void {
  // ─── analytics.scores_by_period ────────────────────────────────────────────
  registerTool(server, {
    name: "analytics.scores_by_period",
    description: `Avg total_score по time-buckets (day / week / month). source='okk' (реальные звонки) или 'roleplay' (AI-ролевки). Используй для "тренд качества" / "среднее за неделю".`,
    inputShape: {
      dept: Dept,
      source: Source,
      from: ISODate,
      to: ISODate,
      group_by: GroupBy,
      line: Line.describe("Только для source=okk и dept=b2g."),
    },
    policy: {},
    deptArg: ({ dept }) => dept,
    handler: async ({ dept, source, from, to, group_by, line }) => {
      const range = berlinDayBoundaryHalfOpen(from, to);
      if (source === "okk") {
        const db = okkForDept(dept);
        // Build the bucket expression once and reuse for SELECT/GROUP/ORDER —
        // ensures Postgres sees identical fragments at all positions.
        const bucket = berlinDateTruncExpr(group_by, okkCalls.callCreatedAt);
        const conds = [
          isNotNull(okkEvaluations.totalScore),
          isNotNull(okkCalls.managerId),
          isNotNull(okkCalls.callCreatedAt),
          gte(okkCalls.callCreatedAt, range.fromExpr),
          lt(okkCalls.callCreatedAt, range.toExclusiveExpr),
        ];
        if (dept === "b2g" && line !== "all") conds.push(eq(okkManagers.line, line));
        const rows = await db
          .select({
            bucket: sql<string>`(${bucket})::date::text`,
            calls: sql<number>`COUNT(*)::int`,
            avg_score: sql<number>`AVG(${okkEvaluations.totalScore})::numeric(5,2)`,
          })
          .from(okkCalls)
          .innerJoin(okkEvaluations, eq(okkEvaluations.callId, okkCalls.id))
          .leftJoin(okkManagers, eq(okkManagers.id, okkCalls.managerId))
          .where(and(...conds))
          .groupBy(bucket)
          .orderBy(bucket);
        return { dept, source, period: { from, to }, group_by, line, rows };
      }
      // roleplay path — D1 or R1 calls table.
      const isB2G = dept === "b2g";
      const callsTable = isB2G ? d1Calls : r1Calls;
      const db = roleplayForDept(dept);
      const bucket = berlinDateTruncExpr(group_by, callsTable.startedAt);
      const rows = await db
        .select({
          bucket: sql<string>`(${bucket})::date::text`,
          calls: sql<number>`COUNT(*)::int`,
          avg_score: sql<number>`AVG(${callsTable.score})::numeric(5,2)`,
        })
        .from(callsTable)
        .where(
          and(
            isNotNull(callsTable.score),
            gte(callsTable.startedAt, range.fromExpr),
            lt(callsTable.startedAt, range.toExclusiveExpr),
          ),
        )
        .groupBy(bucket)
        .orderBy(bucket);
      return { dept, source, period: { from, to }, group_by, rows };
    },
  });

  // ─── analytics.scores_by_manager ───────────────────────────────────────────
  registerTool(server, {
    name: "analytics.scores_by_manager",
    description: `Per-manager средний score за период. source='okk' или 'roleplay'. Используй для "у кого средний балл выше / ниже" / per-manager сравнения.`,
    inputShape: {
      dept: Dept,
      source: Source,
      from: ISODate,
      to: ISODate,
    },
    policy: {},
    deptArg: ({ dept }) => dept,
    handler: async ({ dept, source, from, to }) => {
      const range = berlinDayBoundaryHalfOpen(from, to);
      if (source === "okk") {
        const db = okkForDept(dept);
        const rows = await db
          .select({
            manager_id: okkCalls.managerId,
            manager_name: okkManagers.name,
            line: okkManagers.line,
            calls: sql<number>`COUNT(*)::int`,
            avg_score: sql<number>`AVG(${okkEvaluations.totalScore})::numeric(5,2)`,
            min_score: sql<number>`MIN(${okkEvaluations.totalScore})::int`,
            max_score: sql<number>`MAX(${okkEvaluations.totalScore})::int`,
          })
          .from(okkCalls)
          .innerJoin(okkEvaluations, eq(okkEvaluations.callId, okkCalls.id))
          .leftJoin(okkManagers, eq(okkManagers.id, okkCalls.managerId))
          .where(
            and(
              isNotNull(okkEvaluations.totalScore),
              isNotNull(okkCalls.managerId),
              isNotNull(okkCalls.callCreatedAt),
              gte(okkCalls.callCreatedAt, range.fromExpr),
              lt(okkCalls.callCreatedAt, range.toExclusiveExpr),
            ),
          )
          .groupBy(okkCalls.managerId, okkManagers.name, okkManagers.line)
          .orderBy(desc(sql`AVG(${okkEvaluations.totalScore})`));
        return { dept, source, period: { from, to }, count: rows.length, rows };
      }
      // roleplay — D1.d1_calls / R1.r1_calls joined to users.
      const isB2G = dept === "b2g";
      const callsTable = isB2G ? d1Calls : r1Calls;
      const usersTable = isB2G ? d1Users : r1Users;
      const db = roleplayForDept(dept);
      const rows = await db
        .select({
          user_id: callsTable.userId,
          manager_name: usersTable.name,
          calls: sql<number>`COUNT(*)::int`,
          avg_score: sql<number>`AVG(${callsTable.score})::numeric(5,2)`,
        })
        .from(callsTable)
        .innerJoin(usersTable, eq(usersTable.id, callsTable.userId))
        .where(
          and(
            isNotNull(callsTable.score),
            gte(callsTable.startedAt, range.fromExpr),
            lt(callsTable.startedAt, range.toExclusiveExpr),
          ),
        )
        .groupBy(callsTable.userId, usersTable.name)
        .orderBy(desc(sql`AVG(${callsTable.score})`));
      return { dept, source, period: { from, to }, count: rows.length, rows };
    },
  });

  // ─── analytics.criterion_drift ─────────────────────────────────────────────
  registerTool(server, {
    name: "analytics.criterion_drift",
    description: `Динамика одного criterion (имя из evaluation_json.blocks[].criteria[]) по бакетам периода. Только source='okk'. Phase 2b простой средний score за бакет; Phase 3 — с фильтром по prompt_type / линии.`,
    inputShape: {
      dept: Dept,
      from: ISODate,
      to: ISODate,
      criterion_name: z.string().min(1),
      group_by: GroupBy,
    },
    policy: {},
    deptArg: ({ dept }) => dept,
    handler: async ({ dept, from, to, criterion_name, group_by }) => {
      const db = okkForDept(dept);
      const range = berlinDayBoundaryHalfOpen(from, to);
      const bucket = berlinDateTruncExpr(group_by, okkCalls.callCreatedAt);
      // jsonb_path_query_first — extract criterion's score from evaluation_json
      // by name match anywhere in blocks[].criteria[]. criterion_name flows
      // as a bound parameter through jsonb_build_object — Drizzle parameterises.
      const rows = await db
        .select({
          bucket: sql<string>`(${bucket})::date::text`,
          calls: sql<number>`COUNT(*)::int`,
          avg_criterion_score: sql<number>`AVG(
            (jsonb_path_query_first(
               ${okkEvaluations.evaluationJson},
               '$.blocks[*].criteria[*] ? (@.name == $name)',
               jsonb_build_object('name', ${criterion_name}::text)
             )->>'score')::numeric
          )::numeric(5,2)`,
        })
        .from(okkCalls)
        .innerJoin(okkEvaluations, eq(okkEvaluations.callId, okkCalls.id))
        .where(
          and(
            isNotNull(okkCalls.managerId),
            isNotNull(okkEvaluations.evaluationJson),
            isNotNull(okkCalls.callCreatedAt),
            gte(okkCalls.callCreatedAt, range.fromExpr),
            lt(okkCalls.callCreatedAt, range.toExclusiveExpr),
          ),
        )
        .groupBy(bucket)
        .orderBy(bucket);
      return { dept, criterion_name, period: { from, to }, group_by, rows };
    },
  });
}
