# Dashboard → «Звонки» — как работает

Last updated: 2026-04-28 (commits `cbd6355` → `6737362`)

This is the operational-architecture doc for the dashboard's «Звонки» tab.
Read alongside [`SESSION-HANDOFF.md`](./SESSION-HANDOFF.md) (current focus,
known issues) and [`TODO.md`](./TODO.md) (next steps).

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

## Why B2B has no per-pipeline split

Verified live 2026-04-28:

```sql
SELECT
  CASE WHEN pipeline_id IS NULL THEN 'NULL (telephony)' ELSE 'matched' END AS bucket,
  COUNT(*)
FROM analytics.communications
WHERE created_at >= NOW() - INTERVAL '7 days'
  AND communication_type LIKE 'call%'
GROUP BY bucket
```

→ 11,186 rows NULL (cg-leg + ct), 5 rows matched (legacy `note:N` stragglers).

**Root cause:** PBX (CallGear / CloudTalk) writes the CDR row BEFORE any
Kommo lead exists for the call. There's no pipeline context at write time.
The hard-split (2026-04-28) made telephony the sole call source, so 100%
of new call rows have `pipeline_id=NULL`.

For B2G this isn't a problem — line attribution is via `manager` name (which
the CDR has) → `master_managers.line`. Calls bucket cleanly into L1/L2/L3.

For B2B managers handle BOTH pipelines (verified 2026-04-28: top 7 by lead
volume — Rose 149/123, Метальникова 178/7, Пуховская 122/53, etc.). No
clean manager → pipeline mapping exists. Without phone→lead enrichment,
B2B per-pipeline call attribution is ~60% accurate at best.

**Decision:** B2B tile + trend chart show single big totals. The cohort
table below DOES split per-pipeline correctly because LEADS have
`pipeline_id` (only calls lack it).

**Fix path:** see the P1 task in `TODO.md` — phone→lead enrichment in
`sync-telephony.ts`. Once `analytics.communications.lead_id` is populated
on telephony rows, uncomment the parallel fetches in `/api/dashboard/route.ts`
and B2B will split correctly.

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
