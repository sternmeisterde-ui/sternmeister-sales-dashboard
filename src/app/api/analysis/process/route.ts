import { NextResponse } from "next/server";
import { getDbForDepartment } from "@/lib/db";
import { callAnalyses } from "@/lib/db/schema-existing";
import { eq, or } from "drizzle-orm";
import { runAnalysisPipeline } from "@/lib/analysis/pipeline";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";
// 30 min ceiling. With concurrency pools (Kommo=5, AssemblyAI=4, Grok=3) and
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

  const [pending] = await db
    .select({ id: callAnalyses.id, status: callAnalyses.status })
    .from(callAnalyses)
    .where(or(eq(callAnalyses.status, "pending"), eq(callAnalyses.status, "processing")))
    .limit(1);

  if (!pending) {
    return NextResponse.json({ status: "idle" });
  }

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
