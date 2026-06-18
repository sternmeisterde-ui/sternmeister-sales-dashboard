// One-off applier for 0022_leads_cohort_is_deleted.sql.
//   npx tsx scripts/apply-migration-0022.ts
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { analyticsDb } from "../src/lib/db/analytics";

async function columnExists(table: string, column: string): Promise<boolean> {
  const r = await analyticsDb.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'analytics' AND table_name = ${table} AND column_name = ${column}
    ) AS exists
  `);
  return Boolean(r.rows[0]?.exists);
}

async function main(): Promise<void> {
  console.log("=== Applying 0022_leads_cohort_is_deleted ===");
  const t0 = Date.now();
  await analyticsDb.execute(sql`
    ALTER TABLE analytics.leads_cohort
      ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE
  `);
  await analyticsDb.execute(sql`
    ALTER TABLE analytics.leads_cohort
      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP
  `);
  await analyticsDb.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_lc_is_deleted
      ON analytics.leads_cohort (is_deleted)
      WHERE is_deleted = TRUE
  `);
  console.log(`  done ${Date.now() - t0}ms`);

  for (const col of ["is_deleted", "deleted_at"]) {
    const ok = await columnExists("leads_cohort", col);
    console.log(`  ${ok ? "✅" : "❌"} leads_cohort.${col}`);
  }
  console.log(
    "\n⚠ Все строки сейчас is_deleted=FALSE. Запустить — `npx tsx scripts/backfill-lead-deletions.ts`",
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("fatal:", e);
    process.exit(1);
  });
