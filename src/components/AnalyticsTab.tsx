"use client";

import { useState, useEffect, useCallback } from "react";
import { RefreshCw, AlertTriangle, Loader2 } from "lucide-react";
import DinoLoader from "@/components/DinoLoader";

// ==================== Types ====================

interface BlockScore {
  blockName: string;
  scores: Record<string, number>;
}

interface ClientScoringEntry {
  type: "urgency" | "solvency" | "need";
  distribution: Record<string, { hot: number; warm: number; cold: number }>;
}

interface AnalyticsData {
  department: string;
  months: string[];
  blockScores: BlockScore[];
  clientScoring: ClientScoringEntry[];
  categories: Record<string, Record<string, number>>;
  overallScores: Record<string, number>;
  callVolume: Record<string, number>;
}

// ==================== Helpers ====================

/** Returns a Tailwind text colour class based on a 0–100 score. */
function scoreColor(score: number): string {
  if (score >= 70) return "text-emerald-400";
  if (score >= 40) return "text-amber-400";
  return "text-rose-400";
}

/** Returns a subtle background tint matching the score colour. */
function scoreBg(score: number): string {
  if (score >= 70) return "bg-emerald-500/10";
  if (score >= 40) return "bg-amber-500/10";
  return "bg-rose-500/10";
}

/** Colours for lead categories A–E. */
const CATEGORY_COLOR: Record<string, string> = {
  A: "text-emerald-400",
  B: "text-blue-400",
  C: "text-amber-400",
  D: "text-orange-400",
  E: "text-rose-400",
};

const CATEGORY_BG: Record<string, string> = {
  A: "bg-emerald-500/10",
  B: "bg-blue-500/10",
  C: "bg-amber-500/10",
  D: "bg-orange-500/10",
  E: "bg-rose-500/10",
};

/** Human-readable labels for client scoring types. */
const SCORING_LABEL: Record<ClientScoringEntry["type"], string> = {
  urgency: "Срочность",
  solvency: "Платежеспособность",
  need: "Потребность",
};

/** Formats a YYYY-MM string to a short Russian month label, e.g. "Янв 25". */
function formatMonth(ym: string): string {
  const [year, month] = ym.split("-");
  const date = new Date(Number(year), Number(month) - 1, 1);
  const short = date.toLocaleDateString("ru-RU", { month: "short" });
  return `${short.charAt(0).toUpperCase()}${short.slice(1).replace(".", "")} ${String(year).slice(2)}`;
}

// ==================== Sub-components ====================

/** Shared sticky-header table wrapper. */
function SectionPanel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="glass-panel rounded-2xl p-5 border border-white/5">
      <h3 className="text-[10px] uppercase tracking-widest text-slate-300 font-bold mb-4">
        {title}
      </h3>
      <div className="overflow-x-auto">{children}</div>
    </div>
  );
}

/** Shared table header/body styles. */
const TH =
  "px-3 py-2 text-[10px] uppercase tracking-widest text-slate-500 font-semibold text-right whitespace-nowrap";
const TH_LEFT =
  "px-3 py-2 text-[10px] uppercase tracking-widest text-slate-500 font-semibold text-left whitespace-nowrap sticky left-0 bg-slate-900/80 backdrop-blur-sm z-10 min-w-[160px]";
const TD = "px-3 py-2 text-right text-sm font-mono font-bold";
const TD_LEFT =
  "px-3 py-2 text-left text-sm text-slate-300 font-medium sticky left-0 bg-slate-900/60 backdrop-blur-sm z-10 truncate max-w-[200px]";
const TR = "border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors";

// ==================== Section 1: Block quality dynamics ====================

function BlockScoresTable({
  months,
  blockScores,
  overallScores,
}: {
  months: string[];
  blockScores: BlockScore[];
  overallScores: Record<string, number>;
}) {
  return (
    <SectionPanel title="Динамика качества по блокам">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-white/10">
            <th className={TH_LEFT}>Блок</th>
            {months.map((m) => (
              <th key={m} className={TH}>
                {formatMonth(m)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {blockScores.map((block) => (
            <tr key={block.blockName} className={TR}>
              <td className={TD_LEFT}>{block.blockName}</td>
              {months.map((m) => {
                const val = block.scores[m];
                if (val === undefined || val === null) {
                  return (
                    <td key={m} className={`${TD} text-slate-600`}>
                      —
                    </td>
                  );
                }
                return (
                  <td
                    key={m}
                    className={`${TD} ${scoreColor(val)} ${scoreBg(val)}`}
                  >
                    {val}%
                  </td>
                );
              })}
            </tr>
          ))}

          {/* Overall average row */}
          <tr className="border-t-2 border-white/10 bg-slate-800/30">
            <td className={`${TD_LEFT} text-white font-bold bg-slate-800/40`}>
              Среднее
            </td>
            {months.map((m) => {
              const val = overallScores[m];
              if (val === undefined || val === null) {
                return (
                  <td key={m} className={`${TD} text-slate-600`}>
                    —
                  </td>
                );
              }
              return (
                <td
                  key={m}
                  className={`${TD} font-extrabold ${scoreColor(val)} ${scoreBg(val)}`}
                >
                  {val}%
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>
    </SectionPanel>
  );
}

// ==================== Section 2: Client scoring ====================

function ClientScoringTable({
  entry,
  months,
}: {
  entry: ClientScoringEntry;
  months: string[];
}) {
  const rows: Array<{
    label: string;
    key: keyof (typeof entry.distribution)[string];
    textColor: string;
    bgColor: string;
  }> = [
    {
      label: "Горячие (7–10)",
      key: "hot",
      textColor: "text-emerald-400",
      bgColor: "bg-emerald-500/10",
    },
    {
      label: "Тёплые (4–6)",
      key: "warm",
      textColor: "text-amber-400",
      bgColor: "bg-amber-500/10",
    },
    {
      label: "Холодные (0–3)",
      key: "cold",
      textColor: "text-rose-400",
      bgColor: "bg-rose-500/10",
    },
  ];

  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-slate-400 font-bold mb-2 mt-4">
        {SCORING_LABEL[entry.type]}
      </div>
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-white/10">
            <th className={TH_LEFT}>Сегмент</th>
            {months.map((m) => (
              <th key={m} className={TH}>
                {formatMonth(m)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ label, key, textColor, bgColor }) => (
            <tr key={key} className={TR}>
              <td className={TD_LEFT}>
                <span className={`${textColor} font-medium`}>{label}</span>
              </td>
              {months.map((m) => {
                const bucket = entry.distribution[m];
                const val = bucket ? bucket[key] : null;
                if (val === null || val === undefined) {
                  return (
                    <td key={m} className={`${TD} text-slate-600`}>
                      —
                    </td>
                  );
                }
                return (
                  <td key={m} className={`${TD} ${textColor} ${bgColor}`}>
                    {val}%
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ClientScoringSection({
  clientScoring,
  months,
}: {
  clientScoring: ClientScoringEntry[];
  months: string[];
}) {
  // Hide solvency entirely if all distribution values are null (госники)
  const visibleEntries = clientScoring.filter((entry) => {
    if (entry.type !== "solvency") return true;
    return months.some((m) => {
      const bucket = entry.distribution[m];
      return (
        bucket !== null &&
        bucket !== undefined &&
        (bucket.hot !== null || bucket.warm !== null || bucket.cold !== null)
      );
    });
  });

  if (visibleEntries.length === 0) return null;

  return (
    <SectionPanel title="Скоринг клиентов">
      <div className="overflow-x-auto">
        {visibleEntries.map((entry) => (
          <ClientScoringTable key={entry.type} entry={entry} months={months} />
        ))}
      </div>
    </SectionPanel>
  );
}

// ==================== Section 3: Lead categories ====================

function LeadCategoriesTable({
  categories,
  months,
}: {
  categories: Record<string, Record<string, number>>;
  months: string[];
}) {
  const catKeys = Object.keys(categories).sort();
  if (catKeys.length === 0) return null;

  return (
    <SectionPanel title="Категории лидов">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-white/10">
            <th className={TH_LEFT}>Категория</th>
            {months.map((m) => (
              <th key={m} className={TH}>
                {formatMonth(m)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {catKeys.map((cat) => {
            const textColor = CATEGORY_COLOR[cat] ?? "text-slate-300";
            const bgColor = CATEGORY_BG[cat] ?? "";
            return (
              <tr key={cat} className={TR}>
                <td className={TD_LEFT}>
                  <span className={`${textColor} font-bold`}>{cat}</span>
                </td>
                {months.map((m) => {
                  const val = categories[cat]?.[m];
                  if (val === undefined || val === null) {
                    return (
                      <td key={m} className={`${TD} text-slate-600`}>
                        —
                      </td>
                    );
                  }
                  return (
                    <td key={m} className={`${TD} ${textColor} ${bgColor}`}>
                      {val}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </SectionPanel>
  );
}

// ==================== Section 4: Call volume ====================

function CallVolumeSection({
  callVolume,
  months,
}: {
  callVolume: Record<string, number>;
  months: string[];
}) {
  return (
    <SectionPanel title="Объём звонков">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-white/10">
            <th className={TH_LEFT}>Показатель</th>
            {months.map((m) => (
              <th key={m} className={TH}>
                {formatMonth(m)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className={TR}>
            <td className={TD_LEFT}>Звонков за месяц</td>
            {months.map((m) => {
              const val = callVolume[m];
              if (val === undefined || val === null) {
                return (
                  <td key={m} className={`${TD} text-slate-600`}>
                    —
                  </td>
                );
              }
              return (
                <td key={m} className={`${TD} text-blue-400`}>
                  {val.toLocaleString("ru-RU")}
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>
    </SectionPanel>
  );
}

// ==================== Main component ====================

export default function AnalyticsTab({
  department,
}: {
  department: "b2g" | "b2b";
}) {
  const [months, setMonths] = useState<3 | 6 | 12>(6);
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/analytics?department=${department}&months=${months}`,
          { signal }
        );
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`API error ${res.status}: ${text}`);
        }
        const json: AnalyticsData = await res.json();
        setData(json);
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        if (e instanceof TypeError && e.message === "Failed to fetch") return;
        console.error("Analytics fetch error:", e);
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [department, months]
  );

  useEffect(() => {
    const ac = new AbortController();
    fetchData(ac.signal);
    return () => ac.abort();
  }, [fetchData]);

  // ---- Full-page loader on first load ----
  if (loading && !data) {
    return <DinoLoader />;
  }

  // ---- Full-page error (no cached data) ----
  if (error && !data) {
    return (
      <div className="glass-panel rounded-2xl p-8 border border-red-500/20 text-center">
        <AlertTriangle className="w-10 h-10 text-red-400 mx-auto mb-3" />
        <p className="text-red-400 text-sm">{error}</p>
        <button
          onClick={() => fetchData()}
          className="mt-4 px-4 py-2 bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 rounded-lg text-sm transition-colors"
        >
          Попробовать снова
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 fade-in">
      {/* ---- Filter bar ---- */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        {/* Month range selector */}
        <div className="flex bg-slate-800/50 p-1.5 rounded-xl border border-white/5 shadow-inner">
          {([3, 6, 12] as const).map((n) => (
            <button
              key={n}
              onClick={() => setMonths(n)}
              className={`px-4 py-2 rounded-lg text-[11px] uppercase tracking-widest font-bold transition-all duration-300 ${
                months === n
                  ? "bg-blue-500/20 text-blue-400 border border-blue-500/30 shadow-md"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              {n === 3 ? "3 мес" : n === 6 ? "6 мес" : "12 мес"}
            </button>
          ))}
        </div>

        {/* Refresh button */}
        <button
          onClick={() => fetchData()}
          disabled={loading}
          className="p-2 rounded-lg hover:bg-white/5 text-slate-400 hover:text-white transition-colors disabled:opacity-50"
          title="Обновить"
        >
          {loading ? (
            <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
          ) : (
            <RefreshCw className="w-4 h-4" />
          )}
        </button>
      </div>

      {/* Soft error banner when we still have stale data */}
      {error && data && (
        <div className="glass-panel rounded-xl px-4 py-3 border border-red-500/20 bg-red-500/5 flex items-center gap-3">
          <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0" />
          <p className="text-red-400 text-xs">{error}</p>
        </div>
      )}

      {data && (
        <>
          {/* Section 1 */}
          <BlockScoresTable
            months={data.months}
            blockScores={data.blockScores}
            overallScores={data.overallScores}
          />

          {/* Section 2 */}
          <ClientScoringSection
            clientScoring={data.clientScoring}
            months={data.months}
          />

          {/* Section 3 */}
          <LeadCategoriesTable
            categories={data.categories}
            months={data.months}
          />

          {/* Section 4 */}
          <CallVolumeSection
            callVolume={data.callVolume}
            months={data.months}
          />
        </>
      )}

      {/* Subtle refresh overlay when re-fetching with existing data */}
      {data && loading && (
        <div className="fixed top-4 right-4 z-50 bg-slate-800/90 border border-white/10 rounded-xl px-4 py-2 flex items-center gap-2 shadow-xl">
          <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
          <span className="text-xs text-slate-400">Обновление...</span>
        </div>
      )}
    </div>
  );
}
