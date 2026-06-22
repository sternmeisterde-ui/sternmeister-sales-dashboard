// Targeted backfill for analytics.communications.wait_seconds.
//
// Pulls CDRs from CloudTalk + CallGear over a date range and UPDATEs the
// wait_seconds column by communication_id. Unlike a full telephony re-sync,
// this does NOT delete/re-insert rows — so lead_id / pipeline_id enrichment
// stays intact — and it never touches Kommo (no rate-limit bottleneck).
//
// One UPDATE keyed on communication_id covers all copies of a call (the raw
// row + every Pattern-A fan-out copy), so attributed and unattributed rows
// get the same value.
//
// Run from repo root:
//   npx tsx scripts/backfill-call-wait.ts --from 2026-01-01 --to 2026-06-22
//   npx tsx scripts/backfill-call-wait.ts --days 30
//   npx tsx scripts/backfill-call-wait.ts --from 2026-01-01 --to 2026-06-22 --chunk 7
//
// Requires .env.local with ANALYTICS_DATABASE_URL + CALLGEAR_ACCESS_TOKEN +
// CLOUDTALK_API_ID / CLOUDTALK_API_SECRET.

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { analyticsDb } from "../src/lib/db/analytics";
import { getCallsByDate as getCallGearCallsByDate } from "../src/lib/telephony/callgear";
import { getCallsByDate as getCloudTalkCallsByDate } from "../src/lib/telephony/cloudtalk";
import type { TelephonyCall } from "../src/lib/telephony/types";

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

const UPDATE_BATCH = 500;

/** Bulk UPDATE wait_seconds for a batch of {id, wait} via jsonb_to_recordset. */
async function applyWaits(pairs: { id: string; wait: number }[]): Promise<number> {
  let updated = 0;
  for (let i = 0; i < pairs.length; i += UPDATE_BATCH) {
    const batch = pairs.slice(i, i + UPDATE_BATCH);
    const json = JSON.stringify(batch);
    const res = await analyticsDb.execute<{ communication_id: string }>(sql`
      UPDATE analytics.communications c
      SET wait_seconds = w.wait
      FROM jsonb_to_recordset(${json}::jsonb) AS w(id text, wait integer)
      WHERE c.communication_id = w.id
        AND c.communication_type IN ('call_in', 'call_out')
      RETURNING c.communication_id
    `);
    updated += res.rows.length;
  }
  return updated;
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
  const totalChunks = Math.ceil((to.getTime() - from.getTime()) / (chunkDays * 86_400_000));

  console.log("=== wait_seconds backfill ===");
  console.log(`Range:  ${fmt(from)} → ${fmt(to)}`);
  console.log(`Chunks: ${totalChunks} × ${chunkDays}d`);
  console.log("");

  let cur = new Date(from);
  let n = 0;
  let totalPulled = 0;
  let totalUpdated = 0;
  const overallStart = Date.now();

  while (cur <= to) {
    n++;
    const chunkEndMs = Math.min(cur.getTime() + (chunkDays - 1) * 86_400_000, to.getTime());
    const chunkEnd = new Date(chunkEndMs);
    chunkEnd.setUTCHours(23, 59, 59, 999);
    const t0 = Date.now();
    process.stdout.write(`[${n}/${totalChunks}] ${fmt(cur)} → ${fmt(new Date(chunkEndMs))} ... `);

    try {
      const [cg, ct] = await Promise.all([
        getCallGearCallsByDate(cur, chunkEnd).catch((e) => {
          console.warn(`\n  CallGear failed: ${e instanceof Error ? e.message : e}`);
          return [] as TelephonyCall[];
        }),
        process.env.CLOUDTALK_API_ID
          ? getCloudTalkCallsByDate(cur, chunkEnd).catch((e) => {
              console.warn(`\n  CloudTalk failed: ${e instanceof Error ? e.message : e}`);
              return [] as TelephonyCall[];
            })
          : Promise.resolve([] as TelephonyCall[]),
      ]);

      const pairs = [...cg, ...ct].map((c) => ({ id: c.externalId, wait: Math.max(0, Math.round(c.waitSec ?? 0)) }));
      totalPulled += pairs.length;
      const updated = pairs.length > 0 ? await applyWaits(pairs) : 0;
      totalUpdated += updated;
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`ok ${dt}s | pulled=${pairs.length} updated=${updated}`);
    } catch (err) {
      console.log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }

    cur = new Date(chunkEndMs + 86_400_000);
    cur.setUTCHours(0, 0, 0, 0);
  }

  console.log("");
  console.log("=== DONE ===");
  console.log(`Wall: ${((Date.now() - overallStart) / 1000).toFixed(1)}s`);
  console.log(`Pulled=${totalPulled} rows updated=${totalUpdated}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("fatal:", err);
    process.exit(1);
  });
