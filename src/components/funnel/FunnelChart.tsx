"use client";

import { useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  ChartMode,
  CohortWeek,
  ConversionMeta,
  ConversionSummary,
  MaturityFilter,
} from "@/lib/funnel/types";
import {
  conversionNote,
  qualityColumnLabel,
  usesQualificationRetention,
} from "@/lib/funnel/conversions";
import { fmtCount, fmtPercent, fmtShortDate } from "@/lib/funnel/format";
import InfoPopover from "@/components/funnel/InfoPopover";

interface Props {
  meta: ConversionMeta;
  cohorts: CohortWeek[];
  summary: ConversionSummary;
  mode: ChartMode;
  /** Текущий фильтр зрелости — определяет подпись и базис средней. */
  maturity: MaturityFilter;
  selectedWeekStartIso: string | null;
  onSelectWeek: (weekStartIso: string | null) => void;
  /** Слот для тулбара (Цель,% / тогглер режима / кнопка сравнения). */
  toolbarSlot?: React.ReactNode;
}

export default function FunnelChart({
  meta,
  cohorts,
  summary,
  mode,
  maturity,
  selectedWeekStartIso,
  onSelectWeek,
  toolbarSlot,
}: Props) {
  // Готовим данные графика. 2 серии — mature и immature — для разного визуала.
  // Чтобы линии не рвались между зрелым и незрелым хвостом, последняя зрелая
  // точка дублируется и в серию immature (точка-«мост»).
  const chartData = useMemo(() => {
    const rows = cohorts.map((c) => {
      const pct = c.conversionPct;
      return {
        weekStartIso: c.weekStart.toISOString().slice(0, 10),
        isoLabel: c.isoLabel,
        weekStartShort: fmtShortDate(c.weekStart),
        mature: c.maturityState === "mature" && pct !== null ? pct : null,
        immature: c.maturityState !== "mature" && pct !== null ? pct : null,
        rawPct: pct,
        baseCount: c.baseCount,
        targetCount: c.targetCount,
        disqualificationPct: c.disqualificationPct,
        maturityState: c.maturityState,
      };
    });
    // Найти последнюю зрелую точку и положить её значение в immature, чтобы
    // линия immature начиналась оттуда, без визуального разрыва.
    let lastMatureIdx = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].mature !== null) {
        lastMatureIdx = i;
        break;
      }
    }
    const hasImmatureAfter = rows
      .slice(lastMatureIdx + 1)
      .some((r) => r.immature !== null);
    if (lastMatureIdx >= 0 && hasImmatureAfter) {
      rows[lastMatureIdx].immature = rows[lastMatureIdx].mature;
    }
    return rows;
  }, [cohorts]);

  const matureCount = cohorts.filter((c) => c.maturityState === "mature").length;
  const immatureCount = cohorts.length - matureCount;
  const note = conversionNote(meta.id);
  const selectedShort = (() => {
    if (!selectedWeekStartIso) return null;
    const point = cohorts.find(
      (c) => c.weekStart.toISOString().slice(0, 10) === selectedWeekStartIso
    );
    return point ? fmtShortDate(point.weekStart) : null;
  })();

  return (
    <section
      className="glass-panel rounded-2xl border border-white/5 p-4 flex flex-col gap-3"
      aria-label="Главный график"
    >
      <div className="flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-white truncate">
            <span className="text-blue-300 mr-2">{meta.id}</span>
            {meta.label}
          </h3>
          <div className="text-xs text-slate-400 tabular-nums mt-0.5">
            {cohorts.length} недель · {matureCount} зрелых · {immatureCount}{" "}
            незрелых
            {selectedShort && (
              <>
                {" · "}неделя <span className="text-slate-200">{selectedShort}</span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-4 shrink-0">
          <div className="text-right">
            <div className="text-[10px] text-slate-500 uppercase tracking-widest font-semibold">
              {maturity === "mature"
                ? "Средняя по зрелым"
                : maturity === "immature"
                  ? "Средняя по незрелым"
                  : "Средняя по всем"}
            </div>
            <div className="text-lg font-bold text-white tabular-nums">
              {fmtPercent(summary.matureAvgPct, 1)}
            </div>
          </div>
          {toolbarSlot}
          {note && <InfoPopover title={note.title} points={note.points} />}
        </div>
      </div>

      <div className="h-64">
        {chartData.length === 0 ? (
          <div className="h-full flex items-center justify-center text-sm text-slate-500">
            Нет данных по выбранным фильтрам
          </div>
        ) : mode === "volume" ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={chartData}
              margin={{ top: 12, right: 24, bottom: 4, left: 8 }}
              onClick={(state: any) => {
                if (state?.activePayload?.[0]?.payload?.weekStartIso) {
                  onSelectWeek(state.activePayload[0].payload.weekStartIso);
                }
              }}
            >
              <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
              <XAxis
                dataKey="weekStartShort"
                stroke="#64748b"
                tick={{ fontSize: 11 }}
                tickLine={false}
              />
              <YAxis
                stroke="#64748b"
                tick={{ fontSize: 11 }}
                tickLine={false}
                allowDecimals={false}
              />
              <RTooltip
                content={<FunnelTooltipContent meta={meta} mode="volume" />}
                cursor={{ stroke: "#475569", strokeDasharray: "3 3" }}
              />
              <Area
                type="monotone"
                dataKey="baseCount"
                stroke="#10b981"
                strokeWidth={1.5}
                fill="#10b981"
                fillOpacity={0.12}
                isAnimationActive={false}
              />
              <Area
                type="monotone"
                dataKey="targetCount"
                stroke="#10b981"
                strokeWidth={2}
                fill="#10b981"
                fillOpacity={0.32}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={chartData}
              margin={{ top: 12, right: 24, bottom: 4, left: 8 }}
              onClick={(state: any) => {
                if (state?.activePayload?.[0]?.payload?.weekStartIso) {
                  onSelectWeek(state.activePayload[0].payload.weekStartIso);
                }
              }}
            >
              <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
              <XAxis
                dataKey="weekStartShort"
                stroke="#64748b"
                tick={{ fontSize: 11 }}
                tickLine={false}
              />
              <YAxis
                stroke="#64748b"
                tick={{ fontSize: 11 }}
                tickLine={false}
                unit="%"
                domain={[0, 100]}
              />
              <RTooltip
                content={<FunnelTooltipContent meta={meta} mode="percent" />}
                cursor={{ stroke: "#475569", strokeDasharray: "3 3" }}
              />
              {meta.benchmark !== null && (
                <ReferenceLine
                  y={meta.benchmark}
                  stroke="#f59e0b"
                  strokeDasharray="4 4"
                  strokeWidth={1.5}
                  ifOverflow="extendDomain"
                  label={(props: any) => {
                    if (!props?.viewBox) return null;
                    const { x, y } = props.viewBox;
                    const text = `${meta.benchmark}%`;
                    // Лейбл рендерим ЛЕВЕЕ плот-зоны, поверх стандартной серой Y-оси тика.
                    // Тёмный фон перекрывает серый тик, amber-цвет приоритетнее.
                    return (
                      <g>
                        <rect
                          x={x - 36}
                          y={y - 9}
                          width={34}
                          height={16}
                          fill="#0f172a"
                          rx={3}
                        />
                        <text
                          x={x - 5}
                          y={y + 3}
                          textAnchor="end"
                          fill="#f59e0b"
                          fontSize={11}
                          fontWeight={600}
                        >
                          {text}
                        </text>
                      </g>
                    );
                  }}
                />
              )}
              <Line
                type="monotone"
                dataKey="mature"
                stroke="#10b981"
                strokeWidth={2}
                dot={(props) => (
                  <SelectedOnlyDot
                    {...props}
                    isSelected={
                      props.payload?.weekStartIso === selectedWeekStartIso
                    }
                  />
                )}
                activeDot={{
                  r: 5,
                  fill: "#10b981",
                  stroke: "#0f172a",
                  strokeWidth: 2,
                }}
                connectNulls
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="immature"
                stroke="#10b981"
                strokeWidth={2}
                strokeDasharray="5 4"
                dot={(props) => (
                  <SelectedOnlyDot
                    {...props}
                    isSelected={
                      props.payload?.weekStartIso === selectedWeekStartIso
                    }
                  />
                )}
                activeDot={{
                  r: 5,
                  fill: "#0f172a",
                  stroke: "#10b981",
                  strokeWidth: 2,
                }}
                connectNulls
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Легенда */}
      <div className="flex items-center gap-4 text-[11px] text-slate-400 pt-1">
        {mode === "percent" ? (
          <>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-0.5 bg-emerald-400" />
              Зрелые
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-0 border-t border-dashed border-emerald-400" />
              Незрелые
            </div>
            {meta.benchmark !== null && (
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-0 border-t border-dashed border-amber-500" />
                Целевой уровень
              </div>
            )}
          </>
        ) : (
          <>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-2 bg-emerald-400/15 border border-emerald-400" />
              База
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-2 bg-emerald-400/40 border border-emerald-400" />
              Дошли до цели
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function SelectedOnlyDot(props: any) {
  const { cx, cy, payload, isSelected } = props;
  if (!isSelected) return null;
  if (cx === undefined || cy === undefined || payload?.rawPct === null)
    return null;
  return (
    <circle
      cx={cx}
      cy={cy}
      r={6}
      fill={payload.maturityState === "mature" ? "#10b981" : "#0f172a"}
      stroke="#10b981"
      strokeWidth={2.5}
    />
  );
}

function FunnelTooltipContent({
  meta,
  mode,
  active,
  payload,
}: {
  meta: ConversionMeta;
  mode: ChartMode;
  active?: boolean;
  payload?: Array<{ payload: any }>;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  if (p.rawPct === null) return null;

  const qualityLabel = qualityColumnLabel(meta.id);
  const qualityValue = (() => {
    if (usesQualificationRetention(meta.id)) {
      // Квал % = 100 - disqualification_pct
      if (p.disqualificationPct === null) return "—";
      return fmtPercent(Math.max(0, 100 - p.disqualificationPct), 1);
    }
    const dropoff = Math.max(0, p.baseCount - p.targetCount);
    const pct = p.baseCount > 0 ? (dropoff / p.baseCount) * 100 : null;
    return `${fmtCount(dropoff)} (${fmtPercent(pct, 1)})`;
  })();

  const headline =
    mode === "volume"
      ? `${fmtCount(p.targetCount)} из ${fmtCount(p.baseCount)} лидов`
      : fmtPercent(p.rawPct, 1);

  // Стиль контейнера — как у tooltip-ов в основном дашборде (DashboardTab/CallsChart):
  // background #0f172a, border 1px rgba(255,255,255,0.1), radius 8, fontSize 12.
  return (
    <div
      style={{
        background: "#0f172a",
        border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: 8,
        fontSize: 12,
        padding: "8px 12px",
        boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
      }}
      className="text-slate-200 flex flex-col gap-0.5"
    >
      <div className="text-sm font-bold text-white tabular-nums">{headline}</div>
      <div className="text-slate-400 text-[11px]">
        {meta.id} · {meta.label}
      </div>
      <div className="text-slate-400 text-[11px] mt-1 tabular-nums">
        Неделя <span className="text-slate-200">{p.isoLabel}</span> · {p.weekStartShort}
      </div>
      <div className="text-[11px] tabular-nums">
        Лиды <span className="text-slate-100">{fmtCount(p.baseCount)}</span> · факт{" "}
        <span className="text-slate-100">{fmtCount(p.targetCount)}</span>
      </div>
      <div className="text-[11px] tabular-nums">
        {qualityLabel}: <span className="text-slate-100">{qualityValue}</span>
      </div>
      <div className="text-[11px]">
        Статус{" "}
        <span
          className={
            p.maturityState === "mature"
              ? "text-emerald-400"
              : "text-amber-300"
          }
        >
          {p.maturityState === "mature" ? "зрелая" : "незрелая"}
        </span>
      </div>
    </div>
  );
}
