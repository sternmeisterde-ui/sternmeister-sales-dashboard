import { NextResponse } from "next/server";
import { getDbForDepartment } from "@/lib/db";
import { callAnalyses } from "@/lib/db/schema-existing";
import { and, eq, sql } from "drizzle-orm";
import { runAnalysisPipeline } from "@/lib/analysis/pipeline";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";
// 30 min ceiling. With concurrency pools (Kommo=5, Scribe=4, Grok=3) and
// MAX_CALLS=500, worst-case ~25 min per run. Dokploy has no platform-side
// timeout, but the SSE stream needs Next.js to keep the route alive.
export const maxDuration = 1800;

/**
 * GET /api/analysis/process
 *
 * Uses streaming response to keep the connection alive during
 * long-running pipeline (prevents proxy timeout after 60s).
 * Sends periodic heartbeat comments while pipeline runs.
 */
export async function GET() {
  const session = await getSession();
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = getDbForDepartment("b2g");

  // Atomic claim via single UPDATE...WHERE...RETURNING. Two concurrent
  // /process callers (e.g. Resume click racing the polling effect) cannot
  // both win:
  //   • Both subqueries may pick the same row X.
  //   • The UPDATE acquires a row-level lock on X; the second waits.
  //   • In READ COMMITTED (default), the loser re-evaluates `status='pending'`
  //     after the lock is granted (Postgres EvalPlanQual). Since the winner
  //     already flipped it to `processing`, the WHERE no longer matches and
  //     the loser gets zero rows back.
  //
  // FOR UPDATE SKIP LOCKED is intentionally NOT used: this is Neon HTTP mode
  // where each request runs as its own implicit transaction (no explicit
  // BEGIN), so the row-lock would release at statement end anyway. The
  // re-evaluation is the actual interlock here.
  //
  // We deliberately DON'T auto-claim `processing` rows: previously that
  // mechanism handled SSE-disconnect recovery, but it also let two browsers
  // concurrently run the pipeline on the same row. Genuinely orphaned
  // `processing` rows are recovered by the user via Resume (after explicitly
  // deleting and re-creating, or — when status drifts to error — clicking
  // Resume which routes back through `pending` here).
  const claimed = await db
    .update(callAnalyses)
    .set({ status: "processing" })
    .where(
      and(
        eq(callAnalyses.status, "pending"),
        sql`${callAnalyses.id} = (SELECT id FROM call_analyses WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1)`,
      ),
    )
    .returning({ id: callAnalyses.id });

  if (claimed.length === 0) {
    return NextResponse.json({ status: "idle" });
  }
  const pending = { id: claimed[0].id };

  // Use streaming to keep connection alive during long pipeline
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // Send initial message
      controller.enqueue(encoder.encode(`data: {"status":"started","id":"${pending.id}"}\n\n`));

      // Heartbeat every 20s to prevent proxy timeout
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`data: {"heartbeat":true}\n\n`));
        } catch {
          clearInterval(heartbeat);
        }
      }, 20000);

      try {
        await runAnalysisPipeline(pending.id);
        controller.enqueue(encoder.encode(`data: {"status":"done","id":"${pending.id}"}\n\n`));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        controller.enqueue(encoder.encode(`data: {"status":"error","error":"${msg.replace(/"/g, '\\"')}"}\n\n`));
      } finally {
        clearInterval(heartbeat);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
