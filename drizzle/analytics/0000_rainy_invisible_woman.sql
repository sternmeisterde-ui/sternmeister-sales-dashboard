CREATE SCHEMA "analytics";
--> statement-breakpoint
CREATE TABLE "analytics"."ads_report" (
	"date" date,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"utm_content" text,
	"utm_term" text,
	"impressions" bigint,
	"clicks" bigint,
	"spend" double precision,
	"leads_count" bigint,
	"qual_leads_count" bigint,
	"payment_cnt" bigint,
	"payment_amount" double precision,
	"e_leads_cnt" bigint,
	"pipeline_leads_cnt" bigint,
	"pipeline_payment_cnt" bigint,
	"pipeline_payment_amount" double precision,
	"webinar_leads_cnt" bigint,
	"webinar_payment_cnt" bigint,
	"webinar_payment_amount" double precision,
	"users_cnt" bigint
);
--> statement-breakpoint
CREATE TABLE "analytics"."communications" (
	"communication_id" text,
	"communication_type" text,
	"entity_id" bigint,
	"created_at" timestamp,
	"lead_id" bigint,
	"pipeline_id" bigint,
	"pipeline_name" text,
	"category" text,
	"lead_created_at" timestamp,
	"lead_day_start" timestamp,
	"call_status" smallint,
	"duration" integer,
	"manager" text,
	"status_id" bigint,
	"status_name" text,
	"utm_source" text,
	"first_contact_flg" smallint,
	"last_contact_flg" smallint,
	"first_call_at" timestamp,
	"business_hours_sla" bigint,
	"business_hours_since_communication" double precision
);
--> statement-breakpoint
CREATE TABLE "analytics"."custom_report" (
	"metric_name" text,
	"metric_type" text,
	"dt" timestamp,
	"entity_id" text,
	"lead_id" bigint,
	"numeric_value" double precision,
	"manager" text,
	"current_manager" text,
	"category" text,
	"pipeline_id" bigint,
	"pipeline_name" text,
	"status_id" bigint,
	"status_name" text,
	"utm_source" text,
	"current_pipeline_name" text,
	"current_status_name" text
);
--> statement-breakpoint
CREATE TABLE "analytics"."funnel" (
	"metric_name" text,
	"dt_operational" timestamp,
	"dt_cohort" timestamp,
	"entity_id" text,
	"lead_id" bigint,
	"numeric_value" double precision,
	"manager" text,
	"pipeline_name" text,
	"status_name" text
);
--> statement-breakpoint
CREATE TABLE "analytics"."lead_status_changes" (
	"amo_domain" text,
	"lead_id" bigint,
	"pipeline_id" bigint,
	"pipeline" text,
	"status_id" bigint,
	"status" text,
	"sort" integer,
	"event_at" timestamp,
	"lead_created_at" timestamp,
	"last_event_at" timestamp,
	"next_status_id" bigint,
	"next_event_at" timestamp,
	"manager" text
);
--> statement-breakpoint
CREATE TABLE "analytics"."leads_cohort" (
	"lead_id" bigint,
	"created_at" timestamp,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"utm_content" text,
	"utm_term" text,
	"loss_reason" text,
	"pipeline" text,
	"status" text,
	"status_order" integer,
	"budget" double precision,
	"contact_date" timestamp,
	"manager" text,
	"category" text
);
--> statement-breakpoint
CREATE TABLE "analytics"."sales_report" (
	"date" date,
	"manager" text,
	"create_cnt" bigint,
	"payment_cnt" bigint,
	"payment_sum" double precision,
	"sales_plan" bigint,
	"calls_cnt" bigint,
	"total_duration" bigint,
	"success_calls" bigint,
	"outgoing_calls" bigint,
	"business_hours_sla" bigint,
	"business_hours_sla_cnt" bigint,
	"quality" double precision
);
--> statement-breakpoint
CREATE TABLE "analytics"."sla" (
	"lead_id" bigint,
	"lead_created_at" timestamp,
	"pipeline_id" bigint,
	"pipeline_name" text,
	"status_id" bigint,
	"status_name" text,
	"utm_source" text,
	"category" text,
	"manager" text,
	"loss_reason_name" text,
	"sla_start" timestamp,
	"first_contact_at" timestamp,
	"last_contact_at" timestamp,
	"first_call_out_at" timestamp,
	"first_message_at" timestamp,
	"is_waiting" smallint,
	"is_waiting_call" smallint,
	"sla_first_contact_seconds" bigint,
	"sla_first_call_seconds" bigint,
	"sla_first_call_calendar_seconds" bigint,
	"business_hours_since_last_contact" bigint,
	"sla_status" text
);
--> statement-breakpoint
CREATE TABLE "analytics"."tasks" (
	"lead_created_at" timestamp,
	"lead_id" bigint,
	"closed_flg" smallint,
	"lead_manager" text,
	"task_id" bigint,
	"task_created_at" timestamp,
	"completed_at" timestamp,
	"is_completed" smallint,
	"deadline" timestamp,
	"task_manager" text
);
--> statement-breakpoint
CREATE INDEX "ads_report_date_index" ON "analytics"."ads_report" USING btree ("date");--> statement-breakpoint
CREATE INDEX "ads_report_utm_source_date_index" ON "analytics"."ads_report" USING btree ("utm_source","date");--> statement-breakpoint
CREATE INDEX "communications_lead_id_index" ON "analytics"."communications" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "communications_created_at_index" ON "analytics"."communications" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "communications_manager_created_at_index" ON "analytics"."communications" USING btree ("manager","created_at");--> statement-breakpoint
CREATE INDEX "communications_communication_type_index" ON "analytics"."communications" USING btree ("communication_type");--> statement-breakpoint
CREATE INDEX "custom_report_metric_name_dt_index" ON "analytics"."custom_report" USING btree ("metric_name","dt");--> statement-breakpoint
CREATE INDEX "custom_report_metric_type_dt_index" ON "analytics"."custom_report" USING btree ("metric_type","dt");--> statement-breakpoint
CREATE INDEX "custom_report_manager_dt_index" ON "analytics"."custom_report" USING btree ("manager","dt");--> statement-breakpoint
CREATE INDEX "custom_report_lead_id_index" ON "analytics"."custom_report" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "funnel_metric_name_dt_operational_index" ON "analytics"."funnel" USING btree ("metric_name","dt_operational");--> statement-breakpoint
CREATE INDEX "funnel_metric_name_dt_cohort_index" ON "analytics"."funnel" USING btree ("metric_name","dt_cohort");--> statement-breakpoint
CREATE INDEX "funnel_lead_id_index" ON "analytics"."funnel" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "funnel_pipeline_name_status_name_index" ON "analytics"."funnel" USING btree ("pipeline_name","status_name");--> statement-breakpoint
CREATE INDEX "lead_status_changes_lead_id_event_at_index" ON "analytics"."lead_status_changes" USING btree ("lead_id","event_at");--> statement-breakpoint
CREATE INDEX "lead_status_changes_pipeline_id_status_id_index" ON "analytics"."lead_status_changes" USING btree ("pipeline_id","status_id");--> statement-breakpoint
CREATE INDEX "lead_status_changes_event_at_index" ON "analytics"."lead_status_changes" USING btree ("event_at");--> statement-breakpoint
CREATE INDEX "leads_cohort_lead_id_index" ON "analytics"."leads_cohort" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "leads_cohort_created_at_index" ON "analytics"."leads_cohort" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "leads_cohort_pipeline_status_index" ON "analytics"."leads_cohort" USING btree ("pipeline","status");--> statement-breakpoint
CREATE INDEX "sales_report_date_manager_index" ON "analytics"."sales_report" USING btree ("date","manager");--> statement-breakpoint
CREATE INDEX "sla_lead_id_index" ON "analytics"."sla" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "sla_lead_created_at_index" ON "analytics"."sla" USING btree ("lead_created_at");--> statement-breakpoint
CREATE INDEX "sla_sla_status_index" ON "analytics"."sla" USING btree ("sla_status");--> statement-breakpoint
CREATE INDEX "tasks_task_id_index" ON "analytics"."tasks" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "tasks_lead_id_index" ON "analytics"."tasks" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "tasks_deadline_index" ON "analytics"."tasks" USING btree ("deadline");--> statement-breakpoint
CREATE INDEX "tasks_is_completed_deadline_index" ON "analytics"."tasks" USING btree ("is_completed","deadline");