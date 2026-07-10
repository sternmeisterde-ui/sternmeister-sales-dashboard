"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  Phone, Clock, AlertTriangle,
  PhoneMissed, Target, Loader2, RefreshCw,
  ChevronLeft, ChevronRight, ChevronDown, Check,
  PhoneOutgoing, PhoneCall, Timer, Gauge, PhoneOff,
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
  avgWaitSeconds?: number;
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
  slaFirstCallMin: number;
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

// Детализация KPI-плиток B2B — форма ответа /api/dashboard/b2b-tile-details
// (см. getAnalyticsB2bTileDetails: скоуп/пороги идентичны плиткам).
type TileDetailKind = "outgoing" | "answered" | "hourly" | "wait";
interface B2bTileDetails {
  platforms: Array<{ platform: string; outgoing: number; connected: number; talkSeconds: number }>;
  managerPlatforms: Array<{ manager: string; platform: string; outgoing: number; connected: number }>;
  hourly: Array<{ hour: number; outgoing: number; connected: number }>;
  waitPlatforms: Array<{ platform: string; avgWaitSec: number; maxWaitSec: number; answered: number }>;
  waitManagers: Array<{ manager: string; avgWaitSec: number; answered: number }>;
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

// B2B pipeline IDs + display labels — match server-side B2B_PIPELINES.
const B2B_PIPELINE_LABEL: Record<string, { full: string; colorClass: string }> = {
  "10631243": { full: "Бух Комм", colorClass: "text-emerald-400" },
  "13209983": { full: "Мед Комм", colorClass: "text-purple-400" },
};

const LINE_LABEL: Record<LineFilter, string> = {
  all: "Все линии",
  "1": "Линия 1 — Квалификатор",
  "2": "Линия 2 — Бератер",
  "3": "Линия 3 — Доведение",
};

const LINE_SHORT: Record<Exclude<LineFilter, "all">, string> = {
  "1": "Квалификация",
  "2": "Бератер",
  "3": "Доведение",
};

const LINE_COLOR_CLASS: Record<Exclude<LineFilter, "all">, string> = {
  "1": "text-emerald-400",
  "2": "text-purple-400",
  "3": "text-sky-400",
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
  // For B2G this holds "all"|"1"|"2"|"3" (LineFilter); for B2B it holds
  // "all" or a pipelineId string (e.g. "10631243"). Single piece of state
  // since the dashboard switches modes when the user toggles department,
  // and the new value is reset to "all" on every department change.
  const [trendLine, setTrendLine] = useState<string>("all");
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
  }, [department, range.start, range.end]);

  // ESC закрывает открытую модалку детализации.
  useEffect(() => {
    if (!lostOpen && !slaOpen && !tileDetail) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setLostOpen(false);
        setSlaOpen(false);
        setTileDetail(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [lostOpen, slaOpen, tileDetail]);

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
        `/api/dashboard/b2b-tile-details?department=b2b&from=${formatDate(range.start)}&to=${formatDate(range.end)}`,
      );
      if (!res.ok) throw new Error(`API error ${res.status}`);
      setTileData((await res.json()) as B2bTileDetails);
    } catch (e) {
      setTileError(String(e));
    } finally {
      setTileLoading(false);
    }
  }, [tileData, tileLoading, range.start, range.end]);

  const toggleSlaDetail = useCallback(async () => {
    const next = !slaOpen;
    setSlaOpen(next);
    if (!next || slaItems !== null || slaLoading) return;
    setSlaLoading(true);
    setSlaError(null);
    try {
      const res = await fetch(
        `/api/dashboard/sla-leads?department=${department}&from=${formatDate(range.start)}&to=${formatDate(range.end)}`,
      );
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const json = (await res.json()) as { items: SlaLeadItem[] };
      setSlaItems(json.items);
    } catch (e) {
      setSlaError(String(e));
    } finally {
      setSlaLoading(false);
    }
  }, [slaOpen, slaItems, slaLoading, department, range.start, range.end]);

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
  // (Line 1 / 2 / 3). We sum perManager rows by `line` field.
  const sumByLine = (line: string | null): {
    callsTotal: number; callsConnected: number; missedIncoming: number;
    totalMinutes: number; incomingTotal: number; outgoingTotal: number;
    dialPercent: number; missedPercent: number;
  } => {
    const rows = data.perManager.filter((r) => r.line === line);
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

  // Top-tile breakdown rows. B2G splits by line (Квалификация/Бератер/
  // Доведение). B2B intentionally renders only the total — per-pipeline
  // (Бух Комм / Мед Комм) split was removed at the user's request because
  // the trend chart already exposes that breakdown via dropdown, and the
  // duplicated split made the tiles visually noisy.
  type Metric = "calls" | "dial" | "minutes" | "missed";
  const tileRows = (metric: Metric): TileRow[] | null => {
    if (!byLine) return null;
    return (["1", "2", "3"] as const).map((ln) => {
      const v = byLine[ln];
      const value =
        metric === "calls" ? v.callsTotal
          : metric === "dial" ? `${v.dialPercent}%`
            : metric === "minutes" ? `${v.totalMinutes}м`
              : v.missedIncoming;
      return { key: ln, label: LINE_SHORT[ln], colorClass: LINE_COLOR_CLASS[ln], value };
    });
  };

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
      {isB2G ? (
        // B2G — 4 tiles with per-line breakdown (unchanged).
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <CallMetricTile
            icon={Phone}
            label="Звонки"
            color="blue"
            totalValue={m.callsTotal}
            totalCaption={`${m.outgoingTotal}↑ ${m.incomingTotal}↓`}
            rows={tileRows("calls")}
          />
          <CallMetricTile
            icon={Target}
            label="Дозвон"
            color={m.dialPercent >= 50 ? "emerald" : m.dialPercent >= 30 ? "amber" : "rose"}
            totalValue={`${m.dialPercent}%`}
            totalCaption={`${m.callsConnected}/${m.callsTotal}`}
            rows={tileRows("dial")}
          />
          <CallMetricTile
            icon={Clock}
            label="На линии"
            color="blue"
            totalValue={`${m.totalMinutes}м`}
            totalCaption={`ср. ${m.avgDialogMinutes}м`}
            rows={tileRows("minutes")}
          />
          <CallMetricTile
            icon={PhoneMissed}
            label="Пропущенные"
            color={m.missedIncoming === 0 ? "emerald" : m.missedIncoming <= 3 ? "amber" : "rose"}
            totalValue={m.missedIncoming}
            totalCaption={`${missed.missedPercent}% от ${missed.incomingTotal}`}
            rows={tileRows("missed")}
          />
        </div>
      ) : (
        // B2B — 7 single-number tiles, no captions. % дозвона = принятые
        // исходящие / все исходящие (≤100%). Ожидание = средний answer-wait
        // (сек). SLA = среднее время до 1-го звонка (мин).
        (() => {
          const outgoing = m.outgoingTotal;
          const answeredOut = m.outgoingConnected ?? 0;
          const dialPct = outgoing > 0 ? Math.round((answeredOut / outgoing) * 100) : 0;
          const waitSec = m.avgWaitSeconds ?? 0;
          const slaMin = m.slaFirstCallMin ?? 0;
          const lost = m.lostCalls ?? 0;
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
                icon={Clock} label="Длительность" color="blue" totalValue={fmtHoursMinutes(m.totalMinutes)} rows={null}
                tip="Суммарная длительность по всем звонкам, как её считают кабинеты телефоний: CloudTalk — время разговора, CallGear — полное время звонка."
              />
              <CallMetricTile
                icon={Timer} label="Ожидание" color="blue" totalValue={`${waitSec}с`} rows={null}
                onClick={() => openTileDetail("wait")}
                tip="Сколько в среднем ждали ответа: время от набора до снятия трубки, по отвеченным звонкам менеджеров отдела. Клик — разбивка по платформам и менеджерам."
              />
              <CallMetricTile
                icon={Gauge} label="SLA" color="blue" totalValue={`${slaMin}м`} rows={null}
                onClick={toggleSlaDetail}
                tipAlign="right"
                tip="Среднее рабочее время (Пн–Сб 09:00–18:00 по Берлину) от входа лида в статус «Новый лид» до первого звонка по нему. Без звонка: открытый лид считается до текущего момента, закрытый — до момента закрытия. Не учитываются лиды с причинами: Спам, Неквал, Предложение сотрудничества, Дубль госник, Бух дубль, Мед дубль — и помеченные «Исключить из аналитики». Клик — детализация по сделкам."
              />
              <CallMetricTile
                icon={PhoneOff}
                label="Потерянные"
                color={lost === 0 ? "emerald" : "rose"}
                totalValue={lost}
                rows={null}
                tipAlign="right"
                tip="Исходящие недозвоны в 09:00–19:00 (Берлин), на которые не перезвонили на тот же номер в течение 15 минут. Клик — детализация по менеджерам."
                onClick={toggleLostDetail}
              />
              {/* tipAlign right on the last two so the popover opens leftward
                  and doesn't clip past the viewport edge. */}
            </div>
          );
        })()
      )}

      {/* ============ KPI-ПЛИТКИ — DRILL-DOWN МОДАЛКА (B2B) ============ */}
      {!isB2G && tileDetail && typeof document !== "undefined" && createPortal(
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
                <span className="truncate">Потерянные звонки — детализация</span>
                {lostItems && <span className="text-slate-500 font-normal shrink-0">({lostItems.length})</span>}
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

          {lostItems && lostItems.length === 0 && (
            <p className="text-slate-400 text-sm py-2">За выбранный период потерянных звонков нет 🎉</p>
          )}

          {lostItems && lostItems.length > 0 && (() => {
            // Группировка по ответственному МОПу (Рузанна: «разбито по мопам»).
            const byManager = new Map<string, LostCallItem[]>();
            for (const it of lostItems) {
              const key = it.manager || "Без менеджера";
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
      {!isB2G && slaOpen && typeof document !== "undefined" && createPortal(
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
                {slaItems && slaItems.length > 0 && (
                  <span className="text-slate-500 font-normal shrink-0">
                    ({slaItems.length} · ср. {Math.round(slaItems.reduce((s, x) => s + x.slaMinutes, 0) / slaItems.length)}м)
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
              {slaItems && slaItems.length === 0 && (
                <p className="text-slate-400 text-sm py-2">За выбранный период SLA-сделок нет.</p>
              )}
              {slaItems && slaItems.length > 0 && (() => {
                const byManager = new Map<string, SlaLeadItem[]>();
                for (const it of slaItems) {
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
                                  <th className="py-1.5 font-medium">Статус</th>
                                </tr>
                              </thead>
                              <tbody>
                                {items.map((it) => {
                                  const st = it.slaStatus ? SLA_STATUS_LABEL[it.slaStatus] : undefined;
                                  return (
                                    <tr key={it.leadId} className="border-b border-white/5 hover:bg-white/[0.02]">
                                      <td className="py-1.5 pr-3">
                                        <a
                                          href={kommoLeadUrl(it.leadId)}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="text-blue-400 hover:text-blue-300 hover:underline"
                                        >
                                          #{it.leadId} ↗
                                        </a>
                                      </td>
                                      <td className="py-1.5 pr-3 text-slate-200">{it.clientName ?? <span className="text-slate-600">—</span>}</td>
                                      <td className="py-1.5 pr-3 text-slate-200 font-mono text-xs">{it.phone ?? "—"}</td>
                                      <td className={`py-1.5 pr-3 text-right tabular-nums font-semibold ${it.slaMinutes >= 30 ? "text-rose-400" : "text-slate-200"}`}>
                                        {fmtHoursMinutes(it.slaMinutes)}
                                      </td>
                                      <td className="py-1.5">
                                        {st ? (
                                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${st.cls}`}>{st.label}</span>
                                        ) : (
                                          <span className="text-slate-600 text-xs">—</span>
                                        )}
                                      </td>
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

      {/* ============ PER-MANAGER TABLES — moved up: detail bound to top filter ============ */}
      {(isB2G
        ? [
            { title: "Квалификатор (1я линия)", line: "1", color: "emerald" },
            { title: "Бератер (2я линия)", line: "2", color: "purple" },
            { title: "Доведение (3я линия)", line: "3", color: "sky" },
            { title: "Руководители (без линии)", line: "__none__", color: "amber" },
          ]
        : [
            { title: "Менеджеры", line: "__all__", color: "blue" },
          ]
      ).map(({ title, line, color }) => {
        const lineManagers =
          line === "__all__"
            ? data.perManager
            : line === "__none__"
              ? data.perManager.filter((mgr) => !mgr.line)
              : data.perManager.filter((mgr) => mgr.line === line);
        if (lineManagers.length === 0) return null;
        const titleColorClass =
          color === "emerald"
            ? "text-emerald-400"
            : color === "purple"
              ? "text-purple-400"
              : color === "sky"
                ? "text-sky-400"
                : color === "amber"
                  ? "text-amber-400"
                  : "text-blue-400";
        return (
          <div key={line} className="glass-panel rounded-2xl p-5 border border-white/5">
            <h3 className="text-slate-300 font-semibold tracking-wide text-xs uppercase mb-4">
              <span className={titleColorClass}>{title}</span>
              <span className="text-slate-500 ml-2">({lineManagers.length} чел.)</span>
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-slate-500 text-[10px] uppercase tracking-wider border-b border-white/5">
                    <th className="text-left py-2 px-2 font-medium">Менеджер</th>
                    {isB2G ? (
                      <>
                        <th className="text-right py-2 px-2 font-medium">Звонки</th>
                        <th className="text-right py-2 px-2 font-medium">Дозвон</th>
                        <th className="text-right py-2 px-2 font-medium">% дозв.</th>
                        <th className="text-right py-2 px-2 font-medium">На линии</th>
                        <th className="text-right py-2 px-2 font-medium">Ср. диалог</th>
                        <th className="text-right py-2 px-2 font-medium">Вх. всего</th>
                        <th className="text-right py-2 px-2 font-medium">Пропущ.</th>
                        <th className="text-right py-2 px-2 font-medium">Задачи</th>
                      </>
                    ) : (
                      <>
                        <th className="text-right py-2 px-2 font-medium">Исходящие</th>
                        <th className="text-right py-2 px-2 font-medium">Принятых</th>
                        <th className="text-right py-2 px-2 font-medium">% дозв.</th>
                        <th className="text-right py-2 px-2 font-medium">Длительность</th>
                        <th className="text-right py-2 px-2 font-medium">Ожидание</th>
                        <th className="text-right py-2 px-2 font-medium">SLA</th>
                        <th className="text-right py-2 px-2 font-medium">Всего</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {lineManagers.map((mgr) => {
                    // B2B % дозвона = принятые исходящие / все исходящие (≤100%).
                    const b2bDialPct = mgr.outgoingTotal > 0
                      ? Math.round((mgr.outgoingConnected / mgr.outgoingTotal) * 100)
                      : 0;
                    return (
                    <tr key={mgr.id} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
                      <td className="py-2 px-2 text-white font-medium truncate max-w-[140px]">{mgr.name}</td>
                      {isB2G ? (
                        <>
                          <td className="py-2 px-2 text-right text-slate-300">{mgr.callsTotal}</td>
                          <td className="py-2 px-2 text-right text-slate-300">{mgr.callsConnected}</td>
                          <td className="py-2 px-2 text-right">
                            <span className={mgr.dialPercent >= 50 ? "text-emerald-400" : mgr.dialPercent >= 30 ? "text-amber-400" : "text-rose-400"}>
                              {mgr.dialPercent}%
                            </span>
                          </td>
                          <td className="py-2 px-2 text-right text-slate-300">{mgr.totalMinutes} мин</td>
                          <td className="py-2 px-2 text-right text-slate-300">{mgr.avgDialogMinutes} мин</td>
                          <td className="py-2 px-2 text-right text-slate-300">{mgr.incomingTotal}</td>
                          <td className="py-2 px-2 text-right">
                            <span className={mgr.missedIncoming > 0 ? "text-rose-400" : "text-emerald-400"}>{mgr.missedIncoming}</span>
                          </td>
                          <td className="py-2 px-2 text-right">
                            <span className={mgr.overdueTasks > 0 ? "text-rose-400" : "text-slate-400"}>
                              {mgr.overdueTasks > 0 ? `⚠ ${mgr.overdueTasks}` : "0"}
                            </span>
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="py-2 px-2 text-right text-slate-300">{mgr.outgoingTotal}</td>
                          <td className="py-2 px-2 text-right text-slate-300">{mgr.outgoingConnected}</td>
                          <td className="py-2 px-2 text-right">
                            <span className={b2bDialPct >= 50 ? "text-emerald-400" : b2bDialPct >= 30 ? "text-amber-400" : "text-rose-400"}>
                              {b2bDialPct}%
                            </span>
                          </td>
                          <td className="py-2 px-2 text-right text-slate-300">{fmtHoursMinutes(mgr.totalMinutes)}</td>
                          <td className="py-2 px-2 text-right text-slate-300">{mgr.avgWaitSeconds} с</td>
                          <td className="py-2 px-2 text-right text-slate-300">{mgr.slaFirstCallMin} мин</td>
                          <td className="py-2 px-2 text-right text-slate-300">{mgr.callsTotal}</td>
                        </>
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

      {/* ============ TREND CHART ============
           B2G — line/pipeline dropdown (3 aggregate metric lines).
           B2B — line per manager, metric via pill toggle + manager multiselect. */}
      {isB2G ? (
        <TrendChart
          trend={data.trend}
          trendByLine={data.trendByLine}
          trendByPipeline={data.trendByPipeline ?? null}
          filter={trendLine}
          onFilterChange={setTrendLine}
          mode="b2g"
        />
      ) : (
        <TrendChartByManager trend={data.trend} trendByManager={data.trendByManager ?? null} department={department} vertical={vertical} />
      )}
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
        <div>
          <h4 className="text-[11px] uppercase tracking-wider text-slate-500 mb-2">По платформам</h4>
          <div className="grid grid-cols-2 gap-2">
            {d.waitPlatforms.map((p) => (
              <div key={p.platform} className="rounded-xl border border-white/5 bg-slate-950/50 p-3">
                <div className="text-xs text-slate-400">{p.platform}</div>
                <div className="text-xl font-black text-slate-100 mt-0.5">{fmtSec(p.avgWaitSec)}</div>
                <div className="text-[11px] text-slate-500 mt-0.5">макс {fmtSec(p.maxWaitSec)} · {p.answered} отвеч.</div>
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
                <th className="py-1.5 font-medium text-right">Отвеченных</th>
              </tr>
            </thead>
            <tbody>
              {d.waitManagers.map((m) => (
                <tr key={m.manager} className="border-b border-white/5">
                  <td className="py-1.5 pr-3 text-slate-200">{m.manager}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-slate-300">{fmtSec(m.avgWaitSec)}</td>
                  <td className="py-1.5 text-right tabular-nums text-slate-400">{m.answered}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-slate-600">
          Ожидание = от набора до снятия трубки, по отвеченным звонкам. CloudTalk и CallGear
          регистрируют момент ответа по-разному — сравнение платформ показывает эту разницу.
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
  tip?: string;
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
            className={`pointer-events-none absolute ${tipAlign === "right" ? "right-0" : "left-0"} top-full mt-2 z-30 w-52 max-w-[80vw] rounded-lg border border-white/10 bg-slate-900/95 backdrop-blur px-2.5 py-2 text-[11px] leading-snug text-slate-300 shadow-xl opacity-0 transition-opacity duration-150 group-hover:opacity-100`}
          >
            {tip}
          </div>
        )}
      </div>
    );
  }

  // ── B2G — compact tile: header + 3 line rows. Each row: tiny line tag
  //    on the left, large number on the right. Captions dropped to keep
  //    width minimal so 4 tiles fit in a row from sm breakpoint onward. ─
  return (
    <div className="glass-panel rounded-xl p-3 border border-white/5 hover:border-blue-500/20 transition-all min-w-0 flex flex-col">
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

// Мультиселект менеджеров. selected === null означает «все».
function ManagerMultiSelect({ managers, selected, onChange }: {
  managers: string[];
  selected: Set<string> | null;
  onChange: (next: Set<string> | null) => void;
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

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 bg-slate-900/60 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-slate-300 hover:border-blue-500/40 focus:outline-none transition-colors"
      >
        Менеджеры <span className="text-slate-500">{count}/{managers.length}</span>
        <ChevronDown className="w-3.5 h-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 mt-1 z-30 w-56 max-h-64 overflow-y-auto glass-panel rounded-lg border border-white/10 p-1 shadow-xl scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">
          <button
            onClick={() => onChange(isAll ? new Set() : null)}
            className="w-full text-left px-2 py-1.5 text-xs text-slate-300 hover:bg-white/5 rounded flex items-center justify-between"
          >
            Выбрать всех {isAll && <Check className="w-3.5 h-3.5 text-blue-400" />}
          </button>
          <div className="h-px bg-white/10 my-1" />
          {managers.map((m, i) => {
            const checked = isAll || selected.has(m);
            return (
              <button
                key={m}
                onClick={() => toggle(m)}
                className="w-full text-left px-2 py-1.5 text-xs text-slate-300 hover:bg-white/5 rounded flex items-center gap-2"
              >
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: MANAGER_LINE_COLORS[i % MANAGER_LINE_COLORS.length] }} />
                <span className="flex-1 truncate">{m}</span>
                {checked && <Check className="w-3.5 h-3.5 text-blue-400 shrink-0" />}
              </button>
            );
          })}
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

function TrendChartByManager({ trendByManager, department, vertical }: {
  trend: DailyBucket[];
  trendByManager: Record<string, DailyBucket[]> | null;
  department: string;
  vertical?: "buh" | "med" | "all";
}) {
  const [metric, setMetric] = useState<TrendMetric>("callsTotal");
  const [selected, setSelected] = useState<Set<string> | null>(null); // null = все
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
        {managers.length > 0 && (
          <ManagerMultiSelect managers={managers} selected={selected} onChange={setSelected} />
        )}
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
              // поверх цветной линии на нужном участке.
              lines.push(
                <Line key={`${m}__off`} type="linear" dataKey={`${m}__off`} name={`${m} · выходной`} stroke="#64748b" strokeWidth={3} strokeOpacity={0.9} dot={false} legendType="none" isAnimationActive={false} connectNulls={false} />,
              );
              return lines;
            })}
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// ==================== Trend chart with funnel filter ====================
// B2G: line dropdown (Все / 1 / 2 / 3 — Квалификация / Бератер / Доведение)
// B2B: pipeline dropdown (Все / Бух Комм / Мед Комм)

function TrendChart({
  trend,
  trendByLine,
  trendByPipeline,
  filter,
  onFilterChange,
  mode,
}: {
  trend: DailyBucket[];
  trendByLine: { line1: DailyBucket[]; line2: DailyBucket[]; line3: DailyBucket[] };
  trendByPipeline: Record<string, DailyBucket[]> | null;
  filter: string;
  onFilterChange: (l: string) => void;
  mode: "b2g" | "b2b";
}) {
  let source: DailyBucket[];
  let activeLabel = "";
  if (mode === "b2g") {
    source =
      filter === "1" ? trendByLine.line1
        : filter === "2" ? trendByLine.line2
          : filter === "3" ? trendByLine.line3
            : trend;
    if (filter !== "all") activeLabel = LINE_LABEL[filter as LineFilter] ?? "";
  } else {
    if (filter !== "all" && trendByPipeline?.[filter]) {
      source = trendByPipeline[filter];
      activeLabel = B2B_PIPELINE_LABEL[filter]?.full ?? `Pipeline ${filter}`;
    } else {
      source = trend;
    }
  }

  const data = (source || []).map((d) => ({
    date: d.date.slice(5).replace("-", "."),
    "Звонки": d.callsTotal,
    "Дозвон": d.callsConnected,
    "Пропущ.": d.missedIncoming,
  }));
  if (data.length === 0) return null;

  const dropdown =
    mode === "b2g" ? (
      <select
        value={filter}
        onChange={(e) => onFilterChange(e.target.value)}
        className="bg-slate-900/60 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-slate-300 hover:border-blue-500/40 focus:border-blue-500/60 focus:outline-none transition-colors"
      >
        <option value="all">Все линии</option>
        <option value="1">Квалификация</option>
        <option value="2">Бератер</option>
        <option value="3">Доведение</option>
      </select>
    ) : trendByPipeline ? (
      <select
        value={filter}
        onChange={(e) => onFilterChange(e.target.value)}
        className="bg-slate-900/60 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-slate-300 hover:border-blue-500/40 focus:border-blue-500/60 focus:outline-none transition-colors"
      >
        <option value="all">Все воронки</option>
        {Object.keys(trendByPipeline).map((pid) => (
          <option key={pid} value={pid}>
            {B2B_PIPELINE_LABEL[pid]?.full ?? `Pipeline ${pid}`}
          </option>
        ))}
      </select>
    ) : null;

  return (
    <div className="glass-panel rounded-2xl p-5 border border-white/5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-slate-300 font-semibold tracking-wide text-xs uppercase">
          Динамика звонков по дням
          {activeLabel && (
            <span className="text-slate-500 ml-2 font-normal normal-case">— {activeLabel}</span>
          )}
        </h3>
        {dropdown}
      </div>
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={data} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
          <XAxis dataKey="date" tick={{ fill: "#64748b", fontSize: 11 }} axisLine={{ stroke: "#334155" }} tickLine={false} />
          <YAxis tick={{ fill: "#64748b", fontSize: 11 }} axisLine={false} tickLine={false} allowDecimals={false} />
          <RTooltip contentStyle={{ background: "#0f172a", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12 }} />
          <Legend wrapperStyle={{ fontSize: 11, color: "#94a3b8" }} />
          <Line type="monotone" dataKey="Звонки" stroke="#3b82f6" strokeWidth={2} dot={{ fill: "#3b82f6", r: 3 }} />
          <Line type="monotone" dataKey="Дозвон" stroke="#10b981" strokeWidth={2} dot={{ fill: "#10b981", r: 3 }} />
          <Line type="monotone" dataKey="Пропущ." stroke="#f43f5e" strokeWidth={2} dot={{ fill: "#f43f5e", r: 3 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
