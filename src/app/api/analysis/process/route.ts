import { NextResponse } from "next/server";
import { getDbForDepartment } from "@/lib/db";
import { callAnalyses } from "@/lib/db/schema-existing";
import { eq, or } from "drizzle-orm";
import { runAnalysisPipeline } from "@/lib/analysis/pipeline";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * GET /api/analysis/process
 *
 * Called repeatedly by frontend while analysis is pending/processing.
 * Runs the full pipeline — relies on Dokploy proxy timeout (5-10 min).
 * Progress saved incrementally so partial results survive timeout.
 */
export async function GET() {
  const session = await getSession();
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = getDbForDepartment("b2g");

  const [pending] = await db
    .select({ id: callAnalyses.id, status: callAnalyses.status })
    .from(callAnalyses)
    .where(or(eq(callAnalyses.status, "pending"), eq(callAnalyses.status, "processing")))
    .limit(1);

  if (!pending) {
    return NextResponse.json({ status: "idle" });
  }

  try {
    await runAnalysisPipeline(pending.id);
    return NextResponse.json({ status: "done", id: pending.id });
  } catch (err) {
    return NextResponse.json({ status: "error", id: pending.id, error: String(err) });
  }
}
