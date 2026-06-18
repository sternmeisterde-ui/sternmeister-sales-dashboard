// Quick diagnostic: heartbeat freshness + per-source MAX(timestamp).
// Run from repo root:
//   npx tsx scripts/check-etl-gaps.ts
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { analyticsDb } from "../src/lib/db/analytics";

async function main(): Promise<void> {
  const hb = await analyticsDb.execute<{
    last_completed_at: string | null;
    acquired_at: string | null;
    expires_at: string | null;
  }>(sql`
    SELECT to_char(last_completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_completed_at,
           to_char(acquired_at       AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS acquired_at,
           to_char(expires_at        AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS expires_at
    FROM analytics.etl_locks
    WHERE name = 'cron'
  `);
  const row = hb.rows[0];
  console.log("=== ETL heartbeat ===");
  console.log(row ?? "(no row — cron has never run)");
  if (row?.last_completed_at) {
    const ageSec = Math.floor(
      (Date.now() - new Date(row.last_completed_at).getTime()) / 1000,
    );
    console.log(`  age: ${ageSec}s (${(ageSec / 60).toFixed(1)} min)`);
  }

  console.log("\n=== Source freshness (last 7d MAX) ===");
  const sources: Array<{ label: string; table: string; column: string }> = [
    { label: "communications", table: "analytics.communications", column: "created_at" },
    { label: "leads_cohort", table: "analytics.leads_cohort", column: "created_at" },
    { label: "lead_status_changes", table: "analytics.lead_status_changes", column: "event_at" },
    { label: "sla", table: "analytics.sla", column: "last_contact_at" },
  ];

  for (const s of sources) {
    const r = await analyticsDb.execute<{ max_at: string | null; n: number | string }>(sql`
      SELECT to_char(MAX(${sql.raw(s.column)}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS max_at, COUNT(*) AS n
      FROM ${sql.raw(s.table)}
      WHERE ${sql.raw(s.column)} >= now() - interval '7 days'
    `);
    const ts = r.rows[0]?.max_at ?? null;
    const n = Number(r.rows[0]?.n ?? 0);
    const age = ts
      ? `${Math.floor((Date.now() - new Date(ts).getTime()) / 60_000)} min`
      : "n/a";
    console.log(`  ${s.label.padEnd(22)} max=${ts ?? "null"}  rows7d=${n}  age=${age}`);
  }

  console.log("\n=== Communications by hour, last 96h ===");
  const buckets = await analyticsDb.execute<{ h: string; n: number | string }>(sql`
    SELECT to_char(date_trunc('hour', created_at), 'YYYY-MM-DD HH24"h"') AS h,
           COUNT(*) AS n
    FROM analytics.communications
    WHERE created_at >= now() - interval '96 hours'
    GROUP BY 1
    ORDER BY 1
  `);
  for (const r of buckets.rows) {
    console.log(`  ${r.h}  ${String(r.n).padStart(5)}`);
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
