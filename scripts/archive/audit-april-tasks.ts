// Quick check: are there duplicate (task_id) rows in analytics.tasks?
// tasks has only a regular index on task_id, no unique constraint — same
// retry hazard pattern as lead_status_changes had pre-0014.
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { analyticsDb } from "../src/lib/db/analytics";

async function main(): Promise<void> {
  console.log("=== analytics.tasks duplicate scan (April + all-time) ===\n");

  const april = await analyticsDb.execute<{ n: string }>(sql`
    SELECT COUNT(*)::text AS n FROM (
      SELECT 1 FROM analytics.tasks
      WHERE task_created_at BETWEEN '2026-04-01' AND '2026-04-30 23:59:59'
      GROUP BY task_id
      HAVING COUNT(*) > 1
    ) x
  `);
  console.log(`April:    ${april.rows[0]?.n ?? 0} duplicate task_id groups`);

  const total = await analyticsDb.execute<{ n: string }>(sql`
    SELECT COUNT(*)::text AS n FROM (
      SELECT 1 FROM analytics.tasks
      GROUP BY task_id
      HAVING COUNT(*) > 1
    ) x
  `);
  console.log(`All-time: ${total.rows[0]?.n ?? 0} duplicate task_id groups`);

  // Top dupe groups for visibility
  const top = await analyticsDb.execute<{ task_id: string; n: string }>(sql`
    SELECT task_id::text AS task_id, COUNT(*)::text AS n
    FROM analytics.tasks
    GROUP BY task_id
    HAVING COUNT(*) > 1
    ORDER BY COUNT(*) DESC
    LIMIT 10
  `);
  if (top.rows.length > 0) {
    console.log("\nTop 10 duplicated task_ids:");
    for (const r of top.rows) console.log(`  task_id=${r.task_id}  count=${r.n}`);
  }

  // Also scan: are there duplicate communication_id rows ANYWHERE (not just April)?
  const commsAll = await analyticsDb.execute<{ n: string }>(sql`
    SELECT COUNT(*)::text AS n FROM (
      SELECT 1 FROM analytics.communications
      WHERE communication_id IS NOT NULL
      GROUP BY communication_id, COALESCE(lead_id, 0)
      HAVING COUNT(*) > 1
    ) x
  `);
  console.log(`\ncommunications all-time: ${commsAll.rows[0]?.n ?? 0} dupe groups`);

  const lscAll = await analyticsDb.execute<{ n: string }>(sql`
    SELECT COUNT(*)::text AS n FROM (
      SELECT 1 FROM analytics.lead_status_changes
      GROUP BY lead_id, event_at, status_id
      HAVING COUNT(*) > 1
    ) x
  `);
  console.log(`lead_status_changes all-time: ${lscAll.rows[0]?.n ?? 0} dupe groups`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
