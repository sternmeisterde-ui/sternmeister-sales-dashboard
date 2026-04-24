// Resolve the list of analytics-side manager names that belong to a department.
//
// Source of truth: `master_managers` (D1) filtered by `department`, `role='manager'`,
// `is_active=true`. The integrator's feed (analytics.leads_cohort.manager,
// analytics.communications.manager) uses display names that drift from the canonical
// spellings (Latin vs Cyrillic, Ukrainian Є vs Russian Е). We fold in NAME_ALIASES
// so the whitelist matches whatever spelling the integrator wrote.
//
// Used by the Looker tab API to strip out: role=rop/admin, managers of the other
// department who got attached to a lead in the wrong pipeline, and any legacy names
// (Rose, Виктор, etc.) that aren't in master_managers at all.

import { db } from "@/lib/db";
import { masterManagers, managerSchedule } from "@/lib/db/schema-existing";
import { and, between, eq, isNotNull, or } from "drizzle-orm";
import { NAME_ALIASES } from "./name-aliases";

export interface DeptManagerWhitelist {
  /** Every name the integrator might write for this dept (canonical + aliases). */
  names: string[];
  /** Alias → canonical master_managers.name, for normalising output. */
  aliasToCanonical: Map<string, string>;
  /** Canonical master name → shift start hour (0–23). Default 9 if unset. */
  shiftHourByName: Map<string, number>;
}

function parseHour(s: string | null | undefined): number | null {
  if (!s) return null;
  const h = Number(s.split(":")[0]);
  return Number.isFinite(h) ? h : null;
}

export async function getDeptManagerWhitelist(
  department: "b2g" | "b2b" | string,
): Promise<DeptManagerWhitelist> {
  const dept = department === "b2b" ? "b2b" : "b2g";
  // Double-status convention: role='rop' + line IS NOT NULL means the person
  // is also a working manager on that line (currently applies to Татьяна
  // Дерикова, b2g, line=2). They must be included in the Looker whitelist.
  const rows = await db
    .select({ name: masterManagers.name, shiftStartTime: masterManagers.shiftStartTime })
    .from(masterManagers)
    .where(
      and(
        eq(masterManagers.department, dept),
        eq(masterManagers.isActive, true),
        or(
          eq(masterManagers.role, "manager"),
          and(eq(masterManagers.role, "rop"), isNotNull(masterManagers.line)),
        ),
      ),
    );

  const names = new Set<string>();
  const aliasToCanonical = new Map<string, string>();
  const shiftHourByName = new Map<string, number>();
  for (const { name, shiftStartTime } of rows) {
    names.add(name);
    aliasToCanonical.set(name, name);
    const hour = parseHour(shiftStartTime) ?? 9;
    shiftHourByName.set(name, hour);
    const aliases = NAME_ALIASES[name];
    if (aliases) {
      for (const a of aliases) {
        names.add(a);
        aliasToCanonical.set(a, name);
      }
    }
  }
  return { names: [...names], aliasToCanonical, shiftHourByName };
}

export interface ScheduleOverride {
  /** Canonical master_managers.name of the manager on duty that date. */
  name: string;
  /** YYYY-MM-DD (Berlin calendar date). */
  date: string;
  /** Shift start hour (0–23) from manager_schedule.shift_start_time. */
  hour: number;
}

/**
 * Per-day shift-start overrides from the Daily calendar (manager_schedule)
 * for a department and a date range. Used to refine "SLA от начала смены" —
 * e.g. if Рузанна switched to a 14:00 shift on a specific day, that day's
 * SLA measures from 14:00 instead of her master default.
 *
 * `fromDate` / `toDate` must be YYYY-MM-DD strings. Rows without
 * shift_start_time are skipped (they don't override the default).
 */
export async function getDeptScheduleOverrides(
  department: "b2g" | "b2b" | string,
  fromDate: string,
  toDate: string,
): Promise<ScheduleOverride[]> {
  const dept = department === "b2b" ? "b2b" : "b2g";
  const rows = await db
    .select({
      name: masterManagers.name,
      date: managerSchedule.scheduleDate,
      shiftStartTime: managerSchedule.shiftStartTime,
    })
    .from(managerSchedule)
    .innerJoin(masterManagers, eq(managerSchedule.userId, masterManagers.id))
    .where(
      and(
        eq(masterManagers.department, dept),
        eq(masterManagers.isActive, true),
        isNotNull(managerSchedule.shiftStartTime),
        between(managerSchedule.scheduleDate, fromDate, toDate),
      ),
    );

  const out: ScheduleOverride[] = [];
  for (const r of rows) {
    const hour = parseHour(r.shiftStartTime);
    if (hour !== null) out.push({ name: r.name, date: r.date, hour });
  }
  return out;
}
