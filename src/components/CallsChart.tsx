"use client";

import { useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

interface CallData {
  name: string;
  date: string;
  score: number;
}

interface CallsChartProps {
  calls: CallData[];
  period: "day" | "week" | "month";
  customRange: { start: Date | null; end: Date | null };
  parseCallDate: (dateStr: string) => Date;
  type: "ai_calls" | "real_calls";
}

export default function CallsChart({
  calls,
  period,
  customRange,
  parseCallDate,
  type,
}: CallsChartProps) {
  const aggregation: "day" | "week" = type === "real_calls" ? "week" : "day";

  const chartData = useMemo(() => {
    const buckets = new Map<string, { scores: number[]; count: number; sortKey: string; label: string }>();

    for (const call of calls) {
      const d = parseCallDate(call.date);

      let sortKey: string;
      let label: string;

      if (aggregation === "week") {
        // Week starts on Monday. Bucket key = ISO date of Monday (YYYY-MM-DD).
        const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        const dow = monday.getDay(); // 0=Sun..6=Sat
        const diff = dow === 0 ? -6 : 1 - dow;
        monday.setDate(monday.getDate() + diff);
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);

        sortKey = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, "0")}-${String(monday.getDate()).padStart(2, "0")}`;
        const fmt = (x: Date) => `${String(x.getDate()).padStart(2, "0")}.${String(x.getMonth() + 1).padStart(2, "0")}`;
        label = `${fmt(monday)}–${fmt(sunday)}`;
      } else {
        sortKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        label = `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
      }

      if (!buckets.has(sortKey)) buckets.set(sortKey, { scores: [], count: 0, sortKey, label });
      const entry = buckets.get(sortKey)!;
      entry.count++;
      if (call.score > 0) entry.scores.push(call.score);
    }

    const sorted = [...buckets.values()].sort((a, b) => a.sortKey.localeCompare(b.sortKey));

    return sorted.map((v) => ({
      date: v.label,
      avgScore: v.scores.length > 0 ? Math.round(v.scores.reduce((s, x) => s + x, 0) / v.scores.length) : 0,
      count: v.count,
    }));
  }, [calls, parseCallDate, aggregation]);

  if (chartData.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-slate-500 text-sm">
        Нет данных за период
      </div>
    );
  }

  const maxCount = Math.max(...chartData.map((d) => d.count), 1);
  const tickWidth = aggregation === "week" ? 90 : 60;
  const chartWidth = Math.max(chartData.length * tickWidth, 300);
  const needsScroll = period === "month" || (customRange.start && customRange.end);
  const periodLabel = aggregation === "week" ? "по неделям" : "по дням";

  return (
    <div className="flex flex-col gap-4 h-full">
      {/* Chart 1: Average Score */}
      <div className="flex-1 min-h-0">
        <p className="text-[10px] text-slate-400 uppercase tracking-widest font-semibold mb-1">
          Средний балл ({periodLabel})
        </p>
        <div
          className={needsScroll ? "overflow-x-auto" : ""}
          style={needsScroll ? { maxWidth: "100%" } : undefined}
        >
          <div style={needsScroll ? { width: chartWidth, minHeight: 120 } : { width: "100%", minHeight: 120 }}>
            <ResponsiveContainer width="100%" height={120}>
              <LineChart data={chartData} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis
                  dataKey="date"
                  tick={{ fill: "#64748b", fontSize: 10 }}
                  axisLine={{ stroke: "#334155" }}
                  tickLine={false}
                />
                <YAxis
                  domain={[0, 100]}
                  tick={{ fill: "#64748b", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  tickCount={3}
                />
                <Tooltip
                  contentStyle={{
                    background: "#0f172a",
                    border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  formatter={(value) => [`${value}%`, "Ср. балл"]}
                />
                <Line
                  type="monotone"
                  dataKey="avgScore"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  dot={{ fill: "#3b82f6", r: 3 }}
                  activeDot={{ r: 5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Chart 2: Call Count */}
      <div className="flex-1 min-h-0">
        <p className="text-[10px] text-slate-400 uppercase tracking-widest font-semibold mb-1">
          {type === "ai_calls" ? "Кол-во ролевок" : "Кол-во звонков"} ({periodLabel})
        </p>
        <div
          className={needsScroll ? "overflow-x-auto" : ""}
          style={needsScroll ? { maxWidth: "100%" } : undefined}
        >
          <div style={needsScroll ? { width: chartWidth, minHeight: 120 } : { width: "100%", minHeight: 120 }}>
            <ResponsiveContainer width="100%" height={120}>
              <LineChart data={chartData} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis
                  dataKey="date"
                  tick={{ fill: "#64748b", fontSize: 10 }}
                  axisLine={{ stroke: "#334155" }}
                  tickLine={false}
                />
                <YAxis
                  domain={[0, Math.ceil(maxCount * 1.2)]}
                  tick={{ fill: "#64748b", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  tickCount={3}
                  allowDecimals={false}
                />
                <Tooltip
                  contentStyle={{
                    background: "#0f172a",
                    border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  formatter={(value) => [value, type === "ai_calls" ? "Ролевок" : "Звонков"]}
                />
                <Line
                  type="monotone"
                  dataKey="count"
                  stroke="#10b981"
                  strokeWidth={2}
                  dot={{ fill: "#10b981", r: 3 }}
                  activeDot={{ r: 5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}
