// Diagnostic: scan core analytics tables for duplicate keys and overlapping
// rows across the last 7 days. Useful after a backfill or transient outage
// to confirm UPSERT semantics held.
//
// Run from repo root:
//   npx tsx scripts/check-etl-dupes.ts
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { analyticsDb } from "../src/lib/db/analytics";

interface DupeRow {
  k1: string | null;
  k2: string | null;
  n: string | number;
}

async function main(): Promise<void> {
  console.log("=== Checking duplicates (last 7 days) ===\n");

  // 1. communications: composite unique = (communication_id, COALESCE(lead_id, 0))
  //    Partial WHERE communication_id IS NOT NULL — so we look there.
  console.log("[1] communications: dupes on (communication_id, COALESCE(lead_id, 0))");
  const comms = await analyticsDb.execute<DupeRow>(sql`
    SELECT communication_id::text AS k1,
           COALESCE(lead_id, 0)::text AS k2,
           COUNT(*) AS n
    FROM analytics.communications
    WHERE communication_id IS NOT NULL
      AND created_at >= now() - interval '7 days'
    GROUP BY communication_id, COALESCE(lead_id, 0)
    HAVING COUNT(*) > 1
    ORDER BY n DESC
    LIMIT 20
  `);
  if (comms.rows.length === 0) {
    console.log("  ✅ no duplicates\n");
  } else {
    console.log(`  ⚠️  ${comms.rows.length} groups with duplicates:`);
    for (const r of comms.rows) {
      console.log(`    comm_id=${r.k1} lead_id=${r.k2} count=${r.n}`);
    }
    console.log("");
  }

  // 2. leads_cohort: PK = lead_id (one row per lead). Should never dupe.
  console.log("[2] leads_cohort: dupes on lead_id");
  const leads = await analyticsDb.execute<DupeRow>(sql`
    SELECT lead_id::text AS k1, NULL::text AS k2, COUNT(*) AS n
    FROM analytics.leads_cohort
    WHERE created_at >= now() - interval '7 days'
    GROUP BY lead_id
    HAVING COUNT(*) > 1
    ORDER BY n DESC
    LIMIT 20
  `);
  if (leads.rows.length === 0) {
    console.log("  ✅ no duplicates\n");
  } else {
    console.log(`  ⚠️  ${leads.rows.length} dupe lead_ids`);
    for (const r of leads.rows) console.log(`    lead_id=${r.k1} count=${r.n}`);
    console.log("");
  }

  // 3. lead_status_changes: composite unique should be (lead_id, event_at, status_id)
  console.log("[3] lead_status_changes: dupes on (lead_id, event_at, status_id)");
  const status = await analyticsDb.execute<{ k1: string; k2: string; k3: string; n: string | number }>(sql`
    SELECT lead_id::text AS k1, event_at::text AS k2, status_id::text AS k3, COUNT(*) AS n
    FROM analytics.lead_status_changes
    WHERE event_at >= now() - interval '7 days'
    GROUP BY lead_id, event_at, status_id
    HAVING COUNT(*) > 1
    ORDER BY n DESC
    LIMIT 20
  `);
  if (status.rows.length === 0) {
    console.log("  ✅ no duplicates\n");
  } else {
    console.log(`  ⚠️  ${status.rows.length} dupe groups`);
    for (const r of status.rows) {
      console.log(`    lead=${r.k1} at=${r.k2} status=${r.k3} count=${r.n}`);
    }
    console.log("");
  }

  // 4. sla: PK = lead_id
  console.log("[4] sla: dupes on lead_id");
  const slaDup = await analyticsDb.execute<DupeRow>(sql`
    SELECT lead_id::text AS k1, NULL::text AS k2, COUNT(*) AS n
    FROM analytics.sla
    GROUP BY lead_id
    HAVING COUNT(*) > 1
    ORDER BY n DESC
    LIMIT 20
  `);
  if (slaDup.rows.length === 0) {
    console.log("  ✅ no duplicates\n");
  } else {
    console.log(`  ⚠️  ${slaDup.rows.length} dupe lead_ids`);
    for (const r of slaDup.rows) console.log(`    lead_id=${r.k1} count=${r.n}`);
    console.log("");
  }

  // 5. Cron tick gaps — find consecutive ticks with > 12 min gap (10 min schedule + 2 min slack)
  console.log("[5] Looking for tick gaps (proxy: hourly comms == 0 in business hours)");
  const gaps = await analyticsDb.execute<{ h: string; n: string }>(sql`
    WITH hours AS (
      SELECT generate_series(
        date_trunc('hour', now()) - interval '96 hours',
        date_trunc('hour', now()),
        interval '1 hour'
      ) AS h
    ),
    counts AS (
      SELECT date_trunc('hour', created_at) AS h, COUNT(*) AS n
      FROM analytics.communications
      WHERE created_at >= now() - interval '96 hours'
      GROUP BY 1
    )
    SELECT to_char(hours.h AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24"h"') AS h,
           COALESCE(counts.n, 0)::text AS n
    FROM hours
    LEFT JOIN counts ON counts.h = hours.h
    WHERE COALESCE(counts.n, 0) = 0
      AND EXTRACT(HOUR FROM hours.h AT TIME ZONE 'Europe/Berlin') BETWEEN 8 AND 19
      AND EXTRACT(ISODOW FROM hours.h AT TIME ZONE 'Europe/Berlin') BETWEEN 1 AND 5
    ORDER BY hours.h
  `);
  if (gaps.rows.length === 0) {
    console.log("  ✅ no zero-event business hours in last 96h\n");
  } else {
    console.log(`  ⚠️  ${gaps.rows.length} business hours with zero communications:`);
    for (const r of gaps.rows) console.log(`    ${r.h}  ${r.n}`);
    console.log("");
  }

  // 6. Recent step errors — only available in process logs, but we can check
  //    the last 100 cron lock acquisitions to see acquired/completed pairs.
  console.log("[6] Recent ETL lock state (heartbeat continuity)");
  const lock = await analyticsDb.execute<{
    name: string;
    acquired_at: string | null;
    last_completed_at: string | null;
    expires_at: string | null;
  }>(sql`
    SELECT name,
           to_char(acquired_at       AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS acquired_at,
           to_char(last_completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_completed_at,
           to_char(expires_at        AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS expires_at
    FROM analytics.etl_locks
  `);
  for (const r of lock.rows) {
    console.log(`  ${r.name}:`);
    console.log(`    acquired_at       = ${r.acquired_at}`);
    console.log(`    last_completed_at = ${r.last_completed_at}`);
    console.log(`    expires_at        = ${r.expires_at}`);
  }
  console.log("");
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
