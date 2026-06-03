"use client";

import { useState } from "react";
import AnalyticsTab from "@/components/AnalyticsTab";
import LookerTab from "@/components/LookerTab";

/**
 * B2B-only обёртка: встраивает Looker в «Аналитику» переключателем
 * [ Аналитика | Looker ], вместо отдельной вкладки сайдбара. По запросу Рузанны;
 * у Госников Looker остаётся отдельной вкладкой (см. dev_docs/13-РАЗДЕЛЕНИЕ-B2G-B2B.md §8).
 *
 * Внутренности AnalyticsTab/LookerTab не трогаем — рендерим активный под-вид.
 * Ленивость: неактивный под-вид не смонтирован, поэтому его тяжёлый fetch не идёт.
 */
export default function AnalyticsLookerSwitch({ department }: { department: "b2g" | "b2b" }) {
  const [view, setView] = useState<"analytics" | "looker">("analytics");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex bg-slate-800/50 p-1 rounded-xl border border-white/5 shadow-inner w-fit">
        {([
          { id: "analytics", label: "Аналитика" },
          { id: "looker", label: "Looker" },
        ] as const).map((v) => (
          <button
            key={v.id}
            onClick={() => setView(v.id)}
            className={`px-5 py-2 rounded-lg text-xs font-semibold tracking-wide transition-all duration-300 ${
              view === v.id
                ? "bg-gradient-to-r from-blue-500 to-cyan-500 text-white shadow-lg"
                : "text-slate-400 hover:text-white"
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>

      {view === "analytics" ? (
        <AnalyticsTab department={department} />
      ) : (
        <LookerTab department={department} />
      )}
    </div>
  );
}
