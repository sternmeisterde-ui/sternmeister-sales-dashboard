"use client";

import { useMemo } from "react";
import { Line, LineChart, ResponsiveContainer, ReferenceLine } from "recharts";
import type {
  CohortWeek,
  ConversionId,
  ConversionMeta,
  ConversionSummary,
} from "@/lib/funnel/types";
import { fmtPercent, fmtCount, fmtDeltaPp } from "@/lib/funnel/format";

interface ConversionsBundle {
  meta: ConversionMeta;
  cohorts: CohortWeek[];
  summary: ConversionSummary;
}

interface Props {
  conversions: Record<ConversionId, ConversionsBundle>;
  activeId: ConversionId;
  onSelect: (id: ConversionId) => void;
}

/**
 * Порядок карточек: C1 → C1.1 → C2 → C2.1 → C3 → C3.1 → C4 → C5 (8 карточек).
 * C1.1/C2.1 — «чистые» варианты C1/C2 без лидов с причиной «Игнор».
 * C3.1 — «Термин ДЦ → дошёл до АА» (отсев после состоявшегося ДЦ).
 */
const CARD_ORDER: ConversionId[] = [
  "C1",
  "C1.1",
  "C2",
  "C2.1",
  "C3",
  "C3.1",
  "C4",
  "C5",
];

export default function ConversionCards({
  conversions,
  activeId,
  onSelect,
}: Props) {
  // Период sparkline (последние 8 недель с непустой conversionPct) —
  // ВЫНОСИМ один раз над всеми карточками. У всех конверсий он практически
  // одинаковый (когорты идут по тем же неделям); берём базу из C1.
  const sparklinePeriod = (() => {
    const base = conversions.C1;
    if (!base) return null;
    const pts = base.cohorts
      .filter((c) => c.conversionPct !== null)
      .slice(-8);
    if (pts.length === 0) return null;
    if (pts.length === 1) return pts[0].isoLabel;
    return `${pts[0].isoLabel} – ${pts[pts.length - 1].isoLabel}`;
  })();

  return (
    <section aria-label="Карточки конверсий" className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between px-1">
        <span className="text-[10px] uppercase tracking-widest font-semibold text-slate-500">
          Конверсии C1–C5
        </span>
        <span className="text-[10px] uppercase tracking-widest font-semibold text-slate-500 tabular-nums">
          Тренд:{" "}
          <span className="text-slate-400">{sparklinePeriod ?? "—"}</span>
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
        {CARD_ORDER.map((id) => (
          <ConversionCard
            key={id}
            bundle={conversions[id]}
            isActive={id === activeId}
            onSelect={() => onSelect(id)}
          />
        ))}
      </div>
    </section>
  );
}

function ConversionCard({
  bundle,
  isActive,
  onSelect,
}: {
  bundle: ConversionsBundle;
  isActive: boolean;
  onSelect: () => void;
}) {
  const { meta, cohorts, summary } = bundle;

  // Sparkline: последние 8 точек с непустой conversionPct.
  const sparklineData = useMemo(
    () =>
      cohorts
        .filter((c) => c.conversionPct !== null)
        .slice(-8)
        .map((c) => ({
          x: c.isoLabel,
          y: c.conversionPct,
        })),
    [cohorts]
  );

  // Диапазон НЕЗРЕЛЫХ когорт — что ещё «дозревает» и не учитывается в средней.
  const immatureRange = useMemo(() => {
    const immature = cohorts.filter((c) => c.maturityState !== "mature");
    if (immature.length === 0) return null;
    const first = immature[0];
    const last = immature[immature.length - 1];
    const fmt = (d: Date) =>
      d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
    return `${fmt(first.weekStart)}–${fmt(last.weekEnd)}`;
  }, [cohorts]);

  const deltaTone =
    summary.benchmarkDelta === null
      ? null
      : summary.benchmarkDelta < 0
        ? "rose"
        : summary.benchmarkDelta > 0
          ? "emerald"
          : "slate";

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`glass-panel rounded-xl border px-3 py-2.5 text-left transition-all duration-200 flex flex-col gap-1.5 min-w-0 ${
        isActive
          ? "border-blue-400/40 bg-blue-500/5 shadow-[inset_0_1px_1px_rgba(255,255,255,0.08)]"
          : "border-white/5 hover:border-white/15 hover:bg-white/[0.02]"
      }`}
      aria-pressed={isActive}
    >
      {/* Линия 1: id + delta */}
      <div className="flex items-baseline justify-between">
        <span
          className={`text-xs font-bold uppercase tracking-widest ${
            isActive ? "text-blue-300" : "text-slate-300"
          }`}
        >
          {meta.id}
        </span>
        {summary.benchmarkDelta !== null && deltaTone && (
          <span
            className={`text-xs font-bold tabular-nums ${
              deltaTone === "rose"
                ? "text-rose-400"
                : deltaTone === "emerald"
                  ? "text-emerald-400"
                  : "text-slate-400"
            }`}
          >
            {fmtDeltaPp(summary.benchmarkDelta)}
          </span>
        )}
      </div>

      {/* Линия 2: компактное описание (2 строки максимум) */}
      <div className="text-[11px] text-slate-400 leading-snug line-clamp-2 min-h-[28px]">
        {meta.label}
      </div>

      {/* Линия 3: главная цифра + база */}
      <div className="flex items-baseline justify-between gap-1.5">
        <div className="text-xl font-bold text-white tabular-nums leading-none">
          {fmtPercent(summary.matureAvgPct, 1)}
        </div>
        <div className="text-[10px] text-slate-500 tabular-nums whitespace-nowrap">
          {fmtCount(summary.matureBase)} лидов
        </div>
      </div>

      {/* Линия 4: sparkline — статичный, никаких hover-эффектов и подсказок.
          Период вынесен в шапку секции «Конверсии C1–C5». */}
      <div className="h-7 -mx-1 pointer-events-none" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={sparklineData}
            margin={{ top: 2, right: 2, bottom: 2, left: 2 }}
          >
            {meta.benchmark !== null && (
              <ReferenceLine
                y={meta.benchmark}
                stroke="#64748b"
                strokeDasharray="2 2"
                strokeWidth={0.8}
              />
            )}
            <Line
              type="monotone"
              dataKey="y"
              stroke={isActive ? "#60a5fa" : "#10b981"}
              strokeWidth={1.5}
              dot={false}
              activeDot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Линия 5: количество зрелых когорт (из чего считается средняя) */}
      <div className="text-[10px] text-slate-500 tabular-nums">
        {summary.matureCount}/{summary.totalCount} зрелых
      </div>

      {/* Линия 6: диапазон НЕЗРЕЛЫХ — что ещё не учтено в средней */}
      <div className="text-[10px] text-slate-500 tabular-nums">
        {immatureRange ? (
          <>
            незрелые{" "}
            <span className="text-slate-400">{immatureRange}</span>
          </>
        ) : (
          <span className="text-slate-600">все зрелые</span>
        )}
      </div>

      {/* Линия 7: время созревания + цель */}
      <div className="flex items-baseline justify-between text-[10px] text-slate-500">
        <span>зреет {meta.maturityWeeks} нед.</span>
        {meta.benchmark !== null ? (
          <span className="tabular-nums">цель {meta.benchmark}%</span>
        ) : (
          <span className="text-slate-600">цель не задана</span>
        )}
      </div>
    </button>
  );
}

