-- Drop never-materialised mirror tables of the 3rd-party integrator's MySQL.
--
-- analytics.ads_report / sales_report / custom_report / funnel were created in
-- migration 0000 as a planned mirror of the integrator's reporting tables
-- (report_sternmeister_*) to reproduce Looker dashboards locally. That plan was
-- abandoned — dashboards are computed from the primary tables (leads_cohort /
-- communications / sla). The app's ETL never wrote these tables, no code reads
-- them, and they were confirmed empty (0 rows) on 2026-06-07 before dropping.
--
-- NOTE: analytics.funnel is unrelated to the Воронка feature, which uses
-- leads_cohort + funnel_target_levels.

DROP TABLE IF EXISTS "analytics"."ads_report";
DROP TABLE IF EXISTS "analytics"."sales_report";
DROP TABLE IF EXISTS "analytics"."custom_report";
DROP TABLE IF EXISTS "analytics"."funnel";
