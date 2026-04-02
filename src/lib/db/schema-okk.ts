import {
  pgTable,
  serial,
  text,
  uuid,
  integer,
  timestamp,
  boolean,
  jsonb,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ==================== OKK SCHEMA ====================
// Used in both R2 (B2B / Коммерсы) and D2 (B2G / Госники) Neon branches.
// The table names are identical in both databases — only the connection differs.

// ─── managers ───────────────────────────────────────────────
export const okkManagers = pgTable("managers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  telegramId: text("telegram_id"),
  department: text("department"),           // 'b2g' | 'b2b'
  role: text("role"),                       // 'manager' | 'rop' | 'admin'
  line: text("line"),                       // '1' (квалификатор) | '2' (бератер)
  isActive: boolean("is_active").default(true),
  callgearEmployeeId: text("callgear_employee_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// ─── calls ──────────────────────────────────────────────────
export interface TranscriptSpeakerSegment {
  speaker: string; // e.g. "Speaker A" | "Speaker B"
  text: string;
  start: number;
  end: number;
}

export const okkCalls = pgTable("calls", {
  id: uuid("id").primaryKey().defaultRandom(),
  callgearCallId: text("callgear_call_id"),
  managerId: uuid("manager_id"),
  managerName: text("manager_name"),
  contactPhone: text("contact_phone"),
  durationSeconds: integer("duration_seconds"),
  direction: text("direction"),             // 'inbound' | 'outbound'
  recordingUrl: text("recording_url"),
  audioPath: text("audio_path"),
  transcript: text("transcript"),
  transcriptSpeakers: jsonb("transcript_speakers").$type<TranscriptSpeakerSegment[]>(),
  kommoContactId: text("kommo_contact_id"),
  kommoLeadId: text("kommo_lead_id"),
  kommoPipelineId: text("kommo_pipeline_id"),
  kommoStatusId: text("kommo_status_id"),
  kommoStatusName: text("kommo_status_name"),
  kommoLeadUrl: text("kommo_lead_url"),
  status: text("status"),                   // 'pending' | 'evaluated' | 'error'
  errorMessage: text("error_message"),
  callCreatedAt: timestamp("call_created_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  evaluatedAt: timestamp("evaluated_at", { withTimezone: true }),
  notifiedAt: timestamp("notified_at", { withTimezone: true }),
});

// ─── evaluations ────────────────────────────────────────────

/** Single criterion inside a block */
export interface EvalCriterion {
  name: string;
  score: number;       // 0 or 1 for binary, 0 for informational
  max_score: number;   // 1 for binary, 0 for informational/tags
  feedback: string;
  quote?: string;
}

/**
 * Evaluation block — supports BOTH formats:
 *   New (OKK backend):  block_score / max_block_score / criteria[]
 *   Legacy:             score / max_score / feedback
 */
export interface EvalBlock {
  name: string;
  // New format (from OKK backend convertCriteriaArrayToBlocks)
  block_score?: number;
  max_block_score?: number;
  criteria?: EvalCriterion[];
  // Legacy format (backward-compatible)
  score?: number;
  max_score?: number;
  feedback?: string;
}

/** Helper: resolve block score regardless of format */
export function getBlockScore(b: EvalBlock): number {
  return b.block_score ?? b.score ?? 0;
}
export function getBlockMaxScore(b: EvalBlock): number {
  return b.max_block_score ?? b.max_score ?? 0;
}

export interface EvaluationJson {
  blocks: EvalBlock[];
  total_score: number;
  total_max_score: number;
  summary: string;
  client_scoring?: { urgency: number; solvency?: number; need: number; total: number };
}

export const okkEvaluations = pgTable("evaluations", {
  id: uuid("id").primaryKey().defaultRandom(),
  callId: uuid("call_id").references(() => okkCalls.id),
  managerId: uuid("manager_id"),
  promptType: text("prompt_type"),
  totalScore: integer("total_score"),       // 0–100 integer
  evaluationJson: jsonb("evaluation_json").$type<EvaluationJson>(),
  mistakes: text("mistakes"),
  recommendations: text("recommendations"),
  modelUsed: text("model_used"),
  tokensUsed: integer("tokens_used"),
  callNumber: text("call_number"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// ─── voice_feedback ─────────────────────────────────────────
export const okkVoiceFeedback = pgTable("voice_feedback", {
  id: uuid("id").primaryKey().defaultRandom(),
  callId: uuid("call_id").references(() => okkCalls.id),
  managerId: uuid("manager_id"),
  voiceFileId: text("voice_file_id"),
  transcript: text("transcript"),
  aiResponse: text("ai_response"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// ==================== RELATIONS ====================

export const okkCallsRelations = relations(okkCalls, ({ one, many }) => ({
  manager: one(okkManagers, {
    fields: [okkCalls.managerId],
    references: [okkManagers.id],
  }),
  evaluations: many(okkEvaluations),
  voiceFeedbacks: many(okkVoiceFeedback),
}));

export const okkEvaluationsRelations = relations(okkEvaluations, ({ one }) => ({
  call: one(okkCalls, {
    fields: [okkEvaluations.callId],
    references: [okkCalls.id],
  }),
}));

export const okkVoiceFeedbackRelations = relations(okkVoiceFeedback, ({ one }) => ({
  call: one(okkCalls, {
    fields: [okkVoiceFeedback.callId],
    references: [okkCalls.id],
  }),
}));

export const okkManagersRelations = relations(okkManagers, ({ many }) => ({
  calls: many(okkCalls),
}));
