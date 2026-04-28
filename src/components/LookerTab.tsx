"use client";

import { Fragment, useState, useEffect, useRef, useCallback } from "react";
import { Loader2, ExternalLink, ChevronDown, ChevronRight } from "lucide-react";
import CalendarPicker, { type DateRange } from "@/components/CalendarPicker";

// ─── Department config ──────────────────────────────────────────────────────

const DEPT_CONFIG = {
  b2g: {
    label: "Госники",
    pipelines: ["Бух Гос", "Бух Бератер"] as const,
    statuses: [
      "Термин ДЦ состоялся",
      "Термин ДЦ отменен/перенесен",
      "Термин ДЦ",
      "Термин АА отменен/перенесен",
      "Принято от первой линии",
      "Принимает решение",
      "Новый лид",
      "Недозвон",
      "На рассмотрении бератера",
      "Контакт установлен",
      "Консультация проведена",
      "Консультация перед термином ДЦ проведена",
      "Консультация перед термином ДЦ",
      "Консультация перед термином АА проведена",
      "Консультация перед термином АА",
    ] as const,
    slaRanges: [
      { label: "0–9 мин", value: "0-9" },
      { label: "10–29 мин", value: "10-29" },
      { label: "30+ мин", value: "30+" },
    ],
    hasPipeline: true,
  },
  b2b: {
    label: "Коммерсы",
    pipelines: ["Бух Комм", "Мед Комм"] as const,
    statuses: [
      "Успешно реализовано",
      "Рассрочка",
      "Новый лид 3",
      "Новый лид 2",
      "Новый лид",
      "Нет предварительного согласия",
      "Недозвон",
      "Контакт установлен",
      "Консультация проведена",
      "ИНТЕРЕС ПОДТВЕРЖДЕН",
      "Закрыто и не реализовано",
      "Взят в работу",
      "База",
      "Счет выставлен",
    ] as const,
    slaRanges: [{ label: "10–29 мин", value: "10-29" }],
    hasPipeline: false,
  },
} as const;

// ─── Slice options ──────────────────────────────────────────────────────────

const SLICE_OPTIONS = [
  { label: "Менеджер", col: "manager" },
  { label: "Источник", col: "utm_source" },
  { label: "Статус", col: "status" },
  { label: "Воронка", col: "pipeline" },
  { label: "Категория", col: "category" },
] as const;

type SliceCol = (typeof SLICE_OPTIONS)[number]["col"];

// ─── Types ──────────────────────────────────────────────────────────────────

type View = "all_calls" | "cohorts" | "tlt" | "conversions";

interface AllCallsRow {
  manager: string;
  total_calls: number;
  outgoing_calls: number;
  incoming_calls: number;
  messages_sent: number;
  success_pct: number | null;
  success_calls: number;
  total_duration_sec: number;
}

interface CohortsRow {
  manager: string;
  lead_count: number;
  outgoing_calls: number;
  messages_sent: number;
  success_pct: number | null;
  success_calls: number;
  total_all_calls: number;
  total_duration_sec: number;
  avg_calls_per_lead: number | null;
  /** calendar seconds from lead creation to first outgoing call (avg). */
  avg_sla_lead_to_call_sec: number | null;
  /** calendar seconds from max(lead, shift_start_on_lead_day) to first call (avg). */
  avg_sla_from_shift_sec: number | null;
  sla_lead_count: number;
}

interface TltSummaryRow {
  param1: string | null;
  param2: string | null;
  param3: string | null;
  lead_count: number;
  avg_tlt: number | null;
  avg_gap_sec: number | null;
  outgoing_calls: number;
  messages_sent: number;
  total_comms: number;
}

interface ConvRow {
  pipeline: string;
  status: string;
  status_order: number | null;
  lead_count: number;
  pipeline_total: number;
  pct: number;
}

interface TltDetailRow {
  manager: string;
  current_status: string | null;
  lead_id: number;
  tlt: number | null;
  outgoing_calls: number;
  messages_sent: number;
  total_comms: number;
  avg_gap_sec: number | null;
}

/** Per-lead drill-down row for the Cohorts table inline expansion. */
interface CohortDetailRow {
  lead_id: number;
  lead_created_at: string | null;
  current_status: string | null;
  pipeline: string | null;
  first_call_out_at: string | null;
  /** business-hours seconds — the headline SLA the cohort table averages on */
  sla_first_call_seconds: number | null;
  /** calendar seconds (raw clock time lead→call) */
  sla_first_call_calendar_seconds: number | null;
  /** business-hours from manager's shift-start, ignoring lead-arrived-after-shift */
  sla_first_call_from_shift_seconds: number | null;
  total_calls: number;
  success_calls: number;
  outgoing_calls: number;
  messages_sent: number;
  avg_duration_sec: number | null;
}

interface ApiResponse {
  view: string;
  rows: AllCallsRow[] | CohortsRow[] | TltSummaryRow[] | TltDetailRow[] | ConvRow[];
  total: number;
  filterOptions: { managers: string[] };
}

// ─── Formatters ─────────────────────────────────────────────────────────────

function fmtHMS(sec: number | null | undefined): string {
  if (sec == null) return "—";
  const abs = Math.abs(Number(sec));
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const s = Math.floor(abs % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function fmtPct(val: number | null | undefined): string {
  if (val == null) return "—";
  return `${val}%`;
}

function fmtNum(val: number | null | undefined): string {
  if (val == null) return "—";
  return Number(val).toLocaleString("ru");
}

function fmtDate(val: unknown): string {
  if (!val) return "—";
  const d = new Date(val as string);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function makeDefaultRange(): DateRange {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 30);
  return { start, end };
}

// ─── Pill button helper ──────────────────────────────────────────────────────

function PillBtn({
  active,
  onClick,
  children,
  accent = "blue",
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  accent?: "blue" | "purple";
}) {
  const activeClass =
    accent === "purple"
      ? "bg-purple-500/20 text-purple-400 border border-purple-500/30"
      : "bg-blue-500/20 text-blue-400 border border-blue-500/30";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 rounded-xl text-[11px] font-semibold tracking-wide transition-all border ${
        active ? activeClass : "text-slate-400 hover:text-white border-transparent hover:border-white/5"
      }`}
    >
      {children}
    </button>
  );
}

// ─── Compact dropdown filter ─────────────────────────────────────────────────

function FilterDropdown({
  label,
  activeLabel,
  isActive,
  open,
  onToggle,
  dropdownRef,
  accent = "blue",
  children,
}: {
  label: string;
  activeLabel?: string;
  isActive: boolean;
  open: boolean;
  onToggle: () => void;
  dropdownRef: React.RefObject<HTMLDivElement | null>;
  accent?: "blue" | "purple";
  children: React.ReactNode;
}) {
  const activeClass =
    accent === "purple"
      ? "bg-purple-500/20 text-purple-400 border-purple-500/30"
      : "bg-blue-500/20 text-blue-400 border-blue-500/30";

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={onToggle}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-semibold tracking-wide transition-all border ${
          isActive
            ? `${activeClass} border`
            : "text-slate-400 hover:text-white border-white/10 bg-slate-800/60"
        }`}
      >
        {isActive && activeLabel ? activeLabel : label}
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute top-full mt-2 left-0 bg-slate-900 border border-white/10 rounded-xl shadow-xl z-50 min-w-[130px]">
          <div className="p-1">
            {children}
          </div>
        </div>
      )}
    </div>
  );
}

function DropdownItem({
  active,
  onClick,
  children,
  accent = "blue",
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  accent?: "blue" | "purple";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left px-3 py-2 rounded-lg text-xs hover:bg-white/[0.06] transition-colors whitespace-nowrap ${
        active
          ? accent === "purple" ? "text-purple-400 font-semibold" : "text-blue-400 font-semibold"
          : "text-slate-300"
      }`}
    >
      {children}
    </button>
  );
}

// ─── Tables ──────────────────────────────────────────────────────────────────

function AllCallsTable({ rows, loading }: { rows: AllCallsRow[]; loading: boolean }) {
  const colCount = 8;
  const safeRows = rows ?? [];

  const totalCalls = safeRows.reduce((s, r) => s + Number(r.total_calls), 0);
  const totalOut = safeRows.reduce((s, r) => s + Number(r.outgoing_calls), 0);
  const totalIn = safeRows.reduce((s, r) => s + Number(r.incoming_calls), 0);
  const totalMsg = safeRows.reduce((s, r) => s + Number(r.messages_sent), 0);
  const totalSuccess = safeRows.reduce((s, r) => s + Number(r.success_calls), 0);
  const totalDur = safeRows.reduce((s, r) => s + Number(r.total_duration_sec), 0);
  const totalPct = totalCalls > 0 ? Math.round((totalSuccess / totalCalls) * 100) : null;

  return (
    <div className="glass-panel rounded-2xl overflow-hidden border border-white/5">
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="border-b border-white/10">
              {["Менеджер", "Всего звонков", "Исходящие", "Входящие", "Сообщений", "% успеха", "Успешных (10+с)", "Время на линии"].map((h) => (
                <th key={h} className="px-4 py-3 text-[10px] uppercase tracking-widest text-slate-400 font-semibold whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={colCount} className="text-center py-16 text-slate-400">
                  <Loader2 className="w-5 h-5 animate-spin mx-auto" />
                </td>
              </tr>
            ) : safeRows.length === 0 ? (
              <tr>
                <td colSpan={colCount} className="text-center py-16 text-slate-500 text-xs">
                  Нет данных за выбранный период
                </td>
              </tr>
            ) : (
              <>
                {safeRows.map((r, i) => (
                  <tr key={i} className="border-t border-white/5 hover:bg-white/[0.03] transition-colors">
                    <td className="px-4 py-2.5 text-slate-200 whitespace-nowrap">{r.manager}</td>
                    <td className="px-4 py-2.5 text-slate-200">{fmtNum(r.total_calls)}</td>
                    <td className="px-4 py-2.5 text-slate-200">{fmtNum(r.outgoing_calls)}</td>
                    <td className="px-4 py-2.5 text-slate-200">{fmtNum(r.incoming_calls)}</td>
                    <td className="px-4 py-2.5 text-slate-200">{fmtNum(r.messages_sent)}</td>
                    <td className="px-4 py-2.5 text-slate-200">{fmtPct(r.success_pct)}</td>
                    <td className="px-4 py-2.5 text-slate-200">{fmtNum(r.success_calls)}</td>
                    <td className="px-4 py-2.5 text-slate-200 whitespace-nowrap">{fmtHMS(r.total_duration_sec)}</td>
                  </tr>
                ))}
                <tr className="border-t border-white/10 font-semibold bg-white/[0.04]">
                  <td className="px-4 py-2.5 text-slate-200">Итого</td>
                  <td className="px-4 py-2.5 text-slate-200">{fmtNum(totalCalls)}</td>
                  <td className="px-4 py-2.5 text-slate-200">{fmtNum(totalOut)}</td>
                  <td className="px-4 py-2.5 text-slate-200">{fmtNum(totalIn)}</td>
                  <td className="px-4 py-2.5 text-slate-200">{fmtNum(totalMsg)}</td>
                  <td className="px-4 py-2.5 text-slate-200">{fmtPct(totalPct)}</td>
                  <td className="px-4 py-2.5 text-slate-200">{fmtNum(totalSuccess)}</td>
                  <td className="px-4 py-2.5 text-slate-200 whitespace-nowrap">{fmtHMS(totalDur)}</td>
                </tr>
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CohortsTable({
  rows,
  loading,
  expandedManager,
  onToggleManager,
  detailRows,
  detailLoading,
  detailError,
}: {
  rows: CohortsRow[];
  loading: boolean;
  expandedManager: string | null;
  onToggleManager: (manager: string) => void;
  detailRows: CohortDetailRow[];
  detailLoading: boolean;
  detailError: string | null;
}) {
  const colCount = 9;
  const safeRows = rows ?? [];

  const totalLeads = safeRows.reduce((s, r) => s + Number(r.lead_count), 0);
  const totalOut = safeRows.reduce((s, r) => s + Number(r.outgoing_calls), 0);
  const totalMsg = safeRows.reduce((s, r) => s + Number(r.messages_sent), 0);
  const totalDur = safeRows.reduce((s, r) => s + Number(r.total_duration_sec), 0);
  const totalAllCalls = safeRows.reduce((s, r) => s + Number(r.total_all_calls), 0);
  const totalSuccessCalls = safeRows.reduce((s, r) => s + Number(r.success_calls), 0);
  const totalSlaLeads = safeRows.reduce((s, r) => s + Number(r.sla_lead_count ?? 0), 0);
  // Weighted grand-average = Σ(avg_per_mgr × lead_count_per_mgr) / Σ(lead_count)
  const totalLeadToCallSum = safeRows.reduce(
    (s, r) => s + (r.avg_sla_lead_to_call_sec != null ? Number(r.avg_sla_lead_to_call_sec) * Number(r.sla_lead_count ?? 0) : 0),
    0,
  );
  const totalFromShiftSum = safeRows.reduce(
    (s, r) => s + (r.avg_sla_from_shift_sec != null ? Number(r.avg_sla_from_shift_sec) * Number(r.sla_lead_count ?? 0) : 0),
    0,
  );

  const totalPct = totalAllCalls > 0 ? Math.round((totalSuccessCalls / totalAllCalls) * 100) : null;
  const avgCallsPerLead = totalLeads > 0 ? Math.round((totalAllCalls / totalLeads) * 100) / 100 : null;
  const avgLeadToCall = totalSlaLeads > 0 ? Math.round(totalLeadToCallSum / totalSlaLeads) : null;
  const avgFromShift = totalSlaLeads > 0 ? Math.round(totalFromShiftSum / totalSlaLeads) : null;

  return (
    <div className="glass-panel rounded-2xl overflow-hidden border border-white/5">
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="border-b border-white/10">
              {["Менеджер", "SLA лид → звонок (ср)", "SLA от начала смены (ср)", "Лидов", "Исходящие", "Сообщений", "% успеха", "Время на линии", "Звонков/лид"].map((h) => (
                <th key={h} className="px-4 py-3 text-[10px] uppercase tracking-widest text-slate-400 font-semibold whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={colCount} className="text-center py-16 text-slate-400">
                  <Loader2 className="w-5 h-5 animate-spin mx-auto" />
                </td>
              </tr>
            ) : safeRows.length === 0 ? (
              <tr>
                <td colSpan={colCount} className="text-center py-16 text-slate-500 text-xs">
                  Нет данных за выбранный период
                </td>
              </tr>
            ) : (
              <>
                {safeRows.map((r, i) => {
                  const isExpanded = expandedManager === r.manager;
                  return (
                    <Fragment key={i}>
                      <tr
                        className={`border-t border-white/5 cursor-pointer transition-colors ${
                          isExpanded ? "bg-blue-500/[0.06]" : "hover:bg-white/[0.03]"
                        }`}
                        onClick={() => onToggleManager(r.manager)}
                        title="Нажмите, чтобы посмотреть звонки этого менеджера за период"
                      >
                        <td className="px-4 py-2.5 text-slate-200 whitespace-nowrap">
                          <span className="inline-flex items-center gap-1.5">
                            {isExpanded
                              ? <ChevronDown className="w-3.5 h-3.5 text-blue-400" />
                              : <ChevronRight className="w-3.5 h-3.5 text-slate-500" />}
                            {r.manager}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-slate-200 whitespace-nowrap">{fmtHMS(r.avg_sla_lead_to_call_sec)}</td>
                        <td className="px-4 py-2.5 text-slate-200 whitespace-nowrap">{fmtHMS(r.avg_sla_from_shift_sec)}</td>
                        <td className="px-4 py-2.5 text-slate-200">{fmtNum(r.lead_count)}</td>
                        <td className="px-4 py-2.5 text-slate-200">{fmtNum(r.outgoing_calls)}</td>
                        <td className="px-4 py-2.5 text-slate-200">{fmtNum(r.messages_sent)}</td>
                        <td className="px-4 py-2.5 text-slate-200">{fmtPct(r.success_pct)}</td>
                        <td className="px-4 py-2.5 text-slate-200 whitespace-nowrap">{fmtHMS(r.total_duration_sec)}</td>
                        <td className="px-4 py-2.5 text-slate-200">{r.avg_calls_per_lead != null ? Number(r.avg_calls_per_lead) : "—"}</td>
                      </tr>
                      {isExpanded && (
                        <tr className="bg-slate-950/40">
                          <td colSpan={colCount} className="px-4 py-3">
                            <CohortDetailInline
                              manager={r.manager}
                              loading={detailLoading}
                              error={detailError}
                              rows={detailRows}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                <tr className="border-t border-white/10 font-semibold bg-white/[0.04]">
                  <td className="px-4 py-2.5 text-slate-200">Итого</td>
                  <td className="px-4 py-2.5 text-slate-200 whitespace-nowrap">{fmtHMS(avgLeadToCall)}</td>
                  <td className="px-4 py-2.5 text-slate-200 whitespace-nowrap">{fmtHMS(avgFromShift)}</td>
                  <td className="px-4 py-2.5 text-slate-200">{fmtNum(totalLeads)}</td>
                  <td className="px-4 py-2.5 text-slate-200">{fmtNum(totalOut)}</td>
                  <td className="px-4 py-2.5 text-slate-200">{fmtNum(totalMsg)}</td>
                  <td className="px-4 py-2.5 text-slate-200">{fmtPct(totalPct)}</td>
                  <td className="px-4 py-2.5 text-slate-200 whitespace-nowrap">{fmtHMS(totalDur)}</td>
                  <td className="px-4 py-2.5 text-slate-200">{avgCallsPerLead != null ? avgCallsPerLead : "—"}</td>
                </tr>
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Inline per-lead detail rendered below an expanded Cohorts row. Shows every
 * lead in the manager's cohort with its SLA, call counts, and a Kommo
 * deep-link, sorted by worst-SLA-first so the user can drill straight into
 * the problem deals.
 */
function CohortDetailInline({
  manager,
  loading,
  error,
  rows,
}: {
  manager: string;
  loading: boolean;
  error: string | null;
  rows: CohortDetailRow[];
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
        <span className="ml-2 text-[11px] text-slate-400">Грузим звонки {manager}…</span>
      </div>
    );
  }
  if (error) {
    return (
      <div className="text-[11px] text-rose-400 py-4 text-center">
        Не удалось загрузить детализацию: {error}
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="text-[11px] text-slate-500 py-4 text-center">
        Нет лидов у менеджера {manager} за выбранный период.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-white/5 bg-slate-900/40 overflow-hidden">
      <div className="px-3 py-2 border-b border-white/5 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold">
          {manager} — лиды по убыванию SLA
        </span>
        <span className="text-[10px] text-slate-500 ml-auto">
          {rows.length} лид{rows.length === 1 ? "" : rows.length < 5 ? "а" : "ов"}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse text-[11px]">
          <thead>
            <tr className="border-b border-white/5 bg-slate-900/60">
              {["Лид", "Создан", "Воронка / Текущий статус", "SLA лид→звонок", "SLA рабочие часы", "SLA от смены", "Звонки", "Первый звонок"].map((h) => (
                <th key={h} className="px-3 py-2 text-[9px] uppercase tracking-widest text-slate-500 font-semibold whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              // Primary SLA = calendar seconds, matches parent table's
              // "SLA лид → звонок (ср)" column (AVG(first_call_out - sla_start)).
              // Highlight rows ≥ 30 min — that's the worst bucket in the SLA
              // dropdown filter and the obvious "needs attention" line.
              const primarySla = r.sla_first_call_calendar_seconds;
              const isCritical = primarySla != null && primarySla >= 1800;
              return (
                <tr
                  key={r.lead_id}
                  className={`border-t border-white/5 hover:bg-white/[0.03] transition-colors ${
                    isCritical ? "bg-rose-500/[0.05]" : ""
                  }`}
                >
                  <td className="px-3 py-2">
                    <a
                      href={`https://sternmeister.kommo.com/leads/detail/${r.lead_id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="flex items-center gap-1 text-blue-400 hover:text-blue-300 transition-colors"
                    >
                      {r.lead_id}
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </td>
                  <td className="px-3 py-2 text-slate-300 whitespace-nowrap">{fmtDate(r.lead_created_at)}</td>
                  <td className="px-3 py-2 text-slate-300 max-w-[260px]">
                    <span className="text-slate-500">{r.pipeline ?? "—"}</span>
                    {r.pipeline && r.current_status ? <span className="text-slate-600 mx-1">/</span> : null}
                    <span className="text-slate-300">{r.current_status ?? "—"}</span>
                  </td>
                  <td className={`px-3 py-2 whitespace-nowrap ${isCritical ? "text-rose-300 font-medium" : "text-slate-200"}`}>
                    {fmtHMS(r.sla_first_call_calendar_seconds)}
                  </td>
                  <td className="px-3 py-2 text-slate-300 whitespace-nowrap">
                    {fmtHMS(r.sla_first_call_seconds)}
                  </td>
                  <td className="px-3 py-2 text-slate-300 whitespace-nowrap">
                    {fmtHMS(r.sla_first_call_from_shift_seconds)}
                  </td>
                  <td className="px-3 py-2 text-slate-300 whitespace-nowrap">
                    {fmtNum(r.success_calls)}<span className="text-slate-500"> / {fmtNum(r.total_calls)}</span>
                  </td>
                  <td className="px-3 py-2 text-slate-400 whitespace-nowrap">
                    {r.first_call_out_at ? new Date(r.first_call_out_at).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"}
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

// ─── TLT Tables ──────────────────────────────────────────────────────────────

function TltSummaryTable({
  rows,
  loading,
  slice1Label,
  slice2Label,
  slice3Label,
}: {
  rows: TltSummaryRow[];
  loading: boolean;
  slice1Label: string;
  slice2Label: string;
  slice3Label: string;
}) {
  const colCount = 9;
  const safeRows = rows ?? [];

  const totalLeads = safeRows.reduce((s, r) => s + Number(r.lead_count), 0);
  const totalOut = safeRows.reduce((s, r) => s + Number(r.outgoing_calls), 0);
  const totalMsg = safeRows.reduce((s, r) => s + Number(r.messages_sent), 0);
  const totalComms = safeRows.reduce((s, r) => s + Number(r.total_comms), 0);
  const tltRows = safeRows.filter((r) => r.avg_tlt != null);
  const totalSumTlt = tltRows.reduce((s, r) => s + Number(r.avg_tlt) * Number(r.lead_count), 0);
  const totalLeadsWithTlt = tltRows.reduce((s, r) => s + Number(r.lead_count), 0);
  const totalAvgTlt = totalLeadsWithTlt > 0 ? Math.round(totalSumTlt / totalLeadsWithTlt) : null;
  const gapRows = safeRows.filter((r) => r.avg_gap_sec != null);
  const totalSumGap = gapRows.reduce((s, r) => s + Number(r.avg_gap_sec) * Number(r.lead_count), 0);
  const totalLeadsWithGap = gapRows.reduce((s, r) => s + Number(r.lead_count), 0);
  const totalAvgGap = totalLeadsWithGap > 0 ? Math.round(totalSumGap / totalLeadsWithGap) : null;

  return (
    <div className="glass-panel rounded-2xl overflow-hidden border border-white/5">
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="border-b border-white/10">
              <th className="px-4 py-3 text-[10px] uppercase tracking-widest text-slate-400 font-semibold whitespace-nowrap">{slice1Label}</th>
              <th className="px-4 py-3 text-[10px] uppercase tracking-widest text-slate-400 font-semibold whitespace-nowrap">{slice2Label}</th>
              <th className="px-4 py-3 text-[10px] uppercase tracking-widest text-slate-400 font-semibold whitespace-nowrap">{slice3Label}</th>
              {["Кол-во лидов", "TLT средний", "Ср. между звонками", "Исходящие", "Сообщений", "Всего коммуникаций"].map((h) => (
                <th key={h} className="px-4 py-3 text-[10px] uppercase tracking-widest text-slate-400 font-semibold whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={colCount} className="text-center py-16 text-slate-400">
                  <Loader2 className="w-5 h-5 animate-spin mx-auto" />
                </td>
              </tr>
            ) : safeRows.length === 0 ? (
              <tr>
                <td colSpan={colCount} className="text-center py-16 text-slate-500 text-xs">
                  Нет данных за выбранный период
                </td>
              </tr>
            ) : (
              <>
                {safeRows.map((r, i) => (
                  <tr key={i} className="border-t border-white/5 hover:bg-white/[0.03] transition-colors">
                    <td className="px-4 py-2.5 text-slate-200 whitespace-nowrap">{r.param1 ?? "—"}</td>
                    <td className="px-4 py-2.5 text-slate-200 whitespace-nowrap">{r.param2 ?? "—"}</td>
                    <td className="px-4 py-2.5 text-slate-200 whitespace-nowrap">{r.param3 ?? "—"}</td>
                    <td className="px-4 py-2.5 text-slate-200">{fmtNum(r.lead_count)}</td>
                    <td className="px-4 py-2.5 text-slate-200 whitespace-nowrap">{fmtHMS(r.avg_tlt)}</td>
                    <td className="px-4 py-2.5 text-slate-200 whitespace-nowrap">{fmtHMS(r.avg_gap_sec)}</td>
                    <td className="px-4 py-2.5 text-slate-200">{fmtNum(r.outgoing_calls)}</td>
                    <td className="px-4 py-2.5 text-slate-200">{fmtNum(r.messages_sent)}</td>
                    <td className="px-4 py-2.5 text-slate-200">{fmtNum(r.total_comms)}</td>
                  </tr>
                ))}
                <tr className="border-t border-white/10 font-semibold bg-white/[0.04]">
                  <td className="px-4 py-2.5 text-slate-200" colSpan={3}>Общий итог</td>
                  <td className="px-4 py-2.5 text-slate-200">{fmtNum(totalLeads)}</td>
                  <td className="px-4 py-2.5 text-slate-200 whitespace-nowrap">{fmtHMS(totalAvgTlt)}</td>
                  <td className="px-4 py-2.5 text-slate-200 whitespace-nowrap">{fmtHMS(totalAvgGap)}</td>
                  <td className="px-4 py-2.5 text-slate-200">{fmtNum(totalOut)}</td>
                  <td className="px-4 py-2.5 text-slate-200">{fmtNum(totalMsg)}</td>
                  <td className="px-4 py-2.5 text-slate-200">{fmtNum(totalComms)}</td>
                </tr>
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TltDetailTable({
  rows,
  loading,
  total,
  page,
  onPageChange,
}: {
  rows: TltDetailRow[];
  loading: boolean;
  total: number;
  page: number;
  onPageChange: (p: number) => void;
}) {
  const colCount = 8;
  const PAGE_SIZE = 100;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safeRows = rows ?? [];

  const totalOut = safeRows.reduce((s, r) => s + Number(r.outgoing_calls), 0);
  const totalMsg = safeRows.reduce((s, r) => s + Number(r.messages_sent), 0);
  const totalComms = safeRows.reduce((s, r) => s + Number(r.total_comms), 0);
  const tltRows = safeRows.filter((r) => r.tlt != null);
  const totalAvgTlt = tltRows.length > 0 ? Math.round(tltRows.reduce((s, r) => s + Number(r.tlt), 0) / tltRows.length) : null;
  const gapRows = safeRows.filter((r) => r.avg_gap_sec != null);
  const totalAvgGap = gapRows.length > 0 ? Math.round(gapRows.reduce((s, r) => s + Number(r.avg_gap_sec), 0) / gapRows.length) : null;

  return (
    <div className="flex flex-col gap-2">
      <div className="glass-panel rounded-2xl overflow-hidden border border-white/5">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-white/10">
                {["Менеджер", "Статус", "Лид", "TLT", "Исходящие", "Сообщений", "Всего коммуникаций", "Ср. между звонками"].map((h) => (
                  <th key={h} className="px-4 py-3 text-[10px] uppercase tracking-widest text-slate-400 font-semibold whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={colCount} className="text-center py-16 text-slate-400">
                    <Loader2 className="w-5 h-5 animate-spin mx-auto" />
                  </td>
                </tr>
              ) : safeRows.length === 0 ? (
                <tr>
                  <td colSpan={colCount} className="text-center py-16 text-slate-500 text-xs">
                    Нет данных за выбранный период
                  </td>
                </tr>
              ) : (
                <>
                  {safeRows.map((r, i) => (
                    <tr key={i} className="border-t border-white/5 hover:bg-white/[0.03] transition-colors">
                      <td className="px-4 py-2.5 text-slate-200 whitespace-nowrap">{r.manager ?? "—"}</td>
                      <td className="px-4 py-2.5 text-slate-300 max-w-[180px] truncate whitespace-nowrap">{r.current_status ?? "—"}</td>
                      <td className="px-4 py-2.5">
                        <a
                          href={`https://sternmeister.kommo.com/leads/detail/${r.lead_id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-blue-400 hover:text-blue-300 transition-colors"
                        >
                          {r.lead_id}
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      </td>
                      <td className="px-4 py-2.5 text-slate-200 whitespace-nowrap">{fmtHMS(r.tlt)}</td>
                      <td className="px-4 py-2.5 text-slate-200">{fmtNum(r.outgoing_calls)}</td>
                      <td className="px-4 py-2.5 text-slate-200">{fmtNum(r.messages_sent)}</td>
                      <td className="px-4 py-2.5 text-slate-200">{fmtNum(r.total_comms)}</td>
                      <td className="px-4 py-2.5 text-slate-200 whitespace-nowrap">{fmtHMS(r.avg_gap_sec)}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-white/10 font-semibold bg-white/[0.04]">
                    <td className="px-4 py-2.5 text-slate-200" colSpan={3}>Общий итог</td>
                    <td className="px-4 py-2.5 text-slate-200 whitespace-nowrap">{fmtHMS(totalAvgTlt)}</td>
                    <td className="px-4 py-2.5 text-slate-200">{fmtNum(totalOut)}</td>
                    <td className="px-4 py-2.5 text-slate-200">{fmtNum(totalMsg)}</td>
                    <td className="px-4 py-2.5 text-slate-200">{fmtNum(totalComms)}</td>
                    <td className="px-4 py-2.5 text-slate-200 whitespace-nowrap">{fmtHMS(totalAvgGap)}</td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex items-center justify-between px-1">
        <span className="text-xs text-slate-400">
          {loading ? "Загрузка..." : `${fmtNum(total)} строк`}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onPageChange(Math.max(0, page - 1))}
            disabled={page === 0 || loading}
            className="w-7 h-7 flex items-center justify-center rounded-lg bg-slate-800/60 border border-white/10 text-slate-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-all text-sm"
          >
            ‹
          </button>
          <span className="text-xs text-slate-400">Стр {page + 1} / {totalPages}</span>
          <button
            type="button"
            onClick={() => onPageChange(page + 1)}
            disabled={(page + 1) * PAGE_SIZE >= total || loading}
            className="w-7 h-7 flex items-center justify-center rounded-lg bg-slate-800/60 border border-white/10 text-slate-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-all text-sm"
          >
            ›
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Conversions table ───────────────────────────────────────────────────────

function ConversionsSection({ rows, loading }: { rows: ConvRow[]; loading: boolean }) {
  const safeRows = rows ?? [];

  if (loading) {
    return (
      <div className="glass-panel rounded-2xl border border-white/5 flex items-center justify-center py-20">
        <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
      </div>
    );
  }

  if (safeRows.length === 0) {
    return (
      <div className="glass-panel rounded-2xl border border-white/5 flex items-center justify-center py-20">
        <span className="text-xs text-slate-500">Нет данных за выбранный период</span>
      </div>
    );
  }

  // Group by pipeline preserving SQL order
  const pipelines: string[] = [];
  const byPipeline = new Map<string, ConvRow[]>();
  for (const r of safeRows) {
    if (!byPipeline.has(r.pipeline)) {
      pipelines.push(r.pipeline);
      byPipeline.set(r.pipeline, []);
    }
    byPipeline.get(r.pipeline)!.push(r);
  }

  return (
    <div className="flex flex-col gap-5">
      {pipelines.map((pipeline) => {
        const pipeRows = byPipeline.get(pipeline)!;
        // pipeline_total = cohort size (leads created in period); lead_count can exceed
        // it because one lead may pass through multiple statuses (true funnel).
        const total = Number(pipeRows[0]?.pipeline_total ?? 0);
        const maxLeads = Math.max(...pipeRows.map((r) => Number(r.lead_count)));

        return (
          <div key={pipeline} className="glass-panel rounded-2xl overflow-hidden border border-white/5">
            {/* Pipeline header */}
            <div className="px-5 py-3 border-b border-white/10 flex items-center gap-3">
              <span className="text-xs font-semibold text-slate-200">{pipeline}</span>
              <span className="text-[10px] text-slate-500 bg-white/5 px-2 py.0.5 rounded-full">
                {fmtNum(total)} лидов в когорте
              </span>
              <span className="text-[9px] text-slate-600 ml-auto">% от когорты</span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-white/10">
                    <th className="px-5 py-2.5 text-[10px] uppercase tracking-widest text-slate-400 font-semibold w-1/2">
                      Статус
                    </th>
                    <th className="px-5 py-2.5 text-[10px] uppercase tracking-widest text-slate-400 font-semibold w-1/4">
                      Лиды
                    </th>
                    <th className="px-5 py-2.5 text-[10px] uppercase tracking-widest text-slate-400 font-semibold w-1/4">
                      %
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {pipeRows.map((r) => {
                    const leadCount = Number(r.lead_count);
                    const pct = Number(r.pct);
                    // Bar width relative to pipeline_total so all bars express the same scale
                    const leadsBarW = total > 0 ? Math.min(Math.round((leadCount / total) * 100), 100) : 0;

                    return (
                      <tr
                        key={r.status}
                        className="border-t border-white/5 hover:bg-white/[0.02] transition-colors"
                      >
                        <td className="px-5 py-2.5 text-slate-300 max-w-[280px]">
                          {r.status ?? "—"}
                        </td>
                        <td className="px-5 py-2.5">
                          <div className="flex items-center gap-2.5">
                            <div className="flex-1 max-w-[80px] h-1.5 bg-white/5 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-blue-500/60 rounded-full"
                                style={{ width: `${leadsBarW}%` }}
                              />
                            </div>
                            <span className="text-slate-200 tabular-nums w-8 text-right">
                              {fmtNum(leadCount)}
                            </span>
                          </div>
                        </td>
                        <td className="px-5 py-2.5">
                          <div className="flex items-center gap-2.5">
                            <div className="flex-1 max-w-[80px] h-1.5 bg-white/5 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-emerald-500/60 rounded-full"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className="text-slate-200 tabular-nums w-12 text-right">
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
          </div>
        );
      })}
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

interface LookerTabProps {
  department: "b2g" | "b2b";
}

export default function LookerTab({ department }: LookerTabProps) {
  const config = DEPT_CONFIG[department];

  const [view, setView] = useState<View>("all_calls");
  const [dateRange, setDateRange] = useState<DateRange>(makeDefaultRange);
  const [manager, setManager] = useState("");
  const [selectedStatuses, setSelectedStatuses] = useState<string[]>([]);
  const [category, setCategory] = useState("");
  const [slaRange, setSlaRange] = useState("");
  const [pipeline, setPipeline] = useState("");
  const [tltPage, setTltPage] = useState(0);
  const [slice1, setSlice1] = useState<SliceCol>("manager");
  const [slice2, setSlice2] = useState<SliceCol>("utm_source");
  const [slice3, setSlice3] = useState<SliceCol>("status");

  const [data, setData] = useState<ApiResponse | null>(null);
  const [tltSummaryRows, setTltSummaryRows] = useState<TltSummaryRow[]>([]);
  const [tltDetailRows, setTltDetailRows] = useState<TltDetailRow[]>([]);
  const [tltDetailTotal, setTltDetailTotal] = useState(0);
  const [convRows, setConvRows] = useState<ConvRow[]>([]);
  const [managers, setManagers] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [minDate, setMinDate] = useState<Date | null>(null);
  const [maxDate, setMaxDate] = useState<Date | null>(null);

  // Cohorts drill-down — null = collapsed; manager name = expanded.
  const [expandedManager, setExpandedManager] = useState<string | null>(null);
  const [cohortDetailRows, setCohortDetailRows] = useState<CohortDetailRow[]>([]);
  const [cohortDetailLoading, setCohortDetailLoading] = useState(false);
  const [cohortDetailError, setCohortDetailError] = useState<string | null>(null);
  const detailAbortRef = useRef<AbortController | null>(null);

  const [statusOpen, setStatusOpen] = useState(false);
  const [slaOpen, setSlaOpen] = useState(false);
  const [pipelineOpen, setPipelineOpen] = useState(false);

  const statusDropdownRef = useRef<HTMLDivElement>(null);
  const slaDropdownRef = useRef<HTMLDivElement>(null);
  const pipelineDropdownRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Reset filters when department changes
  useEffect(() => {
    setManager("");
    setSelectedStatuses([]);
    setCategory("");
    setSlaRange("");
    setPipeline("");
    setTltPage(0);
    setData(null);
    setTltSummaryRows([]);
    setTltDetailRows([]);
    setConvRows([]);
    setExpandedManager(null);
    setCohortDetailRows([]);
    setCohortDetailError(null);
  }, [department]);

  // Collapse the drill-down whenever the underlying data context shifts —
  // a stale lead list under a different date/filter set would mislead the
  // user into clicking on leads that aren't in the new period at all.
  useEffect(() => {
    setExpandedManager(null);
    setCohortDetailRows([]);
    setCohortDetailError(null);
  }, [view, dateRange, manager, selectedStatuses, category, slaRange, pipeline]);

  // Fetch available date bounds for the calendar
  useEffect(() => {
    const params = new URLSearchParams({ dept: department, view: "meta" });
    fetch(`/api/analytics/looker/data?${params}`)
      .then((r) => r.json())
      .then((json: { minDate?: string | null; maxDate?: string | null }) => {
        setMinDate(json.minDate ? new Date(`${json.minDate}T00:00:00`) : null);
        setMaxDate(json.maxDate ? new Date(`${json.maxDate}T23:59:59`) : null);
      })
      .catch(() => {/* non-critical */});
  }, [department]);

  // Close dropdowns on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (statusDropdownRef.current && !statusDropdownRef.current.contains(e.target as Node)) {
        setStatusOpen(false);
      }
      if (slaDropdownRef.current && !slaDropdownRef.current.contains(e.target as Node)) {
        setSlaOpen(false);
      }
      if (pipelineDropdownRef.current && !pipelineDropdownRef.current.contains(e.target as Node)) {
        setPipelineOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Fetch data
  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const buildBaseParams = () => {
      const params = new URLSearchParams({ dept: department });
      if (dateRange.start) params.set("from", toISODate(dateRange.start));
      if (dateRange.end) params.set("to", toISODate(dateRange.end));
      if (manager) params.set("manager", manager);
      if (selectedStatuses.length > 0) params.set("statuses", selectedStatuses.join(","));
      if (category) params.set("category", category);
      if (slaRange) params.set("sla", slaRange);
      if (pipeline && config.hasPipeline) params.set("pipeline", pipeline);
      return params;
    };

    const fetchData = async () => {
      setLoading(true);
      try {
        if (view === "conversions") {
          const params = buildBaseParams();
          params.set("view", "conversions");
          const res = await fetch(`/api/analytics/looker/data?${params}`, { signal: controller.signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const json = (await res.json()) as ApiResponse;
          setConvRows(json.rows as ConvRow[]);
          setManagers(json.filterOptions.managers);
          setData(null);
          setTltSummaryRows([]);
          setTltDetailRows([]);
        } else if (view === "tlt") {
          const sumParams = buildBaseParams();
          sumParams.set("view", "tlt_summary");
          sumParams.set("slice1", slice1);
          sumParams.set("slice2", slice2);
          sumParams.set("slice3", slice3);

          const detParams = buildBaseParams();
          detParams.set("view", "tlt_detail");
          detParams.set("limit", "100");
          detParams.set("offset", String(tltPage * 100));

          const [sumRes, detRes] = await Promise.all([
            fetch(`/api/analytics/looker/data?${sumParams}`, { signal: controller.signal }),
            fetch(`/api/analytics/looker/data?${detParams}`, { signal: controller.signal }),
          ]);
          if (!sumRes.ok || !detRes.ok) throw new Error("fetch error");
          const [sumJson, detJson] = await Promise.all([
            sumRes.json() as Promise<ApiResponse>,
            detRes.json() as Promise<ApiResponse>,
          ]);
          setTltSummaryRows(sumJson.rows as TltSummaryRow[]);
          setTltDetailRows(detJson.rows as TltDetailRow[]);
          setTltDetailTotal(detJson.total);
          setManagers(sumJson.filterOptions.managers);
          setData(null);
        } else {
          const params = buildBaseParams();
          params.set("view", view);
          const res = await fetch(`/api/analytics/looker/data?${params}`, {
            signal: controller.signal,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const json = (await res.json()) as ApiResponse;
          setData(json);
          setManagers(json.filterOptions.managers);
          setTltSummaryRows([]);
          setTltDetailRows([]);
          setConvRows([]);
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        console.error("[LookerTab] fetch error", err);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
    return () => controller.abort();
  }, [department, view, dateRange, manager, selectedStatuses, category, slaRange, pipeline, tltPage, slice1, slice2, slice3, config.hasPipeline]);

  // Fetch per-lead detail when a Cohorts row is expanded. Honours the same
  // active filters (date / status / category / sla / pipeline) so the
  // drilled-down list matches the parent row's cohort exactly.
  useEffect(() => {
    if (view !== "cohorts" || !expandedManager) {
      detailAbortRef.current?.abort();
      return;
    }
    if (detailAbortRef.current) detailAbortRef.current.abort();
    const controller = new AbortController();
    detailAbortRef.current = controller;

    const params = new URLSearchParams({ dept: department, view: "cohorts_detail", manager: expandedManager });
    if (dateRange.start) params.set("from", toISODate(dateRange.start));
    if (dateRange.end) params.set("to", toISODate(dateRange.end));
    if (selectedStatuses.length > 0) params.set("statuses", selectedStatuses.join(","));
    if (category) params.set("category", category);
    if (slaRange) params.set("sla", slaRange);
    if (pipeline && config.hasPipeline) params.set("pipeline", pipeline);
    params.set("limit", "200");

    setCohortDetailLoading(true);
    setCohortDetailError(null);

    fetch(`/api/analytics/looker/data?${params}`, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json: { rows?: CohortDetailRow[] }) => {
        setCohortDetailRows(json.rows ?? []);
      })
      .catch((err) => {
        if (err instanceof Error && err.name === "AbortError") return;
        setCohortDetailError(err instanceof Error ? err.message : String(err));
        setCohortDetailRows([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setCohortDetailLoading(false);
      });

    return () => controller.abort();
  }, [view, expandedManager, department, dateRange, selectedStatuses, category, slaRange, pipeline, config.hasPipeline]);

  const handleToggleManager = useCallback((m: string) => {
    setExpandedManager((prev) => (prev === m ? null : m));
  }, []);

  const setQuickRange = useCallback((days: number) => {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - (days - 1));
    setDateRange({ start, end });
    setTltPage(0);
  }, []);

  const toggleStatus = useCallback((status: string) => {
    setSelectedStatuses((prev) =>
      prev.includes(status) ? prev.filter((s) => s !== status) : [...prev, status],
    );
    setTltPage(0);
  }, []);

  const allCallsRows = (view === "all_calls" ? (data?.rows ?? []) : []) as AllCallsRow[];
  const cohortsRows = (view === "cohorts" ? (data?.rows ?? []) : []) as CohortsRow[];

  const activeSlaLabel = config.slaRanges.find((r) => r.value === slaRange)?.label;
  const activePipelineLabel = pipeline || undefined;

  const slice1Label = SLICE_OPTIONS.find((o) => o.col === slice1)?.label ?? slice1;
  const slice2Label = SLICE_OPTIONS.find((o) => o.col === slice2)?.label ?? slice2;
  const slice3Label = SLICE_OPTIONS.find((o) => o.col === slice3)?.label ?? slice3;

  const views: { key: View; label: string }[] = [
    { key: "all_calls", label: "Все звонки" },
    { key: "cohorts", label: "Когорты" },
    { key: "tlt", label: "TLT" },
    { key: "conversions", label: "Конверсии" },
  ];

  return (
    <div className="flex flex-col gap-4 fade-in flex-1 overflow-y-auto pb-6 scrollbar-hide">
      {/* Filter bar */}
      <div className="glass-panel rounded-2xl px-5 py-4 flex flex-col gap-3 border border-white/5">
        {/* Row 1 */}
        <div className="flex flex-wrap gap-2 items-center">
          <CalendarPicker
            mode="range"
            value={dateRange}
            onChange={(r) => { setDateRange(r); setTltPage(0); }}
            onClear={() => { setDateRange(makeDefaultRange()); setTltPage(0); }}
            minDate={minDate}
            maxDate={maxDate}
          />

          {([7, 14, 30, 90] as const).map((days) => (
            <button
              key={days}
              type="button"
              onClick={() => setQuickRange(days)}
              className="text-[10px] px-2.5 py-1.5 rounded-lg bg-slate-800/60 border border-white/10 text-slate-400 hover:text-white hover:bg-slate-700/60 transition-all"
            >
              {days}д
            </button>
          ))}

          {/* Manager select */}
          <select
            value={manager}
            onChange={(e) => { setManager(e.target.value); setTltPage(0); }}
            className="bg-slate-800/60 border border-white/10 rounded-xl px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-blue-500/50 transition-colors"
          >
            <option value="">Все менеджеры</option>
            {managers.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>

          {/* Category select */}
          <select
            value={category}
            onChange={(e) => { setCategory(e.target.value); setTltPage(0); }}
            className="bg-slate-800/60 border border-white/10 rounded-xl px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-blue-500/50 transition-colors"
          >
            <option value="">Все категории</option>
            {["A", "B", "C", "D", "E"].map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>

          {/* SLA dropdown */}
          {config.slaRanges.length > 0 && (
            <FilterDropdown
              label="SLA"
              activeLabel={activeSlaLabel}
              isActive={slaRange !== ""}
              open={slaOpen}
              onToggle={() => setSlaOpen((v) => !v)}
              dropdownRef={slaDropdownRef}
              accent="purple"
            >
              <DropdownItem active={slaRange === ""} onClick={() => { setSlaRange(""); setTltPage(0); setSlaOpen(false); }} accent="purple">
                Все SLA
              </DropdownItem>
              {config.slaRanges.map((r) => (
                <DropdownItem key={r.value} active={slaRange === r.value} onClick={() => { setSlaRange(r.value); setTltPage(0); setSlaOpen(false); }} accent="purple">
                  {r.label}
                </DropdownItem>
              ))}
            </FilterDropdown>
          )}

          {/* Pipeline dropdown (b2g only) */}
          {config.hasPipeline && (
            <FilterDropdown
              label="Воронка"
              activeLabel={activePipelineLabel}
              isActive={pipeline !== ""}
              open={pipelineOpen}
              onToggle={() => setPipelineOpen((v) => !v)}
              dropdownRef={pipelineDropdownRef}
            >
              <DropdownItem active={pipeline === ""} onClick={() => { setPipeline(""); setTltPage(0); setPipelineOpen(false); }}>
                Все воронки
              </DropdownItem>
              {config.pipelines.map((p) => (
                <DropdownItem key={p} active={pipeline === p} onClick={() => { setPipeline(p); setTltPage(0); setPipelineOpen(false); }}>
                  {p}
                </DropdownItem>
              ))}
            </FilterDropdown>
          )}
        </div>

        {/* Row 2: Statuses multi-select */}
        <div className="flex flex-wrap gap-2 items-center">
          <div className="relative" ref={statusDropdownRef}>
            <button
              type="button"
              onClick={() => setStatusOpen((v) => !v)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-semibold tracking-wide transition-all border ${
                selectedStatuses.length > 0
                  ? "bg-blue-500/20 text-blue-400 border-blue-500/30"
                  : "text-slate-400 hover:text-white border-white/10 bg-slate-800/60"
              }`}
            >
              {selectedStatuses.length > 0 ? `Статусы (${selectedStatuses.length})` : "Статусы"}
              <ChevronDown className={`w-3 h-3 transition-transform ${statusOpen ? "rotate-180" : ""}`} />
            </button>

            {statusOpen && (
              <div className="absolute top-full mt-2 left-0 bg-slate-900 border border-white/10 rounded-xl shadow-xl z-50 w-72 max-h-72 overflow-y-auto">
                <div className="p-2 border-b border-white/10">
                  <button
                    type="button"
                    onClick={() => { setSelectedStatuses([]); setTltPage(0); }}
                    className="text-[10px] text-slate-400 hover:text-white transition-colors px-2"
                  >
                    Снять все
                  </button>
                </div>
                <div className="p-1">
                  {config.statuses.map((s) => (
                    <label key={s} className="flex items-center gap-2 px-3 py-2 hover:bg-white/[0.04] rounded-lg cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedStatuses.includes(s)}
                        onChange={() => toggleStatus(s)}
                        className="w-3.5 h-3.5 accent-blue-500"
                      />
                      <span className="text-xs text-slate-300">{s}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>

          {selectedStatuses.length > 0 && (
            <button
              type="button"
              onClick={() => { setSelectedStatuses([]); setTltPage(0); }}
              className="text-[10px] text-slate-400 hover:text-red-400 transition-colors"
            >
              ✕ сбросить статусы
            </button>
          )}
        </div>

        {/* Row 3: TLT срез selectors */}
        {view === "tlt" && (
          <div className="flex flex-wrap gap-3 items-center pt-1 border-t border-white/5">
            <span className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">Срезы</span>
            {([1, 2, 3] as const).map((n) => {
              const current = n === 1 ? slice1 : n === 2 ? slice2 : slice3;
              const setter = n === 1 ? setSlice1 : n === 2 ? setSlice2 : setSlice3;
              return (
                <div key={n} className="flex items-center gap-1.5">
                  <span className="text-[10px] text-slate-500">Срез {n}:</span>
                  <select
                    value={current}
                    onChange={(e) => { setter(e.target.value as SliceCol); setTltPage(0); }}
                    className="bg-slate-800/60 border border-white/10 rounded-xl px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-blue-500/50 transition-colors"
                  >
                    {SLICE_OPTIONS.map((o) => (
                      <option key={o.col} value={o.col}>{o.label}</option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* View toggle */}
      <div className="flex items-center gap-1 px-1">
        {views.map(({ key, label }) => (
          <PillBtn key={key} active={view === key} onClick={() => { setView(key); setTltPage(0); }}>
            {label}
          </PillBtn>
        ))}
      </div>

      {/* Tables */}
      {view === "all_calls" && <AllCallsTable rows={allCallsRows} loading={loading} />}
      {view === "cohorts" && (
        <CohortsTable
          rows={cohortsRows}
          loading={loading}
          expandedManager={expandedManager}
          onToggleManager={handleToggleManager}
          detailRows={cohortDetailRows}
          detailLoading={cohortDetailLoading}
          detailError={cohortDetailError}
        />
      )}
      {view === "conversions" && <ConversionsSection rows={convRows} loading={loading} />}
      {view === "tlt" && (
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <p className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold px-1">TLT — сводная таблица</p>
            <TltSummaryTable
              rows={tltSummaryRows}
              loading={loading}
              slice1Label={slice1Label}
              slice2Label={slice2Label}
              slice3Label={slice3Label}
            />
          </div>
          <div className="flex flex-col gap-2">
            <p className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold px-1">TLT — детализация по лидам</p>
            <TltDetailTable
              rows={tltDetailRows}
              loading={loading}
              total={tltDetailTotal}
              page={tltPage}
              onPageChange={setTltPage}
            />
          </div>
        </div>
      )}
    </div>
  );
}
