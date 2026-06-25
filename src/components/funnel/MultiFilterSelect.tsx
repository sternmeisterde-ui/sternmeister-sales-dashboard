"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";

export interface FilterSelectOption {
  value: string;
  label: string;
}

interface Props {
  /** Выбранные значения. Пустой массив = «все». */
  values: string[];
  options: FilterSelectOption[];
  onChange: (values: string[]) => void;
  /** Подпись пустого состояния. */
  emptyLabel?: string;
  ariaLabel?: string;
  minWidthClass?: string;
}

/**
 * Мультивыбор в стиле дашборда (брат FilterSelect). Клик по опции — переключает
 * (дропдаун не закрывается); «emptyLabel» сверху — сбрасывает всё. Кнопка
 * показывает выбранные метки (или «N выбрано», если их много).
 */
export default function MultiFilterSelect({
  values,
  options,
  onChange,
  emptyLabel = "Все",
  ariaLabel,
  minWidthClass = "min-w-[140px]",
}: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const selectedSet = new Set(values);
  const selectedLabels = options.filter((o) => selectedSet.has(o.value)).map((o) => o.label);
  const displayLabel =
    selectedLabels.length === 0
      ? emptyLabel
      : selectedLabels.length <= 2
        ? selectedLabels.join(", ")
        : `${selectedLabels.length} выбрано`;

  const toggle = (value: string) => {
    onChange(
      selectedSet.has(value) ? values.filter((v) => v !== value) : [...values, value],
    );
  };

  const active = values.length > 0;

  return (
    <div className={`relative ${minWidthClass}`} ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        className={`w-full flex items-center justify-between gap-1.5 px-3 py-1.5 rounded-lg text-[11px] uppercase tracking-widest font-bold transition-colors border ${
          open
            ? "bg-slate-800/70 border-white/15 text-white"
            : active
              ? "bg-slate-800/40 border-white/5 text-slate-200 hover:bg-slate-800/70"
              : "bg-slate-800/40 border-white/5 text-slate-400 hover:bg-slate-800/70 hover:text-white"
        }`}
      >
        <span className="truncate">{displayLabel}</span>
        <ChevronDown className={`w-3 h-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <ul
          role="listbox"
          aria-multiselectable="true"
          className="absolute left-0 right-0 mt-1 min-w-full max-h-[260px] overflow-y-auto rounded-xl border border-white/10 shadow-2xl py-1 z-50 bg-slate-900"
        >
          <li>
            <button
              type="button"
              role="option"
              aria-selected={values.length === 0}
              onClick={() => onChange([])}
              className={`w-full text-left px-3 py-1.5 text-[11px] uppercase tracking-widest font-bold transition-colors ${
                values.length === 0 ? "bg-blue-500/15 text-blue-300" : "text-slate-300 hover:bg-white/5"
              }`}
            >
              {emptyLabel}
            </button>
          </li>
          {options.map((opt) => {
            const on = selectedSet.has(opt.value);
            return (
              <li key={opt.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={on}
                  onClick={() => toggle(opt.value)}
                  className={`w-full flex items-center gap-2 text-left px-3 py-1.5 text-[11px] transition-colors ${
                    on ? "bg-blue-500/15 text-blue-300 font-bold" : "text-slate-300 hover:bg-white/5"
                  }`}
                >
                  <span
                    className={`flex items-center justify-center w-3.5 h-3.5 rounded border ${
                      on ? "bg-blue-500/30 border-blue-400/50" : "border-white/20"
                    }`}
                  >
                    {on && <Check className="w-2.5 h-2.5" />}
                  </span>
                  {opt.label}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
