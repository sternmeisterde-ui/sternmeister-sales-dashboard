// Спека 22 п.3 «Ожидание (сек)»: почему плитка ~14с при кабинетных ~23-28с.
// Декомпозиция за день: текущая формула vs варианты скоупа/определения.
// Кабинетный якорь CallGear можно взять из CSV-выгрузок (колонка
// «Длительность ожидания ответа» по отвеченным). READ-ONLY.
//
// Usage: npx tsx scripts/diag-b2b-wait.ts [YMD]

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { neon } from "@neondatabase/serverless";
import { NAME_ALIASES } from "../src/lib/daily/name-aliases";

const B2B_PIPES = [10631243, 13209983];

async function main() {
  const ymd = process.argv[2] ?? "2026-06-27";
  const fromUtc = new Date(`${ymd}T00:00:00+02:00`);
  const toUtcExcl = new Date(fromUtc.getTime() + 86_400_000);

  const d1 = neon(process.env.DATABASE_URL!);
  const masters = (await d1`
    SELECT name FROM master_managers
    WHERE department = 'b2b' AND is_active = true
      AND role IN ('manager', 'teamlead', 'rop')`) as Array<{ name: string }>;
  const names: string[] = [];
  for (const m of masters) {
    names.push(m.name);
    for (const a of NAME_ALIASES[m.name] ?? []) names.push(a);
  }

  const adb = neon(process.env.ANALYTICS_DATABASE_URL!);

  // 1) ТЕКУЩАЯ формула плитки (fetchAvgWaitSeconds): воронки b2b + NULL,
  //    отвеченные (duration>=1), все типы call%.
  const current = (await adb`
    WITH deduped AS (
      SELECT DISTINCT ON (communication_id)
        communication_id, communication_type, duration, wait_seconds, manager, pipeline_id
      FROM analytics.communications
      WHERE created_at >= ${fromUtc.toISOString()} AND created_at < ${toUtcExcl.toISOString()}
        AND (pipeline_id IN (10631243, 13209983) OR pipeline_id IS NULL)
      ORDER BY communication_id, lead_id NULLS LAST
    )
    SELECT
      round(AVG(wait_seconds) FILTER (WHERE communication_type LIKE 'call%' AND duration >= 1)) AS tile_now,
      COUNT(*) FILTER (WHERE communication_type LIKE 'call%' AND duration >= 1) AS n_now,
      COUNT(*) FILTER (WHERE communication_type LIKE 'call%' AND duration >= 1 AND pipeline_id IS NULL) AS n_null_scope,
      round(AVG(wait_seconds) FILTER (WHERE communication_type LIKE 'call%' AND duration >= 1 AND pipeline_id IS NULL)) AS avg_null_scope,
      COUNT(*) FILTER (WHERE communication_type LIKE 'call%' AND duration >= 1 AND pipeline_id IS NULL AND NOT (manager = ANY(${names}))) AS n_null_foreign
    FROM deduped`) as Array<Record<string, unknown>>;

  console.log(`=== ${ymd} ===`);
  console.log(`ТЕКУЩАЯ плитка (воронки+NULL, отвеченные): ${current[0].tile_now}с по ${current[0].n_now} звонкам`);
  console.log(`  из них NULL-pipeline: ${current[0].n_null_scope} звонков, ср. ${current[0].avg_null_scope}с`);
  console.log(`  из NULL-строк НЕ наших МОПов (чужие/b2g): ${current[0].n_null_foreign}`);

  // 2) Варианты: скоуп ПО АГЕНТАМ (как остальные плитки b2b), разрезы.
  const variants = (await adb`
    WITH deduped AS (
      SELECT DISTINCT ON (communication_id)
        communication_id, communication_type, duration, wait_seconds,
        CASE WHEN communication_id LIKE 'cg-leg:%' THEN 'cg' ELSE 'ct' END AS src
      FROM analytics.communications
      WHERE created_at >= ${fromUtc.toISOString()} AND created_at < ${toUtcExcl.toISOString()}
        AND manager = ANY(${names})
        AND communication_type LIKE 'call%'
      ORDER BY communication_id, lead_id NULLS LAST
    )
    SELECT
      round(AVG(wait_seconds) FILTER (WHERE duration >= 1)) AS answered_all,
      round(AVG(wait_seconds) FILTER (WHERE duration >= 1 AND communication_type = 'call_out')) AS answered_out,
      round(AVG(wait_seconds)) AS all_calls,
      round(AVG(wait_seconds) FILTER (WHERE duration >= 1 AND src = 'ct')) AS ct_answered,
      round(AVG(wait_seconds) FILTER (WHERE duration >= 1 AND src = 'cg')) AS cg_answered,
      COUNT(*) FILTER (WHERE duration >= 1) AS n_answered
    FROM deduped`) as Array<Record<string, unknown>>;

  const v = variants[0];
  console.log(`\nВарианты ПО АГЕНТАМ (МОПы):`);
  console.log(`  отвеченные, оба источника: ${v.answered_all}с (n=${v.n_answered})`);
  console.log(`  отвеченные, только исходящие: ${v.answered_out}с`);
  console.log(`  все звонки (вкл. недозвоны): ${v.all_calls}с`);
  console.log(`  по источникам (отвеченные): CloudTalk=${v.ct_answered}с, CallGear=${v.cg_answered}с`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
