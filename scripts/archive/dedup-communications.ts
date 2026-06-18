// One-shot chunked dedup of analytics.communications.
//
// Why this exists: pre-2026-04-28 the ETL used DELETE-by-date + INSERT
// without a unique index on communication_id. Edited Kommo notes get
// re-fetched on later cron passes via filter[updated_at] and re-inserted
// with the same created_at, accumulating duplicates that the date-window
// DELETE never catches (it only wipes the current 15-min window). Result:
// 4.45M dupes out of 4.69M total rows by 2026-04-28.
//
// Walks day-by-day so each DELETE statement stays under the Neon HTTP
// 60s timeout. Per-day dupes (~40k) fit comfortably. After all days
// processed, run scripts/dedup-communications.ts --create-index to add
// the unique partial index. Backup branch already created on the Neon
// looker project: pre-migration-0004-20260428.
//
// Usage:
//   npx tsx scripts/dedup-communications.ts                 # dry-run, last 4 months
//   npx tsx scripts/dedup-communications.ts --apply
//   npx tsx scripts/dedup-communications.ts --apply --from 2026-01-01 --to 2026-04-28
//   npx tsx scripts/dedup-communications.ts --create-index  # only after dedup

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

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function main() {
  const APPLY = arg("apply") === "true";
  const CREATE_INDEX = arg("create-index") === "true";

  const url = process.env.ANALYTICS_DATABASE_URL;
  if (!url) throw new Error("ANALYTICS_DATABASE_URL not set");
  const sql = neon(url);

  if (CREATE_INDEX) {
    console.log("Creating partial unique index on analytics.communications.communication_id…");
    await sql.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS communications_communication_id_unique
       ON analytics.communications (communication_id)
       WHERE communication_id IS NOT NULL`,
    );
    console.log("Index created (or already existed). Done.");
    return;
  }

  const fromArg = arg("from", "2026-01-01")!;
  const toArg = arg("to", fmt(new Date()))!;
  const from = new Date(`${fromArg}T00:00:00Z`);
  const to = new Date(`${toArg}T23:59:59.999Z`);

  console.log(`Mode: ${APPLY ? "APPLY" : "DRY-RUN (use --apply)"}`);
  console.log(`Range: ${fmt(from)} → ${fmt(to)}`);
  console.log("");

  const before = await sql.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(DISTINCT communication_id) FILTER (WHERE communication_id IS NOT NULL)::int AS uniq
     FROM analytics.communications
     WHERE created_at >= $1 AND created_at <= $2`,
    [from, to],
  );
  console.log(`Before: total=${before[0].total}, unique_ids=${before[0].uniq}, dupes=${before[0].total - before[0].uniq}`);
  console.log("");

  const totalDays = Math.ceil((to.getTime() - from.getTime()) / 86_400_000);
  let dayN = 0;
  let totalDeleted = 0;
  const t0 = Date.now();

  for (
    let cur = new Date(from);
    cur <= to;
    cur = new Date(cur.getTime() + 86_400_000)
  ) {
    dayN++;
    const dayStart = new Date(cur);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(cur);
    dayEnd.setUTCHours(23, 59, 59, 999);

    const tChunk = Date.now();

    // Per-day DELETE: keep the smallest ctid per communication_id, drop the rest.
    // Postgres ROW_NUMBER + DELETE … WHERE ctid IN (…) is the safe pattern when
    // the table lacks a primary key (analytics.communications has no PK). NULL
    // communication_id rows are skipped — they're orphan/legacy rows that
    // shouldn't collapse into one.
    let deletedThisDay = 0;
    if (APPLY) {
      const result = await sql.query(
        `WITH deleted AS (
           DELETE FROM analytics.communications
           WHERE ctid IN (
             SELECT ctid FROM (
               SELECT ctid,
                      ROW_NUMBER() OVER (PARTITION BY communication_id ORDER BY ctid) AS rn
               FROM analytics.communications
               WHERE communication_id IS NOT NULL
                 AND created_at >= $1 AND created_at <= $2
             ) t
             WHERE rn > 1
           )
           RETURNING 1
         )
         SELECT COUNT(*)::int AS n FROM deleted`,
        [dayStart, dayEnd],
      );
      deletedThisDay = result[0]?.n ?? 0;
    } else {
      const counted = await sql.query(
        `SELECT COUNT(*) FILTER (WHERE rn > 1)::int AS to_delete FROM (
           SELECT ROW_NUMBER() OVER (PARTITION BY communication_id ORDER BY ctid) AS rn
           FROM analytics.communications
           WHERE communication_id IS NOT NULL
             AND created_at >= $1 AND created_at <= $2
         ) t`,
        [dayStart, dayEnd],
      );
      deletedThisDay = counted[0].to_delete;
    }

    totalDeleted += deletedThisDay;
    const dt = ((Date.now() - tChunk) / 1000).toFixed(1);
    console.log(
      `[${String(dayN).padStart(3)}/${totalDays}] ${fmt(dayStart)} ` +
        `${APPLY ? "deleted" : "would delete"} ${String(deletedThisDay).padStart(6)} dupes (${dt}s)`,
    );
  }

  const wall = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("");
  console.log("=== DONE ===");
  console.log(`Wall: ${wall}s, ${APPLY ? "deleted" : "would-delete"}: ${totalDeleted}`);

  if (APPLY) {
    const after = await sql.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(DISTINCT communication_id) FILTER (WHERE communication_id IS NOT NULL)::int AS uniq
       FROM analytics.communications
       WHERE created_at >= $1 AND created_at <= $2`,
      [from, to],
    );
    const remDupes = after[0].total - after[0].uniq;
    console.log(`After: total=${after[0].total}, unique_ids=${after[0].uniq}, residual dupes=${remDupes}`);
    if (remDupes > 0) {
      console.log(`⚠ Residual dupes left — likely span across day boundaries. Re-run with wider chunks or run --create-index after manual inspection.`);
    } else {
      console.log(`✓ Clean. Run --create-index next.`);
    }
  } else {
    console.log(`\nDry-run complete. Re-run with --apply.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("fatal:", err);
    process.exit(1);
  });
