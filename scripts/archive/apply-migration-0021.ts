// One-off applier for 0021_lead_close_reason_changes.sql.
// Idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS.
//   npx tsx scripts/apply-migration-0021.ts
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
  console.log("=== Applying 0021_lead_close_reason_changes ===");

  const t0 = Date.now();
  await analyticsDb.execute(sql`
    CREATE TABLE IF NOT EXISTS analytics.lead_close_reason_changes (
      event_id        TEXT PRIMARY KEY,
      lead_id         BIGINT NOT NULL,
      event_at        TIMESTAMP NOT NULL,
      enum_id_before  BIGINT,
      enum_id_after   BIGINT,
      created_by      BIGINT,
      synced_at       TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await analyticsDb.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_lcrc_lead_event
      ON analytics.lead_close_reason_changes (lead_id, event_at)
  `);
  await analyticsDb.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_lcrc_event_at
      ON analytics.lead_close_reason_changes (event_at)
  `);
  console.log(`  done ${Date.now() - t0}ms`);

  const ok = await tableExists("lead_close_reason_changes");
  console.log(
    ok
      ? "Table analytics.lead_close_reason_changes present ✅"
      : "Table lead_close_reason_changes MISSING ❌",
  );

  console.log(
    "\n⚠ Таблица пуста. Заполнить — `npx tsx scripts/backfill-close-reason-changes.ts`",
  );
  console.log(
    "   (тянет history с Kommo /api/v4/events за указанный период, 1 req/sec).",
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("fatal:", e);
    process.exit(1);
  });
