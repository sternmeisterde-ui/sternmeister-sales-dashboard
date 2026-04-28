// Day-by-day backfill of tracking_events — pulls Kommo calls + CRM activity
// for one or both departments, in small chunks so each request fits inside
// rate-limits and the per-request timeout. Designed for re-populating after
// a TRUNCATE / filter_version bump, where the on-demand backfill triggered
// by the Активность tab would block the HTTP request for too long.
//
// Run from repo root:
//   npx tsx scripts/backfill-tracking.ts                         # both depts, last 90 days
//   npx tsx scripts/backfill-tracking.ts --dept b2g --days 30
//   npx tsx scripts/backfill-tracking.ts --dept b2b --from 2026-01-28 --to 2026-04-28
//   npx tsx scripts/backfill-tracking.ts --chunk 3               # 3-day chunks
//
// Requires .env.local with TRACKING_DATABASE_URL, DATABASE_URL, KOMMO_*.

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { syncDepartment } from "../src/lib/tracking/sync";
import { tzOffsetMinutes } from "../src/lib/utils/date";
import { trackingDb } from "../src/lib/db/tracking-db";
import { trackingEvents } from "../src/lib/db/schema-tracking";
import { EVENT_TYPES, EVENT_TYPE_MAP } from "../src/lib/tracking/event-types";
import { and, eq, gte, lte, sql } from "drizzle-orm";

// Customer-scoped types are in EVENT_TYPES for UI parity but Kommo's
// /events filter[entity] doesn't accept "customer", so we can never fetch
// them. Don't flag them in the missing-coverage report.
const KNOWN_UNFETCHABLE = new Set<string>([
  "customer_added",
  "customer_deleted",
  "customer_status_changed",
  "customer_linked",
  "customer_unlinked",
]);

type Dept = "b2g" | "b2b";

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

// Berlin-local calendar date → UTC bounds. Same convention as the GET
// /api/tracking route — start = Berlin 00:00 of `from`, end = Berlin 24:00
// of `to`. Offset computed per-instant so DST flips stay correct.
function berlinDayBounds(from: Date, to: Date): { windowFrom: Date; windowTo: Date } {
  const offFrom = tzOffsetMinutes(from, "Europe/Berlin");
  const offTo = tzOffsetMinutes(to, "Europe/Berlin");
  return {
    windowFrom: new Date(from.getTime() - offFrom * 60_000),
    windowTo: new Date(to.getTime() + (24 * 60 - offTo) * 60_000),
  };
}

async function backfillDept(
  department: Dept,
  from: Date,
  to: Date,
  chunkDays: number,
): Promise<void> {
  const totalChunks = Math.ceil(
    (to.getTime() - from.getTime()) / (chunkDays * 86_400_000),
  ) || 1;

  console.log(`\n=== ${department.toUpperCase()} ===`);
  console.log(`Range:  ${fmt(from)} → ${fmt(to)}`);
  console.log(`Chunks: ${totalChunks} × ${chunkDays}d`);
  console.log("");

  let cur = new Date(from);
  let n = 0;
  let totalInserted = 0;
  const failures: Array<{ from: string; to: string; error: string }> = [];

  const overallStart = Date.now();
  while (cur <= to) {
    n++;
    const chunkEndMs = Math.min(
      cur.getTime() + (chunkDays - 1) * 86_400_000,
      to.getTime(),
    );
    const chunkEnd = new Date(chunkEndMs);

    const fromStr = fmt(cur);
    const toStr = fmt(chunkEnd);
    const t0 = Date.now();
    process.stdout.write(`[${n}/${totalChunks}] ${fromStr} → ${toStr} ... `);

    try {
      const { windowFrom, windowTo } = berlinDayBounds(cur, chunkEnd);
      const res = await syncDepartment(department, {
        windowFrom,
        windowTo,
        isBackfill: true,
        force: true,
      });
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      totalInserted += res.inserted;
      console.log(`ok ${dt}s | inserted=${res.inserted}`);
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
  console.log(`${department}: wall=${total}s inserted=${totalInserted}`);
  if (failures.length > 0) {
    console.log(`failures: ${failures.length}`);
    for (const f of failures) console.log(`  ${f.from} → ${f.to}: ${f.error}`);
  }
}

async function main() {
  const fromArg = arg("from");
  const toArg = arg("to");
  const daysArg = arg("days", "90");
  const chunkArg = arg("chunk", "1");
  const deptArg = arg("dept");

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

  const chunkDays = Math.max(1, Number(chunkArg));
  if (!Number.isFinite(chunkDays)) throw new Error(`Bad --chunk: ${chunkArg}`);

  const depts: Dept[] = deptArg === "b2g" || deptArg === "b2b"
    ? [deptArg]
    : ["b2g", "b2b"];

  console.log("=== Tracking Backfill ===");
  console.log(`Depts:  ${depts.join(", ")}`);
  console.log(`Range:  ${fmt(from)} → ${fmt(to)}`);
  console.log(`Chunk:  ${chunkDays}d`);

  for (const dept of depts) {
    await backfillDept(dept, from, to, chunkDays);
  }

  // Coverage report — confirm all declared EVENT_TYPES actually landed in the
  // cache for the backfilled window. Catches Kommo type-name drift, account-
  // specific blacklists, and "this type just doesn't fire on this account".
  await reportCoverage(from, to, depts);

  console.log("\n=== ALL DONE ===");
}

async function reportCoverage(from: Date, to: Date, depts: Dept[]): Promise<void> {
  console.log("\n=== Coverage report ===");
  // Berlin-day bounds matching the backfill window.
  const { windowFrom, windowTo } = berlinDayBounds(from, to);

  const declared = new Set(EVENT_TYPES.map((t) => t.key));
  const declaredCount = declared.size;

  for (const dept of depts) {
    const rows = await trackingDb
      .select({
        eventType: trackingEvents.eventType,
        cnt: sql<number>`count(*)::int`,
      })
      .from(trackingEvents)
      .where(
        and(
          eq(trackingEvents.department, dept),
          gte(trackingEvents.createdAt, windowFrom),
          lte(trackingEvents.createdAt, windowTo),
        ),
      )
      .groupBy(trackingEvents.eventType);

    // Bucket: declared+seen, declared+missing, undeclared+seen (Kommo emitted
    // something not in our list — likely per-id custom_field_<ID>_value_changed
    // which collapses to the generic via normalizeEventType in render).
    const seen = new Map<string, number>();
    let perFieldCount = 0; // custom_field_<id>_value_changed rows
    for (const r of rows) {
      const cnt = Number(r.cnt);
      if (/^custom_field_\d+_value_changed$/.test(r.eventType)) {
        perFieldCount += cnt;
      }
      seen.set(r.eventType, cnt);
    }

    const declaredSeen = EVENT_TYPES.filter((t) => seen.has(t.key));
    const declaredMissing = EVENT_TYPES.filter((t) => !seen.has(t.key));

    console.log(`\n${dept.toUpperCase()}: ${declaredSeen.length}/${declaredCount} declared types observed`);

    // Missing — split into "expected zero" (Kommo limit) vs "real gap"
    const realMissing: typeof EVENT_TYPES = [];
    const expectedZero: typeof EVENT_TYPES = [];
    for (const t of declaredMissing) {
      if (KNOWN_UNFETCHABLE.has(t.key)) expectedZero.push(t);
      else realMissing.push(t);
    }

    if (expectedZero.length > 0) {
      console.log(`  ⏸ unfetchable by API (${expectedZero.length}): ${expectedZero.map((t) => t.key).join(", ")}`);
    }
    if (realMissing.length > 0) {
      console.log(`  ⚠ no events for declared type (${realMissing.length}):`);
      for (const t of realMissing) {
        console.log(`     ${t.key} — "${t.label}" [${t.group}]`);
      }
      console.log(`     (could mean: account doesn't use this feature, or the type didn't fire in this window)`);
    }
    if (perFieldCount > 0) {
      console.log(`  ℹ per-id custom_field events: ${perFieldCount} rows (collapse to "custom_field_value_changed" in UI)`);
    }
    const totalRows = Array.from(seen.values()).reduce((s, n) => s + n, 0);
    console.log(`  total rows in window: ${totalRows}`);

    // Per-group summary
    const byGroup = new Map<string, { seen: number; total: number; rows: number }>();
    for (const t of EVENT_TYPES) {
      const g = byGroup.get(t.group) ?? { seen: 0, total: 0, rows: 0 };
      g.total++;
      if (seen.has(t.key)) {
        g.seen++;
        g.rows += seen.get(t.key) ?? 0;
      }
      byGroup.set(t.group, g);
    }
    console.log("  per-group:");
    for (const [g, s] of byGroup) {
      console.log(`     ${g}: ${s.seen}/${s.total} types, ${s.rows} rows`);
    }
  }
  void EVENT_TYPE_MAP; // keep import — used implicitly via EVENT_TYPES grouping
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("fatal:", err);
    process.exit(1);
  });
