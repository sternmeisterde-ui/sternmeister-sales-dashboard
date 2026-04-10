"use client";

import { useState, useEffect, useCallback } from "react";
import {
  RefreshCw,
  Loader2,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import DinoLoader from "@/components/DinoLoader";

// ==================== Types ====================

interface CriterionScore {
  name: string;
  scores: Record<string, number>;
}

interface BlockData {
  name: string;
  scores: Record<string, number>;
  criteria: CriterionScore[];
}

interface ManagerCriterion {
  name: string;
  score: number;
}

interface ManagerBlock {
  name: string;
  score: number;
  criteria: ManagerCriterion[];
}

interface ManagerBreakdown {
  id: string;
  name: string;
  overallScore: number;
  callCount: number;
  blocks: ManagerBlock[];
}

interface AnalyticsData {
  periods: string[];
  blocks: BlockData[];
  overallScores: Record<string, number>;
  managers: Array<{ id: string; name: string }>;
  managerBreakdown: ManagerBreakdown[];
  totalCalls: number;
  source: string;
  department: string;
}

// ==================== Helpers ====================

function getCriteriaColor(value: number | undefined): string {
  if (value === undefined) return "text-slate-600";
  if (value >= 80) return "text-emerald-400";
  if (value >= 50) return "text-amber-400";
  return "text-rose-400";
}

function getCriteriaBg(value: number | undefined): string {
  if (value === undefined) return "";
  if (value >= 80) return "bg-emerald-500/5";
  if (value >= 50) return "bg-amber-500/5";
  return "bg-rose-500/5";
}

function formatPeriodLabel(period: string, groupBy: string): string {
  if (groupBy === "month") {
    const [y, m] = period.split("-");
    const months = ["Янв", "Фев", "Мар", "Апр", "Май", "Июн", "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек"];
    return `${months[Number(m) - 1]} ${y.slice(2)}`;
  }
  if (groupBy === "week") return period;
  const parts = period.split("-");
  if (parts.length === 3) return `${parts[2]}.${parts[1]}`;
  return period;
}

function formatDateForInput(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ==================== Main Component ====================

export default function AnalyticsTab({ department }: { department: "b2g" | "b2b" }) {
  const [source, setSource] = useState<"okk" | "roleplay">("okk");
  const [line, setLine] = useState("1");
  const [groupBy, setGroupBy] = useState<"day" | "week" | "month">("day");
  const [managerId, setManagerId] = useState<string>("");
  const [fromDate, setFromDate] = useState<string>(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return formatDateForInput(d);
  });
  const [toDate, setToDate] = useState<string>(() => formatDateForInput(new Date()));

  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsedBlocks, setCollapsedBlocks] = useState<Set<string>>(new Set());
  const [collapsedMgrBlocks, setCollapsedMgrBlocks] = useState<Set<string>>(new Set());

  const toggleBlock = (blockName: string) => {
    setCollapsedBlocks((prev) => {
      const next = new Set(prev);
      if (next.has(blockName)) next.delete(blockName);
      else next.add(blockName);
      return next;
    });
  };

  const toggleMgrBlock = (blockName: string) => {
    setCollapsedMgrBlocks((prev) => {
      const next = new Set(prev);
      if (next.has(blockName)) next.delete(blockName);
      else next.add(blockName);
      return next;
    });
  };

  useEffect(() => {
    if (department === "b2b") setLine("1");
  }, [department]);

  const fetchData = useCallback(
    async (signal?: AbortSignal) => {
      if (!data) setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ department, source, line, groupBy, from: fromDate, to: toDate });
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
    },
    [department, source, line, groupBy, fromDate, toDate, managerId],
  );

  useEffect(() => {
    const ac = new AbortController();
    fetchData(ac.signal);
    return () => ac.abort();
  }, [fetchData]);

  const shiftDate = (dir: -1 | 1) => {
    const days = groupBy === "month" ? 30 : groupBy === "week" ? 7 : 1;
    const shift = days * dir;
    const f = new Date(fromDate);
    const t = new Date(toDate);
    f.setDate(f.getDate() + shift);
    t.setDate(t.getDate() + shift);
    setFromDate(formatDateForInput(f));
    setToDate(formatDateForInput(t));
  };

  const setQuickRange = (days: number) => {
    const t = new Date();
    const f = new Date();
    f.setDate(f.getDate() - days);
    setFromDate(formatDateForInput(f));
    setToDate(formatDateForInput(t));
  };

  const periods = data?.periods ?? [];

  return (
    <div className="flex flex-col gap-5 fade-in flex-1 overflow-y-auto pb-6 scrollbar-hide">
      {/* ── Filter Bar ── */}
      <div className="flex flex-col gap-3">
        {/* Row 1: Source + Line + Manager */}
        <div className="flex flex-wrap gap-3 items-center">
          {/* Source toggle */}
          <div className="flex bg-slate-800/50 p-1 rounded-xl border border-white/5 shadow-inner">
            {(["okk", "roleplay"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSource(s)}
                className={`px-4 py-2 rounded-lg text-[11px] uppercase tracking-widest font-bold transition-all ${
                  source === s
                    ? "bg-blue-500/20 text-blue-400 border border-blue-500/30 shadow-md"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                {s === "okk" ? "OKK (реальные)" : "Ролевки (AI)"}
              </button>
            ))}
          </div>

          {/* Line toggle (B2G only) */}
          {department === "b2g" && (
            <div className="flex bg-slate-800/50 p-1 rounded-xl border border-white/5 shadow-inner">
              {[
                { id: "1", label: "Квалификатор" },
                { id: "2", label: "Бератер" },
                { id: "3", label: "Доведение" },
              ].map((l) => (
                <button
                  key={l.id}
                  onClick={() => { setLine(l.id); setManagerId(""); }}
                  className={`px-3 py-1.5 rounded-lg text-[10px] uppercase tracking-widest font-bold transition-all ${
                    line === l.id
                      ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                      : "text-slate-400 hover:text-white"
                  }`}
                >
                  {l.label}
                </button>
              ))}
            </div>
          )}

          {/* Manager dropdown */}
          {data?.managers && data.managers.length > 0 && (
            <select
              value={managerId}
              onChange={(e) => setManagerId(e.target.value)}
              className="bg-slate-800/50 border border-white/10 rounded-xl px-3 py-2 text-[11px] text-slate-300 focus:outline-none focus:border-blue-500/40 min-w-[180px]"
            >
              <option value="">Все менеджеры</option>
              {data.managers.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          )}

          <button
            onClick={() => fetchData()}
            disabled={loading}
            className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition-colors disabled:opacity-30"
            title="Обновить"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </button>
          {data && (
            <span className="text-[10px] text-slate-500">{data.totalCalls} звонков</span>
          )}
        </div>

        {/* Row 2: GroupBy + Date range + presets */}
        <div className="flex flex-wrap gap-3 items-center">
          <div className="flex bg-slate-800/50 p-1 rounded-xl border border-white/5 shadow-inner">
            {(["day", "week", "month"] as const).map((g) => (
              <button
                key={g}
                onClick={() => setGroupBy(g)}
                className={`px-3 py-1.5 rounded-lg text-[10px] uppercase tracking-widest font-bold transition-all ${
                  groupBy === g
                    ? "bg-purple-500/20 text-purple-400 border border-purple-500/30"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                {g === "day" ? "Дни" : g === "week" ? "Недели" : "Месяцы"}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <button onClick={() => shiftDate(-1)} className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/5">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)}
              className="bg-slate-800/50 border border-white/10 rounded-lg px-2 py-1.5 text-[11px] text-slate-300 focus:outline-none focus:border-blue-500/40" />
            <span className="text-slate-500 text-[10px]">—</span>
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)}
              className="bg-slate-800/50 border border-white/10 rounded-lg px-2 py-1.5 text-[11px] text-slate-300 focus:outline-none focus:border-blue-500/40" />
            <button onClick={() => shiftDate(1)} className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/5">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          <div className="flex gap-1">
            {[{ days: 7, label: "7д" }, { days: 30, label: "30д" }, { days: 90, label: "3м" }, { days: 180, label: "6м" }].map((p) => (
              <button key={p.days} onClick={() => setQuickRange(p.days)}
                className="px-2 py-1 rounded-lg text-[10px] text-slate-400 hover:text-white bg-slate-800/30 hover:bg-slate-700/50 border border-white/5 transition-colors">
                {p.label}
              </button>
            ))}
          </div>
        </div>
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
          <button onClick={() => fetchData()} className="mt-2 text-xs text-red-300 underline hover:text-white">Попробовать снова</button>
        </div>
      )}

      {/* ── Table 1: Criteria × Time (динамика по дням/неделям/месяцам) ── */}
      {data && periods.length > 0 && (
        <>
          <div className="text-[11px] uppercase tracking-widest font-bold text-slate-500">
            Динамика по критериям
          </div>
          <div className="glass-panel text-slate-200 rounded-2xl overflow-hidden border border-white/5 shadow-2xl">
            <div className="w-full overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-white/10">
                    <th className="px-4 py-2.5 text-[10px] uppercase tracking-widest text-slate-500 font-semibold sticky left-0 bg-slate-900/95 backdrop-blur-sm z-20 min-w-[260px]">
                      Критерий
                    </th>
                    {periods.map((p) => (
                      <th key={p} className="px-2 py-2 text-center min-w-[55px]">
                        <div className="text-[9px] uppercase tracking-wider text-slate-400 font-bold leading-tight">
                          {formatPeriodLabel(p, groupBy)}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="text-sm">
                  {data.blocks.map((block) => (
                    <BlockTimeRows
                      key={block.name}
                      block={block}
                      periods={periods}
                      isCollapsed={collapsedBlocks.has(block.name)}
                      onToggle={() => toggleBlock(block.name)}
                    />
                  ))}
                  <tr className="border-t-2 border-white/10 bg-blue-500/[0.05]">
                    <td className="px-4 py-2.5 font-bold text-white text-[12px] sticky left-0 bg-slate-900/90 backdrop-blur-sm z-10">
                      Общий средний балл
                    </td>
                    {periods.map((p) => {
                      const val = data.overallScores[p];
                      return (
                        <td key={p} className={`px-2 py-2.5 text-right font-mono text-[12px] font-bold ${getCriteriaColor(val)}`}>
                          {val !== undefined ? `${val}%` : "—"}
                        </td>
                      );
                    })}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ── Table 2: Criteria × Managers (разбивка по менеджерам) ── */}
      {data && data.managerBreakdown.length > 0 && !managerId && (
        <>
          <div className="text-[11px] uppercase tracking-widest font-bold text-slate-500 mt-2">
            Разбивка по менеджерам
          </div>
          <div className="glass-panel text-slate-200 rounded-2xl overflow-hidden border border-white/5 shadow-2xl">
            <div className="w-full overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-white/10">
                    <th className="px-4 py-2.5 text-[10px] uppercase tracking-widest text-slate-500 font-semibold sticky left-0 bg-slate-900/95 backdrop-blur-sm z-20 min-w-[260px]">
                      Критерий
                    </th>
                    {data.managerBreakdown.map((mgr) => (
                      <th key={mgr.id} className="px-2 py-2 text-center min-w-[80px]">
                        <div className="text-[9px] uppercase tracking-wider text-slate-400 font-bold leading-tight">
                          {mgr.name.split(" ")[0]}
                        </div>
                        <div className="text-[8px] text-slate-600">{mgr.callCount} зв.</div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="text-sm">
                  {data.blocks.map((block, blockIdx) => (
                    <BlockManagerRows
                      key={block.name}
                      blockName={block.name}
                      blockIdx={blockIdx}
                      criteriaNames={block.criteria.map((c) => c.name)}
                      managers={data.managerBreakdown}
                      isCollapsed={collapsedMgrBlocks.has(block.name)}
                      onToggle={() => toggleMgrBlock(block.name)}
                    />
                  ))}
                  {/* Overall row */}
                  <tr className="border-t-2 border-white/10 bg-blue-500/[0.05]">
                    <td className="px-4 py-2.5 font-bold text-white text-[12px] sticky left-0 bg-slate-900/90 backdrop-blur-sm z-10">
                      Общий средний балл
                    </td>
                    {data.managerBreakdown.map((mgr) => (
                      <td key={mgr.id} className={`px-2 py-2.5 text-right font-mono text-[12px] font-bold ${getCriteriaColor(mgr.overallScore)}`}>
                        {mgr.overallScore}%
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* No data */}
      {data && !loading && data.totalCalls === 0 && (
        <div className="glass-panel rounded-2xl p-8 border border-white/5 text-center">
          <p className="text-slate-500 text-sm">Нет данных за выбранный период</p>
        </div>
      )}
    </div>
  );
}

// ==================== Block × Time Rows ====================

function BlockTimeRows({
  block, periods, isCollapsed, onToggle,
}: {
  block: BlockData; periods: string[]; isCollapsed: boolean; onToggle: () => void;
}) {
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
          const val = block.scores[p];
          return (
            <td key={p} className={`px-2 py-2 text-right font-mono text-[11px] font-bold ${getCriteriaColor(val)} ${getCriteriaBg(val)}`}>
              {val !== undefined ? `${val}%` : "—"}
            </td>
          );
        })}
      </tr>
      {!isCollapsed && block.criteria.map((c) => (
        <tr key={`${block.name}-${c.name}`} className="hover:bg-white/[0.02] transition-colors border-b border-white/[0.03]">
          <td className="px-4 py-1.5 text-[11px] text-slate-400 sticky left-0 bg-slate-900/90 backdrop-blur-sm z-10 pl-10">{c.name}</td>
          {periods.map((p) => {
            const val = c.scores[p];
            return (
              <td key={p} className={`px-2 py-1.5 text-right font-mono text-[11px] ${getCriteriaColor(val)}`}>
                {val !== undefined ? `${val}%` : "—"}
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}

// ==================== Block × Managers Rows ====================

function BlockManagerRows({
  blockName, blockIdx, criteriaNames, managers, isCollapsed, onToggle,
}: {
  blockName: string; blockIdx: number; criteriaNames: string[]; managers: ManagerBreakdown[];
  isCollapsed: boolean; onToggle: () => void;
}) {
  return (
    <>
      {/* Block header */}
      <tr className="bg-slate-900/60 border-t border-white/10 cursor-pointer hover:bg-slate-800/40" onClick={onToggle}>
        <td className="px-4 py-2 sticky left-0 bg-slate-900/60 backdrop-blur-sm z-10">
          <div className="flex items-center gap-2">
            {isCollapsed ? <ChevronDown className="w-3.5 h-3.5 text-slate-500" /> : <ChevronUp className="w-3.5 h-3.5 text-slate-500" />}
            <span className="text-[11px] uppercase tracking-widest font-bold text-slate-300">{blockName}</span>
          </div>
        </td>
        {managers.map((mgr) => {
          const block = mgr.blocks[blockIdx];
          const val = block?.score;
          return (
            <td key={mgr.id} className={`px-2 py-2 text-right font-mono text-[11px] font-bold ${getCriteriaColor(val)} ${getCriteriaBg(val)}`}>
              {val !== undefined ? `${val}%` : "—"}
            </td>
          );
        })}
      </tr>
      {/* Criteria rows */}
      {!isCollapsed && criteriaNames.map((cName, cIdx) => (
        <tr key={`${blockName}-mgr-${cName}`} className="hover:bg-white/[0.02] transition-colors border-b border-white/[0.03]">
          <td className="px-4 py-1.5 text-[11px] text-slate-400 sticky left-0 bg-slate-900/90 backdrop-blur-sm z-10 pl-10">{cName}</td>
          {managers.map((mgr) => {
            const block = mgr.blocks[blockIdx];
            const criterion = block?.criteria[cIdx];
            const val = criterion?.score;
            return (
              <td key={mgr.id} className={`px-2 py-1.5 text-right font-mono text-[11px] ${getCriteriaColor(val)}`}>
                {val !== undefined ? `${val}%` : "—"}
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}
