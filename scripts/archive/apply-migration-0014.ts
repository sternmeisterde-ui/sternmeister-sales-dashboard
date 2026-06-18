// One-off applier for 0014_status_changes_unique.sql.
// Idempotent — re-running is a no-op once dupes are gone and the index exists.
//
// Run from repo root:
//   npx tsx scripts/apply-migration-0014.ts
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { analyticsDb } from "../src/lib/db/analytics";

async function dupeCount(): Promise<number> {
  const r = await analyticsDb.execute<{ n: string }>(sql`
    SELECT COUNT(*)::text AS n FROM (
      SELECT 1
      FROM analytics.lead_status_changes
      GROUP BY lead_id, event_at, status_id
      HAVING COUNT(*) > 1
    ) x
  `);
  return Number(r.rows[0]?.n ?? 0);
}

async function main(): Promise<void> {
  console.log("=== Applying 0014_status_changes_unique ===");

  const before = await dupeCount();
  console.log(`Before: ${before} duplicate groups`);

  // Step 1 — Dedupe. Keep the row with the lowest ctid in each group.
  // Self-join via ctid is the canonical PG dedupe; the GROUP BY columns are
  // the natural identity of a status transition.
  console.log("Step 1: deleting duplicate rows ...");
  const t0 = Date.now();
  const del = await analyticsDb.execute(sql`
    DELETE FROM analytics.lead_status_changes a
    USING analytics.lead_status_changes b
    WHERE a.ctid     < b.ctid
      AND a.lead_id  = b.lead_id
      AND a.event_at = b.event_at
      AND a.status_id = b.status_id
  `);
  console.log(
    `  done ${Date.now() - t0}ms (rowCount=${del.rowCount ?? "?"})`,
  );

  const mid = await dupeCount();
  console.log(`After dedupe: ${mid} duplicate groups`);
  if (mid > 0) {
    console.error("FATAL: dupes still present, aborting before index creation");
    process.exit(1);
  }

  // Step 2 — Create the unique index.
  console.log("Step 2: creating unique index ...");
  const t1 = Date.now();
  await analyticsDb.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS lead_status_changes_unique
      ON analytics.lead_status_changes (lead_id, event_at, status_id)
  `);
  console.log(`  done ${Date.now() - t1}ms`);

  // Step 3 — Verify index exists.
  const idx = await analyticsDb.execute<{ indexname: string }>(sql`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'analytics'
      AND tablename = 'lead_status_changes'
      AND indexname = 'lead_status_changes_unique'
  `);
  console.log(
    idx.rows[0]
      ? "Index lead_status_changes_unique is in place ✅"
      : "Index NOT created ❌",
  );
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
