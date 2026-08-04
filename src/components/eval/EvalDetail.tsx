"use client";

// Общий модуль детализации оценки ОКК/ролевок. Вынесен из AnalyticsTab.tsx
// без изменения поведения, чтобы «Детализацию оценок» могли рендерить и другие
// вкладки (Жалобы: замороженные снимки eval_before/eval_after). Данные модуль
// не фетчит — только рендерит переданный payload (форма ручек
// /api/okk/calls/[callId] и /api/calls/[callId]).

import React, { useMemo } from "react";
import { ExternalLink, Clock } from "lucide-react";

export interface EvalDetailCriterion {
  name: string; score: number | null; maxScore: number;
  feedback: string; quote: string; applicable?: boolean;
  // Секунда в записи звонка, где прозвучала цитата критерия (null — нет цитаты
  // или не удалось сматчить). Рендерим как MM:SS.
  atSecond?: number | null;
}
export interface EvalDetailBlock {
  name: string; score: number; maxScore: number; criteria: EvalDetailCriterion[];
}
export interface CallMeta {
  clientName: string | null; phone: string | null; source: string | null;
  leadCategory: string | null; stageAtCallStart: string | null; stageAtPickup: string | null;
  week: string | null; callDateTime: string | null; analyzedAt: string | null;
}
// Реплика чат-транскрипта: спикер + текст + секунда старта (для таймкода MM:SS).
export interface TranscriptTurn {
  speaker: "manager" | "client"; text: string; atSecond: number | null;
}

// «Детализация оценок» — Spellit-вид: шапка с метаданными звонка + широкая
// горизонтально-прокручиваемая таблица, где КАЖДЫЙ критерий = колонка
// (двухрядная шапка: блок → критерий с номером/баллом; тело — Причина +
// Цитата с таймкодом MM:SS). Состав
// полей — по спеке dev_docs/Книга1.xlsx (серые колонки; красные исключены).
// Причина/цитата заполнены у оценок criteria-engine (~с мая 2026); у legacy
// звонков поля пустые — рендерим только то, что есть.
// Пороги цвета оценки (90/70) — единые для бейджа в шапке и блоков.
// [Auto-override…]-маркеры движка срезаются на стороне API (см.
// api/okk/calls/[callId]/route.ts stripEngineTags) — здесь feedback уже чистый.
export function scoreTone(pct: number): string {
  return pct >= 90 ? "text-emerald-400" : pct >= 70 ? "text-amber-400" : "text-rose-400";
}

// Секунды → MM:SS для таймкода критерия в записи звонка.
export function fmtMmSs(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// Бейдж вердикта критерия (✓1 / ✗0 / N/M / Пусто / Инфо / —). Вынесен, чтобы
// шапка-колонка горизонтальной детализации и любые списки критериев красили
// балл одинаково.
export function CriterionBadge({ c }: { c: EvalDetailCriterion }) {
  const isEmpty = c.applicable === false;
  const isInfo = !isEmpty && c.maxScore === 0;
  // null (нераспознанный вердикт, okk) и -1 (то же у ролевок) — «не оценён».
  const isUnscored = !isEmpty && !isInfo && (c.score == null || c.score < 0);
  const passed = !isEmpty && !isInfo && !isUnscored && (c.score ?? 0) >= c.maxScore;
  const base = "shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold";
  if (isEmpty) return <span className={`${base} uppercase tracking-wider bg-slate-700/40 text-slate-400`}>Пусто</span>;
  if (isUnscored) return <span className={`${base} bg-slate-700/40 text-slate-400`} title="Вердикт не распознан">—</span>;
  if (isInfo) return <span className={`${base} uppercase tracking-wider bg-blue-500/15 text-blue-400`}>Инфо</span>;
  if (c.maxScore > 1) return <span className={`${base} bg-purple-500/15 text-purple-300`}>{c.score}/{c.maxScore}</span>;
  if (passed) return <span className={`${base} bg-emerald-500/15 text-emerald-400`}>✓ 1</span>;
  return <span className={`${base} bg-rose-500/15 text-rose-400`}>✗ 0</span>;
}

export function EvalDetailView({ blocks, meta, kommoUrl, duration, manager, score, totalMaxScore, totalRawScore }: {
  blocks: EvalDetailBlock[];
  meta?: CallMeta;
  kommoUrl?: string;
  duration: string;
  manager: string;
  score?: number;
  totalMaxScore?: number;
  totalRawScore?: number;
}) {
  const metaRows: Array<[string, string | null | undefined]> = [
    [
      "Общая оценка",
      typeof score === "number"
        ? `${score}%${totalMaxScore != null && totalRawScore != null ? ` (${totalRawScore}/${totalMaxScore} баллов)` : ""}`
        : null,
    ],
    ["Дата звонка", meta?.callDateTime],
    ["Неделя звонка", meta?.week],
    ["Длительность", duration],
    ["Менеджер", manager],
    ["Клиент", meta?.clientName],
    ["Телефон", meta?.phone],
    ["Источник", meta?.source],
    ["Категория лида", meta?.leadCategory],
    ["Этап в начале звонка", meta?.stageAtCallStart],
    ["Этап при заборе звонка", meta?.stageAtPickup],
    ["Дата анализа", meta?.analyzedAt],
  ];

  // В горизонтальную таблицу берём только блоки с критериями: legacy
  // feedback-only блоки (criteria=[]) дали бы лишнюю ячейку-шапку без колонки
  // под ней и сломали бы выравнивание colSpan.
  const tableBlocks = blocks.filter((b) => b.criteria.length > 0);

  // Сквозная нумерация критериев 1..N через все блоки — как id в конфиге
  // критериев (src/criteria/*.json) и в Spellit-таблице. offset[bi] = сколько
  // критериев в предыдущих блоках; номер критерия = offset + ci + 1.
  const blockOffsets = tableBlocks.reduce<number[]>((acc, _b, i) => {
    acc.push(i === 0 ? 0 : acc[i - 1] + tableBlocks[i - 1].criteria.length);
    return acc;
  }, []);

  // Метаданные звонка — колонки справа (каждое поле = своя колонка, как
  // критерии). Kommo-ссылка идёт последним столбцом.
  const metaItems: Array<{ label: string; node: React.ReactNode }> = metaRows
    .filter(([, v]) => v)
    .map(([label, value]) => ({ label, node: value as React.ReactNode }));
  if (kommoUrl && kommoUrl !== "#") {
    metaItems.push({
      label: "Сделка",
      node: (
        <a href={kommoUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 inline-flex items-center gap-1 break-all">
          <ExternalLink className="w-3 h-3 shrink-0" /> Открыть в Kommo
        </a>
      ),
    });
  }

  return (
    <div className="flex flex-col">
      {/* Горизонтальная детализация: критерии — колонки (как в Spellit-таблице).
          Метаданные звонка — отдельная колонка «Данные звонка» справа. Скролл
          только по горизонтали: высота ячеек ограничена, вертикали нет. Шапка в
          два ряда: блок (colSpan над критериями) + критерий (номер/название/балл).
          Тело — одна строка: Причина + Цитата с MM:SS. */}
      {tableBlocks.length === 0 ? (
        <div className="py-10 text-center text-slate-500 text-sm">Нет критериев для отображения</div>
      ) : (
      <div className="overflow-x-auto rounded-xl border border-white/5 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">
        <table className="border-separate border-spacing-0 text-left">
          <thead>
            {/* Ряд 1 — метаданные (слева) + блоки (этапы) */}
            <tr>
              {/* Данные звонка — компактный блок слева (как бывшая верхняя
                  шапка: сетка подпись/значение в 2 колонки, а не длинный
                  вертикальный список — иначе съедает высоту) */}
              {metaItems.length > 0 && (
                <th
                  rowSpan={2}
                  className="sticky top-0 z-20 align-top p-3 border-b border-white/10 bg-slate-900/95 backdrop-blur-sm min-w-[420px] max-w-[460px] w-[440px]"
                >
                  <span className="text-[11px] font-bold uppercase tracking-wider text-slate-300 whitespace-nowrap">Данные звонка</span>
                </th>
              )}
              {tableBlocks.map((b, bi) => {
                const pct = b.maxScore > 0 ? Math.round((b.score / b.maxScore) * 100) : null;
                return (
                  <th
                    key={`blk-${bi}-${b.name}`}
                    colSpan={Math.max(1, b.criteria.length)}
                    className={`sticky top-0 z-20 h-9 px-3 border-b border-white/10 bg-slate-900/95 backdrop-blur-sm text-left ${bi === 0 ? "border-l-2 border-l-white/20" : "border-l border-l-white/10"}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-slate-300 whitespace-nowrap">{b.name}</span>
                      {pct != null && (
                        <span className="text-[10px] font-bold text-slate-400 whitespace-nowrap">
                          {b.score}/{b.maxScore} · <span className={scoreTone(pct)}>{pct}%</span>
                        </span>
                      )}
                    </div>
                  </th>
                );
              })}
            </tr>
            {/* Ряд 2 — критерии (колонка метаданных занята rowSpan из ряда 1) */}
            <tr>
              {tableBlocks.flatMap((b, bi) =>
                b.criteria.map((c, ci) => (
                  <th
                    key={`crit-${bi}-${ci}-${c.name}`}
                    style={{ top: 36 }}
                    className={`sticky z-10 align-top p-2.5 border-b border-white/10 bg-slate-900/95 backdrop-blur-sm min-w-[260px] max-w-[300px] w-[280px] ${bi === 0 && ci === 0 ? "border-l-2 border-l-white/20" : "border-l border-l-white/10"}`}
                  >
                    <div className="flex items-start gap-2">
                      <CriterionBadge c={c} />
                      <span className="text-[12px] font-semibold text-slate-200 leading-snug whitespace-normal break-words">
                        <span className="text-slate-500 tabular-nums">{blockOffsets[bi] + ci + 1}.</span> {c.name}
                      </span>
                    </div>
                  </th>
                )),
              )}
            </tr>
          </thead>
          <tbody>
            {/* Одна строка данных = один звонок */}
            <tr>
              {/* Данные звонка — компактная сетка 2×N (подпись + значение) */}
              {metaItems.length > 0 && (
                <td className="align-top p-3 min-w-[420px] max-w-[460px] w-[440px]">
                  <div className="max-h-[52vh] overflow-y-auto pr-1 grid grid-cols-2 gap-x-4 gap-y-2.5">
                    {metaItems.map((m) => (
                      <div key={m.label} className="min-w-0">
                        <div className="text-[10px] uppercase tracking-wider text-slate-500">{m.label}</div>
                        <div className="text-[12px] text-slate-200 break-words">{m.node}</div>
                      </div>
                    ))}
                  </div>
                </td>
              )}
              {tableBlocks.flatMap((b, bi) =>
                b.criteria.map((c, ci) => (
                  <td
                    key={`cell-${bi}-${ci}-${c.name}`}
                    className={`align-top p-2.5 min-w-[260px] max-w-[300px] w-[280px] ${bi === 0 && ci === 0 ? "border-l-2 border-l-white/20" : "border-l border-white/5"}`}
                  >
                    <div className="max-h-[52vh] overflow-y-auto pr-1 flex flex-col gap-2">
                      {c.feedback ? (
                        <div>
                          <div className="text-[9px] uppercase tracking-wider text-slate-500 mb-0.5">Причина</div>
                          <p className="text-[12px] text-slate-400 leading-relaxed whitespace-pre-wrap break-words">{c.feedback}</p>
                        </div>
                      ) : null}
                      {c.quote ? (
                        <div>
                          <div className="flex items-center gap-1.5 mb-0.5">
                            <span className="text-[9px] uppercase tracking-wider text-slate-500">Цитата</span>
                            {c.atSecond != null && (
                              <span
                                className="inline-flex items-center gap-0.5 text-[10px] font-mono tabular-nums text-slate-500"
                                title="Момент в записи звонка, где прозвучала цитата"
                              >
                                <Clock className="w-3 h-3" /> {fmtMmSs(c.atSecond)}
                              </span>
                            )}
                          </div>
                          <blockquote className="text-[11px] text-slate-500 leading-relaxed border-l-2 border-slate-600 pl-2.5 whitespace-pre-wrap break-words">
                            {c.quote}
                          </blockquote>
                        </div>
                      ) : null}
                      {!c.feedback && !c.quote && (
                        <span className="text-[11px] text-slate-600 italic">—</span>
                      )}
                    </div>
                  </td>
                )),
              )}
            </tr>
          </tbody>
        </table>
      </div>
      )}
    </div>
  );
}

// Чат-вид транскрипта (пузыри Продавец/Клиент), как в модалке ОКК Госников
// (src/app/page.tsx, «Детальная Расшифровка»). Понимает оба формата меток:
// `[Продавец]:`/`[Клиент]:` (ОКК R2/D2, buildSpeakerTranscript) и
// `Менеджер:`/`Клиент:` (ролевки R1/D1). Если меток нет вовсе (сырой
// транскрипт без диаризации) — падаем обратно на сплошной текст, чтобы не
// красить весь разговор «Клиентом».
export function TranscriptView({ transcript, turns }: { transcript: string; turns?: TranscriptTurn[] }) {
  // Источник реплик: структурированные turns (со спикером и таймкодом) —
  // приоритетно; иначе парсим строковый транскрипт (легаси, без таймкодов).
  const { rows, hasLabels } = useMemo(() => {
    if (turns && turns.length) {
      return {
        rows: turns.map((t) => ({
          isManager: t.speaker === "manager",
          text: t.text,
          atSecond: t.atSecond,
        })),
        hasLabels: true,
      };
    }
    const lines = transcript.split("\n").filter((l) => l.trim());
    const labelled = lines.some(
      (l) => l.includes("[Продавец]") || l.includes("[Клиент]") || /^(Менеджер|Клиент):/.test(l),
    );
    // Строка без метки — продолжение предыдущей реплики (utterance с \n
    // внутри), а не новая реплика «Клиента»: наследует спикера и клеится
    // к текущему ходу.
    const acc: Array<{ isManager: boolean; text: string; atSecond: number | null }> = [];
    for (const line of lines) {
      const hasLabel =
        line.includes("[Продавец]") || line.includes("[Клиент]") || /^(Менеджер|Клиент):/.test(line);
      const isManager = line.includes("[Продавец]") || line.startsWith("Менеджер:");
      const clean = line
        .replace(/^\[Продавец\]:\s*/, "")
        .replace(/^\[Клиент\]:\s*/, "")
        .replace(/^(Менеджер:|Клиент:)\s*/, "");
      if (!clean.trim()) continue;
      const last = acc[acc.length - 1];
      if (!hasLabel && last) last.text += `\n${clean}`;
      else acc.push({ isManager: hasLabel ? isManager : false, text: clean, atSecond: null });
    }
    return { rows: acc, hasLabels: labelled };
  }, [transcript, turns]);

  if (!hasLabels) {
    // Сырой транскрипт без диаризации — жирный тёмный текст (transcript-plain
    // перекрашивается в светлой теме, см. globals.css).
    return (
      <div className="transcript-plain text-[12px] font-semibold text-slate-200 leading-relaxed whitespace-pre-wrap max-h-[55vh] overflow-y-auto">
        {transcript}
      </div>
    );
  }

  return (
    <div className="text-[12px] leading-relaxed max-h-[55vh] overflow-y-auto flex flex-col gap-3 pr-2 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-slate-900/50">
      {rows.map((t, idx) => (
        <div key={idx} className={`flex ${t.isManager ? "justify-end" : "justify-start"} w-full`}>
          <div className={`flex flex-col gap-1 ${t.isManager ? "items-end" : "items-start"} max-w-[75%]`}>
            <span className={`text-[10px] uppercase tracking-wider font-bold px-2 flex items-center gap-1.5 ${t.isManager ? "text-blue-400" : "text-emerald-400"}`}>
              {t.isManager ? "Продавец" : "Клиент"}
              {t.atSecond != null && (
                <span className="inline-flex items-center gap-0.5 font-mono normal-case tracking-normal text-slate-500">
                  <Clock className="w-3 h-3" /> {fmtMmSs(t.atSecond)}
                </span>
              )}
            </span>
            {/* transcript-bubble-* перекрашиваются в светлой теме (globals.css):
                тёмный текст на читаемой заливке. font-semibold — жирный текст. */}
            <div className={`p-3 rounded-2xl whitespace-pre-wrap font-semibold ${t.isManager
              ? "transcript-bubble-manager bg-blue-500/15 text-slate-100 rounded-tr-none border border-blue-500/30 shadow-sm"
              : "transcript-bubble-client bg-emerald-500/10 text-slate-100 rounded-tl-none border border-emerald-500/20 shadow-sm"
            }`}>
              {t.text}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
