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

export interface BotDailyPoint {
  day: string; // YYYY-MM-DD
  total: number; // всего завершённых сессий за день
  users: number; // уникальных пользователей за день
  lvl1: number; // level_1 / leicht
  lvl2: number; // level_2 / mittel / schwer
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
    const rows = unwrapRows<{ lead_id: string | number | null; cnt: string | number }>(
      await analyticsDb.execute(sql`
        SELECT lead_id, count(*) AS cnt
        FROM analytics.bot_roleplays
        WHERE substring(finished_at from 1 for 10) = ${dayIso}
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
 * Для графика «тренировки по дням». Graceful no-op без BERATER_BOT_DATABASE_URL.
 */
export async function getBotDailyStats(fromIso: string, toIso: string): Promise<BotDailyPoint[]> {
  try {
    const rows = unwrapRows<{ day: string; total: string | number; users: string | number; lvl1: string | number; lvl2: string | number }>(
      await analyticsDb.execute(sql`
        SELECT substring(finished_at from 1 for 10) AS day,
               count(*) AS total,
               count(DISTINCT user_id) AS users,
               count(*) FILTER (WHERE lower(coalesce(difficulty,'')) IN ${sql.raw(LEVEL1)}) AS lvl1,
               count(*) FILTER (WHERE lower(coalesce(difficulty,'')) IN ${sql.raw(LEVEL2)}) AS lvl2
        FROM analytics.bot_roleplays
        WHERE finished_at >= ${fromIso}
          AND finished_at <= ${toIso + "T23:59:59"}
        GROUP BY 1 ORDER BY 1
      `),
    );
    return rows.map((r) => ({
      day: String(r.day),
      total: Number(r.total) || 0,
      users: Number(r.users) || 0,
      lvl1: Number(r.lvl1) || 0,
      lvl2: Number(r.lvl2) || 0,
    }));
  } catch (e) {
    console.error("[funnel] getBotDailyStats failed (non-fatal):", e instanceof Error ? e.message : e);
    return [];
  }
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
