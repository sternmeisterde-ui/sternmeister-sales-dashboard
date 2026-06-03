"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Workflow, Loader2, TriangleAlert } from "lucide-react";
import FunnelFilters from "@/components/funnel/FunnelFilters";
import ConversionCards from "@/components/funnel/ConversionCards";
import FunnelChart from "@/components/funnel/FunnelChart";
import TargetLevelInput from "@/components/funnel/TargetLevelInput";
import ChartModeToggle from "@/components/funnel/ChartModeToggle";
import CohortTable from "@/components/funnel/CohortTable";
import KpiBar from "@/components/funnel/KpiBar";
import UnifiedFunnel from "@/components/funnel/UnifiedFunnel";
import ViewModeToggle, { type FunnelViewMode } from "@/components/funnel/ViewModeToggle";
import ClientsView from "@/components/funnel/ClientsView";
import { todayBerlinDate, fmtLocalDate } from "@/lib/utils/date";
import { CONVERSION_ORDER, CONVERSIONS } from "@/lib/funnel/conversions";
import {
  generateAllMockCohorts,
  summarizeConversion,
} from "@/lib/funnel/mock-data";
import type {
  ChartMode,
  CohortWeek,
  ConversionId,
  ConversionMeta,
  ConversionSummary,
  FilterOption,
  FunnelFiltersState,
} from "@/lib/funnel/types";
import type {
  CohortsApiResponse,
  OverviewResponse,
} from "@/lib/funnel/api-types";

type Department = "b2g" | "b2b";

function buildDefaultFilters(): FunnelFiltersState {
  const end = todayBerlinDate();
  const start = new Date(end);
  start.setMonth(start.getMonth() - 6);
  return {
    dateRange: { start, end },
    maturity: "all",
    source: "",
    responsibleUserId: "",
  };
}

function countActiveFilters(
  state: FunnelFiltersState,
  defaults: FunnelFiltersState
): number {
  const dateChanged =
    state.dateRange.start?.getTime() !== defaults.dateRange.start?.getTime() ||
    state.dateRange.end?.getTime() !== defaults.dateRange.end?.getTime();
  return (
    (dateChanged ? 1 : 0) +
    (state.maturity !== defaults.maturity ? 1 : 0) +
    (state.source !== defaults.source ? 1 : 0) +
    (state.responsibleUserId !== defaults.responsibleUserId ? 1 : 0)
  );
}

interface RealCohortRow {
  isoLabel: string;
  weekStart: Date;
  weekEnd: Date;
  baseCount: number;
  targetCount: number;
  conversionPct: number | null;
  maturityState: "mature" | "immature";
  maturityTargetAt: Date;
  disqualifiedCount: number;
  disqualificationPct: number | null;
  languageLevels: {
    a2: { count: number; pct: number | null };
    b1: { count: number; pct: number | null };
    b2: { count: number; pct: number | null };
    c1: { count: number; pct: number | null };
    unknown: { count: number; pct: number | null };
  };
}

export default function FunnelTab({
  department: _department,
}: {
  department: Department;
}) {
  const defaultFilters = useMemo(() => buildDefaultFilters(), []);
  const [filters, setFilters] = useState<FunnelFiltersState>(defaultFilters);
  const [activeId, setActiveId] = useState<ConversionId>("C1");
  const [selectedWeekStartIso, setSelectedWeekStartIso] = useState<
    string | null
  >(null);

  // Override-цели per-conversion (мержатся из БД на первом fetch).
  const [targetOverrides, setTargetOverrides] = useState<
    Partial<Record<ConversionId, number | null>>
  >({});
  const benchmarksInitialized = useRef(false);

  // Per-conversion статус сохранения цели — для подсказки под input.
  const [saveStatus, setSaveStatus] = useState<
    Partial<Record<ConversionId, string>>
  >({});
  const saveTimers = useRef<Partial<Record<ConversionId, ReturnType<typeof setTimeout>>>>({});

  const [chartMode, setChartMode] = useState<ChartMode>("percent");
  const [viewMode, setViewMode] = useState<FunnelViewMode>("cohorts");

  const activeFilterCount = countActiveFilters(filters, defaultFilters);

  const handleFilterChange = (next: Partial<FunnelFiltersState>) => {
    setFilters((prev) => ({ ...prev, ...next }));
    setSelectedWeekStartIso(null);
  };

  const handleReset = () => {
    setFilters(defaultFilters);
    setSelectedWeekStartIso(null);
  };

  // ── Динамические фильтр-опции (источники/менеджеры) ──
  const [sourceOptions, setSourceOptions] = useState<FilterOption[]>([]);
  const [managerOptions, setManagerOptions] = useState<FilterOption[]>([]);
  const filterOptionsAbort = useRef<AbortController | null>(null);

  // ── Реальные данные C1/C2/C5 с бэка ──
  const [realCohorts, setRealCohorts] = useState<
    Partial<Record<ConversionId, RealCohortRow[]>>
  >({});
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [unsupported, setUnsupported] = useState<ConversionId[]>(["C3", "C4"]);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const inflightAbort = useRef<AbortController | null>(null);

  // ── Обзор: KPI-полоска (§9.1) + объединённая воронка (§9.2) ──
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const overviewAbort = useRef<AbortController | null>(null);

  const fetchCohorts = useCallback(async (state: FunnelFiltersState) => {
    if (!state.dateRange.start || !state.dateRange.end) return;
    inflightAbort.current?.abort();
    const ctrl = new AbortController();
    inflightAbort.current = ctrl;
    setLoading(true);
    setFetchError(null);
    try {
      const params = new URLSearchParams({
        from: fmtLocalDate(state.dateRange.start),
        to: fmtLocalDate(state.dateRange.end),
        maturity_state: state.maturity,
      });
      if (state.source) params.set("source", state.source);
      if (state.responsibleUserId)
        params.set("responsible_user_id", state.responsibleUserId);
      const res = await fetch(`/api/funnel/cohorts?${params}`, {
        signal: ctrl.signal,
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => "")}`);
      }
      const data: CohortsApiResponse = await res.json();
      // На первом fetch — мержим сохранённые в БД benchmarks в локальный state.
      if (!benchmarksInitialized.current) {
        benchmarksInitialized.current = true;
        setTargetOverrides((prev) => ({ ...data.benchmarks, ...prev }));
      }
      // Группируем по conversionId.
      const grouped: Partial<Record<ConversionId, RealCohortRow[]>> = {};
      for (const c of data.cohorts) {
        const arr = (grouped[c.conversionId] ??= []);
        arr.push({
          isoLabel: c.isoLabel,
          weekStart: new Date(c.weekStartIso),
          weekEnd: new Date(c.weekEndIso),
          baseCount: c.baseCount,
          targetCount: c.targetCount,
          conversionPct: c.conversionPct,
          maturityState: c.maturityState,
          maturityTargetAt: new Date(c.maturityTargetAtIso),
          disqualifiedCount: c.disqualifiedCount,
          disqualificationPct: c.disqualificationPct,
          languageLevels: c.languageLevels,
        });
      }
      // Сортируем weekStart по возрастанию.
      for (const arr of Object.values(grouped)) {
        arr?.sort((a, b) => a.weekStart.getTime() - b.weekStart.getTime());
      }
      setRealCohorts(grouped);
      setUnsupported(data.unsupportedConversionIds);
      setLastUpdatedAt(data.lastSyncAtIso ? new Date(data.lastSyncAtIso) : null);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setFetchError(e instanceof Error ? e.message : String(e));
    } finally {
      if (inflightAbort.current === ctrl) {
        inflightAbort.current = null;
        setLoading(false);
      }
    }
  }, []);

  // Фетч обзора (KPI + воронка) — те же фильтры, без maturity.
  const fetchOverview = useCallback(async (state: FunnelFiltersState) => {
    if (!state.dateRange.start || !state.dateRange.end) return;
    overviewAbort.current?.abort();
    const ctrl = new AbortController();
    overviewAbort.current = ctrl;
    setOverviewLoading(true);
    try {
      const params = new URLSearchParams({
        from: fmtLocalDate(state.dateRange.start),
        to: fmtLocalDate(state.dateRange.end),
      });
      if (state.source) params.set("source", state.source);
      if (state.responsibleUserId)
        params.set("responsible_user_id", state.responsibleUserId);
      const res = await fetch(`/api/funnel/overview?${params}`, {
        signal: ctrl.signal,
      });
      if (!res.ok) return;
      const data: OverviewResponse = await res.json();
      if (overviewAbort.current !== ctrl) return;
      setOverview(data);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
    } finally {
      if (overviewAbort.current === ctrl) {
        overviewAbort.current = null;
        setOverviewLoading(false);
      }
    }
  }, []);

  // Debounce — 250ms после смены фильтров. НЕ зависит от viewMode: переключение
  // Когорты⇄Клиенты не перезапрашивает данные — когорты остаются в state и
  // отрисовываются мгновенно при возврате.
  useEffect(() => {
    const id = setTimeout(() => {
      fetchCohorts(filters);
      fetchOverview(filters);
    }, 250);
    return () => clearTimeout(id);
  }, [filters, fetchCohorts, fetchOverview]);

  // ── Фетч динамических фильтр-опций при смене дат (debounce 150ms) ──
  const fetchFilterOptions = useCallback(
    async (start: Date, end: Date) => {
      filterOptionsAbort.current?.abort();
      const ctrl = new AbortController();
      filterOptionsAbort.current = ctrl;
      try {
        const params = new URLSearchParams({
          from: fmtLocalDate(start),
          to: fmtLocalDate(end),
        });
        const res = await fetch(`/api/funnel/filter-options?${params}`, {
          signal: ctrl.signal,
        });
        if (!res.ok) return;
        const data: {
          sources: FilterOption[];
          responsible_users: FilterOption[];
        } = await res.json();
        if (filterOptionsAbort.current !== ctrl) return;
        setSourceOptions(data.sources);
        setManagerOptions(data.responsible_users);
        // Авто-сброс выбранного значения, если оно больше не в списке.
        setFilters((prev) => {
          const next = { ...prev };
          if (
            prev.source &&
            !data.sources.some((o) => o.value === prev.source)
          ) {
            next.source = "";
          }
          if (
            prev.responsibleUserId &&
            !data.responsible_users.some((o) => o.value === prev.responsibleUserId)
          ) {
            next.responsibleUserId = "";
          }
          return next;
        });
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
      }
    },
    []
  );

  useEffect(() => {
    if (!filters.dateRange.start || !filters.dateRange.end) return;
    const start = filters.dateRange.start;
    const end = filters.dateRange.end;
    const id = setTimeout(() => fetchFilterOptions(start, end), 150);
    return () => clearTimeout(id);
  }, [filters.dateRange.start, filters.dateRange.end, fetchFilterOptions]);

  // Моки нужны как fallback для C3/C4 (этап I подключит real).
  const mockCohorts = useMemo(() => generateAllMockCohorts(), []);

  // Конверсии с учётом override-benchmark.
  const conversionBundles = useMemo(() => {
    const bundles = {} as Record<
      ConversionId,
      {
        meta: ConversionMeta;
        cohorts: CohortWeek[];
        summary: ConversionSummary;
        isMock: boolean;
      }
    >;
    for (const id of CONVERSION_ORDER) {
      const benchmark =
        id in targetOverrides
          ? targetOverrides[id] ?? null
          : CONVERSIONS[id].benchmark;
      const meta: ConversionMeta = { ...CONVERSIONS[id], benchmark };

      const isMock = unsupported.includes(id);
      let cohorts: CohortWeek[];
      if (isMock) {
        // Применяем фильтр зрелости к мокам локально.
        cohorts = mockCohorts[id].filter((c) => {
          if (filters.maturity === "mature")
            return c.maturityState === "mature";
          if (filters.maturity === "immature")
            return c.maturityState !== "mature";
          return true;
        });
      } else {
        cohorts = (realCohorts[id] ?? []).map((r) => ({
          isoLabel: r.isoLabel,
          weekStart: r.weekStart,
          weekEnd: r.weekEnd,
          baseCount: r.baseCount,
          targetCount: r.targetCount,
          conversionPct: r.conversionPct,
          maturityState: r.maturityState,
          maturityTargetAt: r.maturityTargetAt,
          disqualifiedCount: r.disqualifiedCount,
          disqualificationPct: r.disqualificationPct,
          languageLevels: r.languageLevels,
        }));
      }
      bundles[id] = {
        meta,
        cohorts,
        summary: summarizeConversion(cohorts, benchmark),
        isMock,
      };
    }
    return bundles;
  }, [
    mockCohorts,
    realCohorts,
    unsupported,
    filters.maturity,
    targetOverrides,
  ]);

  const effectiveBenchmark = (id: ConversionId): number | null => {
    if (id in targetOverrides) return targetOverrides[id] ?? null;
    return CONVERSIONS[id].benchmark;
  };

  // Сохранение benchmark в БД (этап K).
  const saveTargetLevel = useCallback(
    async (id: ConversionId, value: number | null) => {
      setSaveStatus((s) => ({ ...s, [id]: "Сохраняется…" }));
      try {
        const res = await fetch(`/api/funnel/conversions/${id}/target-level`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversion_pct: value }),
        });
        if (!res.ok) {
          const msg =
            res.status === 403
              ? "Нет доступа"
              : res.status === 422
                ? "Введите 0–100"
                : `Ошибка ${res.status}`;
          setSaveStatus((s) => ({ ...s, [id]: msg }));
          return;
        }
        setSaveStatus((s) => ({ ...s, [id]: "Сохранено" }));
        setTimeout(() => {
          setSaveStatus((s) => {
            if (s[id] !== "Сохранено") return s;
            const next = { ...s };
            delete next[id];
            return next;
          });
        }, 1800);
      } catch (e) {
        setSaveStatus((s) => ({
          ...s,
          [id]: e instanceof Error ? e.message : "Ошибка",
        }));
      }
    },
    []
  );

  const handleTargetChange = useCallback(
    (id: ConversionId) => (next: number | null) => {
      setTargetOverrides((prev) => ({ ...prev, [id]: next }));
      const existing = saveTimers.current[id];
      if (existing !== undefined) clearTimeout(existing);
      saveTimers.current[id] = setTimeout(() => {
        saveTargetLevel(id, next);
      }, 500);
    },
    [saveTargetLevel]
  );

  const handleTargetCommit = useCallback(
    (id: ConversionId) => () => {
      const existing = saveTimers.current[id];
      if (existing !== undefined) {
        clearTimeout(existing);
        delete saveTimers.current[id];
      }
      saveTargetLevel(id, effectiveBenchmark(id));
    },
    [saveTargetLevel, targetOverrides] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Параметры для drill-down (from/to/source/responsible_user_id из текущих фильтров).
  const drillBaseParams = useMemo(() => {
    const p = new URLSearchParams();
    if (filters.dateRange.start && filters.dateRange.end) {
      p.set("from", fmtLocalDate(filters.dateRange.start));
      p.set("to", fmtLocalDate(filters.dateRange.end));
    }
    if (filters.source) p.set("source", filters.source);
    if (filters.responsibleUserId)
      p.set("responsible_user_id", filters.responsibleUserId);
    return p;
  }, [filters]);

  const activeBundle = conversionBundles[activeId];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 px-1">
        <Workflow className="w-5 h-5 text-blue-400" />
        <h2 className="text-lg font-semibold text-white">Воронка</h2>
        <span className="text-xs text-slate-400">
          Путь клиента к Gutschein
        </span>
        {loading && (
          <Loader2 className="w-3.5 h-3.5 text-slate-500 animate-spin" />
        )}
      </div>

      <FunnelFilters
        state={filters}
        defaultState={defaultFilters}
        sourceOptions={sourceOptions}
        managerOptions={managerOptions}
        activeFilterCount={activeFilterCount}
        lastUpdatedAt={lastUpdatedAt}
        clientsMode={viewMode === "clients"}
        onChange={handleFilterChange}
        onReset={handleReset}
      />

      <div className="flex items-center gap-3 px-1">
        <ViewModeToggle value={viewMode} onChange={setViewMode} />
      </div>

      {viewMode === "clients" && <ClientsView filters={filters} />}

      {viewMode === "cohorts" && (
        <>
      <div className="flex flex-col lg:flex-row gap-3 items-stretch">
        <div className="flex-1 min-w-0">
          <UnifiedFunnel
            stages={overview?.funnel ?? []}
            loading={overviewLoading && !overview}
          />
        </div>
        <div className="lg:w-60 shrink-0">
          <KpiBar
            kpi={overview?.kpi ?? null}
            loading={overviewLoading && !overview}
          />
        </div>
      </div>

      {fetchError && (
        <div className="glass-panel rounded-2xl border border-rose-500/30 bg-rose-500/5 px-4 py-3 text-sm text-rose-300 flex items-center gap-2">
          <TriangleAlert className="w-4 h-4 shrink-0" />
          <span className="truncate">
            Не удалось загрузить когорты: {fetchError}
          </span>
        </div>
      )}

      {activeBundle?.isMock && (
        <div className="glass-panel rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-300 flex items-center gap-2">
          <TriangleAlert className="w-3.5 h-3.5 shrink-0" />
          <span>
            {activeBundle.meta.id} временно на моках — реальный расчёт появится
            на этапе I (cross-pipeline через `analytics.lead_contact_links`).
          </span>
        </div>
      )}

      <ConversionCards
        conversions={conversionBundles}
        activeId={activeId}
        onSelect={(id) => {
          setActiveId(id);
          setSelectedWeekStartIso(null);
        }}
      />

      <FunnelChart
        meta={activeBundle.meta}
        cohorts={activeBundle.cohorts}
        summary={activeBundle.summary}
        mode={chartMode}
        selectedWeekStartIso={selectedWeekStartIso}
        onSelectWeek={setSelectedWeekStartIso}
        toolbarSlot={
          <div className="flex items-center gap-3">
            <TargetLevelInput
              value={effectiveBenchmark(activeId)}
              onChange={handleTargetChange(activeId)}
              onCommit={handleTargetCommit(activeId)}
              statusText={saveStatus[activeId] ?? null}
            />
            <ChartModeToggle value={chartMode} onChange={setChartMode} />
          </div>
        }
      />

      <CohortTable
        meta={activeBundle.meta}
        cohorts={activeBundle.cohorts}
        selectedWeekStartIso={selectedWeekStartIso}
        onSelectWeek={setSelectedWeekStartIso}
        drillBaseParams={drillBaseParams}
        isMock={activeBundle.isMock}
      />
        </>
      )}
    </div>
  );
}
