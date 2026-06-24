"use client";

import { TrendingUp, Users, Flame, Clock, PhoneOff } from "lucide-react";
import type { OverviewKpi } from "@/lib/funnel/api-types";
import { fmtPercent, fmtCount } from "@/lib/funnel/format";

/**
 * KPI-полоска (ТЗ §9.1): 5 плиток-обзора за выбранный период.
 * Hot/Warm/Cold — готовность активных клиентов с предстоящим термином (скоринг §8).
 */
export default function KpiBar({
  kpi,
  loading = false,
}: {
  kpi: OverviewKpi | null;
  loading?: boolean;
}) {
  const fmtDays = (d: number | null) =>
    d === null ? "—" : `${Math.round(d)} дн`;

  return (
    <section
      aria-label="KPI"
      className="grid grid-cols-2 gap-2 lg:flex lg:flex-col lg:justify-between lg:h-full"
    >
      <KpiTile
        icon={<TrendingUp className="w-4 h-4" />}
        tone="blue"
        label="C5 · Гутшайн"
        value={kpi ? fmtPercent(kpi.c5Pct, 1) : "—"}
        sub="квал-лид → гутшайн"
        loading={loading}
      />
      <KpiTile
        icon={<Users className="w-4 h-4" />}
        tone="slate"
        label="Активных клиентов"
        value={kpi ? fmtCount(kpi.activeClients) : "—"}
        sub="в работе, обе воронки"
        loading={loading}
      />
      <KpiTile
        icon={<Flame className="w-4 h-4" />}
        tone="amber"
        label="Hot / Warm / Cold"
        value={
          kpi?.hotWarmCold ? (
            <span className="tabular-nums">
              <span className="text-emerald-300">{kpi.hotWarmCold.hot}</span>
              <span className="text-slate-600"> / </span>
              <span className="text-amber-300">{kpi.hotWarmCold.warm}</span>
              <span className="text-slate-600"> / </span>
              <span className="text-slate-400">{kpi.hotWarmCold.cold}</span>
            </span>
          ) : (
            "—"
          )
        }
        sub={kpi?.hotWarmCold ? "клиенты с предстоящим термином" : "скоро · нужен скоринг"}
        tooltip="Активные клиенты с уже назначенным термином (встречей ДЦ/АА), который ещё впереди — и насколько они к нему готовы. Hot ≥75 / Warm 50–74 / Cold <50 баллов готовности (ролевки с ботом и менеджером, уровень языка, ОКК и др.). Поимённо и с расшифровкой — во вкладке «Клиенты»."
        loading={loading}
        muted={!kpi?.hotWarmCold}
      />
      <KpiTile
        icon={<Clock className="w-4 h-4" />}
        tone="emerald"
        label="Ср. срок → Гутшайн"
        value={kpi ? fmtDays(kpi.avgDaysQualToGutschein) : "—"}
        sub="от квал-лида"
        loading={loading}
      />
      <KpiTile
        icon={<PhoneOff className="w-4 h-4" />}
        tone="rose"
        label={`Без звонка >${kpi?.freshCallThresholdDays ?? 7} дн`}
        value={kpi ? fmtCount(kpi.noFreshCallCount) : "—"}
        sub="требуют касания"
        loading={loading}
      />
    </section>
  );
}

const TONE: Record<string, string> = {
  blue: "text-blue-300",
  slate: "text-slate-200",
  amber: "text-amber-300",
  emerald: "text-emerald-300",
  rose: "text-rose-300",
};

function KpiTile({
  icon,
  tone,
  label,
  value,
  sub,
  loading,
  muted = false,
  tooltip,
}: {
  icon: React.ReactNode;
  tone: keyof typeof TONE | string;
  label: string;
  value: React.ReactNode;
  sub: string;
  loading: boolean;
  muted?: boolean;
  tooltip?: string;
}) {
  return (
    <div
      title={tooltip}
      className={`glass-panel rounded-xl border border-white/5 px-3 py-2.5 flex flex-col gap-1 min-w-0 ${
        tooltip ? "cursor-help" : ""
      } ${muted ? "opacity-60" : ""}`}
    >
      <div className="flex items-center gap-1.5 text-slate-400">
        <span className={TONE[tone] ?? "text-slate-300"}>{icon}</span>
        <span className="text-[10px] uppercase tracking-widest font-semibold truncate">
          {label}
        </span>
      </div>
      <div
        className={`text-2xl font-bold tabular-nums leading-none ${
          loading ? "text-slate-600 animate-pulse" : "text-white"
        }`}
      >
        {loading ? "…" : value}
      </div>
      <div className="text-[10px] text-slate-500 truncate">{sub}</div>
    </div>
  );
}
