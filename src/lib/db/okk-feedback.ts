// Голосовые «Разборы ОС» (работа над ошибками) по реальным звонкам ОКК (D2, b2g).
// Паритет с AI Ролевками (d1_voice_feedback): бейдж-вердикт в списке + вкладка в
// карточке. Вердикт берём из worst_calls.response_adequate; при его отсутствии —
// из факта наличия записи в voice_feedback (→ «Есть», adequate=null).
//
// Батч (без N+1): по списку call_id — как feedbackByCall в queries-existing.ts.

import { desc, eq, inArray, sql } from "drizzle-orm";
import { getOkkDbForDepartment } from "@/lib/db/okk";
import { okkVoiceFeedback, okkWorstCalls } from "@/lib/db/schema-okk";

type OkkDb = ReturnType<typeof getOkkDbForDepartment>;

/** LIGHT-вердикт разбора для одной карточки списка. adequate: true/false — из
 *  worst_calls.response_adequate; null — разбор есть, но не оценён («Есть»). */
export interface OkkVoiceVerdict {
  adequate: boolean | null;
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

  for (const id of callIds) {
    const v = verdictByCall.get(id);
    if (v === true || v === false) out.set(id, { adequate: v });
    else if (hasFeedback.has(id)) out.set(id, { adequate: null }); // «Есть»
    // иначе — ключ не ставим (в списке будет «—»)
  }
  return out;
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
