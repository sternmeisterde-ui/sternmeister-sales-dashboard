"use client";

import { useEffect, useRef, useState } from "react";
import { HelpCircle } from "lucide-react";

/**
 * Иконка «?» с разворачивающейся панелью-пояснением. Клик вне панели или Esc —
 * закрывают. Панель выпадает вправо-вниз от иконки (right-0), чтобы не уезжать
 * за край. Используется в шапке FunnelChart для конверсий со своими тонкостями.
 */
export default function InfoPopover({
  title,
  points,
}: {
  title: string;
  points: string[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Пояснение к конверсии"
        aria-expanded={open}
        className={`flex items-center justify-center w-6 h-6 rounded-full border transition-colors ${
          open
            ? "border-blue-400/40 bg-blue-500/15 text-blue-300"
            : "border-white/10 bg-slate-800/40 text-slate-400 hover:text-slate-200 hover:border-white/25"
        }`}
      >
        <HelpCircle size={14} />
      </button>
      {open && (
        <div
          role="dialog"
          className="absolute right-0 top-full mt-2 z-30 w-80 max-w-[90vw] rounded-xl border border-white/10 bg-slate-900/95 backdrop-blur p-3.5 shadow-[0_8px_24px_rgba(0,0,0,0.35)] text-left"
        >
          <div className="text-sm font-semibold text-white mb-2">{title}</div>
          <ul className="flex flex-col gap-1.5 text-[12px] leading-snug text-slate-300">
            {points.map((p, i) => (
              <li key={i} className="flex gap-1.5">
                <span className="text-slate-600 select-none">•</span>
                <span>{p}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
