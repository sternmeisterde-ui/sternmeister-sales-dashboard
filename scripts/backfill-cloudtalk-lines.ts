// Targeted backfill for CloudTalk line_name + missed (no-agent) inbound rows.
//
// Non-destructive: UPDATEs line_name on existing rows by communication_id
// (keeps lead/pipeline enrichment intact) and INSERTs the no-agent CDRs we used
// to skip (queue rings / missed inbound), so historical inbound-by-line matches
// CloudTalk's group report. Does NOT re-run the full telephony sync.
//
// Run from repo root:
//   npx tsx scripts/backfill-cloudtalk-lines.ts --days 31
//   npx tsx scripts/backfill-cloudtalk-lines.ts --from 2026-05-25 --to 2026-06-24
//
// Requires .env.local with ANALYTICS_DATABASE_URL + CLOUDTALK_API_ID/SECRET.

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import dns from "node:dns";
import net from "node:net";
dns.setDefaultResultOrder("ipv4first");
net.setDefaultAutoSelectFamily(true);
net.setDefaultAutoSelectFamilyAttemptTimeout(500);

import { sql } from "drizzle-orm";
import { analyticsDb } from "../src/lib/db/analytics";
import { communications } from "../src/lib/db/schema-analytics";
import { getCallsByDate } from "../src/lib/telephony/cloudtalk";
import { callToCommRow } from "../src/lib/etl/sync-telephony";

function arg(name: string, def: string | null = null): string | null {
  const a = process.argv.slice(2); const i = a.indexOf(`--${name}`);
  if (i < 0) return def; const v = a[i + 1]; return v && !v.startsWith("--") ? v : "true";
}
function parseDay(s: string): Date { const d = new Date(`${s}T00:00:00Z`); if (Number.isNaN(d.getTime())) throw new Error(`Bad date ${s}`); return d; }
function fmt(d: Date): string { return d.toISOString().slice(0, 10); }

const BATCH = 500;

async function main() {
  const fromArg = arg("from"), toArg = arg("to"), daysArg = arg("days", "31");
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  let from: Date, to: Date;
  if (fromArg && toArg) { from = parseDay(fromArg); to = parseDay(toArg); }
  else { from = new Date(today.getTime() - Number(daysArg) * 86400000); to = new Date(today); }
  to.setUTCHours(23, 59, 59, 999);

  console.log(`=== CloudTalk line_name backfill: ${fmt(from)} → ${fmt(to)} ===`);
  let totalUpdated = 0, totalInserted = 0, totalPulled = 0;

  let cur = new Date(from);
  while (cur <= to) {
    const chunkEnd = new Date(Math.min(cur.getTime() + 86400000 - 1, to.getTime()));
    process.stdout.write(`[${fmt(cur)}] `);
    const calls = await getCallsByDate(cur, chunkEnd);
    totalPulled += calls.length;

    // 1) UPDATE line_name on existing rows (by communication_id).
    const pairs = calls.filter(c => c.lineName).map(c => ({ id: c.externalId, line: c.lineName }));
    let updated = 0;
    for (let i = 0; i < pairs.length; i += BATCH) {
      const json = JSON.stringify(pairs.slice(i, i + BATCH));
      const res = await analyticsDb.execute<{ communication_id: string }>(sql`
        UPDATE analytics.communications c SET line_name = w.line
        FROM jsonb_to_recordset(${json}::jsonb) AS w(id text, line text)
        WHERE c.communication_id = w.id AND c.line_name IS DISTINCT FROM w.line
        RETURNING c.communication_id`);
      updated += res.rows.length;
    }

    // 2) INSERT no-agent rows (missed/queue) we used to skip. ON CONFLICT DO
    //    NOTHING so re-runs are idempotent; line_name set, manager NULL.
    const noAgentRows = calls.filter(c => c.noAgent).map(c => callToCommRow(c, null, ""));
    let inserted = 0;
    for (let i = 0; i < noAgentRows.length; i += BATCH) {
      const slice = noAgentRows.slice(i, i + BATCH);
      await analyticsDb.insert(communications).values(slice).onConflictDoNothing();
      inserted += slice.length;
    }

    totalUpdated += updated; totalInserted += inserted;
    console.log(`pulled=${calls.length} line_updated=${updated} no_agent_ins=${inserted}`);
    cur = new Date(chunkEnd.getTime() + 1); cur.setUTCHours(0, 0, 0, 0);
  }

  console.log(`\n=== DONE === pulled=${totalPulled} line_updated=${totalUpdated} no_agent_inserted=${totalInserted}`);
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
