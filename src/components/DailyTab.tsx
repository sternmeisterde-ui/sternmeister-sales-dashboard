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

// Numbers with >3 digits get a space thousands-separator (500 000 instead
// of 500000). Small values (counts, percentages) stay as-is. Non-numeric
// strings are returned verbatim so labels like "—" or "N/A" are preserved.
function formatCellNumber(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "" || value === "—") return "—";
  const str = String(value);
  const num = Number(str);
  if (!Number.isFinite(num)) return str;
  if (Math.abs(num) <= 999) return str;
  const isFloat = !Number.isInteger(num);
  return num.toLocaleString("ru-RU", {
    maximumFractionDigits: isFloat ? 2 : 0,
    minimumFractionDigits: 0,
  });
}

// Unit split for HH:MM:SS formatting. Fact values come from analytics.sla
// already as raw seconds (see getSlaFactsCombined in build-response.ts) so we
// show them with second-level precision. Plan values are user-entered in
// minutes (admin types "25" → 25 мин SLA target), so they're multiplied by 60
// before formatting. Keeping the two in different units lets admins type a
// round number of minutes while the fact keeps seconds precision.
const DURATION_SEC_KEYS = new Set<string>([
  // Facts — raw seconds from the SQL roll-ups.
  "sla_f", "sla_shift_f", "tlt_f", "calls_sla_f",
  // Legacy seconds fields (Callgear/Cloudtalk ring time).
  "avgWait_f", "avgWait_p",
  "calls_avgWait_f", "calls_avgWait_p",
]);
const DURATION_MIN_KEYS = new Set<string>([
  // Plans — admin-entered minute-granular targets.
  "sla_p", "calls_sla_p",
]);

function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "—";
  const rounded = Math.round(totalSeconds);
  const h = Math.floor(rounded / 3600);
  const m = Math.floor((rounded % 3600) / 60);
  const s = rounded % 60;
  const pad = (x: number) => String(x).padStart(2, "0");
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

function formatCell(value: string | number | null | undefined, metricKey: string): string {
  if (value === null || value === undefined || value === "" || value === "—") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (DURATION_MIN_KEYS.has(metricKey)) return formatDuration(n * 60);
  if (DURATION_SEC_KEYS.has(metricKey)) return formatDuration(n);
  return formatCellNumber(value);
}

// Metrics where "lower is better" — SLA times, wait times, overdue counts.
// For these, over-performance = fact < plan, so the ratio is inverted.
const LOWER_IS_BETTER = new Set<string>([
  "calls_sla_f", "sla_f", "sla_shift_f", "tlt_f",
  "calls_avgWait_f", "avgWait_f",
  "overdueTasks",
]);

/**
 * Traffic-light color class for a fact cell based on % of plan.
 * User thresholds:
 *   green:  within 20 % of plan or over-achieved (ratio ≥ 0.80 higher-better
 *           / ratio ≤ 1.20 lower-better)
 *   yellow: 40–80 % of plan (or 1.2–2.5× for lower-better)
 *   red:    below 40 % (or above 2.5× for lower-better)
 * Returns empty string when no color should apply (missing plan/fact).
 */
function getTrafficLightClass(
  fact: string | null,
  plan: string | null,
  metricKey: string,
): string {
  if (!fact || fact === "—" || !plan || plan === "—") return "";
  const factNum = Number(fact);
  let planNum = Number(plan);
  if (!Number.isFinite(factNum) || !Number.isFinite(planNum) || planNum === 0) return "";
  // Unit normalisation: SLA/TLT facts now come from the backend as seconds
  // (DURATION_SEC_KEYS), while admin-entered plans are still in minutes
  // (DURATION_MIN_KEYS). Convert the plan up to seconds before taking the
  // ratio — otherwise 25 min plan vs 3180 s fact = 127× overage, forcing
  // every SLA cell permanently red.
  const planKey = planKeyFor(metricKey);
  if (DURATION_SEC_KEYS.has(metricKey) && DURATION_MIN_KEYS.has(planKey)) {
    planNum = planNum * 60;
  }
  const ratio = factNum / planNum;
  const lowerBetter = LOWER_IS_BETTER.has(metricKey);
  if (lowerBetter) {
    if (ratio <= 1.2) return "traffic-green";
    if (ratio <= 2.5) return "traffic-yellow";
    return "traffic-red";
  }
  if (ratio >= 0.8) return "traffic-green";
  if (ratio >= 0.4) return "traffic-yellow";
  return "traffic-red";
}

/** Derive the plan-metric key from a fact-metric key.
 *   buh_newRevenue_f → buh_newRevenue_p
 *   totalLeads       → totalLeads_p
 *   okk_f            → okk_p
 *   sla_shift_f / tlt_f → sla_p (same target threshold)
 */
const FACT_TO_PLAN_ALIAS: Record<string, string> = {
  sla_shift_f: "sla_p",
  tlt_f: "sla_p",
  calls_frozenLeads_f: "",
};

function planKeyFor(factKey: string): string {
  const aliased = FACT_TO_PLAN_ALIAS[factKey];
  if (aliased !== undefined) return aliased;
  if (factKey.endsWith("_f")) return `${factKey.slice(0, -2)}_p`;
  return `${factKey}_p`;
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
    // CANNOT use `glass-panel` here: its backdrop-filter creates a containing
    // block that anchors sticky thead/TH to the panel's own box (so they
    // scroll out of view with the panel). Also cannot use `overflow-hidden`
    // on any ancestor, it clips sticky content. Plain div with border/bg is
    // the only combination that lets thead stick to viewport on page scroll.
    <div className="text-slate-200 rounded-2xl border border-white/5 shadow-2xl bg-slate-900/40">
      <div className="w-full overflow-x-auto rounded-2xl">
        <table className="w-full text-left" style={{ borderCollapse: "separate", borderSpacing: 0 }}>
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
                    {/* First cell is sticky-left with the label; remaining N
                        cells carry the accent background so the row looks
                        continuous. sticky on a <td colSpan=N> never pins on
                        horizontal scroll — the cell already spans the whole
                        row and has nowhere to offset to. Splitting into a
                        single sticky cell + placeholder cells is the same
                        pattern as the first column of data rows, which has
                        worked reliably across browsers. */}
                    <td
                      className={`sticky left-0 z-10 px-4 py-2.5 light-panel-header ${accent.cellBg} ${accent.border} min-w-[220px]`}
                    >
                      <div className="flex items-center gap-2">
                        {getSectionIcon(m.sectionIcon)}
                        <span className={`text-[11px] uppercase tracking-widest font-bold ${accent.text}`}>
                          {m.sectionTitle}
                        </span>
                        {isCollapsed
                          ? <ChevronRight className={`w-3.5 h-3.5 ${accent.text} opacity-60`} />
                          : <ChevronDown className={`w-3.5 h-3.5 ${accent.text} opacity-60`} />
                        }
                      </div>
                    </td>
                    <td
                      colSpan={columnLabels.length}
                      className={`light-panel-header ${accent.cellBg} ${accent.border} p-0`}
                    />
                  </tr>
                );
              }

              // ── Skip all rows for collapsed sections ──────────────────────
              if (collapsedSections.has(m.sectionKey)) return null;

              // ── Group sub-header ──────────────────────────────────────────
              // Same sticky-split pattern as the section header above: first
              // <td> sticky-left with the label, second <td colSpan={N}> fills
              // the rest of the row with the group-header tint.
              if (m.isGroupHeader) {
                return (
                  <tr key={`${m.sectionKey}-${m.metricKey}`} className="daily-group-header bg-slate-800/30">
                    <td
                      className="daily-group-header sticky left-0 z-10 px-4 py-1.5 pl-8 text-[10px] uppercase tracking-widest text-slate-500 font-bold bg-slate-800/30 min-w-[220px]"
                    >
                      {m.metricLabel}
                    </td>
                    <td
                      colSpan={columnLabels.length}
                      className="daily-group-header bg-slate-800/30 p-0"
                    />
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
                      // Traffic-light: applies only to fact rows (not plan-only
                      // rows), when we can find a sibling plan value for the
                      // same metric in the same snapshot column. Visual cue
                      // is a 4px left-edge bar via the .traffic-{green|yellow|
                      // red} class — keeps numbers readable across 10+ cols.
                      const isFactRow = !isPlan && /факт/i.test(m.metricLabel);
                      const planKey = isFactRow ? planKeyFor(m.metricKey) : "";
                      const planVal = isFactRow && planKey
                        ? getMetricFact(snap, m.sectionKey, planKey)
                        : null;
                      const trafficCls = isFactRow ? getTrafficLightClass(val, planVal, m.metricKey) : "";
                      return (
                        <td
                          key={colIdx}
                          onClick={() => isPlan && onPlanSave ? startEdit(m, val) : onSelectCol(colIdx)}
                          className={`px-2 py-2 text-right font-mono text-[12px] cursor-pointer transition-colors ${
                            selectedCol === colIdx ? "bg-blue-500/10" : ""
                          } ${isPlan ? "text-blue-300 hover:bg-blue-500/10" : getCellColor(val)} ${trafficCls}`}
                        >
                          {formatCell(val, m.metricKey)}
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
    // NOT glass-panel / overflow-hidden — both break position: sticky on the
    // thead and first-column cells (backdrop-filter creates a containing
    // block, overflow-hidden clips sticky). Plain bg + border reproduces the
    // same visual and keeps sticky working. Matches the main Daily table.
    <div className="text-slate-200 rounded-2xl border border-white/5 shadow-2xl bg-slate-900/40">
      <div
        className="px-4 py-3 border-b border-white/5 bg-slate-900/40 cursor-pointer hover:bg-slate-800/50 transition-colors flex items-center justify-between rounded-t-2xl"
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
      {!collapsed && <div className="w-full overflow-x-auto rounded-b-2xl">
        <table className="w-full text-left" style={{ borderCollapse: "separate", borderSpacing: 0 }}>
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
                    {/* Split-td pattern: first cell sticky with the label,
                        second cell fills the rest of the row with the accent. */}
                    <td
                      className={`sticky left-0 z-10 px-4 py-2 text-[11px] uppercase tracking-widest font-bold min-w-[160px] ${getSectionAccent(group.line).cellBg} ${getSectionAccent(group.line).border} ${getSectionAccent(group.line).text}`}
                    >
                      {LINE_TITLES[group.line] ?? `Линия ${group.line}`}
                      <span className="ml-2 text-slate-400 normal-case font-medium tracking-normal">
                        · {group.managers.length} менеджер{group.managers.length === 1 ? "" : group.managers.length < 5 ? "а" : "ов"}
                      </span>
                    </td>
                    <td
                      colSpan={metricColumns.length}
                      className={`${getSectionAccent(group.line).cellBg} ${getSectionAccent(group.line).border} p-0`}
                    />
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
                          {formatCell(val, col.metricKey)}
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
                  {formatCell(val, metricColumns[i]?.metricKey ?? "")}
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
                  {t.count > 0 ? formatCellNumber(t.avg) : "—"}
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
  const [subTab, setSubTab] = useState<"metrics" | "managers" | "refusals" | "rating">("metrics");

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
              ])
            : ([
                { id: "metrics" as const, label: "Показатели" },
                { id: "managers" as const, label: "Менеджеры" },
                { id: "rating" as const, label: "Рейтинг" },
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

      {/* ===== SUB-TAB: Менеджеры ===== */}
      {/* B2B: one cross-department compare table (sales is team-wide).
          B2G: three SEPARATE tables per line — each line has its own
          managers, own metrics, own filter (manager multi-select + date
          range). Quicker drill-down and matches the 3-line org chart. */}
      {subTab === "managers" && data && !loading && department === "b2g" && (
        <div className="flex flex-col gap-6">
          {(["1", "2", "3"] as const).map((lineFilter) => (
            <div key={lineFilter} className="flex flex-col gap-2">
              <h3 className="text-[11px] uppercase tracking-widest text-slate-400 font-bold">
                {LINE_TITLES[lineFilter]}
              </h3>
              <ManagersCompareView
                department="b2g"
                lineFilter={lineFilter}
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
            </div>
          ))}
        </div>
      )}

      {/* ===== SUB-TAB: Тематики отказов (B2G) ===== */}
      {/* ===== SUB-TAB: Рейтинг первой линии (B2G only) ===== */}
      {department === "b2g" && subTab === "rating" && data && !loading && (
        <RatingFirstLineView
          monthlySnapshot={monthlySnapshot ?? selectedDaySnapshot}
          monthPeriodDate={`${selectedMonth.getFullYear()}-${String(selectedMonth.getMonth() + 1).padStart(2, "0")}`}
        />
      )}

      {department === "b2g" && subTab === "refusals" && data && !loading && (monthlySnapshot?.refusals || selectedDaySnapshot?.refusals) && (
        <RefusalReasonsCards
          monthly={monthlySnapshot?.refusals}
          daily={selectedDaySnapshot?.refusals}
          daySubLabel={selectedDaySnapshot ? formatDaySubLabel(selectedDaySnapshot.date) : ""}
          monthLabel={`${MONTH_NAMES[selectedMonth.getMonth()]} ${selectedMonth.getFullYear()}`}
        />
      )}

      {/* SUB-TAB "Менеджеры" (B2B) рендерится выше в общем блоке subTab === "managers". */}

      {/* ===== SUB-TAB: Показатели (for both depts when subTab==="metrics") ===== */}
      {subTab === "metrics" && (
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
  /** Restrict to a single B2G line ("1", "2", "3"). When set, both the
      manager column list and the metric row list are filtered to that
      line's section (funnel metrics stay on line-1). B2B ignores this. */
  lineFilter?: string;
}

function ManagersCompareView({ snapshot, comparisonDates, monthlyComparisons, department, defaultMode = "managers", lineFilter }: ManagersCompareViewProps) {
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
  // Restrict to a single B2G line if lineFilter is set (ROP drill-down).
  const allManagers = useMemo(() => {
    const raw = collectManagers(snapshot);
    if (!lineFilter) return raw;
    return raw.filter((m) => m.line === lineFilter);
  }, [snapshot, lineFilter]);
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

  // Per-manager view follows a sales-ops diagnosis framework (see agent recs):
  // the table is a variance-hunting tool — not a scorecard — so team-aggregate
  // metrics and plan-only rows are hidden. Order is ВОРОНКА → ЗВОНКИ → SLA →
  // КАЧЕСТВО so a ROP can read left-to-right and spot the weak link fast.
  const metrics = useMemo(() => {
    if (!snapshot) return [];

    // Keys that make no sense per-manager:
    //  • plan constants set by ROP team-wide (*_p, regulation, targets)
    //  • identity/count stubs that always equal 1 per row (staffCount,
    //    managersOnLine, _managersOnLine_f)
    //  • pipeline-stage snapshot counters (berater* / delayed* / appeal*)
    //    that reflect team case queues, not individual output
    //  • duplicate / derived metrics (avgDialogPerEmployee = avgDialogMinutes)
    //  • team-level B2B totals ("total_*") — салestotal section is team-only
    const DENYLIST = new Set<string>([
      "staffCount", "managersOnLine", "calls_managersOnLine_f",
      "avgDialogPerEmployee", "missedIncoming",
      // plan-coefficient rows (ROP sets dept-wide, not per individual)
      "regulationPercent", "callsTotal_p", "totalMinutes_p", "avgWait_p",
      "sla_p", "okk_p", "roleplay_p",
      "calls_sla_p", "calls_total_p", "calls_totalMinutes_p",
      "calls_avgWait_p", "calls_dialPercent_p", "calls_managersOnLine_p",
      "buh_ql2p_p", "med_ql2p_p", "okk_buh1_p", "okk_buh2_p", "okk_med1_p", "okk_avg_p",
      // pipeline-stage counters (team case queue, not individual KPI)
      "beraterReview", "beraterReject", "delayedStart", "appeal",
      "appealsSubmitted", "termAACancelled", "termDCCancelled",
      "awaitTermTotal", "awaitTermNew",
      // team-level derived / rollup rows
      "buh_planDoneTotal", "buh_planDoneNew", "med_planDoneTotal",
      "med_planDoneNew", "total_planDoneTotal", "total_planDoneNew",
      "total_revenueTotal_p", "total_revenueTotal_f", "total_newRevenue_p",
      "total_newRevenue_f", "total_komLeads_p", "total_komLeads_f",
      "total_sales_p", "total_sales_f", "total_prepayments",
      "total_ql2p_p", "total_ql2p_f", "total_avgCheck_p", "total_avgCheck_f",
    ]);

    // Order map: ВОРОНКА (volume/output) → ЗВОНКИ → СКОРОСТЬ (SLA) → КАЧЕСТВО.
    // Primary diagnosis columns per the agent's 5-metric framework bubble up
    // naturally by having low ranks.
    const ORDER: Record<string, number> = {
      // ── ВОРОНКА (volume + output) ──
      revenue: 10, buh_newRevenue_f: 10, med_newRevenue_f: 10,
      buh_salesPlusRenewals_f: 11, med_salesPlusRenewals_f: 11,
      gutscheinsApproved: 12,
      buh_sales_f: 13, med_sales_f: 13,
      buh_avgCheck_f: 14, med_avgCheck_f: 14,
      totalLeads: 15, buh_komLeads_f: 15, med_komLeads_f: 15,
      qualLeads: 16, buh_ql2p_f: 17, med_ql2p_f: 17, qualLeadsPercent: 17,
      a2: 18, b1: 19, b2plus: 20, avgPortfolio: 21,
      tasksTotal: 22, tasksNew: 23, convQualTask: 24,
      consultTotal: 25, consultNew: 26, convTaskConsult: 27,
      termsTotal: 28, termsNew: 29, convConsultTerm: 30,
      termDCDone: 31, termAATransferred: 32, termAACount: 33,
      buh_prepayments: 34, med_prepayments: 34,
      // ── ЗВОНКИ ──
      callsTotal: 40, calls_total_f: 40,
      callsConnected: 41,
      dialPercent: 42, calls_dialPercent_f: 42,
      totalMinutes: 43, calls_totalMinutes_f: 43,
      avgDialogMinutes: 44,
      // ── СКОРОСТЬ / SLA ──
      sla_f: 50, calls_sla_f: 50,
      sla_shift_f: 51,
      tlt_f: 52,
      calls_avgWait_f: 53,
      avgCallsPerLead: 54,
      overdueTasks: 55,
      // ── КАЧЕСТВО ──
      okk_f: 70, okk_buh1_f: 70, okk_buh2_f: 70, okk_med1_f: 70, okk_avg_f: 71,
      roleplay_f: 72,
    };

    const rows: Array<{
      sectionKey: string; sectionTitle: string; metricKey: string;
      metricLabel: string; isPlanRow: boolean; rank: number;
    }> = [];
    for (const sec of snapshot.sections) {
      if (!sec.perManager) continue;
      // B2G line-scoped view: only this line's section (funnel stays on line 1).
      if (lineFilter) {
        if (lineFilter === "1") {
          // Line 1 gets funnel + qualifier sections. Filter out other lines.
          if (sec.dbLine !== "1" && sec.key !== "funnel") continue;
        } else {
          if (sec.dbLine !== lineFilter) continue;
        }
      }
      for (const m of sec.metrics) {
        if (m.isGroupHeader) continue;
        if (DENYLIST.has(m.key)) continue;
        // Skip pure plan rows (hasPlan && !hasFact) — no per-manager context
        if (m.isPlanRow) continue;
        rows.push({
          sectionKey: sec.key,
          sectionTitle: sec.title,
          metricKey: m.key,
          metricLabel: m.label,
          isPlanRow: false,
          rank: ORDER[m.key] ?? 999,
        });
      }
    }
    // Stable sort by rank (metrics without ORDER entry fall to the bottom)
    rows.sort((a, b) => a.rank - b.rank);
    return rows;
  }, [snapshot, lineFilter]);

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
              <div className="daily-managers-dropdown absolute mt-1 min-w-[260px] max-h-[400px] overflow-y-auto rounded-xl border border-white/10 shadow-2xl p-2 bg-slate-900" style={{ zIndex: 100 }}>
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
        // No glass-panel/overflow-hidden here — both break sticky thead.
        <div className="rounded-2xl border border-white/5 bg-slate-900/40">
          <div className="w-full overflow-x-auto rounded-2xl">
            <table className="w-full text-left" style={{ borderCollapse: "separate", borderSpacing: 0 }}>
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
                          {/* Split-td: sticky label cell + empty colSpan filler. */}
                          <td className="sticky left-0 z-10 px-4 py-2 text-[10px] uppercase tracking-widest text-slate-400 font-bold bg-slate-800/80 min-w-[260px]">
                            {m.sectionTitle}
                          </td>
                          <td colSpan={columns.length} className="bg-slate-800/80 p-0" />
                        </tr>
                      )}
                      <tr className={`border-b border-white/5 hover:bg-white/[0.02] ${m.rank < 40 ? "daily-primary-row" : ""}`}>
                        <td className={`px-4 text-slate-300 sticky left-0 bg-slate-900/90 z-10 ${m.rank < 40 ? "py-3 text-[12px] font-semibold" : "py-2 text-[11px]"}`}>
                          {m.metricLabel}
                        </td>
                        {columns.map((c) => {
                          const val = c.getValue(m);
                          return (
                            <td key={c.key} className={`px-3 text-center tabular-nums ${m.rank < 40 ? "py-3 text-[13px] font-semibold" : "py-2"} ${getCellColor(val)}`}>
                              {formatCell(val, m.metricKey)}
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

// ====================== RATING FIRST LINE (B2G) ======================
// Mirrors the "Рейтинг первой линии" sheet in Excel Госники Daily Weekly
// Monthly. Line-1 qualifiers ranked by conversion % (terms ÷ leads).
// RR по записям = (termsTotal ÷ calendar-days-so-far) × days-in-month —
// forward projection of monthly terms total.
// Data comes from the monthly snapshot already loaded for the Managers
// sub-tab; no extra fetch.

function RatingFirstLineView({ monthlySnapshot, monthPeriodDate }: {
  monthlySnapshot: DailySnapshot | undefined;
  monthPeriodDate: string;
}) {
  const rows = useMemo(() => {
    if (!monthlySnapshot) return [];
    const funnelSection = monthlySnapshot.sections.find((s) => s.key === "funnel");
    if (!funnelSection) return [];
    const line1Managers = (funnelSection.managers ?? []).filter((mgr: ManagerData) => mgr.line === "1");
    return line1Managers.map((mgr: ManagerData) => {
      const byKey = new Map(mgr.metrics.map((m) => [m.key, m.fact]));
      const leads = Number(byKey.get("totalLeads") ?? 0);
      const terms = Number(byKey.get("termsTotal") ?? 0);
      const conv = leads > 0 ? (terms / leads) * 100 : 0;
      return { id: mgr.id, name: mgr.name, leads, terms, conv };
    }).sort((a: { conv: number }, b: { conv: number }) => b.conv - a.conv);
  }, [monthlySnapshot]);

  const [yearStr, monthStr] = monthPeriodDate.slice(0, 7).split("-");
  const year = Number(yearStr);
  const monthNum = Number(monthStr);
  const totalDaysInMonth = new Date(year, monthNum, 0).getDate();
  const now = new Date();
  const isCurrentMonth = now.getFullYear() === year && now.getMonth() + 1 === monthNum;
  const daysSoFar = isCurrentMonth ? now.getDate() : totalDaysInMonth;

  if (rows.length === 0) {
    return (
      <div className="glass-panel rounded-2xl p-6 border border-white/5 text-slate-500 text-sm text-center">
        Нет данных для рейтинга первой линии за этот месяц
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <h3 className="text-[11px] uppercase tracking-widest text-slate-400 font-bold">Рейтинг первой линии</h3>
        <span className="text-[10px] text-slate-500">
          {MONTH_NAMES[monthNum - 1]} {year}
          {isCurrentMonth ? ` • день ${daysSoFar} / ${totalDaysInMonth}` : ""}
        </span>
      </div>
      <div className="rounded-2xl border border-white/5 bg-slate-900/40 overflow-x-auto">
        <table className="w-full text-left" style={{ borderCollapse: "separate", borderSpacing: 0 }}>
          <thead className="bg-slate-800/40">
            <tr className="border-b border-white/10">
              <th className="px-4 py-2.5 text-[10px] uppercase tracking-widest text-slate-500 font-semibold">#</th>
              <th className="px-4 py-2.5 text-[11px] text-slate-300 font-bold">Менеджер</th>
              <th className="px-4 py-2.5 text-[11px] text-slate-300 font-bold text-right">Лиды за месяц</th>
              <th className="px-4 py-2.5 text-[11px] text-slate-300 font-bold text-right">Записи на термин</th>
              <th className="px-4 py-2.5 text-[11px] text-slate-300 font-bold text-right">Конверсия</th>
              <th className="px-4 py-2.5 text-[11px] text-slate-300 font-bold text-right">RR по записям</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r: { id: string; name: string; leads: number; terms: number; conv: number }, i: number) => {
              const rr = daysSoFar > 0 ? Math.round((r.terms / daysSoFar) * totalDaysInMonth) : 0;
              const convStr = r.conv.toFixed(2).replace(".", ",") + "%";
              return (
                <tr key={r.id} className="border-b border-white/5 hover:bg-white/[0.02]">
                  <td className="px-4 py-2.5 text-[12px] text-slate-500 tabular-nums">{i + 1}</td>
                  <td className="px-4 py-2.5 text-[13px] text-slate-200 font-semibold">{r.name}</td>
                  <td className="px-4 py-2.5 text-[13px] text-slate-300 text-right tabular-nums">{formatCellNumber(r.leads)}</td>
                  <td className="px-4 py-2.5 text-[13px] text-slate-300 text-right tabular-nums">{formatCellNumber(r.terms)}</td>
                  <td className={`px-4 py-2.5 text-[13px] text-right tabular-nums font-bold ${
                    r.conv >= 40 ? "text-emerald-400" : r.conv >= 25 ? "text-yellow-400" : "text-red-400"
                  }`}>{convStr}</td>
                  <td className="px-4 py-2.5 text-[13px] text-slate-300 text-right tabular-nums">{formatCellNumber(rr)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
