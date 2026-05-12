// Quick check: how many telephony rows still need enrichment, across how
// many distinct phones, considering the enrich_skip_phones list?
import { config } from "dotenv";
config({ path: ".env.local" });

import { sql } from "drizzle-orm";
import { analyticsDb } from "../src/lib/db/analytics";

async function main(): Promise<void> {
  const raw = await analyticsDb.execute<{
    total: string;
    distinct_phones: string;
    oldest: string;
    newest: string;
  }>(sql`
    SELECT
      COUNT(*) AS total,
      COUNT(DISTINCT phone) AS distinct_phones,
      to_char(MIN(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS oldest,
      to_char(MAX(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS newest
    FROM analytics.communications
    WHERE lead_id IS NULL
      AND phone IS NOT NULL
      AND phone <> ''
      AND communication_type LIKE 'call%'
  `);
  console.log("=== All rows with lead_id IS NULL (raw) ===");
  console.log(raw.rows[0]);

  const scannable = await analyticsDb.execute<{ total: string; distinct_phones: string }>(sql`
    SELECT COUNT(*) AS total, COUNT(DISTINCT c.phone) AS distinct_phones
    FROM analytics.communications c
    LEFT JOIN analytics.enrich_skip_phones s ON s.phone = c.phone
    WHERE c.lead_id IS NULL
      AND c.phone IS NOT NULL AND c.phone <> ''
      AND c.communication_type LIKE 'call%'
      AND s.phone IS NULL
  `);
  console.log("\n=== Scannable backlog (excluding skip-list) ===");
  console.log(scannable.rows[0]);

  const skip = await analyticsDb.execute<{ n: string }>(sql`
    SELECT COUNT(*) AS n FROM analytics.enrich_skip_phones
  `);
  console.log(`\nskip-list size: ${skip.rows[0]?.n}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
