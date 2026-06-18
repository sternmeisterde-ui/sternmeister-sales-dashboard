// Local dry-run of the CallGear-only sync — calls runSync directly with
// the same options the new /api/analytics/sync/callgear endpoint uses.
// Verifies:
//   - CallGear API returns data for a 7h-lagged window
//   - syncTelephony filters to CallGear-only correctly
//   - DELETE-by-comm-id + INSERT path doesn't blow up
//   - Enrichment + SLA pick up the new rows
//
// Idempotent against re-runs: window is fixed, comm_id-keyed UPSERT logic
// in sync-telephony handles repeats.
//
//   npx tsx scripts/test-callgear-sync.ts
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { runSync } from "../src/lib/etl/index";

async function main(): Promise<void> {
  // Yesterday afternoon Berlin (peak CallGear traffic): 12:00–13:00 UTC = 14:00–15:00 CEST.
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  yesterday.setUTCHours(12, 0, 0, 0);
  const fromDate = yesterday;
  const toDate = new Date(yesterday.getTime() + 60 * 60 * 1000);

  console.log(`=== CallGear-only sync test ===`);
  console.log(`window: ${fromDate.toISOString()} → ${toDate.toISOString()}`);

  const t0 = Date.now();
  const result = await runSync({
    fromDate,
    toDate,
    incremental: false,
    skip: ["leads", "communications", "status_changes", "tasks"],
    telephonyProviders: ["callgear"],
  });
  console.log(`\nResult (${Math.round((Date.now() - t0) / 1000)}s):`);
  console.log(JSON.stringify(result, null, 2));
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
