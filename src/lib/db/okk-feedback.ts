// Голосовые «Разборы ОС» (работа над ошибками) по реальным звонкам ОКК (D2, b2g).
// Паритет с AI Ролевками (d1_voice_feedback): бейдж-вердикт в списке + вкладка в
// карточке. Вердикт берём из worst_calls.response_adequate; при его отсутствии —
// из факта наличия записи в voice_feedback (→ «Есть», adequate=null).
//
// Батч (без N+1): по списку call_id — как feedbackByCall в queries-existing.ts.

import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getOkkDbForDepartment } from "@/lib/db/okk";
import {
  okkVoiceFeedback,
  okkWorstCalls,
  okkFeedbackTasks,
  okkFeedbackMessages,
  type OkkFeedbackReviewItem,
  type OkkFeedbackTargetCriterion,
} from "@/lib/db/schema-okk";

type OkkDb = ReturnType<typeof getOkkDbForDepartment>;

/** LIGHT-вердикт разбора для одной карточки списка. adequate: true/false — из
 *  worst_calls.response_adequate; null — разбор есть, но не оценён («Есть»).
 *
 *  С 2026-07-28 приоритетный источник — feedback_tasks: там видно не только
 *  «записал / не записал», но и что задача поставлена и сколько напоминаний
 *  ушло. Старые поля остаются для звонков до перехода. */
export interface OkkVoiceVerdict {
  adequate: boolean | null;
  /** Статус задачи на разбор, если она заводилась. */
  taskStatus?: "pending" | "done" | "cancelled";
  remindersSent?: number;
  /** Сколько целевых пунктов разобрано из скольких (после оценки разбора). */
  reviewCovered?: number | null;
  reviewTarget?: number | null;
}

/** Задача на разбор для карточки звонка: что просили разобрать, что отправляли,
 *  как оценён разбор. */
export interface OkkFeedbackTaskDetail {
  status: "pending" | "done" | "cancelled";
  score: number;
  targetCriteria: OkkFeedbackTargetCriterion[];
  remindersSent: number;
  firstSentAt: string | null;
  lastSentAt: string | null;
  escalatedAt: string | null;
  closedAt: string | null;
  cancelReason: string | null;
  review: OkkFeedbackReviewItem[] | null;
  reviewSummary: string | null;
  reviewCovered: number | null;
  reviewTarget: number | null;
  messages: Array<{
    kind: string;
    text: string;
    sentAt: string | null;
    delivered: boolean;
    error: string | null;
  }>;
}

/** Полный разбор для карточки звонка (вкладка «Разбор ОС»). */
export interface OkkVoiceDetail {
  adequate: boolean | null;
  transcript: string;
  aiResponse: string;
  voiceFileId: string | null;
  durationSeconds: number | null; // в D2-таблице длительности нет → всегда null
  createdAt: string | null;
}

/**
 * Вердикт разбора по списку call_id (для колонки-бейджа списка ОКК).
 * Возвращает Map только для звонков, у которых есть разбор ИЛИ строка worst_calls
 * с вердиктом; отсутствие ключа = «—» (менеджер не записывал).
 */
export async function getOkkVoiceVerdicts(
  db: OkkDb,
  callIds: string[],
): Promise<Map<string, OkkVoiceVerdict>> {
  const out = new Map<string, OkkVoiceVerdict>();
  if (callIds.length === 0) return out;

  const [worstRows, feedbackRows] = await Promise.all([
    db
      .select({
        callId: okkWorstCalls.callId,
        responseAdequate: okkWorstCalls.responseAdequate,
      })
      .from(okkWorstCalls)
      .where(inArray(okkWorstCalls.callId, callIds))
      .orderBy(desc(okkWorstCalls.createdAt)),
    db
      .select({ callId: okkVoiceFeedback.callId })
      .from(okkVoiceFeedback)
      .where(inArray(okkVoiceFeedback.callId, callIds)),
  ]);

  // Вердикт = самый свежий ОЦЕНЁННЫЙ worst_calls (response_adequate не null).
  // Строки DESC по createdAt; берём первый non-null, чтобы новая «ожидающая»
  // (null) строка того же звонка не маскировала уже выставленный вердикт.
  const verdictByCall = new Map<string, boolean>();
  for (const r of worstRows) {
    if (r.callId && r.responseAdequate != null && !verdictByCall.has(r.callId)) {
      verdictByCall.set(r.callId, r.responseAdequate);
    }
  }
  const hasFeedback = new Set<string>();
  for (const r of feedbackRows) if (r.callId) hasFeedback.add(r.callId);

  // Задачи на разбор — приоритетный источник: показывают и «ждём разбора», и
  // сколько напоминаний ушло, чего worst_calls не умела.
  const taskRows = await db
    .select({
      callId: okkFeedbackTasks.callId,
      status: okkFeedbackTasks.status,
      remindersSent: okkFeedbackTasks.remindersSent,
      reviewCovered: okkFeedbackTasks.reviewCovered,
      reviewTarget: okkFeedbackTasks.reviewTarget,
    })
    .from(okkFeedbackTasks)
    .where(inArray(okkFeedbackTasks.callId, callIds));

  for (const id of callIds) {
    const v = verdictByCall.get(id);
    if (v === true || v === false) out.set(id, { adequate: v });
    else if (hasFeedback.has(id)) out.set(id, { adequate: null }); // «Есть»
    // иначе — ключ не ставим (в списке будет «—»)
  }

  for (const t of taskRows) {
    if (!t.callId || t.status === "cancelled") continue;
    const prev = out.get(t.callId);
    out.set(t.callId, {
      adequate: prev?.adequate ?? null,
      taskStatus: t.status as "pending" | "done",
      remindersSent: t.remindersSent ?? 0,
      reviewCovered: t.reviewCovered,
      reviewTarget: t.reviewTarget,
    });
  }
  return out;
}

/** Задача на разбор по звонку (для карточки). null = задача не заводилась. */
export async function getOkkFeedbackTask(
  db: OkkDb,
  callId: string,
): Promise<OkkFeedbackTaskDetail | null> {
  const [task] = await db
    .select()
    .from(okkFeedbackTasks)
    .where(eq(okkFeedbackTasks.callId, callId))
    .limit(1);
  if (!task) return null;

  const messages = await db
    .select({
      kind: okkFeedbackMessages.kind,
      text: okkFeedbackMessages.text,
      sentAt: okkFeedbackMessages.sentAt,
      error: okkFeedbackMessages.error,
    })
    .from(okkFeedbackMessages)
    .where(eq(okkFeedbackMessages.taskId, task.id))
    .orderBy(asc(okkFeedbackMessages.sentAt));

  return {
    status: task.status as "pending" | "done" | "cancelled",
    score: task.score,
    targetCriteria: task.targetCriteria ?? [],
    remindersSent: task.remindersSent ?? 0,
    firstSentAt: task.firstSentAt?.toISOString() ?? null,
    lastSentAt: task.lastSentAt?.toISOString() ?? null,
    escalatedAt: task.escalatedAt?.toISOString() ?? null,
    closedAt: task.closedAt?.toISOString() ?? null,
    cancelReason: task.cancelReason ?? null,
    review: task.reviewJson ?? null,
    reviewSummary: task.reviewSummary ?? null,
    reviewCovered: task.reviewCovered,
    reviewTarget: task.reviewTarget,
    messages: messages.map((m) => ({
      kind: m.kind,
      text: m.text,
      sentAt: m.sentAt?.toISOString() ?? null,
      delivered: !m.error,
      error: m.error,
    })),
  };
}

/**
 * Полный разбор одного звонка (вкладка карточки). Берём самый свежий разбор из
 * voice_feedback + вердикт из worst_calls. null = разбора нет вовсе.
 */
export async function getOkkVoiceDetail(
  db: OkkDb,
  callId: string,
): Promise<OkkVoiceDetail | null> {
  const [fbRows, worstRows] = await Promise.all([
    db
      .select({
        transcript: okkVoiceFeedback.transcript,
        aiResponse: okkVoiceFeedback.aiResponse,
        voiceFileId: okkVoiceFeedback.voiceFileId,
        createdAt: okkVoiceFeedback.createdAt,
      })
      .from(okkVoiceFeedback)
      .where(eq(okkVoiceFeedback.callId, callId))
      .orderBy(desc(okkVoiceFeedback.createdAt))
      .limit(1),
    db
      .select({ responseAdequate: okkWorstCalls.responseAdequate })
      .from(okkWorstCalls)
      .where(eq(okkWorstCalls.callId, callId))
      // Оценённые строки (response_adequate не null) — раньше, потом свежие,
      // чтобы вердикт не терялся из-за более новой «ожидающей» строки.
      .orderBy(sql`${okkWorstCalls.responseAdequate} IS NOT NULL DESC`, desc(okkWorstCalls.createdAt))
      .limit(1),
  ]);

  const verdict = worstRows[0]?.responseAdequate;
  const fb = fbRows[0];
  // Разбора нет вовсе (ни записи, ни вердикта) → null.
  if (!fb && verdict !== true && verdict !== false) return null;

  return {
    adequate: verdict === true || verdict === false ? verdict : null,
    transcript: fb?.transcript || "",
    aiResponse: fb?.aiResponse || "",
    voiceFileId: fb?.voiceFileId ?? null,
    durationSeconds: null,
    createdAt: fb?.createdAt ? new Date(fb.createdAt).toISOString() : null,
  };
}
