// GET /api/analysis/process/tick
// Cron-driven analysis worker tick. Called every ~60s by the `analysis-cron`
// compose service (same pattern as etl-cron → /api/analytics/sync/cron).
// This is what makes analysis processing browser-independent: before this
// endpoint existed, a job was only ever claimed/resumed while someone had the
// Анализ tab open — close the tab and a yielded/orphaned run sat frozen
// forever (the "125/769 сделок, сутки без движения" incident).
//
// Protected by CRON_SECRET — no session cookie required (cron has no browser).
// Call: GET /api/analysis/process/tick  with header  x-cron-secret: <CRON_SECRET>
// Or:   GET /api/analysis/process/tick?secret=<CRON_SECRET>
//
// Overlap protection is the claim itself: claimNextAnalysis() is a single
// atomic UPDATE with a global single-flight gate, so a tick that fires while
// a chunk is still running just gets {status:"idle"} — no extra lock table.

import { type NextRequest, NextResponse, after } from "next/server";
import { runAnalysisPipeline } from "@/lib/analysis/pipeline";
import { claimNextAnalysis } from "@/lib/analysis/worker";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret =
    req.headers.get("x-cron-secret") ??
    req.nextUrl.searchParams.get("secret");

  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error("[Analysis tick] CRON_SECRET env var not set");
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }
  if (!secret || secret !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const claimedId = await claimNextAnalysis();
  if (!claimedId) {
    return NextResponse.json({ status: "idle" });
  }

  // Run the chunk AFTER the response is sent — the tick must answer in <1s
  // (curl --max-time in the cron loop), while a chunk runs up to the soft
  // deadline (~20 min). `after()` is Next's sanctioned post-response work
  // primitive; on the standalone node server the process stays alive anyway.
  // A crash inside is handled by the pipeline's own catch (status='error');
  // a hard process kill is handled by heartbeat staleness (auto-reclaim).
  after(() => runAnalysisPipeline(claimedId));

  return NextResponse.json({ status: "claimed", id: claimedId });
}
