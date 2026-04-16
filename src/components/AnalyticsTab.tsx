"use client";

import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Loader2, ChevronDown, ChevronUp, ArrowLeftRight } from "lucide-react";
import CalendarPicker, { type DateRange } from "@/components/CalendarPicker";
import DinoLoader from "@/components/DinoLoader";

// ==================== Types ====================

interface CriterionScore { name: string; scores: Record<string, number> }
interface BlockData { name: string; scores: Record<string, number>; criteria: CriterionScore[] }
interface ManagerCriterion { name: string; score: number | null }
interface ManagerBlock { name: string; score: number | null; criteria: ManagerCriterion[] }
interface ManagerBreakdown { id: string; name: string; overallScore: number | null; callCount: number; blocks: ManagerBlock[] }
interface AnalyticsData {
  periods: string[];
  blocks: BlockData[];
  overallScores: Record<string, number>;
  managers: Array<{ id: string; name: string }>;
  managerBreakdown: ManagerBreakdown[];
  totalCalls: number;
}

// ==================== Helpers ====================

function getCriteriaColor(v: number | null | undefined): string {
  if (v === undefined || v === null) return "text-slate-600";
  if (v >= 80) return "text-emerald-400";
  if (v >= 50) return "text-amber-400";
  return "text-rose-400";
}

function getCriteriaBg(v: number | null | undefined): string {
  if (v === undefined || v === null) return "";
  if (v >= 80) return "bg-emerald-500/5";
  if (v >= 50) return "bg-amber-500/5";
  return "bg-rose-500/5";
}

function fmtScore(v: number | null | undefined): string {
  if (v === undefined || v === null) return "—";
  return `${v}%`;
}

function fmtPeriod(p: string, g: string): string {
  if (g === "month") {
    const [y, m] = p.split("-");
    const mn = ["Янв", "Фев", "Мар", "Апр", "Май", "Июн", "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек"];
    return `${mn[Number(m) - 1]} ${y.slice(2)}`;
  }
  if (g === "week") return p;
  const parts = p.split("-");
  if (parts.length === 3) return `${parts[2]}.${parts[1]}`;
  return p;
}

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtShortRange(r: DateRange): string {
  if (!r.start || !r.end) return "—";
  const f = (d: Date) => `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
  return `${f(r.start)} – ${f(r.end)}`;
}

function avgScores(scores: Record<string, number>): number | null {
  const vals = Object.values(scores);
  if (vals.length === 0) return null;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

function fmtDelta(a: number | null | undefined, b: number | null | undefined): string {
  if (a == null || b == null) return "—";
  const d = b - a;
  if (d === 0) return "0";
  return d > 0 ? `+${d}` : `${d}`;
}

function getDeltaColor(a: number | null | undefined, b: number | null | undefined): string {
  if (a == null || b == null) return "text-slate-600";
  const d = b - a;
  if (d > 0) return "text-emerald-400";
  if (d < 0) return "text-rose-400";
  return "text-slate-400";
}

// B2G line options — includes Бератер 1 and Бератер 2
const B2G_LINES = [
  { id: "1", label: "Квалификатор" },
  { id: "2", label: "Бератер 1" },
  { id: "2b", label: "Бератер 2" },
  { id: "3", label: "Доведение" },
];

// ==================== Main Component ====================

export default function AnalyticsTab({ department }: { department: "b2g" | "b2b" }) {
  const [source, setSource] = useState<"okk" | "roleplay">("okk");
  const [line, setLine] = useState("1");
  const [groupBy, setGroupBy] = useState<"day" | "week" | "month">("day");
  const [managerId, setManagerId] = useState("");
  const [dateRange, setDateRange] = useState<DateRange>(() => {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 30);
    return { start, end };
  });

  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsedBlocks, setCollapsedBlocks] = useState<Set<string>>(new Set());
  const [collapsedMgrBlocks, setCollapsedMgrBlocks] = useState<Set<string>>(new Set());

  // Comparison mode
  const [compareMode, setCompareMode] = useState(false);
  const [compareDateRange, setCompareDateRange] = useState<DateRange>(() => {
    const end = new Date();
    end.setDate(end.getDate() - 30);
    const start = new Date();
    start.setDate(start.getDate() - 60);
    return { start, end };
  });
  const [compareData, setCompareData] = useState<AnalyticsData | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [collapsedCompareBlocks, setCollapsedCompareBlocks] = useState<Set<string>>(new Set());
  const [collapsedCompareMgrBlocks, setCollapsedCompareMgrBlocks] = useState<Set<string>>(new Set());

  const toggle = (set: React.Dispatch<React.SetStateAction<Set<string>>>, name: string) => {
    set((prev) => { const n = new Set(prev); if (n.has(name)) n.delete(name); else n.add(name); return n; });
  };

  // Reset manager when context changes (different DB/line = different manager UUIDs)
  useEffect(() => { if (department === "b2b") setLine("1"); setManagerId(""); }, [department]);
  useEffect(() => {
    setManagerId("");
    if (source === "roleplay" && line === "2b") setLine("2");
  }, [source, line]);
  // If selected manager is not in current list, clear selection
  useEffect(() => {
    if (managerId && data?.managers && !data.managers.some((m) => m.id === managerId)) {
      setManagerId("");
    }
  }, [data?.managers, managerId]);

  const buildParams = useCallback((range: DateRange) => {
    const fromStr = range.start ? fmtDate(range.start) : "";
    const toStr = range.end ? fmtDate(range.end) : "";
    if (!fromStr || !toStr) return null;
    const effectiveLine = source === "roleplay" && line === "2b" ? "2" : line;
    const params = new URLSearchParams({ department, source, line: effectiveLine, groupBy, from: fromStr, to: toStr });
    if (managerId) params.set("managerId", managerId);
    return params;
  }, [department, source, line, groupBy, managerId]);

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    if (!data) setLoading(true);
    setError(null);
    try {
      const params = buildParams(dateRange);
      if (!params) return;
      const res = await fetch(`/api/analytics?${params}`, { signal });
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Unknown error");
      setData(json.data);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [buildParams, dateRange, data]);

  const fetchCompareData = useCallback(async (signal?: AbortSignal) => {
    if (!compareMode) return;
    setCompareLoading(true);
    try {
      const params = buildParams(compareDateRange);
      if (!params) return;
      const res = await fetch(`/api/analytics?${params}`, { signal });
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Unknown error");
      setCompareData(json.data);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
    } finally {
      setCompareLoading(false);
    }
  }, [buildParams, compareDateRange, compareMode]);

  useEffect(() => {
    const ac = new AbortController();
    fetchData(ac.signal);
    return () => ac.abort();
  }, [fetchData]);

  useEffect(() => {
    if (!compareMode) { setCompareData(null); return; }
    const ac = new AbortController();
    fetchCompareData(ac.signal);
    return () => ac.abort();
  }, [fetchCompareData, compareMode]);

  const setQuickRange = (days: number) => {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - days);
    setDateRange({ start, end });
  };

  const periods = data?.periods ?? [];
  const isCompareReady = compareMode && data && compareData;

  return (
    <div className="flex flex-col gap-5 fade-in flex-1 overflow-y-auto pb-6 scrollbar-hide">
      {/* ── Filters ── */}
      <div className="flex flex-wrap gap-2 items-center">
        {/* Source */}
        <div className="flex bg-slate-800/50 p-1 rounded-xl border border-white/5">
          {(["okk", "roleplay"] as const).map((s) => (
            <button key={s} onClick={() => setSource(s)}
              className={`px-3 py-1.5 rounded-lg text-[10px] uppercase tracking-widest font-bold transition-all ${
                source === s ? "bg-blue-500/20 text-blue-400 border border-blue-500/30" : "text-slate-400 hover:text-white"
              }`}>
              {s === "okk" ? "OKK" : "Ролевки"}
            </button>
          ))}
        </div>

        {/* Line (B2G only) — Бератер 2 only for OKK, not roleplay */}
        {department === "b2g" && (
          <div className="flex bg-slate-800/50 p-1 rounded-xl border border-white/5">
            {B2G_LINES
              .filter((l) => source === "okk" || l.id !== "2b")
              .map((l) => (
              <button key={l.id} onClick={() => { setLine(l.id); setManagerId(""); }}
                className={`px-2.5 py-1.5 rounded-lg text-[10px] uppercase tracking-widest font-bold transition-all ${
                  line === l.id ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" : "text-slate-400 hover:text-white"
                }`}>
                {l.label}
              </button>
            ))}
          </div>
        )}

        {/* GroupBy — hidden in compare mode */}
        {!compareMode && (
          <div className="flex bg-slate-800/50 p-1 rounded-xl border border-white/5">
            {(["day", "week", "month"] as const).map((g) => (
              <button key={g} onClick={() => setGroupBy(g)}
                className={`px-2.5 py-1.5 rounded-lg text-[10px] uppercase tracking-widest font-bold transition-all ${
                  groupBy === g ? "bg-purple-500/20 text-purple-400 border border-purple-500/30" : "text-slate-400 hover:text-white"
                }`}>
                {g === "day" ? "Дни" : g === "week" ? "Нед" : "Мес"}
              </button>
            ))}
          </div>
        )}

        {/* Calendar picker A */}
        <CalendarPicker
          mode="range"
          value={dateRange}
          onChange={setDateRange}
          onClear={() => setQuickRange(30)}
        />

        {/* Compare toggle */}
        <button onClick={() => setCompareMode(!compareMode)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[10px] uppercase tracking-widest font-bold transition-all border ${
            compareMode
              ? "bg-orange-500/20 text-orange-400 border-orange-500/30"
              : "bg-slate-800/50 text-slate-400 border-white/5 hover:text-white"
          }`}>
          <ArrowLeftRight className="w-3.5 h-3.5" />
          Сравнить
        </button>

        {/* Calendar picker B — only in compare mode */}
        {compareMode && (
          <CalendarPicker
            mode="range"
            value={compareDateRange}
            onChange={setCompareDateRange}
            onClear={() => {
              const end = new Date();
              end.setDate(end.getDate() - 30);
              const start = new Date();
              start.setDate(start.getDate() - 60);
              setCompareDateRange({ start, end });
            }}
          />
        )}

        {/* Manager dropdown */}
        {data?.managers && data.managers.length > 0 && (
          <select value={managerId} onChange={(e) => setManagerId(e.target.value)}
            className="bg-slate-800/50 border border-white/10 rounded-xl px-3 py-1.5 text-[11px] text-slate-300 focus:outline-none focus:border-blue-500/40 max-w-[170px]">
            <option value="">Все менеджеры</option>
            {data.managers.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        )}

        {/* Refresh + count */}
        <button onClick={() => { fetchData(); if (compareMode) fetchCompareData(); }} disabled={loading}
          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 disabled:opacity-30">
          <RefreshCw className={`w-3.5 h-3.5 ${loading || compareLoading ? "animate-spin" : ""}`} />
        </button>
        {data && <span className="text-[10px] text-slate-500">{data.totalCalls} зв.</span>}
        {compareMode && compareData && <span className="text-[10px] text-slate-500">vs {compareData.totalCalls} зв.</span>}
      </div>

      {/* Loading */}
      {loading && !data && <DinoLoader />}
      {(loading || compareLoading) && data && (
        <div className="flex items-center justify-center py-2">
          <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-blue-500/10 border border-blue-500/20">
            <Loader2 className="w-3 h-3 animate-spin text-blue-400" />
            <span className="text-[10px] text-blue-400 font-medium">Обновление...</span>
          </div>
        </div>
      )}

      {error && (
        <div className="glass-panel rounded-2xl p-6 border border-red-500/20 bg-red-500/5">
          <p className="text-red-400 text-sm">{error}</p>
          <button onClick={() => fetchData()} className="mt-2 text-xs text-red-300 underline hover:text-white">Повторить</button>
        </div>
      )}

      {/* ── COMPARE MODE ── */}
      {isCompareReady ? (
        <>
          <div className="text-[11px] uppercase tracking-widest font-bold text-slate-500">
            Сравнение по критериям
          </div>
          <ComparisonCriteriaTable
            dataA={data}
            dataB={compareData}
            labelA={fmtShortRange(dateRange)}
            labelB={fmtShortRange(compareDateRange)}
            collapsedBlocks={collapsedCompareBlocks}
            onToggle={(n) => toggle(setCollapsedCompareBlocks, n)}
          />

          {!managerId && (data.managerBreakdown.length > 0 || compareData.managerBreakdown.length > 0) && (
            <>
              <div className="text-[11px] uppercase tracking-widest font-bold text-slate-500 mt-2">
                Сравнение по менеджерам
              </div>
              <ComparisonManagerTable
                dataA={data}
                dataB={compareData}
                labelA={fmtShortRange(dateRange)}
                labelB={fmtShortRange(compareDateRange)}
                collapsedBlocks={collapsedCompareMgrBlocks}
                onToggle={(n) => toggle(setCollapsedCompareMgrBlocks, n)}
              />
            </>
          )}
        </>
      ) : (
        <>
          {/* ── NORMAL MODE: Table 1 — Criteria x Time ── */}
          {data && periods.length > 0 && (
            <>
              <div className="text-[11px] uppercase tracking-widest font-bold text-slate-500">
                Динамика по критериям
              </div>
              <CriteriaTimeTable
                blocks={data.blocks}
                periods={periods}
                groupBy={groupBy}
                overallScores={data.overallScores}
                collapsedBlocks={collapsedBlocks}
                onToggle={(n) => toggle(setCollapsedBlocks, n)}
              />
            </>
          )}

          {/* ── NORMAL MODE: Table 2 — Criteria x Managers ── */}
          {data && data.managerBreakdown.length > 0 && !managerId && (
            <>
              <div className="text-[11px] uppercase tracking-widest font-bold text-slate-500 mt-2">
                Разбивка по менеджерам
              </div>
              <ManagerTable
                blocks={data.blocks}
                managers={data.managerBreakdown}
                collapsedBlocks={collapsedMgrBlocks}
                onToggle={(n) => toggle(setCollapsedMgrBlocks, n)}
              />
            </>
          )}
        </>
      )}

      {data && !loading && data.totalCalls === 0 && (
        <div className="glass-panel rounded-2xl p-8 border border-white/5 text-center">
          <p className="text-slate-500 text-sm">Нет данных за выбранный период</p>
        </div>
      )}
    </div>
  );
}

// ==================== Criteria x Time Table ====================

function CriteriaTimeTable({
  blocks, periods, groupBy, overallScores, collapsedBlocks, onToggle,
}: {
  blocks: BlockData[]; periods: string[]; groupBy: string;
  overallScores: Record<string, number>;
  collapsedBlocks: Set<string>; onToggle: (n: string) => void;
}) {
  return (
    <div className="glass-panel text-slate-200 rounded-2xl overflow-hidden border border-white/5 shadow-2xl">
      <div className="w-full overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-white/10">
              <th className="px-4 py-2.5 text-[10px] uppercase tracking-widest text-slate-500 font-semibold sticky left-0 bg-slate-900/95 backdrop-blur-sm z-20 min-w-[260px]">
                Критерий
              </th>
              {periods.map((p) => (
                <th key={p} className="px-2 py-2 text-center min-w-[50px]">
                  <div className="text-[9px] uppercase tracking-wider text-slate-400 font-bold">{fmtPeriod(p, groupBy)}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="text-sm">
            {blocks.map((block) => {
              const collapsed = collapsedBlocks.has(block.name);
              return (
                <BlockTimeRows key={block.name} block={block} periods={periods} isCollapsed={collapsed} onToggle={() => onToggle(block.name)} />
              );
            })}
            <tr className="border-t-2 border-white/10 bg-blue-500/[0.05]">
              <td className="px-4 py-2.5 font-bold text-white text-[12px] sticky left-0 bg-slate-900/90 backdrop-blur-sm z-10">Средний балл</td>
              {periods.map((p) => {
                const v = overallScores[p];
                return <td key={p} className={`px-2 py-2.5 text-right font-mono text-[12px] font-bold ${getCriteriaColor(v)}`}>{fmtScore(v)}</td>;
              })}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BlockTimeRows({ block, periods, isCollapsed, onToggle }: { block: BlockData; periods: string[]; isCollapsed: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className="bg-slate-900/60 border-t border-white/10 cursor-pointer hover:bg-slate-800/40" onClick={onToggle}>
        <td className="px-4 py-2 sticky left-0 bg-slate-900/60 backdrop-blur-sm z-10">
          <div className="flex items-center gap-2">
            {isCollapsed ? <ChevronDown className="w-3.5 h-3.5 text-slate-500" /> : <ChevronUp className="w-3.5 h-3.5 text-slate-500" />}
            <span className="text-[11px] uppercase tracking-widest font-bold text-slate-300">{block.name}</span>
          </div>
        </td>
        {periods.map((p) => {
          const v = block.scores[p];
          return <td key={p} className={`px-2 py-2 text-right font-mono text-[11px] font-bold ${getCriteriaColor(v)} ${getCriteriaBg(v)}`}>{fmtScore(v)}</td>;
        })}
      </tr>
      {!isCollapsed && block.criteria.map((c) => (
        <tr key={`${block.name}-${c.name}`} className="hover:bg-white/[0.02] border-b border-white/[0.03]">
          <td className="px-4 py-1.5 text-[11px] text-slate-400 sticky left-0 bg-slate-900/90 backdrop-blur-sm z-10 pl-10">{c.name}</td>
          {periods.map((p) => {
            const v = c.scores[p];
            return <td key={p} className={`px-2 py-1.5 text-right font-mono text-[11px] ${getCriteriaColor(v)}`}>{fmtScore(v)}</td>;
          })}
        </tr>
      ))}
    </>
  );
}

// ==================== Criteria x Managers Table ====================

function ManagerTable({
  blocks, managers, collapsedBlocks, onToggle,
}: {
  blocks: BlockData[]; managers: ManagerBreakdown[];
  collapsedBlocks: Set<string>; onToggle: (n: string) => void;
}) {
  return (
    <div className="glass-panel text-slate-200 rounded-2xl overflow-hidden border border-white/5 shadow-2xl">
      <div className="w-full overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-white/10">
              <th className="px-4 py-2.5 text-[10px] uppercase tracking-widest text-slate-500 font-semibold sticky left-0 bg-slate-900/95 backdrop-blur-sm z-20 min-w-[260px]">
                Критерий
              </th>
              {managers.map((m) => (
                <th key={m.id} className="px-2 py-2 text-center min-w-[75px]">
                  <div className="text-[9px] uppercase tracking-wider text-slate-400 font-bold leading-tight whitespace-nowrap">{m.name}</div>
                  <div className="text-[11px] text-white font-bold">{m.callCount} зв.</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="text-sm">
            {blocks.map((block, bi) => {
              const collapsed = collapsedBlocks.has(block.name);
              return (
                <BlockManagerRows key={block.name} blockName={block.name} blockIdx={bi}
                  criteriaNames={block.criteria.map((c) => c.name)} managers={managers}
                  isCollapsed={collapsed} onToggle={() => onToggle(block.name)} />
              );
            })}
            <tr className="border-t-2 border-white/10 bg-blue-500/[0.05]">
              <td className="px-4 py-2.5 font-bold text-white text-[12px] sticky left-0 bg-slate-900/90 backdrop-blur-sm z-10">Средний балл</td>
              {managers.map((m) => (
                <td key={m.id} className={`px-2 py-2.5 text-right font-mono text-[12px] font-bold ${getCriteriaColor(m.overallScore)}`}>{fmtScore(m.overallScore)}</td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BlockManagerRows({ blockName, blockIdx, criteriaNames, managers, isCollapsed, onToggle }: {
  blockName: string; blockIdx: number; criteriaNames: string[]; managers: ManagerBreakdown[];
  isCollapsed: boolean; onToggle: () => void;
}) {
  return (
    <>
      <tr className="bg-slate-900/60 border-t border-white/10 cursor-pointer hover:bg-slate-800/40" onClick={onToggle}>
        <td className="px-4 py-2 sticky left-0 bg-slate-900/60 backdrop-blur-sm z-10">
          <div className="flex items-center gap-2">
            {isCollapsed ? <ChevronDown className="w-3.5 h-3.5 text-slate-500" /> : <ChevronUp className="w-3.5 h-3.5 text-slate-500" />}
            <span className="text-[11px] uppercase tracking-widest font-bold text-slate-300">{blockName}</span>
          </div>
        </td>
        {managers.map((m) => {
          const v = m.blocks[blockIdx]?.score;
          return <td key={m.id} className={`px-2 py-2 text-right font-mono text-[11px] font-bold ${getCriteriaColor(v)} ${getCriteriaBg(v)}`}>{fmtScore(v)}</td>;
        })}
      </tr>
      {!isCollapsed && criteriaNames.map((cName, ci) => (
        <tr key={`${blockName}-m-${cName}`} className="hover:bg-white/[0.02] border-b border-white/[0.03]">
          <td className="px-4 py-1.5 text-[11px] text-slate-400 sticky left-0 bg-slate-900/90 backdrop-blur-sm z-10 pl-10">{cName}</td>
          {managers.map((m) => {
            const v = m.blocks[blockIdx]?.criteria[ci]?.score;
            return <td key={m.id} className={`px-2 py-1.5 text-right font-mono text-[11px] ${getCriteriaColor(v)}`}>{fmtScore(v)}</td>;
          })}
        </tr>
      ))}
    </>
  );
}

// ==================== Comparison: Criteria Table ====================

interface AggregatedBlock {
  name: string;
  score: number | null;
  criteria: Array<{ name: string; score: number | null }>;
}

function aggregateData(data: AnalyticsData): { blocks: AggregatedBlock[]; overall: number | null } {
  const blocks: AggregatedBlock[] = data.blocks.map((b) => ({
    name: b.name,
    score: avgScores(b.scores),
    criteria: b.criteria.map((c) => ({
      name: c.name,
      score: avgScores(c.scores),
    })),
  }));
  const overall = avgScores(data.overallScores);
  return { blocks, overall };
}

function ComparisonCriteriaTable({ dataA, dataB, labelA, labelB, collapsedBlocks, onToggle }: {
  dataA: AnalyticsData; dataB: AnalyticsData;
  labelA: string; labelB: string;
  collapsedBlocks: Set<string>; onToggle: (n: string) => void;
}) {
  const aggA = aggregateData(dataA);
  const aggB = aggregateData(dataB);

  // Merge block names preserving order
  const blockNames: string[] = [];
  for (const b of aggA.blocks) { if (!blockNames.includes(b.name)) blockNames.push(b.name); }
  for (const b of aggB.blocks) { if (!blockNames.includes(b.name)) blockNames.push(b.name); }

  return (
    <div className="glass-panel text-slate-200 rounded-2xl overflow-hidden border border-white/5 shadow-2xl">
      <div className="w-full overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-white/10">
              <th className="px-4 py-2.5 text-[10px] uppercase tracking-widest text-slate-500 font-semibold sticky left-0 bg-slate-900/95 backdrop-blur-sm z-20 min-w-[260px]">
                Критерий
              </th>
              <th className="px-3 py-2.5 text-center min-w-[100px]">
                <div className="text-[9px] uppercase tracking-wider text-blue-400 font-bold">{labelA}</div>
                <div className="text-[10px] text-white font-bold">{dataA.totalCalls} зв.</div>
              </th>
              <th className="px-3 py-2.5 text-center min-w-[100px]">
                <div className="text-[9px] uppercase tracking-wider text-orange-400 font-bold">{labelB}</div>
                <div className="text-[10px] text-white font-bold">{dataB.totalCalls} зв.</div>
              </th>
              <th className="px-3 py-2.5 text-center min-w-[60px]">
                <div className="text-[9px] uppercase tracking-wider text-slate-500 font-bold">Δ</div>
              </th>
            </tr>
          </thead>
          <tbody className="text-sm">
            {blockNames.map((blockName) => {
              const blockA = aggA.blocks.find((b) => b.name === blockName);
              const blockB = aggB.blocks.find((b) => b.name === blockName);
              const collapsed = collapsedBlocks.has(blockName);

              const criteriaNames: string[] = [];
              for (const c of blockA?.criteria ?? []) { if (!criteriaNames.includes(c.name)) criteriaNames.push(c.name); }
              for (const c of blockB?.criteria ?? []) { if (!criteriaNames.includes(c.name)) criteriaNames.push(c.name); }

              const scoreA = blockA?.score ?? null;
              const scoreB = blockB?.score ?? null;

              return (
                <CompareBlockRows key={blockName} blockName={blockName} scoreA={scoreA} scoreB={scoreB}
                  blockA={blockA} blockB={blockB} criteriaNames={criteriaNames}
                  isCollapsed={collapsed} onToggle={() => onToggle(blockName)} />
              );
            })}
            <tr className="border-t-2 border-white/10 bg-blue-500/[0.05]">
              <td className="px-4 py-2.5 font-bold text-white text-[12px] sticky left-0 bg-slate-900/90 backdrop-blur-sm z-10">Средний балл</td>
              <td className={`px-3 py-2.5 text-center font-mono text-[12px] font-bold ${getCriteriaColor(aggA.overall)}`}>{fmtScore(aggA.overall)}</td>
              <td className={`px-3 py-2.5 text-center font-mono text-[12px] font-bold ${getCriteriaColor(aggB.overall)}`}>{fmtScore(aggB.overall)}</td>
              <td className={`px-3 py-2.5 text-center font-mono text-[12px] font-bold ${getDeltaColor(aggA.overall, aggB.overall)}`}>{fmtDelta(aggA.overall, aggB.overall)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CompareBlockRows({ blockName, scoreA, scoreB, blockA, blockB, criteriaNames, isCollapsed, onToggle }: {
  blockName: string; scoreA: number | null; scoreB: number | null;
  blockA?: AggregatedBlock; blockB?: AggregatedBlock; criteriaNames: string[];
  isCollapsed: boolean; onToggle: () => void;
}) {
  return (
    <>
      <tr className="bg-slate-900/60 border-t border-white/10 cursor-pointer hover:bg-slate-800/40" onClick={onToggle}>
        <td className="px-4 py-2 sticky left-0 bg-slate-900/60 backdrop-blur-sm z-10">
          <div className="flex items-center gap-2">
            {isCollapsed ? <ChevronDown className="w-3.5 h-3.5 text-slate-500" /> : <ChevronUp className="w-3.5 h-3.5 text-slate-500" />}
            <span className="text-[11px] uppercase tracking-widest font-bold text-slate-300">{blockName}</span>
          </div>
        </td>
        <td className={`px-3 py-2 text-center font-mono text-[11px] font-bold ${getCriteriaColor(scoreA)} ${getCriteriaBg(scoreA)}`}>{fmtScore(scoreA)}</td>
        <td className={`px-3 py-2 text-center font-mono text-[11px] font-bold ${getCriteriaColor(scoreB)} ${getCriteriaBg(scoreB)}`}>{fmtScore(scoreB)}</td>
        <td className={`px-3 py-2 text-center font-mono text-[11px] font-bold ${getDeltaColor(scoreA, scoreB)}`}>{fmtDelta(scoreA, scoreB)}</td>
      </tr>
      {!isCollapsed && criteriaNames.map((cName) => {
        const cA = blockA?.criteria.find((c) => c.name === cName)?.score ?? null;
        const cB = blockB?.criteria.find((c) => c.name === cName)?.score ?? null;
        return (
          <tr key={`${blockName}-cmp-${cName}`} className="hover:bg-white/[0.02] border-b border-white/[0.03]">
            <td className="px-4 py-1.5 text-[11px] text-slate-400 sticky left-0 bg-slate-900/90 backdrop-blur-sm z-10 pl-10">{cName}</td>
            <td className={`px-3 py-1.5 text-center font-mono text-[11px] ${getCriteriaColor(cA)}`}>{fmtScore(cA)}</td>
            <td className={`px-3 py-1.5 text-center font-mono text-[11px] ${getCriteriaColor(cB)}`}>{fmtScore(cB)}</td>
            <td className={`px-3 py-1.5 text-center font-mono text-[11px] ${getDeltaColor(cA, cB)}`}>{fmtDelta(cA, cB)}</td>
          </tr>
        );
      })}
    </>
  );
}

// ==================== Comparison: Managers Table ====================

function ComparisonManagerTable({ dataA, dataB, labelA, labelB, collapsedBlocks, onToggle }: {
  dataA: AnalyticsData; dataB: AnalyticsData;
  labelA: string; labelB: string;
  collapsedBlocks: Set<string>; onToggle: (n: string) => void;
}) {
  // Merge managers from both periods
  const allIds = new Set([
    ...dataA.managerBreakdown.map((m) => m.id),
    ...dataB.managerBreakdown.map((m) => m.id),
  ]);

  const merged = [...allIds].map((id) => {
    const a = dataA.managerBreakdown.find((m) => m.id === id);
    const b = dataB.managerBreakdown.find((m) => m.id === id);
    return { id, name: a?.name ?? b?.name ?? "—", a, b };
  }).sort((x, y) => {
    const avgX = ((x.a?.overallScore ?? 0) + (x.b?.overallScore ?? 0)) / 2;
    const avgY = ((y.a?.overallScore ?? 0) + (y.b?.overallScore ?? 0)) / 2;
    return avgY - avgX;
  });

  // Merge block names
  const blockNames: string[] = [];
  for (const b of dataA.blocks) { if (!blockNames.includes(b.name)) blockNames.push(b.name); }
  for (const b of dataB.blocks) { if (!blockNames.includes(b.name)) blockNames.push(b.name); }

  return (
    <div className="glass-panel text-slate-200 rounded-2xl overflow-hidden border border-white/5 shadow-2xl">
      <div className="w-full overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-white/10">
              <th className="px-4 py-2.5 text-[10px] uppercase tracking-widest text-slate-500 font-semibold sticky left-0 bg-slate-900/95 backdrop-blur-sm z-20 min-w-[180px]">
                Менеджер
              </th>
              <th className="px-2 py-2.5 text-center min-w-[50px]">
                <div className="text-[9px] uppercase tracking-wider text-blue-400 font-bold">Зв.</div>
              </th>
              <th className="px-3 py-2.5 text-center min-w-[80px]">
                <div className="text-[9px] uppercase tracking-wider text-blue-400 font-bold">{labelA}</div>
              </th>
              <th className="px-2 py-2.5 text-center min-w-[50px]">
                <div className="text-[9px] uppercase tracking-wider text-orange-400 font-bold">Зв.</div>
              </th>
              <th className="px-3 py-2.5 text-center min-w-[80px]">
                <div className="text-[9px] uppercase tracking-wider text-orange-400 font-bold">{labelB}</div>
              </th>
              <th className="px-3 py-2.5 text-center min-w-[60px]">
                <div className="text-[9px] uppercase tracking-wider text-slate-500 font-bold">Δ</div>
              </th>
            </tr>
          </thead>
          <tbody className="text-sm">
            {merged.map((m) => {
              const collapsed = collapsedBlocks.has(m.id);
              return (
                <CompareManagerRows key={m.id} mgr={m} blockNames={blockNames}
                  isCollapsed={collapsed} onToggle={() => onToggle(m.id)} />
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CompareManagerRows({ mgr, blockNames, isCollapsed, onToggle }: {
  mgr: { id: string; name: string; a?: ManagerBreakdown; b?: ManagerBreakdown };
  blockNames: string[];
  isCollapsed: boolean; onToggle: () => void;
}) {
  const scoreA = mgr.a?.overallScore ?? null;
  const scoreB = mgr.b?.overallScore ?? null;

  return (
    <>
      <tr className="border-t border-white/10 cursor-pointer hover:bg-slate-800/40" onClick={onToggle}>
        <td className="px-4 py-2 sticky left-0 bg-slate-900/80 backdrop-blur-sm z-10">
          <div className="flex items-center gap-2">
            {isCollapsed ? <ChevronDown className="w-3 h-3 text-slate-500" /> : <ChevronUp className="w-3 h-3 text-slate-500" />}
            <span className="text-[11px] font-bold text-white">{mgr.name}</span>
          </div>
        </td>
        <td className="px-2 py-2 text-center text-[11px] text-white font-bold">{mgr.a?.callCount ?? 0}</td>
        <td className={`px-3 py-2 text-center font-mono text-[12px] font-bold ${getCriteriaColor(scoreA)} ${getCriteriaBg(scoreA)}`}>{fmtScore(scoreA)}</td>
        <td className="px-2 py-2 text-center text-[11px] text-white font-bold">{mgr.b?.callCount ?? 0}</td>
        <td className={`px-3 py-2 text-center font-mono text-[12px] font-bold ${getCriteriaColor(scoreB)} ${getCriteriaBg(scoreB)}`}>{fmtScore(scoreB)}</td>
        <td className={`px-3 py-2 text-center font-mono text-[12px] font-bold ${getDeltaColor(scoreA, scoreB)}`}>{fmtDelta(scoreA, scoreB)}</td>
      </tr>
      {!isCollapsed && blockNames.map((bName, bi) => {
        const bScoreA = mgr.a?.blocks[bi]?.score ?? null;
        const bScoreB = mgr.b?.blocks[bi]?.score ?? null;
        return (
          <tr key={`${mgr.id}-${bName}`} className="hover:bg-white/[0.02] border-b border-white/[0.03]">
            <td className="px-4 py-1.5 text-[10px] text-slate-500 sticky left-0 bg-slate-900/90 backdrop-blur-sm z-10 pl-10">{bName}</td>
            <td />
            <td className={`px-3 py-1.5 text-center font-mono text-[10px] ${getCriteriaColor(bScoreA)}`}>{fmtScore(bScoreA)}</td>
            <td />
            <td className={`px-3 py-1.5 text-center font-mono text-[10px] ${getCriteriaColor(bScoreB)}`}>{fmtScore(bScoreB)}</td>
            <td className={`px-3 py-1.5 text-center font-mono text-[10px] ${getDeltaColor(bScoreA, bScoreB)}`}>{fmtDelta(bScoreA, bScoreB)}</td>
          </tr>
        );
      })}
    </>
  );
}
