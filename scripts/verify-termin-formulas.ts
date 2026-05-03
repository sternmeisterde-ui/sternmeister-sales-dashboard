// Sanity check for /api/dashboard/termins (TZ #1) and /api/dashboard/qual-leads-docs
// (TZ #2). Re-runs the same SQL the routes use against analytics DB and prints
// numbers we can eyeball against expected business behaviour.
//
// Usage: npx tsx scripts/verify-termin-formulas.ts

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { neon } from "@neondatabase/serverless";

const BERATER_PIPELINE = 12154099;
const FIRST_LINE_PIPELINE = 10935879;
const TERM_DC_DONE_STATUS = 93886075;
const DOCS_SENT_DC_STATUS = 101935919;
const NON_QUAL_EXCLUDED = [744876, 747536, 747530, 747532, 744486];

async function main() {
  const url = process.env.ANALYTICS_DATABASE_URL;
  if (!url) throw new Error("ANALYTICS_DATABASE_URL not set");
  const sql = neon(url);

  // ── TZ #1: by-termin-date cohort, last 30d ───────
  console.log("\n=== TZ#1 by termin_date — last 30 days ===");
  const tz1Sample = await sql`
    WITH dc_done AS (
      SELECT lead_id, MIN(event_at) AS dc_done_at
      FROM analytics.lead_status_changes
      WHERE pipeline_id = ${BERATER_PIPELINE} AND status_id = ${TERM_DC_DONE_STATUS}
      GROUP BY lead_id
    ),
    deals AS (
      SELECT
        DATE(COALESCE(lc.termin_date, lc.aa_termin_date)) AS cohort_date,
        EXTRACT(EPOCH FROM (lc.termin_date - lc.created_at)) / 86400.0 AS dc_lag,
        EXTRACT(EPOCH FROM (lc.aa_termin_date - COALESCE(dd.dc_done_at, lc.created_at))) / 86400.0 AS aa_lag
      FROM analytics.leads_cohort lc
      LEFT JOIN dc_done dd ON dd.lead_id = lc.lead_id
      WHERE lc.pipeline_id = ${BERATER_PIPELINE}
        AND COALESCE(lc.termin_date, lc.aa_termin_date) >= NOW() - INTERVAL '30 days'
        AND COALESCE(lc.termin_date, lc.aa_termin_date) <= NOW()
        AND (lc.termin_date IS NOT NULL OR lc.aa_termin_date IS NOT NULL)
    )
    SELECT
      cohort_date::text,
      ROUND(AVG(dc_lag) FILTER (WHERE dc_lag >= 0)::numeric, 1) AS dc_avg,
      ROUND(AVG(aa_lag) FILTER (WHERE aa_lag >= 0)::numeric, 1) AS aa_avg,
      COUNT(*)::int AS cnt
    FROM deals
    GROUP BY cohort_date
    ORDER BY cohort_date DESC
    LIMIT 8
  `;
  console.table(tz1Sample);

  console.log("\n=== TZ#1 cohort-mode totals — last 30 days ===");
  const tz1Compare = await sql`
    SELECT 'by_created_at' AS mode, COUNT(*)::int AS deals
    FROM analytics.leads_cohort
    WHERE pipeline_id = ${BERATER_PIPELINE}
      AND created_at >= NOW() - INTERVAL '30 days'
      AND (termin_date IS NOT NULL OR aa_termin_date IS NOT NULL)
    UNION ALL
    SELECT 'by_termin_date', COUNT(*)::int
    FROM analytics.leads_cohort
    WHERE pipeline_id = ${BERATER_PIPELINE}
      AND COALESCE(termin_date, aa_termin_date) >= NOW() - INTERVAL '30 days'
      AND COALESCE(termin_date, aa_termin_date) <= NOW()
      AND (termin_date IS NOT NULL OR aa_termin_date IS NOT NULL)
  `;
  console.table(tz1Compare);

  console.log("\n=== TZ#1 random sample — manual verification ===");
  const tz1Sanity = await sql`
    WITH dc_done AS (
      SELECT lead_id, MIN(event_at) AS dc_done_at
      FROM analytics.lead_status_changes
      WHERE pipeline_id = ${BERATER_PIPELINE} AND status_id = ${TERM_DC_DONE_STATUS}
      GROUP BY lead_id
    )
    SELECT
      lc.lead_id,
      lc.created_at::date::text AS created,
      lc.termin_date::date::text AS termin_dc,
      lc.aa_termin_date::date::text AS termin_aa,
      dd.dc_done_at::date::text AS dc_done_at,
      ROUND((EXTRACT(EPOCH FROM (lc.termin_date - lc.created_at)) / 86400.0)::numeric, 1) AS dc_lag,
      ROUND((EXTRACT(EPOCH FROM (lc.aa_termin_date - COALESCE(dd.dc_done_at, lc.created_at))) / 86400.0)::numeric, 1) AS aa_lag
    FROM analytics.leads_cohort lc
    LEFT JOIN dc_done dd ON dd.lead_id = lc.lead_id
    WHERE lc.pipeline_id = ${BERATER_PIPELINE}
      AND COALESCE(lc.termin_date, lc.aa_termin_date) >= NOW() - INTERVAL '30 days'
      AND lc.termin_date IS NOT NULL
      AND lc.aa_termin_date IS NOT NULL
    ORDER BY random()
    LIMIT 5
  `;
  console.table(tz1Sanity);

  // ── TZ #2: qual-leads → DOCS_SENT_DC, last 30d ───
  console.log("\n=== TZ#2 qual leads → Документы отправлены в ДЦ — last 30 days ===");
  const tz2Sample = await sql`
    WITH docs_sent AS (
      SELECT lead_id, MIN(event_at) AS docs_sent_at
      FROM analytics.lead_status_changes
      WHERE pipeline_id = ${FIRST_LINE_PIPELINE} AND status_id = ${DOCS_SENT_DC_STATUS}
      GROUP BY lead_id
    ),
    qual AS (
      SELECT
        DATE(lc.created_at) AS cohort_date,
        ds.docs_sent_at,
        EXTRACT(EPOCH FROM (ds.docs_sent_at - lc.created_at)) / 86400.0 AS lag
      FROM analytics.leads_cohort lc
      LEFT JOIN docs_sent ds ON ds.lead_id = lc.lead_id
      WHERE lc.pipeline_id = ${FIRST_LINE_PIPELINE}
        AND lc.created_at >= NOW() - INTERVAL '30 days'
        AND lc.created_at <= NOW()
        AND (lc.non_qual_enum_id IS NULL OR lc.non_qual_enum_id <> ALL(${NON_QUAL_EXCLUDED}))
    )
    SELECT
      cohort_date::text,
      ROUND(AVG(lag) FILTER (WHERE lag >= 0)::numeric, 1) AS avg_days,
      COUNT(*)::int AS qual_count,
      COUNT(*) FILTER (WHERE docs_sent_at IS NOT NULL)::int AS docs_count,
      ROUND((100.0 * COUNT(*) FILTER (WHERE docs_sent_at IS NOT NULL) / NULLIF(COUNT(*), 0))::numeric, 1) AS conv_pct
    FROM qual
    GROUP BY cohort_date
    ORDER BY cohort_date DESC
    LIMIT 8
  `;
  console.table(tz2Sample);

  console.log("\n=== TZ#2 non-qual reason breakdown — last 30 days, FIRST_LINE ===");
  const tz2Reasons = await sql`
    SELECT
      non_qual_enum_id,
      CASE non_qual_enum_id
        WHEN 744486 THEN 'Неправильный номер (исключён)'
        WHEN 744876 THEN 'Неквал лид (исключён)'
        WHEN 747530 THEN 'Неквал Образование (исключён)'
        WHEN 747532 THEN 'Неквал Возраст (исключён)'
        WHEN 747534 THEN 'Неквал Язык (НЕ исключён по ТЗ)'
        WHEN 747536 THEN 'Неквал Доход (исключён)'
        ELSE 'NULL/иное (квал)'
      END AS reason,
      COUNT(*)::int AS cnt
    FROM analytics.leads_cohort
    WHERE pipeline_id = ${FIRST_LINE_PIPELINE}
      AND created_at >= NOW() - INTERVAL '30 days'
    GROUP BY non_qual_enum_id
    ORDER BY cnt DESC
  `;
  console.table(tz2Reasons);

  console.log("\n=== TZ#2 overall conversion — last 30 days ===");
  const tz2Total = await sql`
    WITH docs_sent AS (
      SELECT DISTINCT lead_id
      FROM analytics.lead_status_changes
      WHERE pipeline_id = ${FIRST_LINE_PIPELINE} AND status_id = ${DOCS_SENT_DC_STATUS}
    )
    SELECT
      COUNT(*)::int AS qual_total,
      COUNT(*) FILTER (WHERE ds.lead_id IS NOT NULL)::int AS docs_total,
      ROUND((100.0 * COUNT(*) FILTER (WHERE ds.lead_id IS NOT NULL) / NULLIF(COUNT(*), 0))::numeric, 1) AS conv_pct
    FROM analytics.leads_cohort lc
    LEFT JOIN docs_sent ds ON ds.lead_id = lc.lead_id
    WHERE lc.pipeline_id = ${FIRST_LINE_PIPELINE}
      AND lc.created_at >= NOW() - INTERVAL '30 days'
      AND (lc.non_qual_enum_id IS NULL OR lc.non_qual_enum_id <> ALL(${NON_QUAL_EXCLUDED}))
  `;
  console.table(tz2Total);

  console.log("\n=== TZ#2 5 random qual leads with docs_sent — manual check ===");
  const tz2Sanity = await sql`
    WITH docs_sent AS (
      SELECT lead_id, MIN(event_at) AS docs_sent_at
      FROM analytics.lead_status_changes
      WHERE pipeline_id = ${FIRST_LINE_PIPELINE} AND status_id = ${DOCS_SENT_DC_STATUS}
      GROUP BY lead_id
    )
    SELECT
      lc.lead_id,
      lc.created_at::date::text AS created,
      ds.docs_sent_at::date::text AS docs_sent,
      lc.non_qual_enum_id,
      ROUND((EXTRACT(EPOCH FROM (ds.docs_sent_at - lc.created_at)) / 86400.0)::numeric, 1) AS lag_days
    FROM analytics.leads_cohort lc
    JOIN docs_sent ds ON ds.lead_id = lc.lead_id
    WHERE lc.pipeline_id = ${FIRST_LINE_PIPELINE}
      AND lc.created_at >= NOW() - INTERVAL '30 days'
      AND (lc.non_qual_enum_id IS NULL OR lc.non_qual_enum_id <> ALL(${NON_QUAL_EXCLUDED}))
    ORDER BY random()
    LIMIT 5
  `;
  console.table(tz2Sanity);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
