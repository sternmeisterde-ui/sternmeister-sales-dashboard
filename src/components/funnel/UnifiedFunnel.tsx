"use client";

import { ChevronDown } from "lucide-react";
import type { OverviewFunnelStage } from "@/lib/funnel/api-types";
import { fmtCount, fmtPercent } from "@/lib/funnel/format";

/**
 * Объединённая накопительная воронка (ТЗ §9.2): «Новый лид → Гутшайн».
 * Ширина бара ∝ количеству от первого этапа. Между этапами — % перехода
 * и среднее время перехода.
 */
export default function UnifiedFunnel({
  stages,
  loading = false,
}: {
  stages: OverviewFunnelStage[];
  loading?: boolean;
}) {
  const max = stages.length > 0 ? stages[0].count : 0;

  return (
    <section
      aria-label="Объединённая воронка"
      className="glass-panel rounded-2xl border border-white/5 p-4 flex flex-col gap-1.5 h-full"
    >
      <div className="flex items-baseline justify-between mb-1">
        <h3 className="text-base font-semibold text-white">Объединённая воронка</h3>
        <span className="text-[11px] text-slate-400">
          Новый лид → Гутшайн · накопительно
        </span>
      </div>

      {stages.length === 0 && !loading ? (
        <div className="text-center py-8 text-slate-500 text-sm">
          Нет данных по выбранным фильтрам
        </div>
      ) : (
        /* Полная лестница (18 ступеней) выше прежних 9 — высоту блока задаёт
           родитель (на lg+ = колонка KPI-карточек), список скроллится внутри
           (touch-свайп нативный). На мобиле — кап max-h, иначе блок бесконечный. */
        <div className="flex flex-col gap-1 flex-1 min-h-0 max-h-[480px] lg:max-h-none overflow-y-auto pr-1 overscroll-contain">
        {stages.map((s, i) => {
          const widthPct = max > 0 ? Math.max(2, (s.count / max) * 100) : 0;
          const next = stages[i + 1];
          return (
            <div key={s.key} className="flex flex-col gap-1">
              {/* Этап */}
              <div className="flex items-center gap-3">
                <div className="w-32 sm:w-40 shrink-0 text-[11px] sm:text-xs text-slate-300 text-right leading-tight">
                  {s.label}
                </div>
                <div className="flex-1 relative h-6 rounded-md bg-slate-800/40 overflow-hidden">
                  <div
                    className="absolute inset-y-0 left-0 rounded-md bg-gradient-to-r from-blue-500/60 to-cyan-500/45 transition-[width] duration-500"
                    style={{ width: loading ? "0%" : `${widthPct}%` }}
                  />
                  <div className="absolute inset-0 flex items-center px-2">
                    <span
                      className={`text-xs font-bold tabular-nums ${
                        loading ? "text-slate-600 animate-pulse" : "text-white"
                      }`}
                    >
                      {loading ? "…" : fmtCount(s.count)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Переход к следующему этапу */}
              {next && (
                <div className="flex items-center gap-3">
                  <div className="w-32 sm:w-40 shrink-0" />
                  <div className="flex-1 flex items-center gap-1.5 pl-2 text-[10px] leading-none text-slate-500">
                    <ChevronDown className="w-2.5 h-2.5 shrink-0" />
                    <span className="tabular-nums text-slate-400 font-semibold">
                      {fmtPercent(next.transitionPctFromPrev, 1)}
                    </span>
                    <span className="text-slate-600">·</span>
                    <span className="tabular-nums">
                      {next.avgDaysFromPrev === null
                        ? "ср. —"
                        : `ср. ${Math.round(next.avgDaysFromPrev)} дн`}
                    </span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        </div>
      )}
    </section>
  );
}
