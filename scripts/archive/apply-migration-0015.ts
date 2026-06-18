// One-off applier for 0015_tasks_unique.sql.
// Idempotent — current dupe count is 0, so DELETE is a no-op; index uses
// IF NOT EXISTS, so re-running is safe.
//
//   npx tsx scripts/apply-migration-0015.ts
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { analyticsDb } from "../src/lib/db/analytics";

async function dupeCount(): Promise<number> {
  const r = await analyticsDb.execute<{ n: string }>(sql`
    SELECT COUNT(*)::text AS n FROM (
      SELECT 1
      FROM analytics.tasks
      GROUP BY task_id
      HAVING COUNT(*) > 1
    ) x
  `);
  return Number(r.rows[0]?.n ?? 0);
}

async function main(): Promise<void> {
  console.log("=== Applying 0015_tasks_unique ===");

  const before = await dupeCount();
  console.log(`Before: ${before} duplicate task_id groups`);

  // Step 1 — Dedupe (no-op if before=0).
  console.log("Step 1: deleting duplicate rows ...");
  const t0 = Date.now();
  const del = await analyticsDb.execute(sql`
    DELETE FROM analytics.tasks a
    USING analytics.tasks b
    WHERE a.ctid    < b.ctid
      AND a.task_id = b.task_id
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
    CREATE UNIQUE INDEX IF NOT EXISTS tasks_task_id_unique
      ON analytics.tasks (task_id)
  `);
  console.log(`  done ${Date.now() - t1}ms`);

  // Step 3 — Verify index exists.
  const idx = await analyticsDb.execute<{ indexname: string }>(sql`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'analytics'
      AND tablename = 'tasks'
      AND indexname = 'tasks_task_id_unique'
  `);
  console.log(
    idx.rows[0]
      ? "Index tasks_task_id_unique is in place ✅"
      : "Index NOT created ❌",
  );
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
