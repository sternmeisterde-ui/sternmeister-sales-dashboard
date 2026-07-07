"use client";

/**
 * Вкладка «Регламент» (b2g) — зеркало Looker-отчёта «Sternmeister Госники V7».
 * ТЗ 23 + справочник 23a в dev_docs/specs/. Sub-view'ы повторяют страницы
 * отчёта; данные — /api/reglament?view=…
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, ShieldCheck } from "lucide-react";
import CalendarPicker, { type DateRange } from "@/components/CalendarPicker";
import DinoLoader from "@/components/DinoLoader";
import { berlinCivilDate, fmtLocalDate, todayBerlinDate, todayCivil } from "@/lib/utils/date";
import {
  FUNNEL_LABELS,
  FUNNEL_PIPELINES,
  metricColor,
  NAME_RED_BELOW,
  orderStages,
  UNIT_LABELS,
  type FunnelKey,
  type MetricColor,
} from "@/lib/reglament/norms";

// ─── Типы ответов API ───────────────────────────────────────────────

interface AvgSummaryRow {
  pipeline: string;
  status: string;
  responsible: string;
  stays: number;
  avgSeconds: number;
}
interface AvgDetailRow {
  leadId: number;
  pipeline: string;
  status: string;
  enterAt: string; // "YYYY-MM-DD HH:MM:SS" Berlin
  exitAt: string | null;
  seconds: number;
  responsible: string;
}

interface SlaRow {
  leadId: number;
  manager: string;
  enterAt: string;
  exitAt: string | null;
  workMinutes: number;
  /** null = лид ещё на этапе и в пределах норматива («рано судить»). */
  ok: boolean | null;
}

type SubView = "summary" | "sla" | "stages" | "tlt" | "touches" | "tasks" | "avg";

const SUB_VIEWS: { id: SubView; label: string }[] = [
  { id: "summary", label: "Сводка" },
  { id: "sla", label: "SLA" },
  { id: "stages", label: "Этапы" },
  { id: "tlt", label: "TLT-GAP" },
  { id: "touches", label: "Касания" },
  { id: "tasks", label: "Задачи" },
  { id: "avg", label: "Среднее время" },
];

// ─── Утилиты отображения ────────────────────────────────────────────

/** Секунды → "HH:MM:SS", часы без ограничения (525:51:26 как в Looker). */
function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
}

/** "YYYY-MM-DD HH:MM:SS" (Berlin) → "DD.MM.YYYY, HH:MM:SS". */
function fmtBerlin(ts: string | null): string {
  if (!ts) return "—";
  return `${ts.slice(8, 10)}.${ts.slice(5, 7)}.${ts.slice(0, 4)}, ${ts.slice(11)}`;
}

/** Дефолтный период — текущий месяц (как «Сбросить фильтр» в Looker). */
function defaultRange(): DateRange {
  const today = todayCivil();
  return { start: berlinCivilDate(`${today.slice(0, 7)}-01`), end: todayBerlinDate() };
}

function funnelOfPipeline(pipeline: string): FunnelKey | null {
  if (pipeline === FUNNEL_PIPELINES.gos) return "gos";
  if (pipeline === FUNNEL_PIPELINES.berater) return "berater";
  return null;
}

async function fetchView<T>(view: string, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams({ view, ...params });
  const res = await fetch(`/api/reglament?${qs}`, { cache: "no-store" });
  if (res.status === 403) {
    // Протухшая сессия проходит edge-middleware (там только наличие cookie),
    // но роут отдаёт 403 — подскажем перелогин вместо загадочного HTTP 403.
    throw new Error("нет доступа — сессия истекла? Обновите страницу (F5)");
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

const thCls = "px-3 py-2 font-medium whitespace-nowrap";
const theadStyle = {
  backgroundColor: "rgb(15, 23, 42)",
  boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
} as const;

// ─── Общий хук детальных view (пагинация + фильтры) ─────────────────

interface DetailState<R> {
  data: {
    total: number;
    okCount?: number;
    /** Знаменатель «в нормативе»: только завершённые проверки. */
    countedCount?: number;
    avgSeconds?: number | null;
    managers?: string[];
    rows: R[];
  } | null;
  loading: boolean;
  error: string | null;
  page: number;
  setPage: (fn: (p: number) => number) => void;
  manager: string;
  setManager: (m: string) => void;
  leadId: string;
  setLeadId: (v: string) => void;
  funnelFilter: "" | FunnelKey;
  setFunnelFilter: (f: "" | FunnelKey) => void;
}

const PAGE_SIZE = 100;

function useDetailData<R>(view: string, range: DateRange, opts?: { funnelAware?: boolean }): DetailState<R> {
  const [data, setData] = useState<DetailState<R>["data"]>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPageRaw] = useState(0);
  const [manager, setManagerRaw] = useState("");
  const [leadId, setLeadIdRaw] = useState("");
  const [funnelFilter, setFunnelFilterRaw] = useState<"" | FunnelKey>("");

  // Сужение периода со страницы N > 1 иначе даёт offset за концом выборки:
  // сервер вернёт пустую страницу и total=0 — «данных нет», хотя они есть.
  const rangeKey = `${fmtLocalDate(range.start ?? todayBerlinDate())}|${fmtLocalDate(range.end ?? range.start ?? todayBerlinDate())}`;
  useEffect(() => {
    setPageRaw(0);
  }, [rangeKey]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      const params: Record<string, string> = {
        from: fmtLocalDate(range.start ?? todayBerlinDate()),
        to: fmtLocalDate(range.end ?? range.start ?? todayBerlinDate()),
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      };
      if (manager) params.manager = manager;
      if (/^\d+$/.test(leadId.trim())) params.leadId = leadId.trim();
      if (opts?.funnelAware && funnelFilter) params.funnel = funnelFilter;
      try {
        const d = await fetchView<NonNullable<DetailState<R>["data"]>>(view, params);
        if (!cancelled) setData(d);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, range, page, manager, leadId, funnelFilter]);

  return {
    data,
    loading,
    error,
    page,
    setPage: (fn) => setPageRaw(fn),
    manager,
    setManager: (m) => {
      setManagerRaw(m);
      setPageRaw(0);
    },
    leadId,
    setLeadId: (v) => {
      setLeadIdRaw(v);
      setPageRaw(0);
    },
    funnelFilter,
    setFunnelFilter: (f) => {
      setFunnelFilterRaw(f);
      setPageRaw(0);
    },
  };
}

/** Панель фильтров/пагинации детальных view. Дропдаун менеджеров — из
 *  серверного полного списка (страница выдачи содержит не все имена). */
function DetailToolbar<R>({
  st,
  managers,
  funnelAware,
  hint,
}: {
  st: DetailState<R>;
  managers?: string[];
  funnelAware?: boolean;
  hint?: string;
}) {
  const total = st.data?.total ?? 0;
  const okCount = st.data?.okCount;
  const managerOptions = st.data?.managers ?? managers ?? [];
  return (
    <div className="flex flex-wrap items-center gap-2">
      {funnelAware && (
        <select
          value={st.funnelFilter}
          onChange={(e) => st.setFunnelFilter(e.target.value as "" | FunnelKey)}
          className="rounded-lg border border-white/10 bg-slate-900/60 px-2 py-1.5 text-xs text-slate-300"
        >
          <option value="">Обе воронки</option>
          <option value="gos">{FUNNEL_PIPELINES.gos}</option>
          <option value="berater">{FUNNEL_PIPELINES.berater}</option>
        </select>
      )}
      <select
        value={st.manager}
        onChange={(e) => st.setManager(e.target.value)}
        className="rounded-lg border border-white/10 bg-slate-900/60 px-2 py-1.5 text-xs text-slate-300"
      >
        <option value="">Все менеджеры</option>
        {st.manager && !managerOptions.includes(st.manager) && (
          <option value={st.manager}>{st.manager}</option>
        )}
        {managerOptions.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      <input
        value={st.leadId}
        onChange={(e) => st.setLeadId(e.target.value)}
        placeholder="id сделки"
        className="w-28 rounded-lg border border-white/10 bg-slate-900/60 px-2 py-1.5 text-xs text-slate-300 placeholder:text-slate-600"
      />
      {hint && <span className="text-[11px] text-slate-500">{hint}</span>}
      {okCount != null && (st.data?.countedCount ?? total) > 0 && (
        <span
          className="rounded bg-blue-500/15 px-2 py-0.5 text-[11px] text-blue-300"
          title="Считаются только завершённые проверки; открытые «ещё в этапе» не судятся (кроме уже нарушивших SLA)"
        >
          в нормативе {Math.round((okCount / (st.data?.countedCount ?? total)) * 100)}% ({okCount}/
          {st.data?.countedCount ?? total})
        </span>
      )}
      <span className="ml-auto text-[11px] text-slate-500">
        {total > 0
          ? `${st.page * PAGE_SIZE + 1}–${Math.min((st.page + 1) * PAGE_SIZE, total)} / ${total}`
          : "0"}
      </span>
      <button
        disabled={st.page === 0}
        onClick={() => st.setPage((p) => Math.max(0, p - 1))}
        className="rounded border border-white/10 px-2 py-0.5 text-xs text-slate-400 disabled:opacity-40"
      >
        ←
      </button>
      <button
        disabled={(st.page + 1) * PAGE_SIZE >= total}
        onClick={() => st.setPage((p) => p + 1)}
        className="rounded border border-white/10 px-2 py-0.5 text-xs text-slate-400 disabled:opacity-40"
      >
        →
      </button>
    </div>
  );
}

/** null = открытое пребывание в пределах норматива — «рано судить». */
const okRowCls = (ok: boolean | null) =>
  ok === null ? "bg-slate-900/30" : ok ? "bg-emerald-500/10" : "bg-red-500/10";

const okCellText = (ok: boolean | null) => (ok === null ? "—" : ok ? "true" : "false");

function LeadLink({ id }: { id: number }) {
  return (
    <a
      href={`https://sternmeister.kommo.com/leads/detail/${id}`}
      target="_blank"
      rel="noreferrer"
      className="text-blue-300 hover:underline"
    >
      {id}
    </a>
  );
}

// ─── SLA: «Новый лид ≤ 25 рабочих минут» (Бух Гос) ──────────────────

function SlaView({ range }: { range: DateRange }) {
  const st = useDetailData<SlaRow>("sla", range);
  const { data, loading, error } = st;

  return (
    <div className="flex flex-col gap-3">
      <DetailToolbar
        st={st}
        hint={`воронка ${FUNNEL_PIPELINES.gos} · норма из документа РОПа: выход с этапа «Новый лид» ≤ 25 рабочих минут (окно 09–20, вс не считается); неквал «язык» исключён`}
      />

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          Ошибка загрузки: {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <DinoLoader />
        </div>
      ) : data ? (
        <div className="max-h-[70vh] overflow-auto rounded-lg border border-white/10">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10" style={theadStyle}>
              <tr className="border-b border-white/10 text-left text-xs text-slate-400">
                <th className={thCls}>Менеджер</th>
                <th className={thCls}>Сделка</th>
                <th className={thCls}>Вход на «Новый лид»</th>
                <th className={thCls}>Выход с этапа</th>
                <th className={`${thCls} text-right`}>Рабочих минут на этапе</th>
                <th className={thCls}>SLA ок</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-xs text-slate-500">
                    Нет лидов за период.
                  </td>
                </tr>
              ) : (
                data.rows.map((r, i) => (
                  <tr key={`${r.leadId}-${i}`} className={`border-b border-white/5 last:border-0 ${okRowCls(r.ok)}`}>
                    <td className="whitespace-nowrap px-3 py-2 text-slate-200">{r.manager}</td>
                    <td className="px-3 py-2 text-xs">
                      <LeadLink id={r.leadId} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-300">{fmtBerlin(r.enterAt)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-300">
                      {r.exitAt ? fmtBerlin(r.exitAt) : <span className="text-amber-300/90">ещё на этапе</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-200">
                      {r.workMinutes.toLocaleString("ru-RU", { maximumFractionDigits: 1 })}
                    </td>
                    <td className="px-3 py-2 text-xs">{okCellText(r.ok)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

// ─── Время на этапах / TLT-GAP / Касания ────────────────────────────

interface StageTimeApiRow {
  leadId: number;
  funnel: FunnelKey;
  status: string;
  enterAt: string;
  exitAt: string | null;
  unit: "work_days" | "calendar_days" | "hours";
  limit: number;
  fact: number;
  /** null = открытое пребывание в пределах норматива. */
  ok: boolean | null;
  responsible: string;
}
interface TltGapApiRow {
  leadId: number;
  funnel: FunnelKey;
  status: string;
  enterAt: string;
  exitAt: string | null;
  limit: number;
  gapFact: number;
  /** null = открытое пребывание в пределах норматива. */
  ok: boolean | null;
  responsible: string;
}
interface TouchesApiRow {
  leadId: number;
  funnel: FunnelKey;
  fromStatus: string;
  toStatus: string;
  exitAt: string;
  calls: number;
  messages: number;
  minCalls: number;
  minMessages: number;
  ok: boolean;
  responsible: string;
}

function managersOf(rows: { responsible: string }[] | undefined): string[] {
  return [...new Set((rows ?? []).map((r) => r.responsible))].sort((a, b) => a.localeCompare(b, "ru"));
}

function StageTimeView({ range }: { range: DateRange }) {
  const st = useDetailData<StageTimeApiRow>("stage_time", range, { funnelAware: true });
  return (
    <div className="flex flex-col gap-3">
      <DetailToolbar
        st={st}
        managers={managersOf(st.data?.rows)}
        funnelAware
        hint="факт — наш расчёт (elapsed); ok = факт ≤ норматив"
      />
      {st.error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          Ошибка загрузки: {st.error}
        </div>
      )}
      {st.loading ? (
        <div className="flex items-center justify-center py-16">
          <DinoLoader />
        </div>
      ) : st.data ? (
        <div className="max-h-[70vh] overflow-auto rounded-lg border border-white/10">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10" style={theadStyle}>
              <tr className="border-b border-white/10 text-left text-xs text-slate-400">
                <th className={thCls}>Сделка</th>
                <th className={thCls}>Этап</th>
                <th className={thCls}>Менеджер</th>
                <th className={thCls}>Дата входа</th>
                <th className={thCls}>Дата выхода</th>
                <th className={thCls}>Ед. измерения</th>
                <th className={`${thCls} text-right`}>По регламенту</th>
                <th className={`${thCls} text-right`}>Факт</th>
                <th className={thCls}>Регламент ок</th>
              </tr>
            </thead>
            <tbody>
              {st.data.rows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-3 py-6 text-center text-xs text-slate-500">
                    Нет пребываний за период.
                  </td>
                </tr>
              ) : (
                st.data.rows.map((r, i) => (
                  <tr key={`${r.leadId}-${r.enterAt}-${i}`} className={`border-b border-white/5 last:border-0 ${okRowCls(r.ok)}`}>
                    <td className="px-3 py-2 text-xs">
                      <LeadLink id={r.leadId} />
                    </td>
                    <td className="px-3 py-2 text-slate-200">{r.status}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-slate-200">{r.responsible}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-300">{fmtBerlin(r.enterAt)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-300">
                      {r.exitAt ? fmtBerlin(r.exitAt) : <span className="text-amber-300/80">ещё в этапе</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-400">{UNIT_LABELS[r.unit]}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-300">{r.limit}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-200">
                      {r.unit === "work_days" ? Math.round(r.fact) : r.fact.toFixed(2)}
                    </td>
                    <td className="px-3 py-2 text-xs">{okCellText(r.ok)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function TltGapView({ range }: { range: DateRange }) {
  const st = useDetailData<TltGapApiRow>("tlt_gap", range, { funnelAware: true });
  return (
    <div className="flex flex-col gap-3">
      <DetailToolbar
        st={st}
        managers={managersOf(st.data?.rows)}
        funnelAware
        hint="GAP — макс. разрыв между касаниями на этапе, рабочие дни (Пн–Сб)"
      />
      {st.error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          Ошибка загрузки: {st.error}
        </div>
      )}
      {st.loading ? (
        <div className="flex items-center justify-center py-16">
          <DinoLoader />
        </div>
      ) : st.data ? (
        <div className="max-h-[70vh] overflow-auto rounded-lg border border-white/10">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10" style={theadStyle}>
              <tr className="border-b border-white/10 text-left text-xs text-slate-400">
                <th className={thCls}>Менеджер</th>
                <th className={thCls}>Сделка</th>
                <th className={thCls}>Этап</th>
                <th className={thCls}>Дата входа</th>
                <th className={thCls}>Дата выхода</th>
                <th className={`${thCls} text-right`}>GAP Регламент</th>
                <th className={`${thCls} text-right`}>GAP Факт</th>
                <th className={thCls}>Регламент ок</th>
              </tr>
            </thead>
            <tbody>
              {st.data.rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-center text-xs text-slate-500">
                    Нет данных за период.
                  </td>
                </tr>
              ) : (
                st.data.rows.map((r, i) => (
                  <tr key={`${r.leadId}-${r.enterAt}-${i}`} className={`border-b border-white/5 last:border-0 ${okRowCls(r.ok)}`}>
                    <td className="whitespace-nowrap px-3 py-2 text-slate-200">{r.responsible}</td>
                    <td className="px-3 py-2 text-xs">
                      <LeadLink id={r.leadId} />
                    </td>
                    <td className="px-3 py-2 text-slate-200">{r.status}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-300">{fmtBerlin(r.enterAt)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-300">
                      {r.exitAt ? fmtBerlin(r.exitAt) : <span className="text-amber-300/80">ещё в этапе</span>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-300">{r.limit}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-200">{r.gapFact}</td>
                    <td className="px-3 py-2 text-xs">{okCellText(r.ok)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function TouchesView({ range }: { range: DateRange }) {
  const st = useDetailData<TouchesApiRow>("touches", range, { funnelAware: true });
  return (
    <div className="flex flex-col gap-3">
      <DetailToolbar
        st={st}
        managers={managersOf(st.data?.rows)}
        funnelAware
        hint="касания за пребывание на этапе «Из» до перехода; минимум — по правилам 23a"
      />
      {st.error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          Ошибка загрузки: {st.error}
        </div>
      )}
      {st.loading ? (
        <div className="flex items-center justify-center py-16">
          <DinoLoader />
        </div>
      ) : st.data ? (
        <div className="max-h-[70vh] overflow-auto rounded-lg border border-white/10">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10" style={theadStyle}>
              <tr className="border-b border-white/10 text-left text-xs text-slate-400">
                <th className={thCls}>Менеджер</th>
                <th className={thCls}>Сделка</th>
                <th className={thCls}>Дата выхода</th>
                <th className={thCls}>Из этапа</th>
                <th className={thCls}>В этап</th>
                <th className={`${thCls} text-right`}>Звонки</th>
                <th className={`${thCls} text-right`}>Сообщения</th>
                <th className={`${thCls} text-right`}>Минимум</th>
                <th className={thCls}>Регламент ок</th>
              </tr>
            </thead>
            <tbody>
              {st.data.rows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-3 py-6 text-center text-xs text-slate-500">
                    Нет переходов за период.
                  </td>
                </tr>
              ) : (
                st.data.rows.map((r, i) => (
                  <tr key={`${r.leadId}-${r.exitAt}-${i}`} className={`border-b border-white/5 last:border-0 ${okRowCls(r.ok)}`}>
                    <td className="whitespace-nowrap px-3 py-2 text-slate-200">{r.responsible}</td>
                    <td className="px-3 py-2 text-xs">
                      <LeadLink id={r.leadId} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-300">{fmtBerlin(r.exitAt)}</td>
                    <td className="px-3 py-2 text-slate-200">{r.fromStatus}</td>
                    <td className="px-3 py-2 text-slate-200">{r.toStatus}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-200">{r.calls}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-200">
                      {r.funnel === "berater" ? "—" : r.messages}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right text-xs text-slate-400">
                      {r.minCalls} зв{r.minMessages > 0 ? ` + ${r.minMessages} сообщ` : ""}
                    </td>
                    <td className="px-3 py-2 text-xs">{okCellText(r.ok)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

// ─── Сводка ─────────────────────────────────────────────────────────

interface SummaryMetric {
  pct: number;
  ok: number;
  n: number;
}
interface SummaryRow {
  manager: string;
  metrics: Record<string, SummaryMetric | null>;
  reglament: number | null;
}
interface MissedRow {
  at: string;
  phone: string;
  contactId: number | null;
  contactName: string | null;
  manager: string;
}

const METRIC_COLUMNS: { key: string; label: string; hint: string; gosOnly?: boolean }[] = [
  {
    key: "sla",
    label: "SLA, %",
    gosOnly: true,
    hint: [
      "Как быстро новый лид взят в работу.",
      "",
      "Проверка: сколько сделка провисела на этапе «Новый лид».",
      "Норматив: ≤ 25 рабочих минут (окно 09–20, вс не считается).",
      "Не считаются: неквалы с причиной «язык».",
      "Висит дольше 25 минут до сих пор — уже нарушение.",
      "",
      "% = уложились в 25 минут ÷ все новые лиды периода.",
    ].join("\n"),
  },
  {
    key: "tlt",
    label: "TLT, %",
    hint: [
      "Нет ли длинных пауз в работе с клиентом.",
      "",
      "Проверка: самый длинный разрыв между касаниями за время на этапе",
      "(касание = звонок или сообщение; также вход и выход с этапа).",
      "Норматив: свой у каждого этапа, обычно 1 рабочий день.",
      "Передали сделку другому — отсчёт заново.",
      "",
      "% = пребывания без долгих пауз ÷ все пребывания на этапах.",
    ].join("\n"),
  },
  {
    key: "stage",
    label: "Время на этапе, %",
    hint: [
      "Не застревают ли сделки на этапах.",
      "",
      "Проверка: сколько сделка пробыла на этапе (вход → выход).",
      "Норматив: свой у каждого этапа (часы / рабочие / календарные дни).",
      "Передали сделку другому — отсчёт заново, проверка — владельцу.",
      "",
      "% = уложились в норматив ÷ все пройденные этапы за период.",
    ].join("\n"),
  },
  {
    key: "touches",
    label: "Мин.касаний, %",
    hint: [
      "Достаточно ли звонков, прежде чем сделка сменила этап.",
      "",
      "Проверка: исходящие звонки за время на этапе, с которого ушли.",
      "Норматив: ≥ 1 звонок;",
      "«Документы отправлены в ДЦ» — ещё и 1 сообщение;",
      "закрытие с причиной «игнор» — ≥ 18 звонков.",
      "",
      "% = переходы с достаточным числом касаний ÷ все переходы.",
    ].join("\n"),
  },
  {
    key: "tasks",
    label: "Задачи, %",
    hint: [
      "Закрываются ли задачи CRM вовремя.",
      "",
      "Задачи дня: с дедлайном сегодня + просроченные с прошлых дней.",
      "Выполнена: закрыта до конца дня (просроченная — в день закрытия).",
      "Не считаются: задачи закрытых сделок, воскресенья.",
      "",
      "% = закрытые вовремя ÷ все задачи рабочих дней периода.",
    ].join("\n"),
  },
];

const REGLAMENT_HINT = [
  "Итоговая оценка менеджера.",
  "",
  "Среднее из показателей строки:",
  "SLA, TLT, Время на этапе, Мин.касаний, Задачи.",
  "Показатели без данных за период пропускаются.",
].join("\n");

/** Значок «?» у заголовка колонки — пояснение в нативном tooltip браузера. */
function HeaderHint({ text }: { text: string }) {
  return (
    <span
      title={text}
      className="ml-1 inline-flex h-3.5 w-3.5 cursor-help select-none items-center justify-center rounded-full border border-slate-500 align-middle text-[9px] leading-none text-slate-400 hover:border-slate-300 hover:text-slate-200"
      aria-label="Как считается"
    >
      ?
    </span>
  );
}

const CELL_BG: Record<MetricColor, string> = {
  red: "bg-red-500/20 text-red-200",
  yellow: "bg-amber-500/20 text-amber-100",
  green: "bg-emerald-500/20 text-emerald-100",
};

function MetricCell({ m }: { m: SummaryMetric | null }) {
  if (!m) {
    return <td className="px-3 py-2 text-right text-slate-500">–</td>;
  }
  return (
    <td
      className={`px-3 py-2 text-right tabular-nums ${CELL_BG[metricColor(m.pct)]}`}
      title={`${m.ok}/${m.n} проверок в нормативе`}
    >
      {m.pct}
    </td>
  );
}

function SummaryTable({ rows, funnel }: { rows: SummaryRow[]; funnel: FunnelKey }) {
  const cols = METRIC_COLUMNS.filter((c) => !c.gosOnly || funnel === "gos");
  return (
    <section>
      <h3 className="mb-2 text-center text-sm font-semibold text-slate-200">
        Показатели соблюдения регламента — {FUNNEL_LABELS[funnel]}
      </h3>
      <div className="overflow-x-auto rounded-lg border border-white/10">
        <table className="w-full text-sm">
          <thead style={theadStyle}>
            <tr className="border-b border-white/10 text-left text-xs text-slate-400">
              <th className={thCls}>Менеджер</th>
              {cols.map((c) => (
                <th key={c.key} className={`${thCls} whitespace-nowrap text-right`}>
                  {c.label}
                  <HeaderHint text={c.hint} />
                </th>
              ))}
              <th className={`${thCls} whitespace-nowrap text-right`}>
                Регламент, %
                <HeaderHint text={REGLAMENT_HINT} />
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={cols.length + 2} className="px-3 py-6 text-center text-xs text-slate-500">
                  Нет данных за период.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.manager} className="border-b border-white/5 last:border-0">
                  <td
                    className={`whitespace-nowrap px-3 py-2 ${
                      r.reglament != null && r.reglament < NAME_RED_BELOW
                        ? "bg-red-500/25 text-red-100"
                        : "text-slate-200"
                    }`}
                  >
                    {r.manager}
                  </td>
                  {cols.map((c) => (
                    <MetricCell key={c.key} m={r.metrics[c.key] ?? null} />
                  ))}
                  {r.reglament != null ? (
                    <td className={`px-3 py-2 text-right font-semibold tabular-nums ${CELL_BG[metricColor(r.reglament)]}`}>
                      {r.reglament}
                    </td>
                  ) : (
                    <td className="px-3 py-2 text-right text-slate-500">–</td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MissedCallsTable({ rows }: { rows: MissedRow[] }) {
  return (
    <section>
      <h3 className="mb-2 text-xs uppercase tracking-wider text-slate-500">Пропущенные звонки</h3>
      <div className="max-h-[50vh] overflow-auto rounded-lg border border-white/10">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10" style={theadStyle}>
            <tr className="border-b border-white/10 text-left text-xs text-slate-400">
              <th className={thCls}>Дата и время звонка</th>
              <th className={thCls}>Менеджер</th>
              <th className={thCls}>Контакт</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-3 py-6 text-center text-xs text-slate-500">
                  Пропущенных звонков за период нет.
                </td>
              </tr>
            ) : (
              rows.map((r, i) => (
                <tr key={`${r.at}-${i}`} className="border-b border-white/5 bg-slate-900/30 last:border-0">
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-300">{fmtBerlin(r.at)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-slate-200">{r.manager}</td>
                  <td className="px-3 py-2 text-xs">
                    {r.contactId != null ? (
                      <a
                        href={`https://sternmeister.kommo.com/contacts/detail/${r.contactId}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-300 hover:underline"
                      >
                        {r.contactName || `контакт ${r.contactId}`}
                      </a>
                    ) : (
                      <span className="text-slate-400">…{r.phone.slice(-4)} (контакт не найден)</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-[11px] text-slate-500">
        Только CallGear; звонки, упавшие до дозвона агентам (вне рабочего времени), в базе
        отсутствуют. Менеджер — ответственный контакта в Kommo.
      </p>
    </section>
  );
}

function SummaryView({ range }: { range: DateRange }) {
  const [summary, setSummary] = useState<{ gos: SummaryRow[]; berater: SummaryRow[] } | null>(null);
  const [missed, setMissed] = useState<MissedRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      const params = {
        from: fmtLocalDate(range.start ?? todayBerlinDate()),
        to: fmtLocalDate(range.end ?? range.start ?? todayBerlinDate()),
      };
      try {
        const [s, m] = await Promise.all([
          fetchView<{ gos: SummaryRow[]; berater: SummaryRow[] }>("summary", params),
          fetchView<{ rows: MissedRow[] }>("missed", params),
        ]);
        if (!cancelled) {
          setSummary(s);
          setMissed(m.rows);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [range]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <DinoLoader />
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
        Ошибка загрузки: {error}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      {summary && (
        <>
          <SummaryTable rows={summary.gos} funnel="gos" />
          <SummaryTable rows={summary.berater} funnel="berater" />
          <p className="-mt-3 text-[11px] text-slate-500">
            Метрика = доля проверок в нормативе за период; фильтр периода — по дате
            завершения проверки. Наведите на «?» в заголовке — как считается колонка,
            на ячейку — счёт (ok/всего). Цвета: ≤70 красный, 71–80 жёлтый, ≥81 зелёный.
          </p>
        </>
      )}
      {missed && <MissedCallsTable rows={missed} />}
    </div>
  );
}

// ─── Задачи ─────────────────────────────────────────────────────────

interface TaskApiRow {
  day: string;
  funnel: FunnelKey;
  manager: string;
  total: number;
  planned: number;
  overdue: number;
  completed: number;
  notCompleted: number;
  score: number;
}

function TasksTable({ rows, title }: { rows: TaskApiRow[]; title: string }) {
  return (
    <section>
      <h3 className="mb-2 text-xs uppercase tracking-wider text-slate-500">{title}</h3>
      <div className="max-h-[60vh] overflow-auto rounded-lg border border-white/10">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10" style={theadStyle}>
            <tr className="border-b border-white/10 text-left text-xs text-slate-400">
              <th className={thCls}>Дата</th>
              <th className={thCls}>Менеджер</th>
              <th className={`${thCls} text-right`}>Всего на день</th>
              <th className={`${thCls} text-right`}>Запланировано</th>
              <th className={`${thCls} text-right`}>Просроченные</th>
              <th className={`${thCls} text-right`}>Завершено</th>
              <th className={`${thCls} text-right`}>Не завершены</th>
              <th className={`${thCls} text-right`}>Показатель</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-xs text-slate-500">
                  Нет задач за период.
                </td>
              </tr>
            ) : (
              rows.map((r, i) => (
                <tr key={`${r.day}-${r.manager}-${i}`} className="border-b border-white/5 bg-slate-900/30 last:border-0">
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-300">
                    {`${r.day.slice(8, 10)}.${r.day.slice(5, 7)}.${r.day.slice(0, 4)}`}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-slate-200">{r.manager}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-300">{r.total}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-300">{r.planned}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${r.overdue > 0 ? "text-red-300" : "text-slate-300"}`}>
                    {r.overdue}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-300">{r.completed}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-300">{r.notCompleted}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-200">
                    {r.score.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TasksView({ range }: { range: DateRange }) {
  const [data, setData] = useState<{ rows: TaskApiRow[]; dataUpTo: string | null } | null>(null);
  const [manager, setManager] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      const params: Record<string, string> = {
        from: fmtLocalDate(range.start ?? todayBerlinDate()),
        to: fmtLocalDate(range.end ?? range.start ?? todayBerlinDate()),
      };
      if (manager) params.manager = manager;
      try {
        const d = await fetchView<{ rows: TaskApiRow[]; dataUpTo: string | null }>("tasks", params);
        if (!cancelled) setData(d);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [range, manager]);

  // Задачи не пагинируются — список менеджеров периода собирается из строк.
  const managerOptions = useMemo(
    () => [...new Set((data?.rows ?? []).map((r) => r.manager))].sort((a, b) => a.localeCompare(b, "ru")),
    [data],
  );

  const stale = useMemo(() => {
    if (!data?.dataUpTo) return null;
    const to = fmtLocalDate(range.end ?? todayBerlinDate());
    return data.dataUpTo < to ? data.dataUpTo : null;
  }, [data, range]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <DinoLoader />
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
        Ошибка загрузки: {error}
      </div>
    );
  }
  if (!data) return null;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={manager}
          onChange={(e) => setManager(e.target.value)}
          className="rounded-lg border border-white/10 bg-slate-900/60 px-2 py-1.5 text-xs text-slate-300"
        >
          <option value="">Все менеджеры</option>
          {manager && !managerOptions.includes(manager) && <option value={manager}>{manager}</option>}
          {managerOptions.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>
      {stale && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-300">
          Задачи в аналитической базе синхронизированы по {`${stale.slice(8, 10)}.${stale.slice(5, 7)}.${stale.slice(0, 4)}`} —
          свежие дни могут быть пустыми (syncTasks выполняется только при полном бэкфилле).
        </div>
      )}
      <TasksTable rows={data.rows.filter((r) => r.funnel === "gos")} title="Задачи — Госники" />
      <TasksTable rows={data.rows.filter((r) => r.funnel === "berater")} title="Задачи — Бератер" />
    </div>
  );
}

// ─── Среднее время на этапах ────────────────────────────────────────

function AvgPivot({ rows, funnel }: { rows: AvgSummaryRow[]; funnel: FunnelKey }) {
  const scoped = rows.filter((r) => funnelOfPipeline(r.pipeline) === funnel);
  const stages = orderStages(funnel, scoped.map((r) => r.status));
  const managers = [...new Set(scoped.map((r) => r.responsible))].sort((a, b) =>
    a.localeCompare(b, "ru"),
  );
  // (manager, status) → взвешенная сумма; итоги — по суммарным секундам/пребываниям.
  const cell = new Map<string, { sec: number; n: number }>();
  for (const r of scoped) {
    const k = `${r.responsible}|${r.status}`;
    const c = cell.get(k) ?? { sec: 0, n: 0 };
    c.sec += r.avgSeconds * r.stays;
    c.n += r.stays;
    cell.set(k, c);
  }
  const avgOf = (sec: number, n: number) => (n > 0 ? fmtDuration(sec / n) : "–");
  if (scoped.length === 0) {
    return (
      <div className="rounded-lg border border-white/10 bg-slate-900/60 px-4 py-6 text-center text-xs text-slate-500">
        Нет пребываний за период.
      </div>
    );
  }
  return (
    <div className="max-h-[70vh] overflow-auto rounded-lg border border-white/10">
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10" style={theadStyle}>
          <tr className="border-b border-white/10 text-left text-xs text-slate-400">
            <th className={thCls}>Отв-ый за сделку</th>
            {stages.map((s) => (
              <th key={s} className={`${thCls} text-right`}>
                {s}
              </th>
            ))}
            <th className={`${thCls} text-right`}>Общий итог</th>
          </tr>
        </thead>
        <tbody>
          {managers.map((m) => {
            let rowSec = 0;
            let rowN = 0;
            const cells = stages.map((s) => {
              const c = cell.get(`${m}|${s}`);
              if (c) {
                rowSec += c.sec;
                rowN += c.n;
              }
              return (
                <td key={s} className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-300">
                  {c ? avgOf(c.sec, c.n) : "–"}
                </td>
              );
            });
            return (
              <tr key={m} className="border-b border-white/5 bg-slate-900/30 last:border-0">
                <td className="whitespace-nowrap px-3 py-2 text-slate-200">{m}</td>
                {cells}
                <td className="whitespace-nowrap px-3 py-2 text-right font-semibold tabular-nums text-slate-200">
                  {avgOf(rowSec, rowN)}
                </td>
              </tr>
            );
          })}
          {/* Общий итог по колонкам */}
          <tr className="border-t border-white/10 bg-slate-900/60">
            <td className="px-3 py-2 font-semibold text-slate-200">Общий итог</td>
            {stages.map((s) => {
              let sec = 0;
              let n = 0;
              for (const m of managers) {
                const c = cell.get(`${m}|${s}`);
                if (c) {
                  sec += c.sec;
                  n += c.n;
                }
              }
              return (
                <td key={s} className="whitespace-nowrap px-3 py-2 text-right font-semibold tabular-nums text-slate-200">
                  {avgOf(sec, n)}
                </td>
              );
            })}
            <td className="whitespace-nowrap px-3 py-2 text-right font-semibold tabular-nums text-slate-200">
              {avgOf(
                [...cell.values()].reduce((a, c) => a + c.sec, 0),
                [...cell.values()].reduce((a, c) => a + c.n, 0),
              )}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** Последние 12 берлинских месяцев для фильтра «Месяц создания сделки». */
function lastMonths(): { value: string; label: string }[] {
  const NAMES = [
    "январь", "февраль", "март", "апрель", "май", "июнь",
    "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
  ];
  const today = todayCivil();
  let y = Number(today.slice(0, 4));
  let m = Number(today.slice(5, 7));
  const out: { value: string; label: string }[] = [];
  for (let i = 0; i < 12; i++) {
    out.push({ value: `${y}-${String(m).padStart(2, "0")}`, label: `${NAMES[m - 1]} ${y}` });
    m--;
    if (m === 0) {
      m = 12;
      y--;
    }
  }
  return out;
}

function AvgView({ range }: { range: DateRange }) {
  const [mode, setMode] = useState<"summary" | "detail">("summary");
  const [summaryRows, setSummaryRows] = useState<AvgSummaryRow[] | null>(null);
  const [detail, setDetail] = useState<{
    total: number;
    statuses?: string[];
    managers?: string[];
    rows: AvgDetailRow[];
  } | null>(null);
  const [page, setPage] = useState(0);
  const [leadId, setLeadId] = useState("");
  const [funnelFilter, setFunnelFilter] = useState<"" | FunnelKey>("");
  const [statusFilter, setStatusFilter] = useState("");
  const [managerFilter, setManagerFilter] = useState("");
  const [createdMonth, setCreatedMonth] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const PAGE = 100;
  const months = useMemo(lastMonths, []);

  const params = useMemo(() => {
    const p: Record<string, string> = {
      from: fmtLocalDate(range.start ?? todayBerlinDate()),
      to: fmtLocalDate(range.end ?? range.start ?? todayBerlinDate()),
    };
    // Наборы фильтров — как в Looker: у «Сводного» только когортный «Месяц
    // создания сделки», у «Детализированно» — воронка/этап/ответственный/id.
    // Не подмешиваем чужие: утёкший фильтр невидимо опустошал бы таблицы.
    if (mode === "summary" && createdMonth) p.createdMonth = createdMonth;
    if (mode === "detail") {
      if (funnelFilter) p.funnel = funnelFilter;
      if (statusFilter) p.status = statusFilter;
      if (managerFilter) p.manager = managerFilter;
      if (/^\d+$/.test(leadId.trim())) p.leadId = leadId.trim();
    }
    return p;
  }, [range, funnelFilter, statusFilter, managerFilter, leadId, createdMonth, mode]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        if (mode === "summary") {
          const data = await fetchView<{ rows: AvgSummaryRow[] }>("avg_summary", params);
          if (!cancelled) setSummaryRows(data.rows);
        } else {
          const data = await fetchView<{
            total: number;
            statuses?: string[];
            managers?: string[];
            rows: AvgDetailRow[];
          }>("avg_detail", {
            ...params,
            limit: String(PAGE),
            offset: String(page * PAGE),
          });
          if (!cancelled) setDetail(data);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [mode, params, page]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {(["summary", "detail"] as const).map((m) => (
          <button
            key={m}
            onClick={() => {
              setMode(m);
              setPage(0);
            }}
            className={`rounded-lg px-3 py-1.5 text-xs ${
              mode === m
                ? "bg-blue-500/20 text-blue-300"
                : "border border-white/10 bg-slate-900/60 text-slate-400 hover:border-white/20"
            }`}
          >
            {m === "summary" ? "Сводный" : "Детализированно"}
          </button>
        ))}
        {mode === "summary" && (
          <select
            value={createdMonth}
            onChange={(e) => setCreatedMonth(e.target.value)}
            className="rounded-lg border border-white/10 bg-slate-900/60 px-2 py-1.5 text-xs text-slate-300"
            title="Когорта: учитываются только сделки, созданные в выбранном месяце"
          >
            <option value="">Месяц создания сделки — все</option>
            {months.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        )}
        {mode === "detail" && (
          <>
            <select
              value={funnelFilter}
              onChange={(e) => {
                setFunnelFilter(e.target.value as "" | FunnelKey);
                setPage(0);
              }}
              className="rounded-lg border border-white/10 bg-slate-900/60 px-2 py-1.5 text-xs text-slate-300"
            >
              <option value="">Обе воронки</option>
              <option value="gos">{FUNNEL_PIPELINES.gos}</option>
              <option value="berater">{FUNNEL_PIPELINES.berater}</option>
            </select>
            <select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(0);
              }}
              className="max-w-56 rounded-lg border border-white/10 bg-slate-900/60 px-2 py-1.5 text-xs text-slate-300"
            >
              <option value="">Этап воронки — все</option>
              {statusFilter && !(detail?.statuses ?? []).includes(statusFilter) && (
                <option value={statusFilter}>{statusFilter}</option>
              )}
              {(detail?.statuses ?? []).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select
              value={managerFilter}
              onChange={(e) => {
                setManagerFilter(e.target.value);
                setPage(0);
              }}
              className="rounded-lg border border-white/10 bg-slate-900/60 px-2 py-1.5 text-xs text-slate-300"
            >
              <option value="">Ответственный — все</option>
              {managerFilter && !(detail?.managers ?? []).includes(managerFilter) && (
                <option value={managerFilter}>{managerFilter}</option>
              )}
              {(detail?.managers ?? []).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <input
              value={leadId}
              onChange={(e) => {
                setLeadId(e.target.value);
                setPage(0);
              }}
              placeholder="id сделки"
              className="w-28 rounded-lg border border-white/10 bg-slate-900/60 px-2 py-1.5 text-xs text-slate-300 placeholder:text-slate-600"
            />
          </>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          Ошибка загрузки: {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <DinoLoader />
        </div>
      ) : mode === "summary" && summaryRows ? (
        <>
          {(["gos", "berater"] as const).map((f) => (
            <section key={f}>
              <h3 className="mb-2 text-xs uppercase tracking-wider text-slate-500">
                {f === "gos" ? "Бух — Госники" : "Бератер — Госники"}
              </h3>
              <AvgPivot rows={summaryRows} funnel={f} />
            </section>
          ))}
        </>
      ) : mode === "detail" && detail ? (
        <section>
          <div className="mb-2 flex items-baseline gap-2">
            <h3 className="text-xs uppercase tracking-wider text-slate-500">
              Время пребывания сделки в этапе
            </h3>
            <span className="ml-auto text-[11px] text-slate-500">
              {detail.total > 0
                ? `${page * PAGE + 1}–${Math.min((page + 1) * PAGE, detail.total)} / ${detail.total}`
                : "0"}
            </span>
            <button
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              className="rounded border border-white/10 px-2 py-0.5 text-xs text-slate-400 disabled:opacity-40"
            >
              ←
            </button>
            <button
              disabled={(page + 1) * PAGE >= detail.total}
              onClick={() => setPage((p) => p + 1)}
              className="rounded border border-white/10 px-2 py-0.5 text-xs text-slate-400 disabled:opacity-40"
            >
              →
            </button>
          </div>
          <div className="max-h-[70vh] overflow-auto rounded-lg border border-white/10">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10" style={theadStyle}>
                <tr className="border-b border-white/10 text-left text-xs text-slate-400">
                  <th className={thCls}>Сделка</th>
                  <th className={thCls}>Время входа</th>
                  <th className={thCls}>Время выхода</th>
                  <th className={thCls}>Этап</th>
                  <th className={thCls}>Воронка</th>
                  <th className={thCls}>Отв-ый за сделку</th>
                  <th className={`${thCls} text-right`}>Время в этапе</th>
                </tr>
              </thead>
              <tbody>
                {detail.rows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-6 text-center text-xs text-slate-500">
                      Нет пребываний за период.
                    </td>
                  </tr>
                ) : (
                  detail.rows.map((r, i) => (
                    <tr key={`${r.leadId}-${r.enterAt}-${i}`} className="border-b border-white/5 bg-slate-900/30 last:border-0">
                      <td className="px-3 py-2 text-xs text-slate-400">
                        <a
                          href={`https://sternmeister.kommo.com/leads/detail/${r.leadId}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-blue-300 hover:underline"
                        >
                          {r.leadId}
                        </a>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-300">{fmtBerlin(r.enterAt)}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-300">
                        {r.exitAt ? fmtBerlin(r.exitAt) : <span className="text-amber-300/80">ещё в этапе</span>}
                      </td>
                      <td className="px-3 py-2 text-slate-200">{r.status}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-400">{r.pipeline}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-slate-200">{r.responsible}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-300">
                        {fmtDuration(r.seconds)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}

// ─── Корневой компонент вкладки ─────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export default function ReglamentTab({ department: _department }: { department: "b2g" | "b2b" }) {
  const [sub, setSub] = useState<SubView>("summary");
  const [range, setRange] = useState<DateRange>(defaultRange);
  const [reloadKey, setReloadKey] = useState(0);

  const onRangeChange = useCallback((r: DateRange) => {
    if (r.start && r.end) setRange(r);
  }, []);

  return (
    <div className="flex flex-col gap-5 fade-in">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 text-slate-200">
          <ShieldCheck className="w-5 h-5 text-blue-400" />
          <span className="text-base font-semibold">Регламент</span>
        </div>
        <CalendarPicker
          mode="range"
          value={range}
          onChange={onRangeChange}
          onClear={() => setRange(defaultRange())}
          maxDate={todayBerlinDate()}
        />
        <button
          onClick={() => setReloadKey((k) => k + 1)}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-slate-900/60 px-3 py-1.5 text-xs text-slate-300 hover:border-white/20"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Обновить
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {SUB_VIEWS.map((v) => (
          <button
            key={v.id}
            onClick={() => setSub(v.id)}
            className={`rounded-lg px-3 py-1.5 text-xs ${
              sub === v.id
                ? "bg-blue-500/20 text-blue-300"
                : "border border-white/10 bg-slate-900/60 text-slate-400 hover:border-white/20"
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>

      <div key={`${sub}-${reloadKey}`}>
        {sub === "summary" ? (
          <SummaryView range={range} />
        ) : sub === "avg" ? (
          <AvgView range={range} />
        ) : sub === "sla" ? (
          <SlaView range={range} />
        ) : sub === "stages" ? (
          <StageTimeView range={range} />
        ) : sub === "tlt" ? (
          <TltGapView range={range} />
        ) : sub === "touches" ? (
          <TouchesView range={range} />
        ) : (
          <TasksView range={range} />
        )}
      </div>
    </div>
  );
}
