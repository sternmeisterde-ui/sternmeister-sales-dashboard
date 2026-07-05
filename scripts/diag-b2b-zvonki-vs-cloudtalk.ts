// Диагностика: сверка вкладки «Звонки» (B2B) с CloudTalk API.
// READ-ONLY — ничего не пишет ни в одну БД.
//
// Воспроизводит серверную математику плиток B2B из /api/dashboard:
//   «Звонки» = исходящие ПО АГЕНТАМ (manager ∈ активные b2b master_managers,
//              dedup по communication_id) + входящие ПО ЛИНИИ (line_name LIKE 'KOM%')
// и сравнивает с сырыми CDR, выгруженными напрямую из CloudTalk
// /api/calls/index.json за те же берлинские дни.
//
// Usage: npx tsx scripts/diag-b2b-zvonki-vs-cloudtalk.ts [fromYMD] [toYMD]
//   (границы — берлинские календарные дни включительно; default: последние 7 полных)

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

// Neon на этой машине виснет по IPv6 — форсим IPv4 (см. src/instrumentation.ts)
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");

import { neon } from "@neondatabase/serverless";
import { getCallsByDate } from "../src/lib/telephony/cloudtalk";
import { NAME_ALIASES } from "../src/lib/daily/name-aliases";

const BERLIN = "Europe/Berlin";

function berlinDay(d: Date): string {
  return d.toLocaleDateString("sv", { timeZone: BERLIN });
}

// Берлинская полночь дня YMD → UTC Date (лето +2, зима +1 — берём через Intl)
function berlinMidnightUtc(ymd: string): Date {
  // пробуем оба смещения, проверяем какой даёт нужный берлинский день/час
  for (const off of ["+02:00", "+01:00"]) {
    const d = new Date(`${ymd}T00:00:00${off}`);
    const parts = new Intl.DateTimeFormat("sv", {
      timeZone: BERLIN, hour: "2-digit", hourCycle: "h23",
    }).format(d);
    if (parts === "00") return d;
  }
  throw new Error(`cannot resolve Berlin midnight for ${ymd}`);
}

async function main() {
  const [fromArg, toArg] = process.argv.slice(2);
  // default: последние 7 полных берлинских дней (вчера и 6 до него)
  const todayBerlin = berlinDay(new Date());
  const yesterday = new Date(berlinMidnightUtc(todayBerlin).getTime() - 86_400_000);
  const toYmd = toArg ?? berlinDay(yesterday);
  const fromYmd = fromArg ?? berlinDay(new Date(berlinMidnightUtc(toYmd).getTime() - 6 * 86_400_000));

  const fromUtc = berlinMidnightUtc(fromYmd);
  const toUtcExcl = new Date(berlinMidnightUtc(toYmd).getTime() + 86_400_000); // конец последнего дня

  const days: string[] = [];
  for (let t = fromUtc.getTime(); t < toUtcExcl.getTime(); t += 86_400_000) {
    days.push(berlinDay(new Date(t + 3_600_000))); // +1ч чтобы не попасть на границу
  }
  console.log(`Окно: ${fromYmd} .. ${toYmd} (Berlin), UTC [${fromUtc.toISOString()} .. ${toUtcExcl.toISOString()})\n`);

  // ── 1. Активные b2b-менеджеры из master_managers (D1) ──
  const d1 = neon(process.env.DATABASE_URL!);
  const masters = (await d1`
    SELECT id, name, role, cloudtalk_agent_id
    FROM master_managers
    WHERE department = 'b2b' AND is_active = true
  `) as Array<{ id: string; name: string; role: string; cloudtalk_agent_id: string | null }>;

  const names: string[] = [];
  for (const m of masters) {
    names.push(m.name);
    for (const a of NAME_ALIASES[m.name] ?? []) names.push(a);
  }
  const ctIdToName = new Map<string, string>();
  for (const m of masters) if (m.cloudtalk_agent_id) ctIdToName.set(String(m.cloudtalk_agent_id), m.name);

  console.log(`Активные b2b master_managers: ${masters.length}, с cloudtalk_agent_id: ${ctIdToName.size}`);
  for (const m of masters) {
    console.log(`  ${m.name} (${m.role})${m.cloudtalk_agent_id ? "" : "  ⚠ БЕЗ cloudtalk_agent_id"}`);
  }
  console.log("");

  // ── 2. Цифры вкладки из analytics.communications ──
  const adb = neon(process.env.ANALYTICS_DATABASE_URL!);

  // 2a. Исходящие/входящие ПО АГЕНТАМ (как per-manager путь + сумма = плитки)
  const byAgent = (await adb`
    WITH deduped AS (
      SELECT DISTINCT ON (communication_id)
        communication_id, communication_type, manager, duration, created_at
      FROM analytics.communications
      WHERE created_at >= ${fromUtc.toISOString()}
        AND created_at < ${toUtcExcl.toISOString()}
        AND manager = ANY(${names})
      ORDER BY communication_id, lead_id NULLS LAST
    )
    SELECT
      to_char((created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin')::date, 'YYYY-MM-DD') AS day,
      COUNT(*) FILTER (WHERE communication_type = 'call_out')                    AS out_total,
      COUNT(*) FILTER (WHERE communication_type = 'call_out' AND duration >= 1)  AS out_conn,
      COUNT(*) FILTER (WHERE communication_type = 'call_in')                     AS in_agent,
      COUNT(*) FILTER (WHERE communication_type LIKE 'call%' AND duration >= 1)  AS conn_total
    FROM deduped
    GROUP BY day ORDER BY day
  `) as Array<Record<string, string>>;

  // 2b. Входящие ПО ЛИНИИ KOM% (как getAnalyticsInboundByLine)
  const byLine = (await adb`
    SELECT
      to_char((created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin')::date, 'YYYY-MM-DD') AS day,
      COUNT(DISTINCT communication_id) AS in_line
    FROM analytics.communications
    WHERE created_at >= ${fromUtc.toISOString()}
      AND created_at < ${toUtcExcl.toISOString()}
      AND communication_type = 'call_in'
      AND line_name LIKE 'KOM%'
    GROUP BY day ORDER BY day
  `) as Array<Record<string, string>>;

  // 2c. Сколько ct:-строк вообще лежит в analytics за эти дни (покрытие ETL)
  const ctRows = (await adb`
    SELECT
      to_char((created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin')::date, 'YYYY-MM-DD') AS day,
      COUNT(DISTINCT communication_id) FILTER (WHERE communication_type = 'call_out') AS ct_out,
      COUNT(DISTINCT communication_id) FILTER (WHERE communication_type = 'call_in')  AS ct_in
    FROM analytics.communications
    WHERE created_at >= ${fromUtc.toISOString()}
      AND created_at < ${toUtcExcl.toISOString()}
      AND communication_id LIKE 'ct:%'
    GROUP BY day ORDER BY day
  `) as Array<Record<string, string>>;

  // ── 3. Сырые CDR из CloudTalk (окно с запасом ±1 день, бакет по Берлину) ──
  console.log("Тяну CloudTalk CDR (это ~минута)...");
  const ctCalls = await getCallsByDate(
    new Date(fromUtc.getTime() - 86_400_000),
    new Date(toUtcExcl.getTime() + 86_400_000),
  );
  console.log(`CloudTalk вернул ${ctCalls.length} CDR (окно с запасом)\n`);

  type DayAgg = {
    outB2b: number; outB2bConn: number; outOther: number; outNoAgent: number;
    inKom: number; inOtherLine: number; connTotalB2b: number;
    otherAgents: Map<string, number>;
  };
  const ct = new Map<string, DayAgg>();
  for (const d of days) ct.set(d, { outB2b: 0, outB2bConn: 0, outOther: 0, outNoAgent: 0, inKom: 0, inOtherLine: 0, connTotalB2b: 0, otherAgents: new Map() });

  for (const c of ctCalls) {
    const day = berlinDay(c.startedAt);
    const agg = ct.get(day);
    if (!agg) continue; // за пределами целевых дней
    const isB2bAgent = c.agentId != null && ctIdToName.has(String(c.agentId));
    if (c.type === "outgoing") {
      if (isB2bAgent) {
        agg.outB2b++;
        if (c.talkDurationSec >= 1) { agg.outB2bConn++; agg.connTotalB2b++; }
      } else if (c.agentId == null) {
        agg.outNoAgent++;
      } else {
        agg.outOther++;
        const key = `${c.agentName ?? "?"} [${c.agentId}]`;
        agg.otherAgents.set(key, (agg.otherAgents.get(key) ?? 0) + 1);
      }
    } else if (c.type === "incoming") {
      if ((c.lineName ?? "").startsWith("KOM")) agg.inKom++;
      else agg.inOtherLine++;
      if (isB2bAgent && c.talkDurationSec >= 1) agg.connTotalB2b++;
    }
  }

  // ── 4. Сводная таблица ──
  const aMap = new Map(byAgent.map((r) => [r.day, r]));
  const lMap = new Map(byLine.map((r) => [r.day, r]));
  const cMap = new Map(ctRows.map((r) => [r.day, r]));

  console.log("День        | ПЛИТКА (analytics)          | CLOUDTALK (сырой CDR)          | ETL ct:-строки");
  console.log("            | исх   вх.KOM  ИТОГО  дозвон | исх.b2b  вх.KOM  ИТОГО  дозвон | out    in");
  console.log("-".repeat(110));
  for (const d of days) {
    const a = aMap.get(d); const l = lMap.get(d); const c = ct.get(d)!; const e = cMap.get(d);
    const aOut = Number(a?.out_total ?? 0);
    const aIn = Number(l?.in_line ?? 0);
    const aTot = aOut + aIn;
    const aConn = Number(a?.conn_total ?? 0);
    const cTot = c.outB2b + c.inKom;
    const dTot = aTot - cTot;
    console.log(
      `${d}  | ${String(aOut).padStart(4)} ${String(aIn).padStart(7)} ${String(aTot).padStart(7)} ${String(aConn).padStart(7)} | ` +
      `${String(c.outB2b).padStart(7)} ${String(c.inKom).padStart(7)} ${String(cTot).padStart(7)} ${String(c.connTotalB2b).padStart(7)} | ` +
      `${String(e?.ct_out ?? 0).padStart(5)} ${String(e?.ct_in ?? 0).padStart(5)}` +
      (dTot !== 0 ? `   <-- Δ ИТОГО ${dTot > 0 ? "+" : ""}${dTot}` : "")
    );
  }

  // ── 5. Что CloudTalk видит, но вкладка не атрибутирует ──
  console.log("\nCloudTalk-исходящие ВНЕ b2b-агентов (не попадают в плитку «Звонки»):");
  for (const d of days) {
    const c = ct.get(d)!;
    if (c.outOther === 0 && c.outNoAgent === 0) continue;
    const detail = Array.from(c.otherAgents.entries()).map(([k, n]) => `${k}×${n}`).join(", ");
    console.log(`  ${d}: чужие-агенты=${c.outOther} (${detail}), без-агента=${c.outNoAgent}`);
  }
  console.log("\nCloudTalk-входящие на НЕ-KOM линиях (справочно, к b2b не относятся):");
  for (const d of days) {
    const c = ct.get(d)!;
    if (c.inOtherLine > 0) console.log(`  ${d}: ${c.inOtherLine}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
