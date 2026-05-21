// Quick: are okkManagers' role/isActive set correctly for the people whose
// calls keep showing as orphans? If role IS NULL, the API's
// `role IN ('manager','rop')` filter drops them from the dropdown silently.

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { getOkkDbForDepartment } from "../src/lib/db/okk";
import { okkManagers, okkCalls, okkEvaluations } from "../src/lib/db/schema-okk";
import { and, eq, gte, lte, sql, isNotNull } from "drizzle-orm";

async function dump(dept: "b2g" | "b2b"): Promise<void> {
  const okkDept = dept === "b2g" ? "d2" : "r2";
  const db = getOkkDbForDepartment(dept);
  console.log(`\n══ ${dept.toUpperCase()} (${okkDept}) ══`);

  const rows = await db
    .select({
      id: okkManagers.id,
      name: okkManagers.name,
      role: okkManagers.role,
      isActive: okkManagers.isActive,
      line: okkManagers.line,
    })
    .from(okkManagers)
    .where(eq(okkManagers.department, okkDept))
    .orderBy(okkManagers.name);

  // Calls per manager_id in April
  const from = new Date("2026-04-01T00:00:00Z");
  const to = new Date("2026-04-30T23:59:59Z");
  const calls = await db
    .select({
      managerId: okkCalls.managerId,
      count: sql<number>`count(distinct ${okkCalls.id})::int`,
    })
    .from(okkCalls)
    .leftJoin(okkEvaluations, eq(okkCalls.id, okkEvaluations.callId))
    .where(
      and(
        gte(okkCalls.callCreatedAt, from),
        lte(okkCalls.callCreatedAt, to),
        sql`${okkCalls.id} IN (SELECT call_id FROM evaluations WHERE total_score IS NOT NULL)`,
        isNotNull(okkCalls.managerId),
      ),
    )
    .groupBy(okkCalls.managerId);
  const byMgr = new Map(calls.map((c) => [c.managerId!, Number(c.count)]));

  console.log(`Total rows: ${rows.length}`);
  console.log("");
  console.log("name                          role         active  calls(april)");
  for (const r of rows) {
    const mark =
      r.role !== "manager" && r.role !== "rop"
        ? "⚠ ROLE"
        : !r.isActive
          ? "  inact"
          : "  ok   ";
    const c = byMgr.get(r.id) ?? 0;
    console.log(
      `  ${mark}  ${r.name.padEnd(28)}  ${(r.role ?? "NULL").padEnd(10)}  ${String(r.isActive).padEnd(5)}   ${String(c).padStart(4)}`,
    );
  }
}

async function main(): Promise<void> {
  await dump("b2g");
  await dump("b2b");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
