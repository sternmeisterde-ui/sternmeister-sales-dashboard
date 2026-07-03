// Диагностика №4: какие сырые CloudTalk-исходящие b2b-агентов ОТСУТСТВУЮТ в
// analytics.communications (или лежат там с другим manager/NULL). READ-ONLY.
//
// Usage: npx tsx scripts/diag-b2b-zvonki-missing-ct.ts [fromYMD] [toYMD]

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");

import { neon } from "@neondatabase/serverless";
import { getCallsByDate } from "../src/lib/telephony/cloudtalk";

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
    SELECT name, cloudtalk_agent_id FROM master_managers
    WHERE department = 'b2b' AND is_active = true AND cloudtalk_agent_id IS NOT NULL
  `) as Array<{ name: string; cloudtalk_agent_id: string }>;
  const ctIdToName = new Map(masters.map((m) => [String(m.cloudtalk_agent_id), m.name]));

  const raw = await getCallsByDate(
    new Date(fromUtc.getTime() - 86_400_000),
    new Date(toUtcExcl.getTime() + 86_400_000),
  );
  const targets = raw.filter((c) => {
    if (c.type !== "outgoing" || c.agentId == null) return false;
    if (!ctIdToName.has(String(c.agentId))) return false;
    const d = berlinDay(c.startedAt);
    return d >= fromYmd && d <= toYmd;
  });
  console.log(`Сырых CloudTalk-исходящих b2b-агентов в окне: ${targets.length}`);

  const ids = targets.map((c) => c.externalId);
  const adb = neon(process.env.ANALYTICS_DATABASE_URL!);
  const present = (await adb`
    SELECT DISTINCT communication_id, manager
    FROM analytics.communications
    WHERE communication_id = ANY(${ids})
  `) as Array<{ communication_id: string; manager: string | null }>;
  const managerById = new Map(present.map((r) => [r.communication_id, r.manager]));

  const missing = targets.filter((c) => !managerById.has(c.externalId));
  const wrongManager = targets.filter((c) => {
    const m = managerById.get(c.externalId);
    return m !== undefined && m !== ctIdToName.get(String(c.agentId));
  });

  console.log(`Полностью отсутствуют в analytics: ${missing.length}`);
  for (const c of missing.slice(0, 20)) {
    console.log(`  ${c.externalId}  agent=${c.agentName}  ${c.startedAt.toISOString()}  dur=${c.durationSec}  talk=${c.talkDurationSec}  phone=${c.phone}  line=${c.lineName}  status=${c.status}`);
  }
  console.log(`\nЕсть, но manager отличается от ожидаемого: ${wrongManager.length}`);
  for (const c of wrongManager.slice(0, 20)) {
    console.log(`  ${c.externalId}  ожидали=${ctIdToName.get(String(c.agentId))}  в БД=${managerById.get(c.externalId)}  ${c.startedAt.toISOString()}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
