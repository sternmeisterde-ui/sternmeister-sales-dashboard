"use client";

export type FunnelViewMode = "cohorts" | "clients";

interface Props {
  value: FunnelViewMode;
  onChange: (next: FunnelViewMode) => void;
}

/** Переключатель вида вкладки «Воронка»: когортный обзор vs таблица клиентов. */
export default function ViewModeToggle({ value, onChange }: Props) {
  return (
    <div
      className="inline-flex rounded-lg border border-white/10 bg-slate-800/50 p-0.5"
      role="group"
      aria-label="Режим воронки"
    >
      <ModeButton
        active={value === "cohorts"}
        label="Когорты"
        onClick={() => onChange("cohorts")}
      />
      <ModeButton
        active={value === "clients"}
        label="Клиенты"
        onClick={() => onChange("clients")}
      />
    </div>
  );
}

function ModeButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`px-3 py-1 text-xs rounded-md transition-colors ${
        active
          ? "bg-blue-500/20 text-blue-200 border border-blue-400/30"
          : "text-slate-400 hover:text-white border border-transparent"
      }`}
    >
      {label}
    </button>
  );
}
