// One-off backfill for sync-foreign-calls.ts — pulls Kommo /notes call_in/
// call_out rows whose pbxSource isn't CloudTalk/CallGear (WhatsApp via
// Wazzup, Zadarma, …) for the last N days, then drains enrichTelephonyLeads
// over the same window so the new rows get lead_id/pipeline_id resolved
// without waiting for cron ticks.
//
// Deliberately NOT full runSync() — this only needs syncForeignCallNotes +
// enrichment, not leads/tasks/status_changes/sla. Narrower scope = fewer
// Kommo requests for the same backfill goal.
//
// Run:   npx tsx scripts/backfill-foreign-calls.ts [--days 30]
// Reads: .env.local for KOMMO_ACCESS_TOKEN (or DB token) + ANALYTICS_DATABASE_URL + DATABASE_URL

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");

import { syncForeignCallNotes } from "../src/lib/etl/sync-foreign-calls";
import { enrichTelephonyLeads } from "../src/lib/etl/enrich-telephony-leads";

function arg(name: string, def: string): string {
  const args = process.argv.slice(2);
  const idx = args.indexOf(`--${name}`);
  if (idx < 0) return def;
  return args[idx + 1] ?? def;
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function main() {
  const days = Number(arg("days", "30"));
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

  console.log(`=== Backfill foreign call notes: ${fmt(from)} → ${fmt(to)} (${days}d) ===\n`);

  // ── Phase 1: day-by-day syncForeignCallNotes ──────────────────────
  let cur = new Date(from);
  cur.setUTCHours(0, 0, 0, 0);
  let n = 0;
  const totalDays = Math.ceil((to.getTime() - from.getTime()) / 86_400_000);
  let totalScanned = 0;
  let totalForeign = 0;
  let totalInserted = 0;
  const unmatchedTotals = new Map<number, number>();
  const failures: Array<{ day: string; error: string }> = [];

  while (cur < to) {
    n++;
    const dayEnd = new Date(Math.min(cur.getTime() + 86_400_000 - 1, to.getTime()));
    const dayStr = fmt(cur);
    const t0 = Date.now();
    process.stdout.write(`[${n}/${totalDays}] ${dayStr} ... `);
    try {
      const res = await syncForeignCallNotes(cur, dayEnd);
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      totalScanned += res.notesScanned;
      totalForeign += res.foreignNotes;
      totalInserted += res.inserted;
      for (const u of res.unmatchedManagers) {
        unmatchedTotals.set(u.kommoUserId, (unmatchedTotals.get(u.kommoUserId) ?? 0) + u.count);
      }
      console.log(`ok ${dt}s | scanned=${res.notesScanned} foreign=${res.foreignNotes} inserted=${res.inserted}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`FAILED: ${msg}`);
      failures.push({ day: dayStr, error: msg });
    }
    cur = new Date(cur.getTime() + 86_400_000);
  }

  console.log(`\n--- Phase 1 done: scanned=${totalScanned} foreign=${totalForeign} inserted=${totalInserted} ---`);
  if (unmatchedTotals.size > 0) {
    console.log("Unmatched Kommo user ids (set master_managers.kommo_user_id):");
    for (const [id, count] of unmatchedTotals) console.log(`  kommoUserId=${id} ${count} calls`);
  }
  if (failures.length > 0) {
    console.log(`Failures: ${failures.length}`);
    for (const f of failures) console.log(`  ${f.day}: ${f.error}`);
  }

  // ── Phase 2: drain enrichment (phone → lead) over the same window ──
  console.log(`\n=== Phase 2: draining enrich-telephony-leads over the same window ===`);
  const SAFETY_MAX_TICKS = 20;
  let tick = 0;
  let totalLinked = 0;
  let totalFanned = 0;
  while (tick < SAFETY_MAX_TICKS) {
    tick++;
    const t0 = Date.now();
    const res = await enrichTelephonyLeads(from, to);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    totalLinked += res.rowsLinked;
    totalFanned += res.rowsFannedOut;
    console.log(
      `[drain] tick ${tick} (${dt}s) | scanned=${res.scannedRows} linked=${res.rowsLinked} fanned=${res.rowsFannedOut} unresolved=${res.unresolvedPhones.length} backlog_remaining=${res.backlogRemaining}`,
    );
    if (res.backlogRemaining === 0 && res.scannedRows === 0) {
      console.log(`[drain] backlog drained`);
      break;
    }
  }

  console.log(`\n=== DONE === inserted=${totalInserted} linked=${totalLinked} fannedOut=${totalFanned}`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
