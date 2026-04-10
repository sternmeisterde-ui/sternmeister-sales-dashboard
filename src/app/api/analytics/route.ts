import { NextRequest, NextResponse } from "next/server";
import { getOkkDbForDepartment } from "@/lib/db/okk";
import { getDbForDepartment } from "@/lib/db";
import {
  okkCalls,
  okkEvaluations,
  okkManagers,
  type EvalBlock,
  type EvalCriterion,
  getBlockScore,
  getBlockMaxScore,
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
  score: number;
}

interface ManagerBlockScore {
  name: string;
  score: number;
  criteria: ManagerCriterionScore[];
}

interface ManagerBreakdown {
  id: string;
  name: string;
  overallScore: number;
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
  blocks: EvalBlock[],
  acc: PeriodAcc,
  totalScore: number | null,
) {
  if (totalScore !== null && totalScore !== undefined) {
    acc.totalScoreSum += totalScore;
    acc.totalScoreCount++;
  }
  acc.callCount++;

  for (const block of blocks) {
    if (!block.name || EXCLUDED_BLOCKS.has(block.name)) continue;
    const maxBlock = getBlockMaxScore(block);
    if (maxBlock <= 0) continue;

    const blockPct = Math.round((getBlockScore(block) / maxBlock) * 100);
    const be = acc.blocks.get(block.name);
    if (be) { be.scoreSum += blockPct; be.count++; }
    else acc.blocks.set(block.name, { scoreSum: blockPct, count: 1 });

    const criteria: EvalCriterion[] = block.criteria ?? [];
    for (const c of criteria) {
      if (!c.name || c.max_score <= 0) continue;
      const pct = Math.round((c.score / c.max_score) * 100);
      const key = `${block.name}::${c.name}`;
      const ce = acc.criteria.get(key);
      if (ce) { ce.scoreSum += pct; ce.count++; }
      else acc.criteria.set(key, { scoreSum: pct, count: 1 });
    }
  }
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
    if (!row.callCreatedAt || !row.evaluationJson?.blocks) continue;
    const p = toPeriodKey(row.callCreatedAt, groupBy);
    const acc = accMap.get(p);
    if (!acc) continue;
    processedCount++;
    processBlocks(row.evaluationJson.blocks, acc, row.totalScore);

    // Per-manager accumulation
    if (row.managerId) {
      if (!managerAccMap.has(row.managerId)) managerAccMap.set(row.managerId, newAcc());
      processBlocks(row.evaluationJson.blocks, managerAccMap.get(row.managerId)!, row.totalScore);
    }
  }

  return buildResponse(periods, accMap, managers, managerAccMap, "okk", department, processedCount);
}

// ─── Roleplay data fetcher ──────────────────────────────────

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

  const conditions = [
    gte(callsTable.startedAt, from),
    lte(callsTable.startedAt, to),
    isNotNull(callsTable.score),
    isNotNull(callsTable.evaluationJson),
  ];
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
    if (!row.startedAt || !row.evaluationJson?.blocks) continue;
    const p = toPeriodKey(row.startedAt, groupBy);
    const acc = accMap.get(p);
    if (!acc) continue;
    processedCount++;
    processBlocks(row.evaluationJson.blocks, acc, row.score ?? null);

    if (row.userId) {
      if (!managerAccMap.has(row.userId)) managerAccMap.set(row.userId, newAcc());
      processBlocks(row.evaluationJson.blocks, managerAccMap.get(row.userId)!, row.score ?? null);
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

  // Collect block/criteria order from both period and manager accumulators
  const allAccs = [...accMap.values(), ...managerAccMap.values()];
  for (const acc of allAccs) {
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
        const blockScore = be && be.count > 0 ? Math.round(be.scoreSum / be.count) : 0;

        const criteriaNames = blockCriteriaOrder.get(blockName) ?? [];
        const mgrCriteria: ManagerCriterionScore[] = criteriaNames.map((cName) => {
          const ce = acc.criteria.get(`${blockName}::${cName}`);
          return { name: cName, score: ce && ce.count > 0 ? Math.round(ce.scoreSum / ce.count) : 0 };
        });

        return { name: blockName, score: blockScore, criteria: mgrCriteria };
      });

      const overallScore = acc.totalScoreCount > 0 ? Math.round(acc.totalScoreSum / acc.totalScoreCount) : 0;
      return { id: mgr.id, name: mgr.name, overallScore, callCount: acc.callCount, blocks: mgrBlocks };
    })
    .filter((m): m is ManagerBreakdown => m !== null)
    .sort((a, b) => b.overallScore - a.overallScore);

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
        ? fetchRoleplayData(department, line, from, to, groupBy, managerId)
        : fetchOkkData(department, line, from, to, groupBy, managerId),
    );

    return NextResponse.json({ success: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    console.error("[Analytics API]", error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
