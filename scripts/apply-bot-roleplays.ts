// One-off applier + backfill for 0027_bot_roleplays.
// Создаёт analytics.bot_roleplays (CREATE TABLE IF NOT EXISTS — идемпотентно) и
// делает первый полный sync из бот-Neon. Дальше поддерживает крон (sync-bot-roleplays).
//   npx tsx --no-network-family-autoselection scripts/apply-bot-roleplays.ts
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
  /* нет файла — sync просто скипнется */
}

import { sql } from "drizzle-orm";
import { analyticsDb } from "../src/lib/db/analytics";
import { syncBotRoleplays } from "../src/lib/etl/sync-bot-roleplays";

async function main(): Promise<void> {
  console.log("=== 0027_bot_roleplays: create table ===");
  await analyticsDb.execute(sql`
    CREATE TABLE IF NOT EXISTS analytics.bot_roleplays (
      session_id        TEXT PRIMARY KEY,
      user_id           TEXT,
      lead_id           BIGINT,
      difficulty        TEXT,
      overall_readiness TEXT,
      finished_at       TEXT,
      synced_at         TIMESTAMP NOT NULL DEFAULT NOW()
    )`);
  await analyticsDb.execute(
    sql`CREATE INDEX IF NOT EXISTS idx_bot_roleplays_lead ON analytics.bot_roleplays (lead_id)`,
  );
  await analyticsDb.execute(
    sql`CREATE INDEX IF NOT EXISTS idx_bot_roleplays_finished ON analytics.bot_roleplays (finished_at)`,
  );
  console.log("  table ready ✅");

  console.log("=== backfill (full sync from bot DB) ===");
  console.log("  BERATER_BOT_DATABASE_URL set:", !!process.env.BERATER_BOT_DATABASE_URL);
  const n = await syncBotRoleplays();
  console.log(`  upserted ${n} sessions`);

  const r = await analyticsDb.execute<{ rows_total: string | number; leads: string | number }>(sql`
    SELECT count(*) AS rows_total,
           count(DISTINCT lead_id) FILTER (WHERE lead_id IS NOT NULL) AS leads
    FROM analytics.bot_roleplays`);
  console.log("  analytics.bot_roleplays:", r.rows[0]);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("fatal:", e);
    process.exit(1);
  });
