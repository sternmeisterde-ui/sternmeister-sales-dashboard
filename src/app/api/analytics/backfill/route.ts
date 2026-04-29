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
import { addDaysCivil, diffDaysCivil, parseDateBoundary } from "@/lib/utils/date";

export const dynamic = "force-dynamic";
export const maxDuration = 1800; // 30 min — full 3-month backfill

/** Parse YYYY-MM-DD as a Berlin-local civil string (no TZ conversion).
 *  Returns the same "YYYY-MM-DD" for downstream civil arithmetic. */
function parseCivil(s: string | null): string | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

export async function GET(req: NextRequest): Promise<Response> {
  const session = await getSession();
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const fromCivil = parseCivil(url.searchParams.get("from"));
  const toCivil = parseCivil(url.searchParams.get("to"));
  const chunkDays = Math.max(
    1,
    Math.min(30, Number(url.searchParams.get("chunkDays")) || 7),
  );

  if (!fromCivil || !toCivil) {
    return NextResponse.json(
      { error: "from + to required as YYYY-MM-DD" },
      { status: 400 },
    );
  }
  if (diffDaysCivil(fromCivil, toCivil) > 0) {
    return NextResponse.json({ error: "from must be <= to" }, { status: 400 });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const write = (line: string) => controller.enqueue(enc.encode(line + "\n"));

      let curCivil = fromCivil;
      let chunkNum = 0;
      const totalChunks =
        Math.ceil((diffDaysCivil(toCivil, fromCivil) + 1) / chunkDays);
      let totalLeads = 0;
      let totalComms = 0;
      let totalStatus = 0;
      let totalTasks = 0;
      const failures: Array<{ from: string; to: string; error: string }> = [];

      write(
        `Backfill ${fromCivil} → ${toCivil} (Berlin) | ${totalChunks} chunks of ${chunkDays}d`,
      );

      while (diffDaysCivil(curCivil, toCivil) <= 0) {
        chunkNum++;
        // Civil-day chunk: [curCivil, curCivil+chunkDays-1] clamped to toCivil.
        // Doing the slicing in civil days (not milliseconds) is what keeps the
        // chunk boundaries aligned to Berlin midnight on every iteration —
        // including across CET↔CEST transitions where a UTC-millis stride
        // would land at 23:00 / 01:00 and skip or double a day's data.
        const chunkEndCivil =
          diffDaysCivil(addDaysCivil(curCivil, chunkDays - 1), toCivil) > 0
            ? toCivil
            : addDaysCivil(curCivil, chunkDays - 1);
        const chunkStart = parseDateBoundary(curCivil, "start")!;
        const chunkEnd = parseDateBoundary(chunkEndCivil, "end")!;
        const t0 = Date.now();
        write(`[${chunkNum}/${totalChunks}] ${curCivil} → ${chunkEndCivil} ...`);

        try {
          const result = await runSync({
            fromDate: chunkStart,
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
          failures.push({ from: curCivil, to: chunkEndCivil, error: msg });
        }

        curCivil = addDaysCivil(chunkEndCivil, 1);
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
