// Termin-focused chunked backfill — only the two tables that drive
// /api/dashboard/termins:
//   • analytics.leads_cohort       ← syncLeads (termin_date, aa_termin_date)
//   • analytics.lead_status_changes ← syncStatusChanges (TERM_DC_DONE events)
//
// Skips communications / telephony / tasks / SLA — those are unaffected by
// the new columns and run independently in the regular ETL cron.
//
// Usage:
//   npx tsx scripts/backfill-termins.ts                             # last 90 days
//   npx tsx scripts/backfill-termins.ts --from 2026-01-01 --to 2026-04-28
//   npx tsx scripts/backfill-termins.ts --from 2026-01-01 --to 2026-04-28 --chunk 7
//
// On chunk failure: logs the failing window and continues with the next
// chunk — re-run the script on the same range later to retry only the gaps.

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { fetchLookups } from "../src/lib/etl/lookups";
import { syncLeads } from "../src/lib/etl/sync-leads";
import { syncStatusChanges } from "../src/lib/etl/sync-status-changes";

interface Args {
  from: Date;
  to: Date;
  chunkDays: number;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const get = (name: string): string | null => {
    const idx = args.indexOf(`--${name}`);
    if (idx < 0) return null;
    const v = args[idx + 1];
    return v && !v.startsWith("--") ? v : null;
  };

  const parseDay = (s: string): Date => {
    const d = new Date(`${s}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`Bad date "${s}". Use YYYY-MM-DD.`);
    }
    return d;
  };

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const fromArg = get("from");
  const toArg = get("to");
  const chunkArg = get("chunk");
  const daysArg = get("days");

  let from: Date;
  let to: Date;
  if (fromArg && toArg) {
    from = parseDay(fromArg);
    to = parseDay(toArg);
  } else {
    const days = Number(daysArg ?? "90");
    if (!Number.isFinite(days) || days <= 0) {
      throw new Error(`Bad --days ${daysArg}`);
    }
    to = today;
    from = new Date(today);
    from.setUTCDate(from.getUTCDate() - days);
  }

  const chunkDays = Number(chunkArg ?? "7");
  if (!Number.isFinite(chunkDays) || chunkDays <= 0) {
    throw new Error(`Bad --chunk ${chunkArg}`);
  }

  return { from, to, chunkDays };
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const { from, to, chunkDays } = parseArgs();

  console.log("=".repeat(60));
  console.log(`Termin backfill: ${fmt(from)} → ${fmt(to)}, chunk=${chunkDays}d`);
  console.log("=".repeat(60));

  const lookups = await fetchLookups();
  console.log(
    `[lookups] pipelines=${lookups.pipelines.size} users=${lookups.users.size}`,
  );

  let totalLeads = 0;
  let totalStatusChanges = 0;
  const failures: Array<{ from: string; to: string; reason: string }> = [];

  let cursor = new Date(from);
  while (cursor.getTime() <= to.getTime()) {
    const chunkFrom = new Date(cursor);
    const chunkTo = new Date(cursor);
    chunkTo.setUTCDate(chunkTo.getUTCDate() + chunkDays - 1);
    chunkTo.setUTCHours(23, 59, 59, 999);
    if (chunkTo.getTime() > to.getTime()) {
      chunkTo.setTime(to.getTime());
      chunkTo.setUTCHours(23, 59, 59, 999);
    }

    const tag = `${fmt(chunkFrom)}..${fmt(chunkTo)}`;
    const t0 = Date.now();
    try {
      // Leads must run before status changes — syncStatusChanges needs the
      // leadCache for pipeline/manager metadata.
      const leadCache = await syncLeads(chunkFrom, chunkTo, lookups, "created_at");
      const sc = await syncStatusChanges(chunkFrom, chunkTo, leadCache, lookups);
      totalLeads += leadCache.length;
      totalStatusChanges += sc;
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(
        `  ✓ ${tag} — leads=${leadCache.length} status_changes=${sc} (${dt}s)`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ ${tag} — ${reason}`);
      failures.push({ from: fmt(chunkFrom), to: fmt(chunkTo), reason });
    }

    cursor = new Date(chunkTo);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    cursor.setUTCHours(0, 0, 0, 0);
  }

  console.log("=".repeat(60));
  console.log(
    `DONE — leads=${totalLeads} status_changes=${totalStatusChanges} failures=${failures.length}`,
  );
  if (failures.length > 0) {
    console.log("Failed chunks (re-run script with same args to retry):");
    for (const f of failures) console.log(`  ${f.from}..${f.to} — ${f.reason}`);
  }
  console.log("=".repeat(60));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
