/**
 * Данные бота ролевок (репо berater_bot, Neon) для Воронки: сколько тренировок
 * клиент прошёл с ботом, какого уровня, какая последняя самооценка готовности.
 * Связь — `users.kommo_lead_id` = наш lead_id (сделка Бератера).
 *
 * ОПЦИОНАЛЬНО: без BERATER_BOT_DATABASE_URL читатель — graceful no-op (пустая
 * Map), скоринг/UI просто не получают бот-данных. См. src/lib/db/berater-bot.ts.
 *
 * NB: difficulty в данных разнородный — и `level_1/level_2`, и немецкие
 * `leicht/mittel/schwer`, и NULL. Нормализуем: leicht→1, mittel/schwer→2.
 */
import { sql } from "drizzle-orm";
import { getBeraterBotDb } from "@/lib/db/berater-bot";
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

export async function getBotRoleplaysForLeads(
  leadIds: number[],
): Promise<Map<number, BotRoleplaySummary>> {
  const out = new Map<number, BotRoleplaySummary>();
  const db = getBeraterBotDb();
  if (!db) return out; // BERATER_BOT_DATABASE_URL не задан — обогащение выключено
  const ids = Array.from(
    new Set(leadIds.map(Number).filter((n) => Number.isInteger(n) && n > 0)),
  );
  if (ids.length === 0) return out;

  try {
    const rows = unwrapRows<Record<string, unknown>>(
      await db.execute(sql`
        SELECT u.kommo_lead_id AS lead_id,
               count(*) AS cnt,
               sum(CASE WHEN lower(coalesce(s.difficulty,'')) IN ${sql.raw(LEVEL2)} THEN 2 ELSE 1 END) AS weighted,
               (array_agg(s.overall_readiness ORDER BY s.finished_at DESC))[1] AS latest_readiness,
               max(s.finished_at) AS latest_at
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.finished_at IS NOT NULL
          AND u.kommo_lead_id IN (${sql.raw(ids.join(","))})
        GROUP BY u.kommo_lead_id
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
