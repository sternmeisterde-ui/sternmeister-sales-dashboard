"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, TriangleAlert, ClipboardCheck, X, ExternalLink } from "lucide-react";
import type {
  RoleplayAuditResult,
  RoleplayAuditRow,
  SideAudit,
  RoleplayCallDetail,
  CriterionScore,
} from "@/lib/funnel/roleplay-audit";
import { CLIENT_RP_CRITERIA } from "@/lib/funnel/roleplay-audit";

const PAGE_SIZE = 50;
const FETCH_LIMIT = 1000;

/** Кеш по ключу периода — переключения фильтров не должны дёргать бэк повторно. */
const cache = new Map<string, RoleplayAuditResult>();

interface Props {
  terminFrom: string;
  terminTo: string | null;
  vertical?: "buh" | "med" | "all";
  /** Фильтр по менеджеру из шапки «Клиентов» — применяем на клиенте. */
  manager: string;
}

function kommoUrl(leadId: number): string {
  return `https://sternmeister.kommo.com/leads/detail/${leadId}`;
}

function scoreColor(s: number): string {
  if (s >= 4) return "text-emerald-300";
  if (s === 3) return "text-amber-300";
  return "text-rose-300";
}

function fmtDay(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Europe/Berlin",
  });
}

/** «4→3» с маркерами неоценённых: ○ мало материала, ⚠ сбой авто-оценки. */
function BotScores({ side }: { side: SideAudit }) {
  if (side.bot.length === 0) return <span className="text-slate-600">—</span>;
  return (
    <span className="inline-flex items-center gap-1 tabular-nums">
      {side.bot.map((b, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          {i > 0 && <span className="text-slate-600">→</span>}
          {b.score5 !== null ? (
            <span className={`font-semibold ${scoreColor(b.score5)}`}>{b.score5}</span>
          ) : b.notScored === "degenerate" ? (
            <span className="text-amber-500" title="Ролевка была, но авто-оценка сорвалась — стоит перепроверить">
              ⚠
            </span>
          ) : (
            <span className="text-slate-500" title="Ролевка была, но материала мало: клиент дал слишком мало самостоятельных немецких ответов">
              ○
            </span>
          )}
        </span>
      ))}
    </span>
  );
}

/** Оценки, которые менеджер выставил в карточке Kommo. */
function KommoScores({ side }: { side: SideAudit }) {
  if (!side.kommoKnown) {
    return (
      <span className="text-slate-600" title="Нет данных: сделка ещё не пересинкана из Kommo после включения слотов">
        н/д
      </span>
    );
  }
  const filled = side.kommo.filter((s) => s.score !== null || s.date !== null);
  if (filled.length === 0) {
    return <span className={side.conducted > 0 ? "text-rose-400" : "text-slate-600"}>—</span>;
  }
  return (
    <span className={`tabular-nums ${side.scoreMismatch ? "text-rose-300" : "text-slate-300"}`}>
      {filled.map((s) => (s.score === null ? "?" : s.score)).join(", ")}
    </span>
  );
}

/** «провед./в Kommo/оценено» — средняя цифра краснеет при расхождении. */
function CountsCell({ side }: { side: SideAudit }) {
  if (side.callsOkk === 0 && side.kommoFilled === 0) {
    return <span className="text-slate-600">—</span>;
  }
  return (
    <span
      className="tabular-nums"
      title={
        `Консультаций разобрано ОКК: ${side.callsOkk}\nИз них с ролевкой: ${side.conducted}\n` +
        `Выставлено в Kommo: ${side.kommoKnown ? side.kommoFilled : "нет данных"}\nОценено ботом: ${side.scored}`
      }
    >
      <span className="text-slate-200">{side.conducted}</span>
      <span className="text-slate-600">/</span>
      {side.kommoKnown ? (
        <span className={side.countMismatch ? "text-rose-300 font-semibold" : "text-slate-300"}>
          {side.kommoFilled}
        </span>
      ) : (
        <span className="text-slate-600">н/д</span>
      )}
      <span className="text-slate-600">/</span>
      <span className="text-slate-300">{side.scored}</span>
    </span>
  );
}

function SideCells({ side }: { side: SideAudit }) {
  return (
    <>
      <td className="px-3 py-2 text-center text-slate-300 tabular-nums">{fmtDay(side.terminIso)}</td>
      <td className="px-3 py-2 text-center">
        <CountsCell side={side} />
      </td>
      <td className="px-3 py-2 text-center">
        <BotScores side={side} />
      </td>
      <td className="px-3 py-2 text-center">
        <KommoScores side={side} />
      </td>
    </>
  );
}

export default function RoleplayAuditTable({ terminFrom, terminTo, vertical, manager }: Props) {
  const [data, setData] = useState<RoleplayAuditResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState<RoleplayAuditRow | null>(null);

  const key = `${terminFrom}|${terminTo ?? "open"}|${vertical ?? "-"}`;

  useEffect(() => {
    const ctrl = new AbortController();
    // Всё внутри таймера: синхронный setState в теле эффекта каскадит рендеры
    // (react-hooks/set-state-in-effect), а debounce всё равно нужен на смену дат.
    const id = setTimeout(() => {
      const cached = cache.get(key);
      if (cached) {
        setData(cached);
        setError(null);
        return;
      }
      setLoading(true);
      setError(null);
      const params = new URLSearchParams({ termin_from: terminFrom, limit: String(FETCH_LIMIT) });
      if (terminTo) params.set("termin_to", terminTo);
      if (vertical) params.set("vertical", vertical);
      fetch(`/api/funnel/roleplay-audit?${params}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? (r.json() as Promise<RoleplayAuditResult>) : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((j) => {
          cache.set(key, j);
          setData(j);
        })
        .catch((e) => {
          if ((e as Error).name !== "AbortError") setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => setLoading(false));
    }, 250);
    return () => {
      clearTimeout(id);
      ctrl.abort();
    };
  }, [key, terminFrom, terminTo, vertical]);

  const rows = useMemo(() => {
    if (!data) return [];
    return manager ? data.rows.filter((r) => r.managerName === manager) : data.rows;
  }, [data, manager]);

  // Новая выборка — обратно на первую страницу (без эффекта, см. react.dev).
  const [seenRows, setSeenRows] = useState(rows);
  if (seenRows !== rows) {
    setSeenRows(rows);
    setVisible(PAGE_SIZE);
  }

  // Итоги считаем по видимой выборке: с фильтром по менеджеру серверные totals
  // (по всем) вводили бы в заблуждение.
  const totals = useMemo(() => {
    let conducted = 0;
    let scored = 0;
    let kommoFilled = 0;
    let insufficient = 0;
    let degenerate = 0;
    let mismatchLeads = 0;
    let unknownLeads = 0;
    for (const r of rows) {
      if (!r.dc.kommoKnown) unknownLeads += 1;
      for (const s of [r.dc, r.aa]) {
        conducted += s.conducted;
        scored += s.scored;
        kommoFilled += s.kommoFilled;
        insufficient += s.notScored.insufficient;
        degenerate += s.notScored.degenerate;
      }
      if (r.dc.countMismatch || r.aa.countMismatch || r.dc.scoreMismatch || r.aa.scoreMismatch) {
        mismatchLeads += 1;
      }
    }
    return { conducted, scored, kommoFilled, insufficient, degenerate, mismatchLeads, unknownLeads };
  }, [rows]);

  if (error) {
    return (
      <div className="glass-panel rounded-2xl border border-rose-500/30 bg-rose-500/5 px-4 py-3 text-sm text-rose-300 flex items-center gap-2">
        <TriangleAlert className="w-4 h-4 shrink-0" />
        <span className="truncate">Не удалось загрузить таблицу ролевок: {error}</span>
      </div>
    );
  }
  if (!data && loading) {
    return (
      <div className="glass-panel rounded-2xl border border-white/5 px-4 py-8 flex items-center justify-center gap-2 text-sm text-slate-400">
        <Loader2 className="w-4 h-4 animate-spin" /> Загрузка ролевок…
      </div>
    );
  }
  if (!data || rows.length === 0) return null;

  const shown = rows.slice(0, visible);
  const scoredPct = totals.conducted > 0 ? Math.round((totals.scored / totals.conducted) * 100) : null;

  return (
    <div className="glass-panel rounded-2xl border border-white/5 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/5 flex-wrap">
        <ClipboardCheck className="w-4 h-4 text-violet-400" />
        <span className="text-sm font-medium text-slate-200">Ролевки</span>
        <span className="text-xs text-slate-500 tabular-nums">
          показано {Math.min(visible, rows.length)} из {rows.length}
        </span>
        <span className="text-[11px] text-slate-500 ml-auto">
          провед./в Kommo/оценено · клик по строке — детализация
        </span>
      </div>

      <div className="overflow-auto max-h-[520px]">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-slate-900/80 backdrop-blur z-10">
            <tr className="text-[10px] uppercase tracking-widest font-semibold text-slate-500">
              <th className="px-3 py-2 text-left" rowSpan={2}>Клиент</th>
              <th className="px-3 py-2 text-left" rowSpan={2}>Менеджер</th>
              <th className="px-3 py-2 text-left" rowSpan={2}>Этап</th>
              <th className="px-3 py-2 text-center" rowSpan={2} title="Соединённых звонков по сделке (в скобках — сколько разобрано ОКК как консультации)">
                Звонки
              </th>
              <th className="px-3 py-2 text-center border-l border-white/5" colSpan={4}>ДЦ</th>
              <th className="px-3 py-2 text-center border-l border-white/5" colSpan={4}>АА</th>
            </tr>
            <tr className="text-[10px] uppercase tracking-widest font-semibold text-slate-500">
              <th className="px-3 py-1.5 text-center border-l border-white/5">Термин</th>
              <th className="px-3 py-1.5 text-center">Ролевки</th>
              <th className="px-3 py-1.5 text-center">Бот</th>
              <th className="px-3 py-1.5 text-center">Kommo</th>
              <th className="px-3 py-1.5 text-center border-l border-white/5">Термин</th>
              <th className="px-3 py-1.5 text-center">Ролевки</th>
              <th className="px-3 py-1.5 text-center">Бот</th>
              <th className="px-3 py-1.5 text-center">Kommo</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr
                key={r.leadId}
                tabIndex={0}
                onClick={() => setSelected(r)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelected(r);
                  }
                }}
                className="border-t border-white/5 hover:bg-violet-500/5 focus:bg-violet-500/10 cursor-pointer outline-none"
              >
                <td className="px-3 py-2 max-w-[200px] truncate">
                  <a
                    href={kommoUrl(r.leadId)}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="text-slate-200 hover:text-blue-300 inline-flex items-center gap-1"
                    title="Открыть карточку в Kommo"
                  >
                    {r.name}
                    <ExternalLink className="w-3 h-3 opacity-50 shrink-0" />
                  </a>
                </td>
                <td className="px-3 py-2 text-slate-300 max-w-[160px] truncate">{r.managerName ?? "—"}</td>
                <td className="px-3 py-2 text-slate-400 max-w-[190px] truncate">{r.status ?? "—"}</td>
                <td className="px-3 py-2 text-center text-slate-300 tabular-nums">
                  {r.callsTotal}
                  <span className="text-slate-500"> ({r.callsOkk})</span>
                </td>
                <SideCells side={r.dc} />
                <SideCells side={r.aa} />
              </tr>
            ))}
          </tbody>
          <tfoot className="sticky bottom-0 bg-slate-900/90 backdrop-blur">
            <tr className="border-t border-white/10 text-xs text-slate-300">
              <td className="px-3 py-2.5" colSpan={12}>
                Ролевок проведено{" "}
                <b className="text-slate-100 tabular-nums">{totals.conducted}</b> · оценено{" "}
                <b className="text-slate-100 tabular-nums">{totals.scored}</b>
                {scoredPct !== null && <span className="text-slate-500"> ({scoredPct}%)</span>} · не оценено{" "}
                <span className="text-slate-400 tabular-nums">
                  {totals.insufficient} ○ / {totals.degenerate} ⚠
                </span>{" "}
                · выставлено в Kommo{" "}
                <b className="text-slate-100 tabular-nums">{totals.kommoFilled}</b> · расхождений{" "}
                <b className={totals.mismatchLeads > 0 ? "text-rose-300 tabular-nums" : "text-slate-100 tabular-nums"}>
                  {totals.mismatchLeads}
                </b>{" "}
                <span className="text-slate-500">сделок</span>
                {totals.unknownLeads > 0 && (
                  <span className="text-slate-500" title="Сделки без слепка полей Kommo — не пересинканы после включения слотов; в расхождения не входят">
                    {" "}· без данных Kommo{" "}
                    <b className="text-slate-400 tabular-nums">{totals.unknownLeads}</b>
                  </span>
                )}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {visible < rows.length && (
        <div className="px-4 py-2.5 border-t border-white/5 flex justify-center">
          <button
            type="button"
            onClick={() => setVisible((v) => v + PAGE_SIZE)}
            className="text-xs text-slate-400 hover:text-white px-3 py-1 rounded-md hover:bg-white/5"
          >
            Показать ещё {Math.min(PAGE_SIZE, rows.length - visible)}
          </button>
        </div>
      )}

      {selected && <RoleplayDetailDrawer row={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

// ── Drawer детализации ───────────────────────────────────────────────────────

function RoleplayDetailDrawer({ row, onClose }: { row: RoleplayAuditRow; onClose: () => void }) {
  const [calls, setCalls] = useState<RoleplayCallDetail[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/funnel/roleplay-audit/${row.leadId}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? (r.json() as Promise<{ calls: RoleplayCallDetail[] }>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => setCalls(j.calls ?? []))
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setErr(e instanceof Error ? e.message : String(e));
      });
    return () => ctrl.abort();
  }, [row.leadId]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />
      <div className="relative w-full max-w-2xl h-full bg-slate-900 border-l border-white/10 shadow-2xl flex flex-col">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-white/5">
          <ClipboardCheck className="w-4 h-4 text-violet-400" />
          <div className="min-w-0">
            <div className="text-sm font-medium text-slate-200 truncate">{row.name}</div>
            <div className="text-[11px] text-slate-500 truncate">
              {row.managerName ?? "без менеджера"} · {row.status ?? "—"}
            </div>
          </div>
          <a
            href={kommoUrl(row.leadId)}
            target="_blank"
            rel="noreferrer"
            className="ml-auto text-xs text-slate-400 hover:text-blue-300 inline-flex items-center gap-1"
          >
            Kommo <ExternalLink className="w-3 h-3" />
          </a>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-slate-400 hover:text-white hover:bg-white/5"
            aria-label="Закрыть"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="overflow-auto p-4 flex flex-col gap-3">
          <SlotsSummary row={row} />
          {err && <div className="text-sm text-rose-300">Не удалось загрузить детализацию: {err}</div>}
          {!calls && !err && (
            <div className="flex items-center gap-2 text-sm text-slate-400 py-6 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" /> Загрузка звонков…
            </div>
          )}
          {calls?.length === 0 && (
            <div className="text-sm text-slate-500 py-6 text-center">
              По этой сделке нет консультационных звонков, разобранных ОКК.
            </div>
          )}
          {calls?.map((c) => (
            <CallCard key={c.okkCallId} call={c} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Что стоит в Kommo против того, что насчитал бот — по сторонам. */
function SlotsSummary({ row }: { row: RoleplayAuditRow }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {(["dc", "aa"] as const).map((k) => {
        const s = row[k];
        return (
          <div key={k} className="rounded-xl border border-white/5 bg-white/[0.02] p-3">
            <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1.5">
              {k === "dc" ? "ДЦ" : "АА"} · термин {fmtDay(s.terminIso)}
            </div>
            <div className="text-xs text-slate-300 flex flex-col gap-1">
              <span>
                Ролевок проведено: <b className="tabular-nums">{s.conducted}</b>, оценено ботом{" "}
                <b className="tabular-nums">{s.scored}</b>
              </span>
              <span className={s.countMismatch ? "text-rose-300" : ""}>
                Выставлено в Kommo:{" "}
                {s.kommoKnown ? (
                  <b className="tabular-nums">{s.kommoFilled}</b>
                ) : (
                  <span className="text-slate-500">нет данных</span>
                )}
                {s.countMismatch && " — не сходится"}
              </span>
              <span>
                Оценки бота: <BotScores side={s} />
              </span>
              <span className={s.scoreMismatch ? "text-rose-300" : ""}>
                Оценки в Kommo: <KommoScores side={s} />
                {s.scoreMismatch && " — расходятся"}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const STRENGTH_LABEL: Record<string, string> = {
  weak: "слабо",
  sufficient: "достаточно",
  strong: "сильно",
};

function CallCard({ call }: { call: RoleplayCallDetail }) {
  const [open, setOpen] = useState(false);
  const crits = call.criterionScores
    ? Object.entries(call.criterionScores).filter(([, c]) => c.applicable)
    : [];
  const questions = (call.questions ?? []).filter((q) => q.asked);

  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.02] overflow-hidden">
      <div className="px-3 py-2.5 flex items-center gap-2 flex-wrap">
        <span className="text-[10px] uppercase tracking-widest text-slate-500">
          {call.side === "dc" ? "ДЦ" : "АА"}
          {call.attempt !== null && ` · попытка ${call.attempt}`}
        </span>
        <span className="text-xs text-slate-400">{fmtDay(call.at)}</span>
        {call.managerName && <span className="text-xs text-slate-500 truncate">{call.managerName}</span>}
        {call.durationSeconds !== null && (
          <span className="text-xs text-slate-600 tabular-nums">
            {Math.round(call.durationSeconds / 60)} мин
          </span>
        )}
        <span className="ml-auto inline-flex items-center gap-2">
          {!call.conducted ? (
            <span className="text-xs text-slate-500">ролевки не было</span>
          ) : call.score5 !== null ? (
            <span className={`text-sm font-semibold tabular-nums ${scoreColor(call.score5)}`}>
              {call.score5}
              {call.scorePercent !== null && (
                <span className="text-xs text-slate-500 font-normal"> · {call.scorePercent}%</span>
              )}
            </span>
          ) : (
            <span className={call.notScored === "degenerate" ? "text-amber-400 text-xs" : "text-slate-400 text-xs"}>
              {call.notScored === "degenerate" ? "⚠ сбой авто-оценки" : "○ мало материала"}
            </span>
          )}
          {(crits.length > 0 || questions.length > 0) && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="text-xs text-slate-400 hover:text-white px-2 py-0.5 rounded-md hover:bg-white/5"
            >
              {open ? "свернуть" : "критерии"}
            </button>
          )}
        </span>
      </div>

      {call.gateReason && !call.score5 && (
        <div className="px-3 pb-2 text-[11px] text-slate-500">{call.gateReason}</div>
      )}

      {open && (
        <div className="border-t border-white/5 px-3 py-2.5 flex flex-col gap-3">
          {crits.length > 0 && (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[10px] uppercase tracking-widest text-slate-500">
                  <th className="text-left font-semibold py-1">Критерий</th>
                  <th className="text-right font-semibold py-1" title="Доля закрытых вопросов критерия">Покрытие</th>
                  <th className="text-right font-semibold py-1" title="Средняя сила ответов">Качество</th>
                  <th className="text-right font-semibold py-1" title="Вес после нормировки на применимые критерии">Вес</th>
                </tr>
              </thead>
              <tbody>
                {crits.map(([k, c]: [string, CriterionScore]) => (
                  <tr key={k} className="border-t border-white/5">
                    <td className="py-1 text-slate-300">{CLIENT_RP_CRITERIA[k] ?? k}</td>
                    <td className="py-1 text-right text-slate-400 tabular-nums">{Math.round(c.coverage * 100)}%</td>
                    <td className="py-1 text-right text-slate-400 tabular-nums">{Math.round(c.quality * 100)}%</td>
                    <td className="py-1 text-right text-slate-500 tabular-nums">{Math.round(c.weight * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {questions.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="text-[10px] uppercase tracking-widest text-slate-500">
                Вопросы бератора ({questions.length})
              </div>
              {questions.map((q) => (
                <div key={q.question_id} className="text-[11px] leading-snug">
                  <span className={q.covered ? "text-emerald-300" : "text-rose-300"}>
                    {q.covered ? "✓" : "✗"}
                  </span>{" "}
                  <span className="text-slate-300">{q.question_topic}</span>
                  {!q.self_produced && <span className="text-slate-500"> · повтор за менеджером</span>}
                  {q.answer_strength && (
                    <span className="text-slate-500"> · {STRENGTH_LABEL[q.answer_strength] ?? q.answer_strength}</span>
                  )}
                  {q.quote && <div className="text-slate-500 italic pl-4 truncate">«{q.quote}»</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
