// GET /api/dashboard?department=b2g&from=YYYY-MM-DD&to=YYYY-MM-DD[&vertical=]
// Питает вкладку «Звонки» (DashboardTab) — единственный её потребитель:
//   - todayMetrics: KPI-плитки
//   - perManager: разбивка по менеджерам (таблица + клиентский пересчёт плиток)
//   - trend / trendByLine / trendByManager: динамика по дням
//   - trendByPipeline / todayMetricsByPipeline: сплит Бух Комм / Мед Комм (b2b)
//   - missedBreakdown: доля пропущенных входящих
//
// Всё считается из зеркала `analytics.*`. Kommo здесь НЕ дёргается: воронка,
// pipelineBreakdown и «Задачи» ушли из UI вместе с когортной таблицей, а вместе
// с ними и их вычисления (2026-08-03) — держать ради них живой вызов Kommo на
// каждое открытие вкладки было чистой тратой рейт-лимита.

import { NextRequest, NextResponse } from "next/server";
import {
  sumCallMetrics,
  type UserCallMetrics,
} from "@/lib/kommo/metrics";
import { parseVertical, type Vertical } from "@/lib/kommo/pipeline-config";
import {
  getAnalyticsCallMetricsByMaster,
  getAnalyticsDailyTrend,
  getAnalyticsDailyTrendByLine,
  getAnalyticsDailyTrendByManager,
  getManagersWithKommoForPeriod,
  getAnalyticsTeamCallMetricsByPipeline,
  getAnalyticsDailyTrendByPipeline,
  getAnalyticsUnansweredWaitSeconds,
  getAnalyticsSlaFirstCallMinutes,
  getAnalyticsSlaFirstCallMinutesByManager,
  getAnalyticsLostCallsByManager,
  getAnalyticsInboundByLine,
  getB2gLostLeads,
  type DailyCallBucket,
  type ManagerSlaStat,
  type B2gLostLeadRow,
} from "@/lib/daily/analytics-calls";
import type { UserCallMetrics as UCMType } from "@/lib/kommo/metrics";

import { cached } from "@/lib/kommo/cache";
import { APP_TZ, addDaysCivil, parseDateBoundary, todayCivil } from "@/lib/utils/date";

// ==================== Helpers ====================
//
// All date windows resolve to Europe/Berlin wall-clock boundaries — never
// UTC-naive day rollovers. The team's ground truth is Berlin local time, and
// mixing UTC days with Berlin-day SQL grouping made per-manager tables and
// the trend chart disagree by ±1–2h (incident 2026-04-29: dashboard showed
// activity for "today" before Berlin business hours had started, because the
// UTC-day filter swallowed the previous evening's calls).
//
// parseDateBoundary("YYYY-MM-DD", "start"|"end") returns the UTC Date that
// represents 00:00:00 / 23:59:59.999 Berlin local for that civil date, with
// DST handled. Civil-date arithmetic helpers (addDaysCivil/todayCivil) live
// in @/lib/utils/date — keep this file free of duplicate copies.

/** Day-of-week (0 = Sunday … 6 = Saturday) for a civil date, evaluated in
 *  Berlin TZ. Drives the Monday-of-this-week shift in `getDateRange("week")`.
 *  We use Intl rather than Zeller's congruence so DST-flip days still resolve
 *  the same Berlin weekday (and to keep the helper count low). */
function dayOfWeekBerlin(dateStr: string): number {
  const start = parseDateBoundary(dateStr, "start");
  if (!start) throw new Error(`Bad date string: ${dateStr}`);
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: APP_TZ, weekday: "short" })
    .format(start);
  return ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as const)[wd as "Sun"] ?? 0;
}

/** UTC seconds from a Berlin-local civil-date boundary. Throws on bad input. */
function berlinDayBoundarySec(dateStr: string, kind: "start" | "end"): number {
  const d = parseDateBoundary(dateStr, kind);
  if (!d) throw new Error(`Bad date string: ${dateStr}`);
  return Math.floor(d.getTime() / 1000);
}

function getDateRange(period: string, dateStr: string): { from: number; to: number } {
  switch (period) {
    case "week": {
      // ISO week: Mon → Sun, in Berlin local.
      const wd = dayOfWeekBerlin(dateStr);
      const diff = wd === 0 ? -6 : 1 - wd;
      const monday = addDaysCivil(dateStr, diff);
      const sunday = addDaysCivil(monday, 6);
      return {
        from: berlinDayBoundarySec(monday, "start"),
        to: berlinDayBoundarySec(sunday, "end"),
      };
    }
    case "month": {
      const match = /^(\d{4})-(\d{2})-/.exec(dateStr);
      if (!match) throw new Error(`Bad date string: ${dateStr}`);
      const y = Number(match[1]);
      const m = Number(match[2]);
      // Last day of month: civil arithmetic, no TZ involved.
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const firstCivil = `${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}-01`;
      const lastCivil = `${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}-${lastDay.toString().padStart(2, "0")}`;
      return {
        from: berlinDayBoundarySec(firstCivil, "start"),
        to: berlinDayBoundarySec(lastCivil, "end"),
      };
    }
    case "year": {
      const match = /^(\d{4})-/.exec(dateStr);
      if (!match) throw new Error(`Bad date string: ${dateStr}`);
      const y = match[1];
      return {
        from: berlinDayBoundarySec(`${y}-01-01`, "start"),
        to: berlinDayBoundarySec(`${y}-12-31`, "end"),
      };
    }
    default: {
      return {
        from: berlinDayBoundarySec(dateStr, "start"),
        to: berlinDayBoundarySec(dateStr, "end"),
      };
    }
  }
}

function getTrendRange(period: string, from: number, to: number): { trendFrom: number; trendTo: number; trendDays: number } {
  if (period === "day") {
    // Last 7 Berlin-days ending on the selected date. We derive the Berlin
    // civil date FROM the UTC `to` instant so DST changes inside the 7-day
    // window don't drift the start by an hour: convert `to` → Berlin civil →
    // subtract 6 civil days → take Berlin midnight UTC instant of that day.
    const toCivil = new Date(to * 1000).toLocaleDateString("en-CA", { timeZone: APP_TZ });
    const startCivil = addDaysCivil(toCivil, -6);
    return {
      trendFrom: berlinDayBoundarySec(startCivil, "start"),
      trendTo: to,
      trendDays: 7,
    };
  }
  // For week/month/year — trend covers the full selected period
  const days = Math.ceil((to - from) / 86400);
  return { trendFrom: from, trendTo: to, trendDays: days };
}

// ==================== MAIN HANDLER ====================

// Прошедшие дни уже не меняются — их ответ держим 5 минут.
const RESPONSE_CACHE_TTL = 5 * 60 * 1000;
// Окно, захватывающее СЕГОДНЯ, живёт своей жизнью: CloudTalk-синк доливает
// звонки каждые 10 минут, а drill-down-модалки ходят мимо этого кэша
// (no-store + 60-секундный кэш analytics-запросов). При 5 минутах плитка и
// таблица отставали от своей же детализации — РОП видела «разные цифры» в
// плитке и в модалке (2026-07-29). Держим их в одном такте — 60 секунд.
const LIVE_RESPONSE_CACHE_TTL = 60 * 1000;

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const department = url.searchParams.get("department") || "b2g";
    // Вертикаль Бух/Мед/Все — осмысленна только для b2g. Для b2b передаём
    // undefined → хелперы идут по legacy-пути b2b (медицина там уже слита).
    const vertical: Vertical | undefined =
      department === "b2g" ? parseVertical(url.searchParams.get("vertical")) : undefined;
    const period = url.searchParams.get("period") || "day";
    // Default "today" is Berlin-local, not UTC — otherwise users in the first
    // ~2h after Berlin midnight see yesterday's date as default.
    const dateStr = url.searchParams.get("date") || todayCivil();
    // Optional explicit range — when provided, overrides period-based boundaries.
    // Lets the UI collapse day/week/month/year buttons into one calendar with
    // День/Период toggle.
    const fromStr = url.searchParams.get("from");
    const toStr = url.searchParams.get("to");

    // v15 (2026-08-03): из ответа убраны funnel / pipelineBreakdown /
    // overdueTasks / revenue / managersCount — их никто не читал. Бамп, чтобы
    // после деплоя не отдать старую форму из живого процесса.
    // v13 cache-key bump (2026-07-14): perManager rows grew slaLeadCount +
    // lostCalls (веса для клиентского фильтра «Менеджеры») — v12-кэш отдавал
    // бы строки без этих полей. (v12, 2026-04-29: Berlin boundaries.)
    // v14 (2026-07-20): avgWaitSeconds → avgWaitCloudtalkSec/avgWaitCallgearSec
    // (формулы кабинетов телефоний) — v13-кэш отдавал бы старый shape.
    const cacheKey = `dashboard-response:v15:${department}:${vertical ?? "-"}:${period}:${dateStr}:${fromStr || ""}:${toStr || ""}`;
    // Окно захватывает сегодняшний берлинский день → короткий TTL (см. выше).
    const today = todayCivil();
    const isLiveWindow = (toStr ?? dateStr) >= today;
    const responseData = await cached(
      cacheKey,
      isLiveWindow ? LIVE_RESPONSE_CACHE_TTL : RESPONSE_CACHE_TTL,
      () => buildDashboardResponse(department, vertical, period, dateStr, fromStr, toStr),
    );

    return NextResponse.json(responseData, {
      headers: {
        // Prevent any CDN / browser proxy from serving a stale response that
        // was built before the pipeline-breakdown scoping fix.
        "Cache-Control": "no-store, max-age=0",
      },
    });
  } catch (error) {
    console.error("Dashboard API error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

async function buildDashboardResponse(
  department: string,
  vertical: Vertical | undefined,
  period: string,
  dateStr: string,
  fromStr: string | null,
  toStr: string | null,
) {
    // Explicit from/to (inclusive, "YYYY-MM-DD") take priority over period/date.
    let from: number;
    let to: number;
    let effectivePeriod = period;
    if (fromStr && toStr) {
      // Berlin-local boundaries: "from=2026-04-29" means 00:00 Berlin Apr 29
      // (not 00:00 UTC which is 02:00 Berlin and shifts ~2h of activity into
      // the wrong day's bucket).
      from = berlinDayBoundarySec(fromStr, "start");
      to = berlinDayBoundarySec(toStr, "end");
      // Mark as custom so getTrendRange uses the full range (not 7-day default).
      effectivePeriod = fromStr === toStr ? "day" : "custom";
    } else {
      const derived = getDateRange(period, dateStr);
      from = derived.from;
      to = derived.to;
    }
    const { trendFrom, trendTo } = getTrendRange(effectivePeriod, from, to);

    // Komm: soft-deleted менеджеры не выпадают из статистики за периоды, когда
    // работали (единый ростер за период; для b2g = только активные).
    const allManagers = await getManagersWithKommoForPeriod(department, from, to, vertical);

    // Manager → line lookup for the per-line trend SQL. Pulls names from
    // master_managers (filtered to the active department by getManagersWithKommo)
    // grouped by `line` field. ROPs and managers without a line don't get
    // bucketed — their calls fall under "x" in the trend SQL and are dropped.
    const managersByLine = {
      line1: allManagers.filter((m) => m.line === "1").map((m) => m.name),
      line2: allManagers.filter((m) => m.line === "2").map((m) => m.name),
      line3: allManagers.filter((m) => m.line === "3").map((m) => m.name),
    };

    // Всё параллельно и всё — из зеркала `analytics.*`. Ни одного обращения к
    // Kommo API: снимки лидов, воронка и задачи отсюда удалены вместе с
    // блоками, которые их показывали (2026-08-03).
    const [todayCallMap, trendBuckets, trendByLineRaw, byPipelineRaw, trendByPipelineRaw, unansweredWaitSec, slaFirstCallMin, lostCallsRes, slaByManager, inboundByLine, trendByManagerRaw, b2gLostLeads] = await Promise.all([
      getAnalyticsCallMetricsByMaster(allManagers, department, from, to, vertical).catch((e) => {
        console.error("[Dashboard] analytics calls failed:", e);
        return new Map<string, UserCallMetrics>();
      }),
      getAnalyticsDailyTrend(department, trendFrom, trendTo, vertical).catch((e) => {
        console.error("[Dashboard] analytics trend failed:", e);
        return [];
      }),
      // Per-line trend only meaningful for B2G (3-line org). For B2B we still
      // run the query (cheap, returns empty maps when no managers in lines)
      // so the response shape is uniform — client decides whether to show
      // the line dropdown.
      department === "b2g"
        ? getAnalyticsDailyTrendByLine(department, trendFrom, trendTo, managersByLine, vertical).catch((e) => {
            console.error("[Dashboard] per-line trend failed:", e);
            return null;
          })
        : Promise.resolve(null),
      // Per-pipeline metrics + trend (B2B BK/MK split). Post-2026-04-28
      // these rely on enrich-telephony-leads to populate pipeline_id on
      // telephony rows via phone→lead resolution. Pre-enrichment (or for
      // phones Kommo can't resolve) those rows stay pipeline_id=NULL and
      // are dropped by these helpers' WHERE filter — they only surface in
      // the unscoped totals tile, which is the right behaviour for "calls
      // attributed to a specific pipeline".
      department === "b2b"
        ? getAnalyticsTeamCallMetricsByPipeline(department, from, to).catch((e) => {
            console.error("[Dashboard] per-pipeline tile failed:", e);
            return null;
          })
        : Promise.resolve(null),
      department === "b2b"
        ? getAnalyticsDailyTrendByPipeline(department, trendFrom, trendTo).catch((e) => {
            console.error("[Dashboard] per-pipeline trend failed:", e);
            return null;
          })
        : Promise.resolve(null),
      // B2B-only KPI tiles: «Ожидание» = среднее время гудков в неотвеченных
      // исходящих (см. getAnalyticsUnansweredWaitSeconds) and time-to-first-
      // call SLA (min). Cheap dept-wide aggregates; skipped on B2G.
      // «Ожидание» — среднее гудков в неотвеченных исходящих. Ростер по агентам,
      // поэтому осмысленно для обоих отделов (b2g/b2b), без вертикали.
      getAnalyticsUnansweredWaitSeconds(allManagers, department, from, to).catch((e) => {
        console.error("[Dashboard] unanswered wait failed:", e);
        return null;
      }),
      // SLA до первого звонка (мин). Для b2g — интеграторный (простой) вариант,
      // vertical-aware по воронке (Бух/Мед/Все). Для b2b — «своё» SLA Бух Комм.
      getAnalyticsSlaFirstCallMinutes(department, from, to, vertical).catch((e) => {
        console.error("[Dashboard] sla first-call failed:", e);
        return 0;
      }),
      // B2B «Потерянные»: outbound no-answer attempts with no callback to the
      // same number within 15 min (business hours 09–19 Berlin). total — для
      // плитки, byManager — для клиентского пересчёта при фильтре «Менеджеры».
      department === "b2b"
        ? getAnalyticsLostCallsByManager(allManagers, department, from, to).catch((e) => {
            console.error("[Dashboard] lost calls failed:", e);
            return { total: 0, byManager: new Map<string, number>() };
          })
        : Promise.resolve({ total: 0, byManager: new Map<string, number>() }),
      // Per-manager first-call SLA (min + число лидов) — для per-manager «SLA»
      // и клиентского пересчёта плитки под фильтром «Менеджеры». Оба отдела.
      getAnalyticsSlaFirstCallMinutesByManager(allManagers, department, from, to, vertical).catch((e) => {
        console.error("[Dashboard] per-manager sla failed:", e);
        return new Map<string, ManagerSlaStat>();
      }),
      // B2B inbound counted BY NUMBER (line_name LIKE 'KOM%'), incl. missed
      // no-agent calls — matches CloudTalk's group inbound. Drives «Всего».
      department === "b2b"
        ? getAnalyticsInboundByLine(department, from, to).catch((e) => {
            console.error("[Dashboard] inbound-by-line failed:", e);
            return 0;
          })
        : Promise.resolve(0),
      // Per-manager daily trend — one series per manager for the «Динамика
      // звонков по менеджерам» chart (metric + manager selection client-side).
      // Оба отдела: b2g использует его в режиме «По менеджерам» (Фаза 3).
      getAnalyticsDailyTrendByManager(department, trendFrom, trendTo, allManagers.map((m) => m.name), vertical).catch((e) => {
        console.error("[Dashboard] per-manager trend failed:", e);
        return {} as Record<string, DailyCallBucket[]>;
      }),
      // «Потерянные» b2g (спека 25 §2) — лид-based снимок на конец периода:
      // лиды «Новый лид»/«Недозвон» без звонка > 24ч. Плитка = длина списка.
      department === "b2g"
        ? getB2gLostLeads(new Date(to * 1000), vertical).catch((e) => {
            console.error("[Dashboard] b2g lost leads failed:", e);
            return [] as B2gLostLeadRow[];
          })
        : Promise.resolve([] as B2gLostLeadRow[]),
    ]);

    // Summary = sum of all per-manager metrics for the period
    const todaySummary = sumCallMetrics(Array.from(todayCallMap.values()));

    // Per-manager breakdown. Include ALL active managers+rops from the master
    // table; analytics matches by name so kommoUserId is no longer required.
    // Only role='manager'/'teamlead' per user policy — ROPs/admins don't appear
    // in the per-manager tables even if they were carrying calls (teamleads work
    // the line, so they do).
    const perManager = allManagers
      .filter((m) => m.role === "manager" || m.role === "teamlead")
      .map((mgr) => {
        const cm = todayCallMap.get(mgr.id);
        return {
          id: mgr.id,
          name: mgr.name,
          line: mgr.line,
          kommoUserId: mgr.kommoUserId,
          callsTotal: cm?.callsTotal ?? 0,
          callsConnected: cm?.callsConnected ?? 0,
          dialPercent: cm?.dialPercent ?? 0,
          totalMinutes: cm?.totalMinutes ?? 0,
          avgDialogMinutes: cm?.avgDialogMinutes ?? 0,
          missedIncoming: cm?.missedIncoming ?? 0,
          incomingTotal: cm?.incomingTotal ?? 0,
          outgoingTotal: cm?.outgoingTotal ?? 0,
          // B2B per-manager columns.
          outgoingConnected: cm?.outgoingConnected ?? 0,
          avgWaitSeconds: cm?.avgWaitSeconds ?? 0,
          // Веса/среднее для клиентского пересчёта плитки «Ожидание»
          // (неотвеченные исходящие) при фильтре «Менеджеры».
          unansweredWaitSeconds: cm?.unansweredWaitSeconds ?? 0,
          unansweredOutCount: cm?.unansweredOutCount ?? 0,
          slaFirstCallMin: slaByManager.get(mgr.id)?.avgMin ?? 0,
          // Веса для клиентского пересчёта плиток при фильтре «Менеджеры»:
          // SLA — взвешенное среднее по числу лидов, Потерянные — сумма.
          slaLeadCount: slaByManager.get(mgr.id)?.leadCount ?? 0,
          lostCalls: lostCallsRes.byManager.get(mgr.id) ?? 0,
        };
      })
      .sort((a, b) => b.callsTotal - a.callsTotal);

    // Trend line (already per-day buckets from analytics)
    const trend = trendBuckets;

    // Missed calls breakdown
    const missedBreakdown = {
      incomingTotal: todaySummary.incomingTotal,
      missedIncoming: todaySummary.missedIncoming,
      missedPercent: todaySummary.incomingTotal > 0
        ? Math.round((todaySummary.missedIncoming / todaySummary.incomingTotal) * 100)
        : 0,
    };

    // Empty per-line trends for B2B (or when query failed) — keeps the
    // response shape uniform so the client doesn't need null guards.
    const emptyTrend: DailyCallBucket[] = [];
    const trendByLine = trendByLineRaw ?? {
      line1: emptyTrend,
      line2: emptyTrend,
      line3: emptyTrend,
    };

    // Per-pipeline tile + trend (B2B BK/MK). null on B2G or when the helper
    // failed. Convert Map<pipelineId, …> to plain Record<string, …> for JSON
    // serialisation — the client decodes it the same way.
    const todayMetricsByPipeline: Record<string, UCMType> | null =
      byPipelineRaw && byPipelineRaw.size > 0
        ? Object.fromEntries(
            Array.from(byPipelineRaw.entries()).map(([pid, m]) => [String(pid), m]),
          )
        : null;
    const trendByPipeline: Record<string, DailyCallBucket[]> | null =
      trendByPipelineRaw && trendByPipelineRaw.size > 0
        ? Object.fromEntries(
            Array.from(trendByPipelineRaw.entries()).map(([pid, series]) => [String(pid), series]),
          )
        : null;

    // B2B call totals follow CloudTalk's group model: OUTBOUND by agent (already
    // in todaySummary, now pipeline-filter-free), INBOUND by number (line_name
    // 'KOM%', incl. missed no-agent calls). «Всего» = outbound + inbound-by-line.
    // B2G keeps the agent-based call_in totals.
    const isB2B = department === "b2b";
    const effectiveIncoming = isB2B ? inboundByLine : todaySummary.incomingTotal;
    const effectiveCallsTotal = isB2B
      ? todaySummary.outgoingTotal + inboundByLine
      : todaySummary.callsTotal;

    return {
      date: dateStr,
      period,
      department,
      vertical: vertical ?? null,
      todayMetrics: {
        callsTotal: effectiveCallsTotal,
        callsConnected: todaySummary.callsConnected,
        dialPercent: todaySummary.dialPercent,
        totalMinutes: todaySummary.totalMinutes,
        avgDialogMinutes: todaySummary.avgDialogMinutes,
        missedIncoming: todaySummary.missedIncoming,
        incomingTotal: effectiveIncoming,
        outgoingTotal: todaySummary.outgoingTotal,
        // Outgoing answered + answer-wait + first-call SLA drive the B2B
        // 7-tile layout. outgoingConnected sums fine across managers;
        // «Ожидание» = среднее гудков в неотвеченных исходящих
        // (см. getAnalyticsUnansweredWaitSeconds); null на B2G и без недозвонов.
        outgoingConnected: todaySummary.outgoingConnected ?? 0,
        unansweredWaitSec,
        slaFirstCallMin,
        // b2b — call-based (недозвон без перезвона); b2g — лид-based снимок
        // (лиды «Новый лид»/«Недозвон» без звонка > 24ч), спека 25 §2.
        lostCalls: isB2B ? lostCallsRes.total : b2gLostLeads.length,
      },
      missedBreakdown,
      perManager,
      trend,
      trendByLine,
      trendByManager: trendByManagerRaw,
      todayMetricsByPipeline,
      trendByPipeline,
    };
}
