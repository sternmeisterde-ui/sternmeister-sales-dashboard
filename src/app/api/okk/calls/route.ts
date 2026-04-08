import { NextRequest, NextResponse } from "next/server";
import { getOkkDbForDepartment } from "@/lib/db/okk";
import { okkCalls, okkEvaluations, okkManagers, TranscriptSpeakerSegment } from "@/lib/db/schema-okk";
import { eq, and, gte, lte, desc, sql } from "drizzle-orm";
import { cached } from "@/lib/kommo/cache";

// ─── Helper: format date (same pattern as queries-existing.ts) ──────

function formatDate(date: Date | null): string {
  if (!date) return "—";
  const tz = "Europe/Moscow";
  const callDate = new Date(date);
  const now = new Date();

  const nowMsk = now.toLocaleDateString("en-CA", { timeZone: tz });
  const callMsk = callDate.toLocaleDateString("en-CA", { timeZone: tz });

  const hours = callDate.toLocaleString("ru-RU", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });

  if (callMsk === nowMsk) {
    return `Сегодня, ${hours}`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayMsk = yesterday.toLocaleDateString("en-CA", { timeZone: tz });
  if (callMsk === yesterdayMsk) {
    return `Вчера, ${hours}`;
  }

  const day = callDate.toLocaleString("ru-RU", { timeZone: tz, day: "2-digit" });
  const month = callDate.toLocaleString("ru-RU", { timeZone: tz, month: "2-digit" });
  return `${day}.${month}, ${hours}`;
}

// ─── Helper: build speaker-labelled transcript ──────────────────────
// AssemblyAI returns speakers as "A", "B", etc.
// We determine who is the manager based on call direction:
//   outbound → manager called the client → client picks up first → Speaker A = Клиент
//   inbound  → client called the company → manager answers first → Speaker A = Менеджер
// Fallback: assume outbound (most sales calls are outbound).

function buildSpeakerTranscript(
  speakersRaw: unknown,
  direction: string | null,
): string {
  // transcript_speakers is stored as { utterances: [...] }
  const utterances: TranscriptSpeakerSegment[] = (() => {
    if (!speakersRaw) return [];
    if (Array.isArray(speakersRaw)) return speakersRaw;
    if (typeof speakersRaw === "object" && "utterances" in (speakersRaw as any)) {
      return (speakersRaw as any).utterances ?? [];
    }
    return [];
  })();

  if (utterances.length === 0) return "";

  // Determine which speaker label is the manager
  const isOutbound = direction !== "inbound"; // default outbound
  // outbound: first speaker (A) = Client, second (B) = Manager
  // inbound:  first speaker (A) = Manager, second (B) = Client
  const firstSpeaker = utterances[0]?.speaker ?? "A";
  const managerSpeaker = isOutbound
    ? (utterances.find((u) => u.speaker !== firstSpeaker)?.speaker ?? "B")
    : firstSpeaker;

  return utterances
    .map((u) => {
      const role = u.speaker === managerSpeaker ? "[Продавец]" : "[Клиент]";
      return `${role}: ${u.text}`;
    })
    .join("\n");
}

// ─── GET handler ─────────────────────────────────────────────
// Returns data in the SAME shape as /api/calls:
//   { success: true, data: { calls: ManagerCall[], managers: ManagerStat[] } }

const OKK_CACHE_TTL = 2 * 60 * 1000; // 2 min

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const deptParam = sp.get("department") ?? "b2g";
    const department = (deptParam === "b2b" ? "b2b" : "b2g") as "b2g" | "b2b";

    const cacheKey = `okk-calls:${department}:${sp.get("from") || ""}:${sp.get("to") || ""}:${sp.get("status") || ""}:${sp.get("manager_id") || ""}`;
    const result = await cached(cacheKey, OKK_CACHE_TTL, () => buildOkkResponse(department, sp));
    return NextResponse.json(result);
  } catch (error) {
    console.error("[OKK Calls API] Error:", error);
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

async function buildOkkResponse(department: "b2g" | "b2b", sp: URLSearchParams) {
    const db = getOkkDbForDepartment(department);

    // Build WHERE conditions
    const conditions: ReturnType<typeof eq>[] = [];

    const fromParam = sp.get("from");
    if (fromParam) {
      // Parse as start of day in local (Berlin) timezone
      const parts = fromParam.split("-").map(Number);
      const fromDate = new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0);
      if (!isNaN(fromDate.getTime())) {
        conditions.push(gte(okkCalls.callCreatedAt, fromDate));
      }
    }

    const toParam = sp.get("to");
    if (toParam) {
      // Parse as end of day in local (Berlin) timezone
      const parts = toParam.split("-").map(Number);
      const toDate = new Date(parts[0], parts[1] - 1, parts[2], 23, 59, 59, 999);
      if (!isNaN(toDate.getTime())) {
        conditions.push(lte(okkCalls.callCreatedAt, toDate));
      }
    }

    const statusParam = sp.get("status");
    if (statusParam) {
      conditions.push(eq(okkCalls.status, statusParam));
    } else {
      // By default only show completed calls: "notified" (OKK pipeline) or "evaluated"
      conditions.push(
        sql`${okkCalls.status} IN ('notified', 'evaluated', 'completed')`
      );
    }

    // Only show calls that have been evaluated (skip short/unevaluated)
    conditions.push(sql`${okkCalls.id} IN (SELECT call_id FROM evaluations WHERE total_score IS NOT NULL)`);

    const managerIdParam = sp.get("manager_id");
    if (managerIdParam) {
      conditions.push(eq(okkCalls.managerId, managerIdParam));
    }

    const whereClause =
      conditions.length > 0 ? and(...conditions) : undefined;

    // ── All 3 queries in PARALLEL ────────────────────────────
    const [rows, allManagerRows, managerAggRows] = await Promise.all([
      // Query 1: Calls — LIGHT fields only (no transcript, no full evaluationJson)
      db
        .select({
          id: okkCalls.id,
          managerId: okkCalls.managerId,
          managerName: okkCalls.managerName,
          durationSeconds: okkCalls.durationSeconds,
          recordingUrl: okkCalls.recordingUrl,
          direction: okkCalls.direction,
          kommoLeadUrl: okkCalls.kommoLeadUrl,
          callCreatedAt: okkCalls.callCreatedAt,
          // Evaluation — only score + blocks summary (no transcript/mistakes/recommendations)
          totalScore: okkEvaluations.totalScore,
          evaluationJson: okkEvaluations.evaluationJson,
          callNumber: okkEvaluations.callNumber,
        })
        .from(okkCalls)
        .leftJoin(okkEvaluations, eq(okkCalls.id, okkEvaluations.callId))
        .where(whereClause)
        .orderBy(desc(okkCalls.callCreatedAt))
        .limit(200),

      // Query 2: All managers (only role='manager', active)
      db
        .select({
          id: okkManagers.id,
          name: okkManagers.name,
          role: okkManagers.role,
          line: okkManagers.line,
        })
        .from(okkManagers)
        .where(
          and(
            eq(okkManagers.isActive, true),
            eq(okkManagers.role, "manager"),
          )
        )
        .orderBy(okkManagers.name),

      // Query 3: Per-manager call aggregates
      db
        .select({
          managerId: okkCalls.managerId,
          count: sql<number>`count(distinct ${okkCalls.id})::int`,
          evaluatedCount: sql<number>`count(${okkEvaluations.id})::int`,
          avgScore: sql<number>`round(avg(${okkEvaluations.totalScore}))::int`,
        })
        .from(okkCalls)
        .leftJoin(okkEvaluations, eq(okkCalls.id, okkEvaluations.callId))
        .where(whereClause)
        .groupBy(okkCalls.managerId),
    ]);

    // ── Convert to ManagerCall[] format (server-side, like queries-existing) ──
    const calls = rows.map((row) => {
      const dSec = row.durationSeconds || 0;
      const mins = Math.floor(dSec / 60);
      const secs = dSec % 60;

      // Extract client scoring and raw max score from evaluation JSON
      const evalJson = row.evaluationJson as Record<string, unknown> | null;
      const clientScoring = (evalJson?.client_scoring as unknown) || null;
      const totalMaxScore =
        typeof evalJson?.total_max_score === "number" ? evalJson.total_max_score : undefined;

      // LIGHT blocks: only id/name/score/maxScore — no criteria (loaded on-demand via /api/okk/calls/[callId])
      const blocks = (row.evaluationJson?.blocks || [])
        .filter((b) => (b.criteria && b.criteria.length > 0) || b.feedback)
        .map((b, i) => ({
          id: String(i),
          name: b.name || "",
          score: b.block_score ?? b.score ?? 0,
          maxScore: b.max_block_score ?? b.max_score ?? 0,
          criteria: [] as { id: number; name: string; score: number; maxScore: number; feedback: string; quote: string }[],
          feedback: "",
        }));

      return {
        id: row.id,
        name: row.managerName || "—",
        avatarUrl: "",
        callDuration: `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`,
        callNumber: row.callNumber || "",
        date: formatDate(row.callCreatedAt),
        score: row.totalScore || 0,
        totalMaxScore,
        hasRecording: !!row.recordingUrl,
        audioUrl: row.recordingUrl
          ? `/api/okk/audio/${row.id}?dept=${department}`
          : "#",
        kommoUrl: row.kommoLeadUrl || "",
        // Heavy fields empty — loaded on-demand via /api/okk/calls/[callId]
        transcript: "",
        aiFeedback: "",
        summary: "",
        evalSummary: "",
        blocks,
        clientScoring,
      };
    });

    // ── Merge managers table with call aggregates ────────────
    const aggByManagerId = new Map(
      managerAggRows.map((m) => [m.managerId, m])
    );

    const managers = allManagerRows.map((m) => {
      const agg = aggByManagerId.get(m.id);
      return {
        id: m.id,
        name: m.name || "—",
        avatarUrl: "",
        totalCalls: Number(agg?.count) || 0,
        avgScore: Number(agg?.avgScore) || 0,
        avgDuration: "—",
        conversionRate: "—",
        role: m.role || "manager",
        line: m.line || null,
      };
    });

    // ── Same response shape as /api/calls ────────────────────
    return {
      success: true,
      data: { calls, managers },
    };
}
