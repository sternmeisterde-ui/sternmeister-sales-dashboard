import { pgTable, serial, text, uuid, integer, timestamp, boolean, jsonb, date, numeric } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ==================== D1 TABLES (Госники - B2G) ====================

export const d1Users = pgTable("d1_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  telegramId: text("telegram_id").notNull().unique(),
  name: text("name").notNull(),
  telegramUsername: text("telegram_username"),
  team: text("team").notNull(), // 'dima', 'ruzanna', 'all'
  role: text("role").notNull(), // 'manager', 'rop', 'admin'
  isActive: boolean("is_active").default(true),
  line: text("line"),
  kommoUserId: integer("kommo_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const d1Avatars = pgTable("d1_avatars", {
  id: serial("id").primaryKey(),
  data: jsonb("data").notNull(),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const d1Calls = pgTable("d1_calls", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => d1Users.id),
  avatarId: integer("avatar_id").references(() => d1Avatars.id),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  durationSeconds: integer("duration_seconds"),
  transcript: text("transcript"),
  generatedPrompt: text("generated_prompt"),
  evaluationJson: jsonb("evaluation_json").$type<{
    blocks: Array<{
      name: string;
      block_score: number;
      max_block_score: number;
      criteria: Array<{
        name: string;
        score: number;
        max_score: number;
        feedback: string;
        quote?: string;
      }>;
    }>;
    total_score: number;
    total_max_score: number;
    summary: string;
  }>(),
  score: integer("score"), // 0-100
  mistakes: text("mistakes"),
  recommendations: text("recommendations"),
  grokSessionId: text("grok_session_id"),
  livekitRoomId: text("livekit_room_id"),
  recordingPath: text("recording_path"),
  recordingExpiresAt: timestamp("recording_expires_at", { withTimezone: true }),
  callType: text("call_type"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// ==================== R1 TABLES (Коммерсы - B2B) ====================

export const r1Users = pgTable("r1_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  telegramId: text("telegram_id").notNull().unique(),
  name: text("name").notNull(),
  telegramUsername: text("telegram_username"),
  team: text("team").notNull(),
  role: text("role").notNull(),
  isActive: boolean("is_active").default(true),
  line: text("line"),
  kommoUserId: integer("kommo_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const r1Avatars = pgTable("r1_avatars", {
  id: serial("id").primaryKey(),
  data: jsonb("data").notNull(),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const r1Calls = pgTable("r1_calls", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => r1Users.id),
  avatarId: integer("avatar_id").references(() => r1Avatars.id),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  durationSeconds: integer("duration_seconds"),
  transcript: text("transcript"),
  generatedPrompt: text("generated_prompt"),
  evaluationJson: jsonb("evaluation_json").$type<{
    blocks: Array<{
      name: string;
      block_score: number;
      max_block_score: number;
      criteria: Array<{
        name: string;
        score: number;
        max_score: number;
        feedback: string;
        quote?: string;
      }>;
    }>;
    total_score: number;
    total_max_score: number;
    summary: string;
  }>(),
  score: integer("score"), // 0-100
  mistakes: text("mistakes"),
  recommendations: text("recommendations"),
  grokSessionId: text("grok_session_id"),
  livekitRoomId: text("livekit_room_id"),
  recordingPath: text("recording_path"),
  recordingExpiresAt: timestamp("recording_expires_at", { withTimezone: true }),
  callType: text("call_type"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// ==================== MASTER MANAGERS ====================

export const masterManagers = pgTable("master_managers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  telegramUsername: text("telegram_username"),
  telegramId: text("telegram_id"),
  department: text("department").notNull(),       // 'b2g' | 'b2b'
  team: text("team").notNull().default("all"),
  role: text("role").notNull().default("manager"), // 'manager' | 'rop' | 'admin'
  line: text("line"),                              // '1' | '2' | '3'
  kommoUserId: integer("kommo_user_id"),
  callgearEmployeeId: text("callgear_employee_id"),
  cloudtalkAgentId: text("cloudtalk_agent_id"),
  inOkk: boolean("in_okk").default(false),
  inRolevki: boolean("in_rolevki").default(false),
  isActive: boolean("is_active").default(true),
  shiftStartTime: text("shift_start_time"),           // "09:00", "10:00", etc. (null = default 09:00)
  shiftEndTime: text("shift_end_time"),               // "18:00", "17:00", etc. (null = default 18:00)
  // Per-day base rate used by the payroll calculator. Currency is project-wide
  // (not stored per-row); the cron multiplies this by the schedule status's
  // payrollFactor (see src/lib/daily/schedule-payroll.ts).
  dailyRate: numeric("daily_rate", { precision: 12, scale: 2 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

// ==================== SHARED TABLES ====================

// Bug / error reports submitted via the "Сообщить об ошибке" popup.
// Free-form feedback from admins/managers — also mirrored to Discord for ops.
export const bugReports = pgTable("bug_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  reporterId: uuid("reporter_id"),                    // master_managers.id snapshot (nullable on purpose: admin-only users may not have a master row)
  reporterName: text("reporter_name").notNull(),
  reporterRole: text("reporter_role").notNull(),     // 'admin' | 'rop' | 'manager'
  reporterDepartment: text("reporter_department").notNull(), // 'b2g' | 'b2b'
  section: text("section").notNull(),                // tab id from the sidebar
  description: text("description").notNull(),
  reportDate: date("report_date").notNull(),         // YYYY-MM-DD
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const dailyPlans = pgTable("daily_plans", {
  id: serial("id").primaryKey(),
  department: text("department").notNull(),          // 'b2g' | 'b2b'
  line: text("line").notNull(),                      // '1' (qualifier), '2' (second line), 'funnel'
  userId: uuid("user_id"),                           // NULL = line-level default plan
  metricKey: text("metric_key").notNull(),
  planValue: text("plan_value").notNull(),
  periodType: text("period_type").notNull(),         // 'day' | 'week' | 'month'
  periodDate: text("period_date").notNull(),         // '2026-02-28' | '2026-W09' | '2026-02'
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const managerSchedule = pgTable("manager_schedule", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => masterManagers.id),
  scheduleDate: text("schedule_date").notNull(),     // 'YYYY-MM-DD'
  isOnLine: boolean("is_on_line").notNull().default(true),
  scheduleValue: text("schedule_value"),              // "8", "-", "о", etc.
  shiftStartTime: text("shift_start_time"),           // snapshot of shift start on this date, "HH:MM"
  shiftEndTime: text("shift_end_time"),               // snapshot of shift end on this date, "HH:MM"
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

// Snapshot of one month's payroll for one manager. Cron writes these at
// month-end (or on-demand via the API). One row per (department, periodMonth,
// userId) — re-runs upsert. statusBreakdown is a {code: dayCount} JSON; the
// gross amount is recomputed from the breakdown × snapshot dailyRate so a
// later rate change doesn't silently mutate historical timesheets.
//
// bonusAmount is the manager_bonuses row at the time the snapshot ran;
// grossAmount already includes it (= equivFullDays × dailyRate + bonusAmount).
export const payrollRuns = pgTable("payroll_runs", {
  id: serial("id").primaryKey(),
  department: text("department").notNull(),                // 'b2g' | 'b2b'
  periodMonth: text("period_month").notNull(),             // 'YYYY-MM'
  userId: uuid("user_id").notNull().references(() => masterManagers.id),
  managerName: text("manager_name").notNull(),             // snapshot at run time
  dailyRate: numeric("daily_rate", { precision: 12, scale: 2 }), // snapshot at run time, may be NULL
  statusBreakdown: jsonb("status_breakdown").notNull(),    // { "8": 18, "4": 2, "о": 5, ... }
  equivFullDays: numeric("equiv_full_days", { precision: 8, scale: 2 }).notNull(), // Σ payrollFactor
  bonusAmount: numeric("bonus_amount", { precision: 12, scale: 2 }).notNull().default("0"), // manual premium snapshot
  grossAmount: numeric("gross_amount", { precision: 14, scale: 2 }).notNull(),     // equivFullDays * dailyRate + bonusAmount
  computedAt: timestamp("computed_at", { withTimezone: true }).defaultNow(),
});

// Manual monthly premium per manager. Set in the Табель popup, summed into
// the payroll calculator's gross. One row per (user_id, period_month);
// amount = 0/null clears (we delete the row to keep the table clean).
export const managerBonuses = pgTable("manager_bonuses", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => masterManagers.id),
  periodMonth: text("period_month").notNull(),             // 'YYYY-MM'
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  note: text("note"),                                       // optional "за что"
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const kommoTokens = pgTable("kommo_tokens", {
  id: serial("id").primaryKey(),
  subdomain: text("subdomain").notNull().unique(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const scripts = pgTable("scripts", {
  id: serial("id").primaryKey(),
  department: text("department").notNull(),            // 'b2g' | 'b2b'
  line: text("line").notNull(),                        // '1' | '2' | '3' | 'buh1' | 'buh2' | 'med1'
  title: text("title").notNull(),                      // e.g. 'Линия 1 — Квалификатор'
  notionUrl: text("notion_url"),
  content: jsonb("content").notNull(),                 // { sections: [{ id, title, items: [...] }] }
  version: integer("version").notNull().default(1),
  updatedBy: text("updated_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const dailySnapshots = pgTable("daily_snapshots", {
  id: serial("id").primaryKey(),
  date: text("date").notNull(),                        // 'YYYY-MM-DD'
  department: text("department").notNull(),             // 'b2g' | 'b2b'
  period: text("period").notNull().default("day"),     // 'day' | 'month'
  responseJson: text("response_json").notNull(),       // full JSON response
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

// ==================== CALL ANALYSES ====================

export const callAnalyses = pgTable("call_analyses", {
  id: uuid("id").primaryKey().defaultRandom(),
  department: text("department").notNull(),         // 'b2g' | 'b2b'
  kommoUrl: text("kommo_url").notNull(),
  mode: text("mode").notNull(),                     // 'success' | 'failure'
  status: text("status").notNull().default("pending"), // 'pending' | 'processing' | 'done' | 'error'
  progress: integer("progress").default(0),         // 0-100
  totalCalls: integer("total_calls").default(0),
  processedCalls: integer("processed_calls").default(0),
  errorMessage: text("error_message"),
  resultSummary: text("result_summary"),            // Grok summary markdown
  createdBy: text("created_by"),                    // user name
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});

export const callAnalysisFiles = pgTable("call_analysis_files", {
  id: uuid("id").primaryKey().defaultRandom(),
  analysisId: uuid("analysis_id").notNull().references(() => callAnalyses.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  content: text("content").notNull(),               // markdown content
  fileType: text("file_type").notNull(),            // 'transcript' | 'summary' | 'index'
  leadId: text("lead_id"),
  callScore: integer("call_score"),                 // Grok-assigned relevance score
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// ==================== RELATIONS ====================

export const callAnalysesRelations = relations(callAnalyses, ({ many }) => ({
  files: many(callAnalysisFiles),
}));

export const callAnalysisFilesRelations = relations(callAnalysisFiles, ({ one }) => ({
  analysis: one(callAnalyses, {
    fields: [callAnalysisFiles.analysisId],
    references: [callAnalyses.id],
  }),
}));

export const d1UsersRelations = relations(d1Users, ({ many }) => ({
  calls: many(d1Calls),
}));

export const d1CallsRelations = relations(d1Calls, ({ one }) => ({
  user: one(d1Users, {
    fields: [d1Calls.userId],
    references: [d1Users.id],
  }),
  avatar: one(d1Avatars, {
    fields: [d1Calls.avatarId],
    references: [d1Avatars.id],
  }),
}));

export const r1UsersRelations = relations(r1Users, ({ many }) => ({
  calls: many(r1Calls),
}));

export const r1CallsRelations = relations(r1Calls, ({ one }) => ({
  user: one(r1Users, {
    fields: [r1Calls.userId],
    references: [r1Users.id],
  }),
  avatar: one(r1Avatars, {
    fields: [r1Calls.avatarId],
    references: [r1Avatars.id],
  }),
}));
