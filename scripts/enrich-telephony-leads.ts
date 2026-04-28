// Phone→lead enrichment for telephony-sourced rows in analytics.communications.
// Idempotent: re-runs skip already-linked rows (lead_id IS NOT NULL).
//
// Run from repo root:
//   npx tsx scripts/enrich-telephony-leads.ts                                # last 30 days
//   npx tsx scripts/enrich-telephony-leads.ts --from 2026-01-01 --to 2026-04-28
//   npx tsx scripts/enrich-telephony-leads.ts --from 2026-01-01 --to 2026-04-28 --chunk 7
//
// Requires .env.local with: DATABASE_URL, ANALYTICS_DATABASE_URL,
//   KOMMO_ACCESS_TOKEN (or kommo_tokens row in D1).

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { enrichTelephonyLeads } from "../src/lib/etl/enrich-telephony-leads";

function arg(name: string, def: string | null = null): string | null {
  const args = process.argv.slice(2);
  const idx = args.indexOf(`--${name}`);
  if (idx < 0) return def;
  const v = args[idx + 1];
  return v && !v.startsWith("--") ? v : "true";
}

function parseDay(s: string): Date {
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Bad date: ${s}. Use YYYY-MM-DD.`);
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

  console.log("=== Phone→Lead Enrichment ===");
  console.log(`Range:  ${fmt(from)} → ${fmt(to)}`);
  console.log(`Chunks: ${totalChunks} × ${chunkDays}d`);
  console.log("");

  let cur = new Date(from);
  let n = 0;
  let totalScanned = 0;
  let totalQueried = 0;
  let totalResolved = 0;
  let totalLinked = 0;
  let totalFannedOut = 0;
  const allUnresolved = new Set<string>();
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
      const res = await enrichTelephonyLeads(cur, chunkEnd);
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      totalScanned += res.scannedRows;
      totalQueried += res.phonesQueried;
      totalResolved += res.phonesResolved;
      totalLinked += res.rowsLinked;
      totalFannedOut += res.rowsFannedOut;
      for (const p of res.unresolvedPhones) allUnresolved.add(p);
      console.log(
        `ok ${dt}s | scanned=${res.scannedRows} queried=${res.phonesQueried}` +
        ` resolved=${res.phonesResolved} linked=${res.rowsLinked}` +
        ` fannedOut=${res.rowsFannedOut} unresolved=${res.unresolvedPhones.length}`,
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
  console.log(`Wall:           ${total}s`);
  console.log(`Rows scanned:   ${totalScanned}`);
  console.log(`Phones queried: ${totalQueried}`);
  console.log(`Phones resolved:${totalResolved}`);
  console.log(`Rows linked:    ${totalLinked}`);
  console.log(`Rows fanned out:${totalFannedOut}`);
  console.log(`Unresolved (unique): ${allUnresolved.size}`);

  if (allUnresolved.size > 0 && allUnresolved.size <= 20) {
    console.log("");
    console.log("Sample unresolved phones (no Kommo contact match):");
    for (const p of Array.from(allUnresolved).slice(0, 20)) console.log(`  ${p}`);
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
