"use client";

import type { ChartMode } from "@/lib/funnel/types";

interface Props {
  value: ChartMode;
  onChange: (next: ChartMode) => void;
}

export default function ChartModeToggle({ value, onChange }: Props) {
  return (
    <div
      className="inline-flex rounded-lg border border-white/10 bg-slate-800/50 p-0.5"
      role="group"
      aria-label="Режим графика"
    >
      <ModeButton
        active={value === "percent"}
        label="Процент"
        onClick={() => onChange("percent")}
      />
      <ModeButton
        active={value === "volume"}
        label="Объёмы"
        onClick={() => onChange("volume")}
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
