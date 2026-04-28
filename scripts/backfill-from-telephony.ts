// Backfill analytics.communications with rows pulled directly from
// telephony providers (CallGear today; CloudTalk pending creds).
//
// Run from repo root:
//   npx tsx scripts/backfill-from-telephony.ts                           # last 30 days
//   npx tsx scripts/backfill-from-telephony.ts --days 90
//   npx tsx scripts/backfill-from-telephony.ts --from 2026-04-01 --to 2026-04-28
//   npx tsx scripts/backfill-from-telephony.ts --chunk 7                 # 7-day chunks
//
// Requires .env.local with: DATABASE_URL, ANALYTICS_DATABASE_URL,
//   CALLGEAR_ACCESS_TOKEN.

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { syncTelephony } from "../src/lib/etl/sync-telephony";

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
  const daysArg = arg("days", "30");
  const chunkArg = arg("chunk", "7");

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
  const totalChunks = Math.ceil(
    (to.getTime() - from.getTime()) / (chunkDays * 86_400_000),
  );

  console.log("=== Telephony Backfill ===");
  console.log(`Range:   ${fmt(from)} → ${fmt(to)}`);
  console.log(`Chunks:  ${totalChunks} × ${chunkDays}d`);
  console.log("");

  let cur = new Date(from);
  let n = 0;
  let totalLegs = 0;
  let totalInserted = 0;
  const allUnmatched = new Map<string, { count: number; name: string; source: string }>();
  const failures: { from: string; to: string; error: string }[] = [];

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
      const res = await syncTelephony(cur, chunkEnd);
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      totalLegs += res.callgearLegs;
      totalInserted += res.inserted;
      for (const u of res.unmatchedAgents) {
        const key = `${u.source}:${u.agentId}`;
        const existing = allUnmatched.get(key);
        if (existing) existing.count += u.count;
        else allUnmatched.set(key, { count: u.count, name: u.name, source: u.source });
      }
      console.log(
        `ok ${dt}s | cg_legs=${res.callgearLegs} inserted=${res.inserted} unmatched=${res.unmatchedAgents.length}`,
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
  console.log(`Totals: cg_legs=${totalLegs} inserted=${totalInserted}`);

  if (allUnmatched.size > 0) {
    console.log("");
    console.log(`Unmatched agents (${allUnmatched.size} unique):`);
    const sorted = [...allUnmatched.entries()].sort((a, b) => b[1].count - a[1].count);
    for (const [key, info] of sorted) {
      console.log(`  ${key.padEnd(20)} ${info.name.padEnd(40)} ${info.count} legs`);
    }
    console.log("");
    console.log(
      "Fix attribution: set master_managers.callgear_employee_id (or cloudtalk_agent_id) for each name above, then re-run.",
    );
  }

  if (failures.length > 0) {
    console.log("");
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
