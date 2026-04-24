// Backfill analytics.* from Kommo API month-by-month.
// Run: npx tsx scripts/backfill-analytics.ts [from=2026-01-01] [to=TODAY]
//
// Re-syncs leads + communications + SLA for the range so that new columns
// (first_payment_date, first_payment_amount, prepayment_date, prepayment_amount,
//  closed_at) get populated for historical rows. Safe to re-run.

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { runSync } from "../src/lib/etl/index";

async function main() {
  const args = process.argv.slice(2);
  const full = args.includes("--full");
  // Second-pass mode: only syncs what FAST skipped (status_changes + tasks),
  // without re-pulling leads/communications/SLA that already landed in Phase 1.
  const statusOnly = args.includes("--status-only");
  // Third-pass mode: refetch leads by updated_at so any custom-field UPDATES
  // (payments, closure reasons) applied after initial created_at-based sync
  // land in the DB. Critical for any field that gets filled post-creation.
  const updatedAt = args.includes("--updated-at");
  const dateArgs = args.filter((a) => !a.startsWith("--"));
  const [fromArg, toArg] = dateArgs;

  const fromStr = fromArg ?? "2026-01-01";
  const toStr = toArg ?? new Date().toISOString().slice(0, 10);

  const fromDate = new Date(`${fromStr}T00:00:00Z`);
  const toDateFinal = new Date(`${toStr}T23:59:59Z`);

  let modeLabel: string;
  if (updatedAt) modeLabel = "UPDATED-AT (refresh leads by update window — refreshes payments/closures on old leads)";
  else if (statusOnly) modeLabel = "STATUS-ONLY (only status_changes + tasks)";
  else if (full) modeLabel = "FULL (all tables)";
  else modeLabel = "FAST (skip status_changes + tasks)";

  console.log("=== Analytics Backfill (month-by-month) ===");
  console.log(`Range: ${fromDate.toISOString()} → ${toDateFinal.toISOString()}`);
  console.log(`Mode:  ${modeLabel}`);
  console.log("Kommo rate limit = 7 req/s; expect ~2-5min per month (+3-5min each for status/tasks in FULL/STATUS-ONLY).\n");

  const cursor = new Date(Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), 1, 0, 0, 0));

  const totals = { leads: 0, communications: 0, statusChanges: 0, tasks: 0, slaRows: 0, durationMs: 0 };

  while (cursor <= toDateFinal) {
    const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0, 23, 59, 59));
    const windowStart = cursor < fromDate ? fromDate : cursor;
    const windowEnd = monthEnd > toDateFinal ? toDateFinal : monthEnd;

    const label = cursor.toISOString().slice(0, 7);
    console.log(`\n[${label}] ${windowStart.toISOString().slice(0, 10)} → ${windowEnd.toISOString().slice(0, 10)}`);

    const t0 = Date.now();
    try {
      // Skip matrix:
      //   --updated-at  → run only leads (by updated_at) + SLA — catches payment
      //                   updates. Skip comms/sc/tasks to keep it fast.
      //   --status-only → leads/comms/sla already done, only need sc+tasks
      //   --full        → run everything
      //   (default)     → fast path: skip sc+tasks for speed, run the rest
      const skip: Parameters<typeof runSync>[0]["skip"] = updatedAt
        ? ["communications", "status_changes", "tasks"]
        : statusOnly
          ? ["leads", "communications", "sla"]
          : full
            ? []
            : ["status_changes", "tasks"];

      const res = await runSync({
        fromDate: windowStart,
        toDate: windowEnd,
        // incremental=true → sync-leads uses updated_at window (catches updates).
        incremental: updatedAt,
        skip,
      });
      console.log(
        `[${label}] done in ${((Date.now() - t0) / 1000).toFixed(1)}s — leads=${res.leads} comms=${res.communications} sc=${res.statusChanges} tasks=${res.tasks} sla=${res.slaRows}`,
      );
      totals.leads += res.leads;
      totals.communications += res.communications;
      totals.statusChanges += res.statusChanges;
      totals.tasks += res.tasks;
      totals.slaRows += res.slaRows;
      totals.durationMs += res.durationMs;
    } catch (e) {
      console.error(`[${label}] FAILED:`, e instanceof Error ? e.message : String(e));
    }

    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  console.log("\n=== TOTAL ===");
  console.log(
    `leads=${totals.leads} comms=${totals.communications} sla=${totals.slaRows} time=${(totals.durationMs / 1000).toFixed(1)}s`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("fatal:", err);
    process.exit(1);
  });
