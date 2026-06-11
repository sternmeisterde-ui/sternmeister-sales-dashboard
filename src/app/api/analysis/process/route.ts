import { NextResponse } from "next/server";
import { getDbForDepartment } from "@/lib/db";
import { callAnalyses } from "@/lib/db/schema-existing";
import { eq, sql } from "drizzle-orm";
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
  // Claimable = a `pending` row OR a `processing` row whose heartbeat went
  // STALE (>2 min without an `updated_at` bump). A live run bumps updated_at
  // every ~20s (SSE heartbeat below) and on every call, so it's never stale
  // and can't be double-claimed — this is the precise liveness signal the old
  // "never auto-claim processing" comment lacked. NULL updated_at = a row that
  // never heartbeated (legacy, or a worker killed before the heartbeat landed)
  // → treated as stale. This is what auto-recovers runs the 30-min maxDuration
  // ceiling kills mid-way: the next poll reclaims and resumes them (the
  // pipeline skips already-saved files, so no re-transcription cost).
  //
  // Interlock against two concurrent /process callers: both subqueries may pick
  // row X; the UPDATE row-locks X, the loser re-evaluates the outer `AND
  // (...)` after the lock. Since the winner already bumped updated_at=now()
  // (no longer stale) and flipped pending→processing, the loser's WHERE no
  // longer matches → zero rows. pending is prioritised over stale-processing so
  // fresh work isn't starved by a slow resume.
  const claimable = sql`(
    status = 'pending'
    OR (status = 'processing' AND (updated_at IS NULL OR updated_at < now() - interval '2 minutes'))
  )`;
  const claimed = await db
    .update(callAnalyses)
    .set({ status: "processing", updatedAt: sql`now()` })
    .where(sql`
      ${callAnalyses.id} = (
        SELECT id FROM call_analyses
        WHERE ${claimable}
        ORDER BY (status = 'pending') DESC, created_at ASC
        LIMIT 1
      )
      AND ${claimable}
    `)
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

      // Heartbeat every 20s: keeps the proxy connection alive AND bumps the
      // row's `updated_at` in the DB so the claim logic above sees this run as
      // alive and won't reclaim it as orphaned. When the function is killed
      // (maxDuration / restart), this interval stops → updated_at goes stale
      // → the next /process poll reclaims the row and resumes it.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`data: {"heartbeat":true}\n\n`));
        } catch {
          clearInterval(heartbeat);
        }
        // Fire-and-forget DB heartbeat; swallow errors (a missed bump only
        // risks a harmless reclaim attempt the live pipeline corrects).
        db.update(callAnalyses)
          .set({ updatedAt: sql`now()` })
          .where(eq(callAnalyses.id, pending.id))
          .catch(() => {});
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
