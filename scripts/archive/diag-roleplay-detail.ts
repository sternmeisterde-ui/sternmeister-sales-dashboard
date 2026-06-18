// Read-only: distinct call_types in D1/R1 + any row for a given telegram_id.
//
//   npx tsx scripts/diag-roleplay-detail.ts --tg 1836358772 --days 60

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { eq, sql } from "drizzle-orm";

import { db as d1Db, r1Db, schema as d1Schema } from "../src/lib/db";

const args = process.argv.slice(2);
function arg(n: string): string | null {
  const i = args.indexOf(`--${n}`);
  return i < 0 ? null : args[i + 1] ?? null;
}
const tg = arg("tg");
const days = Number(arg("days") ?? "60");
const since = new Date(Date.now() - days * 24 * 3600 * 1000);

async function inspect(
  label: string,
  db: typeof d1Db,
  usersTbl: typeof d1Schema.d1Users,
  callsTbl: typeof d1Schema.d1Calls,
) {
  console.log(`\n══════ ${label} ══════`);

  // Distribution of call_type in last N days
  const byType = await db.execute(sql`
    SELECT
      COALESCE(call_type, '(null)') AS call_type,
      COUNT(*) AS total,
      COUNT(score) AS with_score,
      COUNT(evaluation_json) AS with_eval,
      MAX(started_at) AS last_seen
    FROM ${callsTbl}
    WHERE started_at >= ${since.toISOString()}
    GROUP BY 1
    ORDER BY total DESC
  `);
  console.log(`\n  call_type distribution (last ${days} days):`);
  for (const r of byType.rows ?? byType) {
    const row = r as { call_type: string; total: number; with_score: number; with_eval: number; last_seen: string };
    console.log(
      `    ${String(row.call_type).padEnd(15)}  total=${String(row.total).padStart(5)}  score=${String(row.with_score).padStart(5)}  eval=${String(row.with_eval).padStart(5)}  last=${row.last_seen ?? "—"}`,
    );
  }

  // All-time distribution to compare
  const byTypeAllTime = await db.execute(sql`
    SELECT
      COALESCE(call_type, '(null)') AS call_type,
      COUNT(*) AS total,
      MAX(started_at) AS last_seen
    FROM ${callsTbl}
    GROUP BY 1
    ORDER BY total DESC
  `);
  console.log(`\n  call_type distribution (ALL TIME):`);
  for (const r of byTypeAllTime.rows ?? byTypeAllTime) {
    const row = r as { call_type: string; total: number; last_seen: string };
    console.log(
      `    ${String(row.call_type).padEnd(15)}  total=${String(row.total).padStart(6)}  last=${row.last_seen ?? "—"}`,
    );
  }

  if (tg) {
    const user = await db
      .select()
      .from(usersTbl)
      .where(eq(usersTbl.telegramId, tg))
      .limit(1);
    if (user.length === 0) {
      console.log(`\n  no user with telegram_id=${tg} in this DB`);
    } else {
      const u = user[0]!;
      console.log(
        `\n  user @${u.telegramUsername ?? "?"} (${u.name}) — uuid=${u.id}, active=${u.isActive}, line=${u.line ?? "—"}, role=${u.role}`,
      );
      const all = await db.execute(sql`
        SELECT id, started_at, duration_seconds, call_type, score,
               (evaluation_json IS NOT NULL) AS has_eval,
               (transcript IS NOT NULL) AS has_tx
        FROM ${callsTbl}
        WHERE user_id = ${u.id}
        ORDER BY started_at DESC
        LIMIT 20
      `);
      const rows = all.rows ?? all;
      if (rows.length === 0) {
        console.log("  ✗ no roleplay rows ever for this user");
      } else {
        console.log(`  ${rows.length} most-recent row(s) for this user (ALL TIME):`);
        for (const r of rows) {
          const row = r as {
            id: string;
            started_at: string;
            duration_seconds: number | null;
            call_type: string | null;
            score: number | null;
            has_eval: boolean;
            has_tx: boolean;
          };
          console.log(
            `    ${row.started_at}  ${String(row.duration_seconds ?? "?").padStart(4)}s  type=${(row.call_type ?? "?").padEnd(10)}  score=${row.score ?? "—"}  tx=${row.has_tx ? "y" : "n"}  eval=${row.has_eval ? "y" : "n"}`,
          );
        }
      }
    }
  }
}

async function main() {
  await inspect("D1 (B2G — Госники)", d1Db, d1Schema.d1Users, d1Schema.d1Calls);
  await inspect("R1 (B2B — Коммерсы)", r1Db, d1Schema.r1Users, d1Schema.r1Calls);
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
