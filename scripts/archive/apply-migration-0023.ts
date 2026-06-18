// One-off applier for 0023_client_roleplays.sql.
// Idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS.
//   npx tsx scripts/apply-migration-0023.ts
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { analyticsDb } from "../src/lib/db/analytics";

async function tableExists(tableName: string): Promise<boolean> {
  const r = await analyticsDb.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'analytics' AND table_name = ${tableName}
    ) AS exists
  `);
  return Boolean(r.rows[0]?.exists);
}

async function main(): Promise<void> {
  console.log("=== Applying 0023_client_roleplays ===");

  const t0 = Date.now();
  await analyticsDb.execute(sql`
    CREATE TABLE IF NOT EXISTS analytics.client_roleplays (
      okk_call_id      UUID PRIMARY KEY,
      lead_id          BIGINT,
      side             TEXT NOT NULL,
      attempt          INTEGER,
      roleplay_at      TIMESTAMP,
      score_5          INTEGER,
      score_percent    INTEGER,
      criterion_scores JSONB,
      model_used       TEXT,
      gate_reason      TEXT,
      synced_at        TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await analyticsDb.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_client_roleplays_lead_side
      ON analytics.client_roleplays (lead_id, side)
  `);
  await analyticsDb.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_client_roleplays_roleplay_at
      ON analytics.client_roleplays (roleplay_at)
  `);
  console.log(`  done ${Date.now() - t0}ms`);

  const ok = await tableExists("client_roleplays");
  console.log(
    ok
      ? "Table analytics.client_roleplays present ✅"
      : "Table client_roleplays MISSING ❌",
  );

  console.log(
    "\n⚠ Таблица пуста. Заполнить — `npx tsx scripts/backfill-client-roleplays.ts`",
  );
  console.log(
    "   (тянет существующие оценки из D2 client_evaluations, roleplay_present=true).",
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("fatal:", e);
    process.exit(1);
  });
