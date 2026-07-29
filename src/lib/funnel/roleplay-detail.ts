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
  selbstpraesentation: "Рассказ о себе",
  fachkenntnis: "Знание курса",
  argumentation: "Аргументация",
  einwandbehandlung: "Работа с возражениями",
  ablehnungsszenario: "Сценарий отказа",
  sprachkompetenz: "Немецкая речь",
};

/**
 * Продуктовые названия тем вопросов бератера. В зеркале лежат сырые ключи
 * (`accounting_fit`, `course_content`), которые ничего не говорят человеку —
 * подписи собраны по `question_intent` из банка вопросов ОКК
 * (src/criteria/client_roleplay/rubrics.json), а не придуманы.
 */
export const CLIENT_RP_TOPICS: Record<string, string> = {
  introduction: "Представился, кто он",
  current_situation: "Текущая ситуация",
  work_history: "Прошлый опыт работы",
  motivation: "Мотивация учиться",
  accounting_fit: "Почему бухгалтерия подходит",
  accounting_experience: "Опыт в бухгалтерии",
  course_content: "Что входит в курс",
  course_duration: "Длительность обучения",
  course_format: "Почему онлайн-формат",
  course_expectation: "Что ждёт от обучения",
  course_availability: "Сможет учиться полный день",
  funding: "Чем оплачивает обучение",
  provider_contact: "Как вышел на учебный центр",
  provider_certification: "Аккредитация учебного центра",
  computer_skills: "Владение компьютером",
  language_level: "Уровень немецкого",
  language_support: "Роль немецкого в обучении",
  personal_commitments: "Личные обстоятельства",
  job_goal: "Цель по работе после курса",
  job_market_research: "Изучал ли рынок труда",
  employment_confidence: "Насколько уверен в трудоустройстве",
  work_readiness: "Готовность выйти на работу",
  long_term_work: "Планы работать в Германии долго",
  next_step: "Следующий шаг",
  // Возражения бератера — их клиент должен отработать.
  job_guarantee: "Возражение: гарантии работы нет",
  price: "Возражение: дорого",
  cheaper_offer: "Возражение: есть дешевле",
  language_course_first: "Возражение: сначала язык",
  simpler_job: "Возражение: найди работу попроще",
  direct_work_alternative: "Возражение: иди работать сразу",
  course_difficulty: "Возражение: курс будет сложным",
  course_duration_readiness: "Возражение: восемь месяцев — долго",
};

/** Человеческая подпись темы вопроса; незнакомый ключ показываем как есть. */
export function topicLabel(topic: string): string {
  return CLIENT_RP_TOPICS[topic] ?? topic;
}

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
  // Номер попытки считаем САМИ, по времени звонка. Поле `attempt` — зеркало
  // client_evaluations.roleplay_number, а оно ненадёжно: клампится до 3,
  // ловит гонки при параллельной оценке и не пересчитывается, когда старую
  // строку переоценили. В базе действительно есть сделки с двумя «попытками 1»
  // (проверено 29.07), и в карточке это выглядело бы ошибкой.
  const seen: Record<string, number> = { dc: 0, aa: 0 };
  return rows.map((r) => {
    const side = r.side === "aa" ? "aa" : "dc";
    // Нумеруем только состоявшиеся ролевки — как это делает ОКК.
    const ordinal = r.conducted === true ? (seen[side] += 1) : null;
    return {
    okkCallId: r.okkCallId,
    side,
    attempt: ordinal,
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
    };
  });
}
