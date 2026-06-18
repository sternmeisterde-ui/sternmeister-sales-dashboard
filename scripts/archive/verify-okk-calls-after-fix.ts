// Verifies that the /api/okk/calls fix returns full month data and that
// the per-manager aggregates the dashboard now consumes line up with the
// raw evaluated-call counts in D2/R2. Run after touching the API:
//
//   npx tsx scripts/verify-okk-calls-after-fix.ts --dept b2g --from 2026-04-01 --to 2026-04-30

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { getOkkDbForDepartment } from "../src/lib/db/okk";
import { okkCalls, okkEvaluations, okkManagers } from "../src/lib/db/schema-okk";
import { and, eq, gte, lte, desc, sql, isNotNull, or } from "drizzle-orm";

const args = process.argv.slice(2);
function arg(name: string): string | null {
  const idx = args.indexOf(`--${name}`);
  if (idx < 0) return null;
  return args[idx + 1] ?? null;
}

async function main(): Promise<void> {
  const dept = (arg("dept") === "b2b" ? "b2b" : "b2g") as "b2g" | "b2b";
  const okkDept = dept === "b2g" ? "d2" : "r2";
  const fromStr = arg("from") ?? "2026-04-01";
  const toStr = arg("to") ?? "2026-04-30";
  const from = new Date(`${fromStr}T00:00:00.000Z`);
  const to = new Date(`${toStr}T23:59:59.999Z`);
  const db = getOkkDbForDepartment(dept);

  console.log(
    `\n══════ ${dept.toUpperCase()} ${fromStr} … ${toStr} ══════\n`,
  );

  // Mirror buildOkkResponse() conditions (after fix)
  const conditions = [
    gte(okkCalls.callCreatedAt, from),
    lte(okkCalls.callCreatedAt, to),
    sql`${okkCalls.status} IN ('notified', 'evaluated', 'completed')`,
    sql`${okkCalls.id} IN (SELECT call_id FROM evaluations WHERE total_score IS NOT NULL)`,
    isNotNull(okkCalls.managerId),
  ];

  // Query 1 — light call rows (post-fix: limit 5000, no slice)
  const rows = await db
    .select({
      id: okkCalls.id,
      managerId: okkCalls.managerId,
      managerName: okkCalls.managerName,
      callCreatedAt: okkCalls.callCreatedAt,
      totalScore: okkEvaluations.totalScore,
    })
    .from(okkCalls)
    .leftJoin(okkEvaluations, eq(okkCalls.id, okkEvaluations.callId))
    .where(and(...conditions))
    .orderBy(desc(okkCalls.callCreatedAt), desc(okkEvaluations.createdAt))
    .limit(5000);

  // Dedup by call id (same logic as fix)
  const seen = new Set<string>();
  const uniqueRows = rows.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });

  // Query 2 — managers visible in dropdown: active OR has calls in window
  const whereForCalls = and(...conditions);
  const managers = await db
    .select({
      id: okkManagers.id,
      name: okkManagers.name,
      role: okkManagers.role,
      line: okkManagers.line,
      isActive: okkManagers.isActive,
    })
    .from(okkManagers)
    .where(
      and(
        sql`${okkManagers.role} IN ('manager', 'rop')`,
        or(
          eq(okkManagers.isActive, true),
          sql`${okkManagers.id} IN (
            SELECT DISTINCT ${okkCalls.managerId} FROM ${okkCalls}
            LEFT JOIN ${okkEvaluations} ON ${okkCalls.id} = ${okkEvaluations.callId}
            WHERE ${whereForCalls}
              AND ${okkCalls.managerId} IS NOT NULL
          )`,
        ),
      ),
    )
    .orderBy(okkManagers.name);

  // Query 3 — per-manager aggregates (no limit, server-side)
  const aggs = await db
    .select({
      managerId: okkCalls.managerId,
      count: sql<number>`count(distinct ${okkCalls.id})::int`,
      avgScore: sql<number>`round(avg(${okkEvaluations.totalScore}))::int`,
    })
    .from(okkCalls)
    .leftJoin(okkEvaluations, eq(okkCalls.id, okkEvaluations.callId))
    .where(and(...conditions))
    .groupBy(okkCalls.managerId);

  const aggByMgr = new Map<string, { count: number; avgScore: number }>();
  for (const a of aggs) {
    if (!a.managerId) continue;
    aggByMgr.set(a.managerId, { count: Number(a.count), avgScore: Number(a.avgScore) });
  }

  console.log(`unique calls in payload (after fix): ${uniqueRows.length}`);
  console.log(`active managers (dropdown source): ${managers.length}`);
  console.log("");
  console.log("─── Per-manager (server agg, what dashboard now uses) ───");
  console.log("");

  // Print sorted by count desc
  const enriched = managers
    .map((m) => ({
      ...m,
      ...(aggByMgr.get(m.id) ?? { count: 0, avgScore: 0 }),
    }))
    .sort((a, b) => b.count - a.count);

  for (const m of enriched) {
    const flag = m.count === 0 ? "  " : m.isActive ? "✓ " : "⊘ ";
    const tag = m.isActive ? "active  " : "inactive";
    console.log(
      `  ${flag}${m.name.padEnd(28)}  ${tag}  line=${(m.line ?? "—").padEnd(3)}  count=${String(m.count).padStart(4)}  avg=${m.count > 0 ? `${String(m.avgScore).padStart(3)}%` : "  —"}`,
    );
  }

  // Cross-check: count from uniqueRows must equal sum of aggregates
  // (modulo orphan calls whose manager_id has no row in okkManagers)
  const fromRows = new Map<string, number>();
  for (const r of uniqueRows) {
    if (!r.managerId) continue;
    fromRows.set(r.managerId, (fromRows.get(r.managerId) ?? 0) + 1);
  }
  let mismatches = 0;
  for (const [id, fromAgg] of aggByMgr) {
    const fromList = fromRows.get(id) ?? 0;
    if (fromList !== fromAgg.count) {
      console.log(
        `\n⚠ mismatch: mgr=${id.slice(0, 8)}…  list=${fromList}  agg=${fromAgg.count}`,
      );
      mismatches++;
    }
  }

  // Orphan call counts (managerId not in active dropdown)
  const activeIds = new Set(managers.map((m) => m.id));
  const orphanIds = Array.from(aggByMgr.keys()).filter((id) => !activeIds.has(id));
  if (orphanIds.length > 0) {
    console.log("\n─── Calls attributed to managers NOT in active dropdown ───");
    for (const id of orphanIds) {
      const agg = aggByMgr.get(id)!;
      console.log(`  ⚠ orphan_mgr_id=${id.slice(0, 8)}…  count=${agg.count}  avg=${agg.avgScore}%`);
    }
  }

  const totalAgg = Array.from(aggByMgr.values()).reduce((s, a) => s + a.count, 0);
  console.log(`\n─── Summary ───`);
  console.log(`  total evaluated calls (sum of aggs): ${totalAgg}`);
  console.log(`  unique calls in payload:             ${uniqueRows.length}`);
  console.log(`  in dashboard dropdown:               ${managers.length}`);
  console.log(`  with calls in period:                ${enriched.filter((m) => m.count > 0).length}`);
  console.log(`  with zero calls (visible at 0):      ${enriched.filter((m) => m.count === 0).length}`);
  if (mismatches === 0) {
    console.log(`  list ↔ agg consistency:              ✓ OK`);
  } else {
    console.log(`  list ↔ agg consistency:              ⚠ ${mismatches} mismatch(es)`);
  }
  console.log("");

  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
