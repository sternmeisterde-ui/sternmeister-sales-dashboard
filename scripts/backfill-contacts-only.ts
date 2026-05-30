// Backfill ONLY leads + contacts (no telephony / comms / status_changes /
// tasks / SLA). Use to populate analytics.contacts + lead_contact_links for
// a historical window without paying the cost of full ETL.
//
// Run:
//   npx tsx scripts/backfill-contacts-only.ts 2025-11-29 2026-05-29
//
// Defaults if args omitted: last 6 months ending today.
//
// Speed: ~30-60s per month (only 2 Kommo endpoints — /leads with embedded
// contact ids, then /contacts in batches of 250). Compare to the full
// backfill-analytics.ts which can take 20+ min per month due to telephony.
// Re-runnable: ON CONFLICT DO UPDATE on both tables.

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { runSync } from "../src/lib/etl/index";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [fromArg, toArg] = args.filter((a) => !a.startsWith("--"));

  const today = new Date();
  const sixMonthsAgo = new Date(today.getTime() - 183 * 86_400_000);

  const fromStr = fromArg ?? sixMonthsAgo.toISOString().slice(0, 10);
  const toStr = toArg ?? today.toISOString().slice(0, 10);

  const fromDate = new Date(`${fromStr}T00:00:00Z`);
  const toDate = new Date(`${toStr}T23:59:59Z`);

  console.log("=== Contacts-only backfill (month-by-month) ===");
  console.log(`Range: ${fromDate.toISOString().slice(0, 10)} → ${toDate.toISOString().slice(0, 10)}`);
  console.log("Steps per chunk: sync-leads → sync-contacts (everything else skipped).");
  console.log("Kommo: 1 req per 250 leads + 1 req per 250 contacts at 1 rps.\n");

  const cursor = new Date(
    Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), 1, 0, 0, 0),
  );

  const totals = { leads: 0, contacts: 0, durationMs: 0, errors: 0 };

  while (cursor <= toDate) {
    const monthEnd = new Date(
      Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0, 23, 59, 59),
    );
    const windowStart = cursor < fromDate ? fromDate : cursor;
    const windowEnd = monthEnd > toDate ? toDate : monthEnd;

    const label = cursor.toISOString().slice(0, 7);
    console.log(
      `\n[${label}] ${windowStart.toISOString().slice(0, 10)} → ${windowEnd.toISOString().slice(0, 10)}`,
    );

    const t0 = Date.now();
    try {
      const res = await runSync({
        fromDate: windowStart,
        toDate: windowEnd,
        // Only leads + contacts. Everything else is skipped so we don't
        // burn Kommo / telephony quota on data we don't need here.
        skip: ["communications", "status_changes", "tasks", "sla", "telephony"],
      });
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(
        `[${label}] done in ${elapsed}s — leads=${res.leads} contacts=${res.contacts} stepErrors=${res.stepErrors.length}`,
      );
      if (res.stepErrors.length > 0) {
        for (const err of res.stepErrors) {
          console.log(`  ! ${err.step}: ${err.message}`);
        }
      }
      totals.leads += res.leads;
      totals.contacts += res.contacts;
      totals.durationMs += res.durationMs;
      totals.errors += res.stepErrors.length;
    } catch (e) {
      console.error(
        `[${label}] FAILED:`,
        e instanceof Error ? e.message : String(e),
      );
      totals.errors += 1;
    }

    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  console.log("\n=== TOTAL ===");
  console.log(
    `leads=${totals.leads} contacts=${totals.contacts} errors=${totals.errors} time=${(totals.durationMs / 1000).toFixed(1)}s`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("fatal:", err);
    process.exit(1);
  });
