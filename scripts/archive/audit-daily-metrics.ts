// Systematic per-metric audit of Daily B2B Commerce for a given month.
// For every metric key in metrics-config-b2b.ts, runs the actual SQL that
// build-response.ts would run and prints the result — so we can see
// which rows are genuinely zero vs which have a broken formula.
//
//   npx tsx scripts/audit-daily-metrics.ts [month=2026-04]

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { analyticsDb } from "../src/lib/db/analytics";
import { sql } from "drizzle-orm";
import { B2B_PIPELINES } from "../src/lib/kommo/pipeline-config";
import { getB2BPipelineStatsSQL } from "../src/lib/daily/analytics-b2b";

interface Row { label: string; value: string | number | null; note?: string }

async function main() {
  const monthArg = process.argv[2] ?? "2026-04";
  const [y, m] = monthArg.split("-").map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
  const to = new Date(Date.UTC(y, m, 0, 23, 59, 59));

  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  DAILY B2B COMMERCE AUDIT — ${monthArg}                              ║`);
  console.log(`║  range: ${from.toISOString().slice(0,10)} → ${to.toISOString().slice(0,10)}                    ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝`);

  const PIPES: Array<[string, number]> = [
    ["Бух Комм",    B2B_PIPELINES.COMMERCIAL],
    ["Medical Comm", B2B_PIPELINES.MEDICAL_COMM],
  ];

  for (const [name, pid] of PIPES) {
    console.log(`\n━━━ ${name} (pipeline=${pid}) ━━━\n`);
    const rows: Row[] = [];

    // R24/R28/R29 — from real SQL helper
    const stats = await getB2BPipelineStatsSQL(pid, from, to);
    rows.push({ label: "R6/R8  Новая выручка факт (€)", value: stats.revenue });
    rows.push({ label: "R12/R28 Количество продаж факт", value: stats.salesCount });
    rows.push({ label: "R13/R29 Количество предоплат", value: stats.prepaymentCount });
    rows.push({ label: "R10 Всего ком. лидов факт (Total)", value: stats.totalLeads });
    rows.push({ label: "R10 Квал ком. лидов факт", value: stats.qualLeads });

    // Coverage of custom fields
    const cov = await (analyticsDb as { execute: <T>(q: unknown) => Promise<{ rows: T[] }> }).execute<{
      total: number | string;
      with_fpd: number | string;
      with_fpa: number | string;
      with_ppd: number | string;
      with_ppa: number | string;
      with_cat: number | string;
      with_lr: number | string;
      with_nqe: number | string;
    }>(sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE first_payment_date IS NOT NULL)::int AS with_fpd,
        COUNT(*) FILTER (WHERE first_payment_amount IS NOT NULL)::int AS with_fpa,
        COUNT(*) FILTER (WHERE prepayment_date IS NOT NULL)::int AS with_ppd,
        COUNT(*) FILTER (WHERE prepayment_amount IS NOT NULL)::int AS with_ppa,
        COUNT(*) FILTER (WHERE category IS NOT NULL AND TRIM(category) <> '')::int AS with_cat,
        COUNT(*) FILTER (WHERE loss_reason IS NOT NULL AND TRIM(loss_reason) <> '')::int AS with_lr,
        COUNT(*) FILTER (WHERE non_qual_enum_id IS NOT NULL)::int AS with_nqe
      FROM analytics.leads_cohort
      WHERE pipeline_id = ${pid}
        AND created_at >= ${from} AND created_at <= ${to}
    `);

    const c = cov.rows[0];
    console.log(`  Coverage (${c.total} leads created in month):`);
    console.log(`    first_payment_date   ${pct(c.with_fpd, c.total)}`);
    console.log(`    first_payment_amount ${pct(c.with_fpa, c.total)}`);
    console.log(`    prepayment_date      ${pct(c.with_ppd, c.total)}`);
    console.log(`    prepayment_amount    ${pct(c.with_ppa, c.total)}`);
    console.log(`    category             ${pct(c.with_cat, c.total)}`);
    console.log(`    loss_reason text     ${pct(c.with_lr, c.total)}`);
    console.log(`    non_qual_enum_id     ${pct(c.with_nqe, c.total)}`);

    console.log(`\n  Computed metrics:`);
    for (const r of rows) {
      const v = r.value == null ? "—" : String(r.value);
      console.log(`    ${r.label.padEnd(38)} = ${v}`);
    }

    // Per-manager call metrics (B2B) — show top managers
    console.log(`\n  Top 5 managers by call volume (from analytics.communications):`);
    const mgrCalls = await (analyticsDb as { execute: <T>(q: unknown) => Promise<{ rows: T[] }> }).execute<{
      manager: string;
      calls: number | string;
      minutes: number | string;
      connected: number | string;
    }>(sql`
      SELECT manager,
        COUNT(*) FILTER (WHERE communication_type LIKE 'call%')::int AS calls,
        COALESCE(SUM(duration) FILTER (WHERE communication_type LIKE 'call%') / 60, 0)::int AS minutes,
        COUNT(*) FILTER (WHERE communication_type LIKE 'call%' AND duration >= 1)::int AS connected
      FROM analytics.communications
      WHERE pipeline_id = ${pid}
        AND created_at >= ${from} AND created_at <= ${to}
        AND manager IS NOT NULL AND manager <> ''
      GROUP BY manager
      ORDER BY calls DESC
      LIMIT 5
    `);
    for (const r of mgrCalls.rows) {
      console.log(`    ${String(r.manager).padEnd(30)} calls=${r.calls} min=${r.minutes} connected=${r.connected}`);
    }
  }

  console.log(`\n━━━ Cross-check against Excel expected ━━━`);
  console.log(`Open дейли коммерция.xlsx → Monthly Numbers → ${monthArg}.`);
  console.log(`Match:
    R26 Новая выручка Бух факт        ↔  Бух Комм: Новая выручка факт
    R28 Квал ком. Бух лидов факт      ↔  Бух Комм: Квал ком. лидов факт
    R32 Количество продаж Бух факт    ↔  Бух Комм: Количество продаж факт
    R33 Количество предоплат          ↔  Бух Комм: Количество предоплат
    R40 Новая выручка Мед факт        ↔  Medical: Новая выручка факт
    R44 Количество продаж Мед факт    ↔  Medical: Количество продаж факт`);
}

function pct(n: number | string, total: number | string): string {
  const nn = Number(n), tt = Number(total);
  if (tt === 0) return `${nn}/0`;
  return `${nn}/${tt} (${Math.round(100 * nn / tt)}%)`;
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
