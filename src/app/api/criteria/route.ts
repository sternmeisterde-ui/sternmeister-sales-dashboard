import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ALL_PROMPT_TYPES, isValidPromptType as isValidPT } from "@/lib/config/tenant";
import { clearCache } from "@/lib/kommo/cache";

function isValidPromptType(value: unknown): value is string {
  return typeof value === "string" && isValidPT(value);
}

function getCriteriaFilePath(promptType: string): string {
  return path.join(process.cwd(), "src", "criteria", `${promptType}.json`);
}

// ─── GET: return criteria config for a given prompt_type ───────────────────

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

    const filePath = getCriteriaFilePath(promptType);
    const raw = await readFile(filePath, "utf-8");
    const config = JSON.parse(raw);

    return NextResponse.json({ success: true, data: config });
  } catch (error) {
    console.error("[Criteria API GET]", error);
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// ─── POST: write updated criteria config back to file ─────────────────────

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

    if (!config || typeof config !== "object") {
      return NextResponse.json({ error: "Missing or invalid config" }, { status: 400 });
    }

    const filePath = getCriteriaFilePath(promptType);
    await writeFile(filePath, JSON.stringify(config, null, 2), "utf-8");

    // Drop cached Analytics responses so the new criteria show up
    // immediately instead of waiting for the 2-min TTL.
    clearCache();

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[Criteria API POST]", error);
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
