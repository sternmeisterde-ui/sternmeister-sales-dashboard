"use client";

import { useState, useEffect, useCallback, useMemo, Fragment } from "react";
import {
  TrendingUp,
  Users,
  Activity,
  Loader2,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  CalendarDays,
  DollarSign,
  Heart,
  Phone,
  ClipboardCheck,
  Megaphone,
  Globe,
  Pencil,
  Calendar,
} from "lucide-react";
import DinoLoader from "@/components/DinoLoader";
import SchedulePopup from "@/components/SchedulePopup";
import CalendarPicker, { type DateRange } from "@/components/CalendarPicker";

// ====================== TYPES ======================

interface MetricRow {
  key: string;
  label: string;
  plan: string | null;
  fact: string | null;
  percent: number | null;
  isGroupHeader: boolean;
  isPlanRow?: boolean;
}

interface ManagerData {
  id: string;
  name: string;
  /** line may be absent on old snapshots loaded from daily_snapshots. */
  line?: string | null;
  kommoUserId: number | null;
  metrics: Array<{
    key: string;
    plan: string | null;
    fact: string | null;
    percent: number | null;
  }>;
}

const LINE_TITLES: Record<string, string> = {
  "1": "Первая линия — Квалификатор",
  "2": "Вторая линия — Бератер",
  "3": "Третья линия — Доведение",
};

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

interface RefusalRow {
  reason: string;
  count: number;
  percent: number;
}

interface DailySnapshot {
  date: string;
  period: string;
  periodType: string;
  periodDate: string;
  sections: Section[];
  schedule?: ScheduleInfo;
  refusals?: { firstLine: RefusalRow[]; berater: RefusalRow[] } | null;
}

interface RangeResponse {
  mode: "days" | "weeks" | "months";
  days?: DailySnapshot[];
  weeks?: DailySnapshot[];
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
    case "DollarSign":
      return <DollarSign className="w-4 h-4 text-green-400" />;
    case "Heart":
      return <Heart className="w-4 h-4 text-red-400" />;
    case "Phone":
      return <Phone className="w-4 h-4 text-sky-400" />;
    case "ClipboardCheck":
      return <ClipboardCheck className="w-4 h-4 text-amber-400" />;
    case "Megaphone":
      return <Megaphone className="w-4 h-4 text-orange-400" />;
    case "Globe":
      return <Globe className="w-4 h-4 text-indigo-400" />;
    case "RefreshCw":
      return <RefreshCw className="w-4 h-4 text-teal-400" />;
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

function getSectionAccent(dbLine: string): {
  rowBg: string;
  cellBg: string;
  border: string;
  text: string;
} {
  switch (dbLine) {
    case "1":
      return { rowBg: "bg-sky-900/30", cellBg: "bg-sky-900/30", border: "border-l-4 border-sky-500/60", text: "text-sky-200" };
    case "2":
      return { rowBg: "bg-violet-900/30", cellBg: "bg-violet-900/30", border: "border-l-4 border-violet-500/60", text: "text-violet-200" };
    case "3":
      return { rowBg: "bg-emerald-900/30", cellBg: "bg-emerald-900/30", border: "border-l-4 border-emerald-500/60", text: "text-emerald-200" };
    default:
      return { rowBg: "bg-blue-900/30", cellBg: "bg-blue-900/30", border: "border-l-4 border-blue-500/60", text: "text-blue-200" };
  }
}

function formatDayLabel(dateStr: string): string {
  const [, , dd] = dateStr.split("-");
  return `D${Number(dd)}`;
}

function formatDaySubLabel(dateStr: string): string {
  const [, mm, dd] = dateStr.split("-");
  return `${dd}.${mm}`;
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
interface FlatMetric {
  sectionKey: string;
  sectionTitle: string;
  sectionIcon: string;
  sectionDbLine: string;
  metricKey: string;
  metricLabel: string;
  isGroupHeader: boolean;
  isPlanRow: boolean;
}

function getAllMetrics(snapshot: DailySnapshot | undefined): FlatMetric[] {
  if (!snapshot) return [];
  const result: FlatMetric[] = [];
  for (const sec of snapshot.sections) {
    result.push({
      sectionKey: sec.key,
      sectionTitle: sec.title,
      sectionIcon: sec.icon,
      sectionDbLine: sec.dbLine,
      metricKey: `__section_${sec.key}`,
      metricLabel: sec.title,
      isGroupHeader: false,
      isPlanRow: false,
    });
    for (const m of sec.metrics) {
      result.push({
        sectionKey: sec.key,
        sectionTitle: sec.title,
        sectionIcon: sec.icon,
        sectionDbLine: sec.dbLine,
        metricKey: m.key,
        metricLabel: m.label,
        isGroupHeader: m.isGroupHeader,
        isPlanRow: m.isPlanRow ?? false,
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
  department,
  monthPeriodDate,
  onPlanSave,
}: {
  snapshots: DailySnapshot[];
  columnLabels: string[];
  columnSubLabels: string[];
  selectedCol: number | null;
  onSelectCol: (idx: number) => void;
  department: string;
  monthPeriodDate?: string;
  onPlanSave?: (dbLine: string, metricKey: string, value: string, periodType: string, periodDate: string) => Promise<void>;
}) {
  const referenceSnapshot = snapshots.find((s) => s.sections.length > 0) || snapshots[0];
  const metrics = useMemo(() => getAllMetrics(referenceSnapshot), [referenceSnapshot]);

  // Collapsible sections
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const toggleSection = useCallback((key: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Inline editing state: "sectionKey:metricKey" -> value
  const [editingCell, setEditingCell] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const startEdit = (m: FlatMetric, currentVal: string | null) => {
    setEditingCell(`${m.sectionKey}:${m.metricKey}`);
    setEditValue(currentVal ?? "");
  };

  const cancelEdit = () => {
    setEditingCell(null);
    setEditValue("");
  };

  const commitEdit = async (m: FlatMetric) => {
    if (!onPlanSave || !referenceSnapshot) return;
    const periodType = "month";
    // Use stable month periodDate (e.g. "2026-04"), not individual day snapshot date
    const periodDate = monthPeriodDate || referenceSnapshot.periodDate.slice(0, 7);
    await onPlanSave(m.sectionDbLine, m.metricKey, editValue, periodType, periodDate);
    setEditingCell(null);
    setEditValue("");
  };

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
          <thead className="sticky top-0 z-40" style={{ backgroundColor: "rgb(15, 23, 42)" }}>
            <tr className="border-b border-white/10">
              <th className="px-4 py-2.5 text-[10px] uppercase tracking-widest text-slate-500 font-semibold sticky left-0 z-50 min-w-[220px]" style={{ backgroundColor: "rgb(15, 23, 42)" }}>
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
              // ── Section header row (collapsible) ────────────────────────
              if (m.metricKey.startsWith("__section_")) {
                const isCollapsed = collapsedSections.has(m.sectionKey);
                const accent = getSectionAccent(m.sectionDbLine);
                return (
                  <tr
                    key={m.metricKey}
                    className={`light-panel-header cursor-pointer select-none border-t-2 border-white/10 ${accent.rowBg}`}
                    onClick={() => toggleSection(m.sectionKey)}
                  >
                    <td
                      colSpan={columnLabels.length + 1}
                      className={`px-4 py-2.5 sticky left-0 z-10 light-panel-header ${accent.cellBg} ${accent.border}`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          {getSectionIcon(m.sectionIcon)}
                          <span className={`text-[11px] uppercase tracking-widest font-bold ${accent.text}`}>
                            {m.sectionTitle}
                          </span>
                        </div>
                        {isCollapsed
                          ? <ChevronRight className={`w-3.5 h-3.5 ${accent.text} opacity-60`} />
                          : <ChevronDown className={`w-3.5 h-3.5 ${accent.text} opacity-60`} />
                        }
                      </div>
                    </td>
                  </tr>
                );
              }

              // ── Skip all rows for collapsed sections ──────────────────────
              if (collapsedSections.has(m.sectionKey)) return null;

              // ── Group sub-header ──────────────────────────────────────────
              if (m.isGroupHeader) {
                return (
                  <tr key={`${m.sectionKey}-${m.metricKey}`} className="daily-group-header bg-slate-800/30">
                    <td
                      colSpan={columnLabels.length + 1}
                      className="daily-group-header px-4 py-1.5 text-[10px] uppercase tracking-widest text-slate-500 font-bold pl-8 sticky left-0 bg-slate-800/30 z-10"
                    >
                      {m.metricLabel}
                    </td>
                  </tr>
                );
              }

              const isPlan = m.isPlanRow;
              const cellId = `${m.sectionKey}:${m.metricKey}`;
              const isEditing = editingCell === cellId;

              // Data row
              return (
                <tr
                  key={`${m.sectionKey}-${m.metricKey}`}
                  className={`hover:bg-white/[0.02] transition-colors border-b border-white/[0.03] ${
                    isPlan ? "bg-blue-500/[0.04]" : ""
                  }`}
                >
                  <td className={`px-4 py-2 font-medium text-[12px] sticky left-0 backdrop-blur-sm z-10 pl-8 ${
                    isPlan ? "text-blue-300 bg-slate-900/90" : "text-slate-300 bg-slate-900/90"
                  }`}>
                    <div className="flex items-center gap-1.5">
                      {isPlan && <Pencil className="w-3 h-3 text-blue-400/50 flex-shrink-0" />}
                      {m.metricLabel}
                    </div>
                  </td>
                  {isPlan && isEditing ? (
                    // Editing mode: single input spanning all columns
                    <td colSpan={columnLabels.length} className="px-2 py-1">
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitEdit(m);
                            if (e.key === "Escape") cancelEdit();
                          }}
                          autoFocus
                          className="w-32 px-2 py-1 rounded bg-slate-800 border border-blue-500/40 text-white text-[12px] font-mono focus:outline-none focus:border-blue-400"
                        />
                        <button
                          onClick={() => commitEdit(m)}
                          className="text-[10px] px-2 py-1 rounded bg-blue-500/20 text-blue-300 hover:bg-blue-500/30"
                        >
                          OK
                        </button>
                        <button
                          onClick={cancelEdit}
                          className="text-[10px] px-2 py-1 rounded bg-slate-700/50 text-slate-400 hover:text-white"
                        >
                          Отмена
                        </button>
                      </div>
                    </td>
                  ) : (
                    // Normal display
                    snapshots.map((snap, colIdx) => {
                      const val = getMetricFact(snap, m.sectionKey, m.metricKey);
                      return (
                        <td
                          key={colIdx}
                          onClick={() => isPlan && onPlanSave ? startEdit(m, val) : onSelectCol(colIdx)}
                          className={`px-2 py-2 text-right font-mono text-[12px] cursor-pointer transition-colors ${
                            selectedCol === colIdx ? "bg-blue-500/10" : ""
                          } ${isPlan ? "text-blue-300 hover:bg-blue-500/10" : getCellColor(val)}`}
                        >
                          {val ?? "—"}
                        </td>
                      );
                    })
                  )}
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
  department,
  defaultCollapsed = false,
}: {
  snapshot: DailySnapshot | undefined;
  title: string;
  department: "b2g" | "b2b";
  defaultCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const managers = useMemo(() => collectManagers(snapshot), [snapshot]);

  // Group by line for B2G; B2B stays flat (no line concept)
  const groupedManagers = useMemo(() => {
    if (department !== "b2g") return [{ line: null as string | null, managers }];
    const order = ["1", "2", "3"];
    const groups: Array<{ line: string | null; managers: ManagerData[] }> = [];
    for (const line of order) {
      const bucket = managers.filter((m) => m.line === line);
      if (bucket.length > 0) groups.push({ line, managers: bucket });
    }
    const orphans = managers.filter((m) => !m.line || !order.includes(m.line));
    if (orphans.length > 0) groups.push({ line: null, managers: orphans });
    return groups;
  }, [managers, department]);

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
      <div
        className="px-4 py-3 border-b border-white/5 bg-slate-900/40 cursor-pointer hover:bg-slate-800/50 transition-colors flex items-center justify-between"
        onClick={() => setCollapsed((v) => !v)}
      >
        <span className="text-[11px] uppercase tracking-widest font-bold text-slate-400">
          {title}
        </span>
        {collapsed
          ? <ChevronRight className="w-3.5 h-3.5 text-slate-500" />
          : <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
        }
      </div>
      {!collapsed && <div className="w-full overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead className="sticky top-0 z-40" style={{ backgroundColor: "rgb(15, 23, 42)" }}>
            <tr className="border-b border-white/10">
              <th className="px-4 py-2.5 text-[10px] uppercase tracking-widest text-slate-500 font-semibold sticky left-0 z-50 min-w-[160px]" style={{ backgroundColor: "rgb(15, 23, 42)" }}>
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
            {/* Manager rows grouped by line (B2G) or flat (B2B) */}
            {groupedManagers.map((group) => (
              <Fragment key={group.line ?? "_flat"}>
                {group.line !== null && (
                  <tr className="light-panel-header border-t-2 border-white/10">
                    <td
                      colSpan={metricColumns.length + 1}
                      className={`px-4 py-2 sticky left-0 z-10 text-[11px] uppercase tracking-widest font-bold ${getSectionAccent(group.line).cellBg} ${getSectionAccent(group.line).border} ${getSectionAccent(group.line).text}`}
                    >
                      {LINE_TITLES[group.line] ?? `Линия ${group.line}`}
                      <span className="ml-2 text-slate-400 normal-case font-medium tracking-normal">
                        · {group.managers.length} менеджер{group.managers.length === 1 ? "" : group.managers.length < 5 ? "а" : "ов"}
                      </span>
                    </td>
                  </tr>
                )}
                {group.managers.map((mgr) => (
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
              </Fragment>
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
      </div>}
    </div>
  );
}

// ActiveManagersPanel removed — replaced by SchedulePopup

// ====================== MAIN COMPONENT ======================

export default function DailyTab({ department }: { department: "b2g" | "b2b" }) {
  const [mode, setMode] = useState<"days" | "weeks" | "months">("days");
  const [selectedMonth, setSelectedMonth] = useState<Date>(new Date());
  const [data, setData] = useState<RangeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [selectedDayIdx, setSelectedDayIdx] = useState<number | null>(null);
  const [scheduleManagers, setScheduleManagers] = useState<Array<{ id: string; name: string; line: string | null; shiftStartTime: string | null; shiftEndTime: string | null }>>([]);
  // Preload months-of-year for Managers tab dropdown (so user can pick any month
  // of the year in parallel with days-of-month).
  const [monthsOfYear, setMonthsOfYear] = useState<RangeResponse | null>(null);
  // Sub-tabs внутри Daily для обоих отделов:
  //   B2B: [Показатели] [Продления] [Менеджеры]
  //   B2G: [Показатели] [Менеджеры] [Отказы]
  // Per-manager таблицы и refusal cards вынесены в отдельные табы чтобы
  // Показатели страница не была перегружена.
  const [subTab, setSubTab] = useState<"metrics" | "renewals" | "managers" | "refusals">("metrics");

  useEffect(() => {
    let abort = false;
    (async () => {
      try {
        const res = await fetch(`/api/daily/managers?department=${department}`);
        const json = await res.json();
        if (!abort && Array.isArray(json.managers)) setScheduleManagers(json.managers);
      } catch (e) {
        console.error("Failed to load schedule managers:", e);
      }
    })();
    return () => { abort = true; };
  }, [department]);

  // Parallel fetch: months-of-year for Managers tab "По датам" dropdown.
  // Runs when department or year changes — independent of mode.
  useEffect(() => {
    let abort = false;
    (async () => {
      try {
        const res = await fetch(`/api/daily/range?department=${department}&mode=months&year=${selectedMonth.getFullYear()}`);
        const json = await res.json();
        if (!abort) setMonthsOfYear(json);
      } catch (e) {
        console.error("Failed to load months-of-year:", e);
      }
    })();
    return () => { abort = true; };
  }, [department, selectedMonth]);

  const fetchData = useCallback(
    async (signal?: AbortSignal) => {
      if (!data) setLoading(true);
      setError(null);
      try {
        let url: string;
        const monthStr = `${selectedMonth.getFullYear()}-${String(selectedMonth.getMonth() + 1).padStart(2, "0")}`;
        if (mode === "days") {
          url = `/api/daily/range?department=${department}&mode=days&month=${monthStr}`;
        } else if (mode === "weeks") {
          // Weeks-of-selected-month (4–5 Mon-Sun weeks that touch the month)
          url = `/api/daily/range?department=${department}&mode=weeks&month=${monthStr}`;
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
    if (mode === "days" || mode === "weeks") {
      d.setMonth(d.getMonth() + dir);
    } else {
      d.setFullYear(d.getFullYear() + dir);
    }
    setSelectedMonth(d);
    setSelectedDayIdx(null);
  };

  // handleSaveActiveManagers removed — schedule popup handles saves directly

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

    if (mode === "weeks" && data.weeks) {
      return {
        columnLabels: data.weeks.map((w, i) => `W${i + 1}`),
        columnSubLabels: data.weeks.map((w) => w.periodDate || ""),
        snapshots: data.weeks,
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
              { id: "weeks" as const, label: "Недели" },
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
            onClick={() => setShowSchedule(true)}
            className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider px-3 py-1.5 rounded-lg text-purple-400 hover:text-white bg-purple-500/10 hover:bg-purple-500/20 transition-colors border border-purple-500/20"
          >
            <Calendar className="w-3.5 h-3.5" />
            Расписание
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

      {/* Active Managers Panel removed — replaced by SchedulePopup */}

      {/* Sub-tabs: [Показатели] + per-department extras */}
      <div className="flex gap-1 p-1 rounded-xl bg-slate-800/40 border border-white/5 w-fit">
        {(
          department === "b2b"
            ? ([
                { id: "metrics" as const, label: "Показатели" },
                { id: "renewals" as const, label: "Продления" },
                { id: "managers" as const, label: "Менеджеры" },
              ])
            : ([
                { id: "metrics" as const, label: "Показатели" },
                { id: "managers" as const, label: "Менеджеры" },
                { id: "refusals" as const, label: "Тематики отказов" },
              ])
        ).map((t) => (
          <button
            key={t.id}
            onClick={() => setSubTab(t.id)}
            className={`px-4 py-2 rounded-lg text-[11px] uppercase tracking-widest font-bold transition-all ${
              subTab === t.id
                ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                : "text-slate-400 hover:text-white border border-transparent"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ===== SUB-TAB: Менеджеры — transposed compare view ===== */}
      {subTab === "managers" && data && !loading && (
        <ManagersCompareView
          department={department}
          snapshot={selectedDaySnapshot ?? monthlySnapshot}
          comparisonDates={
            mode === "days" && data.days
              ? data.days.map((s) => ({ label: formatDayLabel(s.date), snapshot: s }))
              : mode === "weeks" && data.weeks
                ? data.weeks.map((s, i) => ({ label: `W${i + 1}`, snapshot: s }))
                : mode === "months" && data.months
                  ? data.months.map((s, i) => ({ label: MONTH_NAMES_SHORT[i], snapshot: s }))
                  : undefined
          }
          monthlyComparisons={
            monthsOfYear?.months
              ? monthsOfYear.months.map((s, i) => ({ label: MONTH_NAMES_SHORT[i], snapshot: s }))
              : undefined
          }
        />
      )}

      {/* ===== SUB-TAB: Тематики отказов (B2G) ===== */}
      {department === "b2g" && subTab === "refusals" && data && !loading && (monthlySnapshot?.refusals || selectedDaySnapshot?.refusals) && (
        <RefusalReasonsCards
          monthly={monthlySnapshot?.refusals}
          daily={selectedDaySnapshot?.refusals}
          daySubLabel={selectedDaySnapshot ? formatDaySubLabel(selectedDaySnapshot.date) : ""}
          monthLabel={`${MONTH_NAMES[selectedMonth.getMonth()]} ${selectedMonth.getFullYear()}`}
        />
      )}

      {/* ===== SUB-TAB: Продления (B2B only) ===== */}
      {department === "b2b" && subTab === "renewals" && (
        <div className="glass-panel rounded-2xl p-8 border border-white/5 text-center">
          <div className="text-slate-400 text-sm uppercase tracking-widest font-bold mb-2">Продления</div>
          <div className="text-slate-500 text-xs">
            Раздел в разработке. Будет загружать потоки продлений из ТЗ R77-R118 (Выручка 29.04, 27.05, …, 7.04.26).
          </div>
        </div>
      )}

      {/* SUB-TAB "Менеджеры" (B2B) рендерится выше в общем блоке subTab === "managers". */}

      {/* ===== SUB-TAB: Показатели — отображается для B2G всегда, для B2B когда subTab=metrics ===== */}
      {(department === "b2g" || subTab === "metrics") && (
        <>

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
            department={department}
            monthPeriodDate={`${selectedMonth.getFullYear()}-${String(selectedMonth.getMonth() + 1).padStart(2, "0")}`}
            onPlanSave={async (dbLine, metricKey, value, periodType, periodDate) => {
              setSaving(true);
              try {
                const res = await fetch("/api/daily/plans", {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    department,
                    line: dbLine,
                    userId: null,
                    metricKey,
                    planValue: value,
                    periodType,
                    periodDate,
                  }),
                });
                if (!res.ok) console.error("Plan save error:", await res.text());
                await fetchData();
              } catch (e) {
                console.error("Plan save error:", e);
              } finally {
                setSaving(false);
              }
            }}
          />
        </>
      )}

      {/* B2G per-manager tables and refusal cards are now in separate sub-tabs
          (Менеджеры / Тематики отказов). Nothing renders here — moved above. */}

        </>
      )}

      {/* Schedule popup */}
      <SchedulePopup
        isOpen={showSchedule}
        onClose={() => setShowSchedule(false)}
        month={selectedMonth}
        department={department}
        managers={scheduleManagers}
        onSaved={() => { setShowSchedule(false); fetchData(); }}
      />
    </div>
  );
}

// ======================== Refusal reasons cards ==========================

interface RefusalCardsProps {
  monthly?: { firstLine: RefusalRow[]; berater: RefusalRow[] } | null;
  daily?: { firstLine: RefusalRow[]; berater: RefusalRow[] } | null;
  daySubLabel: string;
  monthLabel: string;
}

function RefusalReasonsCards({ monthly, daily, daySubLabel, monthLabel }: RefusalCardsProps) {
  const data = monthly ?? daily;
  if (!data) return null;
  const label = monthly ? monthLabel : daySubLabel;
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <RefusalCard title={`Тематики отказов — Квалификатор (${label})`} rows={data.firstLine} />
      <RefusalCard title={`Тематики отказов — Бератер (${label})`} rows={data.berater} />
    </div>
  );
}

function RefusalCard({ title, rows }: { title: string; rows: RefusalRow[] }) {
  const total = rows.reduce((s, r) => s + r.count, 0);
  return (
    <div className="glass-panel rounded-2xl p-4 border border-white/5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-widest">{title}</h3>
        <span className="text-[11px] text-slate-500">Итог: <span className="text-white font-bold">{total}</span></span>
      </div>
      {rows.length === 0 ? (
        <div className="text-[11px] text-slate-500 py-4 text-center">Нет отказов за период</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-500 text-[10px] uppercase tracking-wider border-b border-white/5">
                <th className="text-left py-2 px-2 font-medium">Причина</th>
                <th className="text-right py-2 px-2 font-medium">Кол-во</th>
                <th className="text-right py-2 px-2 font-medium">%</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.reason} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                  <td className="py-2 px-2 text-slate-200">{r.reason}</td>
                  <td className="py-2 px-2 text-right text-white font-semibold">{r.count}</td>
                  <td className="py-2 px-2 text-right text-slate-400 tabular-nums">{r.percent}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ======================== Managers Compare View ==========================
// Transposed layout: rows = metrics, columns = managers (or dates in compare mode).
// Supports multi-select manager filter and dual modes:
//   "managers" — multiple managers side-by-side for ONE date.
//   "dates"    — ONE manager side-by-side for MULTIPLE dates/periods.

interface CompareDate {
  /** YYYY-MM-DD label, e.g. "24.04" */
  label: string;
  snapshot: DailySnapshot;
}

interface ManagersCompareViewProps {
  /** Current-period snapshot (used in "managers" mode to source per-manager facts). */
  snapshot: DailySnapshot | undefined;
  /** Snapshots for "dates" mode — day-granularity (for the current month). */
  comparisonDates?: CompareDate[];
  /** Snapshots for "dates" mode — month-granularity (for the current year). */
  monthlyComparisons?: CompareDate[];
  department: "b2g" | "b2b";
  /** initial mode */
  defaultMode?: "managers" | "dates";
}

function ManagersCompareView({ snapshot, comparisonDates, monthlyComparisons, department, defaultMode = "managers" }: ManagersCompareViewProps) {
  // Combined list of available date options for the "dates" mode dropdown:
  // daily entries first, then monthly entries with an "M:" prefix to distinguish.
  const allDateOptions: CompareDate[] = useMemo(() => {
    const out: CompareDate[] = [];
    for (const d of comparisonDates ?? []) out.push(d);
    for (const m of monthlyComparisons ?? []) out.push({ label: `M:${m.label}`, snapshot: m.snapshot });
    return out;
  }, [comparisonDates, monthlyComparisons]);
  void department;
  const [mode, setMode] = useState<"managers" | "dates">(defaultMode);
  const allManagers = useMemo(() => collectManagers(snapshot), [snapshot]);
  // "null" = not yet initialised → auto-select-all on first render; once user
  // toggles any box we store an explicit Set (possibly empty).
  const [selectedManagerIds, setSelectedManagerIds] = useState<Set<string> | null>(null);
  const [selectedSingleMgr, setSelectedSingleMgr] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  // Which date columns to show in "dates" mode (default = all).
  const [selectedDateLabels, setSelectedDateLabels] = useState<Set<string> | null>(null);
  // Date-range filter (замена списка чекбоксов). CalendarPicker выдаёт start/end.
  const [dateRange, setDateRange] = useState<DateRange>({ start: null, end: null });

  const effectiveSelected = selectedManagerIds ?? new Set(allManagers.map((m) => m.id));
  const effectiveSingle = selectedSingleMgr ?? (allManagers[0]?.id ?? null);
  // Filter allDateOptions by calendar range (if set) AND/OR by manual selection.
  // If both are set, prefer explicit selection. If neither is set, show all.
  const rangeFilteredLabels = useMemo(() => {
    if (!dateRange.start) return null;
    const end = dateRange.end ?? dateRange.start;
    const s = dateRange.start.getTime();
    const e = new Date(end.getTime() + 86_399_000).getTime(); // end-of-day
    const ok = new Set<string>();
    for (const opt of allDateOptions) {
      const snapTs = new Date(opt.snapshot.date).getTime();
      if (Number.isFinite(snapTs) && snapTs >= s && snapTs <= e) ok.add(opt.label);
    }
    return ok;
  }, [dateRange, allDateOptions]);

  const effectiveDateLabels =
    selectedDateLabels ?? rangeFilteredLabels ?? new Set(allDateOptions.map((d) => d.label));

  const visibleManagers = useMemo(() => {
    if (mode === "dates" && effectiveSingle) {
      const m = allManagers.find((x) => x.id === effectiveSingle);
      return m ? [m] : [];
    }
    return allManagers.filter((m) => effectiveSelected.has(m.id));
  }, [allManagers, effectiveSelected, effectiveSingle, mode]);

  // Metrics only from sections marked perManager=true. Skip group headers + skip
  // plan-rows (hasPlan && !hasFact) since they apply to the department, not a
  // single manager. Funnel section is dept-wide, excluded from per-manager view.
  const metrics = useMemo(() => {
    if (!snapshot) return [];
    const rows: Array<{ sectionKey: string; sectionTitle: string; metricKey: string; metricLabel: string; isPlanRow: boolean }> = [];
    for (const sec of snapshot.sections) {
      if (!sec.perManager) continue;
      for (const m of sec.metrics) {
        if (m.isGroupHeader) continue;
        rows.push({
          sectionKey: sec.key,
          sectionTitle: sec.title,
          metricKey: m.key,
          metricLabel: m.label,
          isPlanRow: m.isPlanRow ?? false,
        });
      }
    }
    return rows;
  }, [snapshot]);

  if (!snapshot || allManagers.length === 0) {
    return (
      <div className="glass-panel rounded-2xl p-6 border border-white/5 text-slate-500 text-sm text-center">
        Нет данных для отображения менеджеров
      </div>
    );
  }

  // Column definitions depending on mode
  const columns: Array<{ key: string; label: string; sub: string; getValue: (m: FlatMetric) => string | null }>
    = mode === "managers"
      ? visibleManagers.map((mgr) => ({
          key: mgr.id,
          label: mgr.name,
          sub: mgr.line ? `Линия ${mgr.line}` : "",
          getValue: (m) => getManagerMetricFact(snapshot, m.sectionKey, m.metricKey, mgr.id),
        }))
      : allDateOptions
          .filter((d) => effectiveDateLabels.has(d.label))
          .map((d) => ({
            key: d.label,
            label: d.label,
            sub: d.snapshot.date,
            getValue: (m) => effectiveSingle ? getManagerMetricFact(d.snapshot, m.sectionKey, m.metricKey, effectiveSingle) : null,
          }));

  type FlatMetric = typeof metrics[number];

  return (
    <div className="flex flex-col gap-3">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Mode toggle */}
        <div className="flex bg-slate-800/40 p-1 rounded-lg border border-white/5">
          {(["managers", "dates"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              disabled={m === "dates" && allDateOptions.length === 0}
              className={`px-3 py-1.5 rounded-md text-[10px] uppercase tracking-widest font-bold transition-all ${
                mode === m
                  ? "bg-emerald-500/20 text-emerald-400"
                  : "text-slate-400 hover:text-white disabled:opacity-30 disabled:hover:text-slate-400"
              }`}
            >
              {m === "managers" ? "По менеджерам" : "По датам"}
            </button>
          ))}
        </div>

        {/* Manager multi-select (mode = managers) or single-select (mode = dates) */}
        {mode === "managers" ? (
          <div className="relative">
            <button
              onClick={() => setDropdownOpen(!dropdownOpen)}
              className="px-3 py-1.5 rounded-lg text-[11px] uppercase tracking-widest font-bold text-slate-300 bg-slate-800/40 border border-white/5 hover:bg-slate-800/70"
            >
              Менеджеры ({effectiveSelected.size}/{allManagers.length}) ▾
            </button>
            {dropdownOpen && (
              <div className="absolute z-30 mt-1 min-w-[260px] max-h-[400px] overflow-y-auto rounded-xl border border-white/10 shadow-2xl p-2 bg-slate-900" style={{ backgroundColor: "rgb(15, 23, 42)" }}>
                <div className="flex gap-2 mb-2 border-b border-white/5 pb-2">
                  <button
                    onClick={() => setSelectedManagerIds(new Set(allManagers.map((m) => m.id)))}
                    className="text-[10px] text-emerald-400 hover:text-emerald-300"
                  >Выбрать всех</button>
                  <button
                    onClick={() => setSelectedManagerIds(new Set())}
                    className="text-[10px] text-slate-400 hover:text-white"
                  >Снять все</button>
                </div>
                {allManagers.map((mgr) => (
                  <label key={mgr.id} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-white/5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={effectiveSelected.has(mgr.id)}
                      onChange={() => {
                        const next = new Set(effectiveSelected);
                        if (next.has(mgr.id)) next.delete(mgr.id);
                        else next.add(mgr.id);
                        setSelectedManagerIds(next);
                      }}
                      className="accent-emerald-500"
                    />
                    <span className="text-xs text-slate-200">{mgr.name}</span>
                    {mgr.line && <span className="text-[9px] text-slate-500 ml-auto">L{mgr.line}</span>}
                  </label>
                ))}
              </div>
            )}
          </div>
        ) : (
          <>
            <select
              value={effectiveSingle ?? ""}
              onChange={(e) => setSelectedSingleMgr(e.target.value || null)}
              className="px-3 py-1.5 rounded-lg text-[11px] uppercase tracking-widest font-bold text-slate-300 bg-slate-800/40 border border-white/5"
            >
              {allManagers.map((mgr) => (
                <option key={mgr.id} value={mgr.id}>{mgr.name}</option>
              ))}
            </select>
            {/* Calendar-based date filter — year/month/day/range selection. */}
            <CalendarPicker
              mode="range"
              value={dateRange}
              onChange={(r) => { setDateRange(r); setSelectedDateLabels(null); }}
              onClear={() => { setDateRange({ start: null, end: null }); setSelectedDateLabels(null); }}
              allowModeToggle
            />
          </>
        )}

        <span className="text-[10px] text-slate-500">
          {mode === "managers" ? `${visibleManagers.length} в таблице` : `${effectiveDateLabels.size} дат`}
          {" • "}
          {metrics.length} метрик
        </span>
      </div>

      {/* Transposed table */}
      {columns.length === 0 ? (
        <div className="glass-panel rounded-2xl p-6 border border-white/5 text-slate-500 text-sm text-center">
          Выберите {mode === "managers" ? "менеджеров" : "даты"} для сравнения
        </div>
      ) : (
        <div className="glass-panel rounded-2xl overflow-hidden border border-white/5">
          <div className="w-full overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead className="sticky top-0 z-40" style={{ backgroundColor: "rgb(15, 23, 42)" }}>
                <tr className="border-b border-white/10">
                  <th className="px-4 py-2.5 text-[10px] uppercase tracking-widest text-slate-500 font-semibold sticky left-0 z-50 min-w-[260px]" style={{ backgroundColor: "rgb(15, 23, 42)" }}>
                    Метрика
                  </th>
                  {columns.map((c) => (
                    <th key={c.key} className="px-3 py-2 text-center min-w-[110px]">
                      <div className="text-[10px] uppercase tracking-wider text-slate-300 font-bold leading-tight">{c.label}</div>
                      {c.sub && <div className="text-[9px] text-slate-500 mt-0.5">{c.sub}</div>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="text-xs">
                {metrics.map((m, i) => {
                  const prev = i > 0 ? metrics[i - 1] : null;
                  const newSection = !prev || prev.sectionKey !== m.sectionKey;
                  return (
                    <Fragment key={`${m.sectionKey}-${m.metricKey}`}>
                      {newSection && (
                        <tr className="bg-slate-800/40 border-t-2 border-white/10">
                          <td colSpan={columns.length + 1} className="px-4 py-2 text-[10px] uppercase tracking-widest text-slate-400 font-bold sticky left-0 bg-slate-800/80 z-10">
                            {m.sectionTitle}
                          </td>
                        </tr>
                      )}
                      <tr className="border-b border-white/5 hover:bg-white/[0.02]">
                        <td className="px-4 py-2 text-[11px] text-slate-300 sticky left-0 bg-slate-900/90 z-10">
                          {m.metricLabel}
                        </td>
                        {columns.map((c) => {
                          const val = c.getValue(m);
                          return (
                            <td key={c.key} className={`px-3 py-2 text-center tabular-nums ${getCellColor(val)}`}>
                              {val ?? "—"}
                            </td>
                          );
                        })}
                      </tr>
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
