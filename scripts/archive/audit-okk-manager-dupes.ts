// Read-only diagnostic: surfaces duplicate rows in OKK `managers` table
// (D2 / R2) that share the same canonical person and split call history
// across multiple manager_id values. The Управляющий dashboard's per-manager
// filter joins through okk.managers, so duplicates make most evaluated calls
// invisible from the dropdown — and ultimately from payroll calculations.
//
// Run:
//   npx tsx scripts/audit-okk-manager-dupes.ts          # both depts
//   npx tsx scripts/audit-okk-manager-dupes.ts --dept b2g
//   npx tsx scripts/audit-okk-manager-dupes.ts --dept b2g --from 2026-04-01 --to 2026-04-30

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { db } from "../src/lib/db";
import { masterManagers } from "../src/lib/db/schema-existing";
import { getOkkDbForDepartment } from "../src/lib/db/okk";
import { okkManagers, okkCalls, okkEvaluations } from "../src/lib/db/schema-okk";
import { and, eq, gte, lte, sql, isNotNull } from "drizzle-orm";

const args = process.argv.slice(2);
function arg(name: string): string | null {
  const idx = args.indexOf(`--${name}`);
  if (idx < 0) return null;
  return args[idx + 1] ?? null;
}

const NORM = (s: string | null | undefined): string =>
  (s ?? "")
    .replace(/\(amoCRM\)/gi, "")
    .replace(/[()]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const NAME_ALIASES: Record<string, string[]> = {
  "Максим Алекперов": ["Maksim Alekperov"],
  "Гульназ Сираждинова": ["Гульназ Cираждинова"],
  "Елизавета Трапезникова": ["Єлизавета Трапезникова"],
};

type OkkRow = {
  id: string;
  name: string;
  isActive: boolean | null;
  kommoUserId: number | null;
  callgearEmployeeId: string | null;
  cloudtalkAgentId: string | null;
  telegramId: string | null;
};

type MasterRow = {
  id: string;
  name: string;
  kommoUserId: number | null;
  callgearEmployeeId: string | null;
  cloudtalkAgentId: string | null;
  telegramId: string | null;
};

async function auditDept(
  dept: "b2g" | "b2b",
  from: Date | null,
  to: Date | null,
): Promise<void> {
  const okkDept = dept === "b2g" ? "d2" : "r2";
  const okkDb = getOkkDbForDepartment(dept);

  console.log(`\n══════════ ${dept.toUpperCase()} (okkDept=${okkDept}) ══════════`);

  // 1) Master managers (active)
  const masterRows = (await db
    .select({
      id: masterManagers.id,
      name: masterManagers.name,
      kommoUserId: masterManagers.kommoUserId,
      callgearEmployeeId: masterManagers.callgearEmployeeId,
      cloudtalkAgentId: masterManagers.cloudtalkAgentId,
      telegramId: masterManagers.telegramId,
    })
    .from(masterManagers)
    .where(and(eq(masterManagers.department, dept), eq(masterManagers.isActive, true)))) as MasterRow[];

  console.log(`master_managers active: ${masterRows.length}`);

  // 2) OKK managers (all rows including inactive — we need to see history)
  const okkRows = (await okkDb
    .select({
      id: okkManagers.id,
      name: okkManagers.name,
      isActive: okkManagers.isActive,
      kommoUserId: okkManagers.kommoUserId,
      callgearEmployeeId: okkManagers.callgearEmployeeId,
      cloudtalkAgentId: okkManagers.cloudtalkAgentId,
      telegramId: okkManagers.telegramId,
    })
    .from(okkManagers)
    .where(eq(okkManagers.department, okkDept))) as OkkRow[];

  console.log(`okk.managers rows: ${okkRows.length} (active: ${okkRows.filter((r) => r.isActive).length})`);

  // 3) Per-manager_id call counts (filtered by period if provided)
  const callConditions = [
    sql`${okkCalls.id} IN (SELECT call_id FROM evaluations WHERE total_score IS NOT NULL)`,
    isNotNull(okkCalls.managerId),
  ];
  if (from) callConditions.push(gte(okkCalls.callCreatedAt, from));
  if (to) callConditions.push(lte(okkCalls.callCreatedAt, to));

  const callCountsRaw = await okkDb
    .select({
      managerId: okkCalls.managerId,
      managerName: okkCalls.managerName,
      count: sql<number>`count(distinct ${okkCalls.id})::int`,
    })
    .from(okkCalls)
    .leftJoin(okkEvaluations, eq(okkCalls.id, okkEvaluations.callId))
    .where(and(...callConditions))
    .groupBy(okkCalls.managerId, okkCalls.managerName);

  const callsByMgrId = new Map<string, { count: number; nameSnapshot: string }>();
  for (const c of callCountsRaw) {
    if (!c.managerId) continue;
    const prev = callsByMgrId.get(c.managerId);
    callsByMgrId.set(c.managerId, {
      count: (prev?.count ?? 0) + Number(c.count),
      nameSnapshot: c.managerName ?? prev?.nameSnapshot ?? "—",
    });
  }
  const totalEvaluated = Array.from(callsByMgrId.values()).reduce((s, v) => s + v.count, 0);
  console.log(
    `evaluated calls in window: ${totalEvaluated}` +
      (from || to
        ? ` (period: ${from?.toISOString().slice(0, 10) ?? "−∞"} … ${to?.toISOString().slice(0, 10) ?? "+∞"})`
        : ""),
  );

  // 4) Bucket okk rows under canonical "person key"
  // Priority: kommoUserId > callgearEmployeeId > cloudtalkAgentId > telegramId > normalized(name)+aliases
  const personKey = (r: { kommoUserId: number | null; callgearEmployeeId: string | null; cloudtalkAgentId: string | null; telegramId: string | null; name: string }): string => {
    if (r.kommoUserId) return `kommo:${r.kommoUserId}`;
    if (r.callgearEmployeeId) return `cg:${r.callgearEmployeeId}`;
    if (r.cloudtalkAgentId) return `ct:${r.cloudtalkAgentId}`;
    if (r.telegramId) return `tg:${r.telegramId}`;
    // Resolve aliases
    const nm = r.name.trim();
    for (const [canon, aliases] of Object.entries(NAME_ALIASES)) {
      if (nm === canon || aliases.includes(nm)) return `name:${NORM(canon)}`;
    }
    return `name:${NORM(nm)}`;
  };

  // Build cross-key index so rows with overlapping IDs collapse together.
  const dsu = new Map<string, string>(); // node → parent
  function find(x: string): string {
    let cur = x;
    while (dsu.get(cur) && dsu.get(cur) !== cur) cur = dsu.get(cur)!;
    dsu.set(x, cur);
    return cur;
  }
  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) dsu.set(ra, rb);
  }
  function add(node: string): void {
    if (!dsu.has(node)) dsu.set(node, node);
  }

  for (const r of okkRows) {
    const keys: string[] = [];
    if (r.kommoUserId) keys.push(`kommo:${r.kommoUserId}`);
    if (r.callgearEmployeeId) keys.push(`cg:${r.callgearEmployeeId}`);
    if (r.cloudtalkAgentId) keys.push(`ct:${r.cloudtalkAgentId}`);
    if (r.telegramId) keys.push(`tg:${r.telegramId}`);
    keys.push(`name:${NORM(r.name)}`);
    for (const k of keys) add(k);
    for (let i = 1; i < keys.length; i++) union(keys[0], keys[i]);
  }
  for (const m of masterRows) {
    const keys: string[] = [];
    if (m.kommoUserId) keys.push(`kommo:${m.kommoUserId}`);
    if (m.callgearEmployeeId) keys.push(`cg:${m.callgearEmployeeId}`);
    if (m.cloudtalkAgentId) keys.push(`ct:${m.cloudtalkAgentId}`);
    if (m.telegramId) keys.push(`tg:${m.telegramId}`);
    keys.push(`name:${NORM(m.name)}`);
    // Also bridge through alias
    for (const [canon, aliases] of Object.entries(NAME_ALIASES)) {
      if (m.name === canon || aliases.includes(m.name)) {
        keys.push(`name:${NORM(canon)}`);
        for (const a of aliases) keys.push(`name:${NORM(a)}`);
      }
    }
    for (const k of keys) add(k);
    for (let i = 1; i < keys.length; i++) union(keys[0], keys[i]);
  }

  // 5) For each master person → list okk rows in same cluster + call counts
  console.log("");
  console.log("─── per-person summary (master ↔ okk rows ↔ calls) ───");
  console.log("");

  type PersonReport = {
    masterId: string | null;
    masterName: string;
    okkActiveIds: string[];
    okkInactiveIds: string[];
    callsTotal: number;
    callsByOkkId: Array<{ okkId: string; calls: number; isActive: boolean | null; name: string }>;
    issue: string | null;
  };

  const reports: PersonReport[] = [];

  for (const m of masterRows) {
    const cluster = find(personKey(m));
    const sameCluster = okkRows.filter((r) => find(personKey(r)) === cluster);
    const active = sameCluster.filter((r) => r.isActive);
    const inactive = sameCluster.filter((r) => !r.isActive);

    const callsByOkkId = sameCluster
      .map((r) => ({
        okkId: r.id,
        calls: callsByMgrId.get(r.id)?.count ?? 0,
        isActive: r.isActive,
        name: r.name,
      }))
      .filter((x) => x.calls > 0 || x.isActive)
      .sort((a, b) => b.calls - a.calls);
    const callsTotal = callsByOkkId.reduce((s, x) => s + x.calls, 0);

    let issue: string | null = null;
    if (active.length === 0 && callsTotal > 0) issue = "no active OKK row but has calls";
    else if (active.length > 1) issue = `${active.length} active OKK rows`;
    else if (active.length === 1 && inactive.some((r) => callsByMgrId.get(r.id)?.count)) {
      issue = "calls split between active + inactive OKK rows";
    }

    reports.push({
      masterId: m.id,
      masterName: m.name,
      okkActiveIds: active.map((r) => r.id),
      okkInactiveIds: inactive.map((r) => r.id),
      callsTotal,
      callsByOkkId,
      issue,
    });
  }

  // Also show OKK clusters with calls but NO master link (true orphans)
  const linkedClusters = new Set(reports.map((r) => find(personKey({ ...masterRows.find((m) => m.id === r.masterId)!, name: r.masterName }))));
  const orphanClusters = new Map<string, OkkRow[]>();
  for (const r of okkRows) {
    const c = find(personKey(r));
    if (linkedClusters.has(c)) continue;
    if (!orphanClusters.has(c)) orphanClusters.set(c, []);
    orphanClusters.get(c)!.push(r);
  }

  // Print
  for (const r of reports) {
    const flag = r.issue ? `⚠ ${r.issue}` : "✓";
    console.log(`${flag}  ${r.masterName}  (master_id=${r.masterId?.slice(0, 8)}…)`);
    console.log(`    total evaluated calls: ${r.callsTotal}`);
    if (r.callsByOkkId.length === 0) {
      console.log("    okk rows: (none with calls or active)");
    } else {
      for (const x of r.callsByOkkId) {
        console.log(
          `      okk ${x.okkId.slice(0, 8)}…  active=${x.isActive ? "yes" : "no "}  calls=${x.calls}  name="${x.name}"`,
        );
      }
    }
    console.log("");
  }

  if (orphanClusters.size > 0) {
    console.log("─── orphan OKK clusters (no master link) ───");
    for (const [, rs] of orphanClusters) {
      const total = rs.reduce((s, r) => s + (callsByMgrId.get(r.id)?.count ?? 0), 0);
      if (total === 0 && rs.every((r) => !r.isActive)) continue;
      console.log(`⚠ orphan: total evaluated calls=${total}`);
      for (const r of rs) {
        console.log(
          `    okk ${r.id.slice(0, 8)}…  active=${r.isActive ? "yes" : "no "}  calls=${callsByMgrId.get(r.id)?.count ?? 0}  name="${r.name}"  kommo=${r.kommoUserId ?? "—"}`,
        );
      }
      console.log("");
    }
  }

  // Aggregate diagnosis
  const issuesCount = reports.filter((r) => r.issue).length;
  const orphansCount = Array.from(orphanClusters.values()).filter(
    (rs) => rs.some((r) => callsByMgrId.get(r.id)?.count) || rs.some((r) => r.isActive),
  ).length;
  console.log(`────────── ${dept.toUpperCase()} summary: ${issuesCount} master rows with split/missing OKK link · ${orphansCount} orphan clusters with calls ──────────`);
}

async function main(): Promise<void> {
  const dept = arg("dept");
  const fromStr = arg("from");
  const toStr = arg("to");
  const from = fromStr ? new Date(`${fromStr}T00:00:00Z`) : null;
  const to = toStr ? new Date(`${toStr}T23:59:59Z`) : null;

  const targets: ("b2g" | "b2b")[] = dept === "b2b" ? ["b2b"] : dept === "b2g" ? ["b2g"] : ["b2g", "b2b"];

  for (const d of targets) {
    await auditDept(d, from, to);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
