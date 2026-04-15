"use client";

import { useState, useEffect, useCallback } from "react";
import { Mic, MicOff } from "lucide-react";

interface ManagerWorstCalls {
  id: string;
  name: string;
  line: string | null;
  totalSent: number;
  totalResponded: number;
  responseRate: number | null;
  hasMissed: boolean;
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

  if (loading) return null;

  // Only show managers who have worst calls (totalSent > 0)
  const active = data.filter((m) => m.totalSent > 0);
  if (active.length === 0) return null;

  return (
    <div className="glass-panel rounded-2xl border border-white/5 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-white/5 bg-slate-900/20">
        <span className="text-[11px] font-bold tracking-wide uppercase text-slate-400">
          Разбор ошибок
        </span>
      </div>
      <div className="px-3 py-2.5 flex flex-wrap gap-2">
        {active.map((m) => {
          const missed = m.totalSent - m.totalResponded;
          const allDone = missed === 0;
          return (
            <div
              key={m.id}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-xl border transition-colors ${
                allDone
                  ? "border-white/5 bg-slate-800/30"
                  : "border-amber-500/30 bg-amber-500/[0.06]"
              }`}
            >
              {allDone ? (
                <Mic className="w-4 h-4 text-emerald-400 shrink-0" />
              ) : (
                <MicOff className="w-4 h-4 text-amber-400 shrink-0" />
              )}
              <span className="text-[12px] font-medium text-white whitespace-nowrap">{m.name}</span>
              <span className={`text-[15px] font-bold tabular-nums ${
                allDone ? "text-emerald-400" : "text-amber-400"
              }`}>
                {m.totalResponded}/{m.totalSent}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
