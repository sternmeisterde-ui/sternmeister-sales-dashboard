/**
 * Зеркалит завершённые сессии бота ролевок (репо berater_bot, ОТДЕЛЬНЫЙ Neon) в
 * `analytics.bot_roleplays`, откуда их читает Funnel «Клиенты» (колонка/скоринг/чарты).
 *
 * Зачем: бот-Neon засыпает (scale-to-zero) и просыпается медленно → живой бот-запрос
 * в «Клиентах» падал по таймауту драйвера (catch → пусто у всех). Зеркало в быстрой
 * analytics убирает живую зависимость от спящей БД (как sync-client-roleplays для D2).
 *
 * FULL SYNC: таблица мала (сотни сессий) — читаем ВСЕ завершённые сессии и upsert'им
 * пачками. Идемпотентно по session_id (ON CONFLICT DO UPDATE), Neon HTTP-ретраи
 * безопасны (docs/etl-architecture.md). LEFT JOIN users — сессии без kommo_lead_id
 * тоже зеркалим (lead_id=NULL): они не нужны «Клиентам», но нужны дневной стате
 * (DISTINCT user_id за день).
 *
 * Авто-skip без BERATER_BOT_DATABASE_URL.
 */

import { sql } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";
import { getBeraterBotDb } from "@/lib/db/berater-bot";
import { unwrapRows } from "@/lib/funnel/compute";

type BotSessionRow = {
  session_id: string | number;
  user_id: string | number | null;
  lead_id: string | number | null;
  difficulty: string | null;
  overall_readiness: string | null;
  finished_at: string | null;
};

const CHUNK = 500;

export async function syncBotRoleplays(): Promise<number> {
  const bot = getBeraterBotDb();
  if (!bot) {
    console.log("[ETL] sync-bot-roleplays: skipped (BERATER_BOT_DATABASE_URL not set)");
    return 0;
  }

  const rows = unwrapRows<BotSessionRow>(
    await bot.execute(sql`
      SELECT s.id              AS session_id,
             s.user_id         AS user_id,
             u.kommo_lead_id   AS lead_id,
             s.difficulty      AS difficulty,
             s.overall_readiness AS overall_readiness,
             s.finished_at     AS finished_at
      FROM sessions s
      LEFT JOIN users u ON u.id = s.user_id
      WHERE s.finished_at IS NOT NULL
    `),
  );
  if (rows.length === 0) {
    console.log("[ETL] sync-bot-roleplays: 0 finished sessions");
    return 0;
  }

  let upserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    upserted += await upsertChunk(rows.slice(i, i + CHUNK));
  }
  console.log(`[ETL] sync-bot-roleplays: upserted ${upserted} sessions`);
  return upserted;
}

/** Пачечный upsert (одним INSERT … VALUES … ON CONFLICT) — быстрее, чем строка-за-строкой. */
async function upsertChunk(rows: BotSessionRow[]): Promise<number> {
  const values = rows.map((r) => {
    const lead = r.lead_id == null ? null : Number(r.lead_id);
    const leadId = Number.isInteger(lead) && (lead as number) > 0 ? lead : null;
    return sql`(${String(r.session_id)}, ${r.user_id == null ? null : String(r.user_id)}, ${leadId}, ${r.difficulty}, ${r.overall_readiness}, ${r.finished_at})`;
  });
  await analyticsDb.execute(sql`
    INSERT INTO analytics.bot_roleplays
      (session_id, user_id, lead_id, difficulty, overall_readiness, finished_at)
    VALUES ${sql.join(values, sql`, `)}
    ON CONFLICT (session_id) DO UPDATE SET
      user_id           = EXCLUDED.user_id,
      lead_id           = EXCLUDED.lead_id,
      difficulty        = EXCLUDED.difficulty,
      overall_readiness = EXCLUDED.overall_readiness,
      finished_at       = EXCLUDED.finished_at,
      synced_at         = NOW()
  `);
  return rows.length;
}
