// Day-by-day backfill of analytics.* — uses small chunks so each chunk
// fits comfortably inside Kommo's rate budget and Neon's connection
// timeout. Designed for re-running after a fetch-logic bugfix where the
// month-by-month script's first chunk would otherwise stall for 20+ min
// on busy windows.
//
// Run from repo root:
//   npx tsx scripts/backfill-by-day.ts                       # last 90 days
//   npx tsx scripts/backfill-by-day.ts --days 30             # last 30
//   npx tsx scripts/backfill-by-day.ts --from 2026-01-28 --to 2026-04-28
//   npx tsx scripts/backfill-by-day.ts --chunk 2             # 2-day chunks
//   npx tsx scripts/backfill-by-day.ts --skip-status         # skip status_changes
//
// Requires .env.local with: DATABASE_URL, ANALYTICS_DATABASE_URL,
//   KOMMO_ACCESS_TOKEN (or kommo_tokens row in D1), TELEGRAM_*.

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { runSync } from "../src/lib/etl/index";

function arg(name: string, def: string | null = null): string | null {
  const args = process.argv.slice(2);
  const idx = args.indexOf(`--${name}`);
  if (idx < 0) return def;
  const v = args[idx + 1];
  return v && !v.startsWith("--") ? v : "true";
}

function parseDay(s: string): Date {
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Bad date: ${s}. Use YYYY-MM-DD.`);
  }
  return d;
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function main() {
  const fromArg = arg("from");
  const toArg = arg("to");
  const daysArg = arg("days", "90");
  const chunkArg = arg("chunk", "1");
  const skipTasks = arg("skip-tasks") === "true";
  const skipStatus = arg("skip-status") === "true";

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  let from: Date;
  let to: Date;
  if (fromArg && toArg) {
    from = parseDay(fromArg);
    to = parseDay(toArg);
  } else if (fromArg) {
    from = parseDay(fromArg);
    to = new Date(today);
  } else {
    const days = Number(daysArg);
    if (!Number.isFinite(days) || days <= 0) throw new Error(`Bad --days: ${daysArg}`);
    from = new Date(today.getTime() - days * 86_400_000);
    to = new Date(today);
  }
  to.setUTCHours(23, 59, 59, 999);

  const chunkDays = Math.max(1, Number(chunkArg));
  const skip: Parameters<typeof runSync>[0]["skip"] = [];
  if (skipStatus) skip.push("status_changes");
  if (skipTasks) skip.push("tasks");

  const totalChunks = Math.ceil(
    (to.getTime() - from.getTime()) / (chunkDays * 86_400_000),
  );

  console.log("=== Day-by-day Analytics Backfill ===");
  console.log(`Range:   ${fmt(from)} → ${fmt(to)}`);
  console.log(`Chunks:  ${totalChunks} × ${chunkDays}d`);
  console.log(`Skip:    ${skip.length > 0 ? skip.join(",") : "(none)"}`);
  console.log("");

  let cur = new Date(from);
  let n = 0;
  let totalLeads = 0;
  let totalComms = 0;
  let totalStatus = 0;
  let totalTasks = 0;
  let totalSla = 0;
  const failures: Array<{ from: string; to: string; error: string }> = [];

  const overallStart = Date.now();
  while (cur <= to) {
    n++;
    const chunkEndMs = Math.min(
      cur.getTime() + (chunkDays - 1) * 86_400_000,
      to.getTime(),
    );
    const chunkEnd = new Date(chunkEndMs);
    chunkEnd.setUTCHours(23, 59, 59, 999);

    const fromStr = fmt(cur);
    const toStr = fmt(new Date(chunkEndMs));
    const t0 = Date.now();
    process.stdout.write(`[${n}/${totalChunks}] ${fromStr} → ${toStr} ... `);

    try {
      const res = await runSync({
        fromDate: cur,
        toDate: chunkEnd,
        skip,
      });
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      totalLeads += res.leads;
      totalComms += res.communications;
      totalStatus += res.statusChanges;
      totalTasks += res.tasks;
      totalSla += res.slaRows;
      console.log(
        `ok ${dt}s | leads=${res.leads} comms=${res.communications} sla=${res.slaRows} status=${res.statusChanges} tasks=${res.tasks}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`FAILED: ${msg}`);
      failures.push({ from: fromStr, to: toStr, error: msg });
    }

    cur = new Date(chunkEndMs + 86_400_000);
    cur.setUTCHours(0, 0, 0, 0);
  }

  const total = ((Date.now() - overallStart) / 1000).toFixed(1);
  console.log("");
  console.log("=== DONE ===");
  console.log(`Wall: ${total}s`);
  console.log(
    `Totals: leads=${totalLeads} comms=${totalComms} sla=${totalSla} status=${totalStatus} tasks=${totalTasks}`,
  );
  if (failures.length > 0) {
    console.log(`Failures: ${failures.length}`);
    for (const f of failures) console.log(`  ${f.from} → ${f.to}: ${f.error}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("fatal:", err);
    process.exit(1);
  });
