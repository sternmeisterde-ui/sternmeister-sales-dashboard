// DB queries for the Daily tab — plans CRUD + manager-kommo mapping
import { eq, and, sql } from "drizzle-orm";
import { db, getDbForDepartment } from "./index";
import { d1Users, r1Users, dailyPlans, managerSchedule, dailySnapshots } from "./schema-existing";

export interface ManagerRow {
  id: string;
  name: string;
  line: string | null;
  kommoUserId: number | null;
  role: string;
}

/**
 * Get all active managers with their Kommo user IDs for a given department
 * B2G → d1_users (D1 branch), B2B → r1_users (R1 branch)
 */
export async function getManagersWithKommo(department: string = "b2g"): Promise<ManagerRow[]> {
  const usersTable = department === "b2b" ? r1Users : d1Users;
  const deptDb = getDbForDepartment(department);

  const rows = await deptDb
    .select({
      id: usersTable.id,
      name: usersTable.name,
      line: usersTable.line,
      kommoUserId: usersTable.kommoUserId,
      role: usersTable.role,
    })
    .from(usersTable)
    .where(eq(usersTable.isActive, true));

  return rows;
}

/**
 * @deprecated Use getManagersWithKommo(department) instead
 */
export async function getD1ManagersWithKommo(): Promise<ManagerRow[]> {
  return getManagersWithKommo("b2g");
}

/**
 * Get all plans for a department/period
 */
export async function getPlans(
  department: string,
  periodType: string,
  periodDate: string
): Promise<
  Array<{
    line: string;
    userId: string | null;
    metricKey: string;
    planValue: string;
  }>
> {
  const rows = await db
    .select({
      line: dailyPlans.line,
      userId: dailyPlans.userId,
      metricKey: dailyPlans.metricKey,
      planValue: dailyPlans.planValue,
    })
    .from(dailyPlans)
    .where(
      and(
        eq(dailyPlans.department, department),
        eq(dailyPlans.periodType, periodType),
        eq(dailyPlans.periodDate, periodDate)
      )
    );

  return rows;
}

/**
 * Upsert a plan value (insert or update on conflict)
 */
export async function upsertPlan(params: {
  department: string;
  line: string;
  userId: string | null;
  metricKey: string;
  planValue: string;
  periodType: string;
  periodDate: string;
}): Promise<void> {
  const { department, line, userId, metricKey, planValue, periodType, periodDate } = params;

  // Check if exists
  const existing = await db
    .select({ id: dailyPlans.id })
    .from(dailyPlans)
    .where(
      and(
        eq(dailyPlans.department, department),
        eq(dailyPlans.line, line),
        eq(dailyPlans.metricKey, metricKey),
        eq(dailyPlans.periodType, periodType),
        eq(dailyPlans.periodDate, periodDate),
        userId
          ? eq(dailyPlans.userId, userId)
          : sql`${dailyPlans.userId} IS NULL`
      )
    )
    .limit(1);

  if (existing.length > 0) {
    // Update
    await db
      .update(dailyPlans)
      .set({ planValue, updatedAt: new Date() })
      .where(eq(dailyPlans.id, existing[0].id));
  } else {
    // Insert
    await db.insert(dailyPlans).values({
      department,
      line,
      userId,
      metricKey,
      planValue,
      periodType,
      periodDate,
    });
  }
}

// ==================== SCHEDULE ====================

/**
 * Get schedule map for a specific date: userId → isOnLine.
 * Returns null if NO schedule entries exist (= show all managers).
 * Managers WITHOUT an entry are assumed ON-LINE by default.
 */
export async function getScheduleForDate(dateStr: string): Promise<Map<string, boolean> | null> {
  const rows = await db
    .select({
      userId: managerSchedule.userId,
      isOnLine: managerSchedule.isOnLine,
    })
    .from(managerSchedule)
    .where(eq(managerSchedule.scheduleDate, dateStr));

  // No schedule entries for this date → null means "no schedule defined"
  if (rows.length === 0) return null;

  const map = new Map<string, boolean>();
  for (const r of rows) {
    map.set(r.userId, r.isOnLine);
  }
  return map;
}

/**
 * Get full schedule for a date (all managers, on-line or not)
 */
export async function getFullScheduleForDate(
  dateStr: string
): Promise<Array<{ userId: string; isOnLine: boolean; scheduleValue: string | null }>> {
  const rows = await db
    .select({
      userId: managerSchedule.userId,
      isOnLine: managerSchedule.isOnLine,
      scheduleValue: managerSchedule.scheduleValue,
    })
    .from(managerSchedule)
    .where(eq(managerSchedule.scheduleDate, dateStr));

  return rows;
}

/**
 * Get schedule for an entire month: date → userId → { isOnLine, scheduleValue }
 */
export async function getScheduleForMonth(
  monthStr: string
): Promise<Array<{ userId: string; scheduleDate: string; isOnLine: boolean; scheduleValue: string | null }>> {
  const rows = await db
    .select({
      userId: managerSchedule.userId,
      scheduleDate: managerSchedule.scheduleDate,
      isOnLine: managerSchedule.isOnLine,
      scheduleValue: managerSchedule.scheduleValue,
    })
    .from(managerSchedule)
    .where(sql`${managerSchedule.scheduleDate} LIKE ${monthStr + "%"}`);

  return rows;
}

/**
 * Set schedule for a manager on a specific date
 */
export async function setSchedule(
  userId: string,
  dateStr: string,
  isOnLine: boolean,
  scheduleValue?: string | null,
): Promise<void> {
  // Check if exists
  const existing = await db
    .select({ id: managerSchedule.id })
    .from(managerSchedule)
    .where(
      and(
        eq(managerSchedule.userId, userId),
        eq(managerSchedule.scheduleDate, dateStr)
      )
    )
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(managerSchedule)
      .set({ isOnLine, scheduleValue: scheduleValue ?? null, updatedAt: new Date() })
      .where(eq(managerSchedule.id, existing[0].id));
  } else {
    await db.insert(managerSchedule).values({
      userId,
      scheduleDate: dateStr,
      isOnLine,
      scheduleValue: scheduleValue ?? null,
    });
  }
}

/**
 * Bulk set schedule: set all managers for a date at once
 */
export async function bulkSetSchedule(
  dateStr: string,
  entries: Array<{ userId: string; isOnLine: boolean }>
): Promise<void> {
  for (const entry of entries) {
    await setSchedule(entry.userId, dateStr, entry.isOnLine);
  }
}

// ==================== DAILY SNAPSHOTS ====================

/**
 * Load a stored daily snapshot from the database.
 * Returns parsed JSON or null if no snapshot exists.
 */
export async function getSnapshot(
  date: string,
  department: string,
  period: string
): Promise<unknown | null> {
  const rows = await db
    .select({ responseJson: dailySnapshots.responseJson })
    .from(dailySnapshots)
    .where(
      and(
        eq(dailySnapshots.date, date),
        eq(dailySnapshots.department, department),
        eq(dailySnapshots.period, period)
      )
    )
    .limit(1);

  if (rows.length === 0) return null;
  return JSON.parse(rows[0].responseJson);
}

/**
 * Save (upsert) a daily snapshot. Overwrites if already exists for this date/department/period.
 */
export async function saveSnapshot(
  date: string,
  department: string,
  period: string,
  data: unknown
): Promise<void> {
  const json = JSON.stringify(data);

  const existing = await db
    .select({ id: dailySnapshots.id })
    .from(dailySnapshots)
    .where(
      and(
        eq(dailySnapshots.date, date),
        eq(dailySnapshots.department, department),
        eq(dailySnapshots.period, period)
      )
    )
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(dailySnapshots)
      .set({ responseJson: json, updatedAt: new Date() })
      .where(eq(dailySnapshots.id, existing[0].id));
  } else {
    await db.insert(dailySnapshots).values({
      date,
      department,
      period,
      responseJson: json,
    });
  }
}
