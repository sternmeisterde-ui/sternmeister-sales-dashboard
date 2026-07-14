import { NextRequest, NextResponse } from "next/server";
import { getOkkDbForDepartment } from "@/lib/db/okk";
import { okkCalls, okkEvaluations, okkManagers } from "@/lib/db/schema-okk";
import { eq, and, gte, lte, desc, sql, inArray } from "drizzle-orm";
import { cached } from "@/lib/kommo/cache";
import { formatCallDate, parseDateBoundary } from "@/lib/utils/date";
import { promptTypeForLine, verticalPromptTypes } from "@/lib/config/tenant";

// ─── GET handler ─────────────────────────────────────────────
// Returns data in the SAME shape as /api/calls:
//   { success: true, data: { calls: ManagerCall[], managers: ManagerStat[] } }

const OKK_CACHE_TTL = 2 * 60 * 1000; // 2 min

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const deptParam = sp.get("department") ?? "b2g";
    const department = (deptParam === "b2b" ? "b2b" : "b2g") as "b2g" | "b2b";

    const cacheKey = `okk-calls:${department}:${sp.get("from") || ""}:${sp.get("to") || ""}:${sp.get("status") || ""}:${sp.get("manager_id") || ""}:${sp.get("line") || ""}:${sp.get("vertical") || ""}`;
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

    // b2g: уволенных менеджеров не показываем (ни звонки, ни дропдаун). Флаг
    // okkManagers.isActive синкается из master_managers (источник правды) — при
    // увольнении sync ставит is_active=false. Фильтруем по okk-стороне (тот же
    // коннекшн; id okk-менеджеров НЕ равны master.id — связь по
    // kommoUserId/telegramId/name, см. /api/managers).
    // b2b: наоборот — история удалённого менеджера должна оставаться видимой
    // за периоды, когда он работал (как в Звонках/Дейли). Фильтр по isActive
    // на звонках НЕ ставим (период и managerId IS NOT NULL ниже уже ограничивают
    // выборку), а в дропдаун добавляем неактивных со звонками в периоде.
    const conditions: ReturnType<typeof eq>[] = [];

    if (department !== "b2b") {
      const activeOkk = await db
        .select({ id: okkManagers.id })
        .from(okkManagers)
        .where(eq(okkManagers.isActive, true));
      conditions.push(inArray(okkCalls.managerId, activeOkk.map((m) => m.id)));
    }

    const fromParam = sp.get("from");
    const fromDate = fromParam ? parseDateBoundary(fromParam, "start") : null;
    if (fromDate) conditions.push(gte(okkCalls.callCreatedAt, fromDate));

    const toParam = sp.get("to");
    const toDate = toParam ? parseDateBoundary(toParam, "end") : null;
    if (toDate) conditions.push(lte(okkCalls.callCreatedAt, toDate));

    const statusParam = sp.get("status");
    if (statusParam) {
      conditions.push(eq(okkCalls.status, statusParam));
    } else {
      // By default only show completed calls: "notified" (OKK pipeline) or "evaluated"
      conditions.push(
        sql`${okkCalls.status} IN ('notified', 'evaluated', 'completed')`
      );
    }

    // Only show calls that have been evaluated AND have a linked manager
    conditions.push(sql`${okkCalls.id} IN (SELECT call_id FROM evaluations WHERE total_score IS NOT NULL)`);
    conditions.push(sql`${okkCalls.managerId} IS NOT NULL`);

    // Hide calls withdrawn by audit/cleanup. Plain processing tags like
    // "Retro CRM-fetch ...", "Skipped: ..." stay visible — those are status
    // notes, not withdrawals. Withdrawal markers always start with "Removed"
    // or "Cleanup" (see scripts/preliminary-remove-complaint-evals.ts and
    // prior dual-filter cleanups of 2026-05-16 / 2026-05-20 in OKK repo).
    conditions.push(sql`
      (${okkCalls.errorMessage} IS NULL
       OR (${okkCalls.errorMessage} NOT ILIKE 'Removed%'
           AND ${okkCalls.errorMessage} NOT ILIKE 'Cleanup%'))
    `);

    const managerIdParam = sp.get("manager_id");
    if (managerIdParam) {
      conditions.push(eq(okkCalls.managerId, managerIdParam));
    }

    // B2B line filter → filter by prompt_type in evaluations.
    // B2G uses the manager.line column (not prompt_type), so skip here.
    const lineParam = sp.get("line");
    if (lineParam && department === "b2b") {
      const pt = promptTypeForLine(department, lineParam);
      if (pt) {
        conditions.push(sql`${okkCalls.id} IN (SELECT call_id FROM evaluations WHERE prompt_type = ${pt})`);
      }
    }

    // Вертикаль Бух/Мед (только b2g) → фильтр по prompt_type мед/бух-линий.
    // 'all'/отсутствие → без фильтра (обе вертикали). Линейный фильтр b2g
    // (manager.line) применяется на клиенте и ортогонален вертикали.
    const verticalParam = sp.get("vertical");
    if (department === "b2g" && (verticalParam === "buh" || verticalParam === "med")) {
      const pts = verticalPromptTypes("b2g", verticalParam);
      if (pts.length > 0) {
        const ptList = sql.join(pts.map((p) => sql`${p}`), sql`, `);
        conditions.push(
          sql`${okkCalls.id} IN (SELECT call_id FROM evaluations WHERE prompt_type IN (${ptList}))`,
        );
      }
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
          pairRole: okkCalls.pairRole,
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
        // Order by eval createdAt DESC so first row per call is the latest evaluation
        .orderBy(desc(okkCalls.callCreatedAt), desc(okkEvaluations.createdAt))
        // Cap at 5k to bound payload — a B2G month is ~600 evaluated calls,
        // so 5k covers ~8 months even with re-evaluation duplicates. Past
        // that the consumer should switch to a paginated query, not silently
        // truncate (which used to drop early-period calls from the per-manager
        // counters and broke payroll attribution).
        .limit(5000),

      // Query 2: Managers visible in the dropdown.
      // b2g — только активные (is_active синкается из master), уволенных не
      // показываем по запросу бизнеса.
      // b2b — активные ∪ неактивные, у кого есть звонки в выбранном периоде:
      // удалённый менеджер выбирается в фильтре за периоды, когда он работал.
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
            sql`${okkManagers.role} IN ('manager', 'teamlead', 'rop')`,
            department === "b2b"
              ? sql`(${okkManagers.isActive} = TRUE OR ${okkManagers.id} IN (
                  SELECT DISTINCT ${okkCalls.managerId} FROM ${okkCalls}
                  WHERE ${okkCalls.managerId} IS NOT NULL
                    ${fromDate ? sql`AND ${okkCalls.callCreatedAt} >= ${fromDate}` : sql``}
                    ${toDate ? sql`AND ${okkCalls.callCreatedAt} <= ${toDate}` : sql``}
                ))`
              : eq(okkManagers.isActive, true),
          ),
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

    // ── Deduplicate: keep only the first (latest eval) row per call ID ──
    // No slice() here — we used to truncate to 200 which silently dropped
    // early-period calls from per-manager counters in the consumer (and
    // therefore from payroll attribution). The query's limit(5000) is the
    // single source of truth for payload size.
    const seenCallIds = new Set<string>();
    const uniqueRows = rows.filter((row) => {
      if (seenCallIds.has(row.id)) return false;
      seenCallIds.add(row.id);
      return true;
    });

    // ── Chain aggregates for continuation tails ──────────────────────────
    // A stitched conversation's evaluation lives on its TAIL row, whose own
    // duration is just the last leg («4 мин» on a 70-min conversation) —
    // the source of the «засчитался только последний звонок» complaints
    // (b2b batch 07.2026). Fetch legs count + prior duration for the visible
    // tails in ONE query and surface the TOTAL to the UI.
    const tailIds = uniqueRows.filter((r) => r.pairRole === "continuation").map((r) => r.id);
    const chainAggByTail = new Map<string, { legs: number; priorDur: number }>();
    if (tailIds.length > 0) {
      const chainRows = await db
        .select({
          tailId: okkCalls.pairedCallId,
          legs: sql<number>`count(*)::int`,
          priorDur: sql<number>`coalesce(sum(${okkCalls.durationSeconds}), 0)::int`,
        })
        .from(okkCalls)
        .where(and(inArray(okkCalls.pairedCallId, tailIds), eq(okkCalls.pairRole, "primary")))
        .groupBy(okkCalls.pairedCallId);
      for (const r of chainRows) {
        if (r.tailId) chainAggByTail.set(r.tailId, { legs: Number(r.legs) || 0, priorDur: Number(r.priorDur) || 0 });
      }
    }

    // ── Convert to ManagerCall[] format (server-side, like queries-existing) ──
    const calls = uniqueRows.map((row) => {
      const chain = row.pairRole === "continuation" ? chainAggByTail.get(row.id) : undefined;
      // Conversation-level duration: tail + all stitched legs.
      const dSec = (row.durationSeconds || 0) + (chain?.priorDur || 0);
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
        // >1 → the row is a stitched conversation of N calls (badge in UI).
        chainLegs: chain ? chain.legs + 1 : undefined,
        callNumber: row.callNumber || "",
        date: formatCallDate(row.callCreatedAt),
        // Raw ISO so clients can filter without round-tripping the display string.
        startedAtIso: row.callCreatedAt ? new Date(row.callCreatedAt).toISOString() : null,
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
