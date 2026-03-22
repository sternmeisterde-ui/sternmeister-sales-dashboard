"use client";

import { useState, useRef, useEffect } from "react";
import { Calendar, ChevronLeft, ChevronRight, X } from "lucide-react";

// ─── helpers ───────────────────────────────────────────────
const getDaysInMonth = (date: Date) => {
  const year = date.getFullYear();
  const month = date.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDayOfMonth = new Date(year, month, 1).getDay(); // 0=Sun
  return { daysInMonth, firstDayOfMonth };
};

const isSameDay = (a: Date | null, b: Date | null) => {
  if (!a || !b) return false;
  return (
    a.getDate() === b.getDate() &&
    a.getMonth() === b.getMonth() &&
    a.getFullYear() === b.getFullYear()
  );
};

const isInRange = (d: Date, start: Date | null, end: Date | null) => {
  if (!start || !end) return false;
  const t = d.getTime();
  return t >= start.getTime() && t <= end.getTime();
};

const fmtShort = (d: Date) =>
  `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;

// ─── types ─────────────────────────────────────────────────
export interface DateRange {
  start: Date | null;
  end: Date | null;
}

interface CalendarPickerProps {
  /** "range" = date-range selection, "single" = pick one day */
  mode: "range" | "single";
  value: DateRange;
  onChange: (range: DateRange) => void;
  onClear: () => void;
  /** extra classes for the wrapper */
  className?: string;
}

// ─── component ─────────────────────────────────────────────
export default function CalendarPicker({
  mode,
  value,
  onChange,
  onClear,
  className = "",
}: CalendarPickerProps) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(new Date());
  const [draft, setDraft] = useState<DateRange>({ start: null, end: null });
  const ref = useRef<HTMLDivElement>(null);

  // Sync draft with external value when popup opens
  useEffect(() => {
    if (open) setDraft({ start: value.start, end: value.end });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const isActive = !!(value.start && (mode === "single" || value.end));

  const handleDayClick = (date: Date) => {
    if (mode === "single") {
      onChange({ start: date, end: date });
      setOpen(false);
      return;
    }
    // range mode
    if (!draft.start || (draft.start && draft.end)) {
      setDraft({ start: date, end: null });
    } else if (date >= draft.start) {
      setDraft({ ...draft, end: date });
    } else {
      setDraft({ start: date, end: draft.start });
    }
  };

  const applyRange = () => {
    if (draft.start && draft.end) {
      onChange(draft);
      setOpen(false);
    }
  };

  const clear = () => {
    setDraft({ start: null, end: null });
    onClear();
    setOpen(false);
  };

  // label for badge
  const badgeLabel = isActive
    ? mode === "single" && value.start
      ? fmtShort(value.start)
      : value.start && value.end
      ? `${fmtShort(value.start)} – ${fmtShort(value.end)}`
      : null
    : null;

  const { daysInMonth, firstDayOfMonth } = getDaysInMonth(month);

  return (
    <div ref={ref} className={`relative ${className}`}>
      {/* Trigger button */}
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all border ${
          isActive
            ? "bg-blue-500/20 text-blue-400 border-blue-500/30"
            : open
            ? "bg-white/5 text-white border-white/10"
            : "text-slate-400 hover:text-white border-transparent hover:border-white/5"
        }`}
      >
        <Calendar className="w-3.5 h-3.5" />
        {badgeLabel ? (
          <span className="tracking-wide">{badgeLabel}</span>
        ) : (
          <span className="uppercase tracking-widest hidden sm:inline">
            Календарь
          </span>
        )}
        {isActive && (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              clear();
            }}
            className="ml-0.5 p-0.5 hover:bg-white/10 rounded transition-colors"
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </button>

      {/* Popup */}
      {open && (
        <div className="absolute top-10 right-0 sm:right-auto sm:left-0 bg-slate-900/95 backdrop-blur-xl border border-white/10 rounded-2xl p-4 shadow-2xl z-50 w-72 animate-in fade-in slide-in-from-top-2">
          {/* Month navigation */}
          <div className="flex items-center justify-between mb-3">
            <button
              onClick={() => {
                const m = new Date(month);
                m.setMonth(m.getMonth() - 1);
                setMonth(m);
              }}
              className="p-1.5 hover:bg-white/5 rounded-lg transition-colors"
            >
              <ChevronLeft className="w-4 h-4 text-slate-400" />
            </button>
            <span className="text-xs font-bold text-white capitalize">
              {month.toLocaleDateString("ru-RU", {
                month: "long",
                year: "numeric",
              })}
            </span>
            <button
              onClick={() => {
                const m = new Date(month);
                m.setMonth(m.getMonth() + 1);
                setMonth(m);
              }}
              className="p-1.5 hover:bg-white/5 rounded-lg transition-colors"
            >
              <ChevronRight className="w-4 h-4 text-slate-400" />
            </button>
          </div>

          {/* Day-of-week labels */}
          <div className="grid grid-cols-7 gap-1 mb-1">
            {["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((d) => (
              <div
                key={d}
                className="text-center text-[10px] font-semibold text-slate-500 py-1"
              >
                {d}
              </div>
            ))}
          </div>

          {/* Days grid */}
          <div className="grid grid-cols-7 gap-1 mb-3">
            {(() => {
              const cells: React.ReactNode[] = [];
              // Shift so Monday = 0 (JS getDay() has Sunday = 0)
              const offset = (firstDayOfMonth + 6) % 7;
              for (let i = 0; i < offset; i++) {
                cells.push(<div key={`e-${i}`} className="aspect-square" />);
              }
              const sel = mode === "range" ? draft : value;
              const today = new Date();
              for (let day = 1; day <= daysInMonth; day++) {
                const date = new Date(
                  month.getFullYear(),
                  month.getMonth(),
                  day
                );
                const isStart = isSameDay(date, sel.start);
                const isEnd = isSameDay(date, sel.end);
                const inRange =
                  mode === "range" &&
                  sel.start &&
                  sel.end &&
                  isInRange(date, sel.start, sel.end);
                const isToday = isSameDay(date, today);

                cells.push(
                  <button
                    key={day}
                    onClick={() => handleDayClick(date)}
                    className={`aspect-square flex items-center justify-center text-[11px] rounded-lg transition-all relative ${
                      isStart || isEnd
                        ? "bg-blue-500 text-white font-bold"
                        : inRange
                        ? "bg-blue-500/20 text-blue-300"
                        : "text-slate-300 hover:bg-white/5"
                    } ${isToday && !isStart && !isEnd ? "ring-1 ring-blue-500/40" : ""}`}
                  >
                    {day}
                  </button>
                );
              }
              return cells;
            })()}
          </div>

          {/* Range preview */}
          {mode === "range" && (
            <div className="flex items-center justify-between text-[10px] text-slate-400 bg-slate-800/50 rounded-lg px-3 py-2 mb-3">
              <span>
                {draft.start
                  ? draft.start.toLocaleDateString("ru-RU")
                  : "Начало"}
              </span>
              <span className="text-slate-600 mx-2">→</span>
              <span>
                {draft.end
                  ? draft.end.toLocaleDateString("ru-RU")
                  : "Конец"}
              </span>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2">
            {mode === "range" ? (
              <>
                <button
                  onClick={applyRange}
                  disabled={!draft.start || !draft.end}
                  className="flex-1 bg-blue-500 hover:bg-blue-600 disabled:bg-slate-700 disabled:text-slate-500 text-white text-xs font-semibold py-2 rounded-lg transition-colors"
                >
                  Применить
                </button>
                <button
                  onClick={clear}
                  className="px-4 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold py-2 rounded-lg transition-colors"
                >
                  Сбросить
                </button>
              </>
            ) : (
              <button
                onClick={clear}
                className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold py-2 rounded-lg transition-colors"
              >
                Сбросить
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
