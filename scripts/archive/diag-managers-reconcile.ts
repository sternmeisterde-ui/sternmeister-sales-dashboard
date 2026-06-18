// Сверка точности среза менеджеров с квал-базой воронки. ТОЛЬКО ЧТЕНИЕ.
// Доказываем: квал-база (без дисквала) = сумма по классам владельца, а видимый
// «Квалификатор» = ровно подмножество «B2G линия 1». Плюс кросс-чек с computeManagers.
//   npx tsx scripts/diag-managers-reconcile.ts

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { db } from "../src/lib/db/index";
import {
  fetchQualifiedBaseLeads,
  fetchCloseReasonHistory,
  fetchTargetEvents,
  fetchBeraterContext,
  enrichDisqualifiedAt,
  processLeadForConversion,
  unwrapRows,
  type ComputeOpts,
} from "../src/lib/funnel/compute";
import { computeManagers } from "../src/lib/funnel/managers";

type R = Record<string, unknown>;
function rows(res: unknown): R[] {
  if (Array.isArray(res)) return res as R[];
  if (res && typeof res === "object" && Array.isArray((res as { rows?: R[] }).rows))
    return (res as { rows: R[] }).rows;
  return [];
}

async function roster(): Promise<Map<number, { dept: string; role: string | null; line: string | null }>> {
  const out = new Map<number, { dept: string; role: string | null; line: string | null }>();
  for (const r of rows(await db.execute(sql`
    SELECT kommo_user_id AS uid, department AS dept, role, line FROM master_managers WHERE kommo_user_id IS NOT NULL
  `))) {
    if (r.uid != null) out.set(Number(r.uid), { dept: String(r.dept), role: r.role as string | null, line: r.line as string | null });
  }
  return out;
}

async function main(): Promise<void> {
  const opts: ComputeOpts = {
    from: new Date(Date.UTC(2026, 2, 1)),
    to: new Date(Date.UTC(2026, 5, 9)),
    maturity: "all",
    source: null,
    responsibleUserId: null,
  };

  const baseRaw = await fetchQualifiedBaseLeads(opts);
  const ids = baseRaw.map((l) => l.leadId);
  const [crh, targetEvents, beraterCtx, mm] = await Promise.all([
    fetchCloseReasonHistory(ids),
    fetchTargetEvents(ids),
    fetchBeraterContext(ids),
    roster(),
  ]);
  const base = baseRaw.map((l) => enrichDisqualifiedAt(l, crh.get(l.leadId)));

  const ownerClass = (uid: number | null): string => {
    if (uid === null) return "no-responsible";
    const m = mm.get(uid);
    if (!m) return "❌ нет в master (система)";
    if (m.dept !== "b2g") return `B2B (${m.dept})`;
    if (m.role === "rop") return "B2G РОП (пул)";
    if (m.line === "1") return "B2G линия 1 (квалиф.)";
    if (m.line === "2") return "B2G линия 2";
    if (m.line === "3") return "B2G линия 3";
    return "B2G линия —";
  };

  // Раскладка квал-базы БЕЗ дисквала по классам владельца.
  const buckets = new Map<string, { clients: number; gutschein: number }>();
  let disq = 0;
  let disqReachedGut = 0;
  let totalNonDisq = 0;
  let totalGutNonDisq = 0;

  for (const lead of base) {
    const c5 = processLeadForConversion("C5", lead, targetEvents, beraterCtx);
    const reachedGut =
      c5.included && c5.targetAt !== null &&
      (lead.disqualifiedAt === null || c5.targetAt <= lead.disqualifiedAt);

    if (lead.isDisqualified) {
      disq += 1;
      if (reachedGut) disqReachedGut += 1;
      continue;
    }
    totalNonDisq += 1;
    if (reachedGut) totalGutNonDisq += 1;

    const k = ownerClass(lead.responsibleUserId);
    const b = buckets.get(k) ?? { clients: 0, gutschein: 0 };
    b.clients += 1;
    if (reachedGut) b.gutschein += 1;
    buckets.set(k, b);
  }

  console.log(`Период ${opts.from.toISOString().slice(0,10)}…${opts.to.toISOString().slice(0,10)}`);
  console.log(`Квал-база всего: ${base.length} (из них дисквал: ${disq}, без дисквала: ${totalNonDisq})\n`);

  console.log("РАСКЛАДКА квал-базы (без дисквала) по классам владельца:");
  const order = ["B2G линия 1 (квалиф.)","B2G линия 2","B2G линия 3","B2G линия —","B2G РОП (пул)","B2B (b2b)","❌ нет в master (система)","no-responsible"];
  const rowsOut = order.filter((k) => buckets.has(k)).map((k) => ({ класс: k, клиенты: buckets.get(k)!.clients, "→Гутшайн": buckets.get(k)!.gutschein }));
  const sumCli = rowsOut.reduce((s, r) => s + r.клиенты, 0);
  const sumGut = rowsOut.reduce((s, r) => s + r["→Гутшайн"], 0);
  rowsOut.push({ класс: "── ИТОГО без дисквала", клиенты: sumCli, "→Гутшайн": sumGut });
  console.table(rowsOut);
  console.log(`Контроль: сумма клиентов (${sumCli}) == база без дисквала (${totalNonDisq})? ${sumCli === totalNonDisq ? "✅" : "❌"}`);
  console.log(`Контроль: сумма Гутшайн (${sumGut}) == всего Гутшайн без дисквала (${totalGutNonDisq})? ${sumGut === totalGutNonDisq ? "✅" : "❌"}`);
  console.log(`Справка: дисквал-лидов, дошедших до Гутшайна (в когортах считаются, у нас нет): ${disqReachedGut}`);

  // Кросс-чек: сумма «Квалификатор» из computeManagers == B2G линия 1.
  const mgr = await computeManagers(opts);
  const qSumCli = mgr.roles.qualifier.reduce((s, r) => s + r.clients, 0);
  const qSumGut = mgr.roles.qualifier.reduce((s, r) => s + r.reachedGutschein, 0);
  const expectCli = buckets.get("B2G линия 1 (квалиф.)")?.clients ?? 0;
  const expectGut = buckets.get("B2G линия 1 (квалиф.)")?.gutschein ?? 0;
  console.log(`\nКросс-чек computeManagers «Квалификатор»:`);
  console.log(`  клиенты: ${qSumCli} == B2G-линия1 ${expectCli}? ${qSumCli === expectCli ? "✅" : "❌"}`);
  console.log(`  Гутшайн: ${qSumGut} == B2G-линия1 ${expectGut}? ${qSumGut === expectGut ? "✅" : "❌"}`);

  console.log("\nГотово. Только чтение.");
}

main().then(() => process.exit(0)).catch((e) => { console.error("Ошибка:", e); process.exit(1); });
