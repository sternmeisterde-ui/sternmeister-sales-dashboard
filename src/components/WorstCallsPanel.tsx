"use client";

import { useState, useEffect, useCallback } from "react";
import { AlertTriangle, CheckCircle2, XCircle, Loader2 } from "lucide-react";

interface ManagerWorstCalls {
  id: string;
  name: string;
  line: string | null;
  totalSent: number;
  totalResponded: number;
  totalAdequate: number;
  responseRate: number | null;
  hasMissed: boolean;
  missedResponses: Array<{ date: string; period: string; score: number }>;
  entries: Array<{ date: string; period: string; score: number; responded: boolean; adequate: boolean | null }>;
}

export default function WorstCallsPanel({
  department,
  from,
  to,
  lineFilter,
}: {
  department: "b2g" | "b2b";
  from: string;
  to: string;
  lineFilter: string;
}) {
  const [data, setData] = useState<ManagerWorstCalls[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const params = new URLSearchParams({ department, from, to });
      if (lineFilter && lineFilter !== "all") params.set("line", lineFilter);
      const res = await fetch(`/api/okk/worst-calls?${params}`);
      const json = await res.json();
      if (json.success) setData(json.data);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [department, from, to, lineFilter]);

  useEffect(() => {
    setLoading(true);
    fetchData();
  }, [fetchData]);

  // Don't render if no data yet
  if (loading) {
    return (
      <div className="glass-panel rounded-2xl p-4 border border-white/5">
        <div className="flex items-center gap-2 text-slate-500 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          Загрузка разбора ошибок...
        </div>
      </div>
    );
  }

  if (data.length === 0) return null;

  const managersWithMissed = data.filter((m) => m.hasMissed);
  const allGood = managersWithMissed.length === 0;

  return (
    <div className="glass-panel rounded-2xl border border-white/5 overflow-hidden shadow-lg">
      <div className="p-4 border-b border-white/5 bg-slate-900/20 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {allGood ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          ) : (
            <AlertTriangle className="w-4 h-4 text-amber-400" />
          )}
          <h3 className="text-sm font-bold tracking-wide uppercase text-slate-200">
            Разбор ошибок (голосовые)
          </h3>
          {!allGood && (
            <span className="text-[10px] bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded-full font-medium">
              {managersWithMissed.length} не записал{managersWithMissed.length === 1 ? "" : "и"}
            </span>
          )}
        </div>
      </div>

      <div className="p-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
          {data.map((mgr) => (
            <ManagerCard key={mgr.id} manager={mgr} />
          ))}
        </div>
      </div>
    </div>
  );
}

function ManagerCard({ manager: m }: { manager: ManagerWorstCalls }) {
  const lineLabel = m.line === "1" ? "Квалиф." : m.line === "2" ? "Бератер" : m.line === "3" ? "Довед." : "";
  const hasIssue = m.hasMissed;
  const rate = m.responseRate;

  return (
    <div className={`rounded-xl border px-3 py-2.5 transition-colors ${
      hasIssue
        ? "border-amber-500/30 bg-amber-500/[0.05]"
        : "border-white/5 bg-slate-800/20"
    }`}>
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5">
          {hasIssue ? (
            <XCircle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          ) : (
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
          )}
          <span className="text-[12px] font-medium text-white truncate max-w-[120px]">{m.name}</span>
        </div>
        {lineLabel && (
          <span className="text-[9px] text-slate-500 uppercase tracking-wider">{lineLabel}</span>
        )}
      </div>

      <div className="flex items-center gap-3 text-[11px]">
        <span className="text-slate-400">
          {m.totalResponded}/{m.totalSent} отв.
        </span>
        {rate !== null && (
          <span className={rate >= 80 ? "text-emerald-400" : rate >= 50 ? "text-amber-400" : "text-rose-400"}>
            {rate}%
          </span>
        )}
        {m.totalAdequate > 0 && (
          <span className="text-emerald-400/60 text-[10px]">
            ✓ {m.totalAdequate} адекв.
          </span>
        )}
      </div>

      {m.missedResponses.length > 0 && (
        <div className="mt-1.5 space-y-0.5">
          {m.missedResponses.slice(0, 3).map((miss, i) => (
            <div key={i} className="text-[10px] text-amber-400/80">
              ⚠ {miss.date.slice(5)} {miss.period === "morning" ? "утро" : "день"} — {miss.score}%
            </div>
          ))}
          {m.missedResponses.length > 3 && (
            <div className="text-[10px] text-slate-500">
              ...и ещё {m.missedResponses.length - 3}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
