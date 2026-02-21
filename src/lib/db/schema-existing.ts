import { pgTable, text, uuid, integer, timestamp, boolean, jsonb } from "drizzle-orm/pg-core";
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
  line: integer("line"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const d1Avatars = pgTable("d1_avatars", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  prompt: text("prompt"),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const d1Calls = pgTable("d1_calls", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => d1Users.id),
  avatarId: integer("avatar_id").notNull().references(() => d1Avatars.id),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  durationSeconds: integer("duration_seconds"),
  transcript: text("transcript"),
  generatedPrompt: text("generated_prompt"),
  evaluationJson: jsonb("evaluation_json").$type<{
    criteria: Array<{
      name: string;
      score: number;
      feedback: string;
    }>;
  }>(),
  score: integer("score"), // 1-10
  mistakes: text("mistakes"),
  recommendations: text("recommendations"),
  grokSessionId: text("grok_session_id"),
  livekitRoomId: text("livekit_room_id"),
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
  line: integer("line"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const r1Avatars = pgTable("r1_avatars", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  prompt: text("prompt"),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const r1Calls = pgTable("r1_calls", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => r1Users.id),
  avatarId: integer("avatar_id").notNull().references(() => r1Avatars.id),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  durationSeconds: integer("duration_seconds"),
  transcript: text("transcript"),
  generatedPrompt: text("generated_prompt"),
  evaluationJson: jsonb("evaluation_json").$type<{
    criteria: Array<{
      name: string;
      score: number;
      feedback: string;
    }>;
  }>(),
  score: integer("score"), // 1-10
  mistakes: text("mistakes"),
  recommendations: text("recommendations"),
  grokSessionId: text("grok_session_id"),
  livekitRoomId: text("livekit_room_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
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
