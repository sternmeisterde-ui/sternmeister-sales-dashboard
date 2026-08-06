"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Loader2, ChevronDown, ChevronRight, AlertTriangle, Hash, FileText,
  BarChart3, Filter, Target, CalendarClock, Lock, Archive,
} from "lucide-react";
import { getLines, isValidLineId } from "@/lib/config/tenant";

// ─── Types ──────────────────────────────────────────────────────
// Read-only view of the OKK evaluation config. The criteria are edited in the
// OKK repo (src/criteria/*.json) and synced to the D2 `criteria_configs` table
// on deploy — the Dashboard API is GET-only (POST → 405). We therefore render
// the config verbatim, including the v5.1 scoring fields the engine actually
// uses: `weight` (criticality tier), `objective` (goal rubric), and the
// date window (`effective_from` / `effective_until`).

interface CriterionRaw {
  id: number;
  name: string;
  type: string;
  conditional: boolean;
  condition?: string | null;
  scoring: boolean | Record<string, string>;
  description: string;
  /** Criticality weight applied in scoreEvaluation (D2 v5.1): 3 фундамент,
   *  1.5 важное, 0.5 бонус, 1/undefined нейтральное. */
  weight?: number;
  /** Goal-rubric objective — what the criterion is really checking. */
  objective?: string;
  /** ISO date (YYYY-MM-DD): criterion only scores calls on/after this date. */
  effective_from?: string;
  /** ISO date (YYYY-MM-DD), exclusive: criterion is retired on this date. */
  effective_until?: string;
}

interface StageRaw { name: string; criteria: CriterionRaw[]; }
interface CriteriaConfig { prompt_type: string; version: string; stages: StageRaw[]; }

// ─── Props ──────────────────────────────────────────────────────

interface CriteriaTabProps {
  department: "b2g" | "b2b";
  lineFilter: string;
}

// ─── Config mapping by department + line (via tenant config) ────

interface ConfigOption {
  promptType: string;
  label: string;
}

function getConfigOptions(dept: "b2g" | "b2b"): ConfigOption[] {
  return getLines(dept).map((l) => ({ promptType: l.promptType, label: l.label }));
}

function getDefaultConfig(dept: "b2g" | "b2b", line: string): string {
  const lines = getLines(dept);
  // Global lineFilter uses the "group" key — Criteria has one promptType per
  // line id, so pick the first id in the matching group (or in the line itself).
  if (isValidLineId(dept, line)) {
    return lines.find((l) => l.id === line)!.promptType;
  }
  const byGroup = lines.find((l) => l.group === line);
  return (byGroup ?? lines[0]).promptType;
}

// ─── Helpers ────────────────────────────────────────────────────

function isScoringBinary(c: CriterionRaw): boolean {
  const scores = typeof c.scoring === "boolean" ? c.scoring : true;
  return scores && (c.type === "binary" || c.type === "scale_0_10");
}

function formatDateRu(iso: string): string {
  // iso = "2026-06-23" → "23.06.2026" (no TZ math — it's a plain calendar date).
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

type TemporalStatus = "active" | "archived" | "scheduled";

function berlinTodayIso(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function temporalStatus(c: CriterionRaw, asOfDate: string): TemporalStatus {
  if (c.effective_from && asOfDate < c.effective_from) return "scheduled";
  if (c.effective_until && asOfDate >= c.effective_until) return "archived";
  return "active";
}

// Score-type display (analytical / filter / binary / scale).
function getScoreInfo(type: string, scoring: boolean): {
  icon: typeof Hash; label: string; color: string; bg: string; border: string;
} {
  if (type === "scale_0_10") {
    return { icon: BarChart3, label: "Шкала 0–10", color: "text-violet-300", bg: "bg-violet-500/10", border: "border-violet-500/20" };
  }
  if (type === "info_tags" || type === "info_text" || type === "info") {
    return { icon: FileText, label: "Аналитический", color: "text-slate-400", bg: "bg-slate-500/10", border: "border-slate-500/20" };
  }
  if (!scoring) {
    return { icon: Filter, label: "Фильтр", color: "text-amber-300", bg: "bg-amber-500/10", border: "border-amber-500/20" };
  }
  return { icon: Hash, label: "1 балл — да/нет", color: "text-emerald-300", bg: "bg-emerald-500/10", border: "border-emerald-500/20" };
}

// Criticality-weight tier display. Only meaningful for scoring binary criteria
// (analytical/filter criteria don't enter the weighted sum). Known tiers get a
// named label + colour; any other value falls back to a literal «×N» so the UI
// stays correct if the rubric changes the weights upstream.
// Вес критерия = его балл. Показываем «3 балла» / «1,5 балла» / «1 балл» —
// без «×» и названий тиров (цвет тира остаётся для наглядности).
function weightLabel(w: number): string {
  const num = Number.isInteger(w) ? String(w) : String(w).replace(".", ",");
  let unit: string;
  if (!Number.isInteger(w)) {
    unit = "балла"; // дробные (0,5 / 1,5 / 2,5) → «балла»
  } else {
    const n = Math.abs(w) % 100;
    const n1 = n % 10;
    if (n >= 11 && n <= 14) unit = "баллов";
    else if (n1 === 1) unit = "балл";
    else if (n1 >= 2 && n1 <= 4) unit = "балла";
    else unit = "баллов";
  }
  return `${num} ${unit}`;
}

function getWeightInfo(weight: number): { label: string; color: string; bg: string; border: string } {
  const label = weightLabel(weight);
  if (weight === 3) return { label, color: "text-rose-300", bg: "bg-rose-500/10", border: "border-rose-500/25" };
  if (weight === 1.5) return { label, color: "text-sky-300", bg: "bg-sky-500/10", border: "border-sky-500/25" };
  return { label, color: "text-slate-400", bg: "bg-slate-500/10", border: "border-slate-500/20" };
}

// ─── Criterion Card (read-only) ─────────────────────────────────

function CriterionCard({ c, status }: { c: CriterionRaw; status: TemporalStatus }) {
  const scores = typeof c.scoring === "boolean" ? c.scoring : true;
  const info = getScoreInfo(c.type, scores);
  const Icon = info.icon;
  // Weight badge only for scoring binary criteria (others don't enter the sum).
  const weightInfo =
    isScoringBinary(c) && c.type === "binary" && typeof c.weight === "number"
      ? getWeightInfo(c.weight)
      : null;

  return (
    <div className={`rounded-xl border bg-slate-900/40 overflow-hidden ${
      status === "active" ? "border-white/[0.06]" : "border-slate-600/20 opacity-65"
    }`}>
      {/* Header bar with number + badges */}
      <div className="flex items-center justify-between gap-2 px-5 py-3 bg-slate-800/40 border-b border-white/[0.04] flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400 text-sm font-bold font-mono">
            {c.id}
          </span>
          <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg ${info.bg} border ${info.border}`}>
            <Icon className={`w-3.5 h-3.5 ${info.color}`} />
            <span className={`text-[11px] font-semibold ${info.color}`}>{info.label}</span>
          </div>
          {weightInfo && (
            <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-lg ${weightInfo.bg} border ${weightInfo.border} ${weightInfo.color}`}>
              {weightInfo.label}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {c.conditional && (
            <span className="text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded-md">
              Если ситуация возникла
            </span>
          )}
          {c.effective_from && (
            <span className="flex items-center gap-1 text-[10px] text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-md">
              <CalendarClock className="w-3 h-3" /> с {formatDateRu(c.effective_from)}
            </span>
          )}
          {c.effective_until && (
            <span className="flex items-center gap-1 text-[10px] text-rose-300 bg-rose-500/10 border border-rose-500/20 px-2 py-0.5 rounded-md">
              <Archive className="w-3 h-3" /> до {formatDateRu(c.effective_until)}
            </span>
          )}
          {status === "scheduled" && (
            <span className="text-[10px] text-sky-300 bg-sky-500/10 border border-sky-500/20 px-2 py-0.5 rounded-md">
              Ещё не действует
            </span>
          )}
          {status === "archived" && (
            <span className="text-[10px] text-slate-300 bg-slate-500/10 border border-slate-500/20 px-2 py-0.5 rounded-md">
              Архивный
            </span>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="px-5 py-4 space-y-3">
        {/* Name */}
        <h4 className="text-sm font-semibold text-white leading-snug">{c.name}</h4>

        {/* Objective (goal rubric) — what the criterion is really checking */}
        {c.objective && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-blue-500/[0.06] border border-blue-500/15">
            <Target className="w-3.5 h-3.5 text-blue-400 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <span className="block text-[10px] font-bold text-blue-300/80 uppercase tracking-wider mb-1">Цель критерия</span>
              <p className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap">{c.objective}</p>
            </div>
          </div>
        )}

        {/* Description */}
        {c.description && (
          <p className="text-xs text-slate-400 leading-relaxed whitespace-pre-wrap">{c.description}</p>
        )}

        {/* Condition if conditional */}
        {c.conditional && c.condition && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/5 border border-amber-500/10">
            <span className="text-[10px] text-amber-400 mt-0.5 shrink-0">⚡</span>
            <p className="text-xs text-amber-200/90 leading-relaxed">{c.condition}</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Stage Section ──────────────────────────────────────────────

function StageSection({ stage, asOfDate }: { stage: StageRaw; asOfDate: string }) {
  const [open, setOpen] = useState(true);
  const scored = stage.criteria.filter(isScoringBinary).length;
  const total = stage.criteria.length;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-2 py-4 text-left group"
      >
        {open ? (
          <ChevronDown className="w-5 h-5 text-blue-400 shrink-0" />
        ) : (
          <ChevronRight className="w-5 h-5 text-slate-500 shrink-0 group-hover:text-slate-300" />
        )}
        <h3 className="text-base font-bold text-white">{stage.name}</h3>
        <div className="flex items-center gap-2 ml-auto">
          <span className="text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-1 rounded-lg font-medium">
            {scored} оцениваемых
          </span>
          <span className="text-xs text-slate-500 bg-slate-700/40 px-2.5 py-1 rounded-lg">
            {total} всего
          </span>
        </div>
      </button>

      {open && (
        <div className="grid gap-3 pb-6 pl-8">
          {stage.criteria.map((c) => (
            <CriterionCard key={c.id} c={c} status={temporalStatus(c, asOfDate)} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Weight legend ──────────────────────────────────────────────

// `weights` — distinct weight values actually present in the open config,
// sorted descending. Rendered only when the config genuinely uses weights.
function WeightLegend({ weights }: { weights: number[] }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-[10px] text-slate-500 uppercase tracking-wider">Вес критерия:</span>
      {weights.map((w) => {
        const t = getWeightInfo(w);
        return (
          <span key={w} className={`text-[11px] font-semibold px-2 py-0.5 rounded-md ${t.bg} border ${t.border} ${t.color}`}>
            {t.label}
          </span>
        );
      })}
    </div>
  );
}

// ─── Main ───────────────────────────────────────────────────────

export default function CriteriaTab({ department, lineFilter }: CriteriaTabProps) {
  const options = getConfigOptions(department);
  const [activeConfig, setActiveConfig] = useState<string>(getDefaultConfig(department, lineFilter));

  const [config, setConfig] = useState<CriteriaConfig | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asOfDate, setAsOfDate] = useState(berlinTodayIso);
  const [showInactive, setShowInactive] = useState(false);

  // Reset config when department changes
  useEffect(() => {
    setActiveConfig(getDefaultConfig(department, lineFilter));
  }, [department, lineFilter]);

  const loadCriteria = useCallback(async (promptType: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/criteria?prompt_type=${promptType}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error ?? "Unknown error");
      setConfig(json.data as CriteriaConfig);
      setVersion(json.version ?? (json.data as CriteriaConfig).version ?? null);
      setShowInactive(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setConfig(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCriteria(activeConfig);
  }, [activeConfig, loadCriteria]);

  const allStages = config?.stages ?? [];
  const activeStages = allStages
    .map((stage) => ({
      ...stage,
      criteria: stage.criteria.filter((c) => temporalStatus(c, asOfDate) === "active"),
    }))
    .filter((stage) => stage.criteria.length > 0);
  const stages = showInactive ? allStages : activeStages;
  const totalStoredCriteria = allStages.reduce((sum, s) => sum + s.criteria.length, 0);
  const totalCriteria = activeStages.reduce((sum, s) => sum + s.criteria.length, 0);
  const scoredCriteria = activeStages.reduce((sum, s) => sum + s.criteria.filter(isScoringBinary).length, 0);
  const inactiveCriteria = totalStoredCriteria - totalCriteria;
  const expectedVersion = activeConfig === "d2_qualifier"
    ? "4.0"
    : activeConfig === "d2_med_qualifier"
      ? "2.0"
      : null;
  const sourceScript = expectedVersion && version === expectedVersion
    ? "Скрипт первой линии v3.0"
    : null;

  // Weights actually used in THIS config (scoring binary criteria only). The
  // legend renders only when the rubric genuinely weights criteria — flat
  // configs (all weight 1 / unset, e.g. berater / все r2_*) get no legend.
  const usedWeights = activeStages
    .flatMap((s) => s.criteria)
    .filter((c) => isScoringBinary(c) && c.type === "binary")
    .map((c) => c.weight)
    .filter((w): w is number => typeof w === "number");
  const hasWeights = usedWeights.some((w) => w !== 1);
  const legendWeights = Array.from(new Set(usedWeights)).sort((a, b) => b - a);

  return (
    <div className="flex flex-col gap-5 fade-in">
      {/* Header */}
      <div className="glass-panel rounded-2xl p-6 border border-white/5 shadow-lg">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
          <div>
            <h2 className="text-xl font-bold text-white">Критерии оценки</h2>
            <p className="text-sm text-slate-400 mt-1">
              {department === "b2b" ? "Коммерсы" : "Госники"} — {options.find((o) => o.promptType === activeConfig)?.label}
              {version && <span className="text-slate-500"> · v{version}</span>}
            </p>
            {sourceScript && (
              <p className="text-xs text-blue-300/80 mt-1">Основано на документе: {sourceScript}</p>
            )}
            {expectedVersion && version && version !== expectedVersion && (
              <p className="text-xs text-amber-300 mt-1">
                Внимание: для нового скрипта ожидается конфигурация v{expectedVersion}, сейчас загружена v{version}.
              </p>
            )}
          </div>
          <span className="flex items-center gap-1.5 text-xs text-slate-400 bg-slate-700/40 px-3 py-1.5 rounded-lg border border-white/[0.06]">
            <Lock className="w-3.5 h-3.5 text-slate-500" /> Только просмотр
          </span>
        </div>

        {/* Config selector — only for Госники (multiple configs) */}
        {options.length > 1 && (
          <div className="flex gap-2 flex-wrap">
            {options.map((opt) => (
              <button
                key={opt.promptType}
                onClick={() => setActiveConfig(opt.promptType)}
                className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                  activeConfig === opt.promptType
                    ? "bg-blue-500/15 text-blue-300 border border-blue-500/25 shadow-sm shadow-blue-500/10"
                    : "text-slate-400 hover:text-white hover:bg-white/5 border border-white/[0.06]"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}

        {!loading && allStages.length > 0 && (
          <div className="mt-4 flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-2 text-xs text-slate-400">
              <CalendarClock className="w-3.5 h-3.5 text-blue-400" />
              Критерии на дату
              <input
                type="date"
                value={asOfDate}
                onChange={(event) => {
                  if (!event.target.value) return;
                  setAsOfDate(event.target.value);
                  setShowInactive(false);
                }}
                className="rounded-lg border border-white/[0.08] bg-slate-800/70 px-2.5 py-1.5 text-xs text-slate-200 focus:border-blue-500/40 focus:outline-none"
              />
            </label>
            {inactiveCriteria > 0 && (
              <button
                type="button"
                onClick={() => setShowInactive((value) => !value)}
                className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                  showInactive
                    ? "border-slate-500/30 bg-slate-500/15 text-slate-200"
                    : "border-white/[0.08] bg-slate-800/50 text-slate-400 hover:text-slate-200"
                }`}
              >
                <Archive className="w-3.5 h-3.5" />
                {showInactive ? "Скрыть архивные" : `Показать архивные (${inactiveCriteria})`}
              </button>
            )}
          </div>
        )}

        {/* Stats + legend */}
        {!loading && stages.length > 0 && (
          <div className="mt-4 pt-4 border-t border-white/[0.06] flex flex-col gap-4">
            <div className="flex items-center gap-6">
              <div>
                <span className="text-2xl font-bold text-white">{totalCriteria}</span>
                <span className="text-xs text-slate-500 ml-1.5">действующих</span>
              </div>
              <div>
                <span className="text-2xl font-bold text-emerald-400">{scoredCriteria}</span>
                <span className="text-xs text-slate-500 ml-1.5">оцениваемых</span>
              </div>
              <div>
                <span className="text-2xl font-bold text-blue-400">{stages.length}</span>
                <span className="text-xs text-slate-500 ml-1.5">этапов</span>
              </div>
            </div>
            {hasWeights && <WeightLegend weights={legendWeights} />}
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 px-5 py-4 bg-red-500/10 border border-red-500/20 rounded-xl text-red-300 text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="w-7 h-7 text-blue-400 animate-spin" />
        </div>
      )}

      {/* Stages */}
      {!loading && (
        <div className="flex flex-col gap-2">
          {stages.map((stage, si) => (
            <StageSection key={`${activeConfig}-${si}`} stage={stage} asOfDate={asOfDate} />
          ))}
        </div>
      )}
    </div>
  );
}
