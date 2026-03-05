import { pgTable, serial, text, uuid, integer, timestamp, boolean, jsonb } from "drizzle-orm/pg-core";
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
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// ==================== SHARED TABLES ====================

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
  userId: uuid("user_id").notNull().references(() => d1Users.id),
  scheduleDate: text("schedule_date").notNull(),     // 'YYYY-MM-DD'
  isOnLine: boolean("is_on_line").notNull().default(true),
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

// ==================== RELATIONS ====================

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
