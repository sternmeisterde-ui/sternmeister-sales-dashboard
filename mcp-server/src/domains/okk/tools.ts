/**
 * okk.* — 6 tools для query OKK-баз (D2/R2). Реальные оценённые звонки +
 * audit-метаданные + coverage heatmap.
 *
 * Orphan-фильтр всегда: total_score IS NOT NULL AND manager_id IS NOT NULL.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { and, asc, desc, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { z } from "zod";

import { okkForDept, okkSchema } from "../../db/connections.js";
import { registerTool } from "../../registry/builder.js";
import { berlinDayBoundaryHalfOpen } from "../../utils/berlin.js";

const { okkCalls, okkEvaluations, okkManagers, okkPhantomHistory } = okkSchema;

const Dept = z.enum(["b2g", "b2b"]);
const Line = z.enum(["all", "1", "2", "3"]).default("all");
const ISODate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export function registerOkkDomain(server: McpServer): void {
  // ─── okk.summarise_quality ─────────────────────────────────────────────────
  registerTool(server, {
    name: "okk.summarise_quality",
    description: `Сводка качества OKK-оценок за период: avg total_score, распределение по линиям (B2G), top/bottom 5 менеджеров, % calls_with_critical_mistakes. Используй для «как качество звонков на этой неделе» / «у кого средний балл упал». Учитывает orphan-фильтр (total_score IS NOT NULL AND manager_id IS NOT NULL). ROP с line!=NULL включается как линейный.`,
    inputShape: {
      dept: Dept,
      from: ISODate.describe("Начало периода (Europe/Berlin civil-day)"),
      to: ISODate.describe("Конец периода (включительно)"),
      line: Line.describe("B2G линия фильтр. Игнорируется для B2B."),
      manager_id: z.string().uuid().optional().describe("Опциональный фильтр на одного менеджера."),
    },
    policy: {},
    deptArg: ({ dept }) => dept,
    handler: async ({ dept, from, to, line, manager_id }) => {
      const db = okkForDept(dept);
      const range = berlinDayBoundaryHalfOpen(from, to);

      const conds = [
        isNotNull(okkEvaluations.totalScore),
        isNotNull(okkCalls.managerId),
        isNotNull(okkCalls.callCreatedAt),
        gte(okkCalls.callCreatedAt, range.fromExpr),
        lt(okkCalls.callCreatedAt, range.toExclusiveExpr),
      ];
      if (manager_id) conds.push(eq(okkCalls.managerId, manager_id));
      if (dept === "b2g" && line !== "all") {
        conds.push(eq(okkManagers.line, line));
      }

      const summary = await db
        .select({
          calls_total: sql<number>`COUNT(*)::int`,
          avg_score: sql<number>`AVG(${okkEvaluations.totalScore})::numeric(5,2)`,
          min_score: sql<number>`MIN(${okkEvaluations.totalScore})::int`,
          max_score: sql<number>`MAX(${okkEvaluations.totalScore})::int`,
        })
        .from(okkCalls)
        .innerJoin(okkEvaluations, eq(okkEvaluations.callId, okkCalls.id))
        .leftJoin(okkManagers, eq(okkManagers.id, okkCalls.managerId))
        .where(and(...conds));

      const perManager = await db
        .select({
          manager_id: okkCalls.managerId,
          manager_name: okkManagers.name,
          line: okkManagers.line,
          calls: sql<number>`COUNT(*)::int`,
          avg_score: sql<number>`AVG(${okkEvaluations.totalScore})::numeric(5,2)`,
        })
        .from(okkCalls)
        .innerJoin(okkEvaluations, eq(okkEvaluations.callId, okkCalls.id))
        .leftJoin(okkManagers, eq(okkManagers.id, okkCalls.managerId))
        .where(and(...conds))
        .groupBy(okkCalls.managerId, okkManagers.name, okkManagers.line)
        .orderBy(desc(sql`AVG(${okkEvaluations.totalScore})`));

      const top5 = perManager.slice(0, 5);
      const bottom5 = perManager.slice(-5).reverse();

      return {
        dept,
        period: { from, to, line, manager_id: manager_id ?? null },
        summary: summary[0] ?? null,
        top5,
        bottom5,
        per_manager_count: perManager.length,
      };
    },
  });

  // ─── okk.get_call ──────────────────────────────────────────────────────────
  registerTool(server, {
    name: "okk.get_call",
    description: `Детали одного звонка: транскрипт, evaluation_json (blocks/criteria/scores/summary/client_scoring), override_metadata. БЕЗ аудио (бинарь) и БЕЗ contact_phone (PII). Используй после okk.find_calls для drill-down.`,
    inputShape: {
      dept: Dept,
      call_id: z.string().uuid(),
    },
    policy: {},
    deptArg: ({ dept }) => dept,
    handler: async ({ dept, call_id }) => {
      const db = okkForDept(dept);
      const rows = await db
        .select({
          id: okkCalls.id,
          manager_id: okkCalls.managerId,
          manager_name: okkCalls.managerName,
          duration_seconds: okkCalls.durationSeconds,
          direction: okkCalls.direction,
          status: okkCalls.status,
          call_created_at: okkCalls.callCreatedAt,
          kommo_lead_id: okkCalls.kommoLeadId,
          kommo_lead_url: okkCalls.kommoLeadUrl,
          kommo_status_name: okkCalls.kommoStatusName,
          transcript: okkCalls.transcript,
          transcript_speakers: okkCalls.transcriptSpeakers,
          eval_id: okkEvaluations.id,
          prompt_type: okkEvaluations.promptType,
          total_score: okkEvaluations.totalScore,
          evaluation_json: okkEvaluations.evaluationJson,
          mistakes: okkEvaluations.mistakes,
          recommendations: okkEvaluations.recommendations,
          model_used: okkEvaluations.modelUsed,
          call_number: okkEvaluations.callNumber,
          override_metadata: okkEvaluations.overrideMetadata,
        })
        .from(okkCalls)
        .leftJoin(okkEvaluations, eq(okkEvaluations.callId, okkCalls.id))
        .where(eq(okkCalls.id, call_id))
        .limit(1);
      if (rows.length === 0) return { error: `Call not found: ${call_id} in ${dept}` };
      return rows[0];
    },
  });

  // ─── okk.find_calls ────────────────────────────────────────────────────────
  registerTool(server, {
    name: "okk.find_calls",
    description: `Список оценённых звонков с фильтрами. Limit 200. Используй для «покажи Машины звонки за апрель» / «найди звонки <60 баллов на 2-й линии». Применяет orphan-фильтр.`,
    inputShape: {
      dept: Dept,
      from: ISODate,
      to: ISODate,
      manager_id: z.string().uuid().optional(),
      score_min: z.number().int().min(0).max(100).optional(),
      score_max: z.number().int().min(0).max(100).optional(),
      line: Line,
      limit: z.number().int().min(1).max(200).default(50),
    },
    policy: {},
    deptArg: ({ dept }) => dept,
    handler: async ({ dept, from, to, manager_id, score_min, score_max, line, limit }) => {
      const db = okkForDept(dept);
      const range = berlinDayBoundaryHalfOpen(from, to);
      const conds = [
        isNotNull(okkEvaluations.totalScore),
        isNotNull(okkCalls.managerId),
        isNotNull(okkCalls.callCreatedAt),
        gte(okkCalls.callCreatedAt, range.fromExpr),
        lt(okkCalls.callCreatedAt, range.toExclusiveExpr),
      ];
      if (manager_id) conds.push(eq(okkCalls.managerId, manager_id));
      if (typeof score_min === "number") conds.push(gte(okkEvaluations.totalScore, score_min));
      if (typeof score_max === "number") conds.push(sql`${okkEvaluations.totalScore} <= ${score_max}`);
      if (dept === "b2g" && line !== "all") conds.push(eq(okkManagers.line, line));

      const rows = await db
        .select({
          id: okkCalls.id,
          manager_name: okkManagers.name,
          line: okkManagers.line,
          duration_seconds: okkCalls.durationSeconds,
          direction: okkCalls.direction,
          call_created_at: okkCalls.callCreatedAt,
          total_score: okkEvaluations.totalScore,
          call_number: okkEvaluations.callNumber,
          kommo_lead_url: okkCalls.kommoLeadUrl,
        })
        .from(okkCalls)
        .innerJoin(okkEvaluations, eq(okkEvaluations.callId, okkCalls.id))
        .leftJoin(okkManagers, eq(okkManagers.id, okkCalls.managerId))
        .where(and(...conds))
        .orderBy(desc(okkCalls.callCreatedAt))
        .limit(limit);

      return {
        dept,
        period: { from, to },
        filters: { manager_id, score_min, score_max, line },
        count: rows.length,
        rows,
      };
    },
  });

  // ─── okk.top_problems ──────────────────────────────────────────────────────
  registerTool(server, {
    name: "okk.top_problems",
    description: `Топ повторяющихся mistakes (текстовое поле в evaluations). Phase 1 — простой rank по distinct mistake-text count. Phase 5 (RAG) — семантическая кластеризация.`,
    inputShape: {
      dept: Dept,
      from: ISODate,
      to: ISODate,
      limit: z.number().int().min(1).max(50).default(10),
    },
    policy: {},
    deptArg: ({ dept }) => dept,
    handler: async ({ dept, from, to, limit }) => {
      const db = okkForDept(dept);
      const range = berlinDayBoundaryHalfOpen(from, to);
      const rows = await db
        .select({
          mistakes: okkEvaluations.mistakes,
          count: sql<number>`COUNT(*)::int`,
        })
        .from(okkCalls)
        .innerJoin(okkEvaluations, eq(okkEvaluations.callId, okkCalls.id))
        .where(
          and(
            isNotNull(okkEvaluations.mistakes),
            isNotNull(okkCalls.managerId),
            isNotNull(okkCalls.callCreatedAt),
            gte(okkCalls.callCreatedAt, range.fromExpr),
            lt(okkCalls.callCreatedAt, range.toExclusiveExpr),
          ),
        )
        .groupBy(okkEvaluations.mistakes)
        .orderBy(desc(sql`COUNT(*)`))
        .limit(limit);

      return {
        dept,
        period: { from, to },
        note: "Phase 1: rank по точному совпадению текста mistakes. Phase 5 даст семантическую группировку.",
        rows,
      };
    },
  });

  // ─── okk.audit_overrides ───────────────────────────────────────────────────
  registerTool(server, {
    name: "okk.audit_overrides",
    description: `Aggregations по override_metadata (Phase 2 audit signal): сколько звонков получили rule-overrides, breakdown по call_type / followup_signal_source / overrides_applied. Используй для «сколько follow-up распознано в апреле?» / «какие правила чаще всего меняют score?».`,
    inputShape: {
      dept: Dept,
      from: ISODate,
      to: ISODate,
    },
    policy: {},
    deptArg: ({ dept }) => dept,
    handler: async ({ dept, from, to }) => {
      const db = okkForDept(dept);
      const range = berlinDayBoundaryHalfOpen(from, to);
      const rows = await db
        .select({
          override_metadata: okkEvaluations.overrideMetadata,
        })
        .from(okkCalls)
        .innerJoin(okkEvaluations, eq(okkEvaluations.callId, okkCalls.id))
        .where(
          and(
            isNotNull(okkEvaluations.overrideMetadata),
            isNotNull(okkCalls.managerId),
            isNotNull(okkCalls.callCreatedAt),
            gte(okkCalls.callCreatedAt, range.fromExpr),
            lt(okkCalls.callCreatedAt, range.toExclusiveExpr),
          ),
        )
        .limit(5000);

      // Aggregate JSONB in code (simpler than SQL gymnastics for Phase 1).
      const stats = {
        total_with_metadata: rows.length,
        followup_count: 0,
        signal_sources: {} as Record<string, number>,
        call_types: {} as Record<string, number>,
        rules_applied: {} as Record<string, number>,
        score_changed: 0,
      };
      for (const r of rows) {
        const m = r.override_metadata;
        if (!m) continue;
        if (m.is_followup) stats.followup_count++;
        const src = String(m.followup_signal_source ?? "null");
        stats.signal_sources[src] = (stats.signal_sources[src] ?? 0) + 1;
        const ct = String(m.call_type ?? "unknown");
        stats.call_types[ct] = (stats.call_types[ct] ?? 0) + 1;
        for (const ruleId of m.overrides_applied ?? []) {
          const k = String(ruleId);
          stats.rules_applied[k] = (stats.rules_applied[k] ?? 0) + 1;
        }
        if (
          m.score_before_override !== null &&
          m.score_before_override !== m.score_after_override
        ) {
          stats.score_changed++;
        }
      }
      return { dept, period: { from, to }, ...stats };
    },
  });

  // ─── okk.coverage_heatmap ──────────────────────────────────────────────────
  registerTool(server, {
    name: "okk.coverage_heatmap",
    description: `Per-manager-per-day coverage_pct из phantom_history: какой % CDR-звонков менеджера попал в OKK calls (= был оценён). Используй для «у кого мало оценок вчера?».`,
    inputShape: {
      dept: Dept,
      from: ISODate,
      to: ISODate,
    },
    policy: {},
    deptArg: ({ dept }) => dept,
    handler: async ({ dept, from, to }) => {
      const db = okkForDept(dept);
      const rows = await db
        .select({
          manager_id: okkPhantomHistory.managerId,
          manager_name: okkPhantomHistory.managerName,
          date: okkPhantomHistory.date,
          phantom_count: okkPhantomHistory.phantomCount,
          okk_count: okkPhantomHistory.okkCount,
          coverage_pct: okkPhantomHistory.coveragePct,
        })
        .from(okkPhantomHistory)
        .where(
          and(
            eq(okkPhantomHistory.department, dept),
            sql`${okkPhantomHistory.date} >= ${from}`,
            sql`${okkPhantomHistory.date} <= ${to}`,
          ),
        )
        .orderBy(asc(okkPhantomHistory.managerName), asc(okkPhantomHistory.date))
        .limit(2000);

      return { dept, period: { from, to }, count: rows.length, rows };
    },
  });
}
