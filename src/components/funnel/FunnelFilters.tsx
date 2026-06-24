"use client";

import { RotateCcw } from "lucide-react";
import CalendarPicker from "@/components/CalendarPicker";
import FilterSelect from "@/components/funnel/FilterSelect";
import type {
  FunnelFiltersState,
  MaturityFilter,
  FilterOption,
} from "@/lib/funnel/types";

interface Props {
  state: FunnelFiltersState;
  defaultState: FunnelFiltersState;
  sourceOptions: FilterOption[];
  managerOptions: FilterOption[];
  langOptions: FilterOption[];
  activeFilterCount: number;
  /** Когда в проде появится бэкенд, придёт сюда из last_sync. */
  lastUpdatedAt: Date | null;
  /**
   * Режим вкладки — определяет, какие фильтры применяются:
   *   cohorts  — все;
   *   clients  — только свой фильтр даты термина (всё в шапке затемнено);
   *   managers — Период + Канал применяются, Зрелость + Менеджер нет.
   */
  mode?: "cohorts" | "clients" | "managers";
  onChange: (next: Partial<FunnelFiltersState>) => void;
  onReset: () => void;
}

const MATURITY_OPTIONS: { value: MaturityFilter; label: string }[] = [
  { value: "all", label: "Все" },
  { value: "mature", label: "Зрелые" },
  { value: "immature", label: "Незрелые" },
];

export default function FunnelFilters({
  state,
  defaultState,
  sourceOptions,
  managerOptions,
  langOptions,
  activeFilterCount,
  lastUpdatedAt,
  mode = "cohorts",
  onChange,
  onReset,
}: Props) {
  const isClients = mode === "clients";
  const isManagers = mode === "managers";
  // Период + Канал: применяются в cohorts и managers; в clients — свой фильтр даты.
  const dimPS = isClients ? "opacity-40 pointer-events-none" : "";
  const titlePS = isClients ? "Не применяется к виду «Клиенты» (только дата термина)" : undefined;
  // Зрелость + Менеджер: только в cohorts; в clients и managers не применяются.
  const dimMM = isClients || isManagers ? "opacity-40 pointer-events-none" : "";
  const titleMM = isClients
    ? "Не применяется к виду «Клиенты»"
    : isManagers
      ? "Не применяется к виду «Менеджеры»"
      : undefined;
  return (
    <section
      className="glass-panel rounded-2xl border border-white/5 px-4 py-3 flex flex-wrap items-center gap-2"
      aria-label="Шапка и фильтры"
    >
      {/* Period — стандартный CalendarPicker, тот же что в Daily/Analytics/Termin.
          В режиме «Клиенты» затемнён — там свой фильтр по дате термина. */}
      <div className={dimPS} title={titlePS}>
        <CalendarPicker
          mode="range"
          value={state.dateRange}
          onChange={(dateRange) => onChange({ dateRange })}
          onClear={() => onChange({ dateRange: defaultState.dateRange })}
        />
      </div>

      {/* Maturity — button group в стиле granularity TerminTab */}
      <div
        title={titleMM}
        className={`inline-flex p-0.5 rounded-lg bg-slate-800/60 border border-white/5 ${dimMM}`}
      >
        {MATURITY_OPTIONS.map((opt) => {
          const active = state.maturity === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange({ maturity: opt.value })}
              aria-pressed={active}
              className={`text-[10px] uppercase tracking-wider px-3 py-1 rounded-md transition-colors ${
                active
                  ? "bg-blue-500/20 text-blue-300"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      {/* Source — кастомный селект в дизайне дашборда */}
      <div className={dimPS} title={titlePS}>
        <FilterSelect
          value={state.source}
          options={sourceOptions}
          onChange={(source) => onChange({ source })}
          emptyLabel="Все каналы"
          ariaLabel="Канал"
          minWidthClass="min-w-[140px]"
        />
      </div>

      {/* Manager — кастомный селект в дизайне дашборда */}
      <div className={dimMM} title={titleMM}>
        <FilterSelect
          value={state.responsibleUserId}
          options={managerOptions}
          onChange={(responsibleUserId) => onChange({ responsibleUserId })}
          emptyLabel="Все менеджеры"
          ariaLabel="Менеджер"
          minWidthClass="min-w-[170px]"
        />
      </div>

      {/* Уровень языка — применяется ко всем визуальным элементам вкладки. */}
      <div title="Уровень языка — применяется ко всем видам вкладки">
        <FilterSelect
          value={state.lang}
          options={langOptions}
          onChange={(lang) => onChange({ lang })}
          emptyLabel="Любой язык"
          ariaLabel="Уровень языка"
          minWidthClass="min-w-[130px]"
        />
      </div>

      {/* Reset + Active filter badge */}
      <button
        type="button"
        onClick={onReset}
        disabled={activeFilterCount === 0}
        className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-widest font-bold text-slate-400 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors px-2 py-1.5"
        title="Сбросить все фильтры"
      >
        <RotateCcw className="w-3 h-3" />
        Очистить
        {activeFilterCount > 0 && (
          <span className="inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-blue-500/20 border border-blue-400/30 text-blue-300 tabular-nums">
            {activeFilterCount}
          </span>
        )}
      </button>

      {/* Right cluster — обновлено */}
      <div className="ml-auto flex items-center gap-2 text-[10px] uppercase tracking-widest font-semibold text-slate-500">
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            lastUpdatedAt ? "bg-emerald-400" : "bg-amber-400"
          }`}
          aria-hidden="true"
        />
        Обновлено
        <span className="text-slate-300 tabular-nums normal-case tracking-normal">
          {lastUpdatedAt ? formatUpdatedAt(lastUpdatedAt) : "—"}
        </span>
      </div>
    </section>
  );
}

function formatUpdatedAt(d: Date): string {
  return d.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Berlin",
  });
}
