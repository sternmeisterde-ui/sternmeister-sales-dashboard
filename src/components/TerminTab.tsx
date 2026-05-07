"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
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

// ── Shared types & helpers ──────────────────────────

type Preset = "today" | "7d" | "30d" | "month" | "custom";
type Granularity = "day" | "week";
type BucketBy = "created_at" | "termin_date";

const PRESETS: Array<{ id: Preset; label: string }> = [
  { id: "today", label: "Сегодня" },
  { id: "7d", label: "7 дней" },
  { id: "30d", label: "30 дней" },
  { id: "month", label: "Текущий месяц" },
  { id: "custom", label: "Произвольный" },
];

function rangeForPreset(preset: Preset): { start: Date; end: Date } {
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
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const fmtShort = (d: Date) =>
    d.toLocaleDateString("ru-RU", { day: "2-digit", month: "short" });
  return `Неделя ${fmtShort(start)} — ${fmtShort(end)}`;
}

// ── Termin section types ────────────────────────────

interface TerminApiRow {
  date: string;
  dcAvgDays: number | null;
  aaAvgDays: number | null;
  dcCount: number;
  aaCount: number;
  count: number;
  rescheduledCount: number;
}

interface TerminTooltipPayload {
  value: number | null;
  dataKey: string;
  payload: TerminApiRow;
}

function TerminChartTooltip({
  active,
  payload,
  label,
  granularity,
}: {
  active?: boolean;
  payload?: TerminTooltipPayload[];
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
        {row.dcCount > 0 && (
          <span className="text-slate-500 text-[10px]">({row.dcCount})</span>
        )}
      </div>
      <div className="flex items-center gap-2 text-slate-300">
        <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
        Термин АА:{" "}
        <span className="ml-auto font-medium text-emerald-300">
          {row.aaAvgDays == null ? "—" : `${row.aaAvgDays.toFixed(1)} дн.`}
        </span>
        {row.aaCount > 0 && (
          <span className="text-slate-500 text-[10px]">({row.aaCount})</span>
        )}
      </div>
      <div className="mt-1 border-t border-white/5 pt-1 text-[11px] text-slate-400 space-y-0.5">
        <div>
          Сделок: <span className="font-medium text-slate-200">{row.count}</span>
        </div>
        <div>
          Из них перенесено:{" "}
          <span className="font-medium text-amber-300">{row.rescheduledCount}</span>
          {row.count > 0 && (
            <span className="text-slate-500">
              {" "}
              ({((row.rescheduledCount / row.count) * 100).toFixed(0)}%)
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Qual-leads section types ────────────────────────

interface QualLeadsApiRow {
  date: string;
  avgDays: number | null;
  qualCount: number;
  docsCount: number;
  conversion: number | null;
}

interface QualLeadsTooltipPayload {
  value: number | null;
  dataKey: string;
  payload: QualLeadsApiRow;
}

function QualLeadsChartTooltip({
  active,
  payload,
  label,
  granularity,
}: {
  active?: boolean;
  payload?: QualLeadsTooltipPayload[];
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
        <span className="inline-block h-2 w-2 rounded-full bg-amber-400" />
        Ср. дней до Док. в ДЦ:{" "}
        <span className="ml-auto font-medium text-amber-300">
          {row.avgDays == null ? "—" : `${row.avgDays.toFixed(1)} дн.`}
        </span>
      </div>
      <div className="mt-1 border-t border-white/5 pt-1 text-[11px] text-slate-400 space-y-0.5">
        <div>
          Квал лидов:{" "}
          <span className="font-medium text-slate-200">{row.qualCount}</span>
        </div>
        <div>
          Перешли:{" "}
          <span className="font-medium text-slate-200">{row.docsCount}</span>
          {row.conversion != null && (
            <span className="text-slate-400"> ({row.conversion.toFixed(1)}%)</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Tab root ────────────────────────────────────────

export default function TerminTab() {
  return (
    <div className="flex flex-col gap-8 fade-in">
      <TerminDashboardSection
        bucketBy="created_at"
        chartTitle="Среднее время до термина (Бух Бератер)"
        xAxisHint={{
          day: "дата создания сделки",
          week: "неделя создания (с понедельника)",
        }}
      />
      <TerminDashboardSection
        bucketBy="termin_date"
        chartTitle="Среднее время до термина (по дате термина)"
        xAxisHint={{
          day: "дата термина (ДЦ или АА)",
          week: "неделя термина (с понедельника)",
        }}
      />
      <QualLeadsDocsSection />
      <FunnelTimingSection />
      <UpcomingTerminsSection />
      <PreTerminSection />
    </div>
  );
}

// ── Termin dashboard section ────────────────────────

function TerminDashboardSection({
  bucketBy,
  chartTitle,
  xAxisHint,
}: {
  bucketBy: BucketBy;
  chartTitle: string;
  xAxisHint: Record<Granularity, string>;
}) {
  const [preset, setPreset] = useState<Preset>("30d");
  const [range, setRange] = useState<{ start: Date; end: Date }>(() =>
    rangeForPreset("30d"),
  );
  const [granularity, setGranularity] = useState<Granularity>("day");
  // useFirst defaults to TRUE per B1=A: original committed termin date, not
  // whatever's been rescheduled to. Toggle exposed in the filter row.
  const [useFirst, setUseFirst] = useState<boolean>(true);
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
        const useFirstParam = useFirst ? "1" : "0";
        const res = await fetch(
          `/api/dashboard/termins?dateFrom=${dateFrom}&dateTo=${dateTo}&granularity=${granularity}&bucketBy=${bucketBy}&useFirst=${useFirstParam}`,
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
    [range.start, range.end, granularity, bucketBy, useFirst],
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
    const start = r.start;
    const end = r.end ?? r.start;
    setRange({ start, end });
    setPreset("custom");
  };

  const stats = useMemo(() => {
    if (!data || data.length === 0)
      return {
        totalDeals: 0,
        rescheduledTotal: 0,
        dcOverall: null as number | null,
        aaOverall: null as number | null,
      };
    let totalDeals = 0;
    let rescheduledTotal = 0;
    let dcSumWeighted = 0;
    let dcWeight = 0;
    let aaSumWeighted = 0;
    let aaWeight = 0;
    for (const row of data) {
      totalDeals += row.count;
      rescheduledTotal += row.rescheduledCount;
      // Per-leg counts as weights — bucket-level dcCount and aaCount differ
      // from row.count (cohort dedup) in chart 2 where each lead can land in
      // different DC vs AA buckets.
      if (row.dcAvgDays != null && row.dcCount > 0) {
        dcSumWeighted += row.dcAvgDays * row.dcCount;
        dcWeight += row.dcCount;
      }
      if (row.aaAvgDays != null && row.aaCount > 0) {
        aaSumWeighted += row.aaAvgDays * row.aaCount;
        aaWeight += row.aaCount;
      }
    }
    return {
      totalDeals,
      rescheduledTotal,
      dcOverall:
        dcWeight > 0 ? Number((dcSumWeighted / dcWeight).toFixed(1)) : null,
      aaOverall:
        aaWeight > 0 ? Number((aaSumWeighted / aaWeight).toFixed(1)) : null,
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
    <div className="flex flex-col gap-4">
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
          <div
            className="inline-flex p-0.5 rounded-lg bg-slate-800/60 border border-white/5"
            title="Какая дата термина учитывается: первая назначенная или текущая (после переносов)"
          >
            {(
              [
                ["first", "Первая"],
                ["latest", "Текущая"],
              ] as const
            ).map(([key, label]) => {
              const active = (key === "first") === useFirst;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setUseFirst(key === "first")}
                  className={`text-[10px] uppercase tracking-wider px-3 py-1 rounded-md transition-colors ${
                    active
                      ? "bg-blue-500/20 text-blue-300"
                      : "text-slate-400 hover:text-white"
                  }`}
                  aria-pressed={active}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <CalendarPicker
            mode="range"
            value={{ start: range.start, end: range.end }}
            onChange={handleRangeChange}
            onClear={() => handlePreset("30d")}
          />
          <span className="text-xs text-slate-400 hidden sm:inline">
            {dateDisplay}
          </span>
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
            <span className="text-[10px] text-blue-400 font-medium">
              Обновление данных...
            </span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <SummaryTile
          label="Сделок в когорте"
          value={stats.totalDeals.toLocaleString("ru-RU")}
          accent="text-slate-200"
        />
        <SummaryTile
          label="Ср. до Термин ДЦ"
          value={
            stats.dcOverall == null ? "—" : `${stats.dcOverall.toFixed(1)} дн.`
          }
          accent="text-blue-300"
        />
        <SummaryTile
          label="Ср. до Термин АА"
          value={
            stats.aaOverall == null ? "—" : `${stats.aaOverall.toFixed(1)} дн.`
          }
          accent="text-emerald-300"
        />
        <SummaryTile
          label="Перенесено"
          value={
            stats.totalDeals > 0
              ? `${stats.rescheduledTotal.toLocaleString("ru-RU")} (${(
                  (stats.rescheduledTotal / stats.totalDeals) *
                  100
                ).toFixed(0)}%)`
              : "—"
          }
          accent="text-amber-300"
        />
      </div>

      <div className="glass-panel rounded-2xl p-4 sm:p-5 border border-white/5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-slate-300 font-semibold tracking-wide text-xs uppercase">
            {chartTitle}
          </h3>
          <span className="text-[10px] text-slate-500 hidden sm:inline">
            ось X — {xAxisHint[granularity]}
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
                <RTooltip
                  content={<TerminChartTooltip granularity={granularity} />}
                />
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
            <p className="text-sm">
              За выбранный период нет сделок с проставленным термином.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Qual-leads → Документы отправлены в ДЦ section ───

function QualLeadsDocsSection() {
  const [preset, setPreset] = useState<Preset>("30d");
  const [range, setRange] = useState<{ start: Date; end: Date }>(() =>
    rangeForPreset("30d"),
  );
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [data, setData] = useState<QualLeadsApiRow[] | null>(null);
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
          `/api/dashboard/qual-leads-docs?dateFrom=${dateFrom}&dateTo=${dateTo}&granularity=${granularity}`,
          { signal },
        );
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`API error ${res.status}: ${text}`);
        }
        const json = (await res.json()) as QualLeadsApiRow[];
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
    const start = r.start;
    const end = r.end ?? r.start;
    setRange({ start, end });
    setPreset("custom");
  };

  const stats = useMemo(() => {
    if (!data || data.length === 0)
      return {
        qualTotal: 0,
        docsTotal: 0,
        avgOverall: null as number | null,
        conversionOverall: null as number | null,
      };
    let qualTotal = 0;
    let docsTotal = 0;
    let avgSumWeighted = 0;
    let avgWeight = 0;
    for (const row of data) {
      qualTotal += row.qualCount;
      docsTotal += row.docsCount;
      if (row.avgDays != null && row.docsCount > 0) {
        avgSumWeighted += row.avgDays * row.docsCount;
        avgWeight += row.docsCount;
      }
    }
    return {
      qualTotal,
      docsTotal,
      avgOverall:
        avgWeight > 0 ? Number((avgSumWeighted / avgWeight).toFixed(1)) : null,
      conversionOverall:
        qualTotal > 0
          ? Number(((docsTotal / qualTotal) * 100).toFixed(1))
          : null,
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
    <div className="flex flex-col gap-4">
      <div className="glass-panel rounded-2xl border border-white/5 p-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 flex-wrap">
          <CalendarDays className="w-4 h-4 text-amber-400 shrink-0" />
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => handlePreset(p.id)}
              className={`text-[10px] uppercase tracking-wider px-3 py-1.5 rounded-lg border transition-colors ${
                preset === p.id
                  ? "bg-amber-500/20 text-amber-300 border-amber-500/40"
                  : "bg-slate-800/40 text-slate-400 border-white/5 hover:text-white hover:border-white/20"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="inline-flex p-0.5 rounded-lg bg-slate-800/60 border border-white/5">
            {(["day", "week"] as const).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setGranularity(g)}
                className={`text-[10px] uppercase tracking-wider px-3 py-1 rounded-md transition-colors ${
                  granularity === g
                    ? "bg-amber-500/20 text-amber-300"
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
          <span className="text-xs text-slate-400 hidden sm:inline">
            {dateDisplay}
          </span>
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
          <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/20">
            <Loader2 className="w-3 h-3 animate-spin text-amber-400" />
            <span className="text-[10px] text-amber-400 font-medium">
              Обновление данных...
            </span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <SummaryTile
          label="Квал лидов в когорте"
          value={stats.qualTotal.toLocaleString("ru-RU")}
          accent="text-slate-200"
        />
        <SummaryTile
          label="Перешли на «Док. отпр.»"
          value={stats.docsTotal.toLocaleString("ru-RU")}
          accent="text-slate-200"
        />
        <SummaryTile
          label="Ср. дней до перехода"
          value={
            stats.avgOverall == null
              ? "—"
              : `${stats.avgOverall.toFixed(1)} дн.`
          }
          accent="text-amber-300"
        />
        <SummaryTile
          label="Конверсия"
          value={
            stats.conversionOverall == null
              ? "—"
              : `${stats.conversionOverall.toFixed(1)}%`
          }
          accent="text-amber-300"
        />
      </div>

      <div className="glass-panel rounded-2xl p-4 sm:p-5 border border-white/5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-slate-300 font-semibold tracking-wide text-xs uppercase">
            Среднее время до этапа «Документы отправлены в ДЦ»
          </h3>
          <span className="text-[10px] text-slate-500 hidden sm:inline">
            ось X —{" "}
            {granularity === "day"
              ? "дата создания лида"
              : "неделя создания (с понедельника)"}
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
                <RTooltip
                  content={<QualLeadsChartTooltip granularity={granularity} />}
                />
                <Legend
                  wrapperStyle={{ fontSize: 11, color: "#94a3b8" }}
                  iconType="circle"
                />
                <Line
                  type="monotone"
                  dataKey="avgDays"
                  name="Ср. дней до Док. в ДЦ"
                  stroke="#f59e0b"
                  strokeWidth={2}
                  dot={{ fill: "#f59e0b", r: 3 }}
                  connectNulls
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 text-center text-slate-500">
            <CalendarDays className="w-8 h-8 mb-2 text-slate-600" />
            <p className="text-sm">
              За выбранный период нет квалифицированных лидов.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Funnel timing (E1+E2) ───────────────────────────

interface FunnelStageRow {
  from: string;
  fromName: string;
  to: string;
  toName: string;
  count: number;
  avgDays: number | null;
}

function FunnelTimingSection() {
  // 90d default: stage transitions take 20+ days each, so the 30d default used
  // by the cohort sections leaves the funnel mostly empty (most leads in the
  // window haven't completed the next transition yet). 90d shows mature data.
  const initialRange = useMemo(() => {
    const today = todayBerlinDate();
    const start = new Date(today.getTime() - 89 * 86_400_000);
    return { start, end: today };
  }, []);
  const [preset, setPreset] = useState<Preset>("custom");
  const [range, setRange] = useState<{ start: Date; end: Date }>(initialRange);
  const [data, setData] = useState<FunnelStageRow[] | null>(null);
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
          `/api/dashboard/termin-funnel?dateFrom=${dateFrom}&dateTo=${dateTo}`,
          { signal },
        );
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`API error ${res.status}: ${text}`);
        }
        const json = (await res.json()) as FunnelStageRow[];
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
    [range.start, range.end],
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
    setRange({ start: r.start, end: r.end ?? r.start });
    setPreset("custom");
  };

  if (loading && !data) return <DinoLoader />;
  if (error && !data) {
    return (
      <div className="glass-panel rounded-2xl p-8 border border-red-500/20 text-center">
        <AlertTriangle className="w-10 h-10 text-red-400 mx-auto mb-3" />
        <p className="text-red-400 text-sm">{error}</p>
      </div>
    );
  }

  const isRefreshing = loading && !!data;
  const hasData = !!data && data.length > 0 && data.some((s) => s.count > 0);
  const dateDisplay = `${formatRu(range.start)} — ${formatRu(range.end)}`;

  // Distinct hue per stage so the bar chart reads as a sequence.
  const stageColors = ["#8b5cf6", "#06b6d4", "#10b981"];
  const chartData = (data ?? []).map((s, i) => ({
    label: `${s.fromName} → ${s.toName}`,
    avgDays: s.avgDays,
    count: s.count,
    color: stageColors[i] ?? "#94a3b8",
  }));

  return (
    <div className="flex flex-col gap-4">
      <div className="glass-panel rounded-2xl border border-white/5 p-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 flex-wrap">
          <CalendarDays className="w-4 h-4 text-violet-400 shrink-0" />
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => handlePreset(p.id)}
              className={`text-[10px] uppercase tracking-wider px-3 py-1.5 rounded-lg border transition-colors ${
                preset === p.id
                  ? "bg-violet-500/20 text-violet-300 border-violet-500/40"
                  : "bg-slate-800/40 text-slate-400 border-white/5 hover:text-white hover:border-white/20"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 flex-wrap">
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
          <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-violet-500/10 border border-violet-500/20">
            <Loader2 className="w-3 h-3 animate-spin text-violet-400" />
            <span className="text-[10px] text-violet-400 font-medium">Обновление данных...</span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {(data ?? []).map((s, i) => (
          <SummaryTile
            key={s.from + s.to}
            label={`${s.fromName} → ${s.toName}`}
            value={
              s.avgDays == null
                ? "— дн."
                : `${s.avgDays.toFixed(1)} дн.`
            }
            sublabel={`${s.count.toLocaleString("ru-RU")} переходов`}
            accent={
              i === 0
                ? "text-violet-300"
                : i === 1
                  ? "text-cyan-300"
                  : "text-emerald-300"
            }
          />
        ))}
      </div>

      <div className="glass-panel rounded-2xl p-4 sm:p-5 border border-white/5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-slate-300 font-semibold tracking-wide text-xs uppercase">
            Воронка — среднее время между этапами
          </h3>
          <span className="text-[10px] text-slate-500 hidden sm:inline">
            учтены лиды, чей переход состоялся в окне
          </span>
        </div>
        {hasData ? (
          <div className="h-[260px] sm:h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={chartData}
                layout="vertical"
                margin={{ top: 10, right: 80, left: 0, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" horizontal={false} />
                <XAxis
                  type="number"
                  tick={{ fill: "#64748b", fontSize: 11 }}
                  axisLine={{ stroke: "#334155" }}
                  tickLine={false}
                  unit=" дн"
                />
                <YAxis
                  dataKey="label"
                  type="category"
                  tick={{ fill: "#94a3b8", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={260}
                />
                <RTooltip
                  content={({ active, payload }) => {
                    if (!active || !payload || payload.length === 0) return null;
                    const r = payload[0]?.payload as
                      | { label: string; avgDays: number | null; count: number }
                      | undefined;
                    if (!r) return null;
                    return (
                      <div className="rounded-lg border border-white/10 bg-slate-900/95 px-3 py-2 text-xs shadow-lg">
                        <div className="font-semibold text-slate-200 mb-1">{r.label}</div>
                        <div className="text-slate-300">
                          Ср. время:{" "}
                          <span className="font-medium text-violet-300">
                            {r.avgDays == null ? "—" : `${r.avgDays.toFixed(1)} дн.`}
                          </span>
                        </div>
                        <div className="text-slate-300">
                          Переходов:{" "}
                          <span className="font-medium text-slate-200">{r.count}</span>
                        </div>
                      </div>
                    );
                  }}
                />
                <Bar dataKey="avgDays" radius={[0, 6, 6, 0]}>
                  {chartData.map((d) => (
                    <Cell key={d.label} fill={d.color} />
                  ))}
                  <LabelList
                    dataKey="avgDays"
                    position="right"
                    content={(props) => {
                      const {
                        x = 0,
                        y = 0,
                        width = 0,
                        height = 0,
                        index,
                      } = props as {
                        x?: number;
                        y?: number;
                        width?: number;
                        height?: number;
                        index?: number;
                      };
                      const row =
                        index != null ? chartData[index] : undefined;
                      if (!row) return null;
                      const text =
                        row.avgDays == null
                          ? "—"
                          : `${row.avgDays.toFixed(1)} дн (${row.count})`;
                      return (
                        <text
                          x={Number(x) + Number(width) + 8}
                          y={Number(y) + Number(height) / 2 + 4}
                          fill="#e2e8f0"
                          fontSize={12}
                          fontWeight={600}
                        >
                          {text}
                        </text>
                      );
                    }}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 text-center text-slate-500">
            <CalendarDays className="w-8 h-8 mb-2 text-slate-600" />
            <p className="text-sm">За выбранный период нет переходов на этих этапах.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Upcoming termins (D1) ───────────────────────────

interface UpcomingRow {
  date: string;
  dcCount: number;
  aaCount: number;
  totalCount: number;
}

function UpcomingTerminsSection() {
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<UpcomingRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const hasDataRef = useRef(false);

  const fetchData = useCallback(
    async (signal?: AbortSignal) => {
      if (!hasDataRef.current) setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/dashboard/termins-upcoming?days=${days}`, {
          signal,
          // Polling-driven refreshes must hit the server. Without no-store the
          // browser HTTP cache could replay a 60s-old response and the
          // dashboard would drift from CRM until the user manually refreshed.
          cache: "no-store",
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`API error ${res.status}: ${text}`);
        }
        const json = (await res.json()) as UpcomingRow[];
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
    [days],
  );

  useEffect(() => {
    const ac = new AbortController();
    fetchData(ac.signal);

    // Auto-refresh: planning data turns over hourly as managers schedule and
    // reschedule termins. Without polling the dashboard drifts from CRM
    // truth until the user manually clicks refresh.
    const POLL_INTERVAL_MS = 5 * 60 * 1000;
    const interval = setInterval(() => {
      fetchData();
    }, POLL_INTERVAL_MS);

    // Tab returning to foreground after being hidden: refresh immediately.
    // Browsers throttle setInterval in background tabs, so a polling cadence
    // alone isn't enough — switching back triggers a fresh load.
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        fetchData();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      ac.abort();
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [fetchData]);

  const stats = useMemo(() => {
    if (!data || data.length === 0)
      return { totalDc: 0, totalAa: 0, peakDay: null as { date: string; n: number } | null };
    let totalDc = 0;
    let totalAa = 0;
    let peakDay: { date: string; n: number } | null = null;
    for (const r of data) {
      totalDc += r.dcCount;
      totalAa += r.aaCount;
      if (peakDay == null || r.totalCount > peakDay.n) {
        peakDay = { date: r.date, n: r.totalCount };
      }
    }
    return { totalDc, totalAa, peakDay };
  }, [data]);

  if (loading && !data) return <DinoLoader />;
  if (error && !data) {
    return (
      <div className="glass-panel rounded-2xl p-8 border border-red-500/20 text-center">
        <AlertTriangle className="w-10 h-10 text-red-400 mx-auto mb-3" />
        <p className="text-red-400 text-sm">{error}</p>
      </div>
    );
  }

  const isRefreshing = loading && !!data;
  const hasData = !!data && data.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="glass-panel rounded-2xl border border-white/5 p-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 flex-wrap">
          <CalendarDays className="w-4 h-4 text-cyan-400 shrink-0" />
          {[7, 14, 30, 60, 90].map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={`text-[10px] uppercase tracking-wider px-3 py-1.5 rounded-lg border transition-colors ${
                days === d
                  ? "bg-cyan-500/20 text-cyan-300 border-cyan-500/40"
                  : "bg-slate-800/40 text-slate-400 border-white/5 hover:text-white hover:border-white/20"
              }`}
            >
              {d} дн
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 flex-wrap">
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
          <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-cyan-500/10 border border-cyan-500/20">
            <Loader2 className="w-3 h-3 animate-spin text-cyan-400" />
            <span className="text-[10px] text-cyan-400 font-medium">Обновление данных...</span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <SummaryTile
          label="Всего ДЦ-термин на период"
          value={stats.totalDc.toLocaleString("ru-RU")}
          accent="text-blue-300"
        />
        <SummaryTile
          label="Всего АА-термин на период"
          value={stats.totalAa.toLocaleString("ru-RU")}
          accent="text-emerald-300"
        />
        <SummaryTile
          label="Пиковый день"
          value={
            stats.peakDay
              ? `${stats.peakDay.n} (${formatRu(new Date(stats.peakDay.date))})`
              : "—"
          }
          accent="text-cyan-300"
        />
      </div>

      <div className="glass-panel rounded-2xl p-4 sm:p-5 border border-white/5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-slate-300 font-semibold tracking-wide text-xs uppercase">
            Запланировано термин — следующие {days} дней
          </h3>
          <span className="text-[10px] text-slate-500 hidden sm:inline">
            ось X — дата термина (Берлин); исключены статус «Термин ДЦ отменен»
          </span>
        </div>
        {hasData ? (
          <div className="h-[260px] sm:h-[320px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={data ?? []}
                margin={{ top: 5, right: 10, left: -10, bottom: 0 }}
                stackOffset="sign"
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
                  allowDecimals={false}
                />
                <RTooltip
                  content={({ active, payload, label }) => {
                    if (!active || !payload || payload.length === 0 || !label) return null;
                    const r = payload[0]?.payload as UpcomingRow | undefined;
                    if (!r) return null;
                    const d = new Date(label);
                    const dispDate = d.toLocaleDateString("ru-RU", {
                      day: "numeric",
                      month: "long",
                      weekday: "long",
                    });
                    return (
                      <div className="rounded-lg border border-white/10 bg-slate-900/95 px-3 py-2 text-xs shadow-lg">
                        <div className="font-semibold text-slate-200 mb-1">{dispDate}</div>
                        <div className="flex items-center gap-2 text-slate-300">
                          <span className="inline-block h-2 w-2 rounded-full bg-blue-400" />
                          ДЦ: <span className="ml-auto font-medium text-blue-300">{r.dcCount}</span>
                        </div>
                        <div className="flex items-center gap-2 text-slate-300">
                          <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
                          АА: <span className="ml-auto font-medium text-emerald-300">{r.aaCount}</span>
                        </div>
                        <div className="mt-1 border-t border-white/5 pt-1 text-[11px] text-slate-200 font-semibold">
                          Всего: {r.totalCount}
                        </div>
                      </div>
                    );
                  }}
                />
                <Legend
                  wrapperStyle={{ fontSize: 11, color: "#94a3b8" }}
                  iconType="circle"
                />
                <Bar dataKey="dcCount" name="Термин ДЦ" stackId="a" fill="#3b82f6" />
                <Bar dataKey="aaCount" name="Термин АА" stackId="a" fill="#10b981" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 text-center text-slate-500">
            <CalendarDays className="w-8 h-8 mb-2 text-slate-600" />
            <p className="text-sm">На выбранный период нет назначенных термин.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Pre-termin (D2) ─────────────────────────────────

interface PreTerminApiRow {
  bucket: "pre_dc" | "post_dc";
  statusId: number;
  statusName: string;
  count: number;
  avgDaysInStatus: number | null;
}

const BUCKET_META: Record<
  PreTerminApiRow["bucket"],
  { label: string; accent: string; barColor: string }
> = {
  pre_dc: {
    label: "До термина ДЦ",
    accent: "text-blue-300",
    barColor: "#3b82f6",
  },
  post_dc: {
    label: "Между ДЦ и Гутшайном",
    accent: "text-emerald-300",
    barColor: "#10b981",
  },
};

function PreTerminSection() {
  const [data, setData] = useState<PreTerminApiRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const hasDataRef = useRef(false);

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    if (!hasDataRef.current) setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/dashboard/pre-termin`, { signal });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`API error ${res.status}: ${text}`);
      }
      const json = (await res.json()) as PreTerminApiRow[];
      setData(json);
      hasDataRef.current = true;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      if (e instanceof TypeError && e.message === "Failed to fetch") return;
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    fetchData(ac.signal);
    return () => ac.abort();
  }, [fetchData]);

  const buckets = useMemo(() => {
    if (!data)
      return { pre_dc: 0, post_dc: 0 } as Record<
        PreTerminApiRow["bucket"],
        number
      >;
    const sums = { pre_dc: 0, post_dc: 0 } as Record<
      PreTerminApiRow["bucket"],
      number
    >;
    for (const r of data) sums[r.bucket] += r.count;
    return sums;
  }, [data]);

  if (loading && !data) return <DinoLoader />;
  if (error && !data) {
    return (
      <div className="glass-panel rounded-2xl p-8 border border-red-500/20 text-center">
        <AlertTriangle className="w-10 h-10 text-red-400 mx-auto mb-3" />
        <p className="text-red-400 text-sm">{error}</p>
      </div>
    );
  }

  const isRefreshing = loading && !!data;
  const hasData = !!data && data.some((r) => r.count > 0);

  // API ordering IS the funnel timeline (pre_dc statuses first, then post_dc;
  // within each bucket, statuses are ordered by their funnel position with
  // "перенесён" placed next to its consultation pair). We preserve API order
  // here so changes in pre-termin/route.ts STATUS_BUCKETS propagate directly.
  const sortedRows = (data ?? []).filter((r) => r.count > 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="glass-panel rounded-2xl border border-white/5 p-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CalendarDays className="w-4 h-4 text-cyan-400" />
          <span className="text-xs text-slate-300 font-semibold tracking-wide uppercase">
            Ожидающие термин (snapshot)
          </span>
        </div>
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

      {isRefreshing && (
        <div className="flex items-center justify-center">
          <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-cyan-500/10 border border-cyan-500/20">
            <Loader2 className="w-3 h-3 animate-spin text-cyan-400" />
            <span className="text-[10px] text-cyan-400 font-medium">
              Обновление данных...
            </span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {(["pre_dc", "post_dc"] as const).map((b) => (
          <SummaryTile
            key={b}
            label={BUCKET_META[b].label}
            value={buckets[b].toLocaleString("ru-RU")}
            accent={BUCKET_META[b].accent}
          />
        ))}
      </div>

      <div className="glass-panel rounded-2xl p-4 sm:p-5 border border-white/5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-slate-300 font-semibold tracking-wide text-xs uppercase">
            Распределение по статусам
          </h3>
          <span className="text-[10px] text-slate-500 hidden sm:inline">
            avg-дней — среднее время с последнего перехода
          </span>
        </div>
        {hasData ? (
          <div className="h-[400px] sm:h-[440px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={sortedRows}
                layout="vertical"
                margin={{ top: 5, right: 30, left: 0, bottom: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="#1e293b"
                  horizontal={false}
                />
                <XAxis
                  type="number"
                  tick={{ fill: "#64748b", fontSize: 11 }}
                  axisLine={{ stroke: "#334155" }}
                  tickLine={false}
                  allowDecimals={false}
                />
                <YAxis
                  dataKey="statusName"
                  type="category"
                  tick={{ fill: "#94a3b8", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  width={280}
                />
                <RTooltip
                  content={({ active, payload }) => {
                    if (!active || !payload || payload.length === 0) return null;
                    const r = payload[0]?.payload as PreTerminApiRow | undefined;
                    if (!r) return null;
                    return (
                      <div className="rounded-lg border border-white/10 bg-slate-900/95 px-3 py-2 text-xs shadow-lg">
                        <div className="font-semibold text-slate-200 mb-1">
                          {r.statusName}
                        </div>
                        <div className="text-slate-300">
                          В статусе:{" "}
                          <span className="font-medium text-cyan-300">
                            {r.count}
                          </span>
                        </div>
                        <div className="text-slate-300">
                          Ср. время с последнего перехода:{" "}
                          <span className="font-medium text-slate-200">
                            {r.avgDaysInStatus == null
                              ? "—"
                              : `${r.avgDaysInStatus.toFixed(1)} дн.`}
                          </span>
                        </div>
                        <div className="mt-1 text-[10px] text-slate-500">
                          Группа: {BUCKET_META[r.bucket].label}
                        </div>
                      </div>
                    );
                  }}
                />
                <Bar dataKey="count" radius={[0, 6, 6, 0]}>
                  {sortedRows.map((r) => (
                    <Cell key={r.statusId} fill={BUCKET_META[r.bucket].barColor} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 text-center text-slate-500">
            <CalendarDays className="w-8 h-8 mb-2 text-slate-600" />
            <p className="text-sm">Нет лидов в pre-termin статусах.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Shared tile ─────────────────────────────────────

function SummaryTile({
  label,
  value,
  accent,
  sublabel,
}: {
  label: string;
  value: string;
  accent: string;
  sublabel?: string;
}) {
  return (
    <div className="glass-panel rounded-2xl border border-white/5 p-4">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">
        {label}
      </div>
      <div className={`text-xl font-semibold ${accent}`}>{value}</div>
      {sublabel && (
        <div className="text-[10px] text-slate-500 mt-1">{sublabel}</div>
      )}
    </div>
  );
}
