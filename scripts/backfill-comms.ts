// Chunked comms + SLA backfill — run this when the initial full backfill was
// truncated by Kommo's 50K event ceiling.
//
// Processes one month at a time so each chunk stays well under 50K events.
// Leads are re-fetched per chunk to provide contactIds for call-event resolution.
// SLA is recomputed once at the end across the full date range.
//
// Usage:
//   npm run analytics:backfill:comms
//   npm run analytics:backfill:comms -- 2025-03-10 2026-04-14

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { runSync } from "../src/lib/etl/index";
import { computeSla } from "../src/lib/etl/compute-sla";

function addOneMonth(d: Date): Date {
  const next = new Date(d);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

async function main() {
  const [, , fromArg, toArg] = process.argv;

  const globalFrom = fromArg
    ? new Date(`${fromArg}T00:00:00Z`)
    : new Date("2025-03-10T00:00:00Z");

  const globalTo = toArg
    ? new Date(`${toArg}T23:59:59Z`)
    : new Date("2026-04-14T00:00:00Z");

  console.log("=== Chunked Communications Backfill ===");
  console.log(`From: ${globalFrom.toISOString()}`);
  console.log(`To:   ${globalTo.toISOString()}`);
  console.log("Processing one month at a time to stay under Kommo 50K limit");
  console.log("");

  let totalLeads = 0;
  let totalComms = 0;
  let chunkCount = 0;

  let cursor = new Date(globalFrom);

  while (cursor < globalTo) {
    const chunkFrom = new Date(cursor);
    const chunkTo = addOneMonth(cursor);
    if (chunkTo > globalTo) chunkTo.setTime(globalTo.getTime());

    console.log(
      `\n[Chunk ${++chunkCount}] ${chunkFrom.toISOString().slice(0, 10)} → ${chunkTo.toISOString().slice(0, 10)}`,
    );

    const result = await runSync({
      fromDate: chunkFrom,
      toDate: chunkTo,
      incremental: false,
      skip: ["status_changes", "tasks", "sla"],
    });

    totalLeads += result.leads;
    totalComms += result.communications;

    console.log(
      `  leads=${result.leads} comms=${result.communications} (${(result.durationMs / 1000).toFixed(1)}s)`,
    );

    cursor = chunkTo;
  }

  // Recompute SLA for the full backfill range now that all comms are populated
  console.log(`\n=== Recomputing SLA for full range ${globalFrom.toISOString().slice(0, 10)} → ${globalTo.toISOString().slice(0, 10)} ===`);
  const slaRows = await computeSla(globalFrom, globalTo);

  console.log("\n=== Backfill complete ===");
  console.log(`Chunks processed: ${chunkCount}`);
  console.log(`Total leads re-synced: ${totalLeads}`);
  console.log(`Total comms inserted: ${totalComms}`);
  console.log(`SLA rows computed: ${slaRows}`);
}

main().catch((err) => {
  console.error("\n=== Backfill FAILED ===");
  console.error(err);
  process.exit(1);
});
