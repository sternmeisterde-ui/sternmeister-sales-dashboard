import { config } from "dotenv";
config({ path: ".env.local" });

import { sql } from "drizzle-orm";
import { analyticsDb } from "../src/lib/db/analytics";

async function main(): Promise<void> {
  const r = await analyticsDb.execute<{ total: string; with_sla: string }>(sql`
    WITH leads_with_telephony AS (
      SELECT DISTINCT lead_id
      FROM analytics.communications
      WHERE communication_type LIKE 'call%'
        AND lead_id IS NOT NULL
    )
    SELECT
      (SELECT COUNT(*) FROM leads_with_telephony)::text AS total,
      (SELECT COUNT(*) FROM leads_with_telephony lt
         JOIN analytics.sla s ON s.lead_id = lt.lead_id)::text AS with_sla
  `);
  console.log("Leads with telephony:", r.rows[0]);
}

main().catch((e) => { console.error(e); process.exit(1); });
