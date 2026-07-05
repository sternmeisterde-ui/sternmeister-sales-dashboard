// Диагностика №5: CallGear по Коммерсам за один берлинский день.
// Сырые данные из CallGear API (леги + сессии) vs analytics.communications
// (cg-leg: строки b2b-менеджеров). READ-ONLY.
//
// Usage: npx tsx scripts/diag-b2b-callgear-day.ts [YMD]   (default 2026-06-29)

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");

import { neon } from "@neondatabase/serverless";
import { getCallsByDate } from "../src/lib/telephony/callgear";
import { NAME_ALIASES } from "../src/lib/daily/name-aliases";

const BERLIN = "Europe/Berlin";
const berlinDay = (d: Date) => d.toLocaleDateString("sv", { timeZone: BERLIN });
function berlinMidnightUtc(ymd: string): Date {
  for (const off of ["+02:00", "+01:00"]) {
    const d = new Date(`${ymd}T00:00:00${off}`);
    if (new Intl.DateTimeFormat("sv", { timeZone: BERLIN, hour: "2-digit", hourCycle: "h23" }).format(d) === "00") return d;
  }
  throw new Error(`bad ymd ${ymd}`);
}

async function main() {
  const ymd = process.argv[2] ?? "2026-06-29";
  const fromUtc = berlinMidnightUtc(ymd);
  const toUtcExcl = new Date(fromUtc.getTime() + 86_400_000);
  console.log(`День: ${ymd} (Berlin) = UTC [${fromUtc.toISOString()} .. ${toUtcExcl.toISOString()})\n`);

  // ── b2b-менеджеры с callgear_employee_id ──
  const d1 = neon(process.env.DATABASE_URL!);
  const masters = (await d1`
    SELECT name, callgear_employee_id FROM master_managers
    WHERE department = 'b2b' AND is_active = true
  `) as Array<{ name: string; callgear_employee_id: string | null }>;
  const cgIdToName = new Map<string, string>();
  for (const m of masters) if (m.callgear_employee_id) cgIdToName.set(String(m.callgear_employee_id), m.name);
  console.log("b2b master_managers ↔ CallGear:");
  for (const m of masters) console.log(`  ${m.name}: cg_id=${m.callgear_employee_id ?? "—"}`);

  const names: string[] = [];
  for (const m of masters) {
    names.push(m.name);
    for (const a of NAME_ALIASES[m.name] ?? []) names.push(a);
  }

  // ── Сырой CallGear (окно с запасом ±1 день, бакет по Берлину) ──
  console.log("\nТяну CallGear API (леги+сессии)...");
  const raw = await getCallsByDate(
    new Date(fromUtc.getTime() - 86_400_000),
    new Date(toUtcExcl.getTime() + 86_400_000),
  );
  const dayLegs = raw.filter((c) => berlinDay(c.startedAt) === ymd);
  const b2bLegs = dayLegs.filter((c) => c.agentId != null && cgIdToName.has(String(c.agentId)));

  const cnt = (arr: typeof b2bLegs) => ({
    total: arr.length,
    out: arr.filter((c) => c.type === "outgoing").length,
    inn: arr.filter((c) => c.type === "incoming").length,
    talk1: arr.filter((c) => c.talkDurationSec >= 1).length,
    sessions: new Set(arr.map((c) => c.sessionId)).size,
  });
  const all = cnt(dayLegs);
  const b2b = cnt(b2bLegs);
  console.log(`\nСырой CallGear за ${ymd}:`);
  console.log(`  Весь аккаунт: легов=${all.total} (исх=${all.out}, вх=${all.inn}), уник. сессий=${all.sessions}`);
  console.log(`  КОММЕРСЫ:     легов=${b2b.total} (исх=${b2b.out}, вх=${b2b.inn}), дозвон(talk>=1s)=${b2b.talk1}, уник. сессий=${b2b.sessions}`);

  console.log(`\n  По менеджерам (сырой CallGear, леги):`);
  const byAgent = new Map<string, { out: number; inn: number; talk: number; sess: Set<string> }>();
  for (const c of b2bLegs) {
    const name = cgIdToName.get(String(c.agentId))!;
    const a = byAgent.get(name) ?? { out: 0, inn: 0, talk: 0, sess: new Set<string>() };
    if (c.type === "outgoing") a.out++; else a.inn++;
    if (c.talkDurationSec >= 1) a.talk++;
    a.sess.add(c.sessionId);
    byAgent.set(name, a);
  }
  for (const [name, a] of [...byAgent.entries()].sort()) {
    console.log(`    ${name.padEnd(26)} исх=${String(a.out).padStart(4)}  вх=${String(a.inn).padStart(3)}  дозвон=${String(a.talk).padStart(4)}  сессий=${a.sess.size}`);
  }

  // ── analytics.communications: cg-leg строки b2b-менеджеров за день ──
  const adb = neon(process.env.ANALYTICS_DATABASE_URL!);
  const dbAgg = (await adb`
    WITH deduped AS (
      SELECT DISTINCT ON (communication_id)
        communication_id, communication_type, manager, duration
      FROM analytics.communications
      WHERE created_at >= ${fromUtc.toISOString()}
        AND created_at < ${toUtcExcl.toISOString()}
        AND manager = ANY(${names})
        AND communication_id LIKE 'cg-leg:%'
      ORDER BY communication_id, lead_id NULLS LAST
    )
    SELECT manager,
      COUNT(*) FILTER (WHERE communication_type = 'call_out') AS out_n,
      COUNT(*) FILTER (WHERE communication_type = 'call_in')  AS in_n,
      COUNT(*) FILTER (WHERE communication_type LIKE 'call%' AND duration >= 1) AS talk_n
    FROM deduped GROUP BY manager ORDER BY manager
  `) as Array<{ manager: string; out_n: string; in_n: string; talk_n: string }>;

  console.log(`\nВ analytics.communications (cg-leg:, дедуп) за ${ymd}:`);
  let dbOut = 0, dbIn = 0, dbTalk = 0;
  for (const r of dbAgg) {
    dbOut += Number(r.out_n); dbIn += Number(r.in_n); dbTalk += Number(r.talk_n);
    console.log(`    ${r.manager.padEnd(26)} исх=${String(r.out_n).padStart(4)}  вх=${String(r.in_n).padStart(3)}  дозвон=${String(r.talk_n).padStart(4)}`);
  }
  console.log(`  ИТОГО: исх=${dbOut}, вх=${dbIn}, дозвон=${dbTalk}`);

  // ── Расхождение по id: чего нет в БД / чего нет в API ──
  const rawIds = new Set(b2bLegs.map((c) => c.externalId));
  const dbIds = (await adb`
    SELECT DISTINCT communication_id
    FROM analytics.communications
    WHERE created_at >= ${fromUtc.toISOString()}
      AND created_at < ${toUtcExcl.toISOString()}
      AND manager = ANY(${names})
      AND communication_id LIKE 'cg-leg:%'
  `) as Array<{ communication_id: string }>;
  const dbIdSet = new Set(dbIds.map((r) => r.communication_id));
  const missingInDb = [...rawIds].filter((id) => !dbIdSet.has(id));
  const missingInApi = [...dbIdSet].filter((id) => !rawIds.has(id));
  console.log(`\nЛегов в API, но НЕТ в analytics: ${missingInDb.length}`);
  for (const id of missingInDb.slice(0, 10)) {
    const c = b2bLegs.find((x) => x.externalId === id)!;
    console.log(`  ${id}  ${cgIdToName.get(String(c.agentId))}  ${c.startedAt.toISOString()}  ${c.type}  talk=${c.talkDurationSec}`);
  }
  console.log(`Строк в analytics, но НЕТ в API-выгрузке: ${missingInApi.length}`);
  for (const id of missingInApi.slice(0, 10)) console.log(`  ${id}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
