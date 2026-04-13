import { NextRequest, NextResponse } from "next/server";
import { getOkkDbForDepartment } from "@/lib/db/okk";
import { getDbForDepartment } from "@/lib/db";
import {
  okkCalls,
  okkEvaluations,
  okkManagers,
} from "@/lib/db/schema-okk";
import { d1Users, d1Calls, r1Users, r1Calls } from "@/lib/db/schema-existing";
import { eq, sql, and, gte, lte, isNotNull } from "drizzle-orm";
import { cached } from "@/lib/kommo/cache";

const CACHE_TTL = 2 * 60 * 1000;

const EXCLUDED_BLOCKS = new Set([
  "Рекомендации",
  "Фильтры",
  "Скоринг",
  "Скоринг клиента",
]);

// ─── Types ──────────────────────────────────────────────────

interface CriterionScore {
  name: string;
  scores: Record<string, number>;
}

interface BlockData {
  name: string;
  scores: Record<string, number>;
  criteria: CriterionScore[];
}

interface ManagerCriterionScore {
  name: string;
  score: number | null; // null = no data for this criterion
}

interface ManagerBlockScore {
  name: string;
  score: number | null; // null = no data
  criteria: ManagerCriterionScore[];
}

interface ManagerBreakdown {
  id: string;
  name: string;
  overallScore: number | null;
  callCount: number;
  blocks: ManagerBlockScore[];
}

interface AnalyticsResponse {
  periods: string[];
  blocks: BlockData[];
  overallScores: Record<string, number>;
  managers: Array<{ id: string; name: string }>;
  managerBreakdown: ManagerBreakdown[];
  totalCalls: number;
  source: string;
  department: string;
}

// ─── Period helpers ─────────────────────────────────────────

function getISOWeek(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

function toPeriodKey(date: Date, groupBy: string): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  switch (groupBy) {
    case "day": return `${y}-${m}-${d}`;
    case "week": return getISOWeek(date);
    case "month": return `${y}-${m}`;
    default: return `${y}-${m}-${d}`;
  }
}

function buildPeriodRange(from: Date, to: Date, groupBy: string): string[] {
  const periods = new Set<string>();
  const cur = new Date(from);
  while (cur <= to) {
    periods.add(toPeriodKey(cur, groupBy));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return [...periods].sort();
}

// ─── Prompt type mapping ────────────────────────────────────

function getOkkPromptType(department: string, line: string): string | null {
  if (department === "b2b") return "r2_commercial";
  switch (line) {
    case "1": return "d2_qualifier";
    case "2": return "d2_berater";
    case "2b": return "d2_berater2";
    case "3": return "d2_dovedenie";
    default: return null;
  }
}

// ─── Accumulator ────────────────────────────────────────────

interface PeriodAcc {
  totalScoreSum: number;
  totalScoreCount: number;
  blocks: Map<string, { scoreSum: number; count: number }>;
  criteria: Map<string, { scoreSum: number; count: number }>;
  callCount: number;
}

function newAcc(): PeriodAcc {
  return {
    totalScoreSum: 0,
    totalScoreCount: 0,
    blocks: new Map(),
    criteria: new Map(),
    callCount: 0,
  };
}

function processBlocks(
  blocks: unknown[],
  acc: PeriodAcc,
  totalScore: number | null,
): boolean {
  if (!blocks || blocks.length === 0) return false;

  let hadData = false;

  for (const rawBlock of blocks) {
    // Safely extract fields — handles both OKK EvalBlock and roleplay inline types
    const block = rawBlock as Record<string, unknown>;
    const name = typeof block.name === "string" ? block.name : "";
    if (!name || EXCLUDED_BLOCKS.has(name)) continue;

    const blockScore = typeof block.block_score === "number" ? block.block_score
      : typeof block.score === "number" ? block.score : 0;
    const maxBlockScore = typeof block.max_block_score === "number" ? block.max_block_score
      : typeof block.max_score === "number" ? block.max_score : 0;

    if (maxBlockScore <= 0) continue;

    hadData = true;
    const blockPct = Math.round((blockScore / maxBlockScore) * 100);
    const be = acc.blocks.get(name);
    if (be) { be.scoreSum += blockPct; be.count++; }
    else acc.blocks.set(name, { scoreSum: blockPct, count: 1 });

    // Criteria — safely handle any shape
    const criteria = Array.isArray(block.criteria) ? block.criteria : [];
    for (const rawC of criteria) {
      const c = rawC as Record<string, unknown>;
      const cName = typeof c.name === "string" ? c.name : "";
      const cScore = typeof c.score === "number" ? c.score : 0;
      const cMax = typeof c.max_score === "number" ? c.max_score : 0;
      if (!cName || cMax <= 0) continue;

      const pct = Math.round((cScore / cMax) * 100);
      const key = `${name}::${cName}`;
      const ce = acc.criteria.get(key);
      if (ce) { ce.scoreSum += pct; ce.count++; }
      else acc.criteria.set(key, { scoreSum: pct, count: 1 });
    }
  }

  // Only count call if we actually extracted block data
  if (hadData) {
    acc.callCount++;
    if (totalScore !== null && totalScore !== undefined) {
      acc.totalScoreSum += totalScore;
      acc.totalScoreCount++;
    }
  }

  return hadData;
}

// ─── OKK data fetcher ───────────────────────────────────────

async function fetchOkkData(
  department: "b2g" | "b2b",
  line: string,
  from: Date,
  to: Date,
  groupBy: string,
  managerId: string | null,
): Promise<AnalyticsResponse> {
  const db = getOkkDbForDepartment(department);
  const promptType = getOkkPromptType(department, line);

  const conditions = [
    sql`${okkCalls.callCreatedAt} >= ${from}`,
    sql`${okkCalls.callCreatedAt} <= ${to}`,
    sql`${okkCalls.status} IN ('notified', 'evaluated', 'completed')`,
    isNotNull(okkEvaluations.totalScore),
  ];
  if (promptType) {
    conditions.push(sql`${okkEvaluations.promptType} = ${promptType}`);
  }
  if (managerId) {
    conditions.push(eq(okkEvaluations.managerId, managerId));
  }

  // Filter managers by line for B2G (berater2 "2b" → same line "2")
  const managerConditions = [
    eq(okkManagers.isActive, true),
    sql`${okkManagers.role} IN ('manager', 'rop')`,
  ];
  if (department === "b2g" && line) {
    const dbLine = line === "2b" ? "2" : line;
    managerConditions.push(eq(okkManagers.line, dbLine));
  }

  const [rows, managers] = await Promise.all([
    db
      .select({
        callCreatedAt: okkCalls.callCreatedAt,
        totalScore: okkEvaluations.totalScore,
        evaluationJson: okkEvaluations.evaluationJson,
        managerId: okkEvaluations.managerId,
      })
      .from(okkCalls)
      .innerJoin(okkEvaluations, eq(okkCalls.id, okkEvaluations.callId))
      .where(sql.join(conditions, sql` AND `))
      .orderBy(okkCalls.callCreatedAt),
    db
      .select({ id: okkManagers.id, name: okkManagers.name })
      .from(okkManagers)
      .where(and(...managerConditions)),
  ]);

  const periods = buildPeriodRange(from, to, groupBy);
  const accMap = new Map<string, PeriodAcc>();
  for (const p of periods) accMap.set(p, newAcc());

  // Per-manager accumulators (aggregate across all periods)
  const managerAccMap = new Map<string, PeriodAcc>();

  let processedCount = 0;
  for (const row of rows) {
    if (!row.callCreatedAt) continue;
    const evalJson = row.evaluationJson as Record<string, unknown> | null;
    const blocks = evalJson && Array.isArray(evalJson.blocks) ? evalJson.blocks : null;
    if (!blocks || blocks.length === 0) continue;

    const p = toPeriodKey(row.callCreatedAt, groupBy);
    const acc = accMap.get(p);
    if (!acc) continue;

    const had = processBlocks(blocks, acc, row.totalScore);
    if (had) processedCount++;

    // Per-manager accumulation
    if (row.managerId) {
      if (!managerAccMap.has(row.managerId)) managerAccMap.set(row.managerId, newAcc());
      processBlocks(blocks, managerAccMap.get(row.managerId)!, row.totalScore);
    }
  }

  return buildResponse(periods, accMap, managers, managerAccMap, "okk", department, processedCount);
}

// ─── Roleplay data fetcher ──────────────────────────────────

function getRoleplayCallType(department: string, line: string): string | null {
  if (department === "b2b") return null; // B2B has one script
  switch (line) {
    case "1": return "qualifier";
    case "2":
    case "2b": return "berater";
    case "3": return "dovedenie";
    default: return null;
  }
}

async function fetchRoleplayData(
  department: "b2g" | "b2b",
  line: string,
  from: Date,
  to: Date,
  groupBy: string,
  managerId: string | null,
): Promise<AnalyticsResponse> {
  const db = getDbForDepartment(department);
  const callsTable = department === "b2b" ? r1Calls : d1Calls;
  const usersTable = department === "b2b" ? r1Users : d1Users;

  const callType = getRoleplayCallType(department, line);

  const conditions = [
    gte(callsTable.startedAt, from),
    lte(callsTable.startedAt, to),
    isNotNull(callsTable.score),
    isNotNull(callsTable.evaluationJson),
  ];
  if (callType) {
    conditions.push(eq(callsTable.callType, callType));
  }
  if (managerId) {
    conditions.push(eq(callsTable.userId, managerId));
  }

  // Filter managers by line for B2G (berater2 "2b" → same line "2")
  const managerConditions = [
    eq(usersTable.isActive, true),
    sql`${usersTable.role} IN ('manager', 'rop')`,
  ];
  if (department === "b2g" && line) {
    const dbLine = line === "2b" ? "2" : line;
    managerConditions.push(eq(usersTable.line, dbLine));
  }

  const [rows, managers] = await Promise.all([
    db
      .select({
        startedAt: callsTable.startedAt,
        score: callsTable.score,
        evaluationJson: callsTable.evaluationJson,
        userId: callsTable.userId,
      })
      .from(callsTable)
      .where(and(...conditions))
      .orderBy(callsTable.startedAt),
    db
      .select({ id: usersTable.id, name: usersTable.name })
      .from(usersTable)
      .where(and(...managerConditions)),
  ]);

  const periods = buildPeriodRange(from, to, groupBy);
  const accMap = new Map<string, PeriodAcc>();
  for (const p of periods) accMap.set(p, newAcc());

  const managerAccMap = new Map<string, PeriodAcc>();

  let processedCount = 0;
  for (const row of rows) {
    if (!row.startedAt) continue;
    const evalJson = row.evaluationJson as Record<string, unknown> | null;
    const blocks = evalJson && Array.isArray(evalJson.blocks) ? evalJson.blocks : null;
    if (!blocks || blocks.length === 0) continue;

    const p = toPeriodKey(row.startedAt, groupBy);
    const acc = accMap.get(p);
    if (!acc) continue;

    const had = processBlocks(blocks, acc, row.score ?? null);
    if (had) processedCount++;

    if (row.userId) {
      if (!managerAccMap.has(row.userId)) managerAccMap.set(row.userId, newAcc());
      processBlocks(blocks, managerAccMap.get(row.userId)!, row.score ?? null);
    }
  }

  return buildResponse(periods, accMap, managers, managerAccMap, "roleplay", department, processedCount);
}

// ─── Build response from accumulators ───────────────────────

function buildResponse(
  periods: string[],
  accMap: Map<string, PeriodAcc>,
  managers: Array<{ id: string; name: string }>,
  managerAccMap: Map<string, PeriodAcc>,
  source: string,
  department: string,
  totalCalls: number,
): AnalyticsResponse {
  const blockOrder: string[] = [];
  const blockCriteriaOrder = new Map<string, string[]>();

  // Collect block/criteria order from all accumulators
  for (const acc of [...accMap.values(), ...managerAccMap.values()]) {
    for (const bName of acc.blocks.keys()) {
      if (!blockOrder.includes(bName)) blockOrder.push(bName);
    }
    for (const key of acc.criteria.keys()) {
      const [bName, cName] = key.split("::");
      if (!blockCriteriaOrder.has(bName)) blockCriteriaOrder.set(bName, []);
      const arr = blockCriteriaOrder.get(bName)!;
      if (!arr.includes(cName)) arr.push(cName);
    }
  }

  // Trim empty periods from the start (show data from first period with calls)
  let trimmedPeriods = periods;
  const firstNonEmpty = periods.findIndex((p) => {
    const acc = accMap.get(p);
    return acc && acc.callCount > 0;
  });
  if (firstNonEmpty > 0) {
    trimmedPeriods = periods.slice(firstNonEmpty);
  }

  // Period-based blocks (criteria × time) — use trimmed periods
  const blocks: BlockData[] = blockOrder.map((blockName) => {
    const scores: Record<string, number> = {};
    for (const p of trimmedPeriods) {
      const acc = accMap.get(p);
      const be = acc?.blocks.get(blockName);
      if (be && be.count > 0) scores[p] = Math.round(be.scoreSum / be.count);
    }

    const criteriaNames = blockCriteriaOrder.get(blockName) ?? [];
    const criteria: CriterionScore[] = criteriaNames.map((cName) => {
      const key = `${blockName}::${cName}`;
      const cScores: Record<string, number> = {};
      for (const p of trimmedPeriods) {
        const acc = accMap.get(p);
        const ce = acc?.criteria.get(key);
        if (ce && ce.count > 0) cScores[p] = Math.round(ce.scoreSum / ce.count);
      }
      return { name: cName, scores: cScores };
    });

    return { name: blockName, scores, criteria };
  });

  const overallScores: Record<string, number> = {};
  for (const p of trimmedPeriods) {
    const acc = accMap.get(p);
    if (acc && acc.totalScoreCount > 0) {
      overallScores[p] = Math.round(acc.totalScoreSum / acc.totalScoreCount);
    }
  }

  // Per-manager breakdown (aggregate across all periods)
  const managerBreakdown: ManagerBreakdown[] = managers
    .map((mgr) => {
      const acc = managerAccMap.get(mgr.id);
      if (!acc || acc.callCount === 0) return null;

      const mgrBlocks: ManagerBlockScore[] = blockOrder.map((blockName) => {
        const be = acc.blocks.get(blockName);
        const blockScore = be && be.count > 0 ? Math.round(be.scoreSum / be.count) : null;

        const criteriaNames = blockCriteriaOrder.get(blockName) ?? [];
        const mgrCriteria: ManagerCriterionScore[] = criteriaNames.map((cName) => {
          const ce = acc.criteria.get(`${blockName}::${cName}`);
          return { name: cName, score: ce && ce.count > 0 ? Math.round(ce.scoreSum / ce.count) : null };
        });

        return { name: blockName, score: blockScore, criteria: mgrCriteria };
      });

      const overallScore = acc.totalScoreCount > 0 ? Math.round(acc.totalScoreSum / acc.totalScoreCount) : null;
      return { id: mgr.id, name: mgr.name, overallScore, callCount: acc.callCount, blocks: mgrBlocks };
    })
    .filter((m): m is ManagerBreakdown => m !== null)
    .sort((a, b) => (b.overallScore ?? 0) - (a.overallScore ?? 0));

  // Diagnostic log
  console.log(`[Analytics] ${source}/${department}: ${totalCalls} calls, ${blockOrder.length} blocks, ${managers.length} managers in list, ${managerAccMap.size} managers with data`);
  for (const [mgrId, mgrAcc] of managerAccMap) {
    const inList = managers.some((m) => m.id === mgrId);
    if (mgrAcc.callCount > 0 && mgrAcc.blocks.size === 0) {
      console.warn(`[Analytics] Manager ${mgrId} has ${mgrAcc.callCount} calls but 0 blocks! inList=${inList}`);
    }
  }

  return { periods: trimmedPeriods, blocks, overallScores, managers, managerBreakdown, totalCalls, source, department };
}

// ─── Route handler ──────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const sp = request.nextUrl.searchParams;
    const department = (sp.get("department") === "b2b" ? "b2b" : "b2g") as "b2g" | "b2b";
    const source = sp.get("source") === "roleplay" ? "roleplay" : "okk";
    const line = sp.get("line") ?? "1";
    const groupBy = sp.get("groupBy") ?? "day";
    const managerId = sp.get("managerId") || null;

    const now = new Date();
    const defaultFrom = new Date(now);
    defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 30);

    const fromStr = sp.get("from");
    const toStr = sp.get("to");
    const from = fromStr ? new Date(`${fromStr}T00:00:00Z`) : defaultFrom;
    const to = toStr ? new Date(`${toStr}T23:59:59Z`) : now;

    if (from > to) {
      return NextResponse.json({ success: false, error: "from must be before to" }, { status: 400 });
    }

    const effectiveLine = (department === "b2b" || source === "roleplay") ? "all" : line;
    const cacheKey = `analytics:${department}:${source}:${effectiveLine}:${groupBy}:${fromStr}:${toStr}:${managerId}`;

    const data = await cached(cacheKey, CACHE_TTL, () =>
      source === "roleplay"
        ? fetchRoleplayData(department, effectiveLine, from, to, groupBy, managerId)
        : fetchOkkData(department, effectiveLine, from, to, groupBy, managerId),
    );

    return NextResponse.json({ success: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    console.error("[Analytics API]", error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
