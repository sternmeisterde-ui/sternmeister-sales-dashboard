// One-shot reconciliation: drain every unenriched telephony row across all
// history, then recompute SLA for every lead that has telephony so the
// per-period stats are 1:1 with reality.
//
// Run:   npx tsx --env-file .env.local scripts/full-enrich-and-resync.ts
//
// Safe to run alongside the production cron — both share Kommo's 2 rps
// combined ceiling per docs/kommo-api-usage.md. Worst case: cron ticks
// see slightly slower /contacts responses while this runs.
//
// Order of operations:
//   1. CREATE TABLE IF NOT EXISTS analytics.enrich_skip_phones (migration
//      0016) — bootstrap so the next steps can use it even if the deploy
//      that introduced the migration hasn't landed yet.
//   2. Loop enrichTelephonyLeads with epoch→now horizon. Each tick scans
//      the oldest 200 rows whose phone is NOT in the skip-list, queries
//      Kommo (1 rps), links resolvable ones, records unresolved ones in
//      the skip-list. Loop terminates when backlogRemaining hits zero.
//   3. computeSla over every lead with at least one telephony row —
//      idempotent DELETE-then-INSERT covers all periods including any
//      historical leads whose SLA may have missed the freshly-linked
//      calls.

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { analyticsDb } from "../src/lib/db/analytics";
import { enrichTelephonyLeads } from "../src/lib/etl/enrich-telephony-leads";
import { computeSla } from "../src/lib/etl/compute-sla";

const MAX_TICKS = 200; // safety cap; each tick processes ≤200 rows

async function ensureSkipListTable(): Promise<void> {
  await analyticsDb.execute(sql`
    CREATE TABLE IF NOT EXISTS analytics.enrich_skip_phones (
      phone               text PRIMARY KEY,
      first_skipped_at    timestamp NOT NULL DEFAULT now(),
      last_attempted_at   timestamp NOT NULL DEFAULT now(),
      attempts            integer   NOT NULL DEFAULT 1
    )
  `);
}

async function backlogCount(): Promise<number> {
  const r = await analyticsDb.execute<{ n: string | number }>(sql`
    SELECT COUNT(*) AS n
    FROM analytics.communications c
    LEFT JOIN analytics.enrich_skip_phones s ON s.phone = c.phone
    WHERE c.lead_id IS NULL
      AND c.phone IS NOT NULL
      AND c.phone <> ''
      AND c.communication_type LIKE 'call%'
      AND s.phone IS NULL
  `);
  return Number(r.rows[0]?.n ?? 0);
}

async function leadIdsWithTelephony(): Promise<number[]> {
  const r = await analyticsDb.execute<{ lead_id: number | string }>(sql`
    SELECT DISTINCT lead_id
    FROM analytics.communications
    WHERE communication_type LIKE 'call%'
      AND lead_id IS NOT NULL
    ORDER BY lead_id
  `);
  return r.rows.map((x) => Number(x.lead_id));
}

async function main(): Promise<void> {
  const t0 = Date.now();

  console.log("=== Step 1: ensure analytics.enrich_skip_phones exists ===");
  await ensureSkipListTable();

  const before = await backlogCount();
  console.log(`backlog before drain: ${before} rows`);

  console.log("\n=== Step 2: drain unenriched telephony rows ===");
  const fromDate = new Date(0);
  const toDate = new Date();

  let tick = 0;
  let totalLinked = 0;
  let totalFanned = 0;
  let totalScanned = 0;
  let lastBacklog = before;

  while (tick < MAX_TICKS) {
    tick += 1;
    const tickStart = Date.now();
    const res = await enrichTelephonyLeads(fromDate, toDate);
    const dt = Math.round((Date.now() - tickStart) / 1000);

    totalLinked += res.rowsLinked;
    totalFanned += res.rowsFannedOut;
    totalScanned += res.scannedRows;

    console.log(
      `[recon] tick ${tick.toString().padStart(3, "0")} (${dt}s) | scanned=${res.scannedRows} linked=${res.rowsLinked} fanned=${res.rowsFannedOut} unresolved=${res.unresolvedPhones.length} backlog=${res.backlogRemaining}`,
    );

    if (res.scannedRows === 0 || res.backlogRemaining === 0) {
      console.log("[recon] backlog drained");
      break;
    }
    // Stall detection: if backlog didn't shrink, all scanned phones must
    // have been timeouts that aren't getting skip-listed. Don't burn the
    // entire MAX_TICKS budget — bail and let the cron retry transient
    // ones next window.
    if (res.backlogRemaining >= lastBacklog && res.rowsLinked === 0 && res.unresolvedPhones.length === 0) {
      console.warn("[recon] backlog stalled (likely transient Kommo timeouts) — stopping");
      break;
    }
    lastBacklog = res.backlogRemaining;
  }

  const after = await backlogCount();
  console.log(
    `\nbacklog after drain: ${after} rows (drained ${before - after}) | linked=${totalLinked} fanned=${totalFanned} ticks=${tick}`,
  );

  console.log("\n=== Step 3: recompute SLA for every lead with telephony ===");
  const allLeadIds = await leadIdsWithTelephony();
  console.log(`SLA scope: ${allLeadIds.length} leads`);

  // compute-sla.ts already chunks DELETE/INSERT internally with retry,
  // but its in-memory CTEs are sized to leadIds. Chunk the lead-id list
  // here too so the SELECT comm_summaries / TLT queries don't push past
  // PG's parser limits on a 12k+ IN clause.
  const SLA_CHUNK = 2000;
  const slaStart = new Date(0);
  const slaEnd = new Date();
  let slaTotal = 0;
  for (let i = 0; i < allLeadIds.length; i += SLA_CHUNK) {
    const slice = allLeadIds.slice(i, i + SLA_CHUNK);
    const t = Date.now();
    const n = await computeSla(slaStart, slaEnd, slice);
    slaTotal += n;
    console.log(
      `[recon SLA] chunk ${i / SLA_CHUNK + 1}/${Math.ceil(allLeadIds.length / SLA_CHUNK)} (${slice.length} leads) → ${n} rows in ${Math.round((Date.now() - t) / 1000)}s`,
    );
  }

  const totalSec = Math.round((Date.now() - t0) / 1000);
  console.log(
    `\n=== DONE in ${totalSec}s | backlog drained=${before - after}/${before} | SLA rows recomputed=${slaTotal} ===`,
  );
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("[recon] fatal:", err);
  process.exit(1);
});
