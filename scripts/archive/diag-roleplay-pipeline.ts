// READ-ONLY: в каком пайплайне лежат лиды из client_roleplays?
//   npx tsx scripts/diag-roleplay-pipeline.ts
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { analyticsDb } from "../src/lib/db/analytics";

async function main(): Promise<void> {
  console.log("Пайплайны в leads_cohort:");
  console.table(
    (await analyticsDb.execute(sql`
      SELECT pipeline_id, pipeline, count(*) AS n
      FROM analytics.leads_cohort GROUP BY pipeline_id, pipeline ORDER BY n DESC
    `)).rows
  );

  console.log("\nЛиды из client_roleplays — по пайплайну:");
  console.table(
    (await analyticsDb.execute(sql`
      SELECT lc.pipeline_id, lc.pipeline,
             count(*) AS roleplays,
             count(DISTINCT cr.lead_id) AS leads,
             min(lc.created_at)::date AS earliest_created,
             max(lc.created_at)::date AS latest_created
      FROM analytics.client_roleplays cr
      JOIN analytics.leads_cohort lc ON lc.lead_id = cr.lead_id
      GROUP BY lc.pipeline_id, lc.pipeline
    `)).rows
  );

  console.log("\nЕсть ли cross-link Бератер-лида ролевки → Гос-лид (через контакт)?");
  console.table(
    (await analyticsDb.execute(sql`
      WITH rp_leads AS (SELECT DISTINCT lead_id FROM analytics.client_roleplays)
      SELECT
        count(*) AS rp_leads,
        count(*) FILTER (WHERE gos.lead_id IS NOT NULL) AS linked_to_gos
      FROM rp_leads r
      LEFT JOIN LATERAL (
        SELECT g.lead_id
        FROM analytics.lead_contact_links lcl_b
        JOIN analytics.lead_contact_links lcl_g
          ON lcl_g.contact_id = lcl_b.contact_id AND lcl_g.lead_id <> r.lead_id
        JOIN analytics.leads_cohort g
          ON g.lead_id = lcl_g.lead_id AND g.pipeline_id = 10935879
        WHERE lcl_b.lead_id = r.lead_id AND lcl_b.is_active = TRUE
        LIMIT 1
      ) gos ON TRUE
    `)).rows
  );
}

main().then(() => process.exit(0)).catch((e) => { console.error("fatal:", e); process.exit(1); });
