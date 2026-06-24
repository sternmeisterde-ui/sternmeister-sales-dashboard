"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

export interface FilterSelectOption {
  value: string;
  label: string;
}

interface Props {
  value: string;
  options: FilterSelectOption[];
  onChange: (value: string) => void;
  /** Подпись для невыбранного состояния (если value === ""). */
  emptyLabel?: string;
  /** ARIA-label для кнопки. */
  ariaLabel?: string;
  /** Минимальная ширина кнопки. */
  minWidthClass?: string;
}

/**
 * Кастомный селект в стиле основного дашборда (DailyTab Менеджеры/Mode).
 * Заменяет native <select>, чтобы не выпадать из дизайна (на Windows OS
 * рисует свою системную панель — отсюда визуальный разлад).
 */
export default function FilterSelect({
  value,
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

  const selected = options.find((o) => o.value === value);
  const displayLabel = selected?.label ?? emptyLabel;

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
            : value !== ""
              ? "bg-slate-800/40 border-white/5 text-slate-200 hover:bg-slate-800/70"
              : "bg-slate-800/40 border-white/5 text-slate-400 hover:bg-slate-800/70 hover:text-white"
        }`}
      >
        <span className="truncate">{displayLabel}</span>
        <ChevronDown
          className={`w-3 h-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <ul
          role="listbox"
          // bg-slate-900 (а не инлайн #0f172a) — чтобы фон перекрашивался темой
          // (.theme-light .bg-slate-900 → светлый); текст slate/blue тоже флипается
          // темой, иначе в светлой теме было тёмное-на-тёмном.
          className="absolute left-0 right-0 mt-1 min-w-full max-h-[260px] overflow-y-auto rounded-xl border border-white/10 shadow-2xl py-1 z-50 bg-slate-900"
        >
          <li>
            <button
              type="button"
              role="option"
              aria-selected={value === ""}
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
              className={`w-full text-left px-3 py-1.5 text-[11px] uppercase tracking-widest font-bold transition-colors ${
                value === ""
                  ? "bg-blue-500/15 text-blue-300"
                  : "text-slate-300 hover:bg-white/5"
              }`}
            >
              {emptyLabel}
            </button>
          </li>
          {options.map((opt) => (
            <li key={opt.value}>
              <button
                type="button"
                role="option"
                aria-selected={value === opt.value}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={`w-full text-left px-3 py-1.5 text-[11px] transition-colors ${
                  value === opt.value
                    ? "bg-blue-500/15 text-blue-300 font-bold"
                    : "text-slate-300 hover:bg-white/5"
                }`}
              >
                {opt.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
