// One-off applier for 0018_funnel_target_levels.sql.
// Creates analytics.funnel_target_levels for the Funnel Dashboard's per-conversion
// benchmark storage. Idempotent — safe to re-run.
//
//   npx tsx scripts/apply-migration-0018.ts
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { analyticsDb } from "../src/lib/db/analytics";

async function tableExists(tableName: string): Promise<boolean> {
  const r = await analyticsDb.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'analytics'
        AND table_name = ${tableName}
    ) AS exists
  `);
  return Boolean(r.rows[0]?.exists);
}

async function main(): Promise<void> {
  console.log("=== Applying 0018_funnel_target_levels ===");

  console.log("Step 1: CREATE TABLE analytics.funnel_target_levels ...");
  const t0 = Date.now();
  await analyticsDb.execute(sql`
    CREATE TABLE IF NOT EXISTS analytics.funnel_target_levels (
      conversion_id   TEXT PRIMARY KEY,
      conversion_pct  NUMERIC(5, 2),
      updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_by      TEXT
    )
  `);
  console.log(`  done ${Date.now() - t0}ms`);

  const ok = await tableExists("funnel_target_levels");
  console.log(
    ok
      ? "Table analytics.funnel_target_levels present ✅"
      : "Table funnel_target_levels MISSING ❌",
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("fatal:", e);
    process.exit(1);
  });
