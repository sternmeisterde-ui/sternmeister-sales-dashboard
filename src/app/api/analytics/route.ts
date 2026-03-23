import { NextRequest, NextResponse } from "next/server";
import { getOkkDbForDepartment } from "@/lib/db/okk";
import {
  okkCalls,
  okkEvaluations,
  type EvalBlock,
  getBlockScore,
  getBlockMaxScore,
} from "@/lib/db/schema-okk";
import { eq, sql } from "drizzle-orm";
import { cached } from "@/lib/kommo/cache";

// ─── Constants ────────────────────────────────────────────────────────────────

const ANALYTICS_CACHE_TTL = 2 * 60 * 1000; // 2 minutes

// ─── Types ────────────────────────────────────────────────────────────────────

interface BlockScoreSeries {
  blockName: string;
  scores: Record<string, number>;
}

interface ClientScoringBucket {
  hot: number;
  warm: number;
  cold: number;
}

interface ClientScoringSeries {
  type: "urgency" | "solvency" | "need";
  distribution: Record<string, ClientScoringBucket>;
}

interface AnalyticsResponse {
  department: string;
  months: string[];
  blockScores: BlockScoreSeries[];
  clientScoring: ClientScoringSeries[];
  categories: Record<string, Record<string, number>>;
  overallScores: Record<string, number>;
  callVolume: Record<string, number>;
}

// Per-month accumulators (mutable, used only during aggregation)
interface MonthAccumulator {
  totalScoreSum: number;
  totalScoreCount: number;
  // blockName → { scoreSum, count }
  blocks: Map<string, { scoreSum: number; count: number }>;
  // scoring type → raw values
  urgencyValues: number[];
  solvencyValues: number[];
  needValues: number[];
  // category → count
  categories: Map<string, number>;
  callCount: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Format a Date to YYYY-MM using UTC calendar month */
function toYearMonth(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** Build an ordered list of YYYY-MM strings covering the last `count` months */
function buildMonthRange(count: number): string[] {
  const now = new Date();
  const result: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    result.push(toYearMonth(d));
  }
  return result;
}

/** Classify a 0–10 score into hot / warm / cold bucket */
function scoreBucket(value: number): "hot" | "warm" | "cold" {
  if (value >= 7) return "hot";
  if (value >= 4) return "warm";
  return "cold";
}

/** Convert a raw array of 0–10 scores to a percentage distribution */
function toDistribution(values: number[]): ClientScoringBucket {
  const total = values.length;
  if (total === 0) return { hot: 0, warm: 0, cold: 0 };
  let hot = 0;
  let warm = 0;
  let cold = 0;
  for (const v of values) {
    const bucket = scoreBucket(v);
    if (bucket === "hot") hot++;
    else if (bucket === "warm") warm++;
    else cold++;
  }
  return {
    hot: Math.round((hot / total) * 100),
    warm: Math.round((warm / total) * 100),
    cold: Math.round((cold / total) * 100),
  };
}

/** Calculate block percentage score, handling both schema formats */
function blockPct(block: EvalBlock): number | null {
  const score = getBlockScore(block);
  const max = getBlockMaxScore(block);
  if (max <= 0) return null;
  return Math.round((score / max) * 100);
}

// ─── Core aggregation ────────────────────────────────────────────────────────

async function buildAnalytics(
  department: "b2g" | "b2b",
  monthCount: number,
): Promise<AnalyticsResponse> {
  const db = getOkkDbForDepartment(department);

  // Date boundary: start of the earliest month in the range
  const now = new Date();
  const fromDate = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (monthCount - 1), 1),
  );

  // Pull all relevant calls joined with evaluations.
  // kommo_custom_fields is not mapped in the Drizzle schema, so we read it
  // via a raw SQL expression — returns null gracefully if the column is absent.
  const rows = await db
    .select({
      callCreatedAt: okkCalls.callCreatedAt,
      totalScore: okkEvaluations.totalScore,
      evaluationJson: okkEvaluations.evaluationJson,
      // Raw JSONB extraction for the lead category custom field
      leadCategory: sql<string | null>`(${okkCalls}.kommo_custom_fields->>'field_866934')`,
    })
    .from(okkCalls)
    .innerJoin(okkEvaluations, eq(okkCalls.id, okkEvaluations.callId))
    .where(
      sql`${okkCalls.callCreatedAt} >= ${fromDate}
        AND ${okkCalls.status} IN ('notified', 'evaluated', 'completed')`,
    )
    .orderBy(okkCalls.callCreatedAt);

  // ── Initialise per-month accumulators ─────────────────────────────────────
  const monthRange = buildMonthRange(monthCount);
  const accumulators = new Map<string, MonthAccumulator>();
  for (const m of monthRange) {
    accumulators.set(m, {
      totalScoreSum: 0,
      totalScoreCount: 0,
      blocks: new Map(),
      urgencyValues: [],
      solvencyValues: [],
      needValues: [],
      categories: new Map(),
      callCount: 0,
    });
  }

  // ── Aggregate rows into month buckets ─────────────────────────────────────
  for (const row of rows) {
    if (!row.callCreatedAt) continue;
    const month = toYearMonth(row.callCreatedAt);
    const acc = accumulators.get(month);
    if (!acc) continue; // outside our month window — skip

    acc.callCount++;

    // Overall score
    if (row.totalScore !== null && row.totalScore !== undefined) {
      acc.totalScoreSum += row.totalScore;
      acc.totalScoreCount++;
    }

    // Block scores
    const blocks = row.evaluationJson?.blocks ?? [];
    for (const block of blocks) {
      if (!block.name) continue;
      const pct = blockPct(block);
      if (pct === null) continue;
      const existing = acc.blocks.get(block.name);
      if (existing) {
        existing.scoreSum += pct;
        existing.count++;
      } else {
        acc.blocks.set(block.name, { scoreSum: pct, count: 1 });
      }
    }

    // Client scoring
    const cs = row.evaluationJson?.client_scoring;
    if (cs) {
      if (typeof cs.urgency === "number") acc.urgencyValues.push(cs.urgency);
      if (typeof cs.solvency === "number") acc.solvencyValues.push(cs.solvency);
      if (typeof cs.need === "number") acc.needValues.push(cs.need);
    }

    // Lead category
    const cat = row.leadCategory;
    if (cat) {
      acc.categories.set(cat, (acc.categories.get(cat) ?? 0) + 1);
    }
  }

  // ── Collect all block names seen across all months (stable order) ─────────
  const allBlockNames = new Set<string>();
  for (const acc of accumulators.values()) {
    for (const name of acc.blocks.keys()) {
      allBlockNames.add(name);
    }
  }

  // ── Build blockScores output ──────────────────────────────────────────────
  const blockScores: BlockScoreSeries[] = [];
  for (const blockName of allBlockNames) {
    const scores: Record<string, number> = {};
    for (const month of monthRange) {
      const acc = accumulators.get(month);
      const entry = acc?.blocks.get(blockName);
      if (entry && entry.count > 0) {
        scores[month] = Math.round(entry.scoreSum / entry.count);
      }
    }
    blockScores.push({ blockName, scores });
  }

  // ── Build clientScoring output ────────────────────────────────────────────
  const scoringTypes: Array<"urgency" | "solvency" | "need"> = [
    "urgency",
    "solvency",
    "need",
  ];
  const clientScoring: ClientScoringSeries[] = scoringTypes.map((type) => {
    const distribution: Record<string, ClientScoringBucket> = {};
    for (const month of monthRange) {
      const acc = accumulators.get(month);
      if (!acc) continue;
      const values =
        type === "urgency"
          ? acc.urgencyValues
          : type === "solvency"
            ? acc.solvencyValues
            : acc.needValues;
      if (values.length > 0) {
        distribution[month] = toDistribution(values);
      }
    }
    return { type, distribution };
  });

  // ── Build categories output ───────────────────────────────────────────────
  const categories: Record<string, Record<string, number>> = {};
  for (const month of monthRange) {
    const acc = accumulators.get(month);
    if (!acc || acc.categories.size === 0) continue;
    categories[month] = Object.fromEntries(acc.categories);
  }

  // ── Build overallScores and callVolume ────────────────────────────────────
  const overallScores: Record<string, number> = {};
  const callVolume: Record<string, number> = {};
  for (const month of monthRange) {
    const acc = accumulators.get(month);
    if (!acc) continue;
    if (acc.totalScoreCount > 0) {
      overallScores[month] = Math.round(
        acc.totalScoreSum / acc.totalScoreCount,
      );
    }
    callVolume[month] = acc.callCount;
  }

  return {
    department,
    months: monthRange,
    blockScores,
    clientScoring,
    categories,
    overallScores,
    callVolume,
  };
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const sp = request.nextUrl.searchParams;

    const deptParam = sp.get("department") ?? "b2g";
    const department = (deptParam === "b2b" ? "b2b" : "b2g") as "b2g" | "b2b";

    const monthsParam = sp.get("months");
    const rawMonths = monthsParam !== null ? Number.parseInt(monthsParam, 10) : 6;
    const monthCount = Number.isNaN(rawMonths) || rawMonths < 1 ? 6 : Math.min(rawMonths, 24);

    const cacheKey = `analytics:${department}:${monthCount}`;

    const data = await cached(cacheKey, ANALYTICS_CACHE_TTL, () =>
      buildAnalytics(department, monthCount),
    );

    return NextResponse.json({ success: true, data });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }
}
