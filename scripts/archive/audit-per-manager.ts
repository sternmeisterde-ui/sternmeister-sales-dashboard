// Per-manager audit: какие ячейки заполнены для каждого B2B менеджера за месяц.
//   npx tsx scripts/audit-per-manager.ts [month=2026-04]

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { db } from "../src/lib/db/index";
import { masterManagers } from "../src/lib/db/schema-existing";
import { eq, and } from "drizzle-orm";
import { getB2BPerManagerStatsSQL } from "../src/lib/daily/analytics-b2b";
import { getAnalyticsCallMetricsByMaster } from "../src/lib/daily/analytics-calls";
import { B2B_PIPELINES } from "../src/lib/kommo/pipeline-config";

async function main() {
  const monthArg = process.argv[2] ?? "2026-04";
  const [y, m] = monthArg.split("-").map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
  const to = new Date(Date.UTC(y, m, 0, 23, 59, 59));
  const fromTs = Math.floor(from.getTime() / 1000);
  const toTs = Math.floor(to.getTime() / 1000);

  console.log(`\n═══ PER-MANAGER AUDIT B2B — ${monthArg} ═══\n`);

  // 1. Active B2B managers
  const mgrs = await db
    .select()
    .from(masterManagers)
    .where(and(eq(masterManagers.department, "b2b"), eq(masterManagers.isActive, true)));

  console.log(`Active B2B managers in master_managers: ${mgrs.length}\n`);
  if (mgrs.length === 0) {
    console.log("❌ Нет активных B2B менеджеров — per-manager таб будет пустым");
    return;
  }

  // 2. Stats per pipeline
  const [buhStats, medStats] = await Promise.all([
    getB2BPerManagerStatsSQL(B2B_PIPELINES.COMMERCIAL, from, to),
    getB2BPerManagerStatsSQL(B2B_PIPELINES.MEDICAL_COMM, from, to),
  ]);

  // 3. Call metrics
  const callMap = await getAnalyticsCallMetricsByMaster(
    mgrs.map((m) => ({ id: m.id, name: m.name })),
    "b2b",
    fromTs,
    toTs,
  );

  // 4. Print matrix: row=manager, columns=metrics
  console.log("MANAGER                           | BUH                              | МЕД                              | ЗВОНКИ");
  console.log("                                  | qual sales rev  prepay           | qual sales rev  prepay           | calls conn min   sla%");
  console.log("─".repeat(150));
  for (const mgr of mgrs) {
    const uid = mgr.kommoUserId;
    const buh = uid ? buhStats.get(uid) : undefined;
    const med = uid ? medStats.get(uid) : undefined;
    const calls = callMap.get(mgr.id);

    const ts = (n: number | null | undefined) => (n == null ? "  —" : String(n).padStart(5));
    const tsL = (n: number | null | undefined) => (n == null ? "   —" : String(n).padStart(6));
    const name = (mgr.name ?? "?").padEnd(33);
    const kom = String(uid ?? "—").padStart(8);

    const buhCol = buh
      ? `${ts(buh.qualLeads)} ${ts(buh.salesCount)} ${tsL(buh.revenue)} ${ts(buh.prepaymentCount)}         `
      : "   —    —      —    —         ";
    const medCol = med
      ? `${ts(med.qualLeads)} ${ts(med.salesCount)} ${tsL(med.revenue)} ${ts(med.prepaymentCount)}         `
      : "   —    —      —    —         ";
    const callsCol = calls
      ? `${ts(calls.callsTotal)} ${ts(calls.callsConnected)} ${ts(calls.totalMinutes)} ${ts(calls.dialPercent)}`
      : "   —    —    —    —";

    console.log(`${name} kid=${kom} | ${buhCol} | ${medCol} | ${callsCol}`);
  }

  // 5. Managers in analytics.communications NOT in master_managers
  console.log(`\n═══ Менеджеры в communications НО НЕ в master_managers (active B2B) ═══`);
  const managerNames = new Set(mgrs.map((m) => m.name));
  // We can't easily query this without raw SQL, so just flag from callMap coverage
  console.log(`callMap resolved: ${callMap.size} из ${mgrs.length}`);
  const unresolved = mgrs.filter((m) => !callMap.has(m.id));
  if (unresolved.length > 0) {
    console.log(`\n❌ Менеджеры без звонков (или с name-drift в analytics):`);
    for (const m of unresolved) console.log(`  ${m.name} (id=${m.id}, kommo_id=${m.kommoUserId})`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
