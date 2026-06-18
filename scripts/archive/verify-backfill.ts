// Quick sanity check after a backfill run.
//   npx tsx scripts/verify-backfill.ts [month=2026-04]
// Prints headline Daily-Commerce numbers for the month so you can compare
// directly against the Excel "дейли коммерция.xlsx" > Monthly Numbers.

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { analyticsDb } from "@/lib/db/analytics";
import { sql } from "drizzle-orm";
import { B2B_PIPELINES, B2G_PIPELINES } from "@/lib/kommo/pipeline-config";

async function main() {
  const monthArg = process.argv[2] ?? new Date().toISOString().slice(0, 7);
  const [y, m] = monthArg.split("-").map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
  const to = new Date(Date.UTC(y, m, 0, 23, 59, 59));

  console.log(`\n=== Verify ${monthArg} (${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}) ===\n`);

  const pipelines: Array<[string, number]> = [
    ["B2B Бух Комм", B2B_PIPELINES.COMMERCIAL],
    ["B2B Medical Admin Comm", B2B_PIPELINES.MEDICAL_COMM],
    ["B2G Бух Гос (1-я линия)", B2G_PIPELINES.FIRST_LINE],
    ["B2G Бух Бератер (2-3)", B2G_PIPELINES.BERATER],
    ["B2G Medical Admin Gov", B2G_PIPELINES.MEDICAL_GOV],
  ];

  for (const [label, pid] of pipelines) {
    const r = await (analyticsDb as { execute: <T>(q: unknown) => Promise<{ rows: T[] }> }).execute<{
      leads_created: number | string;
      qual_leads: number | string;
      won: number | string;
      lost: number | string;
      sold_by_fpd: number | string;
      revenue: number | string | null;
      prepayments: number | string;
    }>(sql`
      SELECT
        COUNT(*) FILTER (WHERE created_at >= ${from} AND created_at <= ${to}) AS leads_created,
        COUNT(*) FILTER (
          WHERE created_at >= ${from} AND created_at <= ${to}
            AND (loss_reason IS NULL OR (loss_reason !~* 'неквал' AND loss_reason !~* 'спам'))
        ) AS qual_leads,
        COUNT(*) FILTER (WHERE status_id = 142 AND closed_at >= ${from} AND closed_at <= ${to}) AS won,
        COUNT(*) FILTER (WHERE status_id = 143 AND closed_at >= ${from} AND closed_at <= ${to}) AS lost,
        COUNT(*) FILTER (WHERE first_payment_date >= ${from} AND first_payment_date <= ${to}) AS sold_by_fpd,
        COALESCE(SUM(first_payment_amount) FILTER (WHERE first_payment_date >= ${from} AND first_payment_date <= ${to}), 0)
          + COALESCE(SUM(prepayment_amount)    FILTER (WHERE prepayment_date    >= ${from} AND prepayment_date    <= ${to}), 0)
          AS revenue,
        COUNT(*) FILTER (WHERE prepayment_date >= ${from} AND prepayment_date <= ${to}) AS prepayments
      FROM analytics.leads_cohort
      WHERE pipeline_id = ${pid}
    `);
    const x = r.rows[0];
    console.log(`[${label}] pipeline=${pid}`);
    console.log(`  Лидов создано:     ${x.leads_created}`);
    console.log(`  Квал лидов:         ${x.qual_leads}`);
    console.log(`  WON (status 142):   ${x.won}`);
    console.log(`  LOST (status 143):  ${x.lost}`);
    console.log(`  Продаж (по fpd):    ${x.sold_by_fpd}`);
    console.log(`  Выручка (€):        ${x.revenue}`);
    console.log(`  Предоплат:          ${x.prepayments}`);
    console.log();
  }

  // Call totals
  const c = await (analyticsDb as { execute: <T>(q: unknown) => Promise<{ rows: T[] }> }).execute<{
    pid: number;
    calls_total: number | string;
    calls_connected: number | string;
    calls_minutes: number | string;
  }>(sql`
    SELECT
      pipeline_id AS pid,
      COUNT(*) FILTER (WHERE communication_type LIKE 'call%' AND created_at >= ${from} AND created_at <= ${to}) AS calls_total,
      COUNT(*) FILTER (WHERE communication_type LIKE 'call%' AND duration >= 1 AND created_at >= ${from} AND created_at <= ${to}) AS calls_connected,
      COALESCE(ROUND(SUM(duration) FILTER (WHERE communication_type LIKE 'call%' AND created_at >= ${from} AND created_at <= ${to}) / 60.0)::int, 0) AS calls_minutes
    FROM analytics.communications
    GROUP BY pipeline_id
    ORDER BY pipeline_id
  `);
  console.log("=== Звонки по воронкам ===");
  for (const row of c.rows) {
    console.log(`  pipeline=${row.pid}: total=${row.calls_total} connected=${row.calls_connected} minutes=${row.calls_minutes}`);
  }

  // Status changes (only populated after --full pass)
  const sc = await (analyticsDb as { execute: <T>(q: unknown) => Promise<{ rows: T[] }> }).execute<{
    cnt: number | string;
  }>(sql`SELECT COUNT(*)::int AS cnt FROM analytics.lead_status_changes WHERE event_at >= ${from} AND event_at <= ${to}`);
  console.log(`\nStatus changes in period: ${sc.rows[0]?.cnt ?? 0}  (run backfill --full if 0)`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
