"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { TrendingUp, Users, Activity, Loader2, RefreshCw, ChevronLeft, ChevronRight, CalendarDays, UserCheck, UserX } from "lucide-react";

// ====================== TYPES ======================

interface MetricRow {
  key: string;
  label: string;
  plan: string | null;
  fact: string | null;
  percent: number | null;
  isGroupHeader: boolean;
}

interface ManagerData {
  id: string;
  name: string;
  kommoUserId: number | null;
  metrics: Array<{
    key: string;
    plan: string | null;
    fact: string | null;
    percent: number | null;
  }>;
}

interface Section {
  key: string;
  title: string;
  icon: string;
  dbLine: string;
  perManager: boolean;
  metrics: MetricRow[];
  managers: ManagerData[];
}

interface ScheduleManager {
  id: string;
  name: string;
  line: string | null;
  isOnLine: boolean;
}

interface ScheduleInfo {
  allManagers: ScheduleManager[];
  hasSchedule: boolean;
}

interface DailyResponse {
  date: string;
  period: string;
  periodType: string;
  periodDate: string;
  sections: Section[];
  schedule?: ScheduleInfo;
}

// ====================== HELPERS ======================

function getPercentColor(percent: number | null): string {
  if (percent === null) return "";
  if (percent >= 100) return "text-emerald-400";
  if (percent >= 80) return "text-amber-400";
  return "text-red-400";
}

function getPercentBg(percent: number | null): string {
  if (percent === null) return "";
  if (percent >= 100) return "bg-emerald-500/10";
  if (percent >= 80) return "bg-amber-500/10";
  return "bg-red-500/10";
}

function getSectionIcon(iconName: string) {
  switch (iconName) {
    case "TrendingUp":
      return <TrendingUp className="w-5 h-5 text-blue-400" />;
    case "Users":
      return <Users className="w-5 h-5 text-emerald-400" />;
    case "Activity":
      return <Activity className="w-5 h-5 text-purple-400" />;
    default:
      return <TrendingUp className="w-5 h-5 text-blue-400" />;
  }
}

function getSectionAccent(sectionKey: string): string {
  switch (sectionKey) {
    case "funnel": return "blue";
    case "qualifier": return "emerald";
    case "secondLine": return "purple";
    default: return "blue";
  }
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ====================== EDITABLE CELL ======================

function EditableCell({
  value,
  onSave,
  placeholder = "—",
}: {
  value: string | null;
  onSave: (val: string) => void;
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commit = () => {
    setEditing(false);
    if (draft !== (value || "")) {
      onSave(draft);
    }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setDraft(value || "");
            setEditing(false);
          }
        }}
        className="w-20 bg-slate-700/80 border border-blue-500/50 rounded px-2 py-0.5 text-white text-right text-sm font-mono outline-none focus:border-blue-400 transition-colors"
      />
    );
  }

  return (
    <button
      onClick={() => {
        setDraft(value || "");
        setEditing(true);
      }}
      className="min-w-[3rem] text-right font-mono text-sm cursor-pointer hover:bg-blue-500/10 rounded px-2 py-0.5 transition-colors border border-transparent hover:border-blue-500/30 text-blue-300"
      title="Нажмите для редактирования"
    >
      {value || placeholder}
    </button>
  );
}

// ====================== SECTION TABLE (NO PER-MANAGER) ======================

function FunnelTable({
  section,
  onPlanSave,
}: {
  section: Section;
  onPlanSave: (line: string, metricKey: string, value: string) => void;
}) {
  return (
    <div className="glass-panel text-slate-200 rounded-3xl overflow-hidden border border-white/5 shadow-2xl flex flex-col">
      <div className="p-5 border-b border-white/5 bg-slate-900/20 flex items-center gap-3">
        {getSectionIcon(section.icon)}
        <h3 className="text-sm font-bold tracking-widest uppercase text-white">
          {section.title}
        </h3>
      </div>
      <div className="w-full overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-white/10">
              <th className="px-5 py-3 text-[10px] uppercase tracking-widest text-slate-500 font-semibold w-[55%]">
                Метрика
              </th>
              <th className="px-3 py-3 text-[10px] uppercase tracking-widest text-slate-500 font-semibold text-right w-[15%]">
                План
              </th>
              <th className="px-3 py-3 text-[10px] uppercase tracking-widest text-slate-500 font-semibold text-right w-[15%]">
                Факт
              </th>
              <th className="px-3 py-3 text-[10px] uppercase tracking-widest text-slate-500 font-semibold text-right w-[15%]">
                %
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5 text-sm">
            {section.metrics.map((m) => {
              if (m.isGroupHeader) {
                return (
                  <tr key={m.key} className="bg-slate-800/30">
                    <td colSpan={4} className="px-5 py-2 text-[10px] uppercase tracking-widest text-blue-400 font-bold">
                      {m.label}
                    </td>
                  </tr>
                );
              }
              return (
                <tr key={m.key} className="hover:bg-white/[0.02] transition-colors group">
                  <td className="px-5 py-3 font-medium text-slate-300 group-hover:text-blue-200 transition-colors">
                    {m.label}
                  </td>
                  <td className="px-3 py-3 text-right">
                    {m.plan !== null || (section.metrics.find((x) => x.key === m.key) as any)?.hasPlan !== false ? (
                      <EditableCell
                        value={m.plan}
                        onSave={(v) => onPlanSave(section.dbLine, m.key, v)}
                      />
                    ) : (
                      <span className="text-slate-600">—</span>
                    )}
                  </td>
                  <td className="px-3 py-3 font-bold text-white text-right font-mono">
                    {m.fact ?? <span className="text-slate-600">—</span>}
                  </td>
                  <td className={`px-3 py-3 text-right font-bold font-mono ${getPercentColor(m.percent)} ${getPercentBg(m.percent)}`}>
                    {m.percent !== null ? `${m.percent}%` : ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ====================== SECTION TABLE (WITH PER-MANAGER) ======================

function ManagerTable({
  section,
  onPlanSave,
}: {
  section: Section;
  onPlanSave: (line: string, metricKey: string, value: string, userId?: string) => void;
}) {
  const [showManagers, setShowManagers] = useState(true);
  const accent = getSectionAccent(section.key);
  const nonHeaderMetrics = section.metrics.filter((m) => !m.isGroupHeader);
  const managers = section.managers;

  return (
    <div className="glass-panel text-slate-200 rounded-3xl overflow-hidden border border-white/5 shadow-2xl flex flex-col">
      <div className="p-5 border-b border-white/5 bg-slate-900/20 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {getSectionIcon(section.icon)}
          <h3 className="text-sm font-bold tracking-widest uppercase text-white">
            {section.title}
          </h3>
          <span className="text-xs text-slate-500">
            ({managers.length} чел.)
          </span>
        </div>
        {managers.length > 0 && (
          <button
            onClick={() => setShowManagers(!showManagers)}
            className="text-xs text-slate-400 hover:text-white px-3 py-1.5 rounded-lg hover:bg-white/5 transition-colors"
          >
            {showManagers ? "Скрыть менеджеров" : "Показать менеджеров"}
          </button>
        )}
      </div>

      <div className="w-full overflow-x-auto">
        <table className="w-full text-left border-collapse min-w-[600px]">
          <thead>
            <tr className="border-b border-white/10">
              <th className="px-5 py-3 text-[10px] uppercase tracking-widest text-slate-500 font-semibold sticky left-0 bg-slate-900/80 backdrop-blur-sm z-10 min-w-[200px]">
                Метрика
              </th>
              {/* Summary columns — highlighted */}
              <th className="px-3 py-2 text-center border-l-2 border-r-2 border-blue-400/60 bg-blue-500/15" colSpan={3}>
                <span className="text-[10px] uppercase tracking-widest text-blue-300 font-bold">Итого</span>
              </th>
              {/* Per-manager columns */}
              {showManagers &&
                managers.map((mgr) => (
                  <th
                    key={mgr.id}
                    className="px-2 py-2 text-center border-l border-white/10"
                    colSpan={3}
                  >
                    <span className="text-[10px] uppercase tracking-wider text-slate-400 font-bold whitespace-nowrap">
                      {mgr.name}
                    </span>
                    {!mgr.kommoUserId && (
                      <span className="block text-[9px] text-amber-500" title="Нет привязки к Kommo">
                        ⚠ нет Kommo ID
                      </span>
                    )}
                  </th>
                ))}
            </tr>
            <tr className="border-b border-white/5">
              <th className="sticky left-0 bg-slate-900/80 backdrop-blur-sm z-10"></th>
              {/* Summary sub-headers — highlighted */}
              <th className="px-2 py-1 text-[9px] uppercase text-blue-400/80 text-right font-medium border-l-2 border-blue-400/60 bg-blue-500/10">
                План
              </th>
              <th className="px-2 py-1 text-[9px] uppercase text-blue-400/80 text-right font-medium bg-blue-500/10">
                Факт
              </th>
              <th className="px-2 py-1 text-[9px] uppercase text-blue-400/80 text-right font-medium border-r-2 border-blue-400/60 bg-blue-500/10">
                %
              </th>
              {/* Per-manager sub-headers */}
              {showManagers &&
                managers.map((mgr) => (
                  <th key={`${mgr.id}-sub`} className="border-l border-white/10" colSpan={3}>
                    <div className="flex">
                      <span className="flex-1 px-1 py-1 text-[9px] uppercase text-slate-500 text-right font-medium">П</span>
                      <span className="flex-1 px-1 py-1 text-[9px] uppercase text-slate-500 text-right font-medium">Ф</span>
                      <span className="flex-1 px-1 py-1 text-[9px] uppercase text-slate-500 text-right font-medium">%</span>
                    </div>
                  </th>
                ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5 text-sm">
            {section.metrics.map((m, rowIdx) => {
              if (m.isGroupHeader) {
                const totalCols = 4 + (showManagers ? managers.length * 3 : 0);
                const accentColor =
                  accent === "emerald" ? "text-emerald-400" :
                  accent === "purple" ? "text-purple-400" :
                  "text-blue-400";
                return (
                  <tr key={m.key} className="bg-slate-800/30">
                    <td
                      colSpan={totalCols}
                      className={`px-5 py-2 text-[10px] uppercase tracking-widest ${accentColor} font-bold`}
                    >
                      {m.label}
                    </td>
                  </tr>
                );
              }

              // Find the non-header index for per-manager lookup
              const nonHeaderIdx = nonHeaderMetrics.findIndex((x) => x.key === m.key);

              return (
                <tr key={m.key} className="hover:bg-white/[0.02] transition-colors group">
                  {/* Metric label */}
                  <td className="px-5 py-2.5 font-medium text-slate-300 group-hover:text-white transition-colors sticky left-0 bg-slate-900/60 backdrop-blur-sm z-10 text-[13px]">
                    {m.label}
                  </td>

                  {/* Summary Plan — highlighted */}
                  <td className="px-2 py-2 text-right border-l-2 border-blue-400/60 bg-blue-500/[0.07]">
                    <EditableCell
                      value={m.plan}
                      onSave={(v) => onPlanSave(section.dbLine, m.key, v)}
                    />
                  </td>

                  {/* Summary Fact — highlighted */}
                  <td className="px-2 py-2 font-bold text-white text-right font-mono text-[13px] bg-blue-500/[0.07]">
                    {m.fact ?? <span className="text-slate-600 font-normal">—</span>}
                  </td>

                  {/* Summary % — highlighted */}
                  <td className={`px-2 py-2 text-right font-bold font-mono text-[13px] border-r-2 border-blue-400/60 bg-blue-500/[0.07] ${getPercentColor(m.percent)}`}>
                    {m.percent !== null ? `${m.percent}%` : ""}
                  </td>

                  {/* Per-manager cells */}
                  {showManagers &&
                    managers.map((mgr) => {
                      const mgrMetric = mgr.metrics[nonHeaderIdx];
                      if (!mgrMetric) {
                        return (
                          <td key={mgr.id} colSpan={3} className="border-l border-white/10">
                            <span className="text-slate-600 text-xs">—</span>
                          </td>
                        );
                      }

                      return (
                        <td key={mgr.id} colSpan={3} className="border-l border-white/10">
                          <div className="flex">
                            {/* Manager Plan */}
                            <span className="flex-1 px-1 py-1 text-right">
                              <EditableCell
                                value={mgrMetric.plan}
                                onSave={(v) =>
                                  onPlanSave(section.dbLine, m.key, v, mgr.id)
                                }
                              />
                            </span>
                            {/* Manager Fact */}
                            <span className="flex-1 px-1 py-1 text-right font-mono text-[12px] text-slate-300">
                              {mgrMetric.fact ?? "—"}
                            </span>
                            {/* Manager % */}
                            <span
                              className={`flex-1 px-1 py-1 text-right font-mono text-[12px] font-bold ${getPercentColor(mgrMetric.percent)}`}
                            >
                              {mgrMetric.percent !== null ? `${mgrMetric.percent}%` : ""}
                            </span>
                          </div>
                        </td>
                      );
                    })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ====================== SCHEDULE PANEL ======================

function SchedulePanel({
  schedule,
  dateStr,
  onToggle,
}: {
  schedule: ScheduleInfo;
  dateStr: string;
  onToggle: (userId: string, isOnLine: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  // Group by line
  const line1 = schedule.allManagers.filter((m) => m.line === "1");
  const line2 = schedule.allManagers.filter((m) => m.line === "2");

  const onLineCount = schedule.allManagers.filter((m) => m.isOnLine).length;
  const totalCount = schedule.allManagers.length;

  return (
    <div className="glass-panel text-slate-200 rounded-2xl overflow-hidden border border-white/5 shadow-lg">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full p-4 flex items-center justify-between hover:bg-white/[0.02] transition-colors"
      >
        <div className="flex items-center gap-3">
          <CalendarDays className="w-4 h-4 text-amber-400" />
          <span className="text-sm font-bold tracking-wide uppercase text-white">
            На линии сегодня
          </span>
          <span className="text-xs text-slate-400">
            {onLineCount} из {totalCount}
          </span>
          {!schedule.hasSchedule && (
            <span className="text-[10px] bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded-full">
              расписание не задано
            </span>
          )}
        </div>
        <span className="text-slate-500 text-xs">
          {expanded ? "▲ Свернуть" : "▼ Развернуть"}
        </span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3">
          {/* Line 1 */}
          {line1.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-widest text-emerald-400 font-bold mb-2">
                Первая линия (квалификаторы)
              </div>
              <div className="flex flex-wrap gap-2">
                {line1.map((mgr) => (
                  <button
                    key={mgr.id}
                    onClick={() => onToggle(mgr.id, !mgr.isOnLine)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 border ${
                      mgr.isOnLine
                        ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25"
                        : "bg-slate-800/50 border-white/5 text-slate-500 hover:bg-slate-700/50 hover:text-slate-300"
                    }`}
                  >
                    {mgr.isOnLine ? (
                      <UserCheck className="w-3 h-3" />
                    ) : (
                      <UserX className="w-3 h-3" />
                    )}
                    {mgr.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Line 2 */}
          {line2.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-widest text-purple-400 font-bold mb-2">
                Вторая линия
              </div>
              <div className="flex flex-wrap gap-2">
                {line2.map((mgr) => (
                  <button
                    key={mgr.id}
                    onClick={() => onToggle(mgr.id, !mgr.isOnLine)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 border ${
                      mgr.isOnLine
                        ? "bg-purple-500/15 border-purple-500/30 text-purple-300 hover:bg-purple-500/25"
                        : "bg-slate-800/50 border-white/5 text-slate-500 hover:bg-slate-700/50 hover:text-slate-300"
                    }`}
                  >
                    {mgr.isOnLine ? (
                      <UserCheck className="w-3 h-3" />
                    ) : (
                      <UserX className="w-3 h-3" />
                    )}
                    {mgr.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <p className="text-[10px] text-slate-600 mt-2">
            Нажмите на менеджера чтобы включить/выключить. Данные обновятся автоматически.
          </p>
        </div>
      )}
    </div>
  );
}

// ====================== MAIN COMPONENT ======================

export default function DailyTab({ department }: { department: "b2g" | "b2b" }) {
  const [period, setPeriod] = useState<"day" | "week" | "month" | "year">("day");
  const [date, setDate] = useState<Date>(new Date());
  const [data, setData] = useState<DailyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const dateStr = formatDate(date);
      const res = await fetch(
        `/api/daily?department=${department}&period=${period}&date=${dateStr}`,
        { signal }
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`API error ${res.status}: ${text}`);
      }
      const json = await res.json();
      setData(json);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      if (e instanceof TypeError && (e as TypeError).message === "Failed to fetch") return;
      console.error("Daily fetch error:", e);
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

  // Navigate date
  const shiftDate = (dir: -1 | 1) => {
    const d = new Date(date);
    switch (period) {
      case "day":
        d.setDate(d.getDate() + dir);
        break;
      case "week":
        d.setDate(d.getDate() + 7 * dir);
        break;
      case "month":
        d.setMonth(d.getMonth() + dir);
        break;
      case "year":
        d.setFullYear(d.getFullYear() + dir);
        break;
    }
    setDate(d);
  };

  // Save plan value
  const handlePlanSave = async (
    line: string,
    metricKey: string,
    value: string,
    userId?: string
  ) => {
    if (!data) return;
    setSaving(true);
    try {
      const res = await fetch("/api/daily/plans", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          department,
          line,
          userId: userId || null,
          metricKey,
          planValue: value,
          periodType: data.periodType,
          periodDate: data.periodDate,
        }),
      });
      if (!res.ok) {
        console.error("Plan save error:", await res.text());
      }
      // Refresh data
      await fetchData();
    } catch (e) {
      console.error("Plan save error:", e);
    } finally {
      setSaving(false);
    }
  };

  // Toggle manager schedule (on-line/off-line for day view)
  const handleScheduleToggle = async (userId: string, isOnLine: boolean) => {
    if (!data) return;
    setSaving(true);
    try {
      const res = await fetch("/api/daily/schedule", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          date: data.date,
          isOnLine,
        }),
      });
      if (!res.ok) {
        console.error("Schedule save error:", await res.text());
      }
      // Refresh data to apply filtering
      await fetchData();
    } catch (e) {
      console.error("Schedule save error:", e);
    } finally {
      setSaving(false);
    }
  };

  // Date display
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
    <div className="flex flex-col gap-6 fade-in flex-1 overflow-y-auto pb-6 scrollbar-hide">
      {/* Controls */}
      <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
        {/* Period tabs */}
        <div className="flex bg-slate-800/50 p-1.5 rounded-xl border border-white/5 shadow-inner overflow-x-auto scrollbar-hide">
          {([
            { id: "day", label: "День" },
            { id: "week", label: "Неделя" },
            { id: "month", label: "Месяц" },
            { id: "year", label: "Год" },
          ] as const).map((f) => (
            <button
              key={f.id}
              onClick={() => setPeriod(f.id)}
              className={`px-4 py-2 rounded-lg text-[11px] uppercase tracking-widest font-bold transition-all duration-300 flex-shrink-0 ${
                period === f.id
                  ? "bg-blue-500/20 text-blue-400 border border-blue-500/30 shadow-md"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Date navigator */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => shiftDate(-1)}
            className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-sm text-slate-300 font-medium min-w-[180px] text-center">
            {dateDisplay}
          </span>
          <button
            onClick={() => shiftDate(1)}
            className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition-colors"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          <button
            onClick={() => setDate(new Date())}
            className="text-[10px] uppercase tracking-wider px-3 py-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition-colors border border-white/5"
          >
            Сегодня
          </button>
          <button
            onClick={() => fetchData()}
            disabled={loading}
            className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition-colors disabled:opacity-30"
            title="Обновить"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </button>
          {saving && (
            <span className="text-[10px] text-blue-400 ml-2 flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" /> Сохранение...
            </span>
          )}
        </div>
      </div>

      {/* Loading */}
      {loading && !data && (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 text-blue-400 animate-spin" />
          <span className="ml-3 text-slate-400">Загрузка данных из Kommo...</span>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="glass-panel rounded-2xl p-6 border border-red-500/20 bg-red-500/5">
          <p className="text-red-400 text-sm">Ошибка: {error}</p>
          <button
            onClick={() => fetchData()}
            className="mt-3 text-xs text-red-300 underline hover:text-white"
          >
            Попробовать снова
          </button>
        </div>
      )}

      {/* Schedule Panel (only for day view) */}
      {data && !loading && period === "day" && data.schedule && (
        <SchedulePanel
          schedule={data.schedule}
          dateStr={data.date}
          onToggle={handleScheduleToggle}
        />
      )}

      {/* Sections */}
      {data && !loading && data.sections.map((section) => {
        if (!section.perManager) {
          return (
            <FunnelTable
              key={section.key}
              section={section}
              onPlanSave={handlePlanSave}
            />
          );
        }

        return (
          <ManagerTable
            key={section.key}
            section={section}
            onPlanSave={handlePlanSave}
          />
        );
      })}

      {/* Data with loading overlay */}
      {data && loading && (
        <div className="fixed top-4 right-4 z-50 bg-slate-800/90 border border-white/10 rounded-xl px-4 py-2 flex items-center gap-2 shadow-xl">
          <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
          <span className="text-xs text-slate-400">Обновление...</span>
        </div>
      )}
    </div>
  );
}
