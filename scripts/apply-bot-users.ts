// One-off applier + backfill for 0028_bot_users.
// Создаёт analytics.bot_users (CREATE TABLE IF NOT EXISTS — идемпотентно) и делает
// первый full sync регистраций из бот-Neon. Дальше поддерживает крон (sync-bot-users).
//   npx tsx scripts/apply-bot-users.ts
import { config } from "dotenv";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

config({ path: resolve(process.cwd(), ".env.local") });
// Бот-URL — из соседнего репо berater_bot/.env (в прод задаётся в Dokploy).
try {
  const env = readFileSync("C:/IDE/sternmaister/berater_bot/.env", "utf8");
  const m = env.match(/^\s*DATABASE_URL\s*=\s*(.+)$/m);
  if (m && !process.env.BERATER_BOT_DATABASE_URL) {
    process.env.BERATER_BOT_DATABASE_URL = m[1].trim().replace(/^["']|["']$/g, "");
  }
} catch {
  /* нет файла — sync просто скипнётся */
}

import { sql } from "drizzle-orm";
import { analyticsDb } from "../src/lib/db/analytics";
import { syncBotUsers } from "../src/lib/etl/sync-bot-roleplays";

async function main(): Promise<void> {
  console.log("=== 0028_bot_users: create table ===");
  await analyticsDb.execute(sql`
    CREATE TABLE IF NOT EXISTS analytics.bot_users (
      user_id           TEXT PRIMARY KEY,
      kommo_lead_id     BIGINT,
      kommo_contact_id  BIGINT,
      phone_normalized  TEXT,
      access_status     TEXT,
      access_authorized BOOLEAN,
      created_at        TEXT,
      last_seen_at      TEXT,
      synced_at         TIMESTAMP NOT NULL DEFAULT NOW()
    )`);
  await analyticsDb.execute(
    sql`CREATE INDEX IF NOT EXISTS idx_bot_users_lead ON analytics.bot_users (kommo_lead_id)`,
  );
  console.log("  table ready ✅");

  console.log("=== backfill (full sync from bot DB) ===");
  console.log("  BERATER_BOT_DATABASE_URL set:", !!process.env.BERATER_BOT_DATABASE_URL);
  const n = await syncBotUsers();
  console.log(`  upserted ${n} users`);

  const r = await analyticsDb.execute<{ rows_total: string | number; with_lead: string | number }>(sql`
    SELECT count(*) AS rows_total,
           count(*) FILTER (WHERE kommo_lead_id IS NOT NULL) AS with_lead
    FROM analytics.bot_users`);
  console.log("  analytics.bot_users:", r.rows[0]);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("fatal:", e);
    process.exit(1);
  });
