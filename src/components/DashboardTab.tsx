"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Phone, Clock, AlertTriangle, Users,
  PhoneMissed, Target, Loader2, RefreshCw,
  ChevronLeft, ChevronRight,
} from "lucide-react";
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

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default function DashboardTab({ department }: { department: string }) {
  const [period, setPeriod] = useState<"day" | "week" | "month" | "year">("day");
  const [date, setDate] = useState<Date>(new Date());
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const dateStr = formatDate(date);
      const res = await fetch(`/api/dashboard?department=${department}&period=${period}&date=${dateStr}`, { signal });
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
  }, [department, period, date]);

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

  const m = data.todayMetrics;
  const f = data.funnel;
  const missed = data.missedBreakdown;

  const isB2G = department === "b2g";

  const shiftDate = (dir: -1 | 1) => {
    const d = new Date(date);
    switch (period) {
      case "day": d.setDate(d.getDate() + dir); break;
      case "week": d.setDate(d.getDate() + 7 * dir); break;
      case "month": d.setMonth(d.getMonth() + dir); break;
      case "year": d.setFullYear(d.getFullYear() + dir); break;
    }
    setDate(d);
  };

  const dateDisplay = (() => {
    switch (period) {
      case "day":
        return date.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
      case "week": {
        const d = new Date(date);
        const day = d.getDay();
        const diff = day === 0 ? -6 : 1 - day;
        const monday = new Date(d);
        monday.setDate(d.getDate() + diff);
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);
        return `${monday.toLocaleDateString("ru-RU", { day: "numeric", month: "short" })} — ${sunday.toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" })}`;
      }
      case "month":
        return date.toLocaleDateString("ru-RU", { month: "long", year: "numeric" });
      case "year":
        return `${date.getFullYear()} год`;
    }
  })();

  return (
    <div className="flex flex-col gap-4 fade-in">
      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex bg-slate-800/50 p-1.5 rounded-xl border border-white/5 shadow-inner">
            {([
              { id: "day", label: "День" },
              { id: "week", label: "Неделя" },
              { id: "month", label: "Месяц" },
              { id: "year", label: "Год" },
            ] as const).map((f) => (
              <button
                key={f.id}
                onClick={() => setPeriod(f.id)}
                className={`px-4 py-2 rounded-lg text-[11px] uppercase tracking-widest font-bold transition-all duration-300 ${
                  period === f.id
                    ? "bg-blue-500/20 text-blue-400 border border-blue-500/30 shadow-md"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <CalendarPicker
            mode="single"
            value={{ start: date, end: date }}
            onChange={(range) => { if (range.start) setDate(range.start); }}
            onClear={() => setDate(new Date())}
          />
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => shiftDate(-1)} className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition-colors">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-sm text-slate-300 font-medium min-w-[180px] text-center">{dateDisplay}</span>
          <button onClick={() => shiftDate(1)} className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition-colors">
            <ChevronRight className="w-4 h-4" />
          </button>
          {formatDate(date) !== formatDate(new Date()) && (
            <button onClick={() => setDate(new Date())} className="text-[10px] uppercase tracking-wider px-3 py-1.5 rounded-lg text-blue-400 hover:text-white bg-blue-500/10 hover:bg-blue-500/20 transition-colors border border-blue-500/20">
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

      {/* ============ KPI CARDS ============ */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <MetricCard icon={Phone} label="Звонки" value={m.callsTotal} sub={`${m.outgoingTotal} исх. / ${m.incomingTotal} вх.`} />
        <MetricCard icon={Target} label="Дозвон" value={`${m.dialPercent}%`} color={m.dialPercent >= 50 ? "emerald" : m.dialPercent >= 30 ? "amber" : "rose"} />
        <MetricCard icon={Clock} label="На линии" value={`${m.totalMinutes} мин`} sub={`Ср. диалог ${m.avgDialogMinutes} мин`} />
        <MetricCard icon={PhoneMissed} label="Пропущенные" value={m.missedIncoming} color={m.missedIncoming === 0 ? "emerald" : m.missedIncoming <= 3 ? "amber" : "rose"} sub={`${missed.missedPercent}% от входящих`} />
        <MetricCard icon={AlertTriangle} label="Просрочено задач" value={m.overdueTasks} color={m.overdueTasks === 0 ? "emerald" : "rose"} />
        <MetricCard icon={Users} label="Менеджеров" value={m.managersCount} />
      </div>




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

function MetricCard({
  icon: Icon,
  label,
  value,
  sub,
  color = "blue",
}: {
  icon: any;
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

