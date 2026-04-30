# Dashboard → «Термин» — как работает

Last updated: 2026-04-28

This is the operational-architecture doc for the dashboard's «Термин» tab.
Read alongside [`SESSION-HANDOFF.md`](./SESSION-HANDOFF.md) and
[`TODO.md`](./TODO.md).

---

## What it shows

For every cohort day (= deals' `created_at` date) in the chosen period,
average days from deal creation to the assigned termin.

Two lines on one chart:

- **Термин ДЦ** — `Дата термина − Дата создания`
- **Термин АА** — usually `Дата термина АА − Дата создания`, BUT if the
  deal passed through the «Термин ДЦ состоялся» stage, the baseline shifts
  to the moment it entered that stage:
  `Дата термина АА − dt(TERM_DC_DONE)`

Per ТЗ:

- Deals without any termin are excluded.
- Negative results (`termin < baseline`) are excluded — Kommo edits sometimes
  back-date a termin.
- Rounded to 1 decimal place.
- Empty period → empty chart, never an error.

Pipeline scope: **Бух Бератер only** (`pipeline_id = 12154099`). Other
pipelines don't carry these custom fields.

---

## Layout

```
┌── Filter row ───────────────────────────────────────────────────┐
│ [Сегодня] [7 дней] [30 дней] [Текущий месяц] [Произвольный]    │
│ (📅 calendar)   01 апр — 28 апр   [↻]                          │
└─────────────────────────────────────────────────────────────────┘

┌── Summary tiles (3 in a row, responsive) ──────────────────────┐
│ Сделок в когорте    │ Ср. до Термин ДЦ   │ Ср. до Термин АА    │
│ 1 248               │ 11.4 дн.            │ 13.7 дн.            │
└─────────────────────────────────────────────────────────────────┘

┌── Chart ───────────────────────────────────────────────────────┐
│ Среднее время до термина (Бух Бератер)    ось X — дата создания│
│ ●━━ Термин ДЦ (#3b82f6, blue)                                  │
│ ●━━ Термин АА (#10b981, emerald)                               │
│ Tooltip: дата • ср. ДЦ • ср. АА • количество сделок            │
└─────────────────────────────────────────────────────────────────┘
```

Mobile: tile grid collapses to 1 col, chart drops to 260 px height,
preset chips wrap.

Filter chips (`today`/`7d`/`30d`/`month`/`custom`) auto-toggle to `custom`
when the user opens the calendar manually.

---

## Источники данных

Все запросы — **Analytics Neon** (`ANALYTICS_DATABASE_URL`, схема `analytics.*`). Никакие другие БД этот раздел не трогает.

| DB connection | Таблица | Колонка | Зачем нужна тут | Где заполняется |
|---|---|---|---|---|
| **Analytics** | `analytics.leads_cohort` | `termin_date` | "Дата термина ДЦ" / legacy "Дата термина" custom field on Kommo lead | ETL `syncLeads` — resolved by name (case-insensitive), fallback на legacy если "Дата термина ДЦ" missing |
| **Analytics** | `analytics.leads_cohort` | `aa_termin_date` | "Дата термина АА" custom field | ETL `syncLeads` |
| **Analytics** | `analytics.leads_cohort` | `created_at` | Deal creation timestamp | Existing column |
| **Analytics** | `analytics.leads_cohort` | `pipeline_id` | Filter `= 12154099` (Бух Бератер) — другие пайплайны эти поля не имеют | Existing |
| **Analytics** | `analytics.lead_status_changes` | MIN(`event_at`) WHERE `status_id = 93886075` | TERM_DC_DONE → baseline для AA когда сделка прошла «Термин ДЦ состоялся» | ETL `syncStatusChanges` |

Both `termin_date` and `aa_termin_date` were added in
[`drizzle/analytics/0006_termin_dates.sql`](../drizzle/analytics/0006_termin_dates.sql)
along with a partial index `idx_lc_termin_cohort` on
`(pipeline_id, created_at) WHERE termin_date IS NOT NULL OR
aa_termin_date IS NOT NULL`.

The custom field names are looked up by NAME (case-insensitive, trimmed),
not field ID — Kommo's IDs differ across accounts and we already saw
two ID variants live for "Дата термина" (885996 generic, 887026
specific). Spellings list lives at
[`src/lib/kommo/pipeline-config.ts`](../src/lib/kommo/pipeline-config.ts) →
`B2G_CUSTOM_FIELD_NAMES`.

---

## API

`GET /api/dashboard/termins?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD`

Defaults: last 30 days if either query param is missing.

```jsonc
[
  { "date": "2026-04-21", "dcAvgDays": 10.4, "aaAvgDays": 7.3,  "count": 19 },
  { "date": "2026-04-22", "dcAvgDays": 11.0, "aaAvgDays": 13.1, "count": 17 },
  { "date": "2026-04-23", "dcAvgDays": 12.0, "aaAvgDays": null, "count": 10 }
  // ...
]
```

`null` on `aaAvgDays` (or `dcAvgDays`) means no deal in that cohort
contributed a non-negative value. `count` is the number of deals in the
cohort with **at least one** termin set.

The route file —
[`src/app/api/dashboard/termins/route.ts`](../src/app/api/dashboard/termins/route.ts) —
runs a single SQL with two CTEs:

```
dc_done   = MIN(event_at) per lead from lead_status_changes
            WHERE status_id = TERM_DC_DONE
deals     = leads_cohort row + LEFT JOIN dc_done
            WHERE pipeline = BERATER, created_at IN [from,to],
                  termin_date OR aa_termin_date IS NOT NULL
SELECT cohort_date,
       ROUND(AVG(termin_date - created_at) FILTER (>= 0), 1)            AS dc_avg_days,
       ROUND(AVG(aa_termin_date - COALESCE(dc_done_at, created_at))
             FILTER (>= 0), 1)                                          AS aa_avg_days,
       COUNT(*)
GROUP BY cohort_date
```

`COALESCE(dc_done_at, created_at)` is what implements the "if passed
TERM_DC_DONE, measure from there" rule.

Cache: `Cache-Control: private, max-age=60`. The data only changes on
ETL ticks (every 15 min) so a 1-min browser cache is safe.

---

## ETL flow

`syncLeads` (existing) — for every Kommo lead in the window:

```ts
const terminDate   = parseDate(findByName(cf, B2G_CUSTOM_FIELD_NAMES.terminDate));
const aaTerminDate = parseDate(findByName(cf, B2G_CUSTOM_FIELD_NAMES.aaTerminDate));
```

`parseDate` handles unix-seconds (`(date)` Kommo type), unix-ms, and ISO
strings — same path as `firstPaymentDate`/`prepaymentDate`.

`syncStatusChanges` (existing) — pulls the full `events` stream for the
window, including `lead_status_changed` events to status `93886075`. The
DC-done timestamp falls out of `MIN(event_at) GROUP BY lead_id` at query
time; nothing else needs to know about it.

The 15-min cron uses `incremental=true` which means `syncLeads` queries
Kommo by `updated_at`, so any lead whose termin date changes anywhere
in Kommo gets re-pulled within 15 minutes.

---

## Backfill

For leads created before the columns existed, run the focused backfill:

```bash
npx tsx scripts/backfill-termins.ts --from 2026-01-01 --to 2026-04-28 --chunk 7
```

Only reaches `syncLeads` + `syncStatusChanges` — skips communications /
tasks / SLA / telephony for max speed. ~30 sec per 7-day chunk.

Resumable: failed chunks are logged at end, re-run the same command to
retry only the gaps.

---

## UI tab

Added to the admin sidebar between «Активность» and «Looker». Hidden
from non-admin users (it's a strategic/management metric, not relevant
to individual managers).

Component:
[`src/components/TerminTab.tsx`](../src/components/TerminTab.tsx)

Recharts `LineChart` with `connectNulls` — so a day with `aa_termin_date`
missing doesn't break the line, it just skips that point.

---

## Edge cases

- **All AA dates equal DC dates** on freshly-created leads — Kommo writes
  both to the same value when the manager schedules the termin, AA only
  diverges later when actually played out. Visually fine: both lines
  overlap until the cohort matures.
- **Lead deleted in Kommo after creation** — `syncLeads` re-fetch removes
  it from `leads_cohort` (DELETE-then-INSERT pattern), so it disappears
  from the chart on next ETL tick.
- **Negative interval** (manual back-date) — filtered out per row by the
  `FILTER (WHERE termin >= baseline)` clause. `count` still includes the
  lead because it has a termin set; the average just excludes it.
- **TERM_DC_DONE event missed by ETL** (rare — events sync window) —
  `dc_done_at` is NULL, AA-baseline silently falls back to `created_at`.
  Re-running `syncStatusChanges` for that window fixes it.
