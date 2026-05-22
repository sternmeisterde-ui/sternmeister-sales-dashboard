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
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import { d2OkkDb } from "@/lib/db/okk";
import { ALL_PROMPT_TYPES, isValidPromptType as isValidPT } from "@/lib/config/tenant";
import { clearCache } from "@/lib/kommo/cache";

function isValidPromptType(value: unknown): value is string {
  return typeof value === "string" && isValidPT(value);
}

function getCriteriaFilePath(promptType: string): string {
  return path.join(process.cwd(), "src", "criteria", `${promptType}.json`);
}

function validateConfigShape(raw: unknown): { ok: true } | { ok: false; reason: string } {
  if (typeof raw !== "object" || raw === null) return { ok: false, reason: "config is not an object" };
  const stages = (raw as { stages?: unknown }).stages;
  if (!Array.isArray(stages)) return { ok: false, reason: "missing \"stages\" array" };
  if (stages.length === 0) return { ok: false, reason: "\"stages\" array is empty" };
  for (let i = 0; i < stages.length; i++) {
    const st = stages[i];
    if (typeof st !== "object" || st === null) return { ok: false, reason: `stages[${i}] is not an object` };
    if (!Array.isArray((st as { criteria?: unknown }).criteria)) return { ok: false, reason: `stages[${i}].criteria missing` };
  }
  return { ok: true };
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

// ─── POST ──────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session || session.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const { prompt_type: promptType, config } = body as {
      prompt_type: unknown;
      config: unknown;
    };

    if (!isValidPromptType(promptType)) {
      return NextResponse.json(
        { error: `Invalid prompt_type. Must be one of: ${ALL_PROMPT_TYPES.join(", ")}` },
        { status: 400 },
      );
    }

    const shape = validateConfigShape(config);
    if (!shape.ok) {
      return NextResponse.json({ error: `Invalid config: ${shape.reason}` }, { status: 400 });
    }

    const version =
      typeof (config as { version?: unknown }).version === "string" &&
      ((config as { version: string }).version).trim().length > 0
        ? (config as { version: string }).version.trim()
        : "1.0";

    const writer = session.telegramUsername || session.name || "dashboard-admin";

    // 1. Write to DB (source of truth).
    await d2OkkDb.execute(sql`
      INSERT INTO criteria_configs (prompt_type, version, config, updated_by, source)
      VALUES (${promptType}, ${version}, ${JSON.stringify(config)}::jsonb, ${writer}, 'dashboard-ui')
      ON CONFLICT (prompt_type) DO UPDATE
        SET version = EXCLUDED.version,
            config = EXCLUDED.config,
            updated_at = now(),
            updated_by = EXCLUDED.updated_by,
            source = EXCLUDED.source
    `);

    // 2. Write FS backup (image-baked safety net for OKK FS fallback).
    //    Best-effort — if it fails (read-only FS, etc.), DB is still updated.
    try {
      await writeFile(getCriteriaFilePath(promptType as string), JSON.stringify(config, null, 2), "utf-8");
    } catch (fsErr) {
      console.warn(`[Criteria API POST] DB written, FS backup failed for ${promptType}:`, fsErr);
    }

    // 3. Drop Analytics cache so dashboards see new scoring on next request.
    clearCache();

    return NextResponse.json({ success: true, persistedTo: "db" });
  } catch (error) {
    console.error("[Criteria API POST]", error);
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
