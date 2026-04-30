# Dashboard → «Звонки» — как работает

Last updated: 2026-04-28 (commits `cbd6355` → `6737362`)

This is the operational-architecture doc for the dashboard's «Звонки» tab.
Read alongside [`SESSION-HANDOFF.md`](./SESSION-HANDOFF.md) (current focus,
known issues) and [`TODO.md`](./TODO.md) (next steps).

> Note: «Звонки» — это label сайдбара для tab id `dashboard`. Компонент — `DashboardTab.tsx`.

---

## Источники данных

| DB connection | Таблица | Зачем нужна тут | Ключевые колонки |
|---|---|---|---|
| **Analytics** (`ANALYTICS_DATABASE_URL`) | `analytics.communications` | KPI tiles + per-manager калы + trend chart | `communication_type` (filter `LIKE 'call%'`), `manager`, `pipeline_id` (filter `IN (dept) OR IS NULL`), `duration` (≥1 = connected), `created_at`, `lead_id`, `phone` (для CDR-row после `enrich-telephony-leads`), `communication_id` (для `COUNT(DISTINCT)`) |
| **Analytics** | `analytics.leads_cohort` | Cohort status table («когортный срез по статусам сделок») | `lead_id`, `created_at` (cohort filter), `pipeline_id`, `status_id`, `category` |
| **D1** (`DATABASE_URL`) | `master_managers` | Per-manager attribution (имя, линия, kommo_user_id) | `id`, `name`, `kommo_user_id`, `line`, `role`, `is_active`, `department`. Фильтр `is_active=true AND department=:dept`. ROPs (без `line`) исключаются из per-manager-таблиц но входят в KPI totals |

> **Внешний источник**: Kommo `/leads/pipelines` API дёргается параллельно для live-имён статусов (терминальные status_id 142/143 — глобальные, имена per-pipeline). Кешируется с `v8` cache-key вместе с response.

> **Не используется** этим разделом: OKK (`calls`/`evaluations`), Roleplay (`d1_calls`/`r1_calls`), `tracking_events`, `daily_plans`, `analytics.sla`. Только три таблицы выше.

---

## Layout (top → bottom)

```
┌── Filter row ────────────────────────────────────────────────────┐
│ Calendar (range/single)   ◀ date display ▶   [Сегодня] [↻]      │
└──────────────────────────────────────────────────────────────────┘

┌── KPI tiles (4 in a row, responsive grid-cols-2 sm:grid-cols-4) ─┐
│ Звонки      │ Дозвон      │ На линии    │ Пропущенные           │
│ total       │ total       │ total       │ total                 │
│ ─────       │ ─────       │ ─────       │ ─────                 │
│ Квалификация│ Квалификация│ Квалификация│ Квалификация          │
│ Бератер     │ Бератер     │ Бератер     │ Бератер               │  (B2G)
│ Доведение   │ Доведение   │ Доведение   │ Доведение             │
└──────────────────────────────────────────────────────────────────┘

┌── Per-manager call tables (3 for B2G, 1 for B2B) ───────────────┐
│ Квалификатор (1я линия) — N человек                              │
│   ┌────────┬──────┬──────┬──────┬──────┬─────┬─────┬─────┬─────┐│
│   │Менеджер│Звонки│Дозвон│%дозв │Налини│Сред │Вх.вс│Прпщ │Задач││
│   ├────────┼──────┼──────┼──────┼──────┼─────┼─────┼─────┼─────┤│
│   │ ...    │ ...  │ ...  │ ...  │ ...  │ ... │ ... │ ... │ ... ││
│   └────────┴──────┴──────┴──────┴──────┴─────┴─────┴─────┴─────┘│
│ Бератер (2я линия) — …                                           │
│ Доведение (3я линия) — …                                         │
│ Руководители (без линии) — …                                     │
└──────────────────────────────────────────────────────────────────┘

┌── Trend chart ──────────────────────────────────────────────────┐
│ Динамика звонков по дням             [Все линии ▼] (B2G)        │
│ [LineChart: Звонки / Дозвон / Пропущ.]                          │
└──────────────────────────────────────────────────────────────────┘

┌── Cohort status table ──────────────────────────────────────────┐
│ Статусы сделок — когортный срез   [☑ Кв.] [☑ Бер.]  [Статусы ▼] │
│ ┌──────────────────┬────────┬───────┬───────────────────────┐   │
│ │ Статус           │ Воронка│ Сделок│ Доля                  │   │
│ ├──────────────────┼────────┼───────┼───────────────────────┤   │
│ │ Доведение        │ Бератер│   53  │ ▓▓▓▓▓░ 21.0%          │   │
│ │ ...              │ ...    │  ...  │ ...                   │   │
│ └──────────────────┴────────┴───────┴───────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

---

## Filters

### Top-level (single calendar)

- One unified date range. «День» / «Период» toggle inside `CalendarPicker`.
- State lives in `DashboardTab.tsx` as `range: { start: Date; end: Date }`.
- Propagates to `/api/dashboard?from=YYYY-MM-DD&to=YYYY-MM-DD` — drives **every** widget on the tab. No widget reads dates independently.

### Local filters (no refetch — pure client useMemo)

| Widget | Filter | Default |
|---|---|---|
| Trend chart | Линия dropdown (B2G only): Все / 1 / 2 / 3 | Все |
| Cohort table | Воронка checkboxes: 2 inline pills (B2G: Квалификатор + Бератер; B2B: Бух Комм + Мед Комм) | Both checked |
| Cohort table | Статусы dropdown: checkbox per status, «Выбрать все / Снять все» | All checked |

Status dropdown auto-narrows to statuses present in the funnel-filtered subset.
Newly-arriving statuses (e.g. after the user expands the date range) are
auto-included via a `null = all-selected` sentinel.

---

## KPI tiles — what each metric is

All 4 tiles read from `analytics.communications` rows where
`communication_type LIKE 'call%'`. The total tile-value uses
`(pipeline_id IN (dept) OR pipeline_id IS NULL)` so telephony rows
(NULL pipeline_id post-hard-split) are counted.

| Tile | Total value | Per-line breakdown (B2G) |
|---|---|---|
| **Звонки** | `COUNT(*)` filter call_in/call_out | sum of perManager.callsTotal grouped by `master_managers.line` |
| **Дозвон** | `% = callsConnected / callsTotal` (connected = `duration >= 1`) | per-line same formula |
| **На линии** | `SUM(duration) / 60` minutes | per-line same |
| **Пропущенные** | `call_in WHERE duration < 1 OR NULL` | per-line same |

**B2B**: the 3 KPIs above show a single big number (no per-pipeline breakdown).
This is intentional — see [Why B2B has no per-pipeline split](#why-b2b-has-no-per-pipeline-split).

The total tile caption uses compact labels:
- Звонки: `860↑ 93↓` (out / in)
- Дозвон: `850/1500` (connected / total)
- На линии: `ср. 7м` (avg dialog minutes)
- Пропущенные: `15% от 200` (missed % of incoming)

---

## Per-manager tables

Source: `data.perManager` from API. Each row: master_managers id + name + line +
call metrics in [from, to] window. Filter is **client-side `.filter(r => r.line === "1")`**
etc. — date binding happens server-side.

ROPs (`role='rop'`) excluded from these tables (they're aggregated into the
KPI totals though, since `master_managers` includes them).

B2G shows 4 tables (Квалификатор / Бератер / Доведение / Руководители без линии).
B2B shows 1 table (Менеджеры — flat, no per-pipeline split).

---

## Trend chart — `Динамика звонков по дням`

Source: `data.trend` (array of `DailyCallBucket`).

For B2G the line dropdown switches between 4 server-computed series:
- Все: `data.trend` — `getAnalyticsDailyTrend(department, from, to)`. Uses `(pipeline_id IN (dept) OR pipeline_id IS NULL)` so all dept calls counted.
- Линия 1/2/3: `data.trendByLine.line{1,2,3}` — `getAnalyticsDailyTrendByLine(department, from, to, managersByLine)`. Uses `manager IN (line-N-names)` to bucket — works even though calls have `pipeline_id=NULL` because attribution is via manager name.

For B2B: no dropdown (would be flat zeros if shown — see below).

Trend window when single day selected: 7-day rolling. When range selected:
exact range.

---

## Cohort status table

This is the «когортный срез по статусам сделок». Source: `data.statusBreakdown`.

**Cohort = leads CREATED in [from, to]** in this department's pipelines,
regardless of current status (active OR closed = won/lost). Lifecycle view
of the cohort. Built server-side in `buildCohortStatusBreakdown()` from
`cohortLeads` (separate `getAnalyticsLeads` fetch with
`dateFilter: { field: "created_at", from, to }`).

Each row: pipelineId, pipelineName, line (B2G only), statusId, statusName, count.

Status names come from the **live** Kommo `/leads/pipelines` API (fetched in
parallel with leads), keyed by `${pipelineId}:${statusId}` — Kommo's terminal
IDs 142 (Won) and 143 (Lost) are GLOBAL across pipelines but have different
labels per funnel ("Гутшайн одобрен" vs "Closed - won" vs "Успешно реализовано"),
so a flat status-id map collapses them.

For B2G the BERATER pipeline is split into Line 2 / Line 3 by status_id:
the `BERATER_LINE_3_STATUS_IDS` set in `route.ts` controls the assignment.
Both halves carry `pipelineId = 12154099` so the «Бератер» funnel checkbox
captures all of them.

**Percent base:** each row's percent = `count / sum(currently shown rows)`.
When the user unchecks a funnel or status, that row drops out of the visible
set, total shrinks, percentages of remaining rows re-base. Verified in code
via `useMemo` chain: `lineFilteredRows → filtered → total → pct`.

---

## B2B per-pipeline split (re-enabled 2026-04-28)

Earlier in 2026-04-28 the B2B tile + trend chart showed dept-wide totals
only because every telephony row had `pipeline_id=NULL` (PBX writes CDR
before any Kommo lead exists for the phone). Fixed today via Migration
0005 + `enrich-telephony-leads.ts`:

1. CDR row arrives at `analytics.communications` with `lead_id=NULL`,
   `pipeline_id=NULL`, **`phone` populated**.
2. `enrich-telephony-leads` (runs after `sync-telephony` in `runSync`):
   - Resolves phone → contact → leads via Kommo `/api/v4/contacts?filter[query]=`.
   - For each call, fans the row out to one row per matched lead with
     real `pipeline_id` + `status_id` + `lead_created_at` from
     `analytics.leads_cohort` (Pattern A, see `docs/mysql-analytics.md`).
3. Daily/Звонки helpers use `COUNT(DISTINCT communication_id)` to keep
   "1 call counts once" semantics (DISTINCT ON CTE in `analytics-calls.ts`).
4. Per-pipeline helpers (`fetchTeamCallMetricsByPipeline`,
   `getAnalyticsDailyTrendByPipeline`) intentionally double-count across
   pipelines a contact has leads in — matches integrator's Looker.

For phones Kommo can't resolve (deleted contacts, typos): row stays
`lead_id=NULL`, `pipeline_id=NULL`. They surface only in dept-total tile
(via `OR pipeline_id IS NULL` fallback), not in per-pipeline split.

`/api/dashboard/route.ts` cache key bumped `v7→v8`. Re-enabled fetchers:
`getAnalyticsTeamCallMetricsByPipeline` + `getAnalyticsDailyTrendByPipeline`.

---

## Server endpoint reference

`GET /api/dashboard?department={b2g|b2b}&from=YYYY-MM-DD&to=YYYY-MM-DD`

Response shape (only fields the Звонки tab uses):

```ts
{
  date: string;
  department: "b2g" | "b2b";
  todayMetrics: {                  // KPI tile totals
    callsTotal, callsConnected, dialPercent, totalMinutes,
    avgDialogMinutes, missedIncoming, incomingTotal, outgoingTotal,
    overdueTasks, revenue, managersCount,
  };
  perManager: Array<{              // 3 tables (B2G) or 1 (B2B)
    id, name, line, kommoUserId,
    callsTotal, callsConnected, dialPercent, totalMinutes,
    avgDialogMinutes, missedIncoming, incomingTotal, outgoingTotal,
    overdueTasks,
  }>;
  trend: DailyCallBucket[];        // 7d (single day) or full range
  trendByLine: {                   // B2G only — line-bucketed series
    line1: DailyCallBucket[];
    line2: DailyCallBucket[];
    line3: DailyCallBucket[];
  };
  todayMetricsByPipeline: null;    // disabled — see "Why B2B" above
  trendByPipeline: null;           // disabled — same
  statusBreakdown: Array<{         // cohort table
    pipelineId, pipelineName, line, statusId, statusName, count,
  }>;
  // legacy fields kept on the wire for non-Звонки consumers:
  funnel, missedBreakdown, pipelineBreakdown,
}
```

Cache: 5-min in-memory, key `dashboard-response:v7:${dept}:${period}:${date}:${from}:${to}`.

---

## Files

```
src/components/DashboardTab.tsx          ← UI (this whole tab in one file)
src/app/api/dashboard/route.ts           ← API + buildCohortStatusBreakdown
src/lib/daily/analytics-calls.ts         ← SQL helpers (per-master, per-line, per-pipeline, trend)
src/lib/db/queries-daily.ts              ← getManagersWithKommo
src/lib/kommo/client.ts                  ← getPipelines() — live status names
```

Diagnostic script:
```bash
npx tsx scripts/list-kommo-statuses.ts   # dump every B2G/B2B pipeline + status
```

---

## Common gotchas

- **Stale cache after schema change.** Bump the `cacheKey` version
  (currently `v7`). Otherwise old cached responses leak the wrong shape.
- **Status name `Status 12345`** appearing in the cohort table = pipeline
  rename in Kommo + stale `liveStatusNames`. Re-fetch (cache TTL 5 min) or
  manually invalidate.
- **B2G Бератер L2 leads not appearing** in the cohort = the funnel filter is
  by pipelineId, not line. The «Бератер» checkbox covers BOTH L2 + L3 statuses
  by design (single Kommo pipeline). Don't confuse with the per-manager tables
  which DO split L2/L3 (separate manager pools).
- **fetchData infinite refetch.** If you add new state to `DashboardTab` and
  put it in the `fetchData` useCallback deps, you'll resurrect the bug fixed
  in commit `b56abbd`. Use a ref instead.
