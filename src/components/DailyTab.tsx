"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  TrendingUp,
  Users,
  Activity,
  Loader2,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  UserCheck,
  UserX,
} from "lucide-react";
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

interface DailySnapshot {
  date: string;
  period: string;
  periodType: string;
  periodDate: string;
  sections: Section[];
  schedule?: ScheduleInfo;
}

interface RangeResponse {
  mode: "days" | "months";
  days?: DailySnapshot[];
  monthlySummary?: DailySnapshot;
  months?: DailySnapshot[];
  month?: string;
  year?: number;
}

// ====================== HELPERS ======================

function getSectionIcon(iconName: string) {
  switch (iconName) {
    case "TrendingUp":
      return <TrendingUp className="w-4 h-4 text-blue-400" />;
    case "Users":
      return <Users className="w-4 h-4 text-emerald-400" />;
    case "Activity":
      return <Activity className="w-4 h-4 text-purple-400" />;
    default:
      return <TrendingUp className="w-4 h-4 text-blue-400" />;
  }
}

function getCellColor(value: string | null): string {
  if (!value) return "text-slate-600";
  const num = Number(value);
  if (Number.isNaN(num)) return "text-white";
  if (num === 0) return "text-slate-600";
  return "text-white";
}

function formatDayLabel(dateStr: string): string {
  const d = new Date(dateStr);
  return `D${d.getDate()}`;
}

function formatDaySubLabel(dateStr: string): string {
  const d = new Date(dateStr);
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const MONTH_NAMES_SHORT = [
  "Янв", "Фев", "Мар", "Апр", "Май", "Июн",
  "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек",
];

const MONTH_NAMES = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

// Get fact value for a metric from a snapshot's section
function getMetricFact(snapshot: DailySnapshot | undefined, sectionKey: string, metricKey: string): string | null {
  if (!snapshot) return null;
  const section = snapshot.sections.find((s) => s.key === sectionKey);
  if (!section) return null;
  const metric = section.metrics.find((m) => m.key === metricKey);
  return metric?.fact ?? null;
}

// Get per-manager fact for a metric
function getManagerMetricFact(
  snapshot: DailySnapshot | undefined,
  sectionKey: string,
  metricKey: string,
  managerId: string
): string | null {
  if (!snapshot) return null;
  const section = snapshot.sections.find((s) => s.key === sectionKey);
  if (!section) return null;
  const mgr = section.managers.find((m) => m.id === managerId);
  if (!mgr) return null;
  const nonHeaderMetrics = section.metrics.filter((m) => !m.isGroupHeader);
  const idx = nonHeaderMetrics.findIndex((m) => m.key === metricKey);
  return mgr.metrics[idx]?.fact ?? null;
}

// Collect all unique managers from a snapshot
function collectManagers(snapshot: DailySnapshot | undefined): ManagerData[] {
  if (!snapshot) return [];
  const seen = new Set<string>();
  const result: ManagerData[] = [];
  for (const sec of snapshot.sections) {
    for (const mgr of sec.managers) {
      if (!seen.has(mgr.id)) {
        seen.add(mgr.id);
        result.push(mgr);
      }
    }
  }
  return result;
}

// Get all non-header metrics across all sections (flat list with section info)
function getAllMetrics(snapshot: DailySnapshot | undefined): Array<{
  sectionKey: string;
  sectionTitle: string;
  sectionIcon: string;
  metricKey: string;
  metricLabel: string;
  isGroupHeader: boolean;
}> {
  if (!snapshot) return [];
  const result: Array<{
    sectionKey: string;
    sectionTitle: string;
    sectionIcon: string;
    metricKey: string;
    metricLabel: string;
    isGroupHeader: boolean;
  }> = [];
  for (const sec of snapshot.sections) {
    // Add section header
    result.push({
      sectionKey: sec.key,
      sectionTitle: sec.title,
      sectionIcon: sec.icon,
      metricKey: `__section_${sec.key}`,
      metricLabel: sec.title,
      isGroupHeader: false,
    });
    for (const m of sec.metrics) {
      result.push({
        sectionKey: sec.key,
        sectionTitle: sec.title,
        sectionIcon: sec.icon,
        metricKey: m.key,
        metricLabel: m.label,
        isGroupHeader: m.isGroupHeader,
      });
    }
  }
  return result;
}

// ====================== SUMMARY TIME TABLE ======================
// Rows = metrics, Columns = days or months

function SummaryTimeTable({
  snapshots,
  columnLabels,
  columnSubLabels,
  selectedCol,
  onSelectCol,
}: {
  snapshots: DailySnapshot[];
  columnLabels: string[];
  columnSubLabels: string[];
  selectedCol: number | null;
  onSelectCol: (idx: number) => void;
}) {
  const referenceSnapshot = snapshots.find((s) => s.sections.length > 0) || snapshots[0];
  const metrics = useMemo(() => getAllMetrics(referenceSnapshot), [referenceSnapshot]);

  if (!referenceSnapshot || metrics.length === 0) {
    return (
      <div className="glass-panel rounded-2xl p-6 border border-white/5 text-slate-500 text-sm text-center">
        Нет данных за выбранный период
      </div>
    );
  }

  return (
    <div className="glass-panel text-slate-200 rounded-2xl overflow-hidden border border-white/5 shadow-2xl">
      <div className="w-full overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-white/10">
              <th className="px-4 py-2.5 text-[10px] uppercase tracking-widest text-slate-500 font-semibold sticky left-0 bg-slate-900/95 backdrop-blur-sm z-20 min-w-[220px]">
                Метрика
              </th>
              {columnLabels.map((label, i) => (
                <th
                  key={i}
                  onClick={() => onSelectCol(i)}
                  className={`px-2 py-2 text-center min-w-[60px] cursor-pointer transition-colors ${
                    selectedCol === i
                      ? "bg-blue-500/20 border-b-2 border-blue-400"
                      : "hover:bg-white/[0.03]"
                  }`}
                >
                  <div className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">
                    {label}
                  </div>
                  <div className="text-[9px] text-slate-600">{columnSubLabels[i]}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="text-sm">
            {metrics.map((m) => {
              // Section header row
              if (m.metricKey.startsWith("__section_")) {
                return (
                  <tr key={m.metricKey} className="bg-slate-900/40 border-t-2 border-white/10">
                    <td
                      colSpan={columnLabels.length + 1}
                      className="px-4 py-2 sticky left-0 bg-slate-900/40 z-10"
                    >
                      <div className="flex items-center gap-2">
                        {getSectionIcon(m.sectionIcon)}
                        <span className="text-[10px] uppercase tracking-widest font-bold text-slate-400">
                          {m.sectionTitle}
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              }

              // Group header
              if (m.isGroupHeader) {
                return (
                  <tr key={`${m.sectionKey}-${m.metricKey}`} className="bg-slate-800/30">
                    <td
                      colSpan={columnLabels.length + 1}
                      className="px-4 py-1.5 text-[10px] uppercase tracking-widest text-slate-500 font-bold pl-8 sticky left-0 bg-slate-800/30 z-10"
                    >
                      {m.metricLabel}
                    </td>
                  </tr>
                );
              }

              // Data row
              return (
                <tr
                  key={`${m.sectionKey}-${m.metricKey}`}
                  className="hover:bg-white/[0.02] transition-colors border-b border-white/[0.03]"
                >
                  <td className="px-4 py-2 font-medium text-slate-300 text-[12px] sticky left-0 bg-slate-900/90 backdrop-blur-sm z-10 pl-8">
                    {m.metricLabel}
                  </td>
                  {snapshots.map((snap, colIdx) => {
                    const val = getMetricFact(snap, m.sectionKey, m.metricKey);
                    return (
                      <td
                        key={colIdx}
                        onClick={() => onSelectCol(colIdx)}
                        className={`px-2 py-2 text-right font-mono text-[12px] cursor-pointer transition-colors ${
                          selectedCol === colIdx ? "bg-blue-500/10" : ""
                        } ${getCellColor(val)}`}
                      >
                        {val ?? "—"}
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

// ====================== MANAGER METRICS TABLE ======================
// Rows = managers, Columns = metrics

function ManagerMetricsTable({
  snapshot,
  title,
}: {
  snapshot: DailySnapshot | undefined;
  title: string;
}) {
  const managers = useMemo(() => collectManagers(snapshot), [snapshot]);

  // Build flat metric columns from all sections (non-header only)
  const metricColumns = useMemo(() => {
    if (!snapshot) return [];
    const cols: Array<{
      sectionKey: string;
      sectionTitle: string;
      sectionIcon: string;
      metricKey: string;
      metricLabel: string;
    }> = [];
    for (const sec of snapshot.sections) {
      for (const m of sec.metrics) {
        if (!m.isGroupHeader) {
          cols.push({
            sectionKey: sec.key,
            sectionTitle: sec.title,
            sectionIcon: sec.icon,
            metricKey: m.key,
            metricLabel: m.label,
          });
        }
      }
    }
    return cols;
  }, [snapshot]);

  if (!snapshot || managers.length === 0) return null;

  // Compute totals and averages
  const totals = metricColumns.map((col) => {
    let sum = 0;
    let count = 0;
    for (const mgr of managers) {
      const val = getManagerMetricFact(snapshot, col.sectionKey, col.metricKey, mgr.id);
      if (val !== null) {
        const num = Number(val);
        if (!Number.isNaN(num)) {
          sum += num;
          count++;
        }
      }
    }
    return { sum, count, avg: count > 0 ? Math.round((sum / count) * 10) / 10 : 0 };
  });

  // Use summary fact from sections for totals (more accurate than summing per-manager)
  const summaryTotals = metricColumns.map((col) => {
    const section = snapshot.sections.find((s) => s.key === col.sectionKey);
    const metric = section?.metrics.find((m) => m.key === col.metricKey);
    return metric?.fact ?? null;
  });

  return (
    <div className="glass-panel text-slate-200 rounded-2xl overflow-hidden border border-white/5 shadow-2xl">
      <div className="px-4 py-3 border-b border-white/5 bg-slate-900/40">
        <span className="text-[11px] uppercase tracking-widest font-bold text-slate-400">
          {title}
        </span>
      </div>
      <div className="w-full overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-white/10">
              <th className="px-4 py-2.5 text-[10px] uppercase tracking-widest text-slate-500 font-semibold sticky left-0 bg-slate-900/95 backdrop-blur-sm z-20 min-w-[160px]">
                Менеджер
              </th>
              {metricColumns.map((col, i) => (
                <th
                  key={`${col.sectionKey}-${col.metricKey}-${i}`}
                  className="px-2 py-2 text-center min-w-[80px]"
                >
                  <div className="text-[9px] uppercase tracking-wider text-slate-500 font-bold leading-tight">
                    {col.metricLabel}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="text-sm">
            {/* Manager rows */}
            {managers.map((mgr) => (
              <tr
                key={mgr.id}
                className="hover:bg-white/[0.02] transition-colors border-b border-white/[0.03]"
              >
                <td className="px-4 py-2 font-medium text-slate-300 text-[12px] sticky left-0 bg-slate-900/90 backdrop-blur-sm z-10">
                  {mgr.name}
                  {!mgr.kommoUserId && (
                    <span className="ml-1 text-[9px] text-amber-500">! Kommo</span>
                  )}
                </td>
                {metricColumns.map((col, i) => {
                  const val = getManagerMetricFact(snapshot, col.sectionKey, col.metricKey, mgr.id);
                  return (
                    <td
                      key={`${col.sectionKey}-${col.metricKey}-${i}`}
                      className={`px-2 py-2 text-right font-mono text-[12px] ${getCellColor(val)}`}
                    >
                      {val ?? "—"}
                    </td>
                  );
                })}
              </tr>
            ))}

            {/* Итого row */}
            <tr className="border-t-2 border-white/10 bg-blue-500/[0.05]">
              <td className="px-4 py-2 font-bold text-white text-[12px] sticky left-0 bg-slate-900/90 backdrop-blur-sm z-10">
                Итого команда:
              </td>
              {summaryTotals.map((val, i) => (
                <td
                  key={i}
                  className="px-2 py-2 text-right font-mono text-[12px] font-bold text-white"
                >
                  {val ?? "—"}
                </td>
              ))}
            </tr>

            {/* Среднее row */}
            <tr className="bg-slate-800/30">
              <td className="px-4 py-2 text-slate-400 text-[12px] sticky left-0 bg-slate-900/90 backdrop-blur-sm z-10">
                Среднее:
              </td>
              {totals.map((t, i) => (
                <td
                  key={i}
                  className="px-2 py-2 text-right font-mono text-[12px] text-slate-400"
                >
                  {t.count > 0 ? t.avg : "—"}
                </td>
              ))}
            </tr>
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
        <span className="text-slate-500 text-xs">{expanded ? "▲" : "▼"}</span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3">
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
                    {selected.has(mgr.id) ? <UserCheck className="w-3 h-3" /> : <UserX className="w-3 h-3" />}
                    {mgr.name}
                  </button>
                ))}
              </div>
            </div>
          )}

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
                    {selected.has(mgr.id) ? <UserCheck className="w-3 h-3" /> : <UserX className="w-3 h-3" />}
                    {mgr.name}
                  </button>
                ))}
              </div>
            </div>
          )}

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
            {dirty && <span className="text-[10px] text-amber-400">Есть несохранённые изменения</span>}
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
  const [mode, setMode] = useState<"days" | "months">("days");
  const [selectedMonth, setSelectedMonth] = useState<Date>(new Date());
  const [data, setData] = useState<RangeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [selectedDayIdx, setSelectedDayIdx] = useState<number | null>(null);

  const fetchData = useCallback(
    async (signal?: AbortSignal) => {
      if (!data) setLoading(true);
      setError(null);
      try {
        let url: string;
        if (mode === "days") {
          const monthStr = `${selectedMonth.getFullYear()}-${String(selectedMonth.getMonth() + 1).padStart(2, "0")}`;
          url = `/api/daily/range?department=${department}&mode=days&month=${monthStr}`;
        } else {
          url = `/api/daily/range?department=${department}&mode=months&year=${selectedMonth.getFullYear()}`;
        }

        const res = await fetch(url, { signal });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`API error ${res.status}: ${text}`);
        }
        const json = await res.json();
        setData(json);

        // Auto-select today if in current month
        if (mode === "days" && json.days) {
          const today = new Date();
          if (
            today.getFullYear() === selectedMonth.getFullYear() &&
            today.getMonth() === selectedMonth.getMonth()
          ) {
            setSelectedDayIdx(today.getDate() - 1);
          } else {
            setSelectedDayIdx(null);
          }
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        if (e instanceof TypeError && e.message === "Failed to fetch") return;
        console.error("Daily range fetch error:", e);
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [department, mode, selectedMonth]
  );

  useEffect(() => {
    const ac = new AbortController();
    fetchData(ac.signal);
    return () => ac.abort();
  }, [fetchData]);

  // Navigation
  const shiftMonth = (dir: -1 | 1) => {
    const d = new Date(selectedMonth);
    if (mode === "days") {
      d.setMonth(d.getMonth() + dir);
    } else {
      d.setFullYear(d.getFullYear() + dir);
    }
    setSelectedMonth(d);
    setSelectedDayIdx(null);
  };

  // Save active managers
  const handleSaveActiveManagers = async (selectedIds: Set<string>) => {
    // Find the schedule from the selected day's snapshot
    const snapshot = data?.days?.[selectedDayIdx ?? 0];
    if (!snapshot?.schedule) return;
    setSaving(true);
    try {
      const managers = snapshot.schedule.allManagers
        .filter((m) => selectedIds.has(m.id))
        .map((m) => ({ managerId: m.id, managerName: m.name, line: m.line }));

      const res = await fetch("/api/daily/active-managers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: snapshot.date,
          department,
          managers,
        }),
      });
      if (!res.ok) console.error("Active managers save error:", await res.text());

      const entries = snapshot.schedule.allManagers.map((m) => ({
        userId: m.id,
        isOnLine: selectedIds.has(m.id),
      }));
      await fetch("/api/daily/schedule", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: snapshot.date, entries }),
      });

      await fetchData();
    } catch (e) {
      console.error("Active managers save error:", e);
    } finally {
      setSaving(false);
    }
  };

  // Build column labels and snapshots for the summary table
  const { columnLabels, columnSubLabels, snapshots } = useMemo(() => {
    if (!data) return { columnLabels: [], columnSubLabels: [], snapshots: [] };

    if (mode === "days" && data.days) {
      return {
        columnLabels: data.days.map((d) => formatDayLabel(d.date)),
        columnSubLabels: data.days.map((d) => formatDaySubLabel(d.date)),
        snapshots: data.days,
      };
    }

    if (mode === "months" && data.months) {
      return {
        columnLabels: MONTH_NAMES_SHORT,
        columnSubLabels: data.months.map((m) => m.periodDate || ""),
        snapshots: data.months,
      };
    }

    return { columnLabels: [], columnSubLabels: [], snapshots: [] };
  }, [data, mode]);

  // Selected day snapshot for per-manager table
  const selectedDaySnapshot = mode === "days" && data?.days && selectedDayIdx !== null
    ? data.days[selectedDayIdx]
    : undefined;

  // Monthly summary for per-manager table
  const monthlySnapshot = data?.monthlySummary;

  // Schedule from today's snapshot (for active managers panel)
  const todaySchedule = useMemo(() => {
    if (mode !== "days" || !data?.days) return undefined;
    const today = new Date();
    const todayIdx = data.days.findIndex((d) => {
      const dd = new Date(d.date);
      return dd.getDate() === today.getDate() && dd.getMonth() === today.getMonth() && dd.getFullYear() === today.getFullYear();
    });
    return todayIdx >= 0 ? data.days[todayIdx] : undefined;
  }, [data, mode]);

  const dateDisplay = mode === "days"
    ? `${MONTH_NAMES[selectedMonth.getMonth()]} ${selectedMonth.getFullYear()}`
    : `${selectedMonth.getFullYear()} год`;

  return (
    <div className="flex flex-col gap-6 fade-in flex-1 overflow-y-auto pb-6 scrollbar-hide">
      {/* Controls */}
      <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
        <div className="flex items-center gap-2 flex-wrap">
          {/* Mode toggle */}
          <div className="flex bg-slate-800/50 p-1.5 rounded-xl border border-white/5 shadow-inner">
            {([
              { id: "days" as const, label: "Месяц (по дням)" },
              { id: "months" as const, label: "Год (по месяцам)" },
            ]).map((f) => (
              <button
                key={f.id}
                onClick={() => { setMode(f.id); setSelectedDayIdx(null); }}
                className={`px-4 py-2 rounded-lg text-[11px] uppercase tracking-widest font-bold transition-all duration-300 flex-shrink-0 ${
                  mode === f.id
                    ? "bg-blue-500/20 text-blue-400 border border-blue-500/30 shadow-md"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* Date navigator */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => shiftMonth(-1)}
            className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-sm text-slate-300 font-medium min-w-[180px] text-center">
            {dateDisplay}
          </span>
          <button
            onClick={() => shiftMonth(1)}
            className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition-colors"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          <button
            onClick={() => { setSelectedMonth(new Date()); setSelectedDayIdx(null); }}
            className="text-[10px] uppercase tracking-wider px-3 py-1.5 rounded-lg text-blue-400 hover:text-white bg-blue-500/10 hover:bg-blue-500/20 transition-colors border border-blue-500/20"
          >
            Сейчас
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
      {loading && !data && <DinoLoader />}

      {/* Background refresh */}
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
          <button onClick={() => fetchData()} className="mt-3 text-xs text-red-300 underline hover:text-white">
            Попробовать снова
          </button>
        </div>
      )}

      {/* Active Managers Panel (show when viewing days, for today) */}
      {todaySchedule?.schedule && (
        <ActiveManagersPanel
          schedule={todaySchedule.schedule}
          dateStr={todaySchedule.date}
          onSave={handleSaveActiveManagers}
          saving={saving}
        />
      )}

      {/* Summary Time Table */}
      {data && !loading && snapshots.length > 0 && (
        <>
          <div className="text-[11px] uppercase tracking-widest font-bold text-slate-500">
            Сводная таблица
            {selectedDayIdx !== null && mode === "days" && data.days && (
              <span className="ml-2 text-blue-400">
                — выбран {formatDaySubLabel(data.days[selectedDayIdx].date)}
              </span>
            )}
          </div>
          <SummaryTimeTable
            snapshots={snapshots}
            columnLabels={columnLabels}
            columnSubLabels={columnSubLabels}
            selectedCol={selectedDayIdx}
            onSelectCol={setSelectedDayIdx}
          />
        </>
      )}

      {/* Per-manager: Monthly summary */}
      {data && !loading && monthlySnapshot && mode === "days" && (
        <ManagerMetricsTable
          snapshot={monthlySnapshot}
          title={`Месячный показатель — ${MONTH_NAMES[selectedMonth.getMonth()]} ${selectedMonth.getFullYear()}`}
        />
      )}

      {/* Per-manager: Selected day */}
      {data && !loading && selectedDaySnapshot && mode === "days" && (
        <ManagerMetricsTable
          snapshot={selectedDaySnapshot}
          title={`Дневной показатель — ${formatDaySubLabel(selectedDaySnapshot.date)}`}
        />
      )}

      {/* Per-manager for months mode: selected month */}
      {data && !loading && mode === "months" && selectedDayIdx !== null && data.months?.[selectedDayIdx] && (
        <ManagerMetricsTable
          snapshot={data.months[selectedDayIdx]}
          title={`${MONTH_NAMES[selectedDayIdx]} ${selectedMonth.getFullYear()}`}
        />
      )}
    </div>
  );
}
