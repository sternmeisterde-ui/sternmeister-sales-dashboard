// Dedicated DB connection for the "daily" Neon project (active managers, schedules)
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

const DAILY_DB_URL =
  process.env.DAILY_DATABASE_URL ||
  "postgresql://neondb_owner:npg_uvL9ZDPw3NUQ@ep-still-fog-anyl3npw-pooler.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require";

let _dailyDb: ReturnType<typeof drizzle> | null = null;

export function getDailyDb() {
  if (!_dailyDb) {
    _dailyDb = drizzle(neon(DAILY_DB_URL));
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
