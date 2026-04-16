import { NextResponse } from "next/server";
import { getDbForDepartment } from "@/lib/db";
import { callAnalyses } from "@/lib/db/schema-existing";
import { eq } from "drizzle-orm";
import { runAnalysisPipeline } from "@/lib/analysis/pipeline";

/**
 * GET /api/analysis/process
 *
 * Starts processing a pending analysis. The pipeline runs as a
 * long-running operation within this request. For Dokploy (Docker),
 * the timeout is controlled by the reverse proxy (default 300-600s).
 *
 * For very large analyses (100 calls), the pipeline saves progress
 * incrementally so if it times out, the partial results are preserved.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const db = getDbForDepartment("b2g");

  // Find pending or stuck processing analysis
  const [pending] = await db
    .select({ id: callAnalyses.id, status: callAnalyses.status })
    .from(callAnalyses)
    .where(eq(callAnalyses.status, "pending"))
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
