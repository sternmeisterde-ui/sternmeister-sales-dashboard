// Canonical schedule-status registry — single source of truth for both the
// SchedulePopup picker UI and the end-of-month payroll calculator.
//
// Each row defines:
//   • code           — single-char value stored in manager_schedule.schedule_value
//   • label          — user-facing Russian name (also re-used in payroll exports)
//   • symbol         — what gets rendered in the calendar cell
//   • payrollFactor  — multiplier applied to the manager's daily rate when this
//                      status falls on a calendar day (e.g. 1.0 = full day pay,
//                      0.5 = half day, 0.0 = unpaid day-off)
//   • countsAsOnLine — whether the day counts toward "manager is at work" stats
//                      (drives shift-window timeline + SLA clipping)
//   • paidLeave      — true means it's a paid status without actual call work
//                      (отпуск, онбординг). Useful when payroll needs to split
//                      "worked" vs "compensated" totals.
//
// Rule of thumb: never inline these multipliers anywhere else — always import
// from this file so a change here propagates to popup + payroll automatically.

export type ScheduleCode = "8" | "4" | "-" | "о" | "н" | "у";

export interface ScheduleStatusDef {
  code: ScheduleCode;
  label: string;
  symbol: string;
  colorClass: string;
  payrollFactor: number;
  countsAsOnLine: boolean;
  paidLeave: boolean;
}

export const SCHEDULE_STATUSES: ScheduleStatusDef[] = [
  { code: "8", label: "Полный день",     symbol: "☀",  colorClass: "bg-emerald-500/20 text-emerald-400", payrollFactor: 1.0, countsAsOnLine: true,  paidLeave: false },
  { code: "4", label: "Половина дня",    symbol: "◑",  colorClass: "bg-amber-500/20 text-amber-400",     payrollFactor: 0.5, countsAsOnLine: true,  paidLeave: false },
  { code: "-", label: "Выходной",        symbol: "—",  colorClass: "bg-slate-700/50 text-slate-400",     payrollFactor: 0.0, countsAsOnLine: false, paidLeave: false },
  { code: "о", label: "Отпуск",          symbol: "🌴", colorClass: "bg-blue-500/20 text-blue-400",       payrollFactor: 1.0, countsAsOnLine: false, paidLeave: true  },
  { code: "н", label: "Онбординг",       symbol: "🚀", colorClass: "bg-cyan-500/20 text-cyan-400",       payrollFactor: 1.0, countsAsOnLine: true,  paidLeave: true  },
  { code: "у", label: "День увольнения", symbol: "🔴", colorClass: "bg-rose-500/20 text-rose-400",       payrollFactor: 1.0, countsAsOnLine: true,  paidLeave: false },
];

const BY_CODE: Record<string, ScheduleStatusDef> = Object.fromEntries(
  SCHEDULE_STATUSES.map((s) => [s.code, s]),
);

export function getStatusDef(code: string | null | undefined): ScheduleStatusDef | null {
  if (!code) return null;
  return BY_CODE[code] ?? null;
}

/** Multiplier to apply to the daily rate. Unknown / null codes pay 0. */
export function payrollFactorFor(code: string | null | undefined): number {
  return getStatusDef(code)?.payrollFactor ?? 0;
}

/** True if this code means the manager is on the floor that day. */
export function isOnLineFor(code: string | null | undefined): boolean {
  return getStatusDef(code)?.countsAsOnLine ?? false;
}
