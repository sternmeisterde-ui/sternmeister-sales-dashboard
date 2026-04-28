"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  Phone, Clock, AlertTriangle,
  PhoneMissed, Target, Loader2, RefreshCw,
  ChevronLeft, ChevronRight,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip as RTooltip,
  ResponsiveContainer, CartesianGrid, Legend,
} from "recharts";
import CalendarPicker from "@/components/CalendarPicker";
import DinoLoader from "@/components/DinoLoader";
import { fmtLocalDate as formatDate } from "@/lib/utils/date";

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
  overdueTasks: number;
}

interface StatusBreakdownRow {
  pipelineId: number;
  pipelineName: string;
  line: string | null;
  statusId: number;
  statusName: string;
  count: number;
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
  statusBreakdown: StatusBreakdownRow[];
}

type LineFilter = "all" | "1" | "2" | "3";

const LINE_LABEL: Record<LineFilter, string> = {
  all: "Все линии",
  "1": "Линия 1 — Квалификатор",
  "2": "Линия 2 — Бератер",
  "3": "Линия 3 — Доведение",
};

const LINE_SHORT: Record<Exclude<LineFilter, "all">, string> = {
  "1": "Квалификатор",
  "2": "Бератер",
  "3": "Доведение",
};

const LINE_COLOR_CLASS: Record<Exclude<LineFilter, "all">, string> = {
  "1": "text-emerald-400",
  "2": "text-purple-400",
  "3": "text-sky-400",
};

// ==================== Component ====================

export default function DashboardTab({ department }: { department: string }) {
  const [range, setRange] = useState<{ start: Date; end: Date }>(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return { start: today, end: today };
  });
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [trendLine, setTrendLine] = useState<LineFilter>("all");

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    if (!data) setLoading(true);
    setError(null);
    try {
      const fromStr = formatDate(range.start);
      const toStr = formatDate(range.end);
      const res = await fetch(
        `/api/dashboard?department=${department}&from=${fromStr}&to=${toStr}`,
        { signal },
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`API error ${res.status}: ${text}`);
      }
      const json = await res.json();
      setData(json);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      if (e instanceof TypeError && e.message === "Failed to fetch") return;
      console.error("Dashboard fetch error:", e);
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [department, range.start, range.end, data]);

  useEffect(() => {
    const ac = new AbortController();
    fetchData(ac.signal);
    return () => ac.abort();
  }, [fetchData]);

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
    const spanDays =
      Math.round((range.end.getTime() - range.start.getTime()) / 86_400_000) + 1;
    const nextStart = new Date(range.start);
    nextStart.setDate(nextStart.getDate() + dir * spanDays);
    const nextEnd = new Date(range.end);
    nextEnd.setDate(nextEnd.getDate() + dir * spanDays);
    setRange({ start: nextStart, end: nextEnd });
  };

  const dateDisplay = isSingleDay
    ? range.start.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })
    : `${range.start.toLocaleDateString("ru-RU", { day: "numeric", month: "short" })} — ${range.end.toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" })}`;

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
              const today = new Date();
              today.setHours(0, 0, 0, 0);
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
          {(!isSingleDay || formatDate(range.start) !== formatDate(new Date())) && (
            <button
              onClick={() => {
                const today = new Date();
                today.setHours(0, 0, 0, 0);
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

      {/* ============ KPI: 4 tiles in one row, compact, responsive width ============ */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <CallMetricTile
          icon={Phone}
          label="Звонки"
          color="blue"
          totalValue={m.callsTotal}
          totalCaption={`${m.outgoingTotal}↑ ${m.incomingTotal}↓`}
          rows={byLine && (["1", "2", "3"] as const).map((ln) => ({
            line: ln,
            value: byLine[ln].callsTotal,
          }))}
        />
        <CallMetricTile
          icon={Target}
          label="Дозвон"
          color={m.dialPercent >= 50 ? "emerald" : m.dialPercent >= 30 ? "amber" : "rose"}
          totalValue={`${m.dialPercent}%`}
          totalCaption={`${m.callsConnected}/${m.callsTotal}`}
          rows={byLine && (["1", "2", "3"] as const).map((ln) => ({
            line: ln,
            value: `${byLine[ln].dialPercent}%`,
          }))}
        />
        <CallMetricTile
          icon={Clock}
          label="На линии"
          color="blue"
          totalValue={`${m.totalMinutes}м`}
          totalCaption={`ср. ${m.avgDialogMinutes}м`}
          rows={byLine && (["1", "2", "3"] as const).map((ln) => ({
            line: ln,
            value: `${byLine[ln].totalMinutes}м`,
          }))}
        />
        <CallMetricTile
          icon={PhoneMissed}
          label="Пропущенные"
          color={m.missedIncoming === 0 ? "emerald" : m.missedIncoming <= 3 ? "amber" : "rose"}
          totalValue={m.missedIncoming}
          totalCaption={`${missed.missedPercent}% от ${missed.incomingTotal}`}
          rows={byLine && (["1", "2", "3"] as const).map((ln) => ({
            line: ln,
            value: byLine[ln].missedIncoming,
          }))}
        />
      </div>

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
                    <th className="text-right py-2 px-2 font-medium">Звонки</th>
                    <th className="text-right py-2 px-2 font-medium">Дозвон</th>
                    <th className="text-right py-2 px-2 font-medium">% дозв.</th>
                    <th className="text-right py-2 px-2 font-medium">На линии</th>
                    <th className="text-right py-2 px-2 font-medium">Ср. диалог</th>
                    <th className="text-right py-2 px-2 font-medium">Вх. всего</th>
                    <th className="text-right py-2 px-2 font-medium">Пропущ.</th>
                    <th className="text-right py-2 px-2 font-medium">Задачи</th>
                  </tr>
                </thead>
                <tbody>
                  {lineManagers.map((mgr) => (
                    <tr key={mgr.id} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
                      <td className="py-2 px-2 text-white font-medium truncate max-w-[140px]">{mgr.name}</td>
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      {/* ============ TREND CHART with line filter ============ */}
      <TrendChart
        trend={data.trend}
        trendByLine={data.trendByLine}
        line={trendLine}
        onLineChange={setTrendLine}
        showLineFilter={isB2G}
      />

      {/* ============ STATUS COHORT TABLE with filters ============ */}
      <StatusCohortTable rows={data.statusBreakdown} isB2G={isB2G} />
    </div>
  );
}

// ==================== KPI tile — compact, fits 4-in-a-row ====================

interface TileRow {
  line: "1" | "2" | "3";
  value: string | number;
}

function CallMetricTile({
  icon: Icon,
  label,
  totalValue,
  totalCaption,
  color,
  rows,
}: {
  icon: LucideIcon;
  label: string;
  totalValue: string | number;
  totalCaption?: string;
  color: "blue" | "emerald" | "amber" | "rose";
  rows: TileRow[] | null;
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
      <div className="glass-panel rounded-xl p-3 border border-white/5 hover:border-blue-500/20 transition-all min-w-0">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-slate-400 font-semibold tracking-wider text-[10px] uppercase truncate">{label}</span>
          <div className={`p-1 ${c.bg} rounded ${c.text} shrink-0`}>
            <Icon className="w-3 h-3" />
          </div>
        </div>
        <div className={`text-2xl font-bold ${c.text} tracking-tight`}>{totalValue}</div>
        {totalCaption && <div className="text-[10px] text-slate-500 mt-0.5 truncate">{totalCaption}</div>}
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
          <div key={r.line} className="flex items-center justify-between gap-2">
            <span className={`text-[10px] font-semibold uppercase tracking-wider ${LINE_COLOR_CLASS[r.line]} shrink-0`}>
              Л{r.line}
            </span>
            <span className={`text-base font-bold tabular-nums ${LINE_COLOR_CLASS[r.line]} tracking-tight truncate`}>
              {r.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ==================== Trend chart with line filter ====================

function TrendChart({
  trend,
  trendByLine,
  line,
  onLineChange,
  showLineFilter,
}: {
  trend: DailyBucket[];
  trendByLine: { line1: DailyBucket[]; line2: DailyBucket[]; line3: DailyBucket[] };
  line: LineFilter;
  onLineChange: (l: LineFilter) => void;
  showLineFilter: boolean;
}) {
  const source =
    line === "1"
      ? trendByLine.line1
      : line === "2"
        ? trendByLine.line2
        : line === "3"
          ? trendByLine.line3
          : trend;

  const data = (source || []).map((d) => ({
    date: d.date.slice(5).replace("-", "."),
    "Звонки": d.callsTotal,
    "Дозвон": d.callsConnected,
    "Пропущ.": d.missedIncoming,
  }));
  if (data.length === 0) return null;

  return (
    <div className="glass-panel rounded-2xl p-5 border border-white/5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-slate-300 font-semibold tracking-wide text-xs uppercase">
          Динамика звонков по дням
          {line !== "all" && (
            <span className="text-slate-500 ml-2 font-normal normal-case">— {LINE_LABEL[line]}</span>
          )}
        </h3>
        {showLineFilter && (
          <select
            value={line}
            onChange={(e) => onLineChange(e.target.value as LineFilter)}
            className="bg-slate-900/60 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-slate-300 hover:border-blue-500/40 focus:border-blue-500/60 focus:outline-none transition-colors"
          >
            <option value="all">Все линии</option>
            <option value="1">Линия 1</option>
            <option value="2">Линия 2</option>
            <option value="3">Линия 3</option>
          </select>
        )}
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

// ==================== Status cohort table with filters ====================
//
// Filters:
//   • Линия (B2G only): all / 1 / 2 / 3 — same dropdown style as the trend chart.
//     Pipeline filter dropped — Line 2 and Line 3 share the BERATER pipeline,
//     so a separate "воронка" filter would just duplicate the line filter.
//   • Статусы: multi-select dropdown with checkboxes, "select all" / "clear"
//     toggles. Default = all checked. Newly-appearing statuses (e.g. after a
//     date-range expansion) are auto-selected so the user doesn't lose visibility.
//
// Percent base: each row's count / sum(currently shown rows). When the user
// narrows by line or unchecks statuses, percentages re-base to that subset.
//
// B2B variant: no line filter (no line concept); pipeline filter shows up
// because Бух Комм vs Мед Admin are real distinct funnels worth slicing.

// Display names for B2G pipelines in the cohort filter. The "Бератер" funnel
// covers both Line 2 and Line 3 in Kommo (single pipeline split by status_id);
// "Квалификатор" is the FIRST_LINE pipeline. Falls back to whatever
// pipelineName the server emits.
const B2G_FUNNEL_LABEL: Record<number, string> = {
  10935879: "Квалификатор",  // B2G_PIPELINES.FIRST_LINE
  12154099: "Бератер",        // B2G_PIPELINES.BERATER (L2 + L3)
};

function StatusCohortTable({ rows, isB2G }: { rows: StatusBreakdownRow[]; isB2G: boolean }) {
  // Funnel multi-select. null sentinel = "all selected" (keeps newly-arriving
  // pipelines auto-included when the date range expands).
  const [funnelSelection, setFunnelSelection] = useState<Set<number> | null>(null);
  const [statusSelection, setStatusSelection] = useState<Set<number> | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Available funnels = distinct pipelineIds in the current rows. For B2G
  // remap labels to the user's preferred names (Квалификатор / Бератер).
  // Bератер still surfaces every L2 + L3 lead — the row filter is by
  // pipelineId, not by line, so nothing is dropped at this stage.
  const funnels = useMemo(() => {
    const map = new Map<number, string>();
    for (const r of rows) {
      const name = isB2G
        ? (B2G_FUNNEL_LABEL[r.pipelineId] ?? r.pipelineName)
        : r.pipelineName;
      map.set(r.pipelineId, name);
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [rows, isB2G]);

  // Resolve funnel selection from the sentinel.
  const selectedFunnels = useMemo(() => {
    if (funnelSelection === null) return new Set(funnels.map((f) => f.id));
    return new Set(Array.from(funnelSelection).filter((id) => funnels.some((f) => f.id === id)));
  }, [funnelSelection, funnels]);

  const scopedRows = useMemo(() => {
    return rows.filter((r) => selectedFunnels.has(r.pipelineId));
  }, [rows, selectedFunnels]);

  const toggleFunnel = (id: number) => {
    setFunnelSelection((prev) => {
      const base = prev ?? new Set(funnels.map((f) => f.id));
      const next = new Set(base);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Alias for the rest of the component.
  const lineFilteredRows = scopedRows;

  const availableStatuses = useMemo(() => {
    const map = new Map<number, string>();
    for (const r of lineFilteredRows) map.set(r.statusId, r.statusName);
    return Array.from(map.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "ru"));
  }, [lineFilteredRows]);

  // Resolve "selected statuses" from the sentinel: null = everything available.
  const selectedSet = useMemo(() => {
    if (statusSelection === null) {
      return new Set(availableStatuses.map((s) => s.id));
    }
    // Filter selection to only statuses still available in current line scope.
    return new Set(
      Array.from(statusSelection).filter((id) =>
        availableStatuses.some((s) => s.id === id),
      ),
    );
  }, [statusSelection, availableStatuses]);

  const filtered = useMemo(() => {
    return lineFilteredRows.filter((r) => selectedSet.has(r.statusId));
  }, [lineFilteredRows, selectedSet]);

  const total = filtered.reduce((s, r) => s + r.count, 0);
  const sorted = useMemo(() => [...filtered].sort((a, b) => b.count - a.count), [filtered]);

  // Close dropdown on outside click.
  useEffect(() => {
    if (!statusOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setStatusOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [statusOpen]);

  if (rows.length === 0) return null;

  const toggleStatus = (id: number) => {
    setStatusSelection((prev) => {
      const base = prev ?? new Set(availableStatuses.map((s) => s.id));
      const next = new Set(base);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const selectAllStatuses = () => setStatusSelection(null);
  const clearAllStatuses = () => setStatusSelection(new Set());

  const allChecked = selectedSet.size === availableStatuses.length && availableStatuses.length > 0;
  const noneChecked = selectedSet.size === 0;
  const buttonLabel = allChecked
    ? `Все статусы (${availableStatuses.length})`
    : noneChecked
      ? "Не выбрано"
      : `Выбрано: ${selectedSet.size} из ${availableStatuses.length}`;

  return (
    <div className="glass-panel rounded-2xl p-5 border border-white/5">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <h3 className="text-slate-300 font-semibold tracking-wide text-xs uppercase">
          Статусы сделок — когортный срез
          <span className="text-slate-500 ml-2 font-normal normal-case">
            (всего {total.toLocaleString("ru-RU")} {total === 1 ? "сделка" : total % 10 >= 2 && total % 10 <= 4 && (total % 100 < 10 || total % 100 >= 20) ? "сделки" : "сделок"})
          </span>
        </h3>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Funnel multi-select as inline checkbox pills. Both B2G and B2B
              have exactly 2 funnels in scope — checkbox pills read better than
              a dropdown for that count. Default both checked; user clicks to
              toggle. Бератер covers L2 + L3 in one funnel. */}
          {funnels.map((f) => {
            const checked = selectedFunnels.has(f.id);
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => toggleFunnel(f.id)}
                className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                  checked
                    ? "bg-blue-500/15 border-blue-500/40 text-blue-200"
                    : "bg-slate-900/40 border-white/10 text-slate-400 hover:border-white/20 hover:text-slate-200"
                }`}
              >
                <span className={`inline-block w-3.5 h-3.5 rounded border ${
                  checked ? "bg-blue-500 border-blue-500" : "border-slate-500"
                } flex items-center justify-center text-[10px] text-white`}>
                  {checked ? "✓" : ""}
                </span>
                <span>{f.name}</span>
              </button>
            );
          })}

          {/* Status multi-select dropdown */}
          <div ref={dropdownRef} className="relative">
            <button
              type="button"
              onClick={() => setStatusOpen((s) => !s)}
              className="bg-slate-900/60 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-slate-300 hover:border-blue-500/40 focus:border-blue-500/60 focus:outline-none transition-colors flex items-center gap-2 min-w-[200px] justify-between"
            >
              <span>{buttonLabel}</span>
              <span className="text-slate-500 text-[10px]">{statusOpen ? "▲" : "▼"}</span>
            </button>
            {statusOpen && (
              <div className="absolute right-0 top-full mt-1 z-30 w-72 max-h-80 overflow-auto rounded-lg border border-white/10 bg-slate-900/95 backdrop-blur-md shadow-xl">
                <div className="sticky top-0 bg-slate-900/95 backdrop-blur-md border-b border-white/5 px-3 py-2 flex items-center justify-between">
                  <button
                    onClick={selectAllStatuses}
                    className="text-[10px] uppercase tracking-wider text-blue-400 hover:text-blue-300"
                  >
                    Выбрать все
                  </button>
                  <button
                    onClick={clearAllStatuses}
                    className="text-[10px] uppercase tracking-wider text-slate-500 hover:text-slate-300"
                  >
                    Снять все
                  </button>
                </div>
                {availableStatuses.length === 0 ? (
                  <div className="p-4 text-center text-xs text-slate-500">Нет статусов</div>
                ) : (
                  <ul className="py-1">
                    {availableStatuses.map((s) => {
                      const checked = selectedSet.has(s.id);
                      return (
                        <li key={s.id}>
                          <label className="flex items-center gap-2 px-3 py-1.5 hover:bg-white/5 cursor-pointer text-xs text-slate-300">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleStatus(s.id)}
                              className="w-3.5 h-3.5 rounded border-white/20 bg-slate-900 text-blue-500 focus:ring-blue-500/40 focus:ring-1"
                            />
                            <span className="truncate">{s.name}</span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {sorted.length === 0 ? (
        <div className="text-center py-8 text-slate-500 text-sm">Нет сделок по выбранным фильтрам</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-slate-500 text-[10px] uppercase tracking-wider border-b border-white/5">
                <th className="text-left py-2 px-2 font-medium">Статус</th>
                {selectedFunnels.size > 1 && (
                  <th className="text-left py-2 px-2 font-medium">Воронка</th>
                )}
                <th className="text-right py-2 px-2 font-medium">Сделок</th>
                <th className="text-right py-2 px-2 font-medium w-1/3">Доля</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const pct = total > 0 ? (r.count / total) * 100 : 0;
                const funnelName =
                  funnels.find((f) => f.id === r.pipelineId)?.name ?? r.pipelineName;
                return (
                  <tr key={`${r.pipelineId}-${r.statusId}`} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
                    <td className="py-2 px-2 text-slate-200 truncate max-w-[320px]">{r.statusName}</td>
                    {selectedFunnels.size > 1 && (
                      <td className="py-2 px-2 text-xs text-slate-400 truncate max-w-[160px]">
                        {funnelName}
                      </td>
                    )}
                    <td className="py-2 px-2 text-right text-slate-200 tabular-nums font-medium">{r.count.toLocaleString("ru-RU")}</td>
                    <td className="py-2 px-2 w-1/3">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 bg-slate-800/60 rounded-full overflow-hidden">
                          <div className="h-full bg-blue-500/70" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="text-[11px] text-slate-500 min-w-[44px] text-right tabular-nums">
                          {pct.toFixed(1)}%
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
