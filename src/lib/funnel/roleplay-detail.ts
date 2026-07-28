/**
 * Детализация ролевок по одной сделке — для карточки в разделе «Ролевки».
 *
 * Читает `analytics.client_roleplays` (зеркало D2 client_evaluations): по
 * каждому консультационному звонку сделки — проводилась ли ролевка, балл
 * клиента, разбивка по 6 критериям и разбор по вопросам банка бератора.
 * Вынесено в отдельный запрос: `question_coverage` весит десятки КБ на звонок
 * и в списке из сотен сделок это неподъёмный payload.
 */

import { sql } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";
import { unwrapRows } from "./compute";
import { classifyNotScored, type Side, type NotScoredKind } from "./roleplays-section";

/** Русские подписи 6 критериев клиентской ролевки (OKK criteria-config.json). */
export const CLIENT_RP_CRITERIA: Record<string, string> = {
  selbstpraesentation: "Самопрезентация (о себе)",
  fachkenntnis: "Знание курса",
  argumentation: "Аргументация",
  einwandbehandlung: "Работа с возражениями",
  ablehnungsszenario: "Сценарий отказа",
  sprachkompetenz: "Немецкая речь",
};

export interface CriterionScore {
  coverage: number;
  quality: number;
  score: number;
  applicable: boolean;
  weight: number;
}

export interface QuestionResult {
  question_id: string;
  question_topic: string;
  criterion: string;
  asked: boolean;
  self_produced: boolean;
  covered: boolean;
  is_ideal: boolean;
  answer_strength: string | null;
  grammar_quality: number;
  problem_type: string | null;
  quote: string;
}

export interface RoleplayCallDetail {
  okkCallId: string;
  side: Side;
  attempt: number | null;
  at: string | null;
  managerName: string | null;
  durationSeconds: number | null;
  /** false = менеджер ролевку не проводил (звонок был, ролевки не было). */
  conducted: boolean;
  score5: number | null;
  scorePercent: number | null;
  notScored: NotScoredKind | null;
  gateReason: string | null;
  criterionScores: Record<string, CriterionScore> | null;
  questions: QuestionResult[] | null;
}

/**
 * Полная детализация ролевок сделки — для drawer'а под таблицей.
 * Отдельным запросом: question_coverage весит десятки КБ на звонок, в списке
 * из сотен сделок это неподъёмный payload.
 */
export async function getRoleplayAuditDetail(leadId: number): Promise<RoleplayCallDetail[]> {
  if (!Number.isInteger(leadId) || leadId <= 0) return [];
  const rows = unwrapRows<{
    okkCallId: string;
    side: string;
    attempt: number | null;
    at: string | null;
    managerName: string | null;
    durationSeconds: number | null;
    conducted: boolean;
    score5: number | null;
    scorePercent: number | null;
    gateReason: string | null;
    criterionScores: Record<string, CriterionScore> | null;
    questions: QuestionResult[] | null;
  }>(
    await analyticsDb.execute(sql`
      SELECT okk_call_id::text  AS "okkCallId",
             side               AS "side",
             attempt            AS "attempt",
             roleplay_at::text  AS "at",
             manager_name       AS "managerName",
             duration_seconds   AS "durationSeconds",
             manager_conducted  AS "conducted",
             score_5            AS "score5",
             score_percent      AS "scorePercent",
             gate_reason        AS "gateReason",
             criterion_scores   AS "criterionScores",
             question_coverage  AS "questions"
      FROM analytics.client_roleplays
      WHERE lead_id = ${leadId}
      ORDER BY roleplay_at NULLS LAST
    `),
  );
  return rows.map((r) => ({
    okkCallId: r.okkCallId,
    side: r.side === "aa" ? "aa" : "dc",
    attempt: r.attempt,
    at: r.at ? new Date(r.at).toISOString() : null,
    managerName: r.managerName,
    durationSeconds: r.durationSeconds,
    conducted: r.conducted === true,
    score5: r.score5,
    scorePercent: r.scorePercent,
    notScored: r.conducted && r.score5 === null ? classifyNotScored(r.gateReason) : null,
    gateReason: r.gateReason,
    criterionScores: r.criterionScores ?? null,
    questions: Array.isArray(r.questions) ? r.questions : null,
  }));
}
