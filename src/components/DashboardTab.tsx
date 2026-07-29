"use client";

import { Fragment, useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  Phone, Clock, AlertTriangle,
  PhoneMissed, Target, Loader2, RefreshCw,
  ChevronLeft, ChevronRight, ChevronDown, Check,
  PhoneOutgoing, PhoneCall, Timer, Gauge, PhoneOff, Users,
  ArrowLeftRight,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip as RTooltip,
  ResponsiveContainer, CartesianGrid, Legend,
} from "recharts";
import CalendarPicker from "@/components/CalendarPicker";
import DinoLoader from "@/components/DinoLoader";
import { kommoLeadUrl } from "@/components/TerminLeadDrillModal";
import {
  fmtLocalDate as formatDate,
  todayBerlinDate,
  berlinCivilDate,
  addDaysCivil,
  diffDaysCivil,
} from "@/lib/utils/date";

// «Длительность» B2B в часах и минутах: «997м» глазами не считывается,
// «16ч 37м» — сразу. До часа оставляем минуты («37м»).
function fmtHoursMinutes(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}ч ${m}м` : `${m}м`;
}

// ==================== Types ====================

interface TodayMetrics {
  callsTotal: number;
  callsConnected: number;
  dialPercent: number;
  totalMinutes: number;
  avgDialogMinutes: number;
  missedIncoming: number;
  incomingTotal: number;
  outgoingTotal: number;
  // B2B tile additions (0 / absent on B2G).
  outgoingConnected?: number;
  // «Ожидание» (переопределение 2026-07-20): среднее время гудков в
  // НЕОТВЕЧЕННЫХ исходящих менеджеров отдела, обе платформы. null = нет данных.
  unansweredWaitSec?: number | null;
  slaFirstCallMin?: number;
  lostCalls?: number;
  overdueTasks: number;
  revenue: number;
  managersCount: number;
}

interface DailyBucket {
  date: string;
  callsTotal: number;
  callsConnected: number;
  totalMinutes: number;
  missedIncoming: number;
  incomingTotal: number;
  outgoingTotal: number;
}

interface PerManagerRow {
  id: string;
  name: string;
  line: string | null;
  kommoUserId: number | null;
  callsTotal: number;
  callsConnected: number;
  dialPercent: number;
  totalMinutes: number;
  avgDialogMinutes: number;
  missedIncoming: number;
  incomingTotal: number;
  outgoingTotal: number;
  // B2B per-manager columns.
  outgoingConnected: number;
  avgWaitSeconds: number;
  // Плитка «Ожидание» (недозвоны): среднее гудков + вес для пересчёта фильтром.
  unansweredWaitSeconds?: number;
  unansweredOutCount?: number;
  slaFirstCallMin: number;
  // Веса для пересчёта плиток при фильтре «Менеджеры» (см. selectedManagers):
  // SLA — взвешенное среднее по slaLeadCount, Потерянные — сумма lostCalls.
  slaLeadCount: number;
  lostCalls: number;
  overdueTasks: number;
}

interface DashboardData {
  date: string;
  department: string;
  todayMetrics: TodayMetrics;
  missedBreakdown: {
    incomingTotal: number;
    missedIncoming: number;
    missedPercent: number;
  };
  perManager: PerManagerRow[];
  trend: DailyBucket[];
  trendByLine: { line1: DailyBucket[]; line2: DailyBucket[]; line3: DailyBucket[] };
  // B2B-only: pipeline_id (string) → metrics / daily buckets. Drives the
  // Бух Комм / Мед Комм split in tiles + trend on the commerce side.
  todayMetricsByPipeline?: Record<string, {
    callsTotal: number; callsConnected: number; dialPercent: number;
    totalMinutes: number; avgDialogMinutes: number; missedIncoming: number;
    incomingTotal: number; outgoingTotal: number;
  }> | null;
  trendByPipeline?: Record<string, DailyBucket[]> | null;
  // B2B-only: manager name → daily buckets. Drives the per-manager «Динамика
  // звонков» chart (line per manager, metric via pill toggle).
  trendByManager?: Record<string, DailyBucket[]> | null;
}

// Строка детализации «Потерянных» (ответ /api/dashboard/lost-calls).
interface LostCallItem {
  manager: string | null;
  phone: string;
  createdAt: string;
  leadId: number | null;
  pipelineName: string | null;
  statusName: string | null;
  clientName: string | null;
  /** Как потеряли клиента: наш недозвон без повтора / клиент звонил сам,
   *  никто не взял и не перезвонили (b2b, 2026-07-29). */
  kind?: "out_unanswered" | "in_missed";
}

// Строка детализации SLA (ответ /api/dashboard/sla-leads).
interface SlaLeadItem {
  leadId: number;
  manager: string | null;
  slaMinutes: number;
  slaStatus: string | null;
  clientName: string | null;
  phone: string | null;
  pipelineId: number | null;
}

// Строка «Потерянных» b2g (ответ /api/dashboard/lost-leads) — лид-based
// (спека 25 §2): лид на «Новый лид»/«Недозвон» без звонка > 24ч.
interface B2gLostLeadItem {
  leadId: number;
  clientName: string | null;
  manager: string | null;
  pipelineName: string | null;
  stageName: string | null;
  leadCreatedAt: string | null;
  lastCallAt: string | null;
}

// Детализация KPI-плиток B2B — форма ответа /api/dashboard/b2b-tile-details
// (см. getAnalyticsB2bTileDetails: скоуп/пороги идентичны плиткам).
type TileDetailKind = "outgoing" | "answered" | "hourly" | "wait";
interface B2bTileDetails {
  platforms: Array<{ platform: string; outgoing: number; connected: number; talkSeconds: number }>;
  managerPlatforms: Array<{ manager: string; platform: string; outgoing: number; connected: number }>;
  hourly: Array<{ hour: number; outgoing: number; connected: number }>;
  // Ожидание — среднее гудков в НЕОТВЕЧЕННЫХ исходящих (метрика плитки).
  waitPlatforms: Array<{ platform: string; avgWaitSec: number; maxWaitSec: number; unanswered: number }>;
  waitManagers: Array<{ manager: string; avgWaitSec: number; unanswered: number }>;
}

const SLA_STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  measured: { label: "звонок сделан", cls: "bg-emerald-500/15 text-emerald-400" },
  instant: { label: "мгновенно", cls: "bg-emerald-500/15 text-emerald-400" },
  pending: { label: "ещё без звонка", cls: "bg-amber-500/15 text-amber-400" },
  closed_no_call: { label: "закрыт без звонка", cls: "bg-rose-500/15 text-rose-400" },
};

// Время потерянного звонка — берлинское, с датой (перид может быть > 1 дня).
function fmtLostAt(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", {
    timeZone: "Europe/Berlin",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type LineFilter = "all" | "1" | "2" | "3";

const LINE_SHORT: Record<Exclude<LineFilter, "all">, string> = {
  "1": "Квалификация",
  "2": "Бератер",
  "3": "Доведение",
};

// ==================== Component ====================

export default function DashboardTab({
  department,
  vertical,
}: {
  department: string;
  /** Вертикаль b2g (buh/med/all). undefined на b2b — параметр не шлём. */
  vertical?: "buh" | "med" | "all";
}) {
  const [range, setRange] = useState<{ start: Date; end: Date }>(() => {
    // Berlin-midnight Date so picker label and the date string sent to the API
    // agree regardless of browser TZ (e.g. Moscow browser would otherwise pick
    // the wrong civil day after fmtLocalDate's Berlin formatting).
    const today = todayBerlinDate();
    return { start: today, end: today };
  });
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Переключатель направления (линии) — общий фильтр вкладки b2g: «Все» или
  // конкретная линия. Скоупит плитки, таблицу и график (как у Комм).
  const [b2gLine, setB2gLine] = useState<"all" | "1" | "2" | "3">("all");
  // Глобальный фильтр «Менеджеры» (B2B): null = все. Живёт в шапке вкладки и
  // фильтрует ВСЁ — KPI-плитки, таблицу, график и детализации. Выбор
  // переживает смену периода (сравнивать одну и ту же группу по датам), но
  // сбрасывается при смене отдела (имена другого отдела не пересекаются).
  const [selectedManagers, setSelectedManagers] = useState<Set<string> | null>(null);
  useEffect(() => {
    setSelectedManagers(null);
  }, [department]);
  // Сравнение периодов (Коммерсы, решение 2026-07-29): тумблер живёт в общей
  // панели фильтров и переключает таблицу «Менеджеры» в вид A | B | Δ по
  // референсу «Оценки критериев». Период B — второй запрос того же
  // /api/dashboard, поэтому обе колонки считаются одними формулами.
  const [compareOn, setCompareOn] = useState(false);
  // Override периода B помечен сигнатурой окна A: при смене A он «протухает»
  // и мы падаем на дефолт (предыдущее равное окно) — без setState-in-effect.
  const [compareOverride, setCompareOverride] = useState<{ sig: string; start: Date; end: Date } | null>(null);
  const [compareData, setCompareData] = useState<DashboardData | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  useEffect(() => {
    setCompareOn(false);
    setCompareData(null);
  }, [department]);
  // Drill-down «Потерянных» (спека 22 п.6): клик по плитке открывает панель
  // с разбивкой по менеджерам. Данные грузятся лениво по клику и сбрасываются
  // при смене периода/отдела (см. useEffect ниже).
  const [lostOpen, setLostOpen] = useState(false);
  const [lostItems, setLostItems] = useState<LostCallItem[] | null>(null);
  const [lostLoading, setLostLoading] = useState(false);
  const [lostError, setLostError] = useState<string | null>(null);
  // Drill-down SLA (спека 22 п.5.3) — тот же паттерн, что «Потерянные».
  const [slaOpen, setSlaOpen] = useState(false);
  const [slaItems, setSlaItems] = useState<SlaLeadItem[] | null>(null);
  const [slaLoading, setSlaLoading] = useState(false);
  const [slaError, setSlaError] = useState<string | null>(null);
  // Drill-down остальных B2B-плиток (Исходящие/Принятых/%дозвона/Ожидание).
  // Один эндпоинт отдаёт данные всех четырёх модалок — фетч по первому клику,
  // кэш на период (сбрасывается вместе с lost/sla ниже).
  const [tileDetail, setTileDetail] = useState<TileDetailKind | null>(null);
  const [tileData, setTileData] = useState<B2bTileDetails | null>(null);
  const [tileLoading, setTileLoading] = useState(false);
  const [tileError, setTileError] = useState<string | null>(null);
  // Drill-down линейных плиток b2g (Фаза 1, спека 25): клик по плитке →
  // разбивка метрики по линиям × менеджерам. Строится client-side из
  // filteredPerManager — сумма всегда равна плитке, запросов к БД нет.
  const [lineTileDetail, setLineTileDetail] = useState<"calls" | "dial" | "minutes" | "missed" | null>(null);
  // Drill-down «Потерянных» b2g (лиды, не звонки) — своя форма (B2gLostLeadItem),
  // отдельно от b2b lostItems (звонки). Ленивый фетч по клику.
  const [lostLeadsOpen, setLostLeadsOpen] = useState(false);
  const [lostLeadsItems, setLostLeadsItems] = useState<B2gLostLeadItem[] | null>(null);
  const [lostLeadsLoading, setLostLeadsLoading] = useState(false);
  const [lostLeadsError, setLostLeadsError] = useState<string | null>(null);
  // Tracks whether we already have data so subsequent refetches don't
  // re-trigger the full-screen DinoLoader (background-refresh UX). Held
  // in a ref because we DON'T want this flag in the fetchData deps —
  // otherwise every setData → ref-change → useCallback recreates →
  // useEffect refires, producing an infinite refetch loop. The bug
  // surfaced as "table data doesn't update on date change" because the
  // loop spammed identical cached responses faster than the user could
  // interact.
  const hasDataRef = useRef(false);

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    if (!hasDataRef.current) setLoading(true);
    setError(null);
    try {
      const fromStr = formatDate(range.start);
      const toStr = formatDate(range.end);
      const verticalParam = vertical ? `&vertical=${vertical}` : "";
      const res = await fetch(
        `/api/dashboard?department=${department}&from=${fromStr}&to=${toStr}${verticalParam}`,
        { signal },
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`API error ${res.status}: ${text}`);
      }
      const json = await res.json();
      setData(json);
      hasDataRef.current = true;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      if (e instanceof TypeError && e.message === "Failed to fetch") return;
      console.error("Dashboard fetch error:", e);
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [department, vertical, range.start, range.end]);

  useEffect(() => {
    const ac = new AbortController();
    fetchData(ac.signal);
    return () => ac.abort();
  }, [fetchData]);

  // ── Период B (сравнение) ─────────────────────────────────────────────
  // Дефолт — предыдущее окно той же длины, стоящее вплотную к A.
  const windowSig = `${formatDate(range.start)}|${formatDate(range.end)}`;
  const compareRange = useMemo(() => {
    if (compareOverride && compareOverride.sig === windowSig) {
      return { start: compareOverride.start, end: compareOverride.end };
    }
    const aFrom = formatDate(range.start);
    const aTo = formatDate(range.end);
    const span = diffDaysCivil(aTo, aFrom) + 1;
    const bTo = addDaysCivil(aFrom, -1);
    const bFrom = addDaysCivil(bTo, -(span - 1));
    return { start: berlinCivilDate(bFrom), end: berlinCivilDate(bTo) };
  }, [compareOverride, windowSig, range.start, range.end]);

  const compareFrom = formatDate(compareRange.start);
  const compareTo = formatDate(compareRange.end);

  useEffect(() => {
    if (!compareOn) return;
    const ac = new AbortController();
    setCompareLoading(true);
    const verticalParam = vertical ? `&vertical=${vertical}` : "";
    fetch(`/api/dashboard?department=${department}&from=${compareFrom}&to=${compareTo}${verticalParam}`, { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (j) setCompareData(j as DashboardData); })
      .catch(() => { /* AbortError / сеть — период B просто не покажется */ })
      .finally(() => setCompareLoading(false));
    return () => ac.abort();
  }, [compareOn, department, vertical, compareFrom, compareTo]);

  // Смена периода/отдела инвалидирует детализации.
  useEffect(() => {
    setLostOpen(false);
    setLostItems(null);
    setLostError(null);
    setSlaOpen(false);
    setSlaItems(null);
    setSlaError(null);
    setTileDetail(null);
    setTileData(null);
    setTileError(null);
    setLineTileDetail(null);
    setLostLeadsOpen(false);
    setLostLeadsItems(null);
    setLostLeadsError(null);
  }, [department, range.start, range.end]);

  // ESC закрывает открытую модалку детализации.
  useEffect(() => {
    if (!lostOpen && !slaOpen && !tileDetail && !lineTileDetail && !lostLeadsOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setLostOpen(false);
        setSlaOpen(false);
        setTileDetail(null);
        setLineTileDetail(null);
        setLostLeadsOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [lostOpen, slaOpen, tileDetail, lineTileDetail, lostLeadsOpen]);

  const toggleLostDetail = useCallback(async () => {
    const next = !lostOpen;
    setLostOpen(next);
    if (!next || lostItems !== null || lostLoading) return;
    setLostLoading(true);
    setLostError(null);
    try {
      const res = await fetch(
        `/api/dashboard/lost-calls?department=${department}&from=${formatDate(range.start)}&to=${formatDate(range.end)}`,
      );
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const json = (await res.json()) as { items: LostCallItem[] };
      setLostItems(json.items);
    } catch (e) {
      setLostError(String(e));
    } finally {
      setLostLoading(false);
    }
  }, [lostOpen, lostItems, lostLoading, department, range.start, range.end]);

  const openTileDetail = useCallback(async (kind: TileDetailKind) => {
    setTileDetail((cur) => (cur === kind ? null : kind));
    if (tileData !== null || tileLoading) return;
    setTileLoading(true);
    setTileError(null);
    try {
      const res = await fetch(
        `/api/dashboard/b2b-tile-details?department=${department}&from=${formatDate(range.start)}&to=${formatDate(range.end)}`,
      );
      if (!res.ok) throw new Error(`API error ${res.status}`);
      setTileData((await res.json()) as B2bTileDetails);
    } catch (e) {
      setTileError(String(e));
    } finally {
      setTileLoading(false);
    }
  }, [tileData, tileLoading, department, range.start, range.end]);

  // «Потерянные» b2g: снимок на конец периода — грузим список лидов лениво.
  const toggleLostLeadsDetail = useCallback(async () => {
    const next = !lostLeadsOpen;
    setLostLeadsOpen(next);
    if (!next || lostLeadsItems !== null || lostLeadsLoading) return;
    setLostLeadsLoading(true);
    setLostLeadsError(null);
    try {
      const verticalParam = vertical ? `&vertical=${vertical}` : "";
      const res = await fetch(
        `/api/dashboard/lost-leads?department=${department}&to=${formatDate(range.end)}${verticalParam}`,
      );
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const json = (await res.json()) as { items: B2gLostLeadItem[] };
      setLostLeadsItems(json.items);
    } catch (e) {
      setLostLeadsError(String(e));
    } finally {
      setLostLeadsLoading(false);
    }
  }, [lostLeadsOpen, lostLeadsItems, lostLeadsLoading, department, vertical, range.end]);

  const toggleSlaDetail = useCallback(async () => {
    const next = !slaOpen;
    setSlaOpen(next);
    if (!next || slaItems !== null || slaLoading) return;
    setSlaLoading(true);
    setSlaError(null);
    try {
      // vertical — чтобы drill-down совпадал с плиткой SLA при выборе Бух/Мед.
      const verticalParam = vertical ? `&vertical=${vertical}` : "";
      const res = await fetch(
        `/api/dashboard/sla-leads?department=${department}&from=${formatDate(range.start)}&to=${formatDate(range.end)}${verticalParam}`,
      );
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const json = (await res.json()) as { items: SlaLeadItem[] };
      setSlaItems(json.items);
    } catch (e) {
      setSlaError(String(e));
    } finally {
      setSlaLoading(false);
    }
  }, [slaOpen, slaItems, slaLoading, department, vertical, range.start, range.end]);

  if (loading && !data) {
    return <DinoLoader />;
  }

  if (error && !data) {
    return (
      <div className="glass-panel rounded-2xl p-8 border border-red-500/20 text-center">
        <AlertTriangle className="w-10 h-10 text-red-400 mx-auto mb-3" />
        <p className="text-red-400 text-sm">{error}</p>
        <button
          onClick={() => fetchData()}
          className="mt-4 px-4 py-2 bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 rounded-lg text-sm transition-colors"
        >
          Попробовать снова
        </button>
      </div>
    );
  }

  if (!data) return null;

  const isRefreshing = loading && !!data;
  const m = data.todayMetrics;
  const missed = data.missedBreakdown;
  const isB2G = department === "b2g";

  // Ростер глобального фильтра «Менеджеры» (B2B): имена таблицы ∪ серии
  // графика (график включает РОПов со звонками, которых нет в таблице).
  // Ростер глобального фильтра «Менеджеры» — для обоих отделов. Имена таблицы
  // ∪ серии графика (график включает РОПов со звонками, которых нет в таблице;
  // на b2g trendByManager пока пуст — заполнится в Фазе 3).
  // b2b: РОВНО строки таблицы «Менеджеры» (master_managers, роли
  // manager/teamlead). Раньше сюда подмешивались имена из серий графика
  // (analytics.communications) — график убран 2026-07-29, а вместе с ним и
  // риск показать в фильтре того, кого нет в таблице (РОПы, старые имена).
  // b2g: график остался — там прежнее объединение.
  const managerNames = Array.from(
    new Set(
      isB2G
        ? [...data.perManager.map((r) => r.name), ...Object.keys(data.trendByManager ?? {})]
        : data.perManager.map((r) => r.name),
    ),
  ).sort((a, b) => a.localeCompare(b, "ru"));
  // Строки таблицы под фильтром. selectedManagers === null («все») → плитки
  // показывают серверные dept-итоги: они включают и звонки, которые не
  // сматчились ни с одним менеджером, поэтому «все» ≠ сумма по строкам.
  const filteredPerManager =
    selectedManagers === null
      ? data.perManager
      : data.perManager.filter((r) => selectedManagers.has(r.name));
  // Детализации «Потерянные»/«SLA» под тем же фильтром — матч по имени
  // менеджера (сервер атрибутирует строки так же, поэтому суммы в модалке
  // сходятся с плитками). Строки «Без менеджера» при активном фильтре скрыты.
  const visibleLostItems =
    lostItems && selectedManagers !== null
      ? lostItems.filter((it) => it.manager != null && selectedManagers.has(it.manager))
      : lostItems;
  // b2b — SLA drill-down под фильтром «Менеджеры»; b2g — SLA dept-level
  // (звонит дайлер, не ответственный), поэтому фильтр по менеджеру не применяем.
  const visibleSlaItems =
    !isB2G && slaItems && selectedManagers !== null
      ? slaItems.filter((it) => it.manager != null && selectedManagers.has(it.manager))
      : slaItems;

  const isSingleDay =
    range.start.getTime() === range.end.getTime() ||
    formatDate(range.start) === formatDate(range.end);

  const shiftDate = (dir: -1 | 1) => {
    // Civil-day arithmetic. The previous `setDate(d + 1)` added 24h browser-
    // local, which crossed DST silently — at the CET↔CEST boundary the next
    // window was offset by 1h and `formatDate` (Berlin TZ) flipped one of
    // the bounds onto an unrelated civil day.
    const startCivil = formatDate(range.start);
    const endCivil = formatDate(range.end);
    const spanDays = diffDaysCivil(endCivil, startCivil) + 1;
    const nextStartCivil = addDaysCivil(startCivil, dir * spanDays);
    const nextEndCivil = addDaysCivil(endCivil, dir * spanDays);
    setRange({
      start: berlinCivilDate(nextStartCivil),
      end: berlinCivilDate(nextEndCivil),
    });
  };

  // All Date objects here are Berlin-midnight UTC instants from the picker.
  // `toLocaleDateString` without a timeZone option reads the user's browser
  // zone — for non-Berlin browsers that produced a label one civil day off
  // from what the picker had highlighted.
  const dateDisplay = isSingleDay
    ? range.start.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Berlin" })
    : `${range.start.toLocaleDateString("ru-RU", { day: "numeric", month: "short", timeZone: "Europe/Berlin" })} — ${range.end.toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/Berlin" })}`;

  // ── Aggregate per-line totals client-side from perManager ─────────────
  // For B2G the user wants every call-stat tile to show three sub-numbers
  // (Line 1 / 2 / 3). We sum perManager rows by `line` field. Источник —
  // filteredPerManager, поэтому глобальный фильтр «Менеджеры» сжимает и
  // построчную разбивку плиток (при selectedManagers===null это те же
  // data.perManager).
  const sumByLine = (line: string | null): {
    callsTotal: number; callsConnected: number; missedIncoming: number;
    totalMinutes: number; incomingTotal: number; outgoingTotal: number;
    dialPercent: number; missedPercent: number;
  } => {
    const rows = filteredPerManager.filter((r) => r.line === line);
    const callsTotal = rows.reduce((s, r) => s + r.callsTotal, 0);
    const callsConnected = rows.reduce((s, r) => s + r.callsConnected, 0);
    const missedIncoming = rows.reduce((s, r) => s + r.missedIncoming, 0);
    const totalMinutes = rows.reduce((s, r) => s + r.totalMinutes, 0);
    const incomingTotal = rows.reduce((s, r) => s + r.incomingTotal, 0);
    const outgoingTotal = rows.reduce((s, r) => s + r.outgoingTotal, 0);
    return {
      callsTotal,
      callsConnected,
      missedIncoming,
      totalMinutes,
      incomingTotal,
      outgoingTotal,
      dialPercent: callsTotal > 0 ? Math.round((callsConnected / callsTotal) * 100) : 0,
      missedPercent: incomingTotal > 0 ? Math.round((missedIncoming / incomingTotal) * 100) : 0,
    };
  };

  const byLine = isB2G
    ? { "1": sumByLine("1"), "2": sumByLine("2"), "3": sumByLine("3") }
    : null;

  // Итоги плиток b2g под глобальным фильтром «Менеджеры». selectedManagers ===
  // null → серверные dept-итоги `m` (включают звонки, не сматченные ни с одним
  // менеджером, поэтому «все» ≠ сумма строк). При выборе — пересчёт из
  // отфильтрованных строк, как в b2b-ветке.
  const b2gEff = (() => {
    if (!isB2G) return null;
    // Всегда dept-итог, фильтр «Менеджеры» НЕ влияет:
    //   • «Потерянные» — лид-based снимок без атрибуции (спека 25 §2);
    //   • SLA — время до первого звонка, а звонит ДАЙЛЕР, не ответственный
    //     менеджер, поэтому пер-менеджерная атрибуция некорректна (2026-07-27).
    const lost = m.lostCalls ?? 0;
    const slaMin = m.slaFirstCallMin ?? 0;
    if (selectedManagers === null) {
      return {
        callsTotal: m.callsTotal, callsConnected: m.callsConnected, dialPercent: m.dialPercent,
        totalMinutes: m.totalMinutes, avgDialogMinutes: m.avgDialogMinutes,
        missedIncoming: m.missedIncoming, incomingTotal: m.incomingTotal,
        outgoingTotal: m.outgoingTotal, missedPercent: missed.missedPercent,
        waitSec: m.unansweredWaitSec ?? null, slaMin, lost,
      };
    }
    const sub = filteredPerManager;
    const callsTotal = sub.reduce((s, r) => s + r.callsTotal, 0);
    const callsConnected = sub.reduce((s, r) => s + r.callsConnected, 0);
    const totalMinutes = sub.reduce((s, r) => s + r.totalMinutes, 0);
    const incomingTotal = sub.reduce((s, r) => s + r.incomingTotal, 0);
    const outgoingTotal = sub.reduce((s, r) => s + r.outgoingTotal, 0);
    const missedIncoming = sub.reduce((s, r) => s + r.missedIncoming, 0);
    // Ожидание — взвешенное по недозвонам (звонок атрибутируется тому, кто
    // его сделал, — это ок). SLA — dept-level (см. выше), фильтр не трогает.
    const unansWeight = sub.reduce((s, r) => s + (r.unansweredOutCount ?? 0), 0);
    const waitSec = unansWeight > 0
      ? Math.round(sub.reduce((s, r) => s + (r.unansweredWaitSeconds ?? 0) * (r.unansweredOutCount ?? 0), 0) / unansWeight)
      : null;
    return {
      callsTotal, callsConnected,
      dialPercent: callsTotal > 0 ? Math.round((callsConnected / callsTotal) * 100) : 0,
      totalMinutes,
      avgDialogMinutes: callsConnected > 0 ? Math.round(totalMinutes / callsConnected) : 0,
      missedIncoming, incomingTotal, outgoingTotal,
      missedPercent: incomingTotal > 0 ? Math.round((missedIncoming / incomingTotal) * 100) : 0,
      waitSec, slaMin, lost,
    };
  })();

  return (
    <div className="flex flex-col gap-4 fade-in">
      {/* ── Filters: single calendar drives the whole view ─────────── */}
      <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
        <div className="flex items-center gap-2 flex-wrap">
          <CalendarPicker
            mode="range"
            allowModeToggle
            value={{ start: range.start, end: range.end }}
            onChange={(r) => {
              if (!r.start) return;
              const end = r.end ?? r.start;
              setRange({ start: r.start, end });
            }}
            onClear={() => {
              const today = todayBerlinDate();
              setRange({ start: today, end: today });
            }}
          />
          {/* Глобальный фильтр «Менеджеры» — фильтрует всю вкладку: плитки,
              таблицы, детализации (b2b — ещё и график; b2g-график по линиям
              не фильтруется до Фазы 3). */}
          {managerNames.length > 0 && (
            <ManagerMultiSelect
              managers={managerNames}
              selected={selectedManagers}
              onChange={setSelectedManagers}
              align="left"
            />
          )}
          {/* «Сравнить периоды» — общий фильтр вкладки (решение 2026-07-29,
              раньше жил внутри блока динамики). Переключает таблицу
              «Менеджеры» в вид A | B | Δ. Только Коммерсы: у Госников
              сравнение осталось в графике динамики. */}
          {!isB2G && (
            <>
              <button
                onClick={() => setCompareOn((v) => !v)}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${compareOn ? "bg-orange-500/20 text-orange-400 border-orange-500/30" : "bg-slate-900/60 text-slate-400 border-white/10 hover:text-slate-200"}`}
              >
                <ArrowLeftRight className="w-3.5 h-3.5" />
                Сравнить периоды
              </button>
              {compareOn && (
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-bold text-orange-400">B</span>
                  <CalendarPicker
                    mode="range"
                    value={{ start: compareRange.start, end: compareRange.end }}
                    onChange={(r) => {
                      if (!r.start) return;
                      setCompareOverride({ sig: windowSig, start: r.start, end: r.end ?? r.start });
                    }}
                    onClear={() => setCompareOverride(null)}
                  />
                  {compareLoading && <Loader2 className="w-3.5 h-3.5 animate-spin text-orange-400" />}
                </div>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button aria-label="Предыдущий период" onClick={() => shiftDate(-1)} className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition-colors">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-sm text-slate-300 font-medium min-w-[180px] text-center">{dateDisplay}</span>
          <button aria-label="Следующий период" onClick={() => shiftDate(1)} className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition-colors">
            <ChevronRight className="w-4 h-4" />
          </button>
          {(!isSingleDay || formatDate(range.start) !== formatDate(todayBerlinDate())) && (
            <button
              onClick={() => {
                const today = todayBerlinDate();
                setRange({ start: today, end: today });
              }}
              className="text-[10px] uppercase tracking-wider px-3 py-1.5 rounded-lg text-blue-400 hover:text-white bg-blue-500/10 hover:bg-blue-500/20 transition-colors border border-blue-500/20"
            >
              Сегодня
            </button>
          )}
          <button
            onClick={() => fetchData()}
            disabled={loading}
            className="p-2 rounded-lg hover:bg-white/5 text-slate-400 hover:text-white transition-colors disabled:opacity-50"
            title="Обновить"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {isRefreshing && (
        <div className="flex items-center justify-center py-2">
          <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-blue-500/10 border border-blue-500/20">
            <Loader2 className="w-3 h-3 animate-spin text-blue-400" />
            <span className="text-[10px] text-blue-400 font-medium">Обновление данных...</span>
          </div>
        </div>
      )}

      {/* ============ KPI tiles ============ */}
      {isB2G && b2gEff ? (
        // B2G — как у Комм: одиночные плитки. Переключатель направления (линии)
        // скоупит 4 звонковые плитки; Ожидание/SLA/Потерянные — по отделу.
        (() => {
          const cv = b2gLine === "all"
            ? b2gEff
            : (() => {
                const v = byLine![b2gLine];
                return {
                  callsTotal: v.callsTotal, callsConnected: v.callsConnected, dialPercent: v.dialPercent,
                  totalMinutes: v.totalMinutes,
                  avgDialogMinutes: v.callsConnected > 0 ? Math.round(v.totalMinutes / v.callsConnected) : 0,
                  missedIncoming: v.missedIncoming, incomingTotal: v.incomingTotal,
                  outgoingTotal: v.outgoingTotal, missedPercent: v.missedPercent,
                };
              })();
          const deptCap = b2gLine === "all" ? undefined : "по отделу";
          const LINE_PILLS = [
            ["all", "Все"], ["1", LINE_SHORT["1"]], ["2", LINE_SHORT["2"]], ["3", LINE_SHORT["3"]],
          ] as const;
          return (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-0.5 bg-slate-900/60 border border-white/10 rounded-lg p-0.5 self-start">
                {LINE_PILLS.map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setB2gLine(key)}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${b2gLine === key ? "bg-blue-500/20 text-blue-300" : "text-slate-400 hover:text-slate-200"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
                <CallMetricTile
                  icon={Phone} label="Звонки" color="blue"
                  totalValue={cv.callsTotal} totalCaption={`${cv.outgoingTotal}↑ ${cv.incomingTotal}↓`}
                  rows={null} onClick={() => setLineTileDetail("calls")}
                  tip="Все звонки (исходящие + входящие) за период. Клик — разбивка по линиям и менеджерам."
                />
                <CallMetricTile
                  icon={Target} label="Дозвон"
                  color={cv.dialPercent >= 50 ? "emerald" : cv.dialPercent >= 30 ? "amber" : "rose"}
                  totalValue={`${cv.dialPercent}%`} totalCaption={`${cv.callsConnected}/${cv.callsTotal}`}
                  rows={null} onClick={() => setLineTileDetail("dial")}
                  tip="Доля звонков с ответом (длительность ≥ 1 сек). Клик — разбивка по линиям и менеджерам."
                />
                <CallMetricTile
                  icon={Clock} label="На линии" color="blue"
                  totalValue={`${cv.totalMinutes}м`} totalCaption={`ср. ${cv.avgDialogMinutes}м`}
                  rows={null} onClick={() => setLineTileDetail("minutes")}
                  tip="Суммарная длительность разговоров за период. Клик — разбивка по линиям и менеджерам."
                />
                <CallMetricTile
                  icon={PhoneMissed} label="Пропущенные"
                  color={cv.missedIncoming === 0 ? "emerald" : cv.missedIncoming <= 3 ? "amber" : "rose"}
                  totalValue={cv.missedIncoming} totalCaption={`${cv.missedPercent}% от ${cv.incomingTotal}`}
                  rows={null} onClick={() => setLineTileDetail("missed")}
                  tip="Входящие без ответа (< 1 сек). Клик — разбивка по линиям и менеджерам."
                />
                {/* Дальше — по всему отделу, вне зависимости от выбранной линии. */}
                <CallMetricTile
                  icon={Timer} label="Ожидание" color="blue"
                  totalValue={b2gEff.waitSec == null ? "—" : `${b2gEff.waitSec}с`}
                  totalCaption={b2gLine === "all" ? "по недозвонам" : "отдел · недозвоны"} rows={null}
                  onClick={() => openTileDetail("wait")}
                  tip="Среднее время гудков в неотвеченных исходящих (от набора до сброса), по всему отделу. Обе платформы (CloudTalk + CallGear). Клик — разбивка по платформам и менеджерам."
                />
                <CallMetricTile
                  icon={Gauge} label="SLA" color="blue" totalValue={`${b2gEff.slaMin}м`}
                  totalCaption={deptCap} rows={null} onClick={toggleSlaDetail}
                  tip="Среднее календарное время от создания лида до первого звонка по нему (реальный wall-clock, вкл. вечер/выходные — дайлер звонит и вне будних 9–18), по всему отделу. Клик — детализация по сделкам."
                />
                <CallMetricTile
                  icon={PhoneOff} label="Потерянные"
                  color={b2gEff.lost === 0 ? "emerald" : "rose"}
                  totalValue={b2gEff.lost} totalCaption={deptCap} rows={null}
                  tipAlign="right"
                  tip="Лиды на этапе «Новый лид»/«Недозвон», по которым последний звонок был больше 24 часов назад (или звонков не было вовсе), по всему отделу. Снимок на конец периода. Клик — список лидов."
                  onClick={toggleLostLeadsDetail}
                />
              </div>
            </div>
          );
        })()
      ) : (
        // B2B — 7 single-number tiles, no captions. % дозвона = принятые
        // исходящие / все исходящие (≤100%). Ожидание = средний answer-wait
        // (сек). SLA = среднее время до 1-го звонка (мин).
        (() => {
          // При активном фильтре «Менеджеры» плитки пересчитываются из
          // perManager-строк: суммы напрямую, Ожидание/SLA — взвешенные
          // средние (веса: отвеченные звонки / slaLeadCount). Без фильтра —
          // серверные dept-итоги (включают несматченные звонки), как раньше.
          const sub = selectedManagers === null ? null : filteredPerManager;
          const outgoing = sub === null ? m.outgoingTotal : sub.reduce((s, r) => s + r.outgoingTotal, 0);
          const answeredOut = sub === null ? m.outgoingConnected ?? 0 : sub.reduce((s, r) => s + r.outgoingConnected, 0);
          const dialPct = outgoing > 0 ? Math.round((answeredOut / outgoing) * 100) : 0;
          const totalMinutes = sub === null ? m.totalMinutes : sub.reduce((s, r) => s + r.totalMinutes, 0);
          // «Ожидание» = среднее гудков в неотвеченных исходящих. При фильтре
          // «Менеджеры» — взвешенное среднее по выбранным (вес = количество
          // их недозвонов).
          let waitSec: number | null = m.unansweredWaitSec ?? null;
          let slaMin = m.slaFirstCallMin ?? 0;
          if (sub !== null) {
            const unansWeight = sub.reduce((s, r) => s + (r.unansweredOutCount ?? 0), 0);
            waitSec = unansWeight > 0
              ? Math.round(sub.reduce((s, r) => s + (r.unansweredWaitSeconds ?? 0) * (r.unansweredOutCount ?? 0), 0) / unansWeight)
              : null;
            const slaWeight = sub.reduce((s, r) => s + (r.slaLeadCount ?? 0), 0);
            slaMin = slaWeight > 0
              ? Math.round(sub.reduce((s, r) => s + r.slaFirstCallMin * (r.slaLeadCount ?? 0), 0) / slaWeight)
              : 0;
          }
          const lost = sub === null ? m.lostCalls ?? 0 : sub.reduce((s, r) => s + (r.lostCalls ?? 0), 0);
          return (
            // 7 колонок под 7 плиток — после удаления «Всего» (спека 22 п.4)
            // 8-колоночная сетка оставляла дыру справа.
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
              <CallMetricTile
                icon={PhoneOutgoing} label="Исходящие" color="blue" totalValue={outgoing} rows={null}
                onClick={() => openTileDetail("outgoing")}
                tip="Количество исходящих звонков (наборов). Сумма CloudTalk и CallGear. Клик — разбивка по платформам и менеджерам."
              />
              {/* Плитка «Всего» (исх+вх) убрана по просьбе Рузанны (спека 22
                  п.4, созвон: «мне это вообще не надо») — набор: Исходящие,
                  Принятых, % дозвона, Длительность, Ожидание, SLA, Потерянные. */}
              <CallMetricTile
                icon={PhoneCall} label="Принятых" color="emerald" totalValue={answeredOut} rows={null}
                onClick={() => openTileDetail("answered")}
                tip="Исходящие, на которые ответили (длительность ≥ 1 сек). Клик — разбивка по платформам и менеджерам."
              />
              <CallMetricTile
                icon={Target}
                label="% дозвона"
                color={dialPct >= 50 ? "emerald" : dialPct >= 30 ? "amber" : "rose"}
                totalValue={`${dialPct}%`}
                rows={null}
                onClick={() => openTileDetail("hourly")}
                tip="Доля исходящих, на которые ответили: принятые ÷ исходящие. Клик — дозваниваемость по часам дня."
              />
              <CallMetricTile
                icon={Clock} label="Длительность" color="blue" totalValue={fmtHoursMinutes(totalMinutes)} rows={null}
                tip="Суммарная длительность по всем звонкам, как её считают кабинеты телефоний: CloudTalk — время разговора, CallGear — полное время звонка."
              />
              <CallMetricTile
                icon={Timer} label="Ожидание" color="blue"
                totalValue={waitSec == null ? "—" : `${waitSec}с`}
                totalCaption="по недозвонам" rows={null}
                onClick={() => openTileDetail("wait")}
                tip="Среднее время гудков в неотвеченных исходящих (от набора до сброса). Обе платформы (CloudTalk + CallGear). Клик — разбивка по платформам и менеджерам."
              />
              <CallMetricTile
                icon={Gauge} label="SLA" color="blue" totalValue={`${slaMin}м`} rows={null}
                onClick={toggleSlaDetail}
                tipAlign="right"
                tipWide
                tip={
                  <div className="flex flex-col gap-1.5 text-left">
                    <p>
                      <span className="text-slate-100 font-semibold">Рабочее время</span> от входа лида
                      в статус «Новый лид» (Бух Комм) до первого звонка по лиду.
                    </p>
                    <p>Рабочее время — по графику смен ответственного менеджера (файл РОПа).</p>
                    <div>
                      <p className="text-slate-100 font-semibold mb-0.5">Корнер-кейсы:</p>
                      <ul className="list-disc pl-4 space-y-0.5">
                        <li>лид не попадал в «Новый лид» — не считается;</li>
                        <li>звонок раньше или в момент входа — SLA = 0;</li>
                        <li>звонка нет, лид закрыт — не считается;</li>
                        <li>звонка нет, лид открыт — от входа до текущего момента.</li>
                      </ul>
                    </div>
                    <p>
                      Не считаются лиды категории D, с флагом «Исключить из аналитики» и с
                      причинами отказа: Спам, Неквал лид, Гос. клиент, Неправильный контакт,
                      Предложение сотрудничества, Дубль госник, Бух дубль, Мед дубль.
                    </p>
                    <p className="text-slate-500">Клик — детализация по сделкам.</p>
                  </div>
                }
              />
              <CallMetricTile
                icon={PhoneOff}
                label="Потерянные"
                color={lost === 0 ? "emerald" : "rose"}
                totalValue={lost}
                rows={null}
                tipAlign="right"
                tip="Входящие звонки клиентов в рабочие часы по Графику, на которые никто не ответил и не перезвонил на этот номер в течение 15 минут. Исходящие недозвоны сюда не входят. Клик — детализация: время, клиент, номер, сделка."
                onClick={toggleLostDetail}
              />
              {/* tipAlign right on the last two so the popover opens leftward
                  and doesn't clip past the viewport edge. */}
            </div>
          );
        })()
      )}

      {/* ============ KPI-ПЛИТКИ — DRILL-DOWN МОДАЛКА (B2B) ============ */}
      {tileDetail && typeof document !== "undefined" && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-start justify-center pt-12 px-4 bg-black/70 backdrop-blur-sm"
          onClick={() => setTileDetail(null)}
          role="dialog"
          aria-modal="true"
          tabIndex={-1}
        >
          <div
            className="w-full max-w-3xl max-h-[85vh] overflow-hidden flex flex-col rounded-2xl bg-slate-900 border border-white/10 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            role="document"
          >
            <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-white/5 bg-slate-950/60">
              <h3 className="text-sm font-bold text-blue-400 flex items-center gap-2 min-w-0">
                {tileDetail === "outgoing" && <><PhoneOutgoing className="w-4 h-4 shrink-0" /><span className="truncate">Исходящие — по платформам</span></>}
                {tileDetail === "answered" && <><PhoneCall className="w-4 h-4 shrink-0" /><span className="truncate">Принятые — по платформам</span></>}
                {tileDetail === "hourly" && <><Target className="w-4 h-4 shrink-0" /><span className="truncate">Дозвон по часам дня (Берлин)</span></>}
                {tileDetail === "wait" && <><Timer className="w-4 h-4 shrink-0" /><span className="truncate">Ожидание ответа — детализация</span></>}
              </h3>
              <button
                onClick={() => setTileDetail(null)}
                className="text-xs text-slate-500 hover:text-slate-300 transition-colors shrink-0"
              >
                Закрыть ✕
              </button>
            </div>
            <div className="overflow-y-auto px-5 py-4">
              {tileLoading && (
                <div className="flex items-center gap-2 text-slate-400 text-sm py-4">
                  <Loader2 className="w-4 h-4 animate-spin" /> Загружаю…
                </div>
              )}
              {tileError && <p className="text-rose-400 text-sm py-2">{tileError}</p>}
              {tileData && <TileDetailContent kind={tileDetail} d={tileData} />}
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* ============ ПОТЕРЯННЫЕ — DRILL-DOWN МОДАЛКА (спека 22 п.6, B2B) ============ */}
      {!isB2G && lostOpen && typeof document !== "undefined" && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-start justify-center pt-12 px-4 bg-black/70 backdrop-blur-sm"
          onClick={() => setLostOpen(false)}
          role="dialog"
          aria-modal="true"
          tabIndex={-1}
        >
          <div
            className="w-full max-w-3xl max-h-[85vh] overflow-hidden flex flex-col rounded-2xl bg-slate-900 border border-white/10 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            role="document"
          >
            <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-white/5 bg-slate-950/60">
              <h3 className="text-sm font-bold text-rose-400 flex items-center gap-2 min-w-0">
                <PhoneOff className="w-4 h-4 shrink-0" />
                <span className="truncate">Потерянные входящие — детализация</span>
                {visibleLostItems && <span className="text-slate-500 font-normal shrink-0">({visibleLostItems.length})</span>}
              </h3>
              <button
                onClick={() => setLostOpen(false)}
                className="text-xs text-slate-500 hover:text-slate-300 transition-colors shrink-0"
              >
                Закрыть ✕
              </button>
            </div>

            <div className="overflow-y-auto px-5 py-4">
          {lostLoading && (
            <div className="flex items-center gap-2 text-slate-400 text-sm py-4">
              <Loader2 className="w-4 h-4 animate-spin" /> Загружаю…
            </div>
          )}
          {lostError && <p className="text-rose-400 text-sm py-2">{lostError}</p>}

          {visibleLostItems && visibleLostItems.length === 0 && (
            <p className="text-slate-400 text-sm py-2">За выбранный период потерянных входящих нет 🎉</p>
          )}

          {visibleLostItems && visibleLostItems.length > 0 && (() => {
            // Группировка по ответственному МОПу (Рузанна: «разбито по мопам»).
            // У Коммерсов входящие падают в общую очередь без агента, поэтому
            // почти всё уходит в одну группу «Входящие — никто не взял».
            const byManager = new Map<string, LostCallItem[]>();
            for (const it of visibleLostItems) {
              const key = it.kind === "in_missed"
                ? "Входящие — никто не взял"
                : it.manager || "Без менеджера";
              const arr = byManager.get(key) ?? [];
              arr.push(it);
              byManager.set(key, arr);
            }
            const groups = [...byManager.entries()].sort((a, b) => b[1].length - a[1].length);
            return (
              <div className="flex flex-col gap-4">
                {groups.map(([mgrName, items]) => (
                  <div key={mgrName}>
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-sm font-semibold text-slate-200">{mgrName}</span>
                      <span className="text-xs px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-400 font-bold">{items.length}</span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500 border-b border-white/10">
                            <th className="py-1.5 pr-3 font-medium">Время</th>
                            <th className="py-1.5 pr-3 font-medium">Клиент</th>
                            <th className="py-1.5 pr-3 font-medium">Телефон</th>
                            <th className="py-1.5 pr-3 font-medium">Сделка</th>
                            <th className="py-1.5 font-medium">Воронка / статус</th>
                          </tr>
                        </thead>
                        <tbody>
                          {items.map((it, i) => (
                            <tr key={`${it.phone}-${it.createdAt}-${i}`} className="border-b border-white/5 hover:bg-white/[0.02]">
                              <td className="py-1.5 pr-3 text-slate-400 whitespace-nowrap tabular-nums">{fmtLostAt(it.createdAt)}</td>
                              <td className="py-1.5 pr-3 text-slate-200">{it.clientName ?? <span className="text-slate-600">—</span>}</td>
                              <td className="py-1.5 pr-3 text-slate-200 font-mono text-xs">{it.phone}</td>
                              <td className="py-1.5 pr-3">
                                {it.leadId ? (
                                  <a
                                    href={kommoLeadUrl(it.leadId)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-blue-400 hover:text-blue-300 hover:underline"
                                  >
                                    #{it.leadId} ↗
                                  </a>
                                ) : (
                                  <span className="text-slate-600">не привязан</span>
                                )}
                              </td>
                              <td className="py-1.5 text-slate-400 text-xs">
                                {it.pipelineName ? `${it.pipelineName}${it.statusName ? ` · ${it.statusName}` : ""}` : "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* ============ SLA — DRILL-DOWN МОДАЛКА (спека 22 п.5.3, B2B) ============ */}
      {slaOpen && typeof document !== "undefined" && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-start justify-center pt-12 px-4 bg-black/70 backdrop-blur-sm"
          onClick={() => setSlaOpen(false)}
          role="dialog"
          aria-modal="true"
          tabIndex={-1}
        >
          <div
            className="w-full max-w-3xl max-h-[85vh] overflow-hidden flex flex-col rounded-2xl bg-slate-900 border border-white/10 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            role="document"
          >
            <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-white/5 bg-slate-950/60">
              <h3 className="text-sm font-bold text-blue-400 flex items-center gap-2 min-w-0">
                <Gauge className="w-4 h-4 shrink-0" />
                <span className="truncate">SLA — из каких сделок состоит среднее</span>
                {visibleSlaItems && visibleSlaItems.length > 0 && (
                  <span className="text-slate-500 font-normal shrink-0">
                    ({visibleSlaItems.length} · ср. {Math.round(visibleSlaItems.reduce((s, x) => s + x.slaMinutes, 0) / visibleSlaItems.length)}м)
                  </span>
                )}
              </h3>
              <button
                onClick={() => setSlaOpen(false)}
                className="text-xs text-slate-500 hover:text-slate-300 transition-colors shrink-0"
              >
                Закрыть ✕
              </button>
            </div>

            <div className="overflow-y-auto px-5 py-4">
              {slaLoading && (
                <div className="flex items-center gap-2 text-slate-400 text-sm py-4">
                  <Loader2 className="w-4 h-4 animate-spin" /> Загружаю…
                </div>
              )}
              {slaError && <p className="text-rose-400 text-sm py-2">{slaError}</p>}
              {visibleSlaItems && visibleSlaItems.length === 0 && (
                <p className="text-slate-400 text-sm py-2">За выбранный период SLA-сделок нет.</p>
              )}
              {visibleSlaItems && visibleSlaItems.length > 0 && (() => {
                // b2g — плоский список без группировки по ответственному
                // менеджеру: звонит дайлер, поэтому атрибуция SLA к
                // ответственному вводит в заблуждение (2026-07-27).
                if (isB2G) {
                  const items = [...visibleSlaItems].sort((a, b) => b.slaMinutes - a.slaMinutes);
                  return (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500 border-b border-white/10">
                            <th className="py-1.5 pr-3 font-medium">Сделка</th>
                            <th className="py-1.5 pr-3 font-medium">Клиент</th>
                            <th className="py-1.5 pr-3 font-medium">Телефон</th>
                            <th className="py-1.5 font-medium text-right">SLA</th>
                          </tr>
                        </thead>
                        <tbody>
                          {items.map((it) => (
                            <tr key={it.leadId} className="border-b border-white/5 hover:bg-white/[0.02]">
                              <td className="py-1.5 pr-3">
                                <a href={kommoLeadUrl(it.leadId)} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 hover:underline font-mono text-xs break-all">
                                  {kommoLeadUrl(it.leadId)}
                                </a>
                              </td>
                              <td className="py-1.5 pr-3 text-slate-200">{it.clientName ?? <span className="text-slate-600">—</span>}</td>
                              <td className="py-1.5 pr-3 text-slate-200 font-mono text-xs">{it.phone ?? "—"}</td>
                              <td className={`py-1.5 text-right tabular-nums font-semibold ${it.slaMinutes >= 30 ? "text-rose-400" : "text-slate-200"}`}>
                                {fmtHoursMinutes(it.slaMinutes)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  );
                }
                const byManager = new Map<string, SlaLeadItem[]>();
                for (const it of visibleSlaItems) {
                  const key = it.manager || "Без менеджера";
                  const arr = byManager.get(key) ?? [];
                  arr.push(it);
                  byManager.set(key, arr);
                }
                const groups = [...byManager.entries()].sort((a, b) => b[1].length - a[1].length);
                return (
                  <div className="flex flex-col gap-4">
                    {groups.map(([mgrName, items]) => {
                      const avg = Math.round(items.reduce((s, x) => s + x.slaMinutes, 0) / items.length);
                      return (
                        <div key={mgrName}>
                          <div className="flex items-center gap-2 mb-1.5">
                            <span className="text-sm font-semibold text-slate-200">{mgrName}</span>
                            <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400 font-bold">{items.length}</span>
                            <span className="text-xs text-slate-500">ср. {avg}м</span>
                          </div>
                          <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                              <thead>
                                <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500 border-b border-white/10">
                                  <th className="py-1.5 pr-3 font-medium">Сделка</th>
                                  <th className="py-1.5 pr-3 font-medium">Клиент</th>
                                  <th className="py-1.5 pr-3 font-medium">Телефон</th>
                                  <th className="py-1.5 pr-3 font-medium text-right">SLA</th>
                                  {/* Статус (sla_own_status) осмыслен только для b2b —
                                      для b2g он всегда пуст, колонку скрываем. */}
                                  {!isB2G && <th className="py-1.5 font-medium">Статус</th>}
                                </tr>
                              </thead>
                              <tbody>
                                {items.map((it) => {
                                  const st = it.slaStatus ? SLA_STATUS_LABEL[it.slaStatus] : undefined;
                                  return (
                                    <tr key={it.leadId} className="border-b border-white/5 hover:bg-white/[0.02]">
                                      <td className="py-1.5 pr-3">
                                        {/* Текст ссылки = сам URL (просьба Рузанны 2026-07-20):
                                            РОП копирует ссылки из детализации в переписку. */}
                                        <a
                                          href={kommoLeadUrl(it.leadId)}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="text-blue-400 hover:text-blue-300 hover:underline font-mono text-xs break-all"
                                        >
                                          {kommoLeadUrl(it.leadId)}
                                        </a>
                                      </td>
                                      <td className="py-1.5 pr-3 text-slate-200">{it.clientName ?? <span className="text-slate-600">—</span>}</td>
                                      <td className="py-1.5 pr-3 text-slate-200 font-mono text-xs">{it.phone ?? "—"}</td>
                                      <td className={`py-1.5 pr-3 text-right tabular-nums font-semibold ${it.slaMinutes >= 30 ? "text-rose-400" : "text-slate-200"}`}>
                                        {fmtHoursMinutes(it.slaMinutes)}
                                      </td>
                                      {!isB2G && (
                                        <td className="py-1.5">
                                          {st ? (
                                            <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${st.cls}`}>{st.label}</span>
                                          ) : (
                                            <span className="text-slate-600 text-xs">—</span>
                                          )}
                                        </td>
                                      )}
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* ====== DRILL-DOWN ЛИНЕЙНЫХ ПЛИТОК (b2g, Фаза 1) — по линиям×менеджерам ====== */}
      {isB2G && lineTileDetail && typeof document !== "undefined" && createPortal(
        (() => {
          const meta: Record<string, { title: string }> = {
            calls: { title: "Звонки" }, dial: { title: "Дозвон" },
            minutes: { title: "На линии" }, missed: { title: "Пропущенные" },
          };
          const groups = [
            { key: "1", title: "Квалификатор (1я линия)", cls: "text-emerald-400" },
            { key: "2", title: "Бератер (2я линия)", cls: "text-purple-400" },
            { key: "3", title: "Доведение (3я линия)", cls: "text-sky-400" },
            { key: "__none__", title: "Руководители (без линии)", cls: "text-amber-400" },
          ];
          const rowVal = (r: PerManagerRow): number =>
            lineTileDetail === "calls" ? r.callsTotal
              : lineTileDetail === "minutes" ? r.totalMinutes
                : lineTileDetail === "dial" ? r.callsConnected
                  : r.missedIncoming;
          const cell = (r: PerManagerRow): string =>
            lineTileDetail === "dial"
              ? `${r.callsConnected}/${r.callsTotal} (${r.dialPercent}%)`
              : lineTileDetail === "minutes" ? `${r.totalMinutes}м`
                : String(rowVal(r));
          return (
            <div
              className="fixed inset-0 z-50 flex items-start justify-center pt-12 px-4 bg-black/70 backdrop-blur-sm"
              onClick={() => setLineTileDetail(null)}
              role="dialog" aria-modal="true" tabIndex={-1}
            >
              <div
                className="w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col rounded-2xl bg-slate-900 border border-white/10 shadow-2xl"
                onClick={(e) => e.stopPropagation()} role="document"
              >
                <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-white/5 bg-slate-950/60">
                  <h3 className="text-sm font-bold text-blue-400 truncate">
                    {meta[lineTileDetail].title} — по линиям и менеджерам
                  </h3>
                  <button onClick={() => setLineTileDetail(null)} className="text-xs text-slate-500 hover:text-slate-300 transition-colors shrink-0">Закрыть ✕</button>
                </div>
                <div className="overflow-y-auto px-5 py-4 flex flex-col gap-4">
                  {/* Скоуп drill-down = выбранная линия (иначе — все линии),
                      чтобы сумма совпадала с плиткой при активном переключателе. */}
                  {groups.filter((g) => b2gLine === "all" || g.key === b2gLine).map((g) => {
                    const rows = filteredPerManager
                      .filter((r) => (g.key === "__none__" ? !r.line : r.line === g.key))
                      .filter((r) => rowVal(r) > 0)
                      .sort((a, b) => rowVal(b) - rowVal(a));
                    if (rows.length === 0) return null;
                    const subtotal = rows.reduce((s, r) => s + rowVal(r), 0);
                    return (
                      <div key={g.key}>
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className={`text-sm font-semibold ${g.cls}`}>{g.title}</span>
                          <span className="text-xs text-slate-500">
                            {lineTileDetail === "dial" ? `${subtotal} дозвонов` : lineTileDetail === "minutes" ? `${subtotal}м` : subtotal}
                          </span>
                        </div>
                        <table className="w-full text-sm">
                          <tbody>
                            {rows.map((r) => (
                              <tr key={r.id} className="border-b border-white/5">
                                <td className="py-1.5 pr-3 text-slate-200 truncate max-w-[220px]">{r.name}</td>
                                <td className="py-1.5 text-right tabular-nums text-slate-300">{cell(r)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })(),
        document.body,
      )}

      {/* ====== «ПОТЕРЯННЫЕ» (b2g) — DRILL-DOWN: список лидов (спека 25 §2) ====== */}
      {isB2G && lostLeadsOpen && typeof document !== "undefined" && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-start justify-center pt-12 px-4 bg-black/70 backdrop-blur-sm"
          onClick={() => setLostLeadsOpen(false)}
          role="dialog" aria-modal="true" tabIndex={-1}
        >
          <div
            className="w-full max-w-3xl max-h-[85vh] overflow-hidden flex flex-col rounded-2xl bg-slate-900 border border-white/10 shadow-2xl"
            onClick={(e) => e.stopPropagation()} role="document"
          >
            <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-white/5 bg-slate-950/60">
              <h3 className="text-sm font-bold text-rose-400 flex items-center gap-2 min-w-0">
                <PhoneOff className="w-4 h-4 shrink-0" />
                <span className="truncate">Потерянные лиды — без звонка &gt; 24ч</span>
                {lostLeadsItems && <span className="text-slate-500 font-normal shrink-0">({lostLeadsItems.length})</span>}
              </h3>
              <button onClick={() => setLostLeadsOpen(false)} className="text-xs text-slate-500 hover:text-slate-300 transition-colors shrink-0">Закрыть ✕</button>
            </div>
            <div className="overflow-y-auto px-5 py-4">
              {lostLeadsLoading && (
                <div className="flex items-center gap-2 text-slate-400 text-sm py-4">
                  <Loader2 className="w-4 h-4 animate-spin" /> Загружаю…
                </div>
              )}
              {lostLeadsError && <p className="text-rose-400 text-sm py-2">{lostLeadsError}</p>}
              {lostLeadsItems && lostLeadsItems.length === 0 && (
                <p className="text-slate-400 text-sm py-2">Потерянных лидов на конец периода нет 🎉</p>
              )}
              {lostLeadsItems && lostLeadsItems.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500 border-b border-white/10">
                        <th className="py-1.5 pr-3 font-medium">Клиент</th>
                        <th className="py-1.5 pr-3 font-medium">Сделка</th>
                        <th className="py-1.5 pr-3 font-medium">Воронка / этап</th>
                        <th className="py-1.5 pr-3 font-medium">Ответственный</th>
                        <th className="py-1.5 font-medium">Последний звонок</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lostLeadsItems.map((it) => (
                        <tr key={it.leadId} className="border-b border-white/5 hover:bg-white/[0.02]">
                          <td className="py-1.5 pr-3 text-slate-200">{it.clientName ?? <span className="text-slate-600">—</span>}</td>
                          <td className="py-1.5 pr-3">
                            <a href={kommoLeadUrl(it.leadId)} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 hover:underline">#{it.leadId} ↗</a>
                          </td>
                          <td className="py-1.5 pr-3 text-slate-400 text-xs">
                            {it.pipelineName ? `${it.pipelineName}${it.stageName ? ` · ${it.stageName}` : ""}` : "—"}
                          </td>
                          <td className="py-1.5 pr-3 text-slate-300">{it.manager ?? <span className="text-slate-600">—</span>}</td>
                          <td className="py-1.5 text-slate-400 whitespace-nowrap tabular-nums">
                            {it.lastCallAt ? fmtLostAt(it.lastCallAt) : <span className="text-rose-400/80">не звонили</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* ============ PER-MANAGER TABLE — режим СРАВНЕНИЯ (Коммерсы) ============
           Плоско, по референсу «Оценки критериев»: строки — менеджеры, у
           каждой метрики тройка колонок A | B | Δ, сверху жирная строка
           «Всего». Тумблеров-раскрывашек нет намеренно — все значения должны
           читаться одним взглядом (фидбек 2026-07-28). */}
      {!isB2G && compareOn && (
        <ManagerCompareTable
          rowsA={filteredPerManager}
          rowsB={compareData?.perManager ?? null}
          selected={selectedManagers}
          labelA={`${fmtCmpRange(formatDate(range.start), formatDate(range.end))}`}
          labelB={`${fmtCmpRange(compareFrom, compareTo)}`}
          loading={compareLoading}
        />
      )}

      {/* ============ PER-MANAGER TABLE — обычный режим ============
           Скоуп по переключателю линий (b2g): «Все» → все менеджеры плоско;
           линия → только её менеджеры. Колонки одинаковы для обоих отделов. */}
      {!(compareOn && !isB2G) && (() => {
        const tableManagers = isB2G && b2gLine !== "all"
          ? filteredPerManager.filter((mgr) => mgr.line === b2gLine)
          : filteredPerManager;
        if (tableManagers.length === 0) return null;
        const tableTitle = isB2G && b2gLine !== "all" ? LINE_SHORT[b2gLine] : "Менеджеры";
        return (
          <div className="glass-panel rounded-2xl p-5 border border-white/5">
            <h3 className="text-slate-300 font-semibold tracking-wide text-xs uppercase mb-4">
              <span className="text-blue-400">{tableTitle}</span>
              <span className="text-slate-500 ml-2">({tableManagers.length} чел.)</span>
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-slate-500 text-[10px] uppercase tracking-wider border-b border-white/5">
                    <th className="text-left py-2 px-2 font-medium">Менеджер</th>
                    <th className="text-right py-2 px-2 font-medium">Исходящие</th>
                    <th className="text-right py-2 px-2 font-medium">Принятых</th>
                    <th className="text-right py-2 px-2 font-medium">% дозв.</th>
                    <th className="text-right py-2 px-2 font-medium">Длительность</th>
                    <th className="text-right py-2 px-2 font-medium" title="Среднее время гудков в неотвеченных исходящих — как плитка «Ожидание» (по недозвонам)">Ожидание</th>
                    <th className="text-right py-2 px-2 font-medium">SLA</th>
                    <th className="text-right py-2 px-2 font-medium">Всего</th>
                  </tr>
                </thead>
                <tbody>
                  {tableManagers.map((mgr) => {
                    // % дозвона = принятые исходящие / все исходящие (≤100%).
                    const dialPct = mgr.outgoingTotal > 0
                      ? Math.round((mgr.outgoingConnected / mgr.outgoingTotal) * 100)
                      : 0;
                    return (
                    <tr key={mgr.id} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
                      <td className="py-2 px-2 text-white font-medium truncate max-w-[140px]">{mgr.name}</td>
                      <td className="py-2 px-2 text-right text-slate-300">{mgr.outgoingTotal}</td>
                      <td className="py-2 px-2 text-right text-slate-300">{mgr.outgoingConnected}</td>
                      <td className="py-2 px-2 text-right">
                        <span className={dialPct >= 50 ? "text-emerald-400" : dialPct >= 30 ? "text-amber-400" : "text-rose-400"}>
                          {dialPct}%
                        </span>
                      </td>
                      <td className="py-2 px-2 text-right text-slate-300">{fmtHoursMinutes(mgr.totalMinutes)}</td>
                      {/* Ожидание — по недозвонам в обоих отделах (решение
                          2026-07-28): среднее гудков в НЕОТВЕЧЕННЫХ исходящих,
                          как у плитки «Ожидание». Раньше b2b показывал здесь
                          avgWaitSeconds (по отвеченным) — числа расходились
                          с плиткой и это путало. */}
                      <td
                        className="py-2 px-2 text-right text-slate-300"
                        title={
                          mgr.unansweredOutCount
                            ? `Среднее по ${mgr.unansweredOutCount} недозвонам за период (сверено с CloudTalk 1в1)`
                            : "Недозвонов за период не было — среднее считать не из чего"
                        }
                      >
                        {mgr.unansweredWaitSeconds ? `${mgr.unansweredWaitSeconds} с` : "—"}
                      </td>
                      <td className="py-2 px-2 text-right text-slate-300">{mgr.slaFirstCallMin} мин</td>
                      <td className="py-2 px-2 text-right text-slate-300">{mgr.callsTotal}</td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      {/* ============ TREND — per manager (ТОЛЬКО b2g) ============
           График по линиям; набор менеджеров скоупится выбранной линией поверх
           глобального фильтра «Менеджеры». У Коммерсов блока динамики больше
           нет (решение 2026-07-29): и график, и сменившая его таблица убраны —
           сравнение периодов переехало в таблицу «Менеджеры» выше. */}
      {isB2G && (() => {
        let chartSelected = selectedManagers;
        if (b2gLine !== "all") {
          const lineNames = new Set(
            data.perManager.filter((r) => r.line === b2gLine).map((r) => r.name),
          );
          chartSelected = selectedManagers === null
            ? lineNames
            : new Set([...selectedManagers].filter((n) => lineNames.has(n)));
        }
        return (
          <TrendChartByManager
            trend={data.trend}
            trendByManager={data.trendByManager ?? null}
            department={department}
            vertical={vertical}
            selected={chartSelected}
          />
        );
      })()}
    </div>
  );
}

// ==================== KPI tile — compact, fits 4-in-a-row ====================

// Generic row for the tile breakdown — works for B2G lines (Л1/Л2/Л3) and
// for B2B pipelines (БК/МК) without the component caring which dimension
// it's slicing.
// ─── Содержимое drill-down модалки KPI-плиток B2B ────────────────────────────
// Четыре вида: платформенная разбивка исходящих/принятых (менеджер × платформа),
// почасовая дозваниваемость, ожидание ответа по платформам и менеджерам.

function fmtSec(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}с`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}м ${String(s).padStart(2, "0")}с`;
}

function dialPctCls(pct: number): string {
  return pct >= 50 ? "text-emerald-400" : pct >= 30 ? "text-amber-400" : "text-rose-400";
}

function TileDetailContent({ kind, d }: { kind: TileDetailKind; d: B2bTileDetails }) {
  if (kind === "hourly") {
    const maxOut = Math.max(1, ...d.hourly.map((h) => h.outgoing));
    return (
      <div className="flex flex-col gap-1.5">
        <p className="text-xs text-slate-500 mb-2">
          Наборы и принятые по часам начала звонка — видно, в какие окна дозваниваемость выше.
        </p>
        {d.hourly.length === 0 && <p className="text-slate-400 text-sm">Нет исходящих за период.</p>}
        {d.hourly.map((h) => {
          const pct = h.outgoing > 0 ? Math.round((h.connected / h.outgoing) * 100) : 0;
          return (
            <div key={h.hour} className="flex items-center gap-3 text-sm">
              <span className="w-14 shrink-0 text-slate-400 tabular-nums">{String(h.hour).padStart(2, "0")}:00</span>
              <div className="flex-1 h-4 bg-slate-800/60 rounded overflow-hidden">
                <div className="h-full bg-blue-500/40 rounded" style={{ width: `${(h.outgoing / maxOut) * 100}%` }} />
              </div>
              <span className="w-16 shrink-0 text-right text-slate-300 tabular-nums">{h.connected}/{h.outgoing}</span>
              <span className={`w-12 shrink-0 text-right font-bold tabular-nums ${dialPctCls(pct)}`}>{pct}%</span>
            </div>
          );
        })}
        <p className="text-[11px] text-slate-600 mt-2">принятые/наборы · % дозвона за час</p>
      </div>
    );
  }

  if (kind === "wait") {
    return (
      <div className="flex flex-col gap-5">
        <p className="text-xs text-slate-500">
          Среднее время гудков в <span className="text-slate-300">неотвеченных</span> исходящих
          (от набора до сброса).
        </p>
        <div>
          <h4 className="text-[11px] uppercase tracking-wider text-slate-500 mb-2">По платформам</h4>
          <div className="grid grid-cols-2 gap-2">
            {d.waitPlatforms.map((p) => (
              <div key={p.platform} className="rounded-xl border border-white/5 bg-slate-950/50 p-3">
                <div className="text-xs text-slate-400">{p.platform}</div>
                <div className="text-xl font-black text-slate-100 mt-0.5">{fmtSec(p.avgWaitSec)}</div>
                <div className="text-[11px] text-slate-500 mt-0.5">макс {fmtSec(p.maxWaitSec)} · {p.unanswered} недозв.</div>
              </div>
            ))}
          </div>
        </div>
        <div>
          <h4 className="text-[11px] uppercase tracking-wider text-slate-500 mb-2">По менеджерам</h4>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500 border-b border-white/10">
                <th className="py-1.5 pr-3 font-medium">Менеджер</th>
                <th className="py-1.5 pr-3 font-medium text-right">Ср. ожидание</th>
                <th className="py-1.5 font-medium text-right">Недозвонов</th>
              </tr>
            </thead>
            <tbody>
              {d.waitManagers.map((m) => (
                <tr key={m.manager} className="border-b border-white/5">
                  <td className="py-1.5 pr-3 text-slate-200">{m.manager}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-slate-300">{fmtSec(m.avgWaitSec)}</td>
                  <td className="py-1.5 text-right tabular-nums text-slate-400">{m.unanswered}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-slate-600">
          Ожидание недозвона: CloudTalk — поле waiting_time; CallGear — вся длительность
          безответного звонка (гудки). В кабинетах телефоний такой метрики нет — их виджеты
          «ожидания» считают другое (очередь входящих / все звонки).
        </p>
      </div>
    );
  }

  // outgoing / answered — платформенные карточки + менеджер × платформа.
  const answeredMode = kind === "answered";
  const platformNames = d.platforms.map((p) => p.platform);
  const byMgr = new Map<string, Map<string, { outgoing: number; connected: number }>>();
  for (const row of d.managerPlatforms) {
    const inner = byMgr.get(row.manager) ?? new Map<string, { outgoing: number; connected: number }>();
    inner.set(row.platform, { outgoing: row.outgoing, connected: row.connected });
    byMgr.set(row.manager, inner);
  }
  const mgrRows = [...byMgr.entries()]
    .map(([manager, inner]) => {
      const total = [...inner.values()].reduce(
        (a, v) => a + (answeredMode ? v.connected : v.outgoing), 0,
      );
      return { manager, inner, total };
    })
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total);

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-2">
        {d.platforms.map((p) => {
          const pct = p.outgoing > 0 ? Math.round((p.connected / p.outgoing) * 100) : 0;
          return (
            <div key={p.platform} className="rounded-xl border border-white/5 bg-slate-950/50 p-3">
              <div className="text-xs text-slate-400">{p.platform}</div>
              <div className="text-xl font-black text-slate-100 mt-0.5">
                {answeredMode ? p.connected : p.outgoing}
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">
                {answeredMode
                  ? `ср. разговор ${p.connected > 0 ? fmtSec(p.talkSeconds / p.connected) : "—"}`
                  : <>дозвон <span className={dialPctCls(pct)}>{pct}%</span> · принято {p.connected}</>}
              </div>
            </div>
          );
        })}
      </div>
      <div>
        <h4 className="text-[11px] uppercase tracking-wider text-slate-500 mb-2">Менеджер × платформа</h4>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500 border-b border-white/10">
                <th className="py-1.5 pr-3 font-medium">Менеджер</th>
                {platformNames.map((p) => (
                  <th key={p} className="py-1.5 pr-3 font-medium text-right">{p}</th>
                ))}
                <th className="py-1.5 font-medium text-right">Всего</th>
              </tr>
            </thead>
            <tbody>
              {mgrRows.map((r) => (
                <tr key={r.manager} className="border-b border-white/5">
                  <td className="py-1.5 pr-3 text-slate-200">{r.manager}</td>
                  {platformNames.map((p) => {
                    const v = r.inner.get(p);
                    const n = v ? (answeredMode ? v.connected : v.outgoing) : 0;
                    return (
                      <td key={p} className="py-1.5 pr-3 text-right tabular-nums text-slate-300">
                        {n > 0 ? n : <span className="text-slate-600">—</span>}
                      </td>
                    );
                  })}
                  <td className="py-1.5 text-right tabular-nums font-bold text-slate-200">{r.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

interface TileRow {
  key: string;
  label: string;
  colorClass: string;
  value: string | number;
}

function CallMetricTile({
  icon: Icon,
  label,
  totalValue,
  totalCaption,
  color,
  rows,
  tip,
  tipWide = false,
  tipAlign = "left",
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  totalValue: string | number;
  totalCaption?: string;
  color: "blue" | "emerald" | "amber" | "rose";
  rows: TileRow[] | null;
  // Optional hover explanation, glass-panel styled. Shown below the tile.
  // ReactNode — для структурированных подсказок (список корнер-кейсов SLA).
  tip?: React.ReactNode;
  // Широкий поповер (w-72) для структурированных подсказок; default w-52.
  tipWide?: boolean;
  // Which edge the tooltip anchors to — "right" opens leftward so the
  // rightmost tiles don't clip past the viewport. Default "left".
  tipAlign?: "left" | "right";
  // Кликабельная плитка (drill-down). Пока используется только в B2B-ветке
  // (rows === null) — «Потерянные».
  onClick?: () => void;
}) {
  const colorMap = {
    blue: { bg: "bg-blue-500/10", text: "text-blue-400" },
    emerald: { bg: "bg-emerald-500/10", text: "text-emerald-400" },
    amber: { bg: "bg-amber-500/10", text: "text-amber-400" },
    rose: { bg: "bg-rose-500/10", text: "text-rose-400" },
  };
  const c = colorMap[color];

  // ── B2B — single big number (no line concept) ──────────────────────
  if (!rows) {
    return (
      <div
        onClick={onClick}
        role={onClick ? "button" : undefined}
        title={onClick ? "Нажми — детализация" : undefined}
        className={`group relative glass-panel rounded-xl p-3 border border-white/5 hover:border-blue-500/20 transition-all min-w-0 ${onClick ? "cursor-pointer hover:border-rose-500/40" : ""}`}
      >
        <div className="flex items-start justify-between mb-1.5 gap-1">
          <span className="text-slate-400 font-semibold tracking-tight text-[10px] uppercase leading-tight break-words min-w-0">{label}</span>
          <div className={`p-1 ${c.bg} rounded ${c.text} shrink-0`}>
            <Icon className="w-3 h-3" />
          </div>
        </div>
        <div className={`text-2xl font-bold ${c.text} tracking-tight`}>{totalValue}</div>
        {totalCaption && <div className="text-[10px] text-slate-500 mt-0.5 truncate">{totalCaption}</div>}
        {tip && (
          <div
            role="tooltip"
            className={`pointer-events-none absolute ${tipAlign === "right" ? "right-0" : "left-0"} top-full mt-2 z-30 ${tipWide ? "w-72" : "w-52"} max-w-[80vw] rounded-lg border border-white/10 bg-slate-900/95 backdrop-blur px-2.5 py-2 text-[11px] leading-snug text-slate-300 shadow-xl opacity-0 transition-opacity duration-150 group-hover:opacity-100`}
          >
            {tip}
          </div>
        )}
      </div>
    );
  }

  // ── B2G — compact tile: header + 3 line rows. Each row: tiny line tag
  //    on the left, large number on the right. Captions dropped to keep
  //    width minimal so 4 tiles fit in a row from sm breakpoint onward.
  //    onClick (спека 25 Фаза 1) → drill-down по линиям×менеджерам. ─
  return (
    <div
      onClick={onClick}
      role={onClick ? "button" : undefined}
      title={onClick ? "Нажми — детализация" : undefined}
      className={`glass-panel rounded-xl p-3 border border-white/5 hover:border-blue-500/20 transition-all min-w-0 flex flex-col ${onClick ? "cursor-pointer hover:border-blue-500/40" : ""}`}
    >
      <div className="flex items-center justify-between mb-1.5 gap-1.5">
        <div className="min-w-0 flex-1">
          <div className="text-slate-400 font-semibold tracking-wider text-[10px] uppercase truncate">{label}</div>
          <div className="flex items-baseline gap-1 mt-0.5">
            <span className={`text-base font-bold ${c.text} tracking-tight tabular-nums`}>{totalValue}</span>
            {totalCaption && <span className="text-[9px] text-slate-500 truncate">{totalCaption}</span>}
          </div>
        </div>
        <div className={`p-1 ${c.bg} rounded ${c.text} shrink-0`}>
          <Icon className="w-3 h-3" />
        </div>
      </div>

      <div className="flex flex-col gap-1 pt-1.5 border-t border-white/5">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center justify-between gap-2">
            <span className={`text-[10px] font-semibold uppercase tracking-wider ${r.colorClass} shrink-0`}>
              {r.label}
            </span>
            <span className={`text-base font-bold tabular-nums ${r.colorClass} tracking-tight truncate`}>
              {r.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ==================== B2B trend chart: line per manager ====================
// Метрика (Звонки/Дозвон/Пропущенные) выбирается пилюлей, менеджеры — мульти-
// селектом. По линии на выбранного менеджера; пусто → все менеджеры.

// Палитра линий (различимы на тёмном фоне; повторяется по кругу при 12+).
const MANAGER_LINE_COLORS = [
  "#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899",
  "#06b6d4", "#84cc16", "#f97316", "#14b8a6", "#a855f7", "#eab308",
];

type TrendMetric = "callsTotal" | "callsConnected" | "missedIncoming";
const METRIC_PILLS: { key: TrendMetric; label: string }[] = [
  { key: "callsTotal", label: "Звонки" },
  { key: "callsConnected", label: "Дозвон" },
  { key: "missedIncoming", label: "Пропущенные" },
];

// Мультиселект менеджеров. selected === null означает «все». Внешний вид —
// 1в1 как фильтр «Менеджеры» на вкладке Активность (TrackingTab): кнопка с
// иконкой и подписью «Все (N)» / «k/N» / «никто», непрозрачный поповер с
// шапкой (счётчик + Все/Снять) и квадратными чекбоксами.
function ManagerMultiSelect({ managers, selected, onChange, align = "right" }: {
  managers: string[];
  selected: Set<string> | null;
  onChange: (next: Set<string> | null) => void;
  /** Край кнопки, к которому прижат дропдаун. В шапке вкладки (слева у
      календаря) нужен "left", иначе список уезжает за левый край экрана. */
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const isAll = selected === null;
  const count = isAll ? managers.length : selected.size;
  const toggle = (m: string) => {
    const base = isAll ? new Set(managers) : new Set(selected);
    if (base.has(m)) base.delete(m);
    else base.add(m);
    // Снова выбраны все → возвращаемся к null (=«все»), чтобы новые менеджеры
    // в следующих периодах тоже попадали в выборку.
    onChange(base.size === managers.length ? null : base);
  };

  const buttonLabel = isAll
    ? `Все (${managers.length})`
    : count === 0
      ? "никто"
      : `${count}/${managers.length}`;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-800/50 border border-white/5 hover:bg-slate-800 text-xs text-slate-300 transition-all"
      >
        <Users className="w-3.5 h-3.5" />
        Менеджеры
        <span className="text-slate-500">{buttonLabel}</span>
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className={`absolute ${align === "left" ? "left-0" : "right-0"} mt-1 z-30 w-64 max-h-72 bg-slate-900 rounded-xl border border-white/10 shadow-2xl overflow-hidden flex flex-col`}>
          <div className="flex items-center gap-2 px-3 py-2 border-b border-white/5 bg-slate-950">
            <span className="text-xs font-semibold text-white">Менеджеры</span>
            <span className="text-[11px] text-slate-400 ml-auto">{count}/{managers.length}</span>
            <button type="button" onClick={() => onChange(null)} className="text-[11px] text-blue-400 hover:text-blue-300 px-1.5">
              Все
            </button>
            <button type="button" onClick={() => onChange(new Set())} className="text-[11px] text-rose-400 hover:text-rose-300 px-1.5">
              Снять
            </button>
          </div>
          <div className="overflow-y-auto flex-1 px-2 py-2 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">
            {managers.map((m) => {
              const checked = isAll || selected.has(m);
              return (
                <label
                  key={m}
                  className="flex items-center gap-2 px-2 py-1 rounded-md text-xs cursor-pointer hover:bg-white/5"
                >
                  <span
                    className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${
                      checked ? "bg-blue-500 border-blue-500" : "border-slate-600"
                    }`}
                  >
                    {checked && <Check className="w-2.5 h-2.5 text-white" strokeWidth={3} />}
                  </span>
                  <input type="checkbox" checked={checked} onChange={() => toggle(m)} className="sr-only" />
                  <span className="text-slate-200 truncate">{m}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// Список civil-дат [from..to] включительно (для x-оси произвольного периода A).
function civilDateRange(from: string, to: string): string[] {
  const out: string[] = [];
  let d = from;
  let guard = 0;
  while (d <= to && guard < 400) { out.push(d); d = addDaysCivil(d, 1); guard++; }
  return out;
}

function TrendChartByManager({ trendByManager, department, vertical, selected }: {
  trend: DailyBucket[];
  trendByManager: Record<string, DailyBucket[]> | null;
  department: string;
  vertical?: "buh" | "med" | "all";
  /** Глобальный фильтр «Менеджеры» из шапки вкладки (null = все). */
  selected: Set<string> | null;
}) {
  const [metric, setMetric] = useState<TrendMetric>("callsTotal");
  const [compareOn, setCompareOn] = useState(false);
  // Оба периода сравнения (A и B) — независимый ручной выбор, помеченный
  // сигнатурой основного окна: при смене окна override «протухает» и мы падаем
  // на дефолт (A = окно дашборда, B = предыдущее равное). Без setState-in-effect.
  const [periodAOverride, setPeriodAOverride] = useState<{ sig: string; start: Date; end: Date } | null>(null);
  const [periodBOverride, setPeriodBOverride] = useState<{ sig: string; start: Date; end: Date } | null>(null);
  const [dataA, setDataA] = useState<Record<string, DailyBucket[]> | null>(null);
  const [dataB, setDataB] = useState<Record<string, DailyBucket[]> | null>(null);
  const [loadingA, setLoadingA] = useState(false);
  const [loadingB, setLoadingB] = useState(false);

  const managers = useMemo(
    () => Object.keys(trendByManager ?? {}).sort((a, b) => a.localeCompare(b, "ru")),
    [trendByManager],
  );
  const visible = useMemo(
    () => (selected === null ? managers : managers.filter((m) => selected.has(m))),
    [managers, selected],
  );

  // Даты текущего окна (все серии padded одинаково → берём из первой).
  const currentDates = useMemo(
    () => (trendByManager && managers.length ? (trendByManager[managers[0]] ?? []).map((d) => d.date) : []),
    [trendByManager, managers],
  );
  const windowSig = `${currentDates[0] ?? ""}|${currentDates.length}`;

  // Имя менеджера → id (master_managers), для сверки с manager_schedule
  // (тот же справочник, что использует Дейли/Активность — не гейтится ролью).
  const [managerIdByName, setManagerIdByName] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/daily/managers?department=${department}`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        const map: Record<string, string> = {};
        for (const m of (j.managers ?? []) as Array<{ id: string; name: string }>) map[m.name] = m.id;
        setManagerIdByName(map);
      })
      .catch(() => { if (!cancelled) setManagerIdByName({}); });
    return () => { cancelled = true; };
  }, [department]);

  // Дефолт A = окно дашборда; дефолт B = предыдущее равное окно перед ним.
  const defaultA = useMemo(() => {
    if (currentDates.length === 0) return null;
    return { start: berlinCivilDate(currentDates[0]), end: berlinCivilDate(currentDates[currentDates.length - 1]) };
  }, [currentDates]);
  const defaultB = useMemo(() => {
    if (currentDates.length === 0) return null;
    const prevEnd = addDaysCivil(currentDates[0], -1);
    const prevStart = addDaysCivil(prevEnd, -(currentDates.length - 1));
    return { start: berlinCivilDate(prevStart), end: berlinCivilDate(prevEnd) };
  }, [currentDates]);

  // customA = пользователь переопределил A для текущего окна (иначе A = окно дашборда).
  const customA = !!(periodAOverride && periodAOverride.sig === windowSig);
  const effA = useMemo(
    () => (customA && periodAOverride ? { start: periodAOverride.start, end: periodAOverride.end } : defaultA),
    [customA, periodAOverride, defaultA],
  );
  const effB = useMemo(
    () => (periodBOverride && periodBOverride.sig === windowSig
      ? { start: periodBOverride.start, end: periodBOverride.end }
      : defaultB),
    [periodBOverride, windowSig, defaultB],
  );
  const aFrom = effA ? formatDate(effA.start) : null;
  const aTo = effA ? formatDate(effA.end) : null;
  const bFrom = effB ? formatDate(effB.start) : null;
  const bTo = effB ? formatDate(effB.end) : null;

  // Фетч per-manager тренда за период (setState — в callback, не в теле эффекта).
  const fetchInto = useCallback(
    async (
      from: string,
      to: string,
      setData: (d: Record<string, DailyBucket[]> | null) => void,
      setLoading: (b: boolean) => void,
    ) => {
      setLoading(true);
      try {
        const vParam = vertical && department === "b2g" ? `&vertical=${vertical}` : "";
        const res = await fetch(`/api/dashboard/manager-trend?department=${department}&from=${from}&to=${to}${vParam}`);
        const j = await res.json();
        setData(j.success ? j.trendByManager : null);
      } catch {
        setData(null);
      } finally {
        setLoading(false);
      }
    },
    [department, vertical],
  );

  // A фетчим только когда он переопределён (по умолчанию A = данные дашборда).
  useEffect(() => {
    if (!compareOn || !customA || !aFrom || !aTo) return;
    fetchInto(aFrom, aTo, setDataA, setLoadingA);
  }, [compareOn, customA, aFrom, aTo, fetchInto]);

  useEffect(() => {
    if (!compareOn || !bFrom || !bTo) return;
    fetchInto(bFrom, bTo, setDataB, setLoadingB);
  }, [compareOn, bFrom, bTo, fetchInto]);

  // x-ось = дни периода A (если A = окно дашборда, берём готовые currentDates;
  // если A переопределён — генерим диапазон и берём dataA). Период B
  // накладывается по индексу дня (день N ↔ день N).
  const xDates = useMemo(
    () => (compareOn && customA ? (aFrom && aTo ? civilDateRange(aFrom, aTo) : []) : currentDates),
    [compareOn, customA, aFrom, aTo, currentDates],
  );

  // Выходные менеджеров (manager_schedule.is_on_line=false) на видимых датах —
  // подтягиваем по месяцам, которые реально попадают в окно графика.
  const [offDays, setOffDays] = useState<Set<string>>(new Set()); // `${userId}|${date}`
  useEffect(() => {
    if (xDates.length === 0) { setOffDays(new Set()); return; }
    const months = Array.from(new Set(xDates.map((d) => d.slice(0, 7))));
    let cancelled = false;
    Promise.all(
      months.map((mo) =>
        fetch(`/api/daily/schedule?month=${mo}`).then((r) => r.json()).catch(() => null),
      ),
    ).then((results) => {
      if (cancelled) return;
      const set = new Set<string>();
      for (const res of results) {
        const schedule = res?.schedule as Array<{ userId: string; scheduleDate: string; isOnLine: boolean }> | undefined;
        if (!schedule) continue;
        for (const row of schedule) {
          if (!row.isOnLine) set.add(`${row.userId}|${row.scheduleDate}`);
        }
      }
      setOffDays(set);
    });
    return () => { cancelled = true; };
  }, [xDates]);

  const chartData = useMemo(() => {
    if (managers.length === 0 || xDates.length === 0) return [];
    const seriesA = compareOn && customA ? dataA : trendByManager;
    const seriesB = compareOn ? dataB : null;
    const rows: Array<Record<string, string | number | null>> = xDates.map((date, idx) => {
      const row: Record<string, string | number | null> = { date: date.slice(5).replace("-", ".") };
      for (const m of visible) {
        row[m] = seriesA?.[m]?.[idx]?.[metric] ?? 0;
        if (seriesB) {
          const cv = seriesB[m]?.[idx]?.[metric];
          if (cv != null) row[`${m}__cmp`] = cv;
        }
      }
      return row;
    });
    // Серый оверлей на выходных: точка входит в `${m}__off`, только если
    // ЭТОТ день подтверждённо выходной у менеджера — без захвата соседних
    // дней. Раньше захватывали ±1 день ради бесшовности при type="monotone",
    // но с переходом на type="linear" (см. фикс излома на стыках) это больше
    // не нужно: прямая между двумя точками — всегда одна и та же прямая,
    // независимо от того, какая серия её рисует, так что стык остаётся
    // бесшовным и без искусственного расширения на соседние (рабочие) дни.
    for (const m of visible) {
      const id = managerIdByName?.[m];
      if (!id) continue;
      const isOff = xDates.map((d) => offDays.has(`${id}|${d}`));
      if (!isOff.some(Boolean)) continue;
      for (let idx = 0; idx < rows.length; idx++) {
        rows[idx][`${m}__off`] = isOff[idx] ? rows[idx][m] : null;
      }
    }
    return rows;
  }, [managers, visible, metric, compareOn, customA, dataA, dataB, trendByManager, xDates, managerIdByName, offDays]);

  const fmtRange = (a: string, b: string) => `${a.slice(5).replace("-", ".")}–${b.slice(5).replace("-", ".")}`;

  const header = (
    <div className="flex items-start justify-between mb-4 gap-3 flex-wrap">
      <div className="min-w-0">
        <h3 className="text-slate-300 font-semibold tracking-wide text-xs uppercase">Динамика звонков по дням</h3>
        {compareOn && aFrom && aTo && bFrom && bTo && (
          <div className="text-[10px] text-slate-500 mt-1 flex items-center gap-2 flex-wrap">
            <span>A: {fmtRange(aFrom, aTo)}</span>
            <span className="text-slate-600">·</span>
            <span className="border-b border-dashed border-slate-500">B: {fmtRange(bFrom, bTo)}</span>
            {(loadingA || loadingB) && <Loader2 className="w-3 h-3 animate-spin" />}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-0.5 bg-slate-900/60 border border-white/10 rounded-lg p-0.5">
          {METRIC_PILLS.map((p) => (
            <button
              key={p.key}
              onClick={() => setMetric(p.key)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${metric === p.key ? "bg-blue-500/20 text-blue-300" : "text-slate-400 hover:text-slate-200"}`}
            >
              {p.label}
            </button>
          ))}
        </div>
        {/* Мультиселект «Менеджеры» переехал в шапку вкладки (глобальный
            фильтр) — график получает выбор через проп selected. */}
        <button
          onClick={() => setCompareOn((v) => !v)}
          className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${compareOn ? "bg-blue-500/20 text-blue-300 border-blue-500/40" : "bg-slate-900/60 text-slate-400 border-white/10 hover:text-slate-200"}`}
        >
          Сравнить периоды
        </button>
        {compareOn && effA && effB && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] font-bold text-slate-500">A</span>
            <CalendarPicker
              mode="range"
              value={{ start: effA.start, end: effA.end }}
              onChange={(r) => {
                if (!r.start) return;
                setPeriodAOverride({ sig: windowSig, start: r.start, end: r.end ?? r.start });
              }}
              onClear={() => setPeriodAOverride(null)}
            />
            <span className="text-[10px] font-bold text-slate-500">B</span>
            <CalendarPicker
              mode="range"
              value={{ start: effB.start, end: effB.end }}
              onChange={(r) => {
                if (!r.start) return;
                setPeriodBOverride({ sig: windowSig, start: r.start, end: r.end ?? r.start });
              }}
              onClear={() => setPeriodBOverride(null)}
            />
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="glass-panel rounded-2xl p-5 border border-white/5">
      {header}
      {managers.length === 0 ? (
        <div className="py-10 text-center text-slate-500 text-sm">Нет данных по менеджерам за период</div>
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={chartData} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
            <XAxis dataKey="date" tick={{ fill: "#64748b", fontSize: 11 }} axisLine={{ stroke: "#334155" }} tickLine={false} />
            <YAxis tick={{ fill: "#64748b", fontSize: 11 }} axisLine={false} tickLine={false} allowDecimals={false} />
            <RTooltip contentStyle={{ background: "#0f172a", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12 }} />
            <Legend wrapperStyle={{ fontSize: 11, color: "#94a3b8" }} />
            {visible.flatMap((m) => {
              const color = MANAGER_LINE_COLORS[managers.indexOf(m) % MANAGER_LINE_COLORS.length];
              const lines = [
                // linear, не monotone: серый оверлей на выходных (ниже) должен
                // стыковаться с этой линией в общих граничных точках. Monotone
                // считает кривизну по своим соседям независимо для каждой
                // серии — даже совпадая в точке, две monotone-кривые подходят
                // к ней под разными углами и дают видимый излом на стыке.
                // Прямая между теми же двумя точками — всегда одна и та же.
                <Line key={m} type="linear" dataKey={m} name={m} stroke={color} strokeWidth={2} dot={{ fill: color, r: 2 }} connectNulls />,
              ];
              // Пунктирная линия периода сравнения — тот же цвет менеджера,
              // скрыта из легенды (иначе двоится), видна в тултипе как «(пред.)».
              if (compareOn && dataB) {
                lines.push(
                  <Line key={`${m}__cmp`} type="linear" dataKey={`${m}__cmp`} name={`${m} (B)`} stroke={color} strokeWidth={2} strokeDasharray="4 3" strokeOpacity={0.65} dot={false} legendType="none" connectNulls />,
                );
              }
              // Серый отрезок поверх цветной линии на выходных днях менеджера
              // (см. offDays/chartData выше). Рисуется последним — ложится
              // поверх цветной линии на нужном участке. Точка (dot) обязательна:
              // без соседнего выходного дня Recharts не рисует сегмент по одной
              // non-null точке (нужно ≥2 смежных), и изолированный однодневный
              // выходной иначе пропадал бы с графика совсем — точка остаётся
              // видна даже когда линии нет.
              lines.push(
                <Line key={`${m}__off`} type="linear" dataKey={`${m}__off`} name={`${m} · выходной`} stroke="#64748b" strokeWidth={3} strokeOpacity={0.9} dot={{ fill: "#64748b", r: 3 }} legendType="none" isAnimationActive={false} connectNulls={false} />,
              );
              return lines;
            })}
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}


// ==================== Сравнение периодов: таблица «Менеджеры» (Коммерсы) ====================
//
// Референс — сравнение в «Оценке критериев»: строки-сущности, у каждой метрики
// колонки A (синяя) | B (оранжевая) | Δ. Плоско, без раскрывашек: все значения
// видны одним взглядом (фидбек 2026-07-28). Данные периода B — второй ответ
// того же /api/dashboard, поэтому обе колонки считаются одними формулами.

/** Короткая подпись периода «дд.мм–дд.мм». */
function fmtCmpRange(from: string, to: string): string {
  const dm = (s: string) => `${s.slice(8, 10)}.${s.slice(5, 7)}`;
  return from === to ? dm(from) : `${dm(from)}–${dm(to)}`;
}

/** Метрики сравнения. invert=true → рост это ухудшение (Ожидание, SLA). */
const CMP_METRICS: Array<{
  key: string;
  label: string;
  invert: boolean;
  /** Значение метрики у строки; null — считать не из чего (нет базы среднего). */
  value: (r: PerManagerRow) => number | null;
  fmt: (v: number) => string;
  /** Единица дельты («% дозв.» меряется в п.п.). */
  deltaUnit: string;
}> = [
  { key: "out", label: "Исходящие", invert: false, value: (r) => r.outgoingTotal, fmt: (v) => String(v), deltaUnit: "" },
  { key: "conn", label: "Принятых", invert: false, value: (r) => r.outgoingConnected, fmt: (v) => String(v), deltaUnit: "" },
  {
    key: "dial", label: "% дозв.", invert: false,
    value: (r) => (r.outgoingTotal > 0 ? Math.round((r.outgoingConnected / r.outgoingTotal) * 100) : null),
    fmt: (v) => `${v}%`, deltaUnit: " п.п.",
  },
  { key: "min", label: "Длительность", invert: false, value: (r) => r.totalMinutes, fmt: (v) => fmtHoursMinutes(v), deltaUnit: " мин" },
  {
    key: "wait", label: "Ожидание", invert: true,
    value: (r) => (r.unansweredWaitSeconds ? r.unansweredWaitSeconds : null),
    fmt: (v) => `${v} с`, deltaUnit: " с",
  },
  {
    key: "sla", label: "SLA", invert: true,
    value: (r) => (r.slaFirstCallMin ? r.slaFirstCallMin : null),
    fmt: (v) => `${v} мин`, deltaUnit: " мин",
  },
];

function cmpDeltaCls(a: number | null, b: number | null, invert: boolean): string {
  if (a == null || b == null) return "text-slate-600";
  const d = a - b;
  if (d === 0) return "text-slate-500";
  return (d > 0) !== invert ? "text-emerald-400" : "text-rose-400";
}

function cmpDeltaText(a: number | null, b: number | null, unit: string): string {
  if (a == null || b == null) return "—";
  const d = Math.round((a - b) * 10) / 10;
  return `${d > 0 ? "+" : ""}${d}${unit}`;
}

function ManagerCompareTable({ rowsA, rowsB, selected, labelA, labelB, loading }: {
  rowsA: PerManagerRow[];
  rowsB: PerManagerRow[] | null;
  selected: Set<string> | null;
  labelA: string;
  labelB: string;
  loading: boolean;
}) {
  // Объединение менеджеров обоих периодов (в B мог работать уже уволенный, в
  // A — новичок), под тем же глобальным фильтром «Менеджеры».
  const byNameA = new Map(rowsA.map((r) => [r.name, r]));
  const byNameB = new Map((rowsB ?? []).map((r) => [r.name, r]));
  const names = Array.from(new Set([...rowsA.map((r) => r.name), ...(rowsB ?? []).map((r) => r.name)]))
    .filter((n) => selected === null || selected.has(n))
    .sort((a, b) => (byNameA.get(b)?.outgoingTotal ?? 0) - (byNameA.get(a)?.outgoingTotal ?? 0) || a.localeCompare(b, "ru"));

  /** Итог столбца: счётчики суммируем, средние — взвешенно (как плитки). */
  const totals = (rows: PerManagerRow[]): PerManagerRow => {
    const acc = rows.filter((r) => selected === null || selected.has(r.name));
    const unansWeight = acc.reduce((s, r) => s + (r.unansweredOutCount ?? 0), 0);
    const slaWeight = acc.reduce((s, r) => s + (r.slaLeadCount ?? 0), 0);
    return {
      id: "__total__", name: "Всего", line: null, kommoUserId: null,
      callsTotal: acc.reduce((s, r) => s + r.callsTotal, 0),
      callsConnected: acc.reduce((s, r) => s + r.callsConnected, 0),
      dialPercent: 0,
      totalMinutes: acc.reduce((s, r) => s + r.totalMinutes, 0),
      avgDialogMinutes: 0,
      missedIncoming: 0,
      incomingTotal: 0,
      outgoingTotal: acc.reduce((s, r) => s + r.outgoingTotal, 0),
      outgoingConnected: acc.reduce((s, r) => s + r.outgoingConnected, 0),
      avgWaitSeconds: 0,
      unansweredWaitSeconds: unansWeight > 0
        ? Math.round(acc.reduce((s, r) => s + (r.unansweredWaitSeconds ?? 0) * (r.unansweredOutCount ?? 0), 0) / unansWeight)
        : 0,
      unansweredOutCount: unansWeight,
      slaFirstCallMin: slaWeight > 0
        ? Math.round(acc.reduce((s, r) => s + r.slaFirstCallMin * (r.slaLeadCount ?? 0), 0) / slaWeight)
        : 0,
      slaLeadCount: slaWeight,
      lostCalls: acc.reduce((s, r) => s + r.lostCalls, 0),
      overdueTasks: 0,
    };
  };

  const rowCells = (a: PerManagerRow | undefined, b: PerManagerRow | undefined, bold: boolean) =>
    CMP_METRICS.map((mm) => {
      const va = a ? mm.value(a) : null;
      const vb = b ? mm.value(b) : null;
      const cls = `py-2 px-3 text-right tabular-nums text-[12px] ${bold ? "font-semibold text-white" : "text-slate-300"}`;
      return (
        <Fragment key={mm.key}>
          <td title={labelA} className={`${cls} border-l border-white/10`}>{va == null ? "—" : mm.fmt(va)}</td>
          <td title={labelB} className={cls}>{vb == null ? "—" : mm.fmt(vb)}</td>
          <td
            title={`A − B${mm.invert ? " (рост = хуже)" : ""}`}
            className={`py-2 px-3 text-right tabular-nums text-[12px] ${bold ? "font-semibold" : ""} ${cmpDeltaCls(va, vb, mm.invert)}`}
          >
            {cmpDeltaText(va, vb, mm.deltaUnit)}
          </td>
        </Fragment>
      );
    });

  const tA = totals(rowsA);
  const tB = rowsB ? totals(rowsB) : undefined;

  return (
    <div className="glass-panel rounded-2xl p-5 border border-white/5">
      <h3 className="text-slate-300 font-semibold tracking-wide text-xs uppercase mb-4 flex items-baseline gap-x-3 gap-y-1 flex-wrap">
        <span className="text-blue-400">Менеджеры — сравнение периодов</span>
        <span className="text-blue-400">A · {labelA}</span>
        <span className="text-orange-400">B · {labelB}</span>
        {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-orange-400" />}
      </h3>
      {!rowsB && !loading && (
        <p className="text-slate-500 text-sm py-2">Период B не загрузился — обновите страницу.</p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-slate-900 min-w-[170px] py-2 px-2" />
              {CMP_METRICS.map((mm) => (
                <th
                  key={mm.key}
                  colSpan={3}
                  className="py-2 px-3 text-center text-[10px] uppercase tracking-wider font-semibold text-slate-200 border-l border-white/10 bg-white/[0.03] whitespace-nowrap"
                >
                  {mm.label}
                </th>
              ))}
            </tr>
            <tr className="border-b border-white/10">
              <th className="sticky left-0 z-10 bg-slate-900 text-left py-1.5 px-2 text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
                Менеджер
              </th>
              {CMP_METRICS.map((mm) => (
                <Fragment key={mm.key}>
                  <th title={labelA} className="py-1.5 px-3 text-right text-[9px] uppercase tracking-wider font-bold text-blue-400 border-l border-white/10">A</th>
                  <th title={labelB} className="py-1.5 px-3 text-right text-[9px] uppercase tracking-wider font-bold text-orange-400">B</th>
                  <th title="A − B" className="py-1.5 px-3 text-right text-[9px] uppercase tracking-wider font-bold text-slate-500">Δ</th>
                </Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-white/10 bg-blue-500/[0.05]">
              <td className="sticky left-0 z-10 bg-slate-900 py-2 px-2 text-[11px] font-bold text-white">Всего</td>
              {rowCells(tA, tB, true)}
            </tr>
            {names.map((n) => (
              <tr key={n} className="border-t border-white/[0.06] hover:bg-white/[0.02] transition-colors">
                <td className="sticky left-0 z-10 bg-slate-900 py-2 px-2 text-[11px] text-slate-200 whitespace-nowrap">{n}</td>
                {rowCells(byNameA.get(n), byNameB.get(n), false)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-slate-600 mt-2">
        Δ = A − B. У «Ожидания» и «SLA» рост означает ухудшение — цвет там инвертирован.
        «—» в «Ожидании» значит, что в периоде не было недозвонов и среднее считать не из чего.
      </p>
    </div>
  );
}
