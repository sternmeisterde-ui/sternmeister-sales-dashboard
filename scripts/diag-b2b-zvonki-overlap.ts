// Диагностика №3: являются ли cg-leg: (CallGear) исходящие b2b-менеджеров
// дублями их же ct: (CloudTalk) звонков. Матч: тот же менеджер + те же
// последние 10 цифр номера + |Δt| <= 180s. READ-ONLY.
//
// Usage: npx tsx scripts/diag-b2b-zvonki-overlap.ts [fromYMD] [toYMD]

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");

import { neon } from "@neondatabase/serverless";
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
    SELECT name FROM master_managers WHERE department = 'b2b' AND is_active = true
  `) as Array<{ name: string }>;
  const names: string[] = [];
  for (const m of masters) {
    names.push(m.name);
    for (const a of NAME_ALIASES[m.name] ?? []) names.push(a);
  }

  const adb = neon(process.env.ANALYTICS_DATABASE_URL!);

  // Каждому cg-leg исходящему ищем ct-пару: тот же менеджер, те же последние
  // 10 цифр, |Δt| <= 180 сек.
  const rows = (await adb`
    WITH cg AS (
      SELECT DISTINCT ON (communication_id)
        communication_id, manager, created_at, duration,
        right(regexp_replace(phone, '\\D', '', 'g'), 10) AS pnorm
      FROM analytics.communications
      WHERE created_at >= ${fromUtc.toISOString()}
        AND created_at < ${toUtcExcl.toISOString()}
        AND manager = ANY(${names})
        AND communication_type = 'call_out'
        AND communication_id LIKE 'cg-leg:%'
      ORDER BY communication_id, lead_id NULLS LAST
    ),
    ct AS (
      SELECT DISTINCT ON (communication_id)
        communication_id, manager, created_at, duration,
        right(regexp_replace(phone, '\\D', '', 'g'), 10) AS pnorm
      FROM analytics.communications
      WHERE created_at >= ${fromUtc.toISOString()}
        AND created_at < ${toUtcExcl.toISOString()}
        AND manager = ANY(${names})
        AND communication_type = 'call_out'
        AND communication_id LIKE 'ct:%'
      ORDER BY communication_id, lead_id NULLS LAST
    )
    SELECT
      cg.manager,
      COUNT(*) AS cg_total,
      COUNT(*) FILTER (WHERE cg.duration >= 1) AS cg_connected,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM ct
        WHERE ct.manager = cg.manager
          AND ct.pnorm = cg.pnorm
          AND abs(extract(epoch FROM (ct.created_at - cg.created_at))) <= 180
      )) AS overlapped
    FROM cg
    GROUP BY cg.manager
    ORDER BY cg.manager
  `) as Array<{ manager: string; cg_total: string; cg_connected: string; overlapped: string }>;

  console.log(`Окно ${fromYmd}..${toYmd}. cg-leg-исходящие b2b-менеджеров и их пересечение с ct: (тот же номер, ±180с):\n`);
  console.log("Менеджер                    | cg-leg всего | из них дозвон | совпало с ct: (дубль?)");
  for (const r of rows) {
    console.log(`${r.manager.padEnd(27)} | ${String(r.cg_total).padStart(12)} | ${String(r.cg_connected).padStart(13)} | ${String(r.overlapped).padStart(10)}`);
  }

  // Примеры совпавших пар — глазами посмотреть что это
  const pairs = (await adb`
    WITH cg AS (
      SELECT DISTINCT ON (communication_id)
        communication_id, manager, created_at, duration,
        right(regexp_replace(phone, '\\D', '', 'g'), 10) AS pnorm
      FROM analytics.communications
      WHERE created_at >= ${fromUtc.toISOString()} AND created_at < ${toUtcExcl.toISOString()}
        AND manager = ANY(${names}) AND communication_type = 'call_out'
        AND communication_id LIKE 'cg-leg:%'
      ORDER BY communication_id, lead_id NULLS LAST
    ),
    ct AS (
      SELECT DISTINCT ON (communication_id)
        communication_id, manager, created_at, duration,
        right(regexp_replace(phone, '\\D', '', 'g'), 10) AS pnorm
      FROM analytics.communications
      WHERE created_at >= ${fromUtc.toISOString()} AND created_at < ${toUtcExcl.toISOString()}
        AND manager = ANY(${names}) AND communication_type = 'call_out'
        AND communication_id LIKE 'ct:%'
      ORDER BY communication_id, lead_id NULLS LAST
    )
    SELECT cg.communication_id AS cg_id, ct.communication_id AS ct_id, cg.manager,
           cg.pnorm, cg.created_at AS cg_at, ct.created_at AS ct_at,
           cg.duration AS cg_dur, ct.duration AS ct_dur
    FROM cg JOIN ct ON ct.manager = cg.manager AND ct.pnorm = cg.pnorm
      AND abs(extract(epoch FROM (ct.created_at - cg.created_at))) <= 180
    ORDER BY cg.created_at DESC
    LIMIT 12
  `) as Array<Record<string, unknown>>;
  console.log("\nПримеры пар cg-leg ↔ ct (кандидаты в дубли):");
  for (const p of pairs) {
    console.log(`  ${p.manager}  тел…${p.pnorm}: ${p.cg_id} (dur=${p.cg_dur}, ${p.cg_at}) ↔ ${p.ct_id} (dur=${p.ct_dur}, ${p.ct_at})`);
  }

  // Сводка по дням: насколько плитка «Звонки» завышена дублями
  const daily = (await adb`
    WITH cg AS (
      SELECT DISTINCT ON (communication_id)
        communication_id, manager, created_at,
        right(regexp_replace(phone, '\\D', '', 'g'), 10) AS pnorm
      FROM analytics.communications
      WHERE created_at >= ${fromUtc.toISOString()} AND created_at < ${toUtcExcl.toISOString()}
        AND manager = ANY(${names}) AND communication_type = 'call_out'
        AND communication_id LIKE 'cg-leg:%'
      ORDER BY communication_id, lead_id NULLS LAST
    ),
    ct AS (
      SELECT DISTINCT ON (communication_id)
        communication_id, manager, created_at,
        right(regexp_replace(phone, '\\D', '', 'g'), 10) AS pnorm
      FROM analytics.communications
      WHERE created_at >= ${fromUtc.toISOString()} AND created_at < ${toUtcExcl.toISOString()}
        AND manager = ANY(${names}) AND communication_type = 'call_out'
        AND communication_id LIKE 'ct:%'
      ORDER BY communication_id, lead_id NULLS LAST
    )
    SELECT
      to_char((cg.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin')::date, 'YYYY-MM-DD') AS day,
      COUNT(*) AS dup_candidates
    FROM cg
    WHERE EXISTS (
      SELECT 1 FROM ct
      WHERE ct.manager = cg.manager AND ct.pnorm = cg.pnorm
        AND abs(extract(epoch FROM (ct.created_at - cg.created_at))) <= 180
    )
    GROUP BY 1 ORDER BY 1
  `) as Array<{ day: string; dup_candidates: string }>;
  console.log("\nКандидаты-дубли по дням (завышение плитки «Звонки»):");
  for (const r of daily) console.log(`  ${r.day}: +${r.dup_candidates}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
