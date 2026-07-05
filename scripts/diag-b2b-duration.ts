// Диагностика «Длительности» (спека 22, п.2): какая формула воспроизводит
// цифры кабинетов CloudTalk/CallGear. Сверяем за один берлинский день:
//   - analytics: SUM(duration) [текущая плитка] vs SUM(duration+wait)
//   - сырой CloudTalk: SUM(billsec) vs SUM(talking) vs SUM(talking+waiting)
//   - сырой CallGear: SUM(total_duration) vs SUM(talk)
// Якоря созвона за 29.06: вкладка 775м (тогда ещё с Сафроновой),
// кабинет CT ≈ 791м (без Сафроновой), кабинет CG = 29:24 (5 МОПов).
// READ-ONLY.
//
// Usage: npx tsx scripts/diag-b2b-duration.ts [YMD]

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");

import { neon } from "@neondatabase/serverless";
import { getCallsByDate as getCT } from "../src/lib/telephony/cloudtalk";
import { getCallsByDate as getCG } from "../src/lib/telephony/callgear";
import { NAME_ALIASES } from "../src/lib/daily/name-aliases";

const BERLIN = "Europe/Berlin";
const berlinDay = (d: Date) => d.toLocaleDateString("sv", { timeZone: BERLIN });
const min = (s: number) => (s / 60).toFixed(1) + "м";

async function main() {
  const ymd = process.argv[2] ?? "2026-06-29";
  const fromUtc = new Date(`${ymd}T00:00:00+02:00`);
  const toUtcExcl = new Date(fromUtc.getTime() + 86_400_000);

  const d1 = neon(process.env.DATABASE_URL!);
  const masters = (await d1`
    SELECT name, role, cloudtalk_agent_id, callgear_employee_id
    FROM master_managers WHERE department = 'b2b' AND is_active = true
  `) as Array<{ name: string; role: string; cloudtalk_agent_id: string | null; callgear_employee_id: string | null }>;
  const sales = masters.filter((m) => ["manager", "teamlead", "rop"].includes(m.role));
  const salesNames: string[] = [];
  for (const m of sales) {
    salesNames.push(m.name);
    for (const a of NAME_ALIASES[m.name] ?? []) salesNames.push(a);
  }
  const ctIds = new Set(sales.filter((m) => m.cloudtalk_agent_id).map((m) => String(m.cloudtalk_agent_id)));
  const cgIds = new Set(sales.filter((m) => m.callgear_employee_id).map((m) => String(m.callgear_employee_id)));
  const safCg = masters.find((m) => m.role === "prolongation")?.callgear_employee_id;

  // ── analytics: текущая формула vs duration+wait ──
  const adb = neon(process.env.ANALYTICS_DATABASE_URL!);
  const rows = (await adb`
    WITH deduped AS (
      SELECT DISTINCT ON (communication_id)
        communication_id, communication_type, duration, wait_seconds
      FROM analytics.communications
      WHERE created_at >= ${fromUtc.toISOString()} AND created_at < ${toUtcExcl.toISOString()}
        AND manager = ANY(${salesNames})
        AND communication_type LIKE 'call%'
      ORDER BY communication_id, lead_id NULLS LAST
    )
    SELECT
      CASE WHEN communication_id LIKE 'ct:%' THEN 'ct' ELSE 'cg' END AS src,
      COUNT(*) AS n,
      COUNT(*) FILTER (WHERE wait_seconds IS NULL) AS wait_null,
      COALESCE(SUM(duration), 0) AS talk_s,
      COALESCE(SUM(duration + COALESCE(wait_seconds, 0)), 0) AS full_s
    FROM deduped GROUP BY 1 ORDER BY 1
  `) as Array<{ src: string; n: string; wait_null: string; talk_s: string; full_s: string }>;

  console.log(`=== ${ymd}, МОПы b2b (без продлений) ===\n`);
  console.log("analytics.communications (то, из чего считает вкладка):");
  let aTalk = 0, aFull = 0;
  for (const r of rows) {
    aTalk += Number(r.talk_s); aFull += Number(r.full_s);
    console.log(`  ${r.src}: n=${r.n}  wait_null=${r.wait_null}  SUM(duration)=${min(Number(r.talk_s))}  SUM(duration+wait)=${min(Number(r.full_s))}`);
  }
  console.log(`  ИТОГО: текущая плитка (talk)=${min(aTalk)}  |  вариант talk+wait=${min(aFull)}\n`);

  // ── сырой CloudTalk ──
  const rawCt = await getCT(new Date(fromUtc.getTime() - 86_400_000), new Date(toUtcExcl.getTime() + 86_400_000));
  let ctBill = 0, ctTalk = 0, ctTalkWait = 0, ctN = 0;
  for (const c of rawCt) {
    if (berlinDay(c.startedAt) !== ymd) continue;
    if (!c.agentId || !ctIds.has(String(c.agentId))) continue;
    ctN++;
    ctBill += c.durationSec;          // billsec
    ctTalk += c.talkDurationSec;      // talking_time
    ctTalkWait += c.talkDurationSec + c.waitSec;
  }
  console.log(`CloudTalk raw (${ctN} CDR, агенты-МОПы):`);
  console.log(`  SUM(billsec)=${min(ctBill)}  SUM(talking)=${min(ctTalk)}  SUM(talking+waiting)=${min(ctTalkWait)}`);
  console.log(`  якорь кабинета с созвона: ~791м\n`);

  // ── сырой CallGear ──
  const rawCg = await getCG(new Date(fromUtc.getTime() - 86_400_000), new Date(toUtcExcl.getTime() + 86_400_000));
  let cgTotal = 0, cgTalk = 0, cgN = 0, safTotal = 0, safTalk = 0, safN = 0;
  for (const c of rawCg) {
    if (berlinDay(c.startedAt) !== ymd) continue;
    if (!c.agentId) continue;
    if (cgIds.has(String(c.agentId))) {
      cgN++; cgTotal += c.durationSec; cgTalk += c.talkDurationSec;
    } else if (safCg && String(c.agentId) === String(safCg)) {
      safN++; safTotal += c.durationSec; safTalk += c.talkDurationSec;
    }
  }
  console.log(`CallGear raw (${cgN} легов, МОПы):`);
  console.log(`  SUM(total_duration)=${min(cgTotal)}  SUM(talk)=${min(cgTalk)}`);
  console.log(`  якорь кабинета с созвона (5 МОПов, без Трапезниковой/Аладиной?): 29.4м`);
  console.log(`  (Сафронова отдельно: n=${safN} total=${min(safTotal)} talk=${min(safTalk)})\n`);

  console.log("Сводка вариантов формулы плитки:");
  console.log(`  как сейчас  = talk(ct)+talk(cg)            = ${min(aTalk)}`);
  console.log(`  кандидат #1 = (talk+wait) оба источника    = ${min(aFull)}`);
  console.log(`  кабинеты    = CT(?) + CG(total)            = см. цифры выше`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
