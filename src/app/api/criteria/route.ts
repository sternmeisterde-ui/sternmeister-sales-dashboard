import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const VALID_PROMPT_TYPES = [
  "r2_commercial",
  "r2_decisions",
  "r2_med_commercial",
  "d2_qualifier",
  "d2_berater",
  "d2_berater2",
  "d2_dovedenie",
] as const;

type PromptType = (typeof VALID_PROMPT_TYPES)[number];

function isValidPromptType(value: unknown): value is PromptType {
  return typeof value === "string" && (VALID_PROMPT_TYPES as readonly string[]).includes(value);
}

function getCriteriaFilePath(promptType: PromptType): string {
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
        { error: `Invalid prompt_type. Must be one of: ${VALID_PROMPT_TYPES.join(", ")}` },
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
        { error: `Invalid prompt_type. Must be one of: ${VALID_PROMPT_TYPES.join(", ")}` },
        { status: 400 },
      );
    }

    if (!config || typeof config !== "object") {
      return NextResponse.json({ error: "Missing or invalid config" }, { status: 400 });
    }

    const filePath = getCriteriaFilePath(promptType);
    await writeFile(filePath, JSON.stringify(config, null, 2), "utf-8");

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[Criteria API POST]", error);
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
