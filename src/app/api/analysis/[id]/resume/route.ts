import { NextRequest, NextResponse } from "next/server";
import { getDbForDepartment } from "@/lib/db";
import { callAnalyses } from "@/lib/db/schema-existing";
import { eq } from "drizzle-orm";
import { getSession } from "@/lib/auth";

/**
 * POST /api/analysis/[id]/resume
 *
 * Flips an `error` or `cancelled` analysis back to `pending` so the worker
 * picks it up again. The pipeline already has resume support (discovery
 * checkpoint manifest + skipping files that already exist in
 * call_analysis_files), so partially-transcribed runs finish the remaining
 * work without re-paying for transcription/analysis on the already-done ones.
 *
 * `processing` is NOT resumable here: live runs heartbeat every ~20s and a
 * stale-heartbeated (orphaned) one is auto-reclaimed by the next worker
 * claim — no manual action needed.
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
    if (existing.status !== "error" && existing.status !== "cancelled") {
      return NextResponse.json(
        { error: `Can only resume from 'error'/'cancelled' status (current: ${existing.status})` },
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
