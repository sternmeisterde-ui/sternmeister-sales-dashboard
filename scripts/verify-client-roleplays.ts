// READ-ONLY проверка analytics.client_roleplays после backfill.
//   npx tsx scripts/verify-client-roleplays.ts
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { analyticsDb } from "../src/lib/db/analytics";

async function main(): Promise<void> {
  const totals = await analyticsDb.execute(sql`
    SELECT count(*) AS rows, count(DISTINCT lead_id) AS leads,
           round(avg(score_5)::numeric, 2) AS avg_score5,
           min(roleplay_at)::text AS earliest, max(roleplay_at)::text AS latest
    FROM analytics.client_roleplays
  `);
  console.log("Итого:");
  console.table(totals.rows);

  const bySide = await analyticsDb.execute(sql`
    SELECT side, count(*) AS n, round(avg(score_5)::numeric, 2) AS avg_score5
    FROM analytics.client_roleplays GROUP BY side ORDER BY side
  `);
  console.log("По стороне (dc=ДЦ / aa=АА):");
  console.table(bySide.rows);

  const byAttempt = await analyticsDb.execute(sql`
    SELECT attempt, count(*) AS n
    FROM analytics.client_roleplays GROUP BY attempt ORDER BY attempt
  `);
  console.log("По номеру попытки:");
  console.table(byAttempt.rows);

  // Связь с воронкой: сколько ролевок матчатся на лид в leads_cohort
  const linked = await analyticsDb.execute(sql`
    SELECT
      count(*)                                               AS roleplays,
      count(*) FILTER (WHERE lc.lead_id IS NOT NULL)         AS matched_to_cohort
    FROM analytics.client_roleplays cr
    LEFT JOIN analytics.leads_cohort lc ON lc.lead_id = cr.lead_id
  `);
  console.log("Связь с leads_cohort (нужно для воронки):");
  console.table(linked.rows);

  const sample = await analyticsDb.execute(sql`
    SELECT lead_id, side, attempt, score_5, score_percent, roleplay_at::text
    FROM analytics.client_roleplays
    ORDER BY roleplay_at DESC LIMIT 5
  `);
  console.log("Свежие 5:");
  console.table(sample.rows);
}

main().then(() => process.exit(0)).catch((e) => { console.error("fatal:", e); process.exit(1); });
