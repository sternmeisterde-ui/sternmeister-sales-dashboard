"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import CalendarPicker, { type DateRange } from "@/components/CalendarPicker";

const TABLE_CONFIG = {
  leads_cohort: { filterCols: ["manager", "pipeline", "status", "category", "utm_source"] },
  communications: { filterCols: ["manager", "communication_type", "pipeline_name"] },
  lead_status_changes: { filterCols: ["manager", "pipeline"] },
  tasks: { filterCols: ["lead_manager", "task_manager"] },
  sla: { filterCols: ["manager", "pipeline_name", "sla_status"] },
  sales_report: { filterCols: ["manager"] },
  ads_report: { filterCols: ["utm_source", "utm_medium"] },
  custom_report: { filterCols: ["manager", "metric_name", "pipeline_name"] },
  funnel: { filterCols: ["manager", "pipeline_name"] },
} as const;

type TableKey = keyof typeof TABLE_CONFIG;

const TABLE_LABELS: { key: TableKey; label: string }[] = [
  { key: "leads_cohort", label: "Лиды" },
  { key: "communications", label: "Коммуникации" },
  { key: "lead_status_changes", label: "Статусы" },
  { key: "tasks", label: "Задачи" },
  { key: "sla", label: "SLA" },
  { key: "sales_report", label: "Продажи" },
  { key: "ads_report", label: "Реклама" },
  { key: "custom_report", label: "Custom" },
  { key: "funnel", label: "Воронка" },
];

const PAGE_SIZE = 100;

interface ApiResponse {
  table: string;
  total: number;
  rows: Record<string, unknown>[];
  filterOptions: Record<string, string[]>;
}

interface SyncResult {
  success: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function colLabel(col: string): string {
  return col
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function formatCell(col: string, value: unknown): string {
  if (value === null || value === undefined) return "—";

  const colLower = col.toLowerCase();
  const isDate = colLower.includes("_at") || colLower.includes("date") || colLower.startsWith("dt");

  if (isDate && (typeof value === "string" || value instanceof Date)) {
    const d = new Date(value as string);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleString("ru-RU", {
        timeZone: "Europe/Berlin",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    }
  }

  if (colLower.endsWith("_seconds") && typeof value === "number") {
    const h = Math.floor(value / 3600);
    const m = Math.round((value % 3600) / 60);
    return `${h}ч ${m}м`;
  }

  if (typeof value === "number") {
    return value.toLocaleString("ru");
  }

  return String(value);
}

function makeDefaultRange(): DateRange {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 30);
  return { start, end };
}

export default function LookerTab() {
  const [table, setTable] = useState<TableKey>("leads_cohort");
  const [dateRange, setDateRange] = useState<DateRange>(makeDefaultRange);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [page, setPage] = useState(0);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string>("");

  const filterDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingFiltersRef = useRef<Record<string, string>>(filters);

  const fetchData = useCallback(
    async (
      currentTable: TableKey,
      currentRange: DateRange,
      currentFilters: Record<string, string>,
      currentPage: number,
    ) => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ table: currentTable });

        if (currentRange.start) params.set("from", toISODate(currentRange.start));
        if (currentRange.end) params.set("to", toISODate(currentRange.end));

        params.set("limit", String(PAGE_SIZE));
        params.set("offset", String(currentPage * PAGE_SIZE));

        for (const [col, val] of Object.entries(currentFilters)) {
          if (val) params.set(col, val);
        }

        const res = await fetch(`/api/analytics/data?${params.toString()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as ApiResponse;
        setData(json);
      } catch (err) {
        console.error("[LookerTab] fetch error", err);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    fetchData(table, dateRange, filters, page);
  }, [table, dateRange, page, filters, fetchData]);

  const applyDebouncedFilters = useCallback(
    (newFilters: Record<string, string>) => {
      pendingFiltersRef.current = newFilters;
      if (filterDebounceRef.current) clearTimeout(filterDebounceRef.current);
      filterDebounceRef.current = setTimeout(() => {
        setPage(0);
        setFilters(pendingFiltersRef.current);
      }, 300);
    },
    [],
  );

  const handleFilterChange = useCallback(
    (col: string, value: string) => {
      const next = { ...pendingFiltersRef.current, [col]: value };
      applyDebouncedFilters(next);
    },
    [applyDebouncedFilters],
  );

  const setQuickRange = useCallback((days: number) => {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - (days - 1));
    setDateRange({ start, end });
    setPage(0);
  }, []);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    setSyncResult("");
    try {
      const from = dateRange.start ? toISODate(dateRange.start) : toISODate(new Date(Date.now() - 30 * 86400 * 1000));
      const to = dateRange.end ? toISODate(dateRange.end) : toISODate(new Date());

      const res = await fetch("/api/analytics/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to }),
      });

      const json = (await res.json()) as SyncResult;

      if (json.success && json.result) {
        const r = json.result as Record<string, unknown>;
        const parts: string[] = [];
        if (typeof r.leads === "number") parts.push(`лидов: ${r.leads}`);
        if (typeof r.communications === "number") parts.push(`комм: ${r.communications}`);
        if (typeof r.sla === "number") parts.push(`SLA: ${r.sla}`);
        if (typeof r.durationMs === "number") parts.push(`${(r.durationMs / 1000).toFixed(1)}с`);
        setSyncResult(parts.length > 0 ? `✓ ${parts.join(", ")}` : "✓ Синхронизировано");
        await fetchData(table, dateRange, filters, page);
      } else {
        setSyncResult(`✗ ${json.error ?? "Ошибка синхронизации"}`);
      }
    } catch (err) {
      setSyncResult(`✗ ${err instanceof Error ? err.message : "Ошибка"}`);
    } finally {
      setSyncing(false);
    }
  }, [dateRange, table, filters, page, fetchData]);

  const columns = data?.rows[0] ? Object.keys(data.rows[0]) : [];
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const hasFilters = Object.values(filters).some(Boolean);
  const totalPages = Math.ceil(total / PAGE_SIZE) || 1;
  const rowStart = page * PAGE_SIZE + 1;
  const rowEnd = Math.min((page + 1) * PAGE_SIZE, total);

  return (
    <div className="flex flex-col gap-4 fade-in flex-1 overflow-y-auto pb-6 scrollbar-hide">
      <div className="glass-panel rounded-2xl px-5 py-3 flex flex-wrap gap-2 items-center border border-white/5">
        <span className="text-[10px] uppercase tracking-widest text-slate-400 mr-2">Таблица</span>
        {TABLE_LABELS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              if (filterDebounceRef.current) clearTimeout(filterDebounceRef.current);
              setTable(key);
              setPage(0);
              setFilters({});
              pendingFiltersRef.current = {};
            }}
            className={`px-3 py-1.5 rounded-xl text-[11px] font-semibold tracking-wide transition-all border ${
              table === key
                ? "bg-blue-500/20 text-blue-400 border-blue-500/30"
                : "text-slate-400 hover:text-white border-transparent hover:border-white/5"
            }`}
          >
            {label}
          </button>
        ))}

        <div className="ml-auto flex items-center gap-3">
          {syncResult && (
            <span
              className={`text-[10px] ${syncResult.startsWith("✓") ? "text-emerald-400" : "text-red-400"}`}
            >
              {syncResult}
            </span>
          )}
          <button
            type="button"
            onClick={handleSync}
            disabled={syncing}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-500/20 border border-blue-500/30 text-blue-300 text-xs font-semibold hover:bg-blue-500/30 disabled:opacity-50 transition-all"
          >
            {syncing ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            Синхронизировать
          </button>
        </div>
      </div>

      <div className="glass-panel rounded-2xl px-5 py-3 flex flex-wrap gap-3 items-center border border-white/5">
        <CalendarPicker
          mode="range"
          value={dateRange}
          onChange={(r) => {
            setDateRange(r);
            setPage(0);
          }}
          onClear={() => {
            setDateRange(makeDefaultRange());
            setPage(0);
          }}
        />

        {([7, 14, 30, 90] as const).map((days) => (
          <button
            key={days}
            type="button"
            onClick={() => setQuickRange(days)}
            className="text-[10px] px-2.5 py-1.5 rounded-lg bg-slate-800/60 border border-white/10 text-slate-400 hover:text-white hover:bg-slate-700/60 transition-all"
          >
            {days}д
          </button>
        ))}

        {TABLE_CONFIG[table].filterCols.map((col) => (
          <select
            key={col}
            value={pendingFiltersRef.current[col] ?? ""}
            onChange={(e) => handleFilterChange(col, e.target.value)}
            className="bg-slate-800/60 border border-white/10 rounded-xl px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-blue-500/50 transition-colors"
          >
            <option value="">Все ({colLabel(col)})</option>
            {data?.filterOptions[col]?.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        ))}

        {hasFilters && (
          <button
            type="button"
            onClick={() => {
              if (filterDebounceRef.current) clearTimeout(filterDebounceRef.current);
              setFilters({});
              pendingFiltersRef.current = {};
              setPage(0);
            }}
            className="text-[10px] text-slate-400 hover:text-red-400 transition-colors"
          >
            ✕ сбросить
          </button>
        )}
      </div>

      <div className="flex items-center gap-4 px-1">
        <span className="text-xs text-slate-400">
          {loading
            ? "Загрузка..."
            : `${total.toLocaleString("ru")} строк · показано ${rowStart}–${rowEnd}`}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0 || loading}
            className="w-7 h-7 flex items-center justify-center rounded-lg bg-slate-800/60 border border-white/10 text-slate-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-all text-sm"
          >
            ‹
          </button>
          <span className="text-xs text-slate-400">
            Стр. {page + 1} / {totalPages}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => p + 1)}
            disabled={(page + 1) * PAGE_SIZE >= total || loading}
            className="w-7 h-7 flex items-center justify-center rounded-lg bg-slate-800/60 border border-white/10 text-slate-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-all text-sm"
          >
            ›
          </button>
        </div>
      </div>

      <div className="glass-panel rounded-2xl overflow-hidden border border-white/5">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-white/10">
                {columns.map((col) => (
                  <th
                    key={col}
                    className="px-4 py-3 text-[10px] uppercase tracking-widest text-slate-400 font-semibold whitespace-nowrap"
                  >
                    {colLabel(col)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td
                    colSpan={Math.max(columns.length, 1)}
                    className="text-center py-16 text-slate-400"
                  >
                    <Loader2 className="w-5 h-5 animate-spin mx-auto" />
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={Math.max(columns.length, 1)}
                    className="text-center py-16 text-slate-500 text-xs"
                  >
                    Нет данных за выбранный период
                  </td>
                </tr>
              ) : (
                rows.map((row, i) => (
                  <tr
                    key={i}
                    className="border-t border-white/5 hover:bg-white/[0.03] transition-colors"
                  >
                    {columns.map((col) => (
                      <td
                        key={col}
                        className="px-4 py-2.5 text-slate-200 whitespace-nowrap max-w-[200px] truncate"
                        title={String(row[col] ?? "")}
                      >
                        {formatCell(col, row[col])}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
