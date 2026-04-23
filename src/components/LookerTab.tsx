"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Loader2, ExternalLink } from "lucide-react";
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

type View = "all_calls" | "cohorts" | "detail" | "tlt";

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
  total_duration_sec: number;
  avg_calls_per_lead: number | null;
  avg_sla_first_call_sec: number | null;
  total_sla_first_call_sec: number;
}

interface DetailRow {
  manager: string;
  lead_id: number;
  lead_created_at: string;
  sla_start: string | null;
  first_call_out_at: string | null;
  success_calls: number;
  total_calls: number;
  avg_duration_sec: number | null;
  sla_first_call_seconds: number | null;
  sla_first_call_calendar_seconds: number | null;
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

interface ApiResponse {
  view: string;
  rows: AllCallsRow[] | CohortsRow[] | DetailRow[] | TltSummaryRow[] | TltDetailRow[];
  total: number;
  filterOptions: { managers: string[] };
}

// ─── Formatters ─────────────────────────────────────────────────────────────

function fmtHMS(sec: number | null | undefined): string {
  if (sec == null) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
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

// ─── Totals helpers ──────────────────────────────────────────────────────────

function sumNum(rows: AllCallsRow[], key: keyof AllCallsRow): number {
  let total = 0;
  for (const r of rows) {
    const v = r[key];
    if (typeof v === "number") total += v;
  }
  return total;
}

function sumNumC(rows: CohortsRow[], key: keyof CohortsRow): number {
  let total = 0;
  for (const r of rows) {
    const v = r[key];
    if (typeof v === "number") total += v;
  }
  return total;
}

// ─── Tables ──────────────────────────────────────────────────────────────────

function AllCallsTable({ rows, loading }: { rows: AllCallsRow[]; loading: boolean }) {
  const colCount = 8;

  const totalCalls = sumNum(rows, "total_calls");
  const totalOut = sumNum(rows, "outgoing_calls");
  const totalIn = sumNum(rows, "incoming_calls");
  const totalMsg = sumNum(rows, "messages_sent");
  const totalSuccess = sumNum(rows, "success_calls");
  const totalDur = sumNum(rows, "total_duration_sec");
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
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={colCount} className="text-center py-16 text-slate-500 text-xs">
                  Нет данных за выбранный период
                </td>
              </tr>
            ) : (
              <>
                {rows.map((r, i) => (
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

function CohortsTable({ rows, loading }: { rows: CohortsRow[]; loading: boolean }) {
  const colCount = 9;

  const totalLeads = sumNumC(rows, "lead_count");
  const totalOut = sumNumC(rows, "outgoing_calls");
  const totalMsg = sumNumC(rows, "messages_sent");
  const totalDur = sumNumC(rows, "total_duration_sec");
  const totalSlaSum = sumNumC(rows, "total_sla_first_call_sec");
  const totalCalls = rows.reduce((acc, r) => {
    const calls = r.avg_calls_per_lead != null ? r.avg_calls_per_lead * r.lead_count : 0;
    return acc + calls;
  }, 0);
  const totalSucc = rows.reduce((acc, r) => {
    const pct = r.success_pct != null ? r.success_pct / 100 : 0;
    return acc + pct * (r.avg_calls_per_lead != null ? r.avg_calls_per_lead * r.lead_count : 0);
  }, 0);
  const totalPct = totalCalls > 0 ? Math.round((totalSucc / totalCalls) * 100) : null;
  const avgCallsPerLead = totalLeads > 0 ? Math.round((totalCalls / totalLeads) * 100) / 100 : null;
  const avgSla = rows.length > 0 ? Math.round(rows.reduce((a, r) => a + (r.avg_sla_first_call_sec ?? 0), 0) / rows.length) : null;

  return (
    <div className="glass-panel rounded-2xl overflow-hidden border border-white/5">
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="border-b border-white/10">
              {["Менеджер", "Лидов", "Исходящие", "Сообщений", "% успеха", "Время на линии", "Звонков/лид", "SLA первый (ср)", "SLA первый (итого)"].map((h) => (
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
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={colCount} className="text-center py-16 text-slate-500 text-xs">
                  Нет данных за выбранный период
                </td>
              </tr>
            ) : (
              <>
                {rows.map((r, i) => (
                  <tr key={i} className="border-t border-white/5 hover:bg-white/[0.03] transition-colors">
                    <td className="px-4 py-2.5 text-slate-200 whitespace-nowrap">{r.manager}</td>
                    <td className="px-4 py-2.5 text-slate-200">{fmtNum(r.lead_count)}</td>
                    <td className="px-4 py-2.5 text-slate-200">{fmtNum(r.outgoing_calls)}</td>
                    <td className="px-4 py-2.5 text-slate-200">{fmtNum(r.messages_sent)}</td>
                    <td className="px-4 py-2.5 text-slate-200">{fmtPct(r.success_pct)}</td>
                    <td className="px-4 py-2.5 text-slate-200 whitespace-nowrap">{fmtHMS(r.total_duration_sec)}</td>
                    <td className="px-4 py-2.5 text-slate-200">{r.avg_calls_per_lead != null ? r.avg_calls_per_lead : "—"}</td>
                    <td className="px-4 py-2.5 text-slate-200 whitespace-nowrap">{fmtHMS(r.avg_sla_first_call_sec)}</td>
                    <td className="px-4 py-2.5 text-slate-200 whitespace-nowrap">{fmtHMS(r.total_sla_first_call_sec)}</td>
                  </tr>
                ))}
                <tr className="border-t border-white/10 font-semibold bg-white/[0.04]">
                  <td className="px-4 py-2.5 text-slate-200">Итого</td>
                  <td className="px-4 py-2.5 text-slate-200">{fmtNum(totalLeads)}</td>
                  <td className="px-4 py-2.5 text-slate-200">{fmtNum(totalOut)}</td>
                  <td className="px-4 py-2.5 text-slate-200">{fmtNum(totalMsg)}</td>
                  <td className="px-4 py-2.5 text-slate-200">{fmtPct(totalPct)}</td>
                  <td className="px-4 py-2.5 text-slate-200 whitespace-nowrap">{fmtHMS(totalDur)}</td>
                  <td className="px-4 py-2.5 text-slate-200">{avgCallsPerLead != null ? avgCallsPerLead : "—"}</td>
                  <td className="px-4 py-2.5 text-slate-200 whitespace-nowrap">{fmtHMS(avgSla)}</td>
                  <td className="px-4 py-2.5 text-slate-200 whitespace-nowrap">{fmtHMS(totalSlaSum)}</td>
                </tr>
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DetailTable({
  rows,
  loading,
  total,
  page,
  onPageChange,
}: {
  rows: DetailRow[];
  loading: boolean;
  total: number;
  page: number;
  onPageChange: (p: number) => void;
}) {
  const colCount = 9;
  const PAGE_SIZE = 100;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex flex-col gap-2">
      <div className="glass-panel rounded-2xl overflow-hidden border border-white/5">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-white/10">
                {["Менеджер", "Лид", "Успешных", "Всего", "TLT (ср)", "SLA звонок", "SLA тотал", "Дата лида", "Первый исх."].map((h) => (
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
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={colCount} className="text-center py-16 text-slate-500 text-xs">
                    Нет данных за выбранный период
                  </td>
                </tr>
              ) : (
                rows.map((r, i) => (
                  <tr key={i} className="border-t border-white/5 hover:bg-white/[0.03] transition-colors">
                    <td className="px-4 py-2.5 text-slate-200 whitespace-nowrap">{r.manager}</td>
                    <td className="px-4 py-2.5 text-slate-200">
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
                    <td className="px-4 py-2.5 text-slate-200">{fmtNum(r.success_calls)}</td>
                    <td className="px-4 py-2.5 text-slate-200">{fmtNum(r.total_calls)}</td>
                    <td className="px-4 py-2.5 text-slate-200 whitespace-nowrap">{fmtHMS(r.avg_duration_sec)}</td>
                    <td className="px-4 py-2.5 text-slate-200 whitespace-nowrap">{fmtHMS(r.sla_first_call_seconds)}</td>
                    <td className="px-4 py-2.5 text-slate-200 whitespace-nowrap">{fmtHMS(r.sla_first_call_calendar_seconds)}</td>
                    <td className="px-4 py-2.5 text-slate-400 whitespace-nowrap">{fmtDate(r.lead_created_at)}</td>
                    <td className="px-4 py-2.5 text-slate-400 whitespace-nowrap">{fmtDate(r.first_call_out_at)}</td>
                  </tr>
                ))
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
          <span className="text-xs text-slate-400">
            Стр {page + 1} / {totalPages}
          </span>
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

  const totalLeads = rows.reduce((s, r) => s + Number(r.lead_count), 0);
  const totalOut = rows.reduce((s, r) => s + Number(r.outgoing_calls), 0);
  const totalMsg = rows.reduce((s, r) => s + Number(r.messages_sent), 0);
  const totalComms = rows.reduce((s, r) => s + Number(r.total_comms), 0);
  const tltRows = rows.filter((r) => r.avg_tlt != null);
  const totalAvgTlt = tltRows.length > 0 ? Math.round(tltRows.reduce((s, r) => s + Number(r.avg_tlt), 0) / tltRows.length) : null;
  const gapRows = rows.filter((r) => r.avg_gap_sec != null);
  const totalAvgGap = gapRows.length > 0 ? Math.round(gapRows.reduce((s, r) => s + Number(r.avg_gap_sec), 0) / gapRows.length) : null;

  return (
    <div className="glass-panel rounded-2xl overflow-hidden border border-white/5">
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="border-b border-white/10">
              <th className="px-4 py-3 text-[10px] uppercase tracking-widest text-slate-400 font-semibold whitespace-nowrap">
                {slice1Label}
              </th>
              <th className="px-4 py-3 text-[10px] uppercase tracking-widest text-slate-400 font-semibold whitespace-nowrap">
                {slice2Label}
              </th>
              <th className="px-4 py-3 text-[10px] uppercase tracking-widest text-slate-400 font-semibold whitespace-nowrap">
                {slice3Label}
              </th>
              {["Кол-во лидов", "TLT средний", "Ср. время между звонками", "Исходящие", "Сообщений", "Всего коммуникаций"].map((h) => (
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
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={colCount} className="text-center py-16 text-slate-500 text-xs">
                  Нет данных за выбранный период
                </td>
              </tr>
            ) : (
              <>
                {rows.map((r, i) => (
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

  const totalOut = rows.reduce((s, r) => s + Number(r.outgoing_calls), 0);
  const totalMsg = rows.reduce((s, r) => s + Number(r.messages_sent), 0);
  const totalComms = rows.reduce((s, r) => s + Number(r.total_comms), 0);
  const tltRows = rows.filter((r) => r.tlt != null);
  const totalAvgTlt = tltRows.length > 0 ? Math.round(tltRows.reduce((s, r) => s + Number(r.tlt), 0) / tltRows.length) : null;
  const gapRows = rows.filter((r) => r.avg_gap_sec != null);
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
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={colCount} className="text-center py-16 text-slate-500 text-xs">
                    Нет данных за выбранный период
                  </td>
                </tr>
              ) : (
                <>
                  {rows.map((r, i) => (
                    <tr key={i} className="border-t border-white/5 hover:bg-white/[0.03] transition-colors">
                      <td className="px-4 py-2.5 text-slate-200 whitespace-nowrap">{r.manager ?? "—"}</td>
                      <td className="px-4 py-2.5 text-slate-300 whitespace-nowrap max-w-[180px] truncate">{r.current_status ?? "—"}</td>
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
          <span className="text-xs text-slate-400">
            Стр {page + 1} / {totalPages}
          </span>
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
  const [page, setPage] = useState(0);
  const [tltPage, setTltPage] = useState(0);
  const [slice1, setSlice1] = useState<SliceCol>("manager");
  const [slice2, setSlice2] = useState<SliceCol>("utm_source");
  const [slice3, setSlice3] = useState<SliceCol>("status");

  const [data, setData] = useState<ApiResponse | null>(null);
  const [tltSummaryRows, setTltSummaryRows] = useState<TltSummaryRow[]>([]);
  const [tltDetailRows, setTltDetailRows] = useState<TltDetailRow[]>([]);
  const [tltDetailTotal, setTltDetailTotal] = useState(0);
  const [managers, setManagers] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);

  const statusDropdownRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Reset all filters when department changes
  useEffect(() => {
    setManager("");
    setSelectedStatuses([]);
    setCategory("");
    setSlaRange("");
    setPipeline("");
    setPage(0);
    setTltPage(0);
    setData(null);
    setTltSummaryRows([]);
    setTltDetailRows([]);
  }, [department]);

  // Close status dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (statusDropdownRef.current && !statusDropdownRef.current.contains(e.target as Node)) {
        setStatusOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Fetch data on any filter/view/page/department change
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
        if (view === "tlt") {
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
          if (view === "detail") {
            params.set("limit", "100");
            params.set("offset", String(page * 100));
          }
          const res = await fetch(`/api/analytics/looker/data?${params}`, {
            signal: controller.signal,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const json = (await res.json()) as ApiResponse;
          setData(json);
          setManagers(json.filterOptions.managers);
          setTltSummaryRows([]);
          setTltDetailRows([]);
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
  }, [department, view, dateRange, manager, selectedStatuses, category, slaRange, pipeline, page, tltPage, slice1, slice2, slice3, config.hasPipeline]);

  const setQuickRange = useCallback((days: number) => {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - (days - 1));
    setDateRange({ start, end });
    setPage(0);
    setTltPage(0);
  }, []);

  const toggleStatus = useCallback((status: string) => {
    setSelectedStatuses((prev) =>
      prev.includes(status) ? prev.filter((s) => s !== status) : [...prev, status],
    );
    setPage(0);
    setTltPage(0);
  }, []);

  const allCallsRows = (view === "all_calls" ? data?.rows : []) as AllCallsRow[];
  const cohortsRows = (view === "cohorts" ? data?.rows : []) as CohortsRow[];
  const detailRows = (view === "detail" ? data?.rows : []) as DetailRow[];

  const slice1Label = SLICE_OPTIONS.find((o) => o.col === slice1)?.label ?? slice1;
  const slice2Label = SLICE_OPTIONS.find((o) => o.col === slice2)?.label ?? slice2;
  const slice3Label = SLICE_OPTIONS.find((o) => o.col === slice3)?.label ?? slice3;

  const views: { key: View; label: string }[] = [
    { key: "all_calls", label: "Все звонки" },
    { key: "cohorts", label: "Когорты" },
    { key: "detail", label: "Детализация" },
    { key: "tlt", label: "TLT" },
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
            onChange={(r) => {
              setDateRange(r);
              setPage(0);
              setTltPage(0);
            }}
            onClear={() => {
              setDateRange(makeDefaultRange());
              setPage(0);
              setTltPage(0);
            }}
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
            onChange={(e) => {
              setManager(e.target.value);
              setPage(0);
              setTltPage(0);
            }}
            className="bg-slate-800/60 border border-white/10 rounded-xl px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-blue-500/50 transition-colors"
          >
            <option value="">Все менеджеры</option>
            {managers.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>

          {/* Category select */}
          <select
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              setPage(0);
              setTltPage(0);
            }}
            className="bg-slate-800/60 border border-white/10 rounded-xl px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-blue-500/50 transition-colors"
          >
            <option value="">Все категории</option>
            {["A", "B", "C", "D", "E"].map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>

          {/* SLA range pills */}
          {config.slaRanges.length > 0 && (
            <div className="flex items-center gap-1">
              <PillBtn active={slaRange === ""} onClick={() => { setSlaRange(""); setPage(0); setTltPage(0); }} accent="purple">
                Все SLA
              </PillBtn>
              {config.slaRanges.map((r) => (
                <PillBtn
                  key={r.value}
                  active={slaRange === r.value}
                  onClick={() => { setSlaRange(r.value); setPage(0); setTltPage(0); }}
                  accent="purple"
                >
                  {r.label}
                </PillBtn>
              ))}
            </div>
          )}

          {/* Pipeline pills (b2g only) */}
          {config.hasPipeline && (
            <div className="flex items-center gap-1">
              <PillBtn active={pipeline === ""} onClick={() => { setPipeline(""); setPage(0); setTltPage(0); }}>
                Все воронки
              </PillBtn>
              {config.pipelines.map((p) => (
                <PillBtn
                  key={p}
                  active={pipeline === p}
                  onClick={() => { setPipeline(p); setPage(0); setTltPage(0); }}
                >
                  {p}
                </PillBtn>
              ))}
            </div>
          )}
        </div>

        {/* Row 2: Statuses multi-select */}
        <div className="flex flex-wrap gap-2 items-center">
          <div className="relative" ref={statusDropdownRef}>
            <button
              type="button"
              onClick={() => setStatusOpen((v) => !v)}
              className={`px-3 py-1.5 rounded-xl text-[11px] font-semibold tracking-wide transition-all border ${
                selectedStatuses.length > 0
                  ? "bg-blue-500/20 text-blue-400 border-blue-500/30"
                  : "text-slate-400 hover:text-white border-white/10 bg-slate-800/60"
              }`}
            >
              {selectedStatuses.length > 0 ? `Статусы (${selectedStatuses.length})` : "Статусы"}
            </button>

            {statusOpen && (
              <div className="absolute top-full mt-2 left-0 bg-slate-900 border border-white/10 rounded-xl shadow-xl z-50 w-72 max-h-72 overflow-y-auto">
                <div className="p-2 border-b border-white/10">
                  <button
                    type="button"
                    onClick={() => { setSelectedStatuses([]); setPage(0); setTltPage(0); }}
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
              onClick={() => { setSelectedStatuses([]); setPage(0); setTltPage(0); }}
              className="text-[10px] text-slate-400 hover:text-red-400 transition-colors"
            >
              ✕ сбросить статусы
            </button>
          )}
        </div>

        {/* Row 3: TLT срез selectors (visible only in TLT view) */}
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
          <PillBtn key={key} active={view === key} onClick={() => { setView(key); setPage(0); setTltPage(0); }}>
            {label}
          </PillBtn>
        ))}
      </div>

      {/* Tables */}
      {view === "all_calls" && <AllCallsTable rows={allCallsRows} loading={loading} />}
      {view === "cohorts" && <CohortsTable rows={cohortsRows} loading={loading} />}
      {view === "detail" && (
        <DetailTable
          rows={detailRows}
          loading={loading}
          total={data?.total ?? 0}
          page={page}
          onPageChange={setPage}
        />
      )}
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
