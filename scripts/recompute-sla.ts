// Re-compute analytics.sla over a window. Run after enrich-telephony-leads
// so SLA picks up the newly-linked first_call_out_at on telephony rows.
//
// Run from repo root:
//   npx tsx scripts/recompute-sla.ts                                # last 30 days
//   npx tsx scripts/recompute-sla.ts --from 2026-01-01 --to 2026-04-28
//   npx tsx scripts/recompute-sla.ts --from 2026-01-01 --to 2026-04-28 --chunk 7
//
// Requires .env.local with: DATABASE_URL, ANALYTICS_DATABASE_URL.

import { config } from "dotenv";
import { resolve } from "node:path";
import dns from "node:dns";
import net from "node:net";

// IPv4-first как в src/instrumentation.ts: на сетях с битым IPv6 Neon-драйвер
// иначе виснет на AAAA-адресе до таймаута (см. memory neon-ipv6-hang).
dns.setDefaultResultOrder("ipv4first");
net.setDefaultAutoSelectFamily(true);
net.setDefaultAutoSelectFamilyAttemptTimeout(500);

config({ path: resolve(process.cwd(), ".env.local") });

import { computeSla } from "../src/lib/etl/compute-sla";

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

  console.log("=== SLA Recompute ===");
  console.log(`Range:  ${fmt(from)} → ${fmt(to)}`);
  console.log(`Chunks: ${totalChunks} × ${chunkDays}d`);
  console.log("");

  let cur = new Date(from);
  let n = 0;
  let totalRows = 0;
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
      const rows = await computeSla(cur, chunkEnd);
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      totalRows += rows;
      console.log(`ok ${dt}s | sla_rows=${rows}`);
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
  console.log(`Wall:  ${total}s`);
  console.log(`Total: ${totalRows} SLA rows updated`);

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
