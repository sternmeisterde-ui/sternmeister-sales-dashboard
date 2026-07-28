"use client";

import { useEffect, useState } from "react";
import { Loader2, X, ExternalLink, ClipboardCheck } from "lucide-react";
import type { RoleplayCallDetail, CriterionScore } from "@/lib/funnel/roleplay-detail";
import { CLIENT_RP_CRITERIA } from "@/lib/funnel/roleplay-detail";

interface Props {
  leadId: number;
  name: string;
  managerName: string | null;
  onClose: () => void;
}

const STRENGTH_LABEL: Record<string, string> = {
  weak: "слабо",
  sufficient: "достаточно",
  strong: "сильно",
};

function scoreColor(s: number): string {
  if (s >= 4) return "text-emerald-300";
  if (s === 3) return "text-amber-300";
  return "text-rose-300";
}

function fmtDay(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", timeZone: "Europe/Berlin" });
}

/**
 * Карточка сделки: все консультационные звонки, разобранные ОКК, с баллом
 * клиента, разбивкой по 6 критериям и разбором по вопросам банка бератора.
 */
export default function RoleplayDetailDrawer({ leadId, name, managerName, onClose }: Props) {
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
    fetch(`/api/funnel/roleplays-section/${leadId}`, { signal: ctrl.signal })
      .then((r) =>
        r.ok ? (r.json() as Promise<{ calls: RoleplayCallDetail[] }>) : Promise.reject(new Error(`HTTP ${r.status}`)),
      )
      .then((j) => setCalls(j.calls ?? []))
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setErr(e instanceof Error ? e.message : String(e));
      });
    return () => ctrl.abort();
  }, [leadId]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />
      <div className="relative w-full max-w-2xl h-full bg-slate-900 border-l border-white/10 shadow-2xl flex flex-col">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-white/5">
          <ClipboardCheck className="w-4 h-4 text-blue-400" />
          <div className="min-w-0">
            <div className="text-sm font-medium text-slate-200 truncate">{name}</div>
            <div className="text-[11px] text-slate-500 truncate">{managerName ?? "без менеджера"}</div>
          </div>
          <a
            href={`https://sternmeister.kommo.com/leads/detail/${leadId}`}
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
          {err && <div className="text-sm text-rose-300">Не удалось загрузить детализацию: {err}</div>}
          {!calls && !err && (
            <div className="flex items-center gap-2 text-sm text-slate-400 py-6 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" /> Загрузка звонков…
            </div>
          )}
          {calls?.length === 0 && (
            <div className="text-sm text-slate-500 py-6 text-center">
              По этой сделке ОКК не разбирал ни одной консультации — все звонки короче 15 минут.
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
          <span className="text-xs text-slate-600 tabular-nums">{Math.round(call.durationSeconds / 60)} мин</span>
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

      {call.gateReason && call.score5 === null && (
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
                  <span className={q.covered ? "text-emerald-300" : "text-rose-300"}>{q.covered ? "✓" : "✗"}</span>{" "}
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
