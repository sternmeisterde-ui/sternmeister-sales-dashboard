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
import { FUNNEL_PIPELINES, orderStages, type FunnelKey } from "@/lib/reglament/norms";

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
  callAt: string | null;
  slaSeconds: number | null;
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
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

const thCls = "px-3 py-2 font-medium whitespace-nowrap";
const theadStyle = {
  backgroundColor: "rgb(15, 23, 42)",
  boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
} as const;

function Placeholder({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-slate-900/60 px-4 py-10 text-center text-sm text-slate-400">
      Раздел «{label}» в разработке.
    </div>
  );
}

/** Секунды → "X ч YY мин" (формат SLA-страницы Looker). */
function fmtHoursMin(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return `${h} ч ${m.toString().padStart(2, "0")} мин`;
}

// ─── SLA первого звонка (Бух Гос) ───────────────────────────────────

/** Порог подсветки превышения — ПРЕДВАРИТЕЛЬНЫЙ (норматив SLA не восстановлен,
 *  справочник 23a §4); 30 мин = верхний бакет вкладки Looker. */
const SLA_HIGHLIGHT_SECONDS = 1800;

function SlaView({ range }: { range: DateRange }) {
  const [data, setData] = useState<{ total: number; avgSeconds: number | null; rows: SlaRow[] } | null>(null);
  const [page, setPage] = useState(0);
  const [manager, setManager] = useState("");
  const [leadId, setLeadId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const PAGE = 100;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params: Record<string, string> = {
      from: fmtLocalDate(range.start ?? todayBerlinDate()),
      to: fmtLocalDate(range.end ?? range.start ?? todayBerlinDate()),
      limit: String(PAGE),
      offset: String(page * PAGE),
    };
    if (manager) params.manager = manager;
    if (/^\d+$/.test(leadId.trim())) params.leadId = leadId.trim();
    fetchView<{ total: number; avgSeconds: number | null; rows: SlaRow[] }>("sla", params)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [range, page, manager, leadId]);

  const managers = useMemo(
    () => [...new Set((data?.rows ?? []).map((r) => r.manager))].sort((a, b) => a.localeCompare(b, "ru")),
    [data],
  );
  const barMax = useMemo(
    () => Math.max(SLA_HIGHLIGHT_SECONDS, ...(data?.rows ?? []).map((r) => r.slaSeconds ?? 0)),
    [data],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={manager}
          onChange={(e) => {
            setManager(e.target.value);
            setPage(0);
          }}
          className="rounded-lg border border-white/10 bg-slate-900/60 px-2 py-1.5 text-xs text-slate-300"
        >
          <option value="">Все менеджеры</option>
          {manager && !managers.includes(manager) && <option value={manager}>{manager}</option>}
          {managers.map((m) => (
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
        <span className="text-[11px] text-slate-500">
          воронка {FUNNEL_PIPELINES.gos} · SLA от начала смены менеджера
        </span>
        <span className="ml-auto text-[11px] text-slate-500">
          {data && data.total > 0
            ? `${page * PAGE + 1}–${Math.min((page + 1) * PAGE, data.total)} / ${data.total}`
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
          disabled={!data || (page + 1) * PAGE >= data.total}
          onClick={() => setPage((p) => p + 1)}
          className="rounded border border-white/10 px-2 py-0.5 text-xs text-slate-400 disabled:opacity-40"
        >
          →
        </button>
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
      ) : data ? (
        <div className="max-h-[70vh] overflow-auto rounded-lg border border-white/10">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10" style={theadStyle}>
              <tr className="border-b border-white/10 text-left text-xs text-slate-400">
                <th className={thCls}>Менеджер</th>
                <th className={thCls}>Сделка</th>
                <th className={thCls}>Дата вхождения</th>
                <th className={thCls}>Дата звонка</th>
                <th className={`${thCls} text-right`}>Время до 1-го звонка</th>
                <th className={`${thCls} w-[26%]`}>SLA</th>
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
                data.rows.map((r, i) => {
                  const over = r.slaSeconds != null && r.slaSeconds > SLA_HIGHLIGHT_SECONDS;
                  const pending = r.callAt == null;
                  return (
                    <tr
                      key={`${r.leadId}-${i}`}
                      className={`border-b border-white/5 last:border-0 ${
                        pending ? "bg-amber-500/10" : over ? "bg-red-500/10" : "bg-slate-900/30"
                      }`}
                    >
                      <td className="whitespace-nowrap px-3 py-2 text-slate-200">{r.manager}</td>
                      <td className="px-3 py-2 text-xs">
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
                        {pending ? <span className="text-amber-300/90">ещё не позвонили</span> : fmtBerlin(r.callAt)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-300">
                        {r.slaSeconds != null ? fmtHoursMin(r.slaSeconds) : "—"}
                      </td>
                      <td className="px-3 py-2">
                        {r.slaSeconds != null && r.slaSeconds > 0 && (
                          <div
                            className={`h-2 rounded ${over ? "bg-red-400/70" : "bg-blue-400/70"}`}
                            style={{ width: `${Math.max(2, Math.min(100, (r.slaSeconds / barMax) * 100))}%` }}
                          />
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
            <tfoot>
              <tr className="border-t border-white/10 bg-slate-900/60">
                <td colSpan={4} className="px-3 py-2 text-right text-xs text-slate-400">
                  Общий итог (среднее по лидам со звонком)
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right font-semibold tabular-nums text-slate-200">
                  {data.avgSeconds != null ? fmtDuration(data.avgSeconds) : "—"}
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      ) : null}
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

function AvgView({ range }: { range: DateRange }) {
  const [mode, setMode] = useState<"summary" | "detail">("summary");
  const [summaryRows, setSummaryRows] = useState<AvgSummaryRow[] | null>(null);
  const [detail, setDetail] = useState<{ total: number; rows: AvgDetailRow[] } | null>(null);
  const [page, setPage] = useState(0);
  const [leadId, setLeadId] = useState("");
  const [funnelFilter, setFunnelFilter] = useState<"" | FunnelKey>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const PAGE = 100;

  const params = useMemo(() => {
    const p: Record<string, string> = {
      from: fmtLocalDate(range.start ?? todayBerlinDate()),
      to: fmtLocalDate(range.end ?? range.start ?? todayBerlinDate()),
    };
    if (funnelFilter) p.funnel = funnelFilter;
    if (/^\d+$/.test(leadId.trim())) p.leadId = leadId.trim();
    return p;
  }, [range, funnelFilter, leadId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const run = async () => {
      try {
        if (mode === "summary") {
          const data = await fetchView<{ rows: AvgSummaryRow[] }>("avg_summary", params);
          if (!cancelled) setSummaryRows(data.rows);
        } else {
          const data = await fetchView<{ total: number; rows: AvgDetailRow[] }>("avg_detail", {
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
        {sub === "avg" ? (
          <AvgView range={range} />
        ) : sub === "sla" ? (
          <SlaView range={range} />
        ) : (
          <Placeholder label={SUB_VIEWS.find((v) => v.id === sub)?.label ?? sub} />
        )}
      </div>
    </div>
  );
}
