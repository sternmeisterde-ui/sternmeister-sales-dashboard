import { analyticsDb } from "@/lib/db/analytics";
import { sql } from "drizzle-orm";

async function main() {
  const res = await analyticsDb.execute(sql.raw(`
    SELECT s.lead_id, s.first_call_out_at, s.sla_start,
      (SELECT MIN(c.created_at) FROM analytics.communications c
       WHERE c.lead_id = 19006949 AND c.communication_type = 'call_out') AS comms_first
    FROM analytics.sla s WHERE s.lead_id = 19006949
  `));
  console.log(JSON.stringify(res.rows, null, 2));

  const cnt = await analyticsDb.execute(sql.raw(`
    SELECT COUNT(*) AS offset_count
    FROM analytics.sla s
    WHERE s.first_call_out_at IS NOT NULL
      AND ABS(EXTRACT(EPOCH FROM (
        (SELECT MIN(c.created_at) FROM analytics.communications c
         WHERE c.lead_id = s.lead_id AND c.communication_type = 'call_out')
        - s.first_call_out_at
      ))) BETWEEN 7100 AND 7300
  `));
  console.log('offset_count:', cnt.rows[0]);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
