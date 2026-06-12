import { NextResponse, after } from "next/server";
import { runAnalysisPipeline } from "@/lib/analysis/pipeline";
import { claimNextAnalysis } from "@/lib/analysis/worker";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/analysis/process — instant "kick" for the analysis worker.
 *
 * Session-authed twin of /api/analysis/process/tick (the cron tick): the UI
 * calls this right after submitting or resuming an analysis so the job starts
 * within ~1s instead of waiting up to ANALYSIS_TICK_SECONDS for the next
 * cron tick. Identical semantics — claim at most one job (global single-
 * flight FIFO, see src/lib/analysis/worker.ts), run one time-boxed chunk
 * detached from the response.
 *
 * History: this used to be a 30-min SSE stream that ran the pipeline inside
 * the request and held the ONLY DB heartbeat in a route-side setInterval.
 * When the browser tab closed, the heartbeat died while the pipeline kept
 * running → a second claim started a duplicate run, and with no tab open
 * nothing ever resumed an orphaned job. The pipeline now owns its own
 * heartbeat + checkpointing, and the cron tick guarantees progress without
 * a browser, so this route only needs to answer {claimed|idle}.
 */
export async function GET() {
  const session = await getSession();
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const claimedId = await claimNextAnalysis();
  if (!claimedId) {
    return NextResponse.json({ status: "idle" });
  }

  // Run the chunk after the response is sent (see tick/route.ts for why this
  // is safe on the standalone node server).
  after(() => runAnalysisPipeline(claimedId));

  return NextResponse.json({ status: "claimed", id: claimedId });
}
