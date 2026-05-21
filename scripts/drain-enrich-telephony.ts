// One-shot drainer: runs enrichTelephonyLeads in a loop until backlog hits 0.
//
// Why this exists: a recent ETL bug let mixed-state CDRs (raw NULL + enriched
// copy under one communication_id) accumulate, blocking each cron tick's bulk
// UPDATE and starving the enrich queue. After the structural fixes landed
// (sync-telephony delete-by-id, enrich payload dedup) and the 8 mixed-state
// rows were cleaned manually, ~2715 unenriched rows still need draining.
// Cron alone would take ~9 ticks (~2.5h). This script does it in one shot.
//
// Run:   npx tsx scripts/drain-enrich-telephony.ts
// Reads: .env.local for KOMMO_ACCESS_TOKEN + ANALYTICS_DATABASE_URL etc.
//
// Safe to run alongside the production cron — both share the same Kommo
// 2-rps combined limit (per docs/kommo-api-usage.md). Worst case: the cron
// tick gets a slightly slower /contacts response.

import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });

import { enrichTelephonyLeads } from "../src/lib/etl/enrich-telephony-leads";

const SAFETY_MAX_TICKS = 40; // 40 × 300 = 12k rows — way over current backlog

async function main(): Promise<void> {
  // Wide horizon — pick up the oldest unenriched row regardless of how far
  // back it is. enrichTelephonyLeads orders ASC by created_at so each tick
  // takes the 300 oldest first.
  const toDate = new Date();
  // 30-day horizon: covers what production cron's 7-day lookback can't reach.
  // Older unenriched rows (Jan/Feb cold dials) stay as-is — they're legit
  // data gaps (numbers never imported to Kommo as contacts).
  const fromDate = new Date(toDate.getTime() - 30 * 24 * 60 * 60 * 1000);

  console.log(`[drain] horizon: ${fromDate.toISOString()} → ${toDate.toISOString()}`);

  let totalLinked = 0;
  let totalFanned = 0;
  let totalScanned = 0;
  let tick = 0;
  const startMs = Date.now();

  while (tick < SAFETY_MAX_TICKS) {
    tick += 1;
    const tickStart = Date.now();
    const res = await enrichTelephonyLeads(fromDate, toDate);
    const dt = Math.round((Date.now() - tickStart) / 1000);

    totalLinked += res.rowsLinked;
    totalFanned += res.rowsFannedOut;
    totalScanned += res.scannedRows;

    console.log(
      `[drain] tick ${tick.toString().padStart(2, "0")} (${dt}s) | scanned=${res.scannedRows} linked=${res.rowsLinked} fanned=${res.rowsFannedOut} unresolved=${res.unresolvedPhones.length} backlog_remaining=${res.backlogRemaining}`,
    );

    if (res.backlogRemaining === 0 && res.scannedRows === 0) {
      console.log(`[drain] backlog drained — exiting`);
      break;
    }

    // Tight loop is fine: each tick already makes Kommo API calls at 1 rps
    // internally, so the natural pacing is the rate limit, not a sleep.
  }

  if (tick === SAFETY_MAX_TICKS) {
    console.warn(`[drain] hit safety cap of ${SAFETY_MAX_TICKS} ticks — stopping`);
  }

  const totalSec = Math.round((Date.now() - startMs) / 1000);
  console.log(
    `[drain] done in ${totalSec}s | ticks=${tick} scanned=${totalScanned} linked=${totalLinked} fanned=${totalFanned}`,
  );
}

main().catch((err) => {
  console.error("[drain] fatal:", err);
  process.exit(1);
});
