"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Phone, Clock, AlertTriangle, Users,
  PhoneMissed, Target, Loader2, RefreshCw,
} from "lucide-react";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, Legend,
} from "recharts";

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

export default function DashboardTab({ department }: { department: string }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/dashboard?department=${department}`, { signal });
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
  }, [department]);

  useEffect(() => {
    const ac = new AbortController();
    fetchData(ac.signal);
    return () => ac.abort();
  }, [fetchData]);

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-blue-400" />
        <span className="ml-3 text-slate-400">Загрузка данных из Kommo...</span>
      </div>
    );
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

  // Format day labels for trend chart
  const trendForChart = data.trend.map((t) => {
    const d = new Date(t.date + "T12:00:00");
    const dayNames = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
    return {
      ...t,
      label: dayNames[d.getDay()],
      dateShort: `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, "0")}`,
    };
  });

  const isB2G = department === "b2g";

  return (
    <div className="flex flex-col gap-4 fade-in">
      {/* Header with refresh */}
      <div className="flex items-center justify-between">
        <h2 className="text-slate-300 text-sm font-medium">
          Данные за {data.date} • {isB2G ? "Госники (B2G)" : "Коммерсы (B2B)"} • Kommo CRM
        </h2>
        <button
          onClick={() => fetchData()}
          disabled={loading}
          className="p-2 rounded-lg hover:bg-white/5 text-slate-400 hover:text-white transition-colors disabled:opacity-50"
          title="Обновить"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </button>
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

      {/* ============ FUNNEL ROW ============ */}
      {isB2G ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
          <FunnelCard label="Активных сделок" value={f.activeDeals ?? 0} />
          <FunnelCard label="Всего лидов" value={f.totalLeads ?? 0} />
          <FunnelCard label="Квал. лидов" value={f.qualLeads ?? 0} />
          <FunnelCard label="A2" value={f.a2 ?? 0} />
          <FunnelCard label="B1" value={f.b1 ?? 0} />
          <FunnelCard label="B2+" value={f.b2plus ?? 0} />
          <FunnelCard label="WON сегодня" value={f.wonToday ?? 0} color="emerald" />
          <FunnelCard label="LOST сегодня" value={f.lostToday ?? 0} color="rose" />
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
          <FunnelCard label="Активных сделок" value={f.activeDeals ?? 0} />
          <FunnelCard label="Новый лид" value={f.newLead ?? 0} />
          <FunnelCard label="В работе" value={f.inProgress ?? 0} />
          <FunnelCard label="Контакт установлен" value={f.contactMade ?? 0} />
          <FunnelCard label="Интерес подтвержден" value={f.interestConfirmed ?? 0} />
          <FunnelCard label="Счет выставлен" value={f.invoiceSent ?? 0} />
          <FunnelCard label="WON сегодня" value={f.wonToday ?? 0} color="emerald" />
          <FunnelCard label="LOST сегодня" value={f.lostToday ?? 0} color="rose" />
        </div>
      )}

      {/* ============ PIPELINE BREAKDOWN ============ */}
      {data.pipelineBreakdown && data.pipelineBreakdown.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {data.pipelineBreakdown.map((pipeline) => (
            <div key={pipeline.pipelineId} className="glass-panel rounded-2xl p-4 border border-white/5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-slate-300 font-semibold text-xs uppercase tracking-wide">
                  {pipeline.pipelineName}
                </h3>
                <span className="text-blue-400 font-bold text-sm">{pipeline.activeDeals} сделок</span>
              </div>
              <div className="space-y-1.5">
                {pipeline.statuses.map((s) => {
                  const maxCount = pipeline.statuses[0]?.count ?? 1;
                  const pct = Math.round((s.count / Math.max(maxCount, 1)) * 100);
                  return (
                    <div key={s.statusId} className="flex items-center gap-2">
                      <span className="text-slate-400 text-[11px] w-[160px] truncate flex-shrink-0">
                        {s.name}
                      </span>
                      <div className="flex-1 h-2 bg-white/5 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-blue-500/60 rounded-full transition-all"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="text-slate-300 text-[11px] font-medium w-8 text-right">
                        {s.count}
                      </span>
                    </div>
                  );
                })}
                {pipeline.statuses.length === 0 && (
                  <div className="text-slate-500 text-xs text-center py-2">Нет активных сделок</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ============ CHARTS ROW ============ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Calls trend */}
        <div className="glass-panel rounded-2xl p-5 border border-white/5">
          <h3 className="text-slate-300 font-semibold tracking-wide text-xs uppercase mb-4">
            Динамика звонков (7 дней)
          </h3>
          <div className="h-[220px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={trendForChart} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis dataKey="dateShort" stroke="#475569" fontSize={11} tickLine={false} axisLine={false} />
                <YAxis stroke="#475569" fontSize={10} tickLine={false} axisLine={false} />
                <Tooltip
                  contentStyle={{
                    background: "#0f172a",
                    border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: "12px",
                    fontSize: "12px",
                  }}
                  labelFormatter={(_, payload) => {
                    if (payload?.[0]) {
                      const item = payload[0].payload;
                      return `${item.label} ${item.dateShort}`;
                    }
                    return "";
                  }}
                />
                <Legend
                  verticalAlign="top"
                  height={30}
                  iconSize={8}
                  wrapperStyle={{ fontSize: "11px", color: "#94a3b8" }}
                />
                <Bar dataKey="callsTotal" name="Исходящие" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                <Bar dataKey="callsConnected" name="Дозвон" fill="#22c55e" radius={[4, 4, 0, 0]} />
                <Bar dataKey="missedIncoming" name="Пропущенные" fill="#f43f5e" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Time on line trend */}
        <div className="glass-panel rounded-2xl p-5 border border-white/5">
          <h3 className="text-slate-300 font-semibold tracking-wide text-xs uppercase mb-4">
            Время на линии (мин/день)
          </h3>
          <div className="h-[220px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trendForChart} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorMinutes" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis dataKey="dateShort" stroke="#475569" fontSize={11} tickLine={false} axisLine={false} />
                <YAxis stroke="#475569" fontSize={10} tickLine={false} axisLine={false} />
                <Tooltip
                  contentStyle={{
                    background: "#0f172a",
                    border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: "12px",
                    fontSize: "12px",
                  }}
                  formatter={(val) => [`${val} мин`, "На линии"]}
                />
                <Area
                  type="monotone"
                  dataKey="totalMinutes"
                  stroke="#8b5cf6"
                  fillOpacity={1}
                  fill="url(#colorMinutes)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* ============ PER-MANAGER TABLE ============ */}
      <div className="glass-panel rounded-2xl p-5 border border-white/5">
        <h3 className="text-slate-300 font-semibold tracking-wide text-xs uppercase mb-4">
          По менеджерам (сегодня)
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-slate-500 text-[10px] uppercase tracking-wider border-b border-white/5">
                <th className="text-left py-2 px-2 font-medium">Менеджер</th>
                <th className="text-left py-2 px-1 font-medium">Линия</th>
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
              {data.perManager.map((mgr) => (
                <tr
                  key={mgr.id}
                  className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors"
                >
                  <td className="py-2 px-2 text-white font-medium truncate max-w-[140px]">
                    {mgr.name}
                  </td>
                  <td className="py-2 px-1 text-slate-500 text-xs">
                    {mgr.line === "1" ? "1я" : mgr.line === "2" ? "2я" : "—"}
                  </td>
                  <td className="py-2 px-2 text-right text-slate-300">
                    {mgr.callsTotal}
                  </td>
                  <td className="py-2 px-2 text-right text-slate-300">
                    {mgr.callsConnected}
                  </td>
                  <td className="py-2 px-2 text-right">
                    <span className={
                      mgr.dialPercent >= 50 ? "text-emerald-400" :
                      mgr.dialPercent >= 30 ? "text-amber-400" :
                      "text-rose-400"
                    }>
                      {mgr.dialPercent}%
                    </span>
                  </td>
                  <td className="py-2 px-2 text-right text-slate-300">
                    {mgr.totalMinutes} мин
                  </td>
                  <td className="py-2 px-2 text-right text-slate-300">
                    {mgr.avgDialogMinutes} мин
                  </td>
                  <td className="py-2 px-2 text-right text-slate-300">
                    {mgr.incomingTotal}
                  </td>
                  <td className="py-2 px-2 text-right">
                    <span className={mgr.missedIncoming > 0 ? "text-rose-400" : "text-emerald-400"}>
                      {mgr.missedIncoming}
                    </span>
                  </td>
                  <td className="py-2 px-2 text-right">
                    <span className={mgr.overdueTasks > 0 ? "text-rose-400" : "text-slate-400"}>
                      {mgr.overdueTasks > 0 ? `⚠ ${mgr.overdueTasks}` : "0"}
                    </span>
                  </td>
                </tr>
              ))}
              {data.perManager.length === 0 && (
                <tr>
                  <td colSpan={10} className="py-8 text-center text-slate-500">
                    Нет данных по менеджерам
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
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

function FunnelCard({
  label,
  value,
  color = "slate",
}: {
  label: string;
  value: number;
  color?: "slate" | "emerald" | "rose";
}) {
  const valueColor =
    color === "emerald" ? "text-emerald-400" :
    color === "rose" ? "text-rose-400" :
    "text-white";

  return (
    <div className="glass-panel rounded-xl p-3 border border-white/5 text-center">
      <div className="text-lg font-bold tracking-tight">
        <span className={valueColor}>{value}</span>
      </div>
      <div className="text-[9px] text-slate-500 uppercase tracking-wider mt-1 font-medium">{label}</div>
    </div>
  );
}
