import { pgTable, text, serial, integer, timestamp, boolean, pgEnum, json } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// Enum для типов отделов
export const departmentTypeEnum = pgEnum('department_type', ['b2g', 'b2b']);

// Таблица: Отделы (Departments)
export const departments = pgTable("departments", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(), // "Госники" или "Коммерсы"
  type: departmentTypeEnum("type").notNull(), // 'b2g' или 'b2b'
  description: text("description"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Таблица: Пользователи / Менеджеры (Users)
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  avatarUrl: text("avatar_url"),
  departmentId: integer("department_id").references(() => departments.id),
  role: text("role").default("manager"), // "manager", "supervisor", "admin"
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Таблица: AI Ролевые Звонки (для тренировки менеджеров)
export const aiRoleCalls = pgTable("ai_role_calls", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id).notNull(),
  departmentId: integer("department_id").references(() => departments.id).notNull(),

  // Информация о звонке
  callDuration: integer("call_duration").notNull(), // В секундах
  callDate: timestamp("call_date").notNull(),

  // Ссылки и медиа
  audioUrl: text("audio_url"),

  // AI Анализ
  transcript: text("transcript"),
  aiSummary: text("ai_summary"),
  aiFeedback: text("ai_feedback"),
  aiScore: integer("ai_score"), // Общий скоринг 0-100

  // Детальный скоринг по блокам (JSON с 12 блоками)
  scoringBlocks: json("scoring_blocks").$type<Array<{
    id: string;
    name: string;
    score: number;
    maxScore: number;
    feedback: string;
  }>>(),

  // Метаданные
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});


// Relations
export const departmentsRelations = relations(departments, ({ many }) => ({
  users: many(users),
  aiRoleCalls: many(aiRoleCalls),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  department: one(departments, {
    fields: [users.departmentId],
    references: [departments.id],
  }),
  aiRoleCalls: many(aiRoleCalls),
}));

export const aiRoleCallsRelations = relations(aiRoleCalls, ({ one }) => ({
  user: one(users, {
    fields: [aiRoleCalls.userId],
    references: [users.id],
  }),
  department: one(departments, {
    fields: [aiRoleCalls.departmentId],
    references: [departments.id],
  }),
}));
