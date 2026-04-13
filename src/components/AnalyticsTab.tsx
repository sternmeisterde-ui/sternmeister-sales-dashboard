"use client";

import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Loader2, ChevronDown, ChevronUp } from "lucide-react";
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

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    if (!data) setLoading(true);
    setError(null);
    try {
      const fromStr = dateRange.start ? fmtDate(dateRange.start) : "";
      const toStr = dateRange.end ? fmtDate(dateRange.end) : "";
      if (!fromStr || !toStr) return;

      // For roleplay, berater 2 doesn't exist — map "2b" → "2"
      const effectiveLine = source === "roleplay" && line === "2b" ? "2" : line;

      const params = new URLSearchParams({ department, source, line: effectiveLine, groupBy, from: fromStr, to: toStr });
      if (managerId) params.set("managerId", managerId);
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
  }, [department, source, line, groupBy, dateRange, managerId]);

  useEffect(() => {
    const ac = new AbortController();
    fetchData(ac.signal);
    return () => ac.abort();
  }, [fetchData]);

  const setQuickRange = (days: number) => {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - days);
    setDateRange({ start, end });
  };

  const periods = data?.periods ?? [];

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

        {/* GroupBy */}
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

        {/* Calendar picker (same as OKK page) */}
        <CalendarPicker
          mode="range"
          value={dateRange}
          onChange={setDateRange}
          onClear={() => setQuickRange(30)}
        />

        {/* No duplicate presets — groupBy + calendar is enough */}

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
        <button onClick={() => fetchData()} disabled={loading}
          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 disabled:opacity-30">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
        {data && <span className="text-[10px] text-slate-500">{data.totalCalls} зв.</span>}
      </div>

      {/* Loading */}
      {loading && !data && <DinoLoader />}
      {loading && data && (
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

      {/* ── Table 1: Criteria × Time ── */}
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

      {/* ── Table 2: Criteria × Managers ── */}
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

      {data && !loading && data.totalCalls === 0 && (
        <div className="glass-panel rounded-2xl p-8 border border-white/5 text-center">
          <p className="text-slate-500 text-sm">Нет данных за выбранный период</p>
        </div>
      )}
    </div>
  );
}

// ==================== Criteria × Time Table ====================

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

// ==================== Criteria × Managers Table ====================

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
                  <div className="text-[8px] text-slate-600">{m.callCount} зв.</div>
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
