"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Phone, Clock, AlertTriangle, Users,
  PhoneMissed, Target, Loader2, RefreshCw,
  ChevronLeft, ChevronRight, TrendingUp, Trophy, XCircle, BarChart3, Filter, Wallet,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip as RTooltip,
  ResponsiveContainer, CartesianGrid,
} from "recharts";
import CalendarPicker from "@/components/CalendarPicker";
import DinoLoader from "@/components/DinoLoader";

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

interface PipelineStats {
  pipelineId: number;
  pipelineName: string;
  activeDeals: number;
  statuses: Array<{ statusId: number; name: string; count: number }>;
}

interface DashboardData {
  date: string;
  department: string;
  todayMetrics: TodayMetrics;
  funnel: Record<string, number>;
  missedBreakdown: {
    incomingTotal: number;
    missedIncoming: number;
    missedPercent: number;
  };
  perManager: Array<{
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
  }>;
  trend: Array<{
    date: string;
    callsTotal: number;
    callsConnected: number;
    totalMinutes: number;
    missedIncoming: number;
    incomingTotal: number;
    outgoingTotal: number;
  }>;
  pipelineBreakdown: PipelineStats[];
}

// ==================== Component ====================

import { fmtLocalDate as formatDate } from "@/lib/utils/date";

export default function DashboardTab({ department }: { department: string }) {
  // Single unified date range state — replaces the old period + date pair.
  // {start: D, end: D} = single day; {start: A, end: B, A<B} = range.
  const [range, setRange] = useState<{ start: Date; end: Date }>(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return { start: today, end: today };
  });
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
  }, [department, range.start, range.end]);

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
  const f = data.funnel;
  const missed = data.missedBreakdown;

  const isB2G = department === "b2g";

  const isSingleDay =
    range.start.getTime() === range.end.getTime() ||
    formatDate(range.start) === formatDate(range.end);

  const shiftDate = (dir: -1 | 1) => {
    // Shift by the length of the current selection (inclusive).
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

  return (
    <div className="flex flex-col gap-4 fade-in">
      {/* Filters — single calendar with День/Период toggle drives the whole view. */}
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

      {/* Background refresh indicator */}
      {isRefreshing && (
        <div className="flex items-center justify-center py-2">
          <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-blue-500/10 border border-blue-500/20">
            <Loader2 className="w-3 h-3 animate-spin text-blue-400" />
            <span className="text-[10px] text-blue-400 font-medium">Обновление данных...</span>
          </div>
        </div>
      )}

      {/* ============ KPI CARDS ============ */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3">
        <MetricCard icon={Phone} label="Звонки" value={m.callsTotal} sub={`${m.outgoingTotal} исх. / ${m.incomingTotal} вх.`} />
        <MetricCard icon={Target} label="Дозвон" value={`${m.dialPercent}%`} color={m.dialPercent >= 50 ? "emerald" : m.dialPercent >= 30 ? "amber" : "rose"} />
        <MetricCard icon={Clock} label="На линии" value={`${m.totalMinutes} мин`} sub={`Ср. диалог ${m.avgDialogMinutes} мин`} />
        <MetricCard icon={PhoneMissed} label="Пропущенные" value={m.missedIncoming} color={m.missedIncoming === 0 ? "emerald" : m.missedIncoming <= 3 ? "amber" : "rose"} sub={`${missed.missedPercent}% от входящих`} />
        <MetricCard icon={AlertTriangle} label="Просрочено задач" value={m.overdueTasks} color={m.overdueTasks === 0 ? "emerald" : "rose"} />
        <MetricCard icon={Wallet} label="Выручка" value={m.revenue > 0 ? `${Math.round(m.revenue).toLocaleString("ru-RU")} €` : "0 €"} color={m.revenue > 0 ? "emerald" : "blue"} />
        <MetricCard icon={Users} label="Менеджеров" value={m.managersCount} />
      </div>

      {/* ============ FUNNEL ============ */}
      <FunnelCards funnel={data.funnel} isB2G={isB2G} />

      {/* ============ TREND CHART ============ */}
      <TrendChart trend={data.trend} />

      {/* ============ PIPELINE BREAKDOWN ============ */}
      <PipelineBreakdown pipelines={data.pipelineBreakdown} />

      {/* ============ PER-MANAGER TABLES ============ */}
      {(isB2G
        ? [
            { title: "Квалификатор (1я линия)", line: "1", color: "emerald" },
            { title: "Бератер (2я линия)", line: "2", color: "purple" },
          ]
        : [
            { title: "Менеджеры", line: "__all__", color: "blue" },
          ]
      ).map(({ title, line, color }) => {
        const lineManagers = line === "__all__"
          ? data.perManager
          : data.perManager.filter((m) => m.line === line);
        if (lineManagers.length === 0) return null;
        return (
          <div key={line} className="glass-panel rounded-2xl p-5 border border-white/5">
            <h3 className="text-slate-300 font-semibold tracking-wide text-xs uppercase mb-4">
              <span className={`text-${color}-400`}>{title}</span>
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
    </div>
  );
}

// ==================== Sub-components ====================

function FunnelCards({ funnel, isB2G }: { funnel: Record<string, number>; isB2G: boolean }) {
  const n = (k: string) => Number(funnel?.[k] ?? 0);
  const b2gItems = [
    { label: "Активные лиды", value: n("activeDeals"), icon: Filter, color: "blue" as const },
    { label: "Квалифицированные", value: n("qualLeads"), icon: Target, color: "emerald" as const },
    { label: "A2", value: n("a2"), icon: BarChart3, color: "amber" as const },
    { label: "B1", value: n("b1"), icon: BarChart3, color: "amber" as const },
    { label: "B2+", value: n("b2plus"), icon: BarChart3, color: "amber" as const },
    { label: "Лидов создано", value: n("totalLeads"), icon: TrendingUp, color: "blue" as const },
    { label: "Выиграно", value: n("wonToday"), icon: Trophy, color: "emerald" as const },
    { label: "Проиграно", value: n("lostToday"), icon: XCircle, color: "rose" as const },
  ];
  const b2bItems = [
    { label: "Активные", value: n("activeDeals"), icon: Filter, color: "blue" as const },
    { label: "Квалифицированные", value: n("qualLeads"), icon: Target, color: "emerald" as const },
    { label: "Новые", value: n("newLead"), icon: TrendingUp, color: "blue" as const },
    { label: "Контакт", value: n("contactMade"), icon: BarChart3, color: "amber" as const },
    { label: "Счёт выставлен", value: n("invoiceSent"), icon: BarChart3, color: "amber" as const },
    { label: "Предоплата", value: n("prepayment"), icon: BarChart3, color: "emerald" as const },
    { label: "Выиграно", value: n("wonToday"), icon: Trophy, color: "emerald" as const },
    { label: "Проиграно", value: n("lostToday"), icon: XCircle, color: "rose" as const },
  ];
  const items = isB2G ? b2gItems : b2bItems;
  return (
    <div className="glass-panel rounded-2xl p-5 border border-white/5">
      <h3 className="text-slate-300 font-semibold tracking-wide text-xs uppercase mb-4">
        Воронка лидов
      </h3>
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
        {items.map(({ label, value, icon: Icon, color }) => (
          <MetricCard key={label} icon={Icon} label={label} value={value} color={color} />
        ))}
      </div>
    </div>
  );
}

function TrendChart({ trend }: { trend: Array<{ date: string; callsTotal: number; callsConnected: number; totalMinutes: number; missedIncoming: number }> }) {
  const data = (trend || []).map((d) => ({
    date: d.date.slice(5).replace("-", "."),
    "Звонки": d.callsTotal,
    "Дозвон": d.callsConnected,
    "Пропущ.": d.missedIncoming,
  }));
  if (data.length === 0) return null;
  return (
    <div className="glass-panel rounded-2xl p-5 border border-white/5">
      <h3 className="text-slate-300 font-semibold tracking-wide text-xs uppercase mb-4">
        Динамика звонков по дням
      </h3>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
          <XAxis dataKey="date" tick={{ fill: "#64748b", fontSize: 11 }} axisLine={{ stroke: "#334155" }} tickLine={false} />
          <YAxis tick={{ fill: "#64748b", fontSize: 11 }} axisLine={false} tickLine={false} allowDecimals={false} />
          <RTooltip
            contentStyle={{ background: "#0f172a", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12 }}
          />
          <Line type="monotone" dataKey="Звонки" stroke="#3b82f6" strokeWidth={2} dot={{ fill: "#3b82f6", r: 3 }} />
          <Line type="monotone" dataKey="Дозвон" stroke="#10b981" strokeWidth={2} dot={{ fill: "#10b981", r: 3 }} />
          <Line type="monotone" dataKey="Пропущ." stroke="#f43f5e" strokeWidth={2} dot={{ fill: "#f43f5e", r: 3 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function PipelineBreakdown({ pipelines }: { pipelines: PipelineStats[] }) {
  if (!pipelines || pipelines.length === 0) return null;
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
      {pipelines.map((p) => (
        <div key={p.pipelineId} className="glass-panel rounded-2xl p-5 border border-white/5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-slate-300 font-semibold tracking-wide text-xs uppercase">
              {p.pipelineName}
            </h3>
            <span className="text-slate-500 text-xs">{p.activeDeals} активных</span>
          </div>
          <table className="w-full text-sm">
            <tbody>
              {p.statuses.map((s) => {
                const pct = p.activeDeals > 0 ? Math.round((s.count / p.activeDeals) * 100) : 0;
                return (
                  <tr key={s.statusId} className="border-b border-white/[0.03]">
                    <td className="py-2 pr-3 text-slate-300 truncate max-w-[180px]">{s.name}</td>
                    <td className="py-2 w-full">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 bg-slate-800/60 rounded-full overflow-hidden">
                          <div className="h-full bg-blue-500/70" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="text-[11px] text-slate-500 min-w-[32px] text-right">{pct}%</span>
                      </div>
                    </td>
                    <td className="py-2 pl-3 text-right text-slate-300 tabular-nums min-w-[48px]">{s.count}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  sub,
  color = "blue",
}: {
  icon: LucideIcon;
  label: string;
  value: string | number;
  sub?: string;
  color?: "blue" | "emerald" | "amber" | "rose";
}) {
  const colorMap = {
    blue: { bg: "bg-blue-500/10", text: "text-blue-400" },
    emerald: { bg: "bg-emerald-500/10", text: "text-emerald-400" },
    amber: { bg: "bg-amber-500/10", text: "text-amber-400" },
    rose: { bg: "bg-rose-500/10", text: "text-rose-400" },
  };
  const c = colorMap[color];

  return (
    <div className="glass-panel rounded-2xl p-3 border border-white/5 group hover:border-blue-500/20 transition-all">
      <div className="flex items-center justify-between mb-2">
        <span className="text-slate-500 font-medium tracking-wider text-[10px] uppercase">{label}</span>
        <div className={`p-1.5 ${c.bg} rounded-md ${c.text}`}>
          <Icon className="w-3.5 h-3.5" />
        </div>
      </div>
      <div className={`text-xl font-bold ${c.text} tracking-tight`}>{value}</div>
      {sub && <div className="text-[10px] text-slate-500 mt-1">{sub}</div>}
    </div>
  );
}

