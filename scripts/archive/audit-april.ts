// Full April 2026 audit — duplicates per natural key, hourly gaps in
// business hours, sanity totals per day. Run after the 0014 migration to
// confirm no leftover dupes from the older retry hazard.
//
//   npx tsx scripts/audit-april.ts
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { analyticsDb } from "../src/lib/db/analytics";

const FROM = "2026-04-01 00:00:00";
const TO = "2026-04-30 23:59:59";

async function main(): Promise<void> {
  console.log(`=== April audit (${FROM} → ${TO} UTC) ===\n`);

  // ── 1. Duplicate scan on every table that should be unique ───────────
  console.log("[1] Duplicate scan — should all be 0\n");

  const checks = [
    {
      label: "communications  (communication_id, COALESCE(lead_id, 0))",
      q: sql`
        SELECT COUNT(*)::text AS n FROM (
          SELECT 1 FROM analytics.communications
          WHERE communication_id IS NOT NULL
            AND created_at BETWEEN ${FROM} AND ${TO}
          GROUP BY communication_id, COALESCE(lead_id, 0)
          HAVING COUNT(*) > 1
        ) x
      `,
    },
    {
      label: "lead_status_changes (lead_id, event_at, status_id)",
      q: sql`
        SELECT COUNT(*)::text AS n FROM (
          SELECT 1 FROM analytics.lead_status_changes
          WHERE event_at BETWEEN ${FROM} AND ${TO}
          GROUP BY lead_id, event_at, status_id
          HAVING COUNT(*) > 1
        ) x
      `,
    },
    {
      label: "leads_cohort  (lead_id)",
      q: sql`
        SELECT COUNT(*)::text AS n FROM (
          SELECT 1 FROM analytics.leads_cohort
          WHERE created_at BETWEEN ${FROM} AND ${TO}
          GROUP BY lead_id
          HAVING COUNT(*) > 1
        ) x
      `,
    },
    {
      label: "sla  (lead_id)",
      q: sql`
        SELECT COUNT(*)::text AS n FROM (
          SELECT 1 FROM analytics.sla
          WHERE lead_created_at BETWEEN ${FROM} AND ${TO}
          GROUP BY lead_id
          HAVING COUNT(*) > 1
        ) x
      `,
    },
    {
      label: "tasks  (task_id) [if present]",
      q: sql`
        SELECT COALESCE(COUNT(*)::text, '0') AS n FROM (
          SELECT 1 FROM analytics.tasks
          WHERE created_at BETWEEN ${FROM} AND ${TO}
          GROUP BY task_id
          HAVING COUNT(*) > 1
        ) x
      `,
    },
  ];

  for (const c of checks) {
    try {
      const r = await analyticsDb.execute<{ n: string }>(c.q);
      const n = Number(r.rows[0]?.n ?? 0);
      console.log(`  ${n === 0 ? "✅" : "⚠️ "} ${c.label.padEnd(60)} dupe groups=${n}`);
    } catch (e) {
      console.log(`  ⚠️  ${c.label.padEnd(60)} query failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  // ── 2. Daily totals — communications & leads ─────────────────────────
  console.log("\n[2] Daily totals (Berlin local day)\n");
  const daily = await analyticsDb.execute<{
    d: string;
    leads: string;
    comms: string;
    status: string;
    sla: string;
  }>(sql`
    WITH days AS (
      SELECT generate_series(
        date_trunc('day', ${FROM}::timestamp AT TIME ZONE 'Europe/Berlin'),
        date_trunc('day', ${TO}::timestamp   AT TIME ZONE 'Europe/Berlin'),
        interval '1 day'
      ) AS d
    )
    SELECT to_char(days.d, 'YYYY-MM-DD (Dy)') AS d,
           (SELECT COUNT(*)::text FROM analytics.leads_cohort lc
              WHERE lc.created_at AT TIME ZONE 'Europe/Berlin' >= days.d
                AND lc.created_at AT TIME ZONE 'Europe/Berlin' < days.d + interval '1 day') AS leads,
           (SELECT COUNT(*)::text FROM analytics.communications c
              WHERE c.created_at AT TIME ZONE 'Europe/Berlin' >= days.d
                AND c.created_at AT TIME ZONE 'Europe/Berlin' < days.d + interval '1 day') AS comms,
           (SELECT COUNT(*)::text FROM analytics.lead_status_changes s
              WHERE s.event_at AT TIME ZONE 'Europe/Berlin' >= days.d
                AND s.event_at AT TIME ZONE 'Europe/Berlin' < days.d + interval '1 day') AS status,
           (SELECT COUNT(*)::text FROM analytics.sla sla
              WHERE sla.lead_created_at AT TIME ZONE 'Europe/Berlin' >= days.d
                AND sla.lead_created_at AT TIME ZONE 'Europe/Berlin' < days.d + interval '1 day') AS sla
    FROM days
    ORDER BY days.d
  `);
  console.log(
    `  ${"day".padEnd(20)} ${"leads".padStart(6)} ${"comms".padStart(6)} ${"status".padStart(6)} ${"sla".padStart(6)}`,
  );
  for (const r of daily.rows) {
    console.log(
      `  ${r.d.padEnd(20)} ${r.leads.padStart(6)} ${r.comms.padStart(6)} ${r.status.padStart(6)} ${r.sla.padStart(6)}`,
    );
  }

  // ── 3. Business-hour gaps (Mon–Fri 08–19 Berlin with zero comms) ─────
  console.log("\n[3] Business hours with ZERO communications (Mon–Fri, 08–19 Europe/Berlin)\n");
  const gaps = await analyticsDb.execute<{ h: string }>(sql`
    WITH hours AS (
      SELECT generate_series(
        ${FROM}::timestamp,
        ${TO}::timestamp,
        interval '1 hour'
      ) AS h
    ),
    counts AS (
      SELECT date_trunc('hour', created_at) AS h, COUNT(*) AS n
      FROM analytics.communications
      WHERE created_at BETWEEN ${FROM} AND ${TO}
      GROUP BY 1
    )
    SELECT to_char(hours.h AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD Dy HH24"h"') AS h
    FROM hours
    LEFT JOIN counts ON counts.h = hours.h
    WHERE COALESCE(counts.n, 0) = 0
      AND EXTRACT(HOUR  FROM hours.h AT TIME ZONE 'Europe/Berlin') BETWEEN 8 AND 19
      AND EXTRACT(ISODOW FROM hours.h AT TIME ZONE 'Europe/Berlin') BETWEEN 1 AND 5
    ORDER BY hours.h
  `);
  if (gaps.rows.length === 0) {
    console.log("  ✅ none — every business hour has at least one comm event");
  } else {
    console.log(`  ⚠️  ${gaps.rows.length} business hours with zero comms:`);
    for (const r of gaps.rows) console.log(`    ${r.h}`);
  }

  // ── 4. Comm-volume outliers — flag days that look anomalously low ────
  console.log("\n[4] Daily comm volume z-score (flagging days < median × 0.5)\n");
  const z = await analyticsDb.execute<{
    d: string;
    n: string;
    med: string;
  }>(sql`
    WITH d AS (
      SELECT date_trunc('day', created_at AT TIME ZONE 'Europe/Berlin') AS day,
             COUNT(*) AS n
      FROM analytics.communications
      WHERE created_at BETWEEN ${FROM} AND ${TO}
        AND EXTRACT(ISODOW FROM created_at AT TIME ZONE 'Europe/Berlin') BETWEEN 1 AND 5
      GROUP BY 1
    ),
    stats AS (
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY n) AS med FROM d
    )
    SELECT to_char(d.day, 'YYYY-MM-DD (Dy)') AS d,
           d.n::text AS n,
           ROUND(stats.med)::text AS med
    FROM d, stats
    WHERE d.n < stats.med * 0.5
    ORDER BY d.day
  `);
  if (z.rows.length === 0) {
    console.log("  ✅ no business day below 50% of median");
  } else {
    console.log(`  ⚠️  ${z.rows.length} suspicious days:`);
    for (const r of z.rows) console.log(`    ${r.d}  comms=${r.n}  median=${r.med}`);
  }

  console.log("\n=== done ===");
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
