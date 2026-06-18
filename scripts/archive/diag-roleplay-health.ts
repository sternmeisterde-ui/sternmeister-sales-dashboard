// Read-only: is the D1/R1 roleplay bot writing rows at all?
// Counts d1_calls / r1_calls per day for last N days regardless of score
// (MCP roleplay_summarise filters isNotNull(score) — this is the raw view).
//
//   npx tsx scripts/diag-roleplay-health.ts --days 30

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { gte, sql } from "drizzle-orm";

import { db as d1Db, r1Db, schema as d1Schema } from "../src/lib/db";

const args = process.argv.slice(2);
function arg(n: string): string | null {
  const i = args.indexOf(`--${n}`);
  return i < 0 ? null : args[i + 1] ?? null;
}
const days = Number(arg("days") ?? "30");
const since = new Date(Date.now() - days * 24 * 3600 * 1000);

async function dump(label: string, db: typeof d1Db, table: typeof d1Schema.d1Calls) {
  console.log(`\n══════ ${label}  (last ${days} days) ══════`);

  const total = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(table)
    .where(gte(table.startedAt, since));
  const scored = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(table)
    .where(sql`${table.startedAt} >= ${since} AND ${table.score} IS NOT NULL`);
  const evaluated = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(table)
    .where(sql`${table.startedAt} >= ${since} AND ${table.evaluationJson} IS NOT NULL`);
  const tx = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(table)
    .where(sql`${table.startedAt} >= ${since} AND ${table.transcript} IS NOT NULL`);

  console.log(`  total rows         = ${total[0]?.n ?? 0}`);
  console.log(`  with transcript    = ${tx[0]?.n ?? 0}`);
  console.log(`  with evaluation    = ${evaluated[0]?.n ?? 0}`);
  console.log(`  with score         = ${scored[0]?.n ?? 0}`);

  const lastFew = await db
    .select({
      id: table.id,
      startedAt: table.startedAt,
      duration: table.durationSeconds,
      score: table.score,
      callType: table.callType,
      userId: table.userId,
      hasTranscript: sql<boolean>`(${table.transcript} IS NOT NULL)`,
      hasEval: sql<boolean>`(${table.evaluationJson} IS NOT NULL)`,
    })
    .from(table)
    .where(gte(table.startedAt, since))
    .orderBy(sql`${table.startedAt} DESC`)
    .limit(10);

  if (lastFew.length === 0) {
    console.log("  (no rows — bot is not writing)");
  } else {
    console.log("");
    console.log("  Most recent rows:");
    for (const r of lastFew) {
      console.log(
        `    ${new Date(r.startedAt).toISOString().slice(0, 19)}Z  ${String(r.duration ?? "?").padStart(4)}s  type=${(r.callType ?? "?").padEnd(10)}  score=${r.score ?? "—"}  tr=${r.hasTranscript ? "y" : "n"}  eval=${r.hasEval ? "y" : "n"}  user=${r.userId.slice(0, 8)}`,
      );
    }
  }

  // Latest row overall (no date filter) — to tell us when the bot last spoke
  const latestEver = await db
    .select({ startedAt: table.startedAt })
    .from(table)
    .orderBy(sql`${table.startedAt} DESC`)
    .limit(1);
  console.log(
    `\n  last row ever      = ${latestEver[0]?.startedAt ? new Date(latestEver[0].startedAt).toISOString().slice(0, 19) + "Z" : "—"}`,
  );
}

async function main() {
  await dump("D1 (B2G — Госники)", d1Db, d1Schema.d1Calls);
  await dump("R1 (B2B — Коммерсы)", r1Db, d1Schema.r1Calls);
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
