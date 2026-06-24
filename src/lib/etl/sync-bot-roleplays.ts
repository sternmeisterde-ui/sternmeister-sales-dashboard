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

type BotUserRow = {
  id: string | number;
  kommo_lead_id: string | number | null;
  kommo_contact_id: string | number | null;
  phone_normalized: string | null;
  access_status: string | null;
  access_authorized: boolean | null;
  created_at: string | null;
  last_seen_at: string | null;
};

/**
 * Зеркалит РЕГИСТРАЦИИ пользователей бота (таблица `users`) в
 * `analytics.bot_users`. Нужно, чтобы отличать «в боте, но 0 тренировок» от
 * «вообще не в боте» (сессии этого не дают — у не-тренировавшегося их просто нет).
 * Full sync, идемпотентно по user_id. Авто-skip без BERATER_BOT_DATABASE_URL.
 */
export async function syncBotUsers(): Promise<number> {
  const bot = getBeraterBotDb();
  if (!bot) {
    console.log("[ETL] sync-bot-users: skipped (BERATER_BOT_DATABASE_URL not set)");
    return 0;
  }

  const rows = unwrapRows<BotUserRow>(
    await bot.execute(sql`
      SELECT id, kommo_lead_id, kommo_contact_id, phone_normalized,
             access_status, access_authorized, created_at, last_seen_at
      FROM users
    `),
  );
  if (rows.length === 0) {
    console.log("[ETL] sync-bot-users: 0 users");
    return 0;
  }

  let upserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    upserted += await upsertUserChunk(rows.slice(i, i + CHUNK));
  }
  console.log(`[ETL] sync-bot-users: upserted ${upserted} users`);
  return upserted;
}

async function upsertUserChunk(rows: BotUserRow[]): Promise<number> {
  const posInt = (v: string | number | null): number | null => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  const values = rows.map(
    (r) =>
      sql`(${String(r.id)}, ${posInt(r.kommo_lead_id)}, ${posInt(r.kommo_contact_id)}, ${r.phone_normalized}, ${r.access_status}, ${r.access_authorized}, ${r.created_at == null ? null : String(r.created_at)}, ${r.last_seen_at == null ? null : String(r.last_seen_at)})`,
  );
  await analyticsDb.execute(sql`
    INSERT INTO analytics.bot_users
      (user_id, kommo_lead_id, kommo_contact_id, phone_normalized, access_status, access_authorized, created_at, last_seen_at)
    VALUES ${sql.join(values, sql`, `)}
    ON CONFLICT (user_id) DO UPDATE SET
      kommo_lead_id     = EXCLUDED.kommo_lead_id,
      kommo_contact_id  = EXCLUDED.kommo_contact_id,
      phone_normalized  = EXCLUDED.phone_normalized,
      access_status     = EXCLUDED.access_status,
      access_authorized = EXCLUDED.access_authorized,
      created_at        = EXCLUDED.created_at,
      last_seen_at      = EXCLUDED.last_seen_at,
      synced_at         = NOW()
  `);
  return rows.length;
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
