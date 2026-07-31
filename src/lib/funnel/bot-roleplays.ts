/**
 * Данные бота ролевок (репо berater_bot, Neon) для Воронки: сколько тренировок
 * клиент прошёл с ботом, какого уровня, какая последняя самооценка готовности.
 * Связь — `users.kommo_lead_id` = наш lead_id (сделка Бератера).
 *
 * ЧТЕНИЕ — из ЗЕРКАЛА `analytics.bot_roleplays` (наполняет ETL `sync-bot-roleplays`
 * из бот-Neon, см. src/lib/etl/sync-bot-roleplays.ts). НЕ ходим в бот-БД на лету:
 * она засыпает (scale-to-zero) и таймаутила запрос «Клиентов» → колонка пустела у
 * всех. Нет зеркала/данных → пустой результат (graceful).
 *
 * NB: difficulty в данных разнородный — и `level_1/level_2`, и немецкие
 * `leicht/mittel/schwer`, и NULL. Нормализуем: leicht→1, mittel/schwer→2.
 */
import { sql } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";
import { getBeraterPipelineIds } from "@/lib/kommo/pipeline-config";
import { unwrapRows } from "./compute";

export interface BotRoleplaySummary {
  /** Всего завершённых сессий бота по сделке. */
  count: number;
  /** Взвешенно: level_1/leicht=1, level_2/mittel/schwer=2 (как в berater-dashboard). */
  weightedCount: number;
  latestReadiness: string | null; // overall_readiness последней сессии
  latestAtIso: string | null;
}

const LEVEL2 = "('level_2','mittel','schwer','medium','hard')";
const LEVEL1 = "('level_1','leicht','easy')";

/** ISO-дата + N дней (UTC-арифметика по календарю, без TZ-сюрпризов). */
function shiftIsoDay(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface BotDailyPoint {
  day: string; // YYYY-MM-DD
  total: number; // всего завершённых сессий за день
  users: number; // уникальных пользователей за день
  lvl1: number; // level_1 / leicht
  lvl2: number; // level_2 / mittel / schwer
}

export interface BotTrainingSummary {
  /** Все целевые лиды периода (Бух Бератер + ДЦ/АА-термин в периоде). */
  targetLeads: number;
  /** Сколько целевых лидов тренировались хотя бы раз в выбранном периоде. */
  engagedTargetLeads: number;
  /** engagedTargetLeads / targetLeads × 100. */
  conversionPct: number | null;
}

export interface BotTrainingStats {
  points: BotDailyPoint[];
  summary: BotTrainingSummary;
}

export interface BotDayClient {
  leadId: number;
  count: number; // тренировок за этот день
}

/**
 * Кто и сколько тренировался с ботом в КОНКРЕТНЫЙ день (для drill по точке графика).
 * Возвращает [{leadId, count}] по убыванию. Имена резолвит вызывающий код
 * (analytics), т.к. бот-БД имён сделок не хранит. Graceful no-op без env.
 */
export async function getBotRoleplaysOnDay(dayIso: string): Promise<BotDayClient[]> {
  try {
    // День — БЕРЛИНСКАЯ дата (CLAUDE.md #1). finished_at — text ISO с +00:00;
    // substring давал UTC-день: вечерние тренировки (после 22:00 Berlin летом)
    // падали на соседний день и drill расходился с графиком.
    // Грубый sargable-диапазон возвращает индекс (см. getBotDailyStats).
    const rows = unwrapRows<{ lead_id: string | number | null; cnt: string | number }>(
      await analyticsDb.execute(sql`
        SELECT lead_id, count(*) AS cnt
        FROM analytics.bot_roleplays
        WHERE finished_at >= ${shiftIsoDay(dayIso, -1)}
          AND finished_at < ${shiftIsoDay(dayIso, 1)}
          AND to_char(finished_at::timestamptz AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD') = ${dayIso}
          AND lead_id IS NOT NULL
        GROUP BY lead_id
        ORDER BY cnt DESC
      `),
    );
    return rows
      .map((r) => ({ leadId: Number(r.lead_id), count: Number(r.cnt) || 0 }))
      .filter((x) => Number.isInteger(x.leadId) && x.leadId > 0);
  } catch (e) {
    console.error("[funnel] getBotRoleplaysOnDay failed (non-fatal):", e instanceof Error ? e.message : e);
    return [];
  }
}

/**
 * Дневная статистика завершённых сессий бота за окно [fromIso, toIso] (ISO-даты).
 * Для графика «тренировки по дням» + целевой пул по датам ДЦ/АА-термина.
 * Читаем только analytics-зеркало; любой сбой даёт graceful пустой результат.
 */
export async function getBotTrainingStats(fromIso: string, toIso: string): Promise<BotTrainingStats> {
  try {
    // День — БЕРЛИНСКАЯ дата (CLAUDE.md #1), не UTC-substring: иначе вечерние
    // тренировки после 22:00 Berlin (лето) уезжали на соседний день.
    // Грубый sargable-диапазон (текст ISO, ±1 день на TZ) возвращает индекс
    // idx_bot_roleplays_finished (code-review 2026-07-06: to_char по колонке
    // в WHERE давал full scan); точная берлинская граница — вторым условием.
    // Берлинский день D начинается в D−1T22:00Z (лето) → нижняя граница −1 день.
    const coarseLo = shiftIsoDay(fromIso, -1);
    const coarseHi = shiftIsoDay(toIso, 1);
    const beraterIds = getBeraterPipelineIds("buh");
    const beraterIn = sql.join(beraterIds.map((id) => sql`${id}`), sql`, `);
    const dcDate = sql`((termin_date AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date`;
    const aaDate = sql`((aa_termin_date AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date`;
    const targetLeadCte = sql`
      SELECT lead_id
      FROM analytics.leads_cohort
      WHERE pipeline_id IN (${beraterIn})
        AND is_deleted = FALSE
        AND exclude_from_analytics = FALSE
        AND status_id <> 143
        AND (language_level IS NULL OR TRIM(language_level) NOT ILIKE 'A1%')
        AND (
          (${dcDate} >= ${fromIso}::date AND ${dcDate} <= ${toIso}::date)
          OR (${aaDate} >= ${fromIso}::date AND ${aaDate} <= ${toIso}::date)
        )
    `;
    const periodSessionsCte = sql`
      SELECT
        br.*,
        to_char(br.finished_at::timestamptz AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD') AS day
      FROM analytics.bot_roleplays br
      WHERE br.finished_at >= ${coarseLo}
        AND br.finished_at < ${coarseHi}
        AND to_char(br.finished_at::timestamptz AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD') >= ${fromIso}
        AND to_char(br.finished_at::timestamptz AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD') <= ${toIso}
    `;

    const [dailyResult, summaryResult] = await Promise.all([
      analyticsDb.execute(sql`
        WITH period_sessions AS (${periodSessionsCte})
        SELECT
          ps.day,
          count(*) AS total,
          count(DISTINCT ps.user_id) AS users,
          count(*) FILTER (WHERE lower(coalesce(ps.difficulty,'')) IN ${sql.raw(LEVEL1)}) AS lvl1,
          count(*) FILTER (WHERE lower(coalesce(ps.difficulty,'')) IN ${sql.raw(LEVEL2)}) AS lvl2
        FROM period_sessions ps
        GROUP BY ps.day
        ORDER BY ps.day
      `),
      analyticsDb.execute(sql`
        WITH target_leads AS (${targetLeadCte}),
        period_sessions AS (${periodSessionsCte})
        SELECT
          count(DISTINCT tl.lead_id) AS target_leads,
          count(DISTINCT ps.lead_id) AS engaged_target_leads
        FROM target_leads tl
        LEFT JOIN period_sessions ps ON ps.lead_id = tl.lead_id
      `),
    ]);
    const rows = unwrapRows<{
      day: string;
      total: string | number;
      users: string | number;
      lvl1: string | number;
      lvl2: string | number;
    }>(dailyResult);
    const summaryRow = unwrapRows<{
      target_leads: string | number;
      engaged_target_leads: string | number;
    }>(summaryResult)[0];
    const targetLeads = Number(summaryRow?.target_leads) || 0;
    const engagedTargetLeads = Number(summaryRow?.engaged_target_leads) || 0;
    return {
      points: rows.map((r) => ({
      day: String(r.day),
      total: Number(r.total) || 0,
      users: Number(r.users) || 0,
      lvl1: Number(r.lvl1) || 0,
      lvl2: Number(r.lvl2) || 0,
      })),
      summary: {
        targetLeads,
        engagedTargetLeads,
        conversionPct: targetLeads > 0
          ? Math.round((engagedTargetLeads / targetLeads) * 1000) / 10
          : null,
      },
    };
  } catch (e) {
    console.error("[funnel] getBotTrainingStats failed (non-fatal):", e instanceof Error ? e.message : e);
    return {
      points: [],
      summary: { targetLeads: 0, engagedTargetLeads: 0, conversionPct: null },
    };
  }
}

/** Совместимый помощник для возможных серверных потребителей только дневного ряда. */
export async function getBotDailyStats(fromIso: string, toIso: string): Promise<BotDailyPoint[]> {
  return (await getBotTrainingStats(fromIso, toIso)).points;
}

/**
 * Какие из переданных лидов ЗАРЕГИСТРИРОВАНЫ в боте (есть запись в зеркале
 * `analytics.bot_users` с этим kommo_lead_id). Нужно, чтобы отличать «в боте, но
 * 0 тренировок» от «вообще не в боте». Graceful: нет таблицы/данных → пустой set.
 */
export async function getRegisteredBotLeads(leadIds: number[]): Promise<Set<number>> {
  const out = new Set<number>();
  const ids = Array.from(
    new Set(leadIds.map(Number).filter((n) => Number.isInteger(n) && n > 0)),
  );
  if (ids.length === 0) return out;
  try {
    const rows = unwrapRows<{ lead_id: string | number }>(
      await analyticsDb.execute(sql`
        SELECT DISTINCT kommo_lead_id AS lead_id
        FROM analytics.bot_users
        WHERE kommo_lead_id IN (${sql.raw(ids.join(","))})
      `),
    );
    for (const r of rows) {
      const n = Number(r.lead_id);
      if (Number.isInteger(n) && n > 0) out.add(n);
    }
  } catch (e) {
    console.error("[funnel] getRegisteredBotLeads failed (non-fatal):", e instanceof Error ? e.message : e);
  }
  return out;
}

export async function getBotRoleplaysForLeads(
  leadIds: number[],
): Promise<Map<number, BotRoleplaySummary>> {
  const out = new Map<number, BotRoleplaySummary>();
  const ids = Array.from(
    new Set(leadIds.map(Number).filter((n) => Number.isInteger(n) && n > 0)),
  );
  if (ids.length === 0) return out;

  try {
    const rows = unwrapRows<Record<string, unknown>>(
      await analyticsDb.execute(sql`
        SELECT lead_id,
               count(*) AS cnt,
               sum(CASE WHEN lower(coalesce(difficulty,'')) IN ${sql.raw(LEVEL2)} THEN 2 ELSE 1 END) AS weighted,
               (array_agg(overall_readiness ORDER BY finished_at DESC))[1] AS latest_readiness,
               max(finished_at) AS latest_at
        FROM analytics.bot_roleplays
        WHERE lead_id IN (${sql.raw(ids.join(","))})
        GROUP BY lead_id
      `),
    );
    for (const r of rows) {
      const leadId = Number(r.lead_id);
      if (!Number.isInteger(leadId)) continue;
      out.set(leadId, {
        count: Number(r.cnt) || 0,
        weightedCount: Number(r.weighted) || 0,
        latestReadiness: (r.latest_readiness as string) ?? null,
        latestAtIso: r.latest_at ? String(r.latest_at) : null,
      });
    }
  } catch (e) {
    // Бот-БД недоступна/схема иная — не валим Воронку, просто без обогащения.
    console.error("[funnel] getBotRoleplaysForLeads failed (non-fatal):", e instanceof Error ? e.message : e);
  }
  return out;
}
