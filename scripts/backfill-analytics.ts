// One-time backfill: pulls ALL Kommo data from 2025-03-10 to today into analytics.*
// Run: npm run analytics:backfill
// Or with date range: npx tsx scripts/backfill-analytics.ts 2025-03-10 2026-04-23

import { config } from "dotenv";
import { resolve } from "node:path";

// Load .env.local before importing anything that reads env vars
config({ path: resolve(process.cwd(), ".env.local") });

import { runSync } from "../src/lib/etl/index";

async function main() {
  const [,, fromArg, toArg] = process.argv;

  const fromDate = fromArg
    ? new Date(`${fromArg}T00:00:00Z`)
    : new Date("2025-03-10T00:00:00Z");

  const toDate = toArg
    ? new Date(`${toArg}T23:59:59Z`)
    : new Date();

  console.log("=== Analytics Backfill ===");
  console.log(`From: ${fromDate.toISOString()}`);
  console.log(`To:   ${toDate.toISOString()}`);
  console.log("This may take several minutes due to Kommo rate limits (7 req/s)");
  console.log("");

  const result = await runSync({ fromDate, toDate, incremental: false });
  console.log("\n=== Backfill complete ===");
  console.log(`Leads:          ${result.leads}`);
  console.log(`Communications: ${result.communications}`);
  console.log(`Status changes: ${result.statusChanges}`);
  console.log(`Tasks:          ${result.tasks}`);
  console.log(`SLA rows:       ${result.slaRows}`);
  console.log(`Duration:       ${(result.durationMs / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error("\n=== Backfill FAILED ===");
  console.error(err);
  process.exit(1);
});
