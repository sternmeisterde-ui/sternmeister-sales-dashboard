"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
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

const LINE_COLOR: Record<Exclude<LineFilter, "all">, string> = {
  "1": "emerald",
  "2": "purple",
  "3": "sky",
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

      {/* ============ KPI: 4 tiles, each split by line for B2G ============ */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <CallMetricTile
          icon={Phone}
          label="Звонки"
          color="blue"
          total={m.callsTotal}
          totalSub={`${m.outgoingTotal} исх. / ${m.incomingTotal} вх.`}
          byLine={byLine && {
            "1": { value: byLine["1"].callsTotal, sub: `${byLine["1"].outgoingTotal}/${byLine["1"].incomingTotal}` },
            "2": { value: byLine["2"].callsTotal, sub: `${byLine["2"].outgoingTotal}/${byLine["2"].incomingTotal}` },
            "3": { value: byLine["3"].callsTotal, sub: `${byLine["3"].outgoingTotal}/${byLine["3"].incomingTotal}` },
          }}
        />
        <CallMetricTile
          icon={Target}
          label="Дозвон"
          color={m.dialPercent >= 50 ? "emerald" : m.dialPercent >= 30 ? "amber" : "rose"}
          total={`${m.dialPercent}%`}
          totalSub={`${m.callsConnected} из ${m.callsTotal}`}
          byLine={byLine && {
            "1": { value: `${byLine["1"].dialPercent}%`, sub: `${byLine["1"].callsConnected}/${byLine["1"].callsTotal}` },
            "2": { value: `${byLine["2"].dialPercent}%`, sub: `${byLine["2"].callsConnected}/${byLine["2"].callsTotal}` },
            "3": { value: `${byLine["3"].dialPercent}%`, sub: `${byLine["3"].callsConnected}/${byLine["3"].callsTotal}` },
          }}
        />
        <CallMetricTile
          icon={Clock}
          label="На линии"
          color="blue"
          total={`${m.totalMinutes} мин`}
          totalSub={`Ср. диалог ${m.avgDialogMinutes} мин`}
          byLine={byLine && {
            "1": { value: `${byLine["1"].totalMinutes} мин`, sub: undefined },
            "2": { value: `${byLine["2"].totalMinutes} мин`, sub: undefined },
            "3": { value: `${byLine["3"].totalMinutes} мин`, sub: undefined },
          }}
        />
        <CallMetricTile
          icon={PhoneMissed}
          label="Пропущенные"
          color={m.missedIncoming === 0 ? "emerald" : m.missedIncoming <= 3 ? "amber" : "rose"}
          total={m.missedIncoming}
          totalSub={`${missed.missedPercent}% от входящих`}
          byLine={byLine && {
            "1": { value: byLine["1"].missedIncoming, sub: `${byLine["1"].missedPercent}%` },
            "2": { value: byLine["2"].missedIncoming, sub: `${byLine["2"].missedPercent}%` },
            "3": { value: byLine["3"].missedIncoming, sub: `${byLine["3"].missedPercent}%` },
          }}
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

// ==================== KPI tile with optional line breakdown ====================

function CallMetricTile({
  icon: Icon,
  label,
  total,
  totalSub,
  color,
  byLine,
}: {
  icon: LucideIcon;
  label: string;
  total: string | number;
  totalSub?: string;
  color: "blue" | "emerald" | "amber" | "rose";
  byLine: { "1": { value: string | number; sub?: string }; "2": { value: string | number; sub?: string }; "3": { value: string | number; sub?: string } } | null;
}) {
  const colorMap = {
    blue: { bg: "bg-blue-500/10", text: "text-blue-400" },
    emerald: { bg: "bg-emerald-500/10", text: "text-emerald-400" },
    amber: { bg: "bg-amber-500/10", text: "text-amber-400" },
    rose: { bg: "bg-rose-500/10", text: "text-rose-400" },
  };
  const c = colorMap[color];

  return (
    <div className="glass-panel rounded-2xl p-4 border border-white/5 hover:border-blue-500/20 transition-all">
      <div className="flex items-center justify-between mb-3">
        <span className="text-slate-500 font-medium tracking-wider text-[10px] uppercase">{label}</span>
        <div className={`p-1.5 ${c.bg} rounded-md ${c.text}`}>
          <Icon className="w-3.5 h-3.5" />
        </div>
      </div>
      <div className={`text-2xl font-bold ${c.text} tracking-tight`}>{total}</div>
      {totalSub && <div className="text-[10px] text-slate-500 mt-0.5">{totalSub}</div>}
      {byLine && (
        <div className="mt-3 pt-3 border-t border-white/5 grid grid-cols-3 gap-2">
          {(["1", "2", "3"] as const).map((ln) => {
            const lineColor = LINE_COLOR[ln];
            const colorClass =
              lineColor === "emerald"
                ? "text-emerald-400"
                : lineColor === "purple"
                  ? "text-purple-400"
                  : "text-sky-400";
            return (
              <div key={ln} className="text-center">
                <div className="text-[9px] text-slate-500 uppercase tracking-wider mb-0.5">L{ln}</div>
                <div className={`text-sm font-semibold ${colorClass}`}>{byLine[ln].value}</div>
                {byLine[ln].sub && <div className="text-[9px] text-slate-500 mt-0.5">{byLine[ln].sub}</div>}
              </div>
            );
          })}
        </div>
      )}
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

function StatusCohortTable({ rows, isB2G }: { rows: StatusBreakdownRow[]; isB2G: boolean }) {
  const [lineFilter, setLineFilter] = useState<LineFilter>("all");
  const [pipelineFilter, setPipelineFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<Set<number>>(new Set());

  const pipelines = useMemo(() => {
    const map = new Map<number, string>();
    for (const r of rows) map.set(r.pipelineId, r.pipelineName);
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [rows]);

  const allStatuses = useMemo(() => {
    const map = new Map<number, string>();
    for (const r of rows) map.set(r.statusId, r.statusName);
    return Array.from(map.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "ru"));
  }, [rows]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (isB2G && lineFilter !== "all" && r.line !== lineFilter) return false;
      if (pipelineFilter !== "all" && String(r.pipelineId) !== pipelineFilter) return false;
      if (statusFilter.size > 0 && !statusFilter.has(r.statusId)) return false;
      return true;
    });
  }, [rows, isB2G, lineFilter, pipelineFilter, statusFilter]);

  const total = filtered.reduce((s, r) => s + r.count, 0);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => b.count - a.count);
  }, [filtered]);

  if (rows.length === 0) return null;

  const toggleStatus = (id: number) => {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearStatusFilter = () => setStatusFilter(new Set());

  return (
    <div className="glass-panel rounded-2xl p-5 border border-white/5">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <h3 className="text-slate-300 font-semibold tracking-wide text-xs uppercase">
          Статусы сделок — когортный срез
          <span className="text-slate-500 ml-2 font-normal normal-case">
            (всего {total} {total === 1 ? "сделка" : total < 5 ? "сделки" : "сделок"})
          </span>
        </h3>
        <div className="flex items-center gap-2 flex-wrap">
          {isB2G && (
            <select
              value={lineFilter}
              onChange={(e) => setLineFilter(e.target.value as LineFilter)}
              className="bg-slate-900/60 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-slate-300 hover:border-blue-500/40 focus:border-blue-500/60 focus:outline-none transition-colors"
            >
              <option value="all">Все линии</option>
              <option value="1">Линия 1</option>
              <option value="2">Линия 2</option>
              <option value="3">Линия 3</option>
            </select>
          )}
          <select
            value={pipelineFilter}
            onChange={(e) => setPipelineFilter(e.target.value)}
            className="bg-slate-900/60 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-slate-300 hover:border-blue-500/40 focus:border-blue-500/60 focus:outline-none transition-colors max-w-[260px]"
          >
            <option value="all">Все воронки</option>
            {pipelines.map((p) => (
              <option key={p.id} value={String(p.id)}>{p.name}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Status multi-select pills */}
      <div className="mb-4 flex items-center gap-2 flex-wrap">
        <span className="text-[10px] text-slate-500 uppercase tracking-wider">Статусы:</span>
        {allStatuses.map((s) => {
          const active = statusFilter.has(s.id);
          return (
            <button
              key={s.id}
              onClick={() => toggleStatus(s.id)}
              className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${
                active
                  ? "bg-blue-500/20 border-blue-500/40 text-blue-300"
                  : "bg-slate-900/40 border-white/5 text-slate-400 hover:border-white/15 hover:text-slate-200"
              }`}
            >
              {s.name}
            </button>
          );
        })}
        {statusFilter.size > 0 && (
          <button
            onClick={clearStatusFilter}
            className="text-[10px] uppercase tracking-wider text-slate-500 hover:text-slate-300 ml-1"
          >
            Сбросить
          </button>
        )}
      </div>

      {sorted.length === 0 ? (
        <div className="text-center py-8 text-slate-500 text-sm">Нет сделок по выбранным фильтрам</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-slate-500 text-[10px] uppercase tracking-wider border-b border-white/5">
                <th className="text-left py-2 px-2 font-medium">Статус</th>
                <th className="text-left py-2 px-2 font-medium">Воронка</th>
                {isB2G && <th className="text-left py-2 px-2 font-medium">Линия</th>}
                <th className="text-right py-2 px-2 font-medium">Сделок</th>
                <th className="text-right py-2 px-2 font-medium w-1/3">Доля</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const pct = total > 0 ? (r.count / total) * 100 : 0;
                return (
                  <tr key={`${r.pipelineId}-${r.line ?? "x"}-${r.statusId}`} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
                    <td className="py-2 px-2 text-slate-200 truncate max-w-[260px]">{r.statusName}</td>
                    <td className="py-2 px-2 text-slate-400 text-xs truncate max-w-[200px]">{r.pipelineName}</td>
                    {isB2G && (
                      <td className="py-2 px-2 text-xs">
                        {r.line ? (
                          <span className={
                            r.line === "1"
                              ? "text-emerald-400"
                              : r.line === "2"
                                ? "text-purple-400"
                                : "text-sky-400"
                          }>
                            L{r.line}
                          </span>
                        ) : (
                          <span className="text-slate-600">—</span>
                        )}
                      </td>
                    )}
                    <td className="py-2 px-2 text-right text-slate-200 tabular-nums font-medium">{r.count}</td>
                    <td className="py-2 px-2 w-1/3">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 bg-slate-800/60 rounded-full overflow-hidden">
                          <div className="h-full bg-blue-500/70" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="text-[11px] text-slate-500 min-w-[40px] text-right tabular-nums">
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
