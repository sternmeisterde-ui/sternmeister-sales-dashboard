/**
 * Analysis worker — shared claim logic.
 *
 * Both entry points (the session-authed /api/analysis/process kick and the
 * cron-authed /api/analysis/process/tick) funnel through claimNextAnalysis()
 * so the queue semantics live in exactly one place:
 *
 *   • Global single-flight: at most ONE analysis runs at a time. All analyses
 *     (both departments) live in D1, and every Kommo request in the app shares
 *     one global 1 req/sec rate limiter (src/lib/kommo/client.ts) with the ETL
 *     cron — two concurrent discovery scans would starve each other into the
 *     soft-deadline ceiling and thrash. Queued jobs wait as `pending` (FIFO).
 *
 *   • Resume-first ordering: a `processing` row with a stale heartbeat is a
 *     chunked job that yielded (or a killed worker) — it is picked BEFORE any
 *     `pending` row, otherwise a yielded job and a fresh job would ping-pong
 *     and neither would finish.
 */
import { sql } from "drizzle-orm";
import { getDbForDepartment } from "@/lib/db";
import { callAnalyses } from "@/lib/db/schema-existing";

/**
 * Atomically claim the next runnable analysis, or return null when there is
 * nothing claimable / another job is live.
 *
 * Single UPDATE...WHERE...RETURNING — Neon HTTP mode runs each request as its
 * own implicit transaction, so this must stay one statement. Two concurrent
 * claimers cannot both win:
 *   • Both subqueries are deterministic → they pick the SAME row X.
 *   • The UPDATE acquires a row-level lock on X; the second waits.
 *   • In READ COMMITTED (default), the loser re-evaluates the outer WHERE
 *     after the lock is granted (Postgres EvalPlanQual). Since the winner
 *     already flipped status/bumped updated_at, the WHERE no longer matches
 *     and the loser gets zero rows back.
 *
 * FOR UPDATE SKIP LOCKED is intentionally NOT used: with Neon HTTP the row
 * lock would release at statement end anyway; the re-evaluation is the actual
 * interlock here.
 *
 * Claimable = `pending` OR `processing` with a STALE heartbeat (>2 min without
 * an updated_at bump). The pipeline bumps updated_at every ~20s while alive
 * (see runAnalysisPipeline), so a live run is never reclaimed; a worker killed
 * by deploy/crash goes stale and is auto-resumed. NULL updated_at = a row that
 * never heartbeated (legacy, or killed before the first bump) → stale.
 *
 * The NOT EXISTS clause is the single-flight gate: refuse to claim anything
 * while a DIFFERENT row has a fresh heartbeat. The race window across two
 * different rows (claimer A reads "nobody alive" just before claimer B's first
 * heartbeat lands) is sub-second with a 60s cron tick and self-healing — file
 * writes are idempotent — so it is documented, not engineered around.
 */
export async function claimNextAnalysis(): Promise<string | null> {
  const db = getDbForDepartment("b2g"); // analyses for BOTH departments live in D1

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
        ORDER BY (status = 'processing') DESC, created_at ASC
        LIMIT 1
      )
      AND ${claimable}
      AND NOT EXISTS (
        SELECT 1 FROM call_analyses other
        WHERE other.status = 'processing'
          AND other.id <> call_analyses.id
          AND other.updated_at IS NOT NULL
          AND other.updated_at >= now() - interval '2 minutes'
      )
    `)
    .returning({ id: callAnalyses.id });

  return claimed.length > 0 ? claimed[0].id : null;
}
