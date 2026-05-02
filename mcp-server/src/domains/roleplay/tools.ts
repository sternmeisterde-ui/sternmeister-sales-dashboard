/**
 * roleplay.* — раздел "AI Ролевки" дашборда. Тренировочные звонки менеджеров
 * с AI-аватарами клиентов. Источники: D1.d1_calls (B2G) / R1.r1_calls (B2B).
 *
 * Phase 3c scope (4 tools):
 *   - roleplay.summarise — avg score / count / per-manager top/bottom
 *   - roleplay.find_calls — list по фильтрам
 *   - roleplay.compare_to_okk — gap analysis OKK vs roleplay для одного менеджера
 *   - roleplay.training_gaps — устойчиво проседающие критерии (Phase 4 deepen)
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
import { berlinDayBoundaryHalfOpen } from "../../utils/berlin.js";
import { registerTool } from "../../registry/builder.js";

const { d1Calls, d1Users, r1Calls, r1Users, masterManagers } = dashSchema;
const { okkCalls, okkEvaluations } = okkSchema;

const Dept = z.enum(["b2g", "b2b"]);
const ISODate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export function registerRoleplayDomain(server: McpServer): void {
  // ─── roleplay.summarise ────────────────────────────────────────────────────
  registerTool(server, {
    name: "roleplay.summarise",
    description: `Сводка ролевок отдела за период: total_calls, avg_score, top/bottom 5 менеджеров. Фильтр isNotNull(score) — незавершённые ролевки исключаются.`,
    inputShape: {
      dept: Dept,
      from: ISODate,
      to: ISODate,
    },
    policy: {},
    deptArg: ({ dept }) => dept,
    handler: async ({ dept, from, to }) => {
      const isB2G = dept === "b2g";
      const calls = isB2G ? d1Calls : r1Calls;
      const users = isB2G ? d1Users : r1Users;
      const db = roleplayForDept(dept);
      const range = berlinDayBoundaryHalfOpen(from, to);
      const conds = [
        isNotNull(calls.score),
        gte(calls.startedAt, range.fromExpr),
        lt(calls.startedAt, range.toExclusiveExpr),
      ];
      const summary = await db
        .select({
          calls_total: sql<number>`COUNT(*)::int`,
          avg_score: sql<number>`AVG(${calls.score})::numeric(5,2)`,
          min_score: sql<number>`MIN(${calls.score})::int`,
          max_score: sql<number>`MAX(${calls.score})::int`,
        })
        .from(calls)
        .where(and(...conds));

      const perManager = await db
        .select({
          user_id: calls.userId,
          manager_name: users.name,
          calls: sql<number>`COUNT(*)::int`,
          avg_score: sql<number>`AVG(${calls.score})::numeric(5,2)`,
        })
        .from(calls)
        .innerJoin(users, eq(users.id, calls.userId))
        .where(and(...conds))
        .groupBy(calls.userId, users.name)
        .orderBy(desc(sql`AVG(${calls.score})`));

      return {
        dept,
        period: { from, to },
        summary: summary[0] ?? null,
        top5: perManager.slice(0, 5),
        bottom5: perManager.slice(-5).reverse(),
        per_manager_count: perManager.length,
      };
    },
  });

  // ─── roleplay.find_calls ───────────────────────────────────────────────────
  registerTool(server, {
    name: "roleplay.find_calls",
    description: `Список ролевок с фильтрами: dept, период, score range, telegram_id (опц), call_type (опц). Limit 100. Используй для "Машины ролевки за апрель" / "ролевки <50 баллов".`,
    inputShape: {
      dept: Dept,
      from: ISODate,
      to: ISODate,
      telegram_id: z.string().optional().describe("Опционально — для одного менеджера"),
      score_min: z.number().int().min(0).max(100).optional(),
      score_max: z.number().int().min(0).max(100).optional(),
      call_type: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(20),
    },
    policy: {},
    deptArg: ({ dept }) => dept,
    handler: async ({ dept, from, to, telegram_id, score_min, score_max, call_type, limit }) => {
      const isB2G = dept === "b2g";
      const calls = isB2G ? d1Calls : r1Calls;
      const users = isB2G ? d1Users : r1Users;
      const db = roleplayForDept(dept);
      const range = berlinDayBoundaryHalfOpen(from, to);
      const conds = [
        isNotNull(calls.score),
        gte(calls.startedAt, range.fromExpr),
        lt(calls.startedAt, range.toExclusiveExpr),
      ];
      if (telegram_id) conds.push(eq(users.telegramId, telegram_id));
      if (typeof score_min === "number") conds.push(gte(calls.score, score_min));
      if (typeof score_max === "number") conds.push(sql`${calls.score} <= ${score_max}`);
      if (call_type) conds.push(eq(calls.callType, call_type));

      const rows = await db
        .select({
          id: calls.id,
          manager_name: users.name,
          telegram_id: users.telegramId,
          started_at: calls.startedAt,
          duration_seconds: calls.durationSeconds,
          score: calls.score,
          call_type: calls.callType,
          recommendations: calls.recommendations,
        })
        .from(calls)
        .innerJoin(users, eq(users.id, calls.userId))
        .where(and(...conds))
        .orderBy(desc(calls.startedAt))
        .limit(limit);

      return {
        dept,
        period: { from, to },
        filters: { telegram_id, score_min, score_max, call_type },
        count: rows.length,
        rows,
      };
    },
  });

  // ─── roleplay.compare_to_okk ───────────────────────────────────────────────
  registerTool(server, {
    name: "roleplay.compare_to_okk",
    description: `Gap analysis: avg ролевочного score vs avg OKK total_score для одного менеджера за период. Принимает master_managers.id (uuid). OKK score за тот же период через master_managers→ окк managers по name.`,
    inputShape: {
      master_id: z.string().uuid().describe("master_managers.id (D1)"),
      from: ISODate,
      to: ISODate,
    },
    policy: {},
    handler: async ({ master_id, from, to }) => {
      // 1) Resolve master_manager → dept + name + telegram_id
      const { d1 } = await import("../../db/connections.js");
      const profile = await d1
        .select({
          id: masterManagers.id,
          name: masterManagers.name,
          department: masterManagers.department,
          telegram_id: masterManagers.telegramId,
        })
        .from(masterManagers)
        .where(eq(masterManagers.id, master_id))
        .limit(1);
      if (profile.length === 0) return { error: `manager not found: ${master_id}` };
      const m = profile[0]!;
      const dept = m.department as "b2g" | "b2b";

      // 2) Roleplay average via telegram_id link
      const isB2G = dept === "b2g";
      const calls = isB2G ? d1Calls : r1Calls;
      const users = isB2G ? d1Users : r1Users;
      const rdb = roleplayForDept(dept);
      const range = berlinDayBoundaryHalfOpen(from, to);

      const roleplayAgg = m.telegram_id
        ? await rdb
            .select({
              calls: sql<number>`COUNT(*)::int`,
              avg_score: sql<number>`AVG(${calls.score})::numeric(5,2)`,
            })
            .from(calls)
            .innerJoin(users, eq(users.id, calls.userId))
            .where(
              and(
                eq(users.telegramId, m.telegram_id),
                isNotNull(calls.score),
                gte(calls.startedAt, range.fromExpr),
                lt(calls.startedAt, range.toExclusiveExpr),
              ),
            )
        : [{ calls: 0, avg_score: null }];

      // 3) OKK average via name match (master_managers.id = okk.managers.id by sync)
      const okk = okkForDept(dept);
      const okkAgg = await okk
        .select({
          calls: sql<number>`COUNT(*)::int`,
          avg_score: sql<number>`AVG(${okkEvaluations.totalScore})::numeric(5,2)`,
        })
        .from(okkCalls)
        .innerJoin(okkEvaluations, eq(okkEvaluations.callId, okkCalls.id))
        .where(
          and(
            isNotNull(okkEvaluations.totalScore),
            eq(okkCalls.managerId, master_id),
            isNotNull(okkCalls.callCreatedAt),
            gte(okkCalls.callCreatedAt, range.fromExpr),
            lt(okkCalls.callCreatedAt, range.toExclusiveExpr),
          ),
        );

      const rp = roleplayAgg[0] ?? { calls: 0, avg_score: null };
      const ok = okkAgg[0] ?? { calls: 0, avg_score: null };
      const gap =
        rp.avg_score !== null && ok.avg_score !== null
          ? Number(ok.avg_score) - Number(rp.avg_score)
          : null;

      return {
        manager: { master_id, name: m.name, dept, telegram_id: m.telegram_id },
        period: { from, to },
        roleplay: rp,
        okk: ok,
        gap_okk_minus_roleplay: gap,
        notes: gap === null
          ? "Сравнение невозможно: не хватает данных в одной из систем."
          : gap > 5
            ? "OKK существенно выше — возможно ролевки слишком жёсткие или менеджер на real-калах работает лучше."
            : gap < -5
              ? "Ролевки выше OKK — менеджер хорошо учится но в реальных звонках хуже применяет."
              : "Score-ы сопоставимы.",
      };
    },
  });

  // ─── roleplay.training_gaps ────────────────────────────────────────────────
  registerTool(server, {
    name: "roleplay.training_gaps",
    description: `Phase 3c MVP: возвращает менеджеров с avg ролевочного score < threshold за период. Phase 4 расширит на per-criterion drift через jsonb_path_query на evaluation_json.blocks[].criteria[].`,
    inputShape: {
      dept: Dept,
      from: ISODate,
      to: ISODate,
      threshold: z.number().int().min(0).max(100).default(70),
    },
    policy: {},
    deptArg: ({ dept }) => dept,
    handler: async ({ dept, from, to, threshold }) => {
      const isB2G = dept === "b2g";
      const calls = isB2G ? d1Calls : r1Calls;
      const users = isB2G ? d1Users : r1Users;
      const db = roleplayForDept(dept);
      const range = berlinDayBoundaryHalfOpen(from, to);
      const rows = await db
        .select({
          user_id: calls.userId,
          manager_name: users.name,
          calls: sql<number>`COUNT(*)::int`,
          avg_score: sql<number>`AVG(${calls.score})::numeric(5,2)`,
        })
        .from(calls)
        .innerJoin(users, eq(users.id, calls.userId))
        .where(
          and(
            isNotNull(calls.score),
            gte(calls.startedAt, range.fromExpr),
            lt(calls.startedAt, range.toExclusiveExpr),
          ),
        )
        .groupBy(calls.userId, users.name)
        .having(sql`AVG(${calls.score}) < ${threshold} AND COUNT(*) >= 3`)
        .orderBy(sql`AVG(${calls.score}) ASC`);
      return {
        dept,
        period: { from, to },
        threshold,
        rows,
        notes: "Phase 3c: только overall avg score. Phase 4 даст per-criterion breakdown через evaluation_json.",
      };
    },
  });
}
