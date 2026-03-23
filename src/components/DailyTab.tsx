"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { TrendingUp, Users, Activity, Loader2, RefreshCw, ChevronLeft, ChevronRight, CalendarDays, UserCheck, UserX } from "lucide-react";
import CalendarPicker from "@/components/CalendarPicker";
import DinoLoader from "@/components/DinoLoader";

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

// ====================== UNIFIED TABLE ======================

// Returns a Tailwind accent colour token for a given section key
function getSectionAccentColor(sectionKey: string): string {
  switch (sectionKey) {
    case "funnel": return "text-blue-400";
    case "qualifier": return "text-emerald-400";
    case "secondLine": return "text-purple-400";
    default: return "text-blue-400";
  }
}

// Section-separator row rendered inside the unified table body
function SectionHeaderRow({
  section,
  colSpan,
}: {
  section: Section;
  colSpan: number;
}) {
  return (
    <tr className="bg-slate-900/40 border-t-2 border-white/10">
      <td
        colSpan={colSpan}
        className="px-5 py-2.5 sticky left-0 bg-slate-900/40"
      >
        <div className="flex items-center gap-2">
          {getSectionIcon(section.icon)}
          <span className={`text-[10px] uppercase tracking-widest font-bold ${getSectionAccentColor(section.key)}`}>
            {section.title}
          </span>
        </div>
      </td>
    </tr>
  );
}

function UnifiedTable({
  sections,
  viewMode,
  onPlanSave,
}: {
  sections: Section[];
  viewMode: "summary" | "managers";
  onPlanSave: (line: string, metricKey: string, value: string, userId?: string) => void;
}) {
  // Collect all managers that appear in any section (including funnel with split leads)
  const allManagers: ManagerData[] = (() => {
    const seen = new Set<string>();
    const result: ManagerData[] = [];
    for (const sec of sections) {
      for (const mgr of sec.managers) {
        if (!seen.has(mgr.id)) {
          seen.add(mgr.id);
          result.push(mgr);
        }
      }
    }
    return result;
  })();

  // Summary mode: Метрика | План | Факт | %
  if (viewMode === "summary") {
    return (
      <div className="glass-panel text-slate-200 rounded-3xl overflow-hidden border border-white/5 shadow-2xl flex flex-col">
        <div className="w-full overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/10">
                <th className="px-5 py-3 text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
                  Метрика
                </th>
                <th className="px-3 py-3 text-[10px] uppercase tracking-widest text-slate-500 font-semibold text-right w-[13%]">
                  План
                </th>
                <th className="px-3 py-3 text-[10px] uppercase tracking-widest text-slate-500 font-semibold text-right w-[13%]">
                  Факт
                </th>
                <th className="px-3 py-3 text-[10px] uppercase tracking-widest text-slate-500 font-semibold text-right w-[10%]">
                  %
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5 text-sm">
              {sections.map((section) => (
                <>
                  {/* Section separator */}
                  <SectionHeaderRow
                    key={`sep-${section.key}`}
                    section={section}
                    colSpan={4}
                  />

                  {section.metrics.map((m) => {
                    if (m.isGroupHeader) {
                      return (
                        <tr key={`${section.key}-${m.key}`} className="bg-slate-800/30">
                          <td colSpan={4} className="px-5 py-2 text-[10px] uppercase tracking-widest text-slate-500 font-bold pl-10">
                            {m.label}
                          </td>
                        </tr>
                      );
                    }
                    return (
                      <tr key={`${section.key}-${m.key}`} className="hover:bg-white/[0.02] transition-colors group">
                        <td className="px-5 py-3 font-medium text-slate-300 group-hover:text-white transition-colors pl-10">
                          {m.label}
                        </td>
                        <td className="px-3 py-3 text-right">
                          <EditableCell
                            value={m.plan}
                            onSave={(v) => onPlanSave(section.dbLine, m.key, v)}
                          />
                        </td>
                        <td className="px-3 py-3 font-bold text-white text-right font-mono">
                          {m.fact ?? <span className="text-slate-600 font-normal">—</span>}
                        </td>
                        <td className={`px-3 py-3 text-right font-bold font-mono ${getPercentColor(m.percent)} ${getPercentBg(m.percent)}`}>
                          {m.percent !== null ? `${m.percent}%` : ""}
                        </td>
                      </tr>
                    );
                  })}
                </>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // Managers mode: sticky metric col | Итого (Fact/%) | manager columns (Fact only)
  // colSpan for a full row: 1 (metric) + 2 (итого) + allManagers.length (one Fact col each)
  const totalCols = 1 + 2 + allManagers.length;

  return (
    <div className="glass-panel text-slate-200 rounded-3xl overflow-hidden border border-white/5 shadow-2xl flex flex-col">
      <div className="w-full overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            {/* Top row: column group headers */}
            <tr className="border-b border-white/10">
              <th className="px-5 py-3 text-[10px] uppercase tracking-widest text-slate-500 font-semibold sticky left-0 bg-slate-900/80 backdrop-blur-sm z-10 min-w-[220px]">
                Метрика
              </th>
              {/* Итого group */}
              <th
                colSpan={2}
                className="px-3 py-2 text-center border-l-2 border-r-2 border-blue-400/60 bg-blue-500/15"
              >
                <span className="text-[10px] uppercase tracking-widest text-blue-300 font-bold">
                  Итого
                </span>
              </th>
              {/* Per-manager single-column headers */}
              {allManagers.map((mgr) => {
                const parts = mgr.name.split(" ");
                return (
                <th
                  key={mgr.id}
                  className="px-2 py-2 text-center border-l border-white/10 min-w-[70px]"
                >
                  <span className="text-[10px] uppercase tracking-wider text-slate-400 font-bold leading-tight block">
                    {parts[0]}
                  </span>
                  {parts[1] && (
                    <span className="text-[9px] uppercase tracking-wider text-slate-500 font-medium leading-tight block">
                      {parts[1]}
                    </span>
                  )}
                  {!mgr.kommoUserId && (
                    <span
                      className="block text-[9px] text-amber-500"
                      title="Нет привязки к Kommo"
                    >
                      ! Kommo
                    </span>
                  )}
                </th>
              );
              })}
            </tr>

            {/* Sub-header row: Ф / % under Итого, Факт label under each manager */}
            <tr className="border-b border-white/5">
              <th className="sticky left-0 bg-slate-900/80 backdrop-blur-sm z-10" />
              <th className="px-2 py-1 text-[9px] uppercase text-blue-400/80 text-right font-medium border-l-2 border-blue-400/60 bg-blue-500/10">
                Факт
              </th>
              <th className="px-2 py-1 text-[9px] uppercase text-blue-400/80 text-right font-medium border-r-2 border-blue-400/60 bg-blue-500/10">
                %
              </th>
              {allManagers.map((mgr) => (
                <th
                  key={`${mgr.id}-sub`}
                  className="px-2 py-1 text-[9px] uppercase text-slate-500 text-right font-medium border-l border-white/10"
                >
                  Факт
                </th>
              ))}
            </tr>
          </thead>

          <tbody className="divide-y divide-white/5 text-sm">
            {sections.map((section) => {
              // Build a map: managerId → their metrics array for this section (non-header only)
              const nonHeaderMetrics = section.metrics.filter((m) => !m.isGroupHeader);
              const mgrMetricMap = new Map<string, typeof section.managers[0]["metrics"]>();
              for (const mgr of section.managers) {
                mgrMetricMap.set(mgr.id, mgr.metrics);
              }

              return (
                <>
                  {/* Section separator */}
                  <SectionHeaderRow
                    key={`sep-${section.key}`}
                    section={section}
                    colSpan={totalCols}
                  />

                  {section.metrics.map((m) => {
                    if (m.isGroupHeader) {
                      return (
                        <tr key={`${section.key}-${m.key}`} className="bg-slate-800/30">
                          <td
                            colSpan={totalCols}
                            className="px-5 py-2 text-[10px] uppercase tracking-widest text-slate-500 font-bold sticky left-0 bg-slate-800/30 pl-10"
                          >
                            {m.label}
                          </td>
                        </tr>
                      );
                    }

                    const nonHeaderIdx = nonHeaderMetrics.findIndex((x) => x.key === m.key);

                    return (
                      <tr key={`${section.key}-${m.key}`} className="hover:bg-white/[0.02] transition-colors group">
                        {/* Sticky metric label */}
                        <td className="px-5 py-2.5 font-medium text-slate-300 group-hover:text-white transition-colors sticky left-0 bg-slate-900/60 backdrop-blur-sm z-10 text-[13px] pl-10">
                          {m.label}
                        </td>

                        {/* Итого Fact */}
                        <td className="px-2 py-2 font-bold text-white text-right font-mono text-[13px] border-l-2 border-blue-400/60 bg-blue-500/[0.07]">
                          {m.fact ?? <span className="text-slate-600 font-normal">—</span>}
                        </td>

                        {/* Итого % */}
                        <td
                          className={`px-2 py-2 text-right font-bold font-mono text-[13px] border-r-2 border-blue-400/60 bg-blue-500/[0.07] ${getPercentColor(m.percent)}`}
                        >
                          {m.percent !== null ? `${m.percent}%` : ""}
                        </td>

                        {/* Per-manager Fact cells */}
                        {allManagers.map((mgr) => {
                          const mgrMetrics = mgrMetricMap.get(mgr.id);
                          const mgrMetric = mgrMetrics?.[nonHeaderIdx];

                          if (!mgrMetric) {
                            return (
                              <td
                                key={mgr.id}
                                className="px-2 py-2 text-center border-l border-white/10 text-slate-600 font-mono text-[12px]"
                              >
                                —
                              </td>
                            );
                          }

                          return (
                            <td
                              key={mgr.id}
                              className={`px-2 py-2 text-right border-l border-white/10 font-mono text-[12px] font-bold ${getPercentColor(mgrMetric.percent)}`}
                            >
                              {mgrMetric.fact ?? <span className="text-slate-600 font-normal">—</span>}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ====================== ACTIVE MANAGERS PANEL ======================

function ActiveManagersPanel({
  schedule,
  dateStr,
  onSave,
  saving,
}: {
  schedule: ScheduleInfo;
  dateStr: string;
  onSave: (selectedIds: Set<string>) => void;
  saving: boolean;
}) {
  const [expanded, setExpanded] = useState(!schedule.hasSchedule);
  const [selected, setSelected] = useState<Set<string>>(() => {
    const s = new Set<string>();
    for (const m of schedule.allManagers) {
      if (m.isOnLine) s.add(m.id);
    }
    return s;
  });
  const [dirty, setDirty] = useState(false);

  // Sync selected state when schedule data changes from server
  useEffect(() => {
    const s = new Set<string>();
    for (const m of schedule.allManagers) {
      if (m.isOnLine) s.add(m.id);
    }
    setSelected(s);
    setDirty(false);
  }, [schedule]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setDirty(true);
  };

  const selectAll = () => {
    setSelected(new Set(schedule.allManagers.map((m) => m.id)));
    setDirty(true);
  };

  const deselectAll = () => {
    setSelected(new Set());
    setDirty(true);
  };

  const line1 = schedule.allManagers.filter((m) => m.line === "1");
  const line2 = schedule.allManagers.filter((m) => m.line === "2");
  const activeCount = schedule.allManagers.filter((m) => m.isOnLine).length;

  return (
    <div className="glass-panel text-slate-200 rounded-2xl overflow-hidden border border-white/5 shadow-lg">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full p-4 flex items-center justify-between hover:bg-white/[0.02] transition-colors"
      >
        <div className="flex items-center gap-3">
          <CalendarDays className="w-4 h-4 text-amber-400" />
          <span className="text-sm font-bold tracking-wide uppercase text-white">
            Активные менеджеры
          </span>
          {schedule.hasSchedule ? (
            <span className="text-xs text-emerald-400 bg-emerald-500/15 px-2 py-0.5 rounded-full">
              {activeCount} на линии
            </span>
          ) : (
            <span className="text-[10px] bg-red-500/20 text-red-400 px-2 py-0.5 rounded-full font-medium">
              не заполнено — данные скрыты
            </span>
          )}
        </div>
        <span className="text-slate-500 text-xs">
          {expanded ? "▲" : "▼"}
        </span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3">
          {/* Select all / deselect all */}
          <div className="flex gap-2">
            <button
              onClick={selectAll}
              className="text-[10px] uppercase tracking-wider px-3 py-1.5 rounded-lg text-emerald-400 hover:bg-emerald-500/15 transition-colors border border-emerald-500/20"
            >
              Выбрать всех
            </button>
            <button
              onClick={deselectAll}
              className="text-[10px] uppercase tracking-wider px-3 py-1.5 rounded-lg text-slate-400 hover:bg-white/5 transition-colors border border-white/10"
            >
              Снять всех
            </button>
          </div>

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
                    onClick={() => toggle(mgr.id)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 border ${
                      selected.has(mgr.id)
                        ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25"
                        : "bg-slate-800/50 border-white/5 text-slate-500 hover:bg-slate-700/50 hover:text-slate-300"
                    }`}
                  >
                    {selected.has(mgr.id) ? (
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
                    onClick={() => toggle(mgr.id)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 border ${
                      selected.has(mgr.id)
                        ? "bg-purple-500/15 border-purple-500/30 text-purple-300 hover:bg-purple-500/25"
                        : "bg-slate-800/50 border-white/5 text-slate-500 hover:bg-slate-700/50 hover:text-slate-300"
                    }`}
                  >
                    {selected.has(mgr.id) ? (
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

          {/* Save button */}
          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={() => onSave(selected)}
              disabled={saving}
              className={`px-5 py-2 rounded-xl text-xs font-bold uppercase tracking-wider transition-all duration-200 ${
                dirty
                  ? "bg-blue-500 text-white hover:bg-blue-400 shadow-lg shadow-blue-500/25"
                  : "bg-blue-500/20 text-blue-300 hover:bg-blue-500/30"
              } disabled:opacity-50`}
            >
              {saving ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="w-3 h-3 animate-spin" /> Сохранение...
                </span>
              ) : (
                "Сохранить"
              )}
            </button>
            {dirty && (
              <span className="text-[10px] text-amber-400">
                Есть несохранённые изменения
              </span>
            )}
            <span className="text-[10px] text-slate-500 ml-auto">
              Выбрано: {selected.size} из {schedule.allManagers.length}
            </span>
          </div>
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
  const [viewMode, setViewMode] = useState<"summary" | "managers">("summary");

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    // Only show full loading on first load (no data yet)
    if (!data) setLoading(true);
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

  // Save plan value — always stored as monthly plan
  const handlePlanSave = async (
    line: string,
    metricKey: string,
    value: string,
    userId?: string
  ) => {
    if (!data) return;
    setSaving(true);
    try {
      // Convert displayed value back to monthly plan
      let monthlyValue = value;
      const num = Number(value);
      if (!Number.isNaN(num) && data.periodType !== "month") {
        const d = new Date(date);
        const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        if (data.periodType === "day") {
          monthlyValue = String(Math.round(num * daysInMonth));
        } else if (data.periodType === "week") {
          monthlyValue = String(Math.round(num * (daysInMonth / 7)));
        } else if (data.periodType === "year") {
          monthlyValue = String(Math.round(num / 12));
        }
      }

      // Always save as month period
      const monthDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
      const res = await fetch("/api/daily/plans", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          department,
          line,
          userId: userId || null,
          metricKey,
          planValue: monthlyValue,
          periodType: "month",
          periodDate: monthDate,
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

  // Save active managers for the day
  const handleSaveActiveManagers = async (selectedIds: Set<string>) => {
    if (!data?.schedule) return;
    setSaving(true);
    try {
      const managers = data.schedule.allManagers
        .filter((m) => selectedIds.has(m.id))
        .map((m) => ({ managerId: m.id, managerName: m.name, line: m.line }));

      const res = await fetch("/api/daily/active-managers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: data.date,
          department,
          managers,
        }),
      });
      if (!res.ok) {
        console.error("Active managers save error:", await res.text());
      }
      // Also update old schedule table for filtering compatibility
      const entries = data.schedule.allManagers.map((m) => ({
        userId: m.id,
        isOnLine: selectedIds.has(m.id),
      }));
      await fetch("/api/daily/schedule", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: data.date, entries }),
      });
      // Refresh data to apply filtering
      await fetchData();
    } catch (e) {
      console.error("Active managers save error:", e);
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
        {/* Period tabs + Calendar + View mode toggle */}
        <div className="flex items-center gap-2 flex-wrap">
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

          {/* View mode toggle */}
          <div className="flex bg-slate-800/50 p-1.5 rounded-xl border border-white/5 shadow-inner">
            {([
              { id: "summary", label: "Общая статистика" },
              { id: "managers", label: "Менеджеры" },
            ] as const).map((v) => (
              <button
                key={v.id}
                onClick={() => setViewMode(v.id)}
                className={`px-4 py-2 rounded-lg text-[11px] uppercase tracking-widest font-bold transition-all duration-300 flex-shrink-0 ${
                  viewMode === v.id
                    ? "bg-blue-500/20 text-blue-400 border border-blue-500/30 shadow-md"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                {v.label}
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
          {formatDate(date) !== formatDate(new Date()) && (
            <button
              onClick={() => setDate(new Date())}
              className="text-[10px] uppercase tracking-wider px-3 py-1.5 rounded-lg text-blue-400 hover:text-white bg-blue-500/10 hover:bg-blue-500/20 transition-colors border border-blue-500/20"
            >
              Сегодня
            </button>
          )}
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

      {/* First load */}
      {loading && !data && <DinoLoader />}

      {/* Background refresh indicator */}
      {loading && data && (
        <div className="flex items-center justify-center py-2">
          <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-blue-500/10 border border-blue-500/20">
            <Loader2 className="w-3 h-3 animate-spin text-blue-400" />
            <span className="text-[10px] text-blue-400 font-medium">Обновление данных...</span>
          </div>
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

      {/* Active Managers Panel (only for day view) */}
      {data && !loading && period === "day" && data.schedule && (
        <ActiveManagersPanel
          schedule={data.schedule}
          dateStr={data.date}
          onSave={handleSaveActiveManagers}
          saving={saving}
        />
      )}

      {/* Block data if active managers not set for day view */}
      {data && !loading && period === "day" && data.schedule && !data.schedule.hasSchedule && (
        <div className="glass-panel rounded-2xl p-8 border border-amber-500/20 bg-amber-500/5 text-center">
          <p className="text-amber-400 text-sm font-medium">
            Выберите активных менеджеров на сегодня и нажмите «Сохранить» чтобы увидеть данные
          </p>
        </div>
      )}

      {/* Unified table — hidden if schedule not set on day view */}
      {data && !loading && (period !== "day" || !data.schedule || data.schedule.hasSchedule) && (
        <UnifiedTable
          sections={data.sections}
          viewMode={viewMode}
          onPlanSave={handlePlanSave}
        />
      )}

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
