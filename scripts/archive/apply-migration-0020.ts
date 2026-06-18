// One-off applier for 0020_leads_cohort_funnel_extras.sql.
// Adds 3 columns to analytics.leads_cohort for Funnel correctness after
// cohort-conversion is decommissioned. Idempotent.
//
//   npx tsx scripts/apply-migration-0020.ts
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
  console.log("=== Applying 0020_leads_cohort_funnel_extras ===");

  const t0 = Date.now();
  await analyticsDb.execute(sql`
    ALTER TABLE analytics.leads_cohort
      ADD COLUMN IF NOT EXISTS exclude_from_analytics BOOLEAN NOT NULL DEFAULT FALSE
  `);
  await analyticsDb.execute(sql`
    ALTER TABLE analytics.leads_cohort
      ADD COLUMN IF NOT EXISTS first_qualification_at TIMESTAMP
  `);
  await analyticsDb.execute(sql`
    ALTER TABLE analytics.leads_cohort
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP
  `);
  await analyticsDb.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_lc_exclude_from_analytics
      ON analytics.leads_cohort (exclude_from_analytics)
      WHERE exclude_from_analytics = TRUE
  `);
  await analyticsDb.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_lc_first_qualification_at
      ON analytics.leads_cohort (first_qualification_at)
      WHERE first_qualification_at IS NOT NULL
  `);
  console.log(`  schema done ${Date.now() - t0}ms`);

  // Бэкфилл first_qualification_at: для каждого Гос-лида находим earliest
  // event_at в lead_status_changes по QUAL_FIRST_LINE_STATUS_IDS (за вычетом
  // UNSORTED 83873487 и BASE 93485479).
  console.log(
    "Backfill: computing first_qualification_at from lead_status_changes ...",
  );
  const t1 = Date.now();
  const QUAL_STATUSES = [
    83873491, // NEW_LEAD
    90367079, // IN_PROGRESS
    90367083, // NO_ANSWER
    90367087, // CONTACT_MADE
    95514983, // CONSULT_DONE
    104211575, // DECISION_MAKING
    101935919, // DOCS_SENT_DC
    95514987, // DELAYED_START
    142, // WON Термин ДЦ
    143, // LOST
  ];
  await analyticsDb.execute(sql`
    UPDATE analytics.leads_cohort lc
    SET first_qualification_at = sub.first_at
    FROM (
      SELECT lead_id, MIN(event_at) AS first_at
      FROM analytics.lead_status_changes
      WHERE pipeline_id = 10935879
        AND status_id IN (${sql.raw(QUAL_STATUSES.join(","))})
      GROUP BY lead_id
    ) AS sub
    WHERE lc.lead_id = sub.lead_id
      AND lc.pipeline_id = 10935879
      AND lc.first_qualification_at IS NULL
  `);
  console.log(`  backfill done ${Date.now() - t1}ms`);

  for (const col of ["exclude_from_analytics", "first_qualification_at", "updated_at"]) {
    const ok = await columnExists("leads_cohort", col);
    console.log(`  ${ok ? "✅" : "❌"} leads_cohort.${col}`);
  }

  console.log(
    "\n⚠ exclude_from_analytics и updated_at заполнятся при следующем sync-leads тике.",
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
