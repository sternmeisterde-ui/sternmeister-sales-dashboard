"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AlertTriangle,
  CalendarDays,
  Loader2,
  RefreshCw,
} from "lucide-react";
import CalendarPicker, { type DateRange } from "@/components/CalendarPicker";
import DinoLoader from "@/components/DinoLoader";
import {
  fmtLocalDate as formatDate,
  berlinCivilComponents,
  berlinCivilDate,
  todayBerlinDate,
} from "@/lib/utils/date";

interface TerminApiRow {
  date: string;
  dcAvgDays: number | null;
  aaAvgDays: number | null;
  count: number;
}

type Preset = "today" | "7d" | "30d" | "month" | "custom";
type Granularity = "day" | "week";

const PRESETS: Array<{ id: Preset; label: string }> = [
  { id: "today", label: "Сегодня" },
  { id: "7d", label: "7 дней" },
  { id: "30d", label: "30 дней" },
  { id: "month", label: "Текущий месяц" },
  { id: "custom", label: "Произвольный" },
];

function rangeForPreset(preset: Preset): { start: Date; end: Date } {
  // Berlin business calendar — every preset is a Berlin civil-day window so
  // the picker, the URL, and the SQL agree regardless of browser TZ.
  const today = todayBerlinDate();
  if (preset === "today") return { start: today, end: today };
  if (preset === "7d") {
    const start = new Date(today.getTime() - 6 * 86_400_000);
    return { start, end: today };
  }
  if (preset === "30d") {
    const start = new Date(today.getTime() - 29 * 86_400_000);
    return { start, end: today };
  }
  // current month — first day of the Berlin civil month containing today
  const { y, m } = berlinCivilComponents(today);
  const civil = `${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}-01`;
  const start = berlinCivilDate(civil);
  return { start, end: today };
}

function formatRu(d: Date): string {
  return d.toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "short",
  });
}

interface TooltipPayload {
  value: number | null;
  dataKey: string;
  payload: TerminApiRow;
}

function formatBucketLabel(iso: string, granularity: Granularity): string {
  const start = new Date(iso);
  if (Number.isNaN(start.getTime())) return iso;
  if (granularity === "day") {
    return start.toLocaleDateString("ru-RU", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  }
  // ISO week: bucket key is Monday → end is Sunday (+6 days).
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const fmtShort = (d: Date) =>
    d.toLocaleDateString("ru-RU", { day: "2-digit", month: "short" });
  return `Неделя ${fmtShort(start)} — ${fmtShort(end)}`;
}

function ChartTooltip({
  active,
  payload,
  label,
  granularity,
}: {
  active?: boolean;
  payload?: TooltipPayload[];
  label?: string;
  granularity: Granularity;
}) {
  if (!active || !payload || payload.length === 0 || !label) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  const display = formatBucketLabel(label, granularity);
  return (
    <div className="rounded-lg border border-white/10 bg-slate-900/95 px-3 py-2 text-xs shadow-lg">
      <div className="mb-1 font-semibold text-slate-200">{display}</div>
      <div className="flex items-center gap-2 text-slate-300">
        <span className="inline-block h-2 w-2 rounded-full bg-blue-400" />
        Термин ДЦ:{" "}
        <span className="ml-auto font-medium text-blue-300">
          {row.dcAvgDays == null ? "—" : `${row.dcAvgDays.toFixed(1)} дн.`}
        </span>
      </div>
      <div className="flex items-center gap-2 text-slate-300">
        <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
        Термин АА:{" "}
        <span className="ml-auto font-medium text-emerald-300">
          {row.aaAvgDays == null ? "—" : `${row.aaAvgDays.toFixed(1)} дн.`}
        </span>
      </div>
      <div className="mt-1 border-t border-white/5 pt-1 text-[11px] text-slate-400">
        Сделок: <span className="font-medium text-slate-200">{row.count}</span>
      </div>
    </div>
  );
}

export default function TerminTab() {
  const [preset, setPreset] = useState<Preset>("30d");
  const [range, setRange] = useState<{ start: Date; end: Date }>(() =>
    rangeForPreset("30d"),
  );
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [data, setData] = useState<TerminApiRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const hasDataRef = useRef(false);

  const fetchData = useCallback(
    async (signal?: AbortSignal) => {
      if (!hasDataRef.current) setLoading(true);
      setError(null);
      try {
        const dateFrom = formatDate(range.start);
        const dateTo = formatDate(range.end);
        const res = await fetch(
          `/api/dashboard/termins?dateFrom=${dateFrom}&dateTo=${dateTo}&granularity=${granularity}`,
          { signal },
        );
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`API error ${res.status}: ${text}`);
        }
        const json = (await res.json()) as TerminApiRow[];
        setData(json);
        hasDataRef.current = true;
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        if (e instanceof TypeError && e.message === "Failed to fetch") return;
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [range.start, range.end, granularity],
  );

  useEffect(() => {
    const ac = new AbortController();
    fetchData(ac.signal);
    return () => ac.abort();
  }, [fetchData]);

  const handlePreset = (id: Preset) => {
    setPreset(id);
    if (id !== "custom") setRange(rangeForPreset(id));
  };

  const handleRangeChange = (r: DateRange) => {
    if (!r.start) return;
    // Picker emits Berlin-midnight Dates already; pass them through unchanged
    // (was: startOfDay() which forced browser-local midnight and dropped the
    // Berlin alignment for non-Berlin browsers).
    const start = r.start;
    const end = r.end ?? r.start;
    setRange({ start, end });
    setPreset("custom");
  };

  const stats = useMemo(() => {
    if (!data || data.length === 0)
      return { totalDeals: 0, dcOverall: null as number | null, aaOverall: null as number | null };
    let totalDeals = 0;
    let dcSumWeighted = 0;
    let dcWeight = 0;
    let aaSumWeighted = 0;
    let aaWeight = 0;
    for (const row of data) {
      totalDeals += row.count;
      if (row.dcAvgDays != null) {
        dcSumWeighted += row.dcAvgDays * row.count;
        dcWeight += row.count;
      }
      if (row.aaAvgDays != null) {
        aaSumWeighted += row.aaAvgDays * row.count;
        aaWeight += row.count;
      }
    }
    return {
      totalDeals,
      dcOverall: dcWeight > 0 ? Number((dcSumWeighted / dcWeight).toFixed(1)) : null,
      aaOverall: aaWeight > 0 ? Number((aaSumWeighted / aaWeight).toFixed(1)) : null,
    };
  }, [data]);

  if (loading && !data) return <DinoLoader />;

  if (error && !data) {
    return (
      <div className="glass-panel rounded-2xl p-8 border border-red-500/20 text-center">
        <AlertTriangle className="w-10 h-10 text-red-400 mx-auto mb-3" />
        <p className="text-red-400 text-sm">{error}</p>
        <button
          type="button"
          onClick={() => fetchData()}
          className="mt-4 px-4 py-2 bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 rounded-lg text-sm transition-colors"
        >
          Попробовать снова
        </button>
      </div>
    );
  }

  const isRefreshing = loading && !!data;
  const hasData = !!data && data.length > 0;
  const dateDisplay = `${formatRu(range.start)} — ${formatRu(range.end)}`;

  return (
    <div className="flex flex-col gap-4 fade-in">
      {/* ── Filters row ────────────────────────────── */}
      <div className="glass-panel rounded-2xl border border-white/5 p-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 flex-wrap">
          <CalendarDays className="w-4 h-4 text-blue-400 shrink-0" />
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => handlePreset(p.id)}
              className={`text-[10px] uppercase tracking-wider px-3 py-1.5 rounded-lg border transition-colors ${
                preset === p.id
                  ? "bg-blue-500/20 text-blue-300 border-blue-500/40"
                  : "bg-slate-800/40 text-slate-400 border-white/5 hover:text-white hover:border-white/20"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {/* Day / Week granularity toggle — Recharts re-renders on data
              change so flipping between modes feels instant once both
              responses are cached. */}
          <div className="inline-flex p-0.5 rounded-lg bg-slate-800/60 border border-white/5">
            {(["day", "week"] as const).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setGranularity(g)}
                className={`text-[10px] uppercase tracking-wider px-3 py-1 rounded-md transition-colors ${
                  granularity === g
                    ? "bg-blue-500/20 text-blue-300"
                    : "text-slate-400 hover:text-white"
                }`}
                aria-pressed={granularity === g}
              >
                {g === "day" ? "День" : "Неделя"}
              </button>
            ))}
          </div>
          <CalendarPicker
            mode="range"
            value={{ start: range.start, end: range.end }}
            onChange={handleRangeChange}
            onClear={() => handlePreset("30d")}
          />
          <span className="text-xs text-slate-400 hidden sm:inline">{dateDisplay}</span>
          <button
            type="button"
            onClick={() => fetchData()}
            disabled={loading}
            className="p-2 rounded-lg hover:bg-white/5 text-slate-400 hover:text-white transition-colors disabled:opacity-50"
            title="Обновить"
            aria-label="Обновить"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {isRefreshing && (
        <div className="flex items-center justify-center">
          <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-blue-500/10 border border-blue-500/20">
            <Loader2 className="w-3 h-3 animate-spin text-blue-400" />
            <span className="text-[10px] text-blue-400 font-medium">Обновление данных...</span>
          </div>
        </div>
      )}

      {/* ── Summary tiles ──────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <SummaryTile
          label="Сделок в когорте"
          value={stats.totalDeals.toLocaleString("ru-RU")}
          accent="text-slate-200"
        />
        <SummaryTile
          label="Ср. до Термин ДЦ"
          value={stats.dcOverall == null ? "—" : `${stats.dcOverall.toFixed(1)} дн.`}
          accent="text-blue-300"
        />
        <SummaryTile
          label="Ср. до Термин АА"
          value={stats.aaOverall == null ? "—" : `${stats.aaOverall.toFixed(1)} дн.`}
          accent="text-emerald-300"
        />
      </div>

      {/* ── Chart ──────────────────────────────────── */}
      <div className="glass-panel rounded-2xl p-4 sm:p-5 border border-white/5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-slate-300 font-semibold tracking-wide text-xs uppercase">
            Среднее время до термина (Бух Бератер)
          </h3>
          <span className="text-[10px] text-slate-500 hidden sm:inline">
            ось X — {granularity === "day" ? "дата создания сделки" : "неделя создания (с понедельника)"}
          </span>
        </div>
        {hasData ? (
          <div className="h-[260px] sm:h-[320px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={data ?? []}
                margin={{ top: 5, right: 10, left: -10, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis
                  dataKey="date"
                  tick={{ fill: "#64748b", fontSize: 11 }}
                  axisLine={{ stroke: "#334155" }}
                  tickLine={false}
                  tickFormatter={(v: string) => {
                    const d = new Date(v);
                    if (Number.isNaN(d.getTime())) return v;
                    if (granularity === "week") {
                      // ISO-week starts Monday; show week-start as DD.MM.
                      return d.toLocaleDateString("ru-RU", {
                        day: "2-digit",
                        month: "2-digit",
                      });
                    }
                    return d.toLocaleDateString("ru-RU", {
                      day: "2-digit",
                      month: "2-digit",
                    });
                  }}
                />
                <YAxis
                  tick={{ fill: "#64748b", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  allowDecimals
                  unit=" дн"
                />
                <RTooltip content={<ChartTooltip granularity={granularity} />} />
                <Legend
                  wrapperStyle={{ fontSize: 11, color: "#94a3b8" }}
                  iconType="circle"
                />
                <Line
                  type="monotone"
                  dataKey="dcAvgDays"
                  name="Термин ДЦ"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  dot={{ fill: "#3b82f6", r: 3 }}
                  connectNulls
                />
                <Line
                  type="monotone"
                  dataKey="aaAvgDays"
                  name="Термин АА"
                  stroke="#10b981"
                  strokeWidth={2}
                  dot={{ fill: "#10b981", r: 3 }}
                  connectNulls
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 text-center text-slate-500">
            <CalendarDays className="w-8 h-8 mb-2 text-slate-600" />
            <p className="text-sm">За выбранный период нет сделок с проставленным термином.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryTile({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <div className="glass-panel rounded-2xl border border-white/5 p-4">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">
        {label}
      </div>
      <div className={`text-xl font-semibold ${accent}`}>{value}</div>
    </div>
  );
}
