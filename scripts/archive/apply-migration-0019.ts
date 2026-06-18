// One-off applier for 0019_leads_cohort_language_level.sql.
// Adds language_level TEXT column to analytics.leads_cohort for the Funnel
// Dashboard's language-level breakdown. Idempotent — safe to re-run.
//
//   npx tsx scripts/apply-migration-0019.ts
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { analyticsDb } from "../src/lib/db/analytics";

async function columnExists(
  table: string,
  column: string,
): Promise<boolean> {
  const r = await analyticsDb.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'analytics'
        AND table_name = ${table}
        AND column_name = ${column}
    ) AS exists
  `);
  return Boolean(r.rows[0]?.exists);
}

async function main(): Promise<void> {
  console.log("=== Applying 0019_leads_cohort_language_level ===");

  const t0 = Date.now();
  await analyticsDb.execute(sql`
    ALTER TABLE analytics.leads_cohort
      ADD COLUMN IF NOT EXISTS language_level TEXT
  `);
  await analyticsDb.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_lc_language_level
      ON analytics.leads_cohort (language_level)
  `);
  console.log(`  done ${Date.now() - t0}ms`);

  const exists = await columnExists("leads_cohort", "language_level");
  console.log(
    exists
      ? "Column leads_cohort.language_level present ✅"
      : "Column language_level MISSING ❌",
  );
  console.log(
    "\n⚠ Прошлые строки имеют NULL — заполнятся при следующем sync-leads тике (cron ETL).",
  );
  console.log(
    "   Для немедленного backfill — `npx tsx scripts/backfill-analytics.ts`.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("fatal:", e);
    process.exit(1);
  });
