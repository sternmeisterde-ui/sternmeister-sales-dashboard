"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, Save, ChevronDown, ChevronRight, AlertTriangle, CheckCircle2, Hash, FileText, BarChart3, Filter } from "lucide-react";

// ─── Types ──────────────────────────────────────────────────────

interface CriterionRaw {
  id: number;
  name: string;
  type: string;
  conditional: boolean;
  condition?: string | null;
  scoring: boolean | Record<string, string>;
  description: string;
}

interface StageRaw { name: string; criteria: CriterionRaw[]; }
interface CriteriaConfig { prompt_type: string; version: string; stages: StageRaw[]; }

interface CriterionLocal {
  id: number;
  name: string;
  type: string;
  conditional: boolean;
  condition: string;
  scoring: boolean;
  description: string;
}

interface StageLocal { name: string; criteria: CriterionLocal[]; }

// ─── Props ──────────────────────────────────────────────────────

interface CriteriaTabProps {
  department: "b2g" | "b2b";
  lineFilter: string;
}

// ─── Config mapping by department + line ────────────────────────

interface ConfigOption {
  promptType: string;
  label: string;
}

function getConfigOptions(dept: "b2g" | "b2b"): ConfigOption[] {
  if (dept === "b2b") {
    return [
      { promptType: "r2_commercial", label: "Коммерсы — OKK + Ролевки" },
    ];
  }
  return [
    { promptType: "d2_qualifier", label: "Линия 1 — Квалификатор" },
    { promptType: "d2_berater", label: "Линия 2 — Бератер 1" },
    { promptType: "d2_berater2", label: "Линия 2 — Бератер 2" },
    { promptType: "d2_dovedenie", label: "Линия 3 — Доведение" },
  ];
}

function getDefaultConfig(dept: "b2g" | "b2b", line: string): string {
  if (dept === "b2b") return "r2_commercial";
  if (line === "1") return "d2_qualifier";
  if (line === "2") return "d2_berater";
  if (line === "3") return "d2_dovedenie";
  return "d2_qualifier";
}

// ─── Helpers ────────────────────────────────────────────────────

function rawToLocal(raw: CriterionRaw): CriterionLocal {
  return {
    id: raw.id, name: raw.name, type: raw.type,
    conditional: raw.conditional, condition: raw.condition ?? "",
    scoring: typeof raw.scoring === "boolean" ? raw.scoring : true,
    description: raw.description,
  };
}

function localToRaw(local: CriterionLocal, raw: CriterionRaw): CriterionRaw {
  return {
    ...raw, name: local.name, type: local.type,
    conditional: local.conditional, condition: local.condition || null,
    scoring: typeof raw.scoring === "boolean" ? local.scoring : raw.scoring,
    description: local.description,
  };
}

// Score type display with colors
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

// ─── Criterion Card ─────────────────────────────────────────────

function CriterionCard({
  c, stageIndex, ci, onChange,
}: {
  c: CriterionLocal;
  stageIndex: number;
  ci: number;
  onChange: (si: number, ci: number, field: keyof CriterionLocal, value: unknown) => void;
}) {
  const info = getScoreInfo(c.type, c.scoring);
  const Icon = info.icon;

  return (
    <div className="rounded-xl border border-white/[0.06] bg-slate-900/40 hover:bg-slate-900/60 transition-colors overflow-hidden">
      {/* Header bar with number + type */}
      <div className="flex items-center justify-between px-5 py-3 bg-slate-800/40 border-b border-white/[0.04]">
        <div className="flex items-center gap-3">
          <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400 text-sm font-bold font-mono">
            {c.id}
          </span>
          <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg ${info.bg} border ${info.border}`}>
            <Icon className={`w-3.5 h-3.5 ${info.color}`} />
            <span className={`text-[11px] font-semibold ${info.color}`}>{info.label}</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {c.conditional && (
            <span className="text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded-md">
              Если ситуация возникла
            </span>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="px-5 py-4 space-y-3">
        {/* Name — large editable */}
        <input
          type="text"
          value={c.name}
          onChange={(e) => onChange(stageIndex, ci, "name", e.target.value)}
          className="w-full bg-slate-800/60 border border-white/[0.08] rounded-xl px-4 py-3 text-sm text-white font-medium focus:border-blue-500/40 focus:outline-none focus:ring-1 focus:ring-blue-500/20 transition-all placeholder-slate-600"
          placeholder="Название критерия"
        />

        {/* Description — large textarea */}
        <textarea
          value={c.description}
          onChange={(e) => onChange(stageIndex, ci, "description", e.target.value)}
          rows={3}
          className="w-full bg-slate-800/40 border border-white/[0.06] rounded-xl px-4 py-3 text-xs text-slate-300 leading-relaxed focus:border-blue-500/30 focus:outline-none focus:ring-1 focus:ring-blue-500/20 transition-all resize-y placeholder-slate-600"
          placeholder="Описание: что проверяется, как оценивается..."
        />

        {/* Condition if conditional */}
        {c.conditional && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/5 border border-amber-500/10">
            <span className="text-[10px] text-amber-400 mt-0.5 shrink-0">⚡</span>
            <input
              type="text"
              value={c.condition}
              onChange={(e) => onChange(stageIndex, ci, "condition", e.target.value)}
              className="flex-1 bg-transparent text-xs text-amber-200 focus:outline-none placeholder-amber-600/40"
              placeholder="Когда критерий применяется (например: если клиент спросил о цене)"
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Stage Section ──────────────────────────────────────────────

function StageSection({
  stage, stageIndex, onChange,
}: {
  stage: StageLocal;
  stageIndex: number;
  onChange: (si: number, ci: number, field: keyof CriterionLocal, value: unknown) => void;
}) {
  const [open, setOpen] = useState(true);
  const scored = stage.criteria.filter((c) => c.scoring && (c.type === "binary" || c.type === "scale_0_10")).length;
  const total = stage.criteria.length;

  return (
    <div>
      {/* Stage header */}
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

      {/* Criteria cards */}
      {open && (
        <div className="grid gap-3 pb-6 pl-8">
          {stage.criteria.map((c, ci) => (
            <CriterionCard key={c.id} c={c} stageIndex={stageIndex} ci={ci} onChange={onChange} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main ───────────────────────────────────────────────────────

export default function CriteriaTab({ department, lineFilter }: CriteriaTabProps) {
  const options = getConfigOptions(department);
  const [activeConfig, setActiveConfig] = useState<string>(getDefaultConfig(department, lineFilter));

  const [rawConfig, setRawConfig] = useState<CriteriaConfig | null>(null);
  const [stages, setStages] = useState<StageLocal[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Reset config when department changes
  useEffect(() => {
    setActiveConfig(getDefaultConfig(department, lineFilter));
  }, [department, lineFilter]);

  const loadCriteria = useCallback(async (promptType: string) => {
    setLoading(true);
    setError(null);
    setDirty(false);
    setSaveSuccess(false);
    try {
      const res = await fetch(`/api/criteria?prompt_type=${promptType}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error ?? "Unknown error");
      const config: CriteriaConfig = json.data;
      setRawConfig(config);
      setStages(config.stages.map((s) => ({ name: s.name, criteria: s.criteria.map(rawToLocal) })));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCriteria(activeConfig);
  }, [activeConfig, loadCriteria]);

  const handleChange = useCallback(
    (si: number, ci: number, field: keyof CriterionLocal, value: unknown) => {
      setStages((prev) =>
        prev.map((s, i) =>
          i !== si ? s : { ...s, criteria: s.criteria.map((c, j) => (j !== ci ? c : { ...c, [field]: value })) }
        )
      );
      setDirty(true);
      setSaveSuccess(false);
    },
    []
  );

  const handleSave = async () => {
    if (!rawConfig) return;
    setSaving(true);
    setError(null);
    setSaveSuccess(false);
    try {
      const updatedConfig: CriteriaConfig = {
        ...rawConfig,
        stages: rawConfig.stages.map((rawStage, si) => ({
          ...rawStage,
          criteria: rawStage.criteria.map((rawC, ci) => {
            const local = stages[si]?.criteria[ci];
            return local ? localToRaw(local, rawC) : rawC;
          }),
        })),
      };
      const res = await fetch("/api/criteria", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt_type: activeConfig, config: updatedConfig }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error ?? "Save failed");
      setRawConfig(updatedConfig);
      setDirty(false);
      setSaveSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const totalCriteria = stages.reduce((sum, s) => sum + s.criteria.length, 0);
  const scoredCriteria = stages.reduce(
    (sum, s) => sum + s.criteria.filter((c) => c.scoring && (c.type === "binary" || c.type === "scale_0_10")).length, 0
  );

  return (
    <div className="flex flex-col gap-5 fade-in">
      {/* Header */}
      <div className="glass-panel rounded-2xl p-6 border border-white/5 shadow-lg">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
          <div>
            <h2 className="text-xl font-bold text-white">Критерии оценки</h2>
            <p className="text-sm text-slate-400 mt-1">
              {department === "b2b" ? "Коммерсы" : "Госники"} — {options.find((o) => o.promptType === activeConfig)?.label}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {dirty && (
              <span className="text-xs text-amber-400 bg-amber-500/10 px-3 py-1.5 rounded-lg border border-amber-500/20 font-medium">
                Есть несохранённые изменения
              </span>
            )}
            {saveSuccess && (
              <span className="flex items-center gap-1.5 text-xs text-emerald-400 bg-emerald-500/10 px-3 py-1.5 rounded-lg border border-emerald-500/20">
                <CheckCircle2 className="w-3.5 h-3.5" /> Сохранено
              </span>
            )}
          </div>
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

        {/* Stats */}
        {!loading && stages.length > 0 && (
          <div className="flex items-center gap-6 mt-4 pt-4 border-t border-white/[0.06]">
            <div>
              <span className="text-2xl font-bold text-white">{totalCriteria}</span>
              <span className="text-xs text-slate-500 ml-1.5">критериев</span>
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
            <StageSection key={`${activeConfig}-${si}`} stage={stage} stageIndex={si} onChange={handleChange} />
          ))}
        </div>
      )}

      {/* Save */}
      {!loading && stages.length > 0 && (
        <div className="flex justify-end pt-2 pb-6">
          <button
            onClick={handleSave}
            disabled={!dirty || saving}
            className={`flex items-center gap-2 px-8 py-3 rounded-xl text-sm font-semibold transition-all ${
              dirty
                ? "bg-blue-500 hover:bg-blue-600 text-white shadow-lg shadow-blue-500/25"
                : "bg-slate-800 text-slate-500 cursor-not-allowed"
            }`}
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Сохранить изменения
          </button>
        </div>
      )}
    </div>
  );
}
