// Диагностика №2: откуда у b2b-агентов в analytics.communications БОЛЬШЕ
// исходящих, чем в сыром CloudTalk. Разбивка по источнику comm_id-префикса
// (ct: / cg-leg: / прочее) и по менеджерам, + per-agent сверка с CloudTalk.
// READ-ONLY.
//
// Usage: npx tsx scripts/diag-b2b-zvonki-sources.ts [fromYMD] [toYMD]

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");

import { neon } from "@neondatabase/serverless";
import { getCallsByDate } from "../src/lib/telephony/cloudtalk";
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
  const [fromArg, toArg] = process.argv.slice(2);
  const toYmd = toArg ?? berlinDay(new Date(Date.now() - 86_400_000));
  const fromYmd = fromArg ?? berlinDay(new Date(berlinMidnightUtc(toYmd).getTime() - 6 * 86_400_000));
  const fromUtc = berlinMidnightUtc(fromYmd);
  const toUtcExcl = new Date(berlinMidnightUtc(toYmd).getTime() + 86_400_000);

  const d1 = neon(process.env.DATABASE_URL!);
  const masters = (await d1`
    SELECT id, name, cloudtalk_agent_id FROM master_managers
    WHERE department = 'b2b' AND is_active = true
  `) as Array<{ id: string; name: string; cloudtalk_agent_id: string | null }>;

  const names: string[] = [];
  const aliasToCanon = new Map<string, string>();
  for (const m of masters) {
    names.push(m.name);
    aliasToCanon.set(m.name, m.name);
    for (const a of NAME_ALIASES[m.name] ?? []) { names.push(a); aliasToCanon.set(a, m.name); }
  }
  const ctIdToName = new Map<string, string>();
  for (const m of masters) if (m.cloudtalk_agent_id) ctIdToName.set(String(m.cloudtalk_agent_id), m.name);

  const adb = neon(process.env.ANALYTICS_DATABASE_URL!);

  // Исходящие b2b-агентов по дням × источнику
  const bySource = (await adb`
    WITH deduped AS (
      SELECT DISTINCT ON (communication_id)
        communication_id, communication_type, manager, duration, created_at
      FROM analytics.communications
      WHERE created_at >= ${fromUtc.toISOString()}
        AND created_at < ${toUtcExcl.toISOString()}
        AND manager = ANY(${names})
        AND communication_type = 'call_out'
      ORDER BY communication_id, lead_id NULLS LAST
    )
    SELECT
      to_char((created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin')::date, 'YYYY-MM-DD') AS day,
      CASE
        WHEN communication_id LIKE 'ct:%' THEN 'ct'
        WHEN communication_id LIKE 'cg-leg:%' THEN 'cg-leg'
        WHEN communication_id LIKE 'note:%' THEN 'note'
        ELSE 'other'
      END AS src,
      COUNT(*) AS n
    FROM deduped
    GROUP BY 1, 2 ORDER BY 1, 2
  `) as Array<{ day: string; src: string; n: string }>;

  console.log("Исходящие b2b-агентов в analytics по ИСТОЧНИКУ:");
  const daysSet = [...new Set(bySource.map((r) => r.day))].sort();
  for (const d of daysSet) {
    const parts = bySource.filter((r) => r.day === d).map((r) => `${r.src}=${r.n}`).join("  ");
    console.log(`  ${d}: ${parts}`);
  }

  // Per-agent сверка за всё окно: analytics(ct:) vs analytics(всё) vs CloudTalk raw
  const perAgent = (await adb`
    WITH deduped AS (
      SELECT DISTINCT ON (communication_id)
        communication_id, manager, communication_type, created_at
      FROM analytics.communications
      WHERE created_at >= ${fromUtc.toISOString()}
        AND created_at < ${toUtcExcl.toISOString()}
        AND manager = ANY(${names})
        AND communication_type = 'call_out'
      ORDER BY communication_id, lead_id NULLS LAST
    )
    SELECT manager,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE communication_id LIKE 'ct:%') AS ct_n,
      COUNT(*) FILTER (WHERE communication_id NOT LIKE 'ct:%') AS non_ct
    FROM deduped GROUP BY manager ORDER BY manager
  `) as Array<{ manager: string; total: string; ct_n: string; non_ct: string }>;

  console.log("\nТяну CloudTalk CDR...");
  const raw = await getCallsByDate(
    new Date(fromUtc.getTime() - 86_400_000),
    new Date(toUtcExcl.getTime() + 86_400_000),
  );
  const ctOutByName = new Map<string, number>();
  for (const c of raw) {
    if (c.type !== "outgoing" || c.agentId == null) continue;
    const name = ctIdToName.get(String(c.agentId));
    if (!name) continue;
    const day = berlinDay(c.startedAt);
    if (day < fromYmd || day > toYmd) continue;
    ctOutByName.set(name, (ctOutByName.get(name) ?? 0) + 1);
  }

  console.log(`\nPer-agent за ${fromYmd}..${toYmd} — analytics vs CloudTalk (исходящие):`);
  console.log("Менеджер                    | analytics | из них ct: | не-ct: | CloudTalk raw | Δ(analytics-raw)");
  const agg = new Map<string, { total: number; ct: number; non: number }>();
  for (const r of perAgent) {
    const canon = aliasToCanon.get(r.manager) ?? r.manager;
    const a = agg.get(canon) ?? { total: 0, ct: 0, non: 0 };
    a.total += Number(r.total); a.ct += Number(r.ct_n); a.non += Number(r.non_ct);
    agg.set(canon, a);
  }
  for (const [name, a] of [...agg.entries()].sort()) {
    const rawN = ctOutByName.get(name) ?? 0;
    console.log(
      `${name.padEnd(27)} | ${String(a.total).padStart(9)} | ${String(a.ct).padStart(10)} | ${String(a.non).padStart(6)} | ${String(rawN).padStart(13)} | ${String(a.total - rawN).padStart(5)}`
    );
  }

  // Примеры не-ct строк — что это вообще такое
  const samples = (await adb`
    SELECT communication_id, manager, communication_type, duration, phone, line_name,
           created_at, pipeline_id, lead_id
    FROM analytics.communications
    WHERE created_at >= ${fromUtc.toISOString()}
      AND created_at < ${toUtcExcl.toISOString()}
      AND manager = ANY(${names})
      AND communication_type = 'call_out'
      AND communication_id NOT LIKE 'ct:%'
    ORDER BY created_at DESC
    LIMIT 15
  `) as Array<Record<string, unknown>>;
  console.log("\nПримеры НЕ-ct исходящих строк b2b-агентов:");
  for (const s of samples) {
    console.log(`  ${s.communication_id}  ${s.manager}  dur=${s.duration}  phone=${s.phone}  line=${s.line_name}  pipe=${s.pipeline_id}  lead=${s.lead_id}  ${s.created_at}`);
  }

  // И наоборот: ct:-строки, которых нет в сыром CloudTalk (например, дубли/чужое окно)
  const rawIds = new Set(raw.map((c) => c.externalId));
  const ctOnly = (await adb`
    SELECT DISTINCT communication_id, manager, created_at
    FROM analytics.communications
    WHERE created_at >= ${fromUtc.toISOString()}
      AND created_at < ${toUtcExcl.toISOString()}
      AND manager = ANY(${names})
      AND communication_type = 'call_out'
      AND communication_id LIKE 'ct:%'
  `) as Array<{ communication_id: string; manager: string; created_at: string }>;
  const phantom = ctOnly.filter((r) => !rawIds.has(r.communication_id));
  console.log(`\nct:-строк в analytics, отсутствующих в сыром CloudTalk-выгрузе: ${phantom.length} из ${ctOnly.length}`);
  for (const p of phantom.slice(0, 10)) console.log(`  ${p.communication_id}  ${p.manager}  ${p.created_at}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
