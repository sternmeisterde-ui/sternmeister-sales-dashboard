"use client";

// Вкладка «Жалобы» — реестр жалоб менеджеров на оценки ОКК/ролевок (обе
// линии). Данные — GET /api/complaints (реестр D1 complaints, агрегат двух
// механизмов подачи); снимки оценок «до/после» — GET /api/complaints/[id]/eval,
// рендер — общий EvalDetailView (тот же вид, что «Детализация оценок» в
// Аналитике b2b). Менеджер видит только свои жалобы (гейт на сервере),
// admin — весь отдел + фильтры по статусу/менеджерам.

import { Fragment, useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, Loader2, MessageSquareWarning, RefreshCw, X } from "lucide-react";
import CalendarPicker, { type DateRange } from "@/components/CalendarPicker";
import DinoLoader from "@/components/DinoLoader";
import { EvalDetailView, type EvalDetailBlock, type CallMeta } from "@/components/eval/EvalDetail";
import { berlinCivilDate, fmtLocalDate, todayBerlinDate } from "@/lib/utils/date";

interface ComplaintRow {
  id: string;
  source: "error_report" | "bug_report";
  department: "b2g" | "b2b";
  managerName: string | null;
  masterManagerId: string | null;
  callId: string | null;
  callSource: "okk" | "ai" | null;
  text: string;
  filedAt: string;
  scoreBefore: number | null;
  hasEvalBefore: boolean;
  status: "new" | "in_review" | "resolved" | "rejected" | "not_complaint";
  verdict: "valid" | "partial" | "invalid" | null;
  decision: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  scoreAfter: number | null;
  hasEvalAfter: boolean;
}

interface ApiResponse {
  complaints: ComplaintRow[];
  allManagers: { id: string; name: string }[];
}

// Замороженный снимок (FrozenEvalPayload из src/lib/eval/snapshot.ts) —
// ровно props EvalDetailView.
interface FrozenPayload {
  v: number;
  blocks: EvalDetailBlock[];
  meta?: CallMeta;
  kommoUrl?: string;
  callDuration: string;
  manager: string;
  score: number;
  totalMaxScore?: number;
  totalRawScore?: number;
  snapshotAt: string;
}

const STATUS_META: Record<ComplaintRow["status"], { label: string; cls: string }> = {
  new: { label: "Новая", cls: "bg-slate-500/20 text-slate-300" },
  in_review: { label: "В работе", cls: "bg-blue-500/20 text-blue-300" },
  resolved: { label: "Рассмотрена", cls: "bg-emerald-500/20 text-emerald-300" },
  rejected: { label: "Отклонена", cls: "bg-rose-500/20 text-rose-300" },
  not_complaint: { label: "Не жалоба", cls: "bg-slate-700/40 text-slate-500" },
};

// Пороги как в бейдже модалки звонка (CallMediaModal): ≥66 зелёный, ≥41 жёлтый.
function scoreBadgeCls(score: number): string {
  if (score >= 66) return "bg-emerald-500/15 text-emerald-400";
  if (score >= 41) return "bg-amber-500/15 text-amber-400";
  return "bg-rose-500/15 text-rose-400";
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ru-RU", {
    timeZone: "Europe/Berlin",
    day: "2-digit", month: "2-digit", year: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

function sourceLabel(row: ComplaintRow): string {
  if (row.callSource === "ai") return "ролевка";
  if (row.callSource === "okk") return "звонок ОКК";
  return "без звонка";
}

// Реестр ведётся с 1 августа 2026 (см. COMPLAINTS_SINCE на сервере).
function defaultRange(): DateRange {
  return { start: berlinCivilDate("2026-08-01"), end: todayBerlinDate() };
}

// Мультивыбор менеджеров: дропдаун с чекбоксами (копия паттерна из
// AnalyticsTab). Пустой выбор = «Все менеджеры».
function ManagerMultiSelect({ managers, selected, onChange }: {
  managers: { id: string; name: string }[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const label =
    selected.length === 0 ? "Все менеджеры"
    : selected.length === 1 ? (managers.find((m) => m.id === selected[0])?.name ?? "1 выбран")
    : `${selected.length} менеджеров`;
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 bg-slate-800/50 border border-white/10 rounded-xl px-3 py-1.5 text-[11px] text-slate-300 hover:border-blue-500/40 focus:outline-none max-w-[190px]">
        <span className="truncate">{label}</span>
        <ChevronDown className="w-3 h-3 text-slate-500 shrink-0" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute z-50 mt-1 left-0 w-60 max-h-72 overflow-y-auto bg-slate-900 rounded-xl border border-white/10 p-1 shadow-2xl">
            <button onClick={() => onChange([])}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-white/5 text-left">
              <span className={`text-[11px] ${selected.length === 0 ? "text-blue-300 font-semibold" : "text-slate-400"}`}>Все менеджеры</span>
            </button>
            {managers.map((m) => {
              const on = selected.includes(m.id);
              return (
                <button key={m.id} onClick={() => toggle(m.id)}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-white/5 text-left">
                  <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${on ? "bg-blue-500 border-blue-500" : "border-white/20"}`}>
                    {on && <Check className="w-2.5 h-2.5 text-white" />}
                  </span>
                  <span className="truncate text-[11px] text-slate-300">{m.name}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// Модалка замороженного снимка оценки: тот же chrome, что «Оценки» в
// CallMediaModal (max-w-6xl, Esc), но данные — из jsonb-снимка жалобы,
// а не из живой оценки (живая могла быть перезаписана/удалена).
function FrozenEvalModal({ complaintId, phase, title, onClose }: {
  complaintId: string;
  phase: "before" | "after";
  title: string;
  onClose: () => void;
}) {
  const [payload, setPayload] = useState<FrozenPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/complaints/${complaintId}/eval?phase=${phase}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j.payload) setPayload(j.payload as FrozenPayload);
        else setError(j.error || "Снимок недоступен");
      })
      .catch(() => { if (!cancelled) setError("Ошибка загрузки"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [complaintId, phase]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 sm:pl-56" onClick={onClose}>
      <div
        className="glass-panel rounded-2xl border border-white/10 w-full max-w-6xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/5">
          <div className="min-w-0">
            <div className="text-sm font-bold text-slate-200 truncate">{title}</div>
            {payload && (
              <div className="text-[11px] text-slate-500">
                {payload.manager} · снимок от {fmtDateTime(payload.snapshotAt)}
              </div>
            )}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {payload && (
              <span className={`px-2.5 py-1 rounded-lg text-sm font-black ${scoreBadgeCls(payload.score)}`} title="Оценка звонка в снимке">
                {payload.score}%
              </span>
            )}
            <button onClick={onClose} className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-white/5" title="Закрыть">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="p-5 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-slate-500"><Loader2 className="w-5 h-5 animate-spin" /></div>
          ) : error ? (
            <div className="py-10 text-center text-rose-400 text-sm">{error}</div>
          ) : payload ? (
            <EvalDetailView
              blocks={payload.blocks}
              meta={payload.meta}
              kommoUrl={payload.kommoUrl}
              duration={payload.callDuration}
              manager={payload.manager}
              score={payload.score}
              totalMaxScore={payload.totalMaxScore}
              totalRawScore={payload.totalRawScore}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

// Бейдж оценки в таблице: кликабелен, только если есть снимок детализации.
function ScoreCell({ score, hasEval, onOpen }: {
  score: number | null;
  hasEval: boolean;
  onOpen: () => void;
}) {
  if (score == null && !hasEval) return <span className="text-slate-600">—</span>;
  const badge = (
    <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-bold ${score != null ? scoreBadgeCls(score) : "bg-slate-700/40 text-slate-400"}`}>
      {score != null ? `${score}%` : "…"}
    </span>
  );
  if (!hasEval) {
    return <span title="Детализация недоступна (звонок удалён или оценки ещё не было)">{badge}</span>;
  }
  return (
    <button onClick={onOpen} className="hover:opacity-75 transition-opacity" title="Открыть детализацию оценки">
      {badge}
    </button>
  );
}

// Ручного редактирования решений в UI нет намеренно: жалобы разбирает
// Claude-адъюдикатор в OKK-репо и постит итоги batch'ем в
// POST /api/complaints/resolve — вкладка только отображает.
export default function ComplaintsTab({ department, isAdmin }: {
  department: "b2g" | "b2b";
  isAdmin: boolean;
}) {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<DateRange>(defaultRange);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [managerIds, setManagerIds] = useState<string[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [modal, setModal] = useState<{ id: string; phase: "before" | "after"; title: string } | null>(null);

  const load = useCallback(async (r: DateRange, status: string | null, mgrs: string[]) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ department });
      if (r.start) params.set("from", fmtLocalDate(r.start));
      if (r.end) params.set("to", fmtLocalDate(r.end));
      if (status) params.set("status", status);
      if (mgrs.length) params.set("managers", mgrs.join(","));
      const res = await fetch(`/api/complaints?${params}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as ApiResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [department]);

  useEffect(() => {
    load(range, statusFilter, managerIds);
    // Перезагрузка только по смене фильтров/отдела; range меняется через
    // onRangeChange ниже (там же load), чтобы не дёргать API на полувыборе.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [department, statusFilter, managerIds]);

  const onRangeChange = (r: DateRange) => {
    setRange(r);
    if (r.start && r.end) load(r, statusFilter, managerIds);
  };

  const rows = data?.complaints ?? [];

  const statusChips: Array<{ key: string | null; label: string }> = [
    { key: null, label: "Все" },
    { key: "new", label: "Новая" },
    { key: "in_review", label: "В работе" },
    { key: "resolved", label: "Рассмотрена" },
    { key: "rejected", label: "Отклонена" },
    ...(isAdmin ? [{ key: "not_complaint" as string | null, label: "Не жалоба" }] : []),
  ];

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-24">
        <DinoLoader />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 fade-in">
      {/* Заголовок + фильтры */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 text-slate-200">
          <MessageSquareWarning className="w-5 h-5 text-blue-400" />
          <span className="text-base font-semibold">Жалобы</span>
        </div>

        <CalendarPicker
          mode="range"
          value={range}
          onChange={onRangeChange}
          onClear={() => onRangeChange(defaultRange())}
          maxDate={todayBerlinDate()}
        />

        {isAdmin && (
          <ManagerMultiSelect
            managers={data?.allManagers ?? []}
            selected={managerIds}
            onChange={setManagerIds}
          />
        )}

        <button
          onClick={() => load(range, statusFilter, managerIds)}
          disabled={loading}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-slate-900/60 px-3 py-1.5 text-xs text-slate-300 hover:border-white/20 disabled:opacity-50"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Обновить
        </button>
      </div>

      {/* Статус-чипы */}
      <div className="flex flex-wrap items-center gap-1.5">
        {statusChips.map((c) => (
          <button
            key={c.key ?? "all"}
            onClick={() => setStatusFilter(c.key)}
            className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition-colors ${
              statusFilter === c.key
                ? "bg-blue-500/20 text-blue-300 border-blue-500/40"
                : "bg-slate-900/40 text-slate-400 border-white/10 hover:border-white/20"
            }`}
          >
            {c.label}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-slate-500">{rows.length} жалоб</span>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          Не удалось загрузить жалобы: {error}
        </div>
      )}

      {/* Таблица */}
      <div className="max-h-[75vh] overflow-y-auto overflow-x-auto rounded-lg border border-white/10">
        <table className="w-full text-sm">
          <thead
            className="sticky top-0 z-10"
            style={{ backgroundColor: "rgb(15, 23, 42)", boxShadow: "0 2px 8px rgba(0,0,0,0.4)" }}
          >
            <tr className="border-b border-white/10 text-left text-xs text-slate-400">
              <th className="px-3 py-2 font-medium whitespace-nowrap">Подана</th>
              <th className="px-3 py-2 font-medium">Менеджер</th>
              <th className="px-3 py-2 font-medium min-w-[260px]">Текст жалобы</th>
              <th className="px-3 py-2 font-medium whitespace-nowrap" title="Оценка ОКК на момент подачи жалобы (заморожена)">Оценка до</th>
              <th className="px-3 py-2 font-medium">Статус</th>
              <th className="px-3 py-2 font-medium whitespace-nowrap">Рассмотрена</th>
              <th className="px-3 py-2 font-medium min-w-[220px]">Решение</th>
              <th className="px-3 py-2 font-medium whitespace-nowrap" title="Оценка ОКК после рассмотрения (заморожена в момент решения)">Оценка после</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-xs text-slate-500">
                  Жалоб за период нет.
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const expanded = expandedId === row.id;
                const st = STATUS_META[row.status];
                return (
                  <Fragment key={row.id}>
                  <tr className="border-b border-white/5 bg-slate-900/30 align-top">
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-400">{fmtDateTime(row.filedAt)}</td>
                    <td className="px-3 py-2">
                      <div className="text-slate-200 text-xs font-semibold whitespace-nowrap">{row.managerName || "—"}</div>
                      <div className="text-[10px] text-slate-500">{sourceLabel(row)}</div>
                    </td>
                    <td className="px-3 py-2">
                      <button
                        onClick={() => setExpandedId(expanded ? null : row.id)}
                        className={`text-left text-xs text-slate-300 leading-relaxed whitespace-pre-wrap ${expanded ? "" : "line-clamp-2"}`}
                        title={expanded ? "Свернуть" : "Развернуть"}
                      >
                        {row.text}
                      </button>
                    </td>
                    <td className="px-3 py-2">
                      <ScoreCell
                        score={row.scoreBefore}
                        hasEval={row.hasEvalBefore}
                        onOpen={() => setModal({ id: row.id, phase: "before", title: "Оценка на момент подачи жалобы" })}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap ${st.cls}`}>{st.label}</span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-400">
                      {row.resolvedAt ? fmtDateTime(row.resolvedAt) : "—"}
                    </td>
                    <td className="px-3 py-2">
                      {row.decision ? (
                        <span className={`block text-xs text-slate-300 leading-relaxed whitespace-pre-wrap ${expanded ? "" : "line-clamp-2"}`}>
                          {row.decision}
                        </span>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <ScoreCell
                        score={row.scoreAfter}
                        hasEval={row.hasEvalAfter}
                        onOpen={() => setModal({ id: row.id, phase: "after", title: "Оценка после рассмотрения" })}
                      />
                    </td>
                  </tr>
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {modal && (
        <FrozenEvalModal
          complaintId={modal.id}
          phase={modal.phase}
          title={modal.title}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
