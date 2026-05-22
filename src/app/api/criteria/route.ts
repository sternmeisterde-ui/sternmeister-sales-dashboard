// /api/criteria — read & write OKK evaluation criteria.
//
// Source of truth: D2 OKK database, table `criteria_configs`.
// FS files (src/criteria/*.json) are kept as a deploy-image backup so
// the OKK evaluator can fall back if the DB is unreachable.
//
// GET: returns criteria for a single prompt_type (admin only).
//   - DB first; FS fallback on DB error.
// POST: writes criteria for a single prompt_type (admin only).
//   - Validates structural shape (stages: non-empty array).
//   - Writes DB (UPSERT) + FS backup so the next Docker build still ships
//     a working copy.
//   - Clears the Dashboard Analytics cache so dashboards reflect new
//     scoring on next refresh.
//
// Concurrency: the table has a PK on prompt_type — concurrent POSTs are
// serialized by Postgres. Last-writer-wins (no row locking — admin-only
// UI, contention is negligible). Add updated_by/source so audit logs
// can identify the writer.
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import { d2OkkDb } from "@/lib/db/okk";
import { ALL_PROMPT_TYPES, isValidPromptType as isValidPT } from "@/lib/config/tenant";
function isValidPromptType(value: unknown): value is string {
  return typeof value === "string" && isValidPT(value);
}

function getCriteriaFilePath(promptType: string): string {
  return path.join(process.cwd(), "src", "criteria", `${promptType}.json`);
}

async function readFromDb(promptType: string): Promise<{ version: string; config: unknown } | null> {
  const result = await d2OkkDb.execute<{ version: string; config: unknown }>(
    sql`SELECT version, config FROM criteria_configs WHERE prompt_type = ${promptType} LIMIT 1`,
  );
  const rows = (result as any).rows ?? result;
  if (!rows || rows.length === 0) return null;
  return { version: String(rows[0].version), config: rows[0].config };
}

async function readFromFs(promptType: string): Promise<unknown> {
  const raw = await readFile(getCriteriaFilePath(promptType), "utf-8");
  return JSON.parse(raw);
}

// ─── GET ───────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session || session.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const promptType = request.nextUrl.searchParams.get("prompt_type");
    if (!isValidPromptType(promptType)) {
      return NextResponse.json(
        { error: `Invalid prompt_type. Must be one of: ${ALL_PROMPT_TYPES.join(", ")}` },
        { status: 400 },
      );
    }

    // DB-first.
    try {
      const dbRow = await readFromDb(promptType);
      if (dbRow) {
        return NextResponse.json({ success: true, data: dbRow.config, source: "db", version: dbRow.version });
      }
      // Row missing — fall through to FS.
      console.warn(`[Criteria API GET] row missing in DB for ${promptType}, falling back to FS`);
    } catch (e) {
      console.warn(`[Criteria API GET] DB read failed for ${promptType}, falling back to FS`, e);
    }

    // FS fallback.
    const fsConfig = await readFromFs(promptType);
    return NextResponse.json({ success: true, data: fsConfig, source: "fs-fallback" });
  } catch (error) {
    console.error("[Criteria API GET]", error);
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// ─── POST disabled ─────────────────────────────────────────────────────────
// UI is read-only by design (2026-05-22 decision). To change criteria, edit
// `src/criteria/*.json` in sternmeisterde-ui/okk, commit, and the next deploy
// will sync the DB via `npm start` → `migrate-criteria-to-db.ts --apply`.
// Direct DB UPDATEs are also fine; OKK loader picks them up within 60s.

export async function POST() {
  return NextResponse.json(
    {
      error:
        "Criteria are read-only via UI. Edit src/criteria/*.json in the OKK repo or run scripts/migrate-criteria-to-db.ts.",
    },
    { status: 405 },
  );
}
