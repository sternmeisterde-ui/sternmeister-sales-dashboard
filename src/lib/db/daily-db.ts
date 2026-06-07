// Dedicated DB connection for the "daily" Neon project (active managers, schedules)
import "@/lib/db/neon-setup";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

let _dailyDb: ReturnType<typeof drizzle> | null = null;

export function getDailyDb() {
  if (!_dailyDb) {
    // Env-only — no hardcoded fallback. Fail loud if the var is missing
    // (must be whitelisted in docker-compose app env + set in Dokploy).
    const url = process.env.DAILY_DATABASE_URL;
    if (!url) throw new Error("DAILY_DATABASE_URL is not set");
    _dailyDb = drizzle(neon(url));
  }
  return _dailyDb;
}

// Schema
export const dailyActiveManagers = pgTable("daily_active_managers", {
  id: serial("id").primaryKey(),
  date: text("date").notNull(),
  department: text("department").notNull().default("b2g"),
  managerId: text("manager_id").notNull(),
  managerName: text("manager_name").notNull(),
  line: text("line"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});
