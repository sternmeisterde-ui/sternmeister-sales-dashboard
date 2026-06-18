// Quick sanity check after a telephony backfill: prints per-day call totals
// from analytics.communications grouped by source. Run after
// scripts/backfill-from-telephony.ts to confirm the data landed and to
// compare day-by-day coverage against the user's PBX panel expectations.
//
// Usage:
//   npx tsx scripts/check-call-coverage.ts                       # last 14 days
//   npx tsx scripts/check-call-coverage.ts --from 2026-01-01 --to 2026-04-28

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { neon } from "@neondatabase/serverless";

function arg(name: string, def: string | null = null): string | null {
  const args = process.argv.slice(2);
  const idx = args.indexOf(`--${name}`);
  if (idx < 0) return def;
  const v = args[idx + 1];
  return v && !v.startsWith("--") ? v : "true";
}

async function main() {
  const fromArg = arg("from");
  const toArg = arg("to");
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const from = fromArg
    ? new Date(`${fromArg}T00:00:00Z`)
    : new Date(today.getTime() - 14 * 86_400_000);
  const to = toArg
    ? new Date(`${toArg}T23:59:59.999Z`)
    : new Date(today.getTime() + 86_399_999);

  const url = process.env.ANALYTICS_DATABASE_URL;
  if (!url) throw new Error("ANALYTICS_DATABASE_URL not set");
  const sql = neon(url);

  console.log(`=== Call coverage ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)} ===\n`);

  // Per-day totals
  const daily = await sql`
    SELECT
      to_char((created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin')::date, 'YYYY-MM-DD') AS day,
      COUNT(*) FILTER (WHERE communication_id LIKE 'cg-leg:%')::int AS cg,
      COUNT(*) FILTER (WHERE communication_id LIKE 'ct:%')::int AS ct,
      COUNT(*) FILTER (
        WHERE communication_type LIKE 'call%'
          AND communication_id NOT LIKE 'cg-leg:%'
          AND communication_id NOT LIKE 'ct:%'
      )::int AS kommo_orphan,
      COUNT(*) FILTER (
        WHERE communication_type LIKE 'call%'
          AND (communication_id LIKE 'cg-leg:%' OR communication_id LIKE 'ct:%')
          AND duration >= 1
      )::int AS connected
    FROM analytics.communications
    WHERE created_at >= ${from}
      AND created_at <= ${to}
      AND communication_type LIKE 'call%'
    GROUP BY day
    ORDER BY day DESC
    LIMIT 60
  `;

  console.log("Per day (Berlin time, last 60 rows):");
  console.log("day         | cg    | ct    | kommo* | connected");
  console.log("---------------------------------------------------");
  for (const r of daily) {
    const cg = String(r.cg).padStart(5);
    const ct = String(r.ct).padStart(5);
    const k = String(r.kommo_orphan).padStart(6);
    const c = String(r.connected).padStart(9);
    console.log(`${r.day}  | ${cg} | ${ct} | ${k} | ${c}`);
  }
  console.log("\n* kommo_orphan = stale call rows from pre-hard-split. Should be 0 after a clean re-backfill.");

  // Totals
  const totals = await sql`
    SELECT
      COUNT(*) FILTER (WHERE communication_id LIKE 'cg-leg:%')::int AS cg_total,
      COUNT(*) FILTER (WHERE communication_id LIKE 'ct:%')::int AS ct_total,
      COUNT(*) FILTER (
        WHERE communication_type LIKE 'call%'
          AND communication_id NOT LIKE 'cg-leg:%'
          AND communication_id NOT LIKE 'ct:%'
      )::int AS kommo_orphan_total,
      COUNT(DISTINCT manager) FILTER (WHERE communication_id LIKE 'cg-leg:%' OR communication_id LIKE 'ct:%')::int AS unique_managers
    FROM analytics.communications
    WHERE created_at >= ${from}
      AND created_at <= ${to}
      AND communication_type LIKE 'call%'
  `;
  const t = totals[0];
  console.log(`\n=== Totals ===`);
  console.log(`CallGear:        ${t.cg_total}`);
  console.log(`CloudTalk:       ${t.ct_total}`);
  console.log(`Kommo orphan:    ${t.kommo_orphan_total}  ${t.kommo_orphan_total > 0 ? "← still need re-backfill" : "✓"}`);
  console.log(`Unique managers (telephony): ${t.unique_managers}`);

  // Top managers (telephony only)
  const top = await sql`
    SELECT manager,
      COUNT(*) FILTER (WHERE communication_id LIKE 'cg-leg:%')::int AS cg,
      COUNT(*) FILTER (WHERE communication_id LIKE 'ct:%')::int AS ct,
      COUNT(*) FILTER (WHERE duration >= 1)::int AS connected,
      COUNT(*)::int AS total
    FROM analytics.communications
    WHERE created_at >= ${from}
      AND created_at <= ${to}
      AND (communication_id LIKE 'cg-leg:%' OR communication_id LIKE 'ct:%')
    GROUP BY manager
    ORDER BY total DESC
    LIMIT 30
  `;
  console.log(`\n=== Top 30 managers (telephony) ===`);
  console.log("manager                         |  cg  |  ct  | connected | total");
  console.log("-------------------------------------------------------------------");
  for (const r of top) {
    const name = String(r.manager ?? "?").padEnd(31);
    const cg = String(r.cg).padStart(4);
    const ct = String(r.ct).padStart(4);
    const c = String(r.connected).padStart(9);
    const tot = String(r.total).padStart(5);
    console.log(`${name} | ${cg} | ${ct} | ${c} | ${tot}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("fatal:", err);
    process.exit(1);
  });
