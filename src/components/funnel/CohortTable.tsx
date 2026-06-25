"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CohortWeek,
  ConversionMeta,
  LanguageBreakdown,
} from "@/lib/funnel/types";
import {
  qualityColumnLabel,
  usesQualificationRetention,
} from "@/lib/funnel/conversions";
import {
  fmtCount,
  fmtDeltaPp,
  fmtPercent,
  fmtWeekRange,
} from "@/lib/funnel/format";
import LeadDrillPopover, {
  type DrillLead,
} from "@/components/funnel/LeadDrillPopover";
import HoverTip from "@/components/funnel/HoverTip";

interface Props {
  meta: ConversionMeta;
  cohorts: CohortWeek[];
  selectedWeekStartIso: string | null;
  onSelectWeek: (weekStartIso: string) => void;
  /** URLSearchParams для drill (from/to/source/responsible_user_id). */
  drillBaseParams: URLSearchParams;
  /** Конверсии на моках — drill для них показывает заглушку. */
  isMock?: boolean;
}

interface DrillState {
  anchorEl: HTMLElement;
  weekStartIso: string;
  isoLabel: string;
  metric: "base" | "target";
  count: number;
}

const LANGUAGE_KEYS: Array<{ key: keyof LanguageBreakdown; label: string }> = [
  { key: "a1", label: "A1" },
  { key: "a2", label: "A2" },
  { key: "b1", label: "B1" },
  { key: "b2", label: "B2" },
  { key: "c1", label: "C1" },
];

export default function CohortTable({
  meta,
  cohorts,
  selectedWeekStartIso,
  onSelectWeek,
  drillBaseParams,
  isMock = false,
}: Props) {
  const qualityHeader = qualityColumnLabel(meta.id);
  const usesRetention = usesQualificationRetention(meta.id);
  const benchmark = meta.benchmark;
  const [drill, setDrill] = useState<DrillState | null>(null);
  const [drillData, setDrillData] = useState<{
    leads: DrillLead[];
    loading: boolean;
    error: string | null;
    /** Точное число с бэка — может отличаться от drill.count (initial из строки). */
    totalCount: number | null;
  }>({ leads: [], loading: false, error: null, totalCount: null });
  const inflightAbort = useRef<AbortController | null>(null);

  // Сортировка по неделе по убыванию (свежие сверху).
  const sortedRows = useMemo(
    () => cohorts.slice().sort((a, b) => b.weekStart.getTime() - a.weekStart.getTime()),
    [cohorts]
  );

  const openDrill = (
    e: React.MouseEvent<HTMLButtonElement>,
    row: CohortWeek,
    metric: "base" | "target"
  ) => {
    e.stopPropagation();
    setDrill({
      anchorEl: e.currentTarget,
      weekStartIso: row.weekStart.toISOString().slice(0, 10),
      isoLabel: row.isoLabel,
      metric,
      count: metric === "base" ? row.baseCount : row.targetCount,
    });
    onSelectWeek(row.weekStart.toISOString().slice(0, 10));
  };

  // Фетчим лидов при изменении drill (по weekStartIso + metric — не по объекту).
  // Важно: не обновляем drill из этого эффекта — иначе бесконечный re-fetch loop.
  const drillKey = drill ? `${drill.weekStartIso}|${drill.metric}` : null;
  useEffect(() => {
    if (!drill) {
      inflightAbort.current?.abort();
      inflightAbort.current = null;
      setDrillData({ leads: [], loading: false, error: null, totalCount: null });
      return;
    }
    if (isMock) {
      setDrillData({
        leads: [],
        loading: false,
        error: `Drill-down для ${meta.id} временно недоступен (конверсия на моках)`,
        totalCount: null,
      });
      return;
    }
    inflightAbort.current?.abort();
    const ctrl = new AbortController();
    inflightAbort.current = ctrl;
    setDrillData({ leads: [], loading: true, error: null, totalCount: null });
    const params = new URLSearchParams(drillBaseParams);
    params.set("metric", drill.metric);
    fetch(
      `/api/funnel/cohorts/${meta.id}/${drill.weekStartIso}/leads?${params}`,
      { signal: ctrl.signal }
    )
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => "")}`);
        }
        return res.json();
      })
      .then((data: { leads: DrillLead[]; count: number }) => {
        if (inflightAbort.current !== ctrl) return;
        setDrillData({
          leads: data.leads,
          loading: false,
          error: null,
          totalCount: data.count,
        });
      })
      .catch((e) => {
        if ((e as Error).name === "AbortError") return;
        if (inflightAbort.current !== ctrl) return;
        setDrillData({
          leads: [],
          loading: false,
          error: e instanceof Error ? e.message : String(e),
          totalCount: null,
        });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drillKey, meta.id, isMock, drillBaseParams]);

  return (
    <section
      className="glass-panel rounded-2xl border border-white/5 p-4 flex flex-col gap-3"
      aria-label="Таблица когорт"
    >
      <div className="flex items-baseline justify-between">
        <h3 className="text-base font-semibold text-white">Таблица когорт</h3>
        <span className="text-[11px] text-slate-400 tabular-nums">
          {cohorts.length} недель в выборке
        </span>
      </div>

      <div className="overflow-auto -mx-2 max-h-[420px]">
        <table className="w-full text-sm border-collapse">
          <thead className="sticky top-0 bg-slate-900/95 backdrop-blur z-10">
            <tr className="text-[10px] uppercase tracking-widest text-slate-500 border-b border-white/5">
              <Th align="left">Неделя</Th>
              <Th align="right">Лиды</Th>
              <Th align="right">Цель</Th>
              <Th align="right">Факт</Th>
              <Th align="right">Конв.</Th>
              <Th align="right">Откл.</Th>
              <Th align="left">Статус</Th>
              <Th align="right" title={qualityHeader}>
                {qualityHeader}
              </Th>
              {LANGUAGE_KEYS.map((l) => (
                <Th key={l.key} align="right">
                  {l.label}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRows.length === 0 ? (
              <tr>
                <td
                  colSpan={8 + LANGUAGE_KEYS.length}
                  className="text-center py-6 text-slate-500 text-sm"
                >
                  Нет данных по выбранным фильтрам
                </td>
              </tr>
            ) : (
              sortedRows.map((row) => {
                const iso = row.weekStart.toISOString().slice(0, 10);
                const isSelected = iso === selectedWeekStartIso;
                const isMature = row.maturityState === "mature";
                const plannedTarget =
                  benchmark === null
                    ? null
                    : Math.ceil((row.baseCount * benchmark) / 100);
                const benchmarkDelta =
                  benchmark === null || row.conversionPct === null
                    ? null
                    : row.conversionPct - benchmark;
                const qualityValue = usesRetention
                  ? row.disqualificationPct === null
                    ? "—"
                    : fmtPercent(Math.max(0, 100 - row.disqualificationPct), 1)
                  : (() => {
                      const dropoff = Math.max(0, row.baseCount - row.targetCount);
                      const pct =
                        row.baseCount > 0
                          ? (dropoff / row.baseCount) * 100
                          : null;
                      return `${fmtCount(dropoff)} (${fmtPercent(pct, 1)})`;
                    })();
                return (
                  <tr
                    key={iso}
                    role="button"
                    tabIndex={0}
                    aria-selected={isSelected}
                    onClick={() => onSelectWeek(iso)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelectWeek(iso);
                      }
                    }}
                    className={`border-b border-white/5 cursor-pointer transition-colors ${
                      isSelected
                        ? "bg-blue-500/10"
                        : "hover:bg-white/[0.02]"
                    } ${!isMature ? "text-slate-400" : "text-slate-100"}`}
                  >
                    <td className="px-2 py-2 text-xs font-mono whitespace-nowrap">
                      <HoverTip label={fmtWeekRange(row.weekStart)}>
                        <span>
                          {row.isoLabel} ·{" "}
                          <span className="text-slate-400">
                            {row.weekStart.toLocaleDateString("ru-RU", {
                              day: "2-digit",
                              month: "2-digit",
                            })}
                          </span>
                        </span>
                      </HoverTip>
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      <CountPill
                        value={row.baseCount}
                        active={
                          drill?.weekStartIso === iso && drill.metric === "base"
                        }
                        onClick={(e) => openDrill(e, row, "base")}
                      />
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-slate-400">
                      {plannedTarget === null ? "—" : fmtCount(plannedTarget)}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      <CountPill
                        value={row.targetCount}
                        active={
                          drill?.weekStartIso === iso && drill.metric === "target"
                        }
                        onClick={(e) => openDrill(e, row, "target")}
                      />
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums font-semibold">
                      {fmtPercent(row.conversionPct, 1)}
                    </td>
                    <td
                      className={`px-2 py-2 text-right tabular-nums ${
                        benchmarkDelta === null
                          ? "text-slate-500"
                          : benchmarkDelta < 0
                            ? "text-rose-400"
                            : benchmarkDelta > 0
                              ? "text-emerald-400"
                              : "text-slate-400"
                      }`}
                    >
                      {fmtDeltaPp(benchmarkDelta)}
                    </td>
                    <td className="px-2 py-2">
                      <HoverTip
                        label={
                          isMature
                            ? `Зрелая с ${formatMaturityDate(row.maturityTargetAt)}`
                            : `Будет зрелой ${formatMaturityDate(row.maturityTargetAt)}`
                        }
                      >
                        <span
                          className={`text-[10px] uppercase tracking-widest rounded px-1.5 py-0.5 ${
                            isMature
                              ? "text-emerald-400 bg-emerald-500/10 border border-emerald-500/20"
                              : "text-slate-400 bg-slate-500/10 border border-slate-500/20"
                          }`}
                        >
                          {isMature ? "зрелая" : "незрелая"}
                        </span>
                      </HoverTip>
                    </td>
                    <td
                      className="px-2 py-2 text-right tabular-nums"
                      title={qualityHeader}
                    >
                      {qualityValue}
                    </td>
                    {LANGUAGE_KEYS.map((l) => {
                      const cell = row.languageLevels[l.key];
                      return (
                        <td
                          key={l.key}
                          className="px-2 py-2 text-right tabular-nums text-slate-400 text-xs whitespace-nowrap"
                        >
                          {fmtCount(cell.count)}{" "}
                          <span className="text-slate-600">
                            ({fmtPercent(cell.pct, 0)})
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {drill && (
        <LeadDrillPopover
          anchorEl={drill.anchorEl}
          title={drill.metric === "target" ? "Факт" : "Лиды"}
          subtitle={`${meta.id} · ${drill.isoLabel}`}
          totalCount={drillData.totalCount ?? drill.count}
          leads={drillData.leads}
          loading={drillData.loading}
          error={drillData.error}
          onClose={() => setDrill(null)}
        />
      )}
    </section>
  );
}

function Th({
  children,
  align,
  title,
}: {
  children: React.ReactNode;
  align: "left" | "right";
  title?: string;
}) {
  return (
    <th
      title={title}
      className={`font-semibold px-2 py-2 ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

function formatMaturityDate(d: Date): string {
  return d.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function CountPill({
  value,
  active,
  onClick,
}: {
  value: number;
  active: boolean;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-block min-w-[40px] px-2 py-0.5 rounded border text-xs tabular-nums transition-colors ${
        active
          ? "border-blue-400/40 bg-blue-500/20 text-blue-200"
          : "border-white/10 bg-slate-800/40 text-slate-100 hover:border-white/25 hover:bg-slate-700/40"
      }`}
    >
      {fmtCount(value)}
    </button>
  );
}
