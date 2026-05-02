/**
 * apply-pg-comments.ts — applies generated pg COMMENT migrations to all 6
 * Neon databases of the dashboard. Run after `generate-pg-comments.ts` to
 * sync catalog comments with the latest curated narratives.
 *
 * Idempotent: each migration is a sequence of `COMMENT ON ...` statements,
 * which Postgres overwrites on re-apply.
 *
 * Usage:
 *   npx tsx scripts/apply-pg-comments.ts                    # apply all 6
 *   npx tsx scripts/apply-pg-comments.ts --db=tracking      # one DB
 *   npx tsx scripts/apply-pg-comments.ts --dry-run          # show what would run
 *
 * Connection strings come from .env.local (DATABASE_URL, R1_DATABASE_URL,
 * D2_OKK_DATABASE_URL, R2_OKK_DATABASE_URL, ANALYTICS_DATABASE_URL,
 * TRACKING_DATABASE_URL). Missing R1_DATABASE_URL is auto-derived from
 * DATABASE_URL by swapping the Neon endpoint (matches src/lib/db/index.ts).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";
import { neon } from "@neondatabase/serverless";

dotenv.config({ path: ".env.local" });

type DbKey = "d1" | "r1" | "d2" | "r2" | "analytics" | "tracking";

interface Target {
  db: DbKey;
  envVar: string;
  sqlFile: string;
  /** If envVar missing, derive from this fallback (only for r1 → d1). */
  fallback?: { source: string; replace: string; with: string };
}

const D1_ENDPOINT = "ep-withered-recipe-ai1ea97w-pooler";
const R1_ENDPOINT = "ep-shiny-recipe-aio8wyp2-pooler";

const TARGETS: ReadonlyArray<Target> = [
  { db: "d1", envVar: "DATABASE_URL", sqlFile: "drizzle/d1/0000_pg_comments.sql" },
  {
    db: "r1",
    envVar: "R1_DATABASE_URL",
    sqlFile: "drizzle/r1/0000_pg_comments.sql",
    fallback: { source: "DATABASE_URL", replace: D1_ENDPOINT, with: R1_ENDPOINT },
  },
  { db: "d2", envVar: "D2_OKK_DATABASE_URL", sqlFile: "drizzle/d2/0000_pg_comments.sql" },
  { db: "r2", envVar: "R2_OKK_DATABASE_URL", sqlFile: "drizzle/r2/0000_pg_comments.sql" },
  {
    db: "analytics",
    envVar: "ANALYTICS_DATABASE_URL",
    sqlFile: "drizzle/analytics/0012_pg_comments.sql",
  },
  {
    db: "tracking",
    envVar: "TRACKING_DATABASE_URL",
    sqlFile: "drizzle/tracking/0000_pg_comments.sql",
  },
];

interface Args {
  db?: DbKey;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false };
  for (const a of argv) {
    if (a === "--dry-run") args.dryRun = true;
    else if (a.startsWith("--db=")) {
      args.db = a.slice("--db=".length) as DbKey;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: tsx scripts/apply-pg-comments.ts [--db=<d1|r1|d2|r2|analytics|tracking>] [--dry-run]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown arg: ${a}`);
    }
  }
  return args;
}

function resolveUrl(target: Target): string | null {
  const direct = process.env[target.envVar];
  if (direct) return direct;
  if (target.fallback) {
    const src = process.env[target.fallback.source];
    if (src && src.includes(target.fallback.replace)) {
      return src.replace(target.fallback.replace, target.fallback.with);
    }
  }
  return null;
}

function extractStatements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((l) => /^COMMENT ON /.test(l))
    .map((l) => l.replace(/;\s*$/, ""));
}

async function applyOne(repoRoot: string, target: Target, dryRun: boolean): Promise<void> {
  const url = resolveUrl(target);
  if (!url) {
    console.warn(`[skip] ${target.db}: ${target.envVar} not set`);
    return;
  }
  const sqlFile = path.join(repoRoot, target.sqlFile);
  const raw = await fs.readFile(sqlFile, "utf8");
  const statements = extractStatements(raw);
  if (statements.length === 0) {
    console.warn(`[skip] ${target.db}: 0 statements parsed from ${target.sqlFile}`);
    return;
  }
  console.log(`[apply] ${target.db}: ${statements.length} statements`);
  if (dryRun) return;

  const sql = neon(url);
  const t0 = Date.now();
  let i = 0;
  for (const stmt of statements) {
    try {
      // Neon HTTP driver supports a single statement per call. We don't need
      // a real BEGIN/COMMIT for COMMENT ON (each is its own tiny txn).
      await sql.query(stmt);
      i++;
    } catch (err) {
      console.error(`[error] ${target.db} stmt #${i + 1}: ${stmt.slice(0, 120)}…`);
      throw err;
    }
  }
  console.log(`[done] ${target.db}: ${i} applied in ${Date.now() - t0}ms`);
}

async function main() {
  const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const args = parseArgs(process.argv.slice(2));
  const work = args.db ? TARGETS.filter((t) => t.db === args.db) : TARGETS;
  for (const t of work) {
    await applyOne(repoRoot, t, args.dryRun);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
