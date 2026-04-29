import { NextRequest, NextResponse } from "next/server";
import { getDbForDepartment } from "@/lib/db";
import { callAnalyses } from "@/lib/db/schema-existing";
import { eq } from "drizzle-orm";
import { getSession } from "@/lib/auth";

/**
 * POST /api/analysis/[id]/resume
 *
 * Flips an `error` analysis back to `pending` so /api/analysis/process picks
 * it up again. The pipeline already has resume support (it skips files that
 * already exist in call_analysis_files), so partially-transcribed runs
 * (e.g. the Grok-credits-exhausted case where 4/7 calls were done) finish
 * the remaining work without re-paying for transcription/analysis on the
 * already-done ones.
 *
 * Only `error` is resumable. Stuck `processing` rows must be killed first
 * (DELETE) — we can't tell from the DB whether the SSE stream is still alive
 * on another connection, and resuming a live one would race the pipeline.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession();
    if (!session || session.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    const db = getDbForDepartment("b2g");

    const [existing] = await db
      .select({ status: callAnalyses.status })
      .from(callAnalyses)
      .where(eq(callAnalyses.id, id));

    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (existing.status !== "error") {
      return NextResponse.json(
        { error: `Can only resume from 'error' status (current: ${existing.status})` },
        { status: 400 },
      );
    }

    await db
      .update(callAnalyses)
      .set({ status: "pending", errorMessage: null })
      .where(eq(callAnalyses.id, id));

    return NextResponse.json({ success: true, id });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
