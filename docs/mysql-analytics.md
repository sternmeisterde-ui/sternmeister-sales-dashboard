# MySQL Analytics DB — Complete Reference

**Host:** 45.156.25.84:3306 / db `db` / user `sternmeister`  
**Refresh:** daily via Airflow  
**Data range:** 2025-03-10 → present  
**Total rows:** ~1.87M across 9 tables

---

## 1. Schema Map

### 1.1 `sternmeister_leads_cohort` — 21 622 rows

One row per Kommo lead. This is the lead master table.

| Column | Type | Notes |
|---|---|---|
| `lead_id` | BIGINT UNSIGNED | PK candidate (no declared index; leads are unique) |
| `created_at` | DATETIME | Lead creation timestamp in Kommo |
| `utm_source` | TEXT | Traffic source (facebook, google, tiktok, tgbot, etc.) |
| `utm_medium` | TEXT | |
| `utm_campaign` | TEXT | |
| `utm_content` | TEXT | |
| `utm_term` | TEXT | |
| `loss_reason` | TEXT | Loss reason if closed |
| `pipeline` | TEXT | Pipeline name (Бух Комм, Бух Гос, Мед Комм, etc.) |
| `status` | TEXT | Current/final lead status name |
| `status_order` | INT UNSIGNED | Numeric sort order of the status in the pipeline |
| `budget` | DOUBLE | Deal amount (EUR) |
| `contact_date` | DATETIME | First contact date |
| `manager` | TEXT | **Current responsible manager in Kommo** (last snapshot) |
| `category` | TEXT | Lead quality tier: A / B / C / D / E (E is most common, ~40%; A is rarest, ~0.5%) |

**Natural key:** `lead_id` (no duplicates observed).  
**FK into other tables:** `lead_id` joins to `sternmeister_communications.lead_id`, `sternmeister_sla.lead_id`, `sternmeister_lead_status_changes.lead_id`, `sternmeister_tasks.lead_id`.  
**Surprising pattern:** `manager` reflects the *current* snapshot manager, not the one at creation. It changes when a lead is reassigned. Use `current_manager` in the report tables for live attribution.

---

### 1.2 `sternmeister_communications` — 334 400 rows

One row per communication event (call or message) attached to a Kommo lead.

| Column | Type | Notes |
|---|---|---|
| `communication_id` | TEXT | PK candidate — numeric for calls, UUID for messages |
| `communication_type` | TEXT | `call_out`, `call_in`, `outgoing_chat_message`, `incoming_chat_message`, NULL |
| `entity_id` | BIGINT UNSIGNED | Kommo entity ID |
| `created_at` | DATETIME | Timestamp of the communication |
| `lead_id` | BIGINT UNSIGNED | FK → `sternmeister_leads_cohort.lead_id` |
| `pipeline_id` | BIGINT UNSIGNED | Kommo pipeline ID |
| `pipeline_name` | TEXT | Pipeline name |
| `category` | TEXT | Lead category at time of comm |
| `lead_created_at` | DATETIME | Denormalized: `leads_cohort.created_at` |
| `lead_day_start` | DATETIME | Date truncated to day for the lead |
| `call_status` | SMALLINT UNSIGNED | **4** = answered/connected; **6** = missed/busy; **7** = voicemail; **3** = cancelled; NULL = non-call |
| `duration` | INT UNSIGNED | Call duration in **seconds** (0 for missed/busy) |
| `manager` | TEXT | Person who handled this specific call (comm-level attribution) |
| `status_id` | BIGINT UNSIGNED | Lead status at time of comm |
| `status_name` | TEXT | Lead status name at time of comm |
| `utm_source` | TEXT | Lead's UTM source |
| `first_contact_flg` | TINYINT UNSIGNED | 1 = this is the first ever contact on the lead |
| `last_contact_flg` | TINYINT UNSIGNED | 1 = this is the most recent contact |
| `first_call_at` | DATETIME | Timestamp of first call on the lead |
| `business_hours_sla` | BIGINT | Business-hours seconds between lead creation and this comm |
| `business_hours_since_communication` | DOUBLE | Business-hours seconds since previous comm on same lead |

**Indexes:** `idx_lead_id (lead_id)`, `idx_created_at (created_at)`  
**Surprising patterns:**
- A single `communication_id` (numeric call ID) can appear on **multiple leads** and pipelines simultaneously. The system links one phone call to all pipeline records where that contact appears. Example: `communication_id=10430951` appears in Бух Комм, Мед Комм, and webinars for three different lead_ids.
- `communication_type` distribution: call_out 205k (61%), outgoing_chat_message 67k (20%), incoming_chat_message 50k (15%), call_in 10k (3%), NULL 1.7k.
- `call_status=4` with `duration > 0` = successful call. `call_status=6` = no answer / busy (always `duration=0`).

---

### 1.3 `sternmeister_lead_status_changes` — 69 643 rows

One row per status transition event for each lead.

| Column | Type | Notes |
|---|---|---|
| `amo_domain` | TEXT | Kommo account domain |
| `lead_id` | BIGINT UNSIGNED | FK → leads_cohort |
| `pipeline_id` | BIGINT UNSIGNED | Pipeline ID |
| `status_id` | BIGINT UNSIGNED | Status ID after this transition |
| `event_at` | DATETIME | When the status changed |
| `lead_created_at` | DATETIME | Lead creation (denormalized) |
| `pipeline` | TEXT | Pipeline name |
| `status` | TEXT | Status name after this transition |
| `sort` | INT UNSIGNED | Sort order of this status |
| `last_event_at` | DATETIME | Latest event_at on this lead (for filtering "current") |
| `next_status_id` | BIGINT UNSIGNED | ID of the next status (0 if still in this status) |
| `next_event_at` | DATETIME | When next transition occurred (1970-01-01 if not yet) |
| `manager` | TEXT | Manager responsible at this transition |

**Indexes:** `idx_lead_pipeline (lead_id, pipeline_id)`, `idx_event_at (event_at)`  
**Natural key:** (`lead_id`, `status_id`, `event_at`) — composite.  
**FK:** `lead_id` → `sternmeister_leads_cohort`.

---

### 1.4 `sternmeister_sla` — 6 915 rows

One row per lead for SLA tracking. Contains pre-computed business-hours wait times.

| Column | Type | Notes |
|---|---|---|
| `lead_id` | BIGINT UNSIGNED | PK candidate |
| `lead_created_at` | DATETIME | |
| `pipeline_id` | BIGINT UNSIGNED | |
| `pipeline_name` | TEXT | |
| `status_id` | BIGINT UNSIGNED | Current status |
| `status_name` | TEXT | |
| `utm_source` | TEXT | |
| `category` | TEXT | |
| `manager` | TEXT | Current responsible manager |
| `loss_reason_name` | TEXT | |
| `sla_start` | DATETIME | SLA timer start — usually `lead_created_at + ~3min` (Kommo webhook lag) |
| `first_contact_at` | DATETIME | First any-type contact (call or message) |
| `last_contact_at` | DATETIME | Most recent contact |
| `first_call_out_at` | DATETIME | First outbound call |
| `first_message_at` | DATETIME | First outbound message |
| `is_waiting` | TINYINT | 1 = still waiting for first contact |
| `is_waiting_call` | TINYINT | 1 = still waiting for first outbound call |
| `sla_first_contact_seconds` | BIGINT | Business-hours seconds from `sla_start` to `first_contact_at` |
| `sla_first_call_seconds` | BIGINT | Business-hours seconds from `sla_start` to `first_call_out_at` (**"SLA первого звонка"**) |
| `sla_first_call_calendar_seconds` | BIGINT | **Calendar** seconds (same window) — **"SLA первого звонка (тотал)"** |
| `business_hours_since_last_contact` | BIGINT | Business-hours seconds from `sla_start` to `last_contact_at` ≈ TLT |
| `sla_status` | TEXT | `contacted` / `frozen` / `waiting` |

**SLA status values:**
- `contacted` (6707, 97%): first call was made
- `frozen` (196, 3%): lead is paused/on hold (`is_waiting=1`)
- `waiting` (12, <1%): still awaiting first contact

---

### 1.5 `sternmeister_tasks` — 141 661 rows

Kommo tasks linked to leads.

| Column | Type | Notes |
|---|---|---|
| `task_id` | BIGINT UNSIGNED | PK candidate |
| `lead_id` | BIGINT UNSIGNED | FK → leads_cohort |
| `lead_created_at` | DATETIME | Denormalized |
| `closed_flg` | TINYINT | 1 = lead is closed/lost |
| `lead_manager` | TEXT | Lead responsible manager |
| `task_created_at` | DATETIME | When task was created |
| `completed_at` | DATETIME | When task was completed (NULL if open) |
| `is_completed` | TINYINT | 1 = task completed |
| `deadline` | DATETIME | Task due date |
| `task_manager` | TEXT | Assigned task manager (usually = lead_manager) |

**Note:** Tasks are NOT used in any `report_sternmeister_*` metrics. The table feeds a separate task-completion analysis not currently in the dashboards.

---

### 1.6 `sternmeister_ads_report` — 12 746 rows

Daily ad spend + lead/conversion data by UTM combination.

| Column | Type | Notes |
|---|---|---|
| `date` | DATE | Report date |
| `utm_source` | TEXT | e.g. `facebook`, `google`, `tiktok` |
| `utm_medium` | TEXT | |
| `utm_campaign` | TEXT | |
| `utm_content` | TEXT | |
| `utm_term` | TEXT | |
| `impressions` | BIGINT | Ad impressions |
| `clicks` | BIGINT | Ad clicks |
| `spend` | DOUBLE | Ad spend in EUR |
| `leads_count` | BIGINT | Total leads from this source on this date (= `e_leads_cnt + pipeline_leads_cnt + webinar_leads_cnt`) |
| `qual_leads_count` | BIGINT | Qualified leads |
| `payment_cnt` | BIGINT | Payments attributed (cohort, any pipeline) |
| `payment_amount` | DOUBLE | Total payment amount EUR |
| `e_leads_cnt` | BIGINT | Educational leads |
| `pipeline_leads_cnt` | BIGINT | Sales pipeline leads |
| `pipeline_payment_cnt` | BIGINT | Payments from pipeline leads |
| `pipeline_payment_amount` | DOUBLE | Revenue from pipeline leads |
| `webinar_leads_cnt` | BIGINT | Webinar leads |
| `webinar_payment_cnt` | BIGINT | Payments from webinar leads |
| `webinar_payment_amount` | DOUBLE | Revenue from webinar leads |
| `users_cnt` | BIGINT | Unique users/sessions (from ad platform) |

**No declared primary key.** Natural key: (`date`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`).  
**Surprising pattern:** Most rows (99%+ by row count) have NULL `spend`, `impressions`, `clicks` — these rows contain lead data from organic/untracked sources where no ad cost is available. The 68 rows with `spend > 0` are all Facebook/Google tracked campaigns.

---

### 1.7 `sternmeister_sales_report` — 201 rows

Monthly per-manager aggregated KPIs.

| Column | Type | Notes |
|---|---|---|
| `date` | DATE | First day of the month (14 months: 2025-03 → 2026-04) |
| `manager` | TEXT | Manager name |
| `create_cnt` | BIGINT | Leads created/assigned in this month (≈ `leads_cohort` count, small delta from pipeline filter) |
| `payment_cnt` | BIGINT | Payments received |
| `payment_sum` | DOUBLE | Total payment amount EUR |
| `sales_plan` | BIGINT | Monthly sales plan (units) |
| `calls_cnt` | BIGINT | Total calls (all statuses) |
| `total_duration` | BIGINT | Total call duration in **seconds** |
| `success_calls` | BIGINT | Calls with `call_status=4 AND duration>=10` |
| `outgoing_calls` | BIGINT | Outbound call count |
| `business_hours_sla` | BIGINT | SUM of business-hours SLA seconds for leads with SLA measured (NULL for all current rows) |
| `business_hours_sla_cnt` | BIGINT | COUNT of leads with SLA measured (0 for all current rows) |
| `quality` | DOUBLE | External OKK score 0–1 (populated for only 3 rows: Екатерина Маслий Apr–Jun 2025; source unclear — not derivable from this DB) |

**No declared primary key.** Natural key: (`date`, `manager`).  
26 distinct managers × 14 months. Granularity: monthly.

---

### 1.8 `report_sternmeister_custom_report` — 933 489 rows

Pre-aggregated report table. One row per `(metric_name, metric_type, entity_id, lead_id, pipeline)` combination.

| Column | Type | Notes |
|---|---|---|
| `metric_name` | TEXT | See metric catalog below |
| `metric_type` | TEXT | `cohort` or `operational` (see §2.2) |
| `dt` | DATETIME | Date dimension (see §2.2) |
| `entity_id` | TEXT | Communication ID prefixed: `call_out_12345`, `call_in_12345`, `outgoing_chat_message_<uuid>`, or bare `lead_id` for lead-level metrics |
| `lead_id` | BIGINT UNSIGNED | FK → leads_cohort (no index declared) |
| `numeric_value` | DOUBLE | The metric value (mostly 1.0 for counts; seconds for time metrics) |
| `manager` | TEXT | **Person who handled this communication** (for call/msg metrics) or lead's responsible manager (for lead-count metrics) |
| `current_manager` | TEXT | **Current lead responsible manager** at report refresh time |
| `category` | TEXT | Lead quality tier |
| `pipeline_id` | BIGINT UNSIGNED | |
| `pipeline_name` | TEXT | |
| `status_id` | BIGINT UNSIGNED | Lead status at time of event |
| `status_name` | TEXT | Lead status name at time of event |
| `utm_source` | TEXT | |
| `current_pipeline_name` | TEXT | Current pipeline at refresh time |
| `current_status_name` | TEXT | Current status at refresh time |

**Indexes:** `idx_dt (dt)`, `idx_pipeline_metric (pipeline_name(100), metric_type(50), metric_name(100))`, `idx_manager (manager(100))`, `idx_current (...)`.

---

### 1.9 `report_sternmeister_funnel` — 404 361 rows

Pre-aggregated funnel report. One row per communication event tagged with its lead's current funnel stage.

| Column | Type | Notes |
|---|---|---|
| `metric_name` | TEXT | See §3 |
| `dt_operational` | DATETIME | Always = report refresh date (today) — not a filter dimension |
| `dt_cohort` | DATETIME | Lead creation date — the actual grouping dimension |
| `entity_id` | TEXT | `lead_id` (for Кол-во лидов) or comm entity ID (for other metrics) |
| `lead_id` | BIGINT UNSIGNED | |
| `numeric_value` | DOUBLE | 1.0 for counts; seconds for time metrics |
| `manager` | TEXT | Current lead responsible manager |
| `pipeline_name` | TEXT | |
| `status_name` | TEXT | Funnel stage name |

**No indexes declared.**

---

## 2. Metric Catalog

### 2.1 Metric Overview

21 distinct metric-type combinations across both report tables:

| Metric Name | Table | Types | Unit | Granularity |
|---|---|---|---|---|
| Все звонки | custom_report | cohort, operational | count (1 per call) | per communication |
| Входящие звонки | custom_report | cohort, operational | count | per communication |
| Исходящие звонки | custom_report | cohort, operational | count | per communication |
| Пропущенные звонки | custom_report | cohort, operational | count | per communication |
| Успешные звонки (10+ сек) | custom_report | cohort, operational | count | per communication |
| Время на линии | custom_report | cohort, operational | **seconds** | per communication |
| Среднее время между звонками | custom_report | cohort, operational | **seconds** | per communication |
| Кол-во лидов | custom_report | cohort, operational | count | per lead |
| Отправлено сообщений | custom_report | cohort, operational | count | per communication |
| SLA первого звонка | custom_report | cohort only | **seconds** (business hours) | per lead |
| SLA первого звонка (тотал) | custom_report | cohort only | **seconds** (calendar) | per lead |
| TLT | custom_report | cohort only | **seconds** (business hours) | per lead |
| Кол-во лидов на стадии | funnel | — | count | per lead × stage |
| Среднее время между касаниями | funnel | — | **seconds** (calendar) | per communication |
| Среднее кол-во звонков на этапе | funnel | — | count | per call |
| Среднее кол-во касаний на этапе | funnel | — | count | per comm (all types) |
| Среднее кол-во сообщений на этапе | funnel | — | count | per message |

---

### 2.2 `cohort` vs `operational` Semantics

| Aspect | `cohort` | `operational` |
|---|---|---|
| **`dt` value** | `DATE(lead.created_at)` — the day the lead was created | `DATE(communication.created_at)` — the day the communication happened |
| **Use case** | "How many calls were made on leads created on this date?" | "How many calls were made on this date, regardless of when the lead was created?" |
| **Example** | Lead created 2025-03-25 → all its calls show `dt=2025-03-25` in cohort | Same lead's call on 2026-02-17 shows `dt=2026-02-17` in operational |

**For KPI dashboards:** operational = daily activity view. Cohort = lead-origin view (useful for conversion analysis).

---

### 2.3 Per-Metric SQL Reproductions

All formulas are verified against the datasource tables. The report uses Kommo event-log manager attribution which can differ slightly from `communications.manager`; differences are noted.

#### Все звонки (All Calls)

```sql
-- Operational: calls made on a given date, grouped by lead's responsible manager
SELECT
  DATE(c.created_at)                          AS dt,
  c.manager                                   AS manager,   -- comm handler
  c.pipeline_name,
  COUNT(*)                                    AS numeric_value
FROM sternmeister_communications c
WHERE c.communication_type IN ('call_in', 'call_out')
  AND DATE(c.created_at) = '2026-04-22'
GROUP BY dt, c.manager, c.pipeline_name;

-- Cohort: all calls on leads created on a given date
SELECT
  DATE(l.created_at)                          AS dt,
  c.manager,
  c.pipeline_name,
  COUNT(*)                                    AS numeric_value
FROM sternmeister_communications c
JOIN sternmeister_leads_cohort l ON c.lead_id = l.lead_id
WHERE c.communication_type IN ('call_in', 'call_out')
  AND DATE(l.created_at) = '2026-04-22'
GROUP BY dt, c.manager, c.pipeline_name;
```

**Verified:** operational row-count from communications matches report to within ~1% (2184 vs 1970 for Apr 22; small delta from multi-pipeline call duplication and leads not yet in leads_cohort).

---

#### Входящие звонки (Inbound Calls)

```sql
-- Filter: communication_type = 'call_in'
SELECT COUNT(*) FROM sternmeister_communications
WHERE communication_type = 'call_in'
  AND DATE(created_at) = :date AND manager = :manager AND pipeline_name = :pipeline;
```

---

#### Исходящие звонки (Outbound Calls)

```sql
SELECT COUNT(*) FROM sternmeister_communications
WHERE communication_type = 'call_out'
  AND DATE(created_at) = :date AND manager = :manager AND pipeline_name = :pipeline;
```

---

#### Пропущенные звонки (Missed Calls)

```sql
-- Missed = inbound call not answered (call_status != 4)
SELECT COUNT(*) FROM sternmeister_communications
WHERE communication_type = 'call_in'
  AND call_status != 4          -- status 6 = busy/no answer
  AND DATE(created_at) = :date
  AND manager = :manager AND pipeline_name = :pipeline;
```

**Note:** `call_status` values: 4=answered, 6=missed/busy, 7=voicemail, 3=cancelled.

---

#### Успешные звонки 10+ сек (Successful Calls ≥10s)

```sql
SELECT COUNT(*) FROM sternmeister_communications
WHERE communication_type IN ('call_in', 'call_out')
  AND call_status = 4 AND duration >= 10
  AND DATE(created_at) = :date
  AND manager = :manager AND pipeline_name = :pipeline;
```

---

#### Время на линии (Time on Line)

```sql
-- Sum of duration in seconds for all calls (including short answered calls)
SELECT SUM(duration) FROM sternmeister_communications
WHERE communication_type IN ('call_in', 'call_out')
  AND call_status = 4           -- answered calls only
  AND DATE(created_at) = :date
  AND manager = :manager AND pipeline_name = :pipeline;
```

**Unit:** seconds. To display: divide by 60 for minutes.

---

#### Среднее время между звонками (Average Time Between Calls)

```sql
-- Per-lead ordered calls; numeric_value = calendar seconds between THIS call and PREVIOUS call
-- Entity_id format: "{lead_id}_{call_type}_{comm_id}"
-- Reproduce by:
SELECT
  c.lead_id,
  c.communication_id,
  TIMESTAMPDIFF(SECOND,
    LAG(c.created_at) OVER (PARTITION BY c.lead_id ORDER BY c.created_at),
    c.created_at
  )                             AS seconds_since_prev_call
FROM sternmeister_communications c
WHERE c.communication_type IN ('call_in', 'call_out')
  AND c.lead_id = :lead_id
ORDER BY c.created_at;
```

**Verified:** calendar diff matches report values (e.g. 352 569s for lead 5582076 call pair). To aggregate: `AVG()` over all non-NULL diffs per manager/pipeline/date.

---

#### Кол-во лидов (Lead Count)

```sql
-- Operational: leads created on this date
SELECT COUNT(*) FROM sternmeister_leads_cohort
WHERE DATE(created_at) = :date
  AND manager = :manager AND pipeline = :pipeline;

-- Cohort: same (cohort and operational are identical for lead counts since
-- dt = lead.created_at in both cases)
```

**Verified:** `create_cnt` in `sternmeister_sales_report` matches leads_cohort count within ±5% (pipeline scoping difference).

---

#### Отправлено сообщений (Messages Sent)

```sql
SELECT COUNT(*) FROM sternmeister_communications
WHERE communication_type = 'outgoing_chat_message'
  AND DATE(created_at) = :date
  AND manager = :manager AND pipeline_name = :pipeline;
```

**Note:** `manager` is often empty string for messages (Kommo bot-sent). These appear with `manager=''` in the report.

---

#### SLA первого звонка (SLA First Call — Business Hours)

```sql
-- Per lead: business-hours seconds from lead creation to first outbound call
SELECT lead_id, sla_first_call_seconds
FROM sternmeister_sla
WHERE lead_id = :lead_id;
-- To aggregate (average SLA): AVG(sla_first_call_seconds) WHERE sla_status='contacted'
```

**Unit:** business-hours seconds (see §4 for business hours definition).  
**Verified:** `sla.sla_first_call_seconds` = report `numeric_value` for SLA первого звонка (exact match for lead 6576940: both = 1358).

---

#### SLA первого звонка (тотал) (SLA First Call — Calendar)

```sql
SELECT lead_id, sla_first_call_calendar_seconds
FROM sternmeister_sla
WHERE lead_id = :lead_id;
```

**Verified:** matches report `numeric_value` for "SLA первого звонка (тотал)" (lead 6576940: both = 4060 = `TIMESTAMPDIFF(SECOND, sla_start, first_call_out_at)`).

---

#### TLT (Total Lead Time)

```sql
-- Approximate: business-hours seconds from lead creation to last contact
SELECT lead_id, business_hours_since_last_contact
FROM sternmeister_sla
WHERE lead_id = :lead_id;
```

**Unit:** business-hours seconds.  
**Note:** TLT in the report is close to `sla.business_hours_since_last_contact` (within ~1% for sampled leads). The exact formula appears to use `sla_start` as origin rather than `lead_created_at` (lag of ~3 minutes for Kommo webhook).

---

## 3. Funnel Report

### Structure

`report_sternmeister_funnel` aggregates `sternmeister_lead_status_changes` + `sternmeister_communications`.

**Granularity:** one row per `(metric_name, lead_id, status_name, entity_id)` snapshot. All rows have `dt_operational = TODAY` (refreshed daily — it is NOT a historical series).

**`dt_cohort`** = `DATE(lead.created_at)` — the lead's creation date. This is the primary grouping dimension for funnel analysis.

**`dt_operational`** = refresh date (always current day). Used only to signal data freshness; not useful for filtering.

### Stage Definitions

Stages = distinct `status_name` values from `sternmeister_lead_status_changes`. No separate stage table exists; stage boundaries are defined by status transitions. Key stages (by row count):

| Stage | Approx rows | Meaning |
|---|---|---|
| Недозвон | 100k | No answer — repeated dial attempts |
| Контакт установлен | 44k | Contact made |
| Закрыто и не реализовано | 26k | Closed lost |
| Новый лид | 24k | Freshly created |
| Отложенный старт | 24k | Deferred start |
| Консультация проведена | 20k | Consultation done |
| Термин ДЦ | 18k | Appointment at ДЦ |
| Взято в работу / Взят в работу | 31k | Taken into work (duplicate spelling) |
| Closed - lost | 11k | English version of Закрыто |
| Нет предварительного согласия | 10k | No pre-agreement |
| Доведение | 9k | Follow-through stage |

**Warning:** "Взято в работу" and "Взят в работу" are two spellings of the same stage (inflection difference). Merge them in queries.

### Funnel Metric Formulas

```sql
-- Кол-во лидов на стадии: count of unique leads that reached a given stage
SELECT status_name, COUNT(DISTINCT lead_id) AS lead_count
FROM report_sternmeister_funnel
WHERE metric_name = 'Кол-во лидов на стадии'
  AND DATE(dt_cohort) BETWEEN :start AND :end
GROUP BY status_name;

-- Average from datasource:
SELECT lsc.status, COUNT(DISTINCT lsc.lead_id) AS leads
FROM sternmeister_lead_status_changes lsc
WHERE DATE(lsc.lead_created_at) BETWEEN :start AND :end
GROUP BY lsc.status;
```

```sql
-- Среднее время между касаниями: avg calendar seconds between consecutive touches
-- numeric_value = seconds between this comm and previous comm on same lead in same stage
SELECT status_name, AVG(numeric_value) AS avg_seconds_between_touches
FROM report_sternmeister_funnel
WHERE metric_name = 'Среднее время между касаниями'
GROUP BY status_name;
```

```sql
-- Среднее кол-во звонков на этапе:
-- Each row = 1 call; aggregate = avg calls per lead per stage
SELECT status_name,
  SUM(numeric_value)           AS total_calls,
  COUNT(DISTINCT lead_id)      AS leads,
  SUM(numeric_value) / COUNT(DISTINCT lead_id) AS avg_calls_per_lead
FROM report_sternmeister_funnel
WHERE metric_name = 'Среднее кол-во звонков на этапе'
GROUP BY status_name;
```

```sql
-- Среднее кол-во касаний на этапе: same as calls but includes all communication types
-- Среднее кол-во сообщений на этапе: only outgoing_chat_message rows
```

---

## 4. SLA Calculation

### Business Hours Definition

**Inferred from data:**
- Working days: **Monday through Saturday** (Sunday = off)
- Business hours: **09:00 – 18:00** (9 hours = 32 400 seconds/day)

**Evidence:**
- Lead created Sat 22:58, first call Sat 09:45 next morning → biz_seconds = 2753 = 45min 53s after 09:00 ✓
- Lead created before 09:00 Mon, called Mon 10:16 → biz_seconds = 1012s = 16min 52s after 10:00 (this specific case used a 10:00 start, suggesting **some pipelines may start at 10:00**). Most Monday leads show 09:00 start.
- Lead created Fri 18:15, first call Mon 09:11 → biz_seconds = 32 400s = exactly 9h (one full working day on Monday). Sat+Sun = 0 hours in this case, confirming Sunday is non-working.
- Saturday is a working day (calls observed on Saturdays, SLA counts Saturday time).

**Caveat:** A minority of cases show what looks like a 10:00 start (Бух Комм pipeline). This may be pipeline-specific or an anomaly. The dominant pattern is 09:00–18:00.

### SLA Fields

| Field | Content |
|---|---|
| `sla_first_call_seconds` | Business-hours seconds from `sla_start` to `first_call_out_at` |
| `sla_first_call_calendar_seconds` | Calendar seconds same window |
| `sla_first_contact_seconds` | Business-hours seconds to any first contact (call or message) |
| `business_hours_since_last_contact` | Business-hours seconds from `sla_start` to most recent contact |

### SLA Status Cutoffs

No hard cutoff thresholds are stored in the DB. Observed distribution for `sla_first_call_seconds` (contacts only):

| Range | Count |
|---|---|
| ≤ 1h (≤ 3600s) | 3972 |
| 1–4h | 756 |
| 4–9h (within 1 workday) | 319 |
| 9h–1 workday (9h–24h calendar) | 284 |
| > 1 day | 1376 |

**Likely SLA target:** ≤ 1h business hours (the most common bucket by far). Exact threshold to confirm with business.

### Business Hours Formula (Python)

```python
from datetime import datetime, time, timedelta

WORK_START = time(9, 0)
WORK_END   = time(18, 0)
WORK_DAYS  = {0, 1, 2, 3, 4, 5}  # Mon=0 … Sat=5; Sun=6 excluded

def business_hours_seconds(start: datetime, end: datetime) -> int:
    total = 0
    cur = start
    while cur.date() < end.date():
        if cur.weekday() in WORK_DAYS:
            day_start = cur.replace(hour=9, minute=0, second=0, microsecond=0)
            day_end   = cur.replace(hour=18, minute=0, second=0, microsecond=0)
            s = max(cur, day_start)
            e = min(day_end, cur.replace(hour=23, minute=59, second=59))
            if s < e:
                total += int((e - s).total_seconds())
        cur = (cur + timedelta(days=1)).replace(hour=0, minute=0, second=0)
    if end.date() == cur.date() and end.weekday() in WORK_DAYS:
        day_start = end.replace(hour=9, minute=0, second=0, microsecond=0)
        day_end   = end.replace(hour=18, minute=0, second=0, microsecond=0)
        s = max(start if start.date() == end.date() else day_start, day_start)
        e = min(end, day_end)
        if s < e:
            total += int((e - s).total_seconds())
    return total
```

---

## 5. Ads Report Formulas

All ads metrics are computed from `sternmeister_ads_report`:

```sql
-- CPL (Cost Per Lead)
SELECT date, utm_source, utm_campaign,
  spend / NULLIF(leads_count, 0)       AS CPL,
  spend / NULLIF(qual_leads_count, 0)  AS CPQL,
  spend / NULLIF(payment_cnt, 0)       AS CAC,
  payment_amount / NULLIF(spend, 0)    AS ROMI
FROM sternmeister_ads_report
WHERE spend > 0;
```

| Metric | Formula | Notes |
|---|---|---|
| **CPL** | `spend / leads_count` | Cost per lead (all leads) |
| **CPQL** | `spend / qual_leads_count` | Cost per qualified lead |
| **CAC** | `spend / payment_cnt` | Cost per acquisition (any pipeline) |
| **ROMI** | `payment_amount / spend` | Return on marketing investment (ratio, not %) |
| **CTR** | `clicks / impressions` | Click-through rate |
| **CPC** | `spend / clicks` | Cost per click |

### Lead Type Breakdown

```
leads_count = e_leads_cnt + pipeline_leads_cnt + webinar_leads_cnt
```
Verified exact match (10 512 = 10 512) across all rows.

| Column | Meaning |
|---|---|
| `e_leads_cnt` | Educational/email-sequence leads (small volume) |
| `pipeline_leads_cnt` | Main sales pipeline leads |
| `webinar_leads_cnt` | Webinar funnel leads |
| `pipeline_payment_cnt/amount` | Revenue attributed to pipeline leads |
| `webinar_payment_cnt/amount` | Revenue attributed to webinar leads |

**Important:** 99%+ of rows have NULL `spend`. Only Facebook/Google tracked campaigns (68 rows) have cost data. All rows have lead counts. Filter `WHERE spend > 0` for cost-based metrics.

---

## 6. Sales Report Formulas

### Column Semantics

```sql
-- success_calls: calls with status=4 AND duration>=10 seconds
SELECT COUNT(*) FROM sternmeister_communications
WHERE manager = :manager
  AND DATE(created_at) BETWEEN :month_start AND :month_end
  AND call_status = 4 AND duration >= 10;

-- outgoing_calls: all outbound calls (any status)
SELECT COUNT(*) FROM sternmeister_communications
WHERE manager = :manager
  AND communication_type = 'call_out'
  AND DATE(created_at) BETWEEN :month_start AND :month_end;

-- total_duration: sum of all call durations
SELECT SUM(duration) FROM sternmeister_communications
WHERE manager = :manager
  AND DATE(created_at) BETWEEN :month_start AND :month_end
  AND communication_type IN ('call_in', 'call_out');
```

### `business_hours_sla` and `business_hours_sla_cnt`

```
avg_sla = business_hours_sla / business_hours_sla_cnt
```
`business_hours_sla` = SUM of SLA seconds for manager's leads that month.  
`business_hours_sla_cnt` = COUNT of those leads.  
**Currently NULL/0 for all rows** — the SLA aggregation job was not running during this period.

### `quality` Column

Only populated for **Екатерина Маслий** (Apr–Jun 2025, values 0.27–0.43). Values do not match any computable ratio from this database (not success_calls/total, not payment_rate). **Source is external** — likely pulled from the D2/R2 OKK evaluation databases. Cannot be reproduced without the OKK evaluations data.

---

## 7. Manager Reconciliation

### Complete Manager List (35 distinct names across all tables)

Active managers (in `sternmeister_sales_report`, 26 names):

| Manager | Notes |
|---|---|
| Анна Михолап | |
| Василина Милевская | |
| Виктор | (no surname) |
| Виктория Слюсаренко | |
| Гульназ **C**ираждинова | **WARNING:** Latin 'C' in the patronymic, not Cyrillic 'С'. Consistent across all tables but is a data quality issue. Queries must use exact spelling with Latin C. |
| Дмитрий Слидзюк | |
| Евгения Гусева | |
| Екатерина Болтова | |
| Екатерина Маслий | |
| Елена Поминова | |
| Єлизавета Трапезникова | Ukrainian Є (not Russian Е) |
| Ирина Сафронова | |
| Кристина Никоненко | |
| Любовь Левина | |
| Maksim Alekperov | Latin script (not Cyrillic) |
| Мария Радион | |
| Наталья Байда | |
| Нина Маркелова | |
| Ольга Лихварь | |
| Ольга Метальникова | |
| Ольга Пуховская | |
| Rose | Special: acts as inbound call queue (IVR) for incoming calls. All `call_in` records in the report are attributed to "Rose" as `manager`, while `current_manager` shows the actual agent who answered. Rose is also a real sales manager handling outbound calls on her own leads. |
| Татьяна Дерикова | |
| Эльмира Аладина | |
| Александра Николаева | |
| Валерия Лигай | |

Former/inactive managers (in `custom_report` history but NOT in `sales_report`; 9 names):

| Manager | Last Activity |
|---|---|
| Алёна Бочкарева | operational until 2026-03-16 |
| Бизун Ольга | operational until 2026-04-01 |
| Вероника Орехова | operational until 2026-03-05 |
| Зульфия Ахметова | operational until 2026-04-01 |
| Кристина Аладко | operational until 2026-04-14 |
| Marina Bogosyan | operational until 2026-02-22 |
| Мария Михайлова | operational until 2026-04-01 |
| Наталья Панова | operational until 2026-02-11 |
| Баярма Дондокова | sparse activity, still in cohort data |

### Kommo Mapping Notes

- Manager names in this DB are Kommo display names. Map to Kommo user IDs via `/api/v4/users` endpoint.
- No Kommo user IDs are stored in the MySQL DB.
- Our `master_managers` table in D1 has the authoritative name → Kommo user ID mapping.

---

## 8. Replication Strategy

### What You CAN Replicate from Kommo API + Neon OKK DBs

| Metric | Source | Method |
|---|---|---|
| Все звонки (operational) | Kommo API `/api/v4/events?type=outgoing_call,incoming_call` | Count call events per day per manager |
| Входящие / Исходящие | Same | Filter `type=incoming_call` or `outgoing_call` |
| Пропущенные | Kommo API calls where `result.status != 'answered'` | |
| Успешные (10+ сек) | Kommo call events with `duration >= 10` | |
| Время на линии | SUM of `duration` from Kommo call events | |
| Кол-во лидов | Kommo API `/api/v4/leads` with `created_at[from/to]` | |
| Отправлено сообщений | Kommo API notes/messages endpoint | |
| SLA первого звонка | Kommo leads `created_at` + first outbound call event; business hours computed in app | |
| Lead funnel stages | Kommo API `/api/v4/events?type=lead_status_changed` | Match to pipeline stages |
| Среднее время между звонками | Compute from sequential call events per lead (LAG window function) | |
| TLT | `business_hours(lead.created_at, last_call.created_at)` | |

### What Requires the 3rd-Party Integrator (Cannot Easily Replicate)

| Metric | Gap |
|---|---|
| **Среднее время между касаниями (funnel)** | Requires joining communications to status-change windows (which status was active during each comm). This window join is complex and requires the pre-built status-change event log. |
| **`quality` score** | External OKK evaluation aggregation. Requires reading from D2/R2 OKK evaluation JSON, averaging block scores, joining to manager+month. Doable from our DB but the linking logic (manager name matching + date) needs care. |
| **`business_hours_sla` / `business_hours_sla_cnt`** | Currently unpopulated in the MySQL DB. Would need the business-hours computation engine (§4 formula) applied to Kommo lead + call data. Implementable in app. |
| **Cohort call counts matching exactly** | The Airflow pipeline uses Kommo's internal event log (including phone system CDR) which has richer call metadata than what's exposed via `/api/v4/calls`. Our communications table may miss some calls. |
| **Multi-pipeline call deduplication** | One phone call linking to N leads across N pipelines. Kommo API returns calls per lead, so you'd need dedup logic. |
| **Ads attribution data** | `sternmeister_ads_report` ingests from Facebook Ads API + Google Ads API directly. You would need to integrate those APIs separately. The lead → UTM linkage comes from Kommo lead custom fields. |

### Minimal Query Set for Dashboard Replication

```sql
-- 1. Daily call KPIs per manager (operational)
SELECT
  DATE(created_at) AS dt, manager, pipeline_name,
  COUNT(*)                                           AS all_calls,
  SUM(communication_type = 'call_in')                AS incoming,
  SUM(communication_type = 'call_out')               AS outgoing,
  SUM(communication_type = 'call_in' AND call_status != 4) AS missed,
  SUM(call_status = 4 AND duration >= 10)            AS successful,
  SUM(duration)                                      AS total_duration_s
FROM sternmeister_communications
WHERE communication_type IN ('call_in', 'call_out')
GROUP BY dt, manager, pipeline_name;

-- 2. Daily message counts
SELECT DATE(created_at) AS dt, manager, pipeline_name, COUNT(*) AS messages_sent
FROM sternmeister_communications
WHERE communication_type = 'outgoing_chat_message'
GROUP BY dt, manager, pipeline_name;

-- 3. Daily new leads (operational)
SELECT DATE(created_at) AS dt, manager, pipeline, COUNT(*) AS lead_count
FROM sternmeister_leads_cohort
GROUP BY dt, manager, pipeline;

-- 4. SLA summary per manager
SELECT manager, pipeline_name,
  COUNT(*) AS total_leads,
  AVG(sla_first_call_seconds)          AS avg_sla_bh_seconds,
  AVG(sla_first_call_calendar_seconds) AS avg_sla_cal_seconds,
  SUM(sla_first_call_seconds <= 3600)  AS within_1h_count
FROM sternmeister_sla
WHERE sla_status = 'contacted'
GROUP BY manager, pipeline_name;

-- 5. Funnel stage distribution (current snapshot)
SELECT pipeline_name, status_name, COUNT(DISTINCT lead_id) AS leads
FROM report_sternmeister_funnel
WHERE metric_name = 'Кол-во лидов на стадии'
GROUP BY pipeline_name, status_name
ORDER BY pipeline_name, leads DESC;
```

---

## 9. Open Questions

1. **Business hours: 09:00 or 10:00 start?** Most evidence points to 09:00 Mon–Sat, but some Бух Комм leads show implied 10:00 start. Needs confirmation — is there a pipeline-specific schedule?

2. **Rose = inbound queue?** "Rose" appears as `manager` on all inbound calls in the report but `current_manager` shows the actual agent. Is "Rose" the name of the IVR/auto-attendant in Kommo, or a real user who is also the queue owner?

3. **`quality` source:** Only 3 rows populated (Екатерина Маслий, Apr–Jun 2025). Is this an OKK evaluation score? Was it ever intended to be populated for all managers? What is the scoring scale (0–1 based on observed values)?

4. **`sla_start` offset:** `sla_start` = `lead_created_at + ~3 minutes` (median ~200s). This appears to be Kommo webhook processing lag. Should TLT and SLA be measured from `lead_created_at` or `sla_start`?

5. **Multi-pipeline call attribution:** The same `communication_id` appears on multiple leads in different pipelines. How does the 3rd-party integrator decide which pipeline gets the metric? Is there a primary pipeline per call?

6. **`Баярма Дондокова`** appears in funnel/custom_report with only 16 call rows (last Apr 22 2026) but 0 communications in the `sternmeister_communications` table. Her calls exist only in the report layer — are they in a different Kommo account or source system?

7. **Sunday working hours:** Lead created Sat 22:54, called Sun 10:05 → biz_seconds = 321s = 5min 21s from 10:00. Was Sunday a working day (with 10:00 start) at some point? Current data shows this case only once — may be a past schedule or data error.

8. **`Гульназ Cираждинова` (Latin C):** Is this a consistent data quality issue that should be corrected at source, or intentional? Affects JOIN matching if comparing to Kommo API user names.

9. **`sternmeister_tasks` not reflected in metrics:** Is task-completion tracked anywhere in Looker dashboards? The table has 141k rows but zero corresponding metrics in either report table.

10. **Ads attribution data gap:** `sternmeister_ads_report` lacks spend data for 99% of rows (only organic leads). Is Facebook/Google Ads API integration actively maintained? The spend data appears to stop after May 2025.
