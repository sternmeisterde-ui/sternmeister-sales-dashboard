/**
 * managers.* — 5 tools для query master_managers + связанных таблиц.
 * SoT — D1.master_managers; sync targets D2/R2/D1.d1_users/R1.r1_users.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { and, desc, eq, ilike, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";

import { d1, dashSchema } from "../../db/connections.js";
import { registerTool } from "../../registry/builder.js";

const { masterManagers, managerSchedule, managerBonuses, payrollRuns } = dashSchema;

const Dept = z.enum(["b2g", "b2b"]);
const Role = z.enum(["manager", "rop", "admin"]);
const Line = z.enum(["1", "2", "3"]);

interface ManagerSummary {
  id: string;
  name: string;
  department: string;
  team: string | null;
  role: string;
  line: string | null;
  is_active: boolean | null;
  telegram_username: string | null;
  kommo_user_id: number | null;
  callgear_employee_id: string | null;
  cloudtalk_agent_id: string | null;
}

export function registerManagersDomain(server: McpServer): void {
  // ─── managers.list ─────────────────────────────────────────────────────────
  registerTool(server, {
    name: "managers.list",
    description: `Список менеджеров отдела с фильтрами. Используй когда РОП спрашивает «кто у меня на 2-й линии?» / «кто активный в b2b?». ROP с непустой line включается как линейный (project_double_status). Только активные по умолчанию.`,
    inputShape: {
      dept: Dept,
      line: Line.optional().describe("Только B2G. '1'/'2'/'3'."),
      role: Role.optional(),
      active: z.boolean().default(true).describe("Только активные (is_active=true). По умолчанию true."),
    },
    policy: {},
    deptArg: ({ dept }) => dept,
    handler: async ({ dept, line, role, active }) => {
      const conds = [eq(masterManagers.department, dept)];
      if (active) conds.push(eq(masterManagers.isActive, true));
      if (line) conds.push(eq(masterManagers.line, line));
      if (role) conds.push(eq(masterManagers.role, role));

      const rows = await d1
        .select({
          id: masterManagers.id,
          name: masterManagers.name,
          department: masterManagers.department,
          team: masterManagers.team,
          role: masterManagers.role,
          line: masterManagers.line,
          is_active: masterManagers.isActive,
          telegram_username: masterManagers.telegramUsername,
          kommo_user_id: masterManagers.kommoUserId,
          callgear_employee_id: masterManagers.callgearEmployeeId,
          cloudtalk_agent_id: masterManagers.cloudtalkAgentId,
        })
        .from(masterManagers)
        .where(and(...conds))
        .orderBy(masterManagers.line, masterManagers.name);

      return {
        dept,
        filters: { line, role, active },
        count: rows.length,
        rows: rows as ManagerSummary[],
      };
    },
  });

  // ─── managers.find_by_name ─────────────────────────────────────────────────
  registerTool(server, {
    name: "managers.find_by_name",
    description: `Поиск менеджера по имени (case-insensitive partial match). Возвращает первое совпадение + до 5 alternatives. Используй ДО других managers.* tools чтобы получить id. ВНИМАНИЕ: master_managers.name vs analytics.communications.manager имеют 3 known name-drifts (Maksim/Latin-C/Ukrainian-Є) — этот tool ищет ТОЛЬКО в master_managers.`,
    inputShape: {
      name: z.string().min(1).describe("Имя или часть имени"),
      dept: Dept.optional().describe("Опциональный фильтр отдела"),
    },
    policy: {},
    deptArg: ({ dept }) => dept,
    handler: async ({ name, dept }) => {
      const conds = [ilike(masterManagers.name, `%${name}%`)];
      if (dept) conds.push(eq(masterManagers.department, dept));

      const rows = await d1
        .select({
          id: masterManagers.id,
          name: masterManagers.name,
          department: masterManagers.department,
          line: masterManagers.line,
          role: masterManagers.role,
          is_active: masterManagers.isActive,
        })
        .from(masterManagers)
        .where(and(...conds))
        .orderBy(masterManagers.isActive, masterManagers.name)
        .limit(6);

      if (rows.length === 0) {
        return {
          query: name,
          found: false,
          message: `No managers match '${name}'${dept ? ` in dept=${dept}` : ""}.`,
        };
      }
      const [first, ...alternatives] = rows;
      return {
        query: name,
        found: true,
        match: first,
        alternatives,
      };
    },
  });

  // ─── managers.get_profile ──────────────────────────────────────────────────
  registerTool(server, {
    name: "managers.get_profile",
    description: `Полная карта менеджера: профиль + расписание текущей недели (manager_schedule) + premium на текущий месяц (manager_bonuses) + последний payroll snapshot (payroll_runs). Принимает UUID id (получить через managers.find_by_name).`,
    inputShape: {
      id: z.string().uuid().describe("UUID master_managers.id"),
    },
    policy: {},
    handler: async ({ id }) => {
      const profile = await d1
        .select()
        .from(masterManagers)
        .where(eq(masterManagers.id, id))
        .limit(1);
      if (profile.length === 0) {
        return { error: `Manager not found: ${id}` };
      }

      const today = new Date();
      const monthStr = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}`;
      const weekStart = new Date(today);
      weekStart.setUTCDate(today.getUTCDate() - 7);
      const weekStartStr = weekStart.toISOString().slice(0, 10);

      const [schedule, bonus, lastPayroll] = await Promise.all([
        d1
          .select({
            schedule_date: managerSchedule.scheduleDate,
            schedule_value: managerSchedule.scheduleValue,
            is_on_line: managerSchedule.isOnLine,
            shift_start: managerSchedule.shiftStartTime,
            shift_end: managerSchedule.shiftEndTime,
          })
          .from(managerSchedule)
          .where(
            and(
              eq(managerSchedule.userId, id),
              sql`${managerSchedule.scheduleDate} >= ${weekStartStr}`,
            ),
          )
          .orderBy(desc(managerSchedule.scheduleDate))
          .limit(14),
        d1
          .select({
            period_month: managerBonuses.periodMonth,
            amount: managerBonuses.amount,
            note: managerBonuses.note,
          })
          .from(managerBonuses)
          .where(and(eq(managerBonuses.userId, id), eq(managerBonuses.periodMonth, monthStr)))
          .limit(1),
        d1
          .select({
            period_month: payrollRuns.periodMonth,
            equiv_full_days: payrollRuns.equivFullDays,
            bonus_amount: payrollRuns.bonusAmount,
            gross_amount: payrollRuns.grossAmount,
            status_breakdown: payrollRuns.statusBreakdown,
            computed_at: payrollRuns.computedAt,
          })
          .from(payrollRuns)
          .where(eq(payrollRuns.userId, id))
          .orderBy(desc(payrollRuns.periodMonth))
          .limit(1),
      ]);

      return {
        profile: profile[0],
        recent_schedule: schedule,
        current_month_bonus: bonus[0] ?? null,
        last_payroll_snapshot: lastPayroll[0] ?? null,
      };
    },
  });

  // ─── managers.compare ──────────────────────────────────────────────────────
  registerTool(server, {
    name: "managers.compare",
    description: `Side-by-side сравнение нескольких менеджеров. Текущая версия: возвращает профили + последний payroll snapshot. Future: + OKK avg, ролевки, SLA. Используй для «сравни Машу и Петю в апреле».`,
    inputShape: {
      ids: z
        .array(z.string().uuid())
        .min(2)
        .max(10)
        .describe("UUID-ы менеджеров для сравнения (от 2 до 10)"),
    },
    policy: {},
    handler: async ({ ids }) => {
      const profiles = await d1
        .select({
          id: masterManagers.id,
          name: masterManagers.name,
          department: masterManagers.department,
          line: masterManagers.line,
          role: masterManagers.role,
          is_active: masterManagers.isActive,
          daily_rate: masterManagers.dailyRate,
        })
        .from(masterManagers)
        .where(sql`${masterManagers.id} IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);

      const payrolls = await d1
        .select({
          user_id: payrollRuns.userId,
          period_month: payrollRuns.periodMonth,
          equiv_full_days: payrollRuns.equivFullDays,
          bonus_amount: payrollRuns.bonusAmount,
          gross_amount: payrollRuns.grossAmount,
        })
        .from(payrollRuns)
        .where(sql`${payrollRuns.userId} IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`)
        .orderBy(desc(payrollRuns.periodMonth));

      // Group most recent payroll per user_id.
      const lastPayrollByUser: Record<string, (typeof payrolls)[number]> = {};
      for (const p of payrolls) {
        if (!lastPayrollByUser[p.user_id]) lastPayrollByUser[p.user_id] = p;
      }

      return {
        ids,
        rows: profiles.map((p) => ({
          ...p,
          last_payroll: lastPayrollByUser[p.id] ?? null,
        })),
        notes: [
          "Phase 1: только профиль + последний payroll. OKK/ролевки/SLA сравнение — в следующих фазах.",
        ],
      };
    },
  });

  // ─── managers.find_outliers ────────────────────────────────────────────────
  registerTool(server, {
    name: "managers.find_outliers",
    description: `Top-3 / bottom-3 менеджеров по метрике за период. Текущие метрики: 'gross_amount' (по последнему payroll snapshot за period_month). Future: 'okk_score', 'sla_first_call', 'roleplay_score'. Используй для «у кого упала зарплата в апреле?».`,
    inputShape: {
      dept: Dept,
      metric: z.enum(["gross_amount"]).describe("Метрика для ранжирования"),
      period_month: z
        .string()
        .regex(/^\d{4}-\d{2}$/)
        .describe("Месяц YYYY-MM"),
    },
    policy: {},
    deptArg: ({ dept }) => dept,
    handler: async ({ dept, metric, period_month }) => {
      // Pull all payroll snapshots for the dept × month.
      const rows = await d1
        .select({
          user_id: payrollRuns.userId,
          manager_name: payrollRuns.managerName,
          gross_amount: payrollRuns.grossAmount,
          equiv_full_days: payrollRuns.equivFullDays,
          bonus_amount: payrollRuns.bonusAmount,
        })
        .from(payrollRuns)
        .where(
          and(
            eq(payrollRuns.department, dept),
            eq(payrollRuns.periodMonth, period_month),
            isNotNull(payrollRuns.grossAmount),
          ),
        );

      if (rows.length === 0) {
        return {
          dept,
          metric,
          period_month,
          message: "No payroll snapshots for this dept × month. Кран ещё не закрыл месяц?",
        };
      }

      const sorted = [...rows].sort((a, b) => Number(b.gross_amount) - Number(a.gross_amount));
      const median = sorted[Math.floor(sorted.length / 2)];
      const top3 = sorted.slice(0, 3);
      const bottom3 = sorted.slice(-3).reverse();

      return {
        dept,
        metric,
        period_month,
        sample_size: rows.length,
        top3,
        bottom3,
        median,
      };
    },
  });
}
