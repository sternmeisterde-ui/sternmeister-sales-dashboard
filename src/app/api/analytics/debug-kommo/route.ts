// GET /api/analytics/debug-kommo?from=2026-04-28T00:00:00Z&to=2026-04-28T23:59:59Z
//
// Direct passthrough to Kommo /api/v4/{entity}/notes with the same filter
// the ETL uses — confirms whether call notes actually come back from Kommo
// for a given window. If this returns 0 calls but the Kommo UI shows calls
// for the same window, the bug is in our filter syntax. If this returns
// hundreds, the bug is in the ETL/dashboard downstream.

import { NextRequest, NextResponse } from "next/server";
import { getAllCallNotesByDate } from "@/lib/kommo/client";

export const dynamic = "force-dynamic";

function parseInstant(s: string | null, fallback: Date): Date {
  if (!s) return fallback;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return fallback;
  return d;
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const from = parseInstant(url.searchParams.get("from"), today);
    const to = parseInstant(
      url.searchParams.get("to"),
      new Date(today.getTime() + 24 * 60 * 60_000),
    );

    const fromTs = Math.floor(from.getTime() / 1000);
    const toTs = Math.floor(to.getTime() / 1000);

    const t0 = Date.now();
    const notes = await getAllCallNotesByDate(fromTs, toTs);
    const elapsedMs = Date.now() - t0;

    // Group by entityType + bucket by Berlin-local day
    const byEntity = new Map<string, number>();
    const byDay = new Map<string, number>();
    let firstCreatedAt: number | null = null;
    let lastCreatedAt: number | null = null;
    for (const n of notes) {
      byEntity.set(n.entityType, (byEntity.get(n.entityType) ?? 0) + 1);
      const day = new Date(n.createdAt * 1000).toLocaleDateString("en-CA", {
        timeZone: "Europe/Berlin",
      });
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
      if (firstCreatedAt === null || n.createdAt < firstCreatedAt) firstCreatedAt = n.createdAt;
      if (lastCreatedAt === null || n.createdAt > lastCreatedAt) lastCreatedAt = n.createdAt;
    }

    return NextResponse.json({
      window: {
        from: from.toISOString(),
        to: to.toISOString(),
        fromTs,
        toTs,
      },
      total: notes.length,
      elapsedMs,
      byEntity: Object.fromEntries(byEntity),
      byDay: Object.fromEntries(
        Array.from(byDay.entries()).sort(([a], [b]) => a.localeCompare(b)),
      ),
      firstCreatedAt: firstCreatedAt
        ? new Date(firstCreatedAt * 1000).toISOString()
        : null,
      lastCreatedAt: lastCreatedAt
        ? new Date(lastCreatedAt * 1000).toISOString()
        : null,
      sample: notes.slice(0, 5).map((n) => ({
        noteId: n.noteId,
        type: n.type,
        entityType: n.entityType,
        entityId: n.entityId,
        createdBy: n.createdBy,
        responsibleUserId: n.responsibleUserId,
        createdAtBerlin: new Date(n.createdAt * 1000).toLocaleString("ru-RU", {
          timeZone: "Europe/Berlin",
        }),
        durationSec: n.duration,
      })),
    });
  } catch (err) {
    console.error("[analytics/debug-kommo] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
