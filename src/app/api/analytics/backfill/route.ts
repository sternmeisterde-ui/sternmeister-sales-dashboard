// GET /api/analytics/backfill?from=YYYY-MM-DD&to=YYYY-MM-DD&chunkDays=7
//
// Server-side chunked backfill. Slices [from, to] into N-day windows and
// runs the existing runSync for each — same pipeline as /api/analytics/sync
// but tolerant of a 3-month range that would otherwise blow the per-request
// budget.
//
// Streams progress as plain text (one line per chunk) so the browser shows
// progress in real time and the connection doesn't sit idle long enough for
// proxies to abort it.

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { runSync } from "@/lib/etl";

export const dynamic = "force-dynamic";
export const maxDuration = 1800; // 30 min — full 3-month backfill

function parseDay(s: string | null): Date | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function GET(req: NextRequest): Promise<Response> {
  const session = await getSession();
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const from = parseDay(url.searchParams.get("from"));
  const to = parseDay(url.searchParams.get("to"));
  const chunkDays = Math.max(
    1,
    Math.min(30, Number(url.searchParams.get("chunkDays")) || 7),
  );

  if (!from || !to) {
    return NextResponse.json(
      { error: "from + to required as YYYY-MM-DD" },
      { status: 400 },
    );
  }
  if (from > to) {
    return NextResponse.json({ error: "from must be <= to" }, { status: 400 });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const write = (line: string) => controller.enqueue(enc.encode(line + "\n"));

      let cur = new Date(from);
      let chunkNum = 0;
      const totalChunks =
        Math.ceil((to.getTime() - from.getTime()) / (chunkDays * 86_400_000)) + 1;
      let totalLeads = 0;
      let totalComms = 0;
      let totalStatus = 0;
      let totalTasks = 0;
      const failures: Array<{ from: string; to: string; error: string }> = [];

      write(
        `Backfill ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)} | ${totalChunks} chunks of ${chunkDays}d`,
      );

      while (cur <= to) {
        chunkNum++;
        const chunkEndMs = Math.min(
          cur.getTime() + (chunkDays - 1) * 86_400_000,
          to.getTime(),
        );
        const chunkEnd = new Date(chunkEndMs);
        chunkEnd.setUTCHours(23, 59, 59, 999);
        const fromStr = cur.toISOString().slice(0, 10);
        const toStr = new Date(chunkEndMs).toISOString().slice(0, 10);
        const t0 = Date.now();
        write(`[${chunkNum}/${totalChunks}] ${fromStr} → ${toStr} ...`);

        try {
          const result = await runSync({
            fromDate: cur,
            toDate: chunkEnd,
          });
          const dt = Math.round((Date.now() - t0) / 1000);
          totalLeads += result.leads;
          totalComms += result.communications;
          totalStatus += result.statusChanges;
          totalTasks += result.tasks;
          write(
            `  ok ${dt}s | leads=${result.leads} comms=${result.communications} sla=${result.slaRows} status=${result.statusChanges} tasks=${result.tasks}`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          write(`  FAILED: ${msg}`);
          failures.push({ from: fromStr, to: toStr, error: msg });
        }

        cur = new Date(chunkEndMs + 86_400_000);
        cur.setUTCHours(0, 0, 0, 0);
      }

      write("=== DONE ===");
      write(
        `Totals: leads=${totalLeads} communications=${totalComms} status_changes=${totalStatus} tasks=${totalTasks}`,
      );
      if (failures.length > 0) {
        write(`Failures (${failures.length}):`);
        for (const f of failures) {
          write(`  ${f.from} → ${f.to}: ${f.error}`);
        }
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
