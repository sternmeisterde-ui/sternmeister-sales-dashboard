"use client";

import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { Calendar, ChevronLeft, ChevronRight, X } from "lucide-react";
import { berlinCivilComponents, berlinCivilDate, todayBerlinDate } from "@/lib/utils/date";

// ─── helpers ───────────────────────────────────────────────
//
// Every Date this component handles is a UTC instant for 00:00 Berlin of some
// civil day — built via `berlinCivilDate("YYYY-MM-DD")` or
// `todayBerlinDate()`. NEVER `new Date(y, m, d)` (browser-local midnight) —
// that drifts the civil-day signal in non-Berlin browsers and the picker
// silently sends the wrong day to the API. Comparisons therefore use
// `berlinCivilComponents` to read y/m/d in Berlin TZ.

const getDaysInMonth = (date: Date) => {
  // `date` is the Berlin-midnight UTC instant of any day in the desired month;
  // read its components in Berlin TZ.
  const { y, m } = berlinCivilComponents(date);
  // Last-day-of-month and first-day-weekday: civil-calendar arithmetic, no TZ.
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const firstDayOfMonth = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); // 0 = Sun
  return { daysInMonth, firstDayOfMonth };
};

const isSameDay = (a: Date | null, b: Date | null) => {
  if (!a || !b) return false;
  const ca = berlinCivilComponents(a);
  const cb = berlinCivilComponents(b);
  return ca.y === cb.y && ca.m === cb.m && ca.d === cb.d;
};

const isInRange = (d: Date, start: Date | null, end: Date | null) => {
  if (!start || !end) return false;
  const t = d.getTime();
  return t >= start.getTime() && t <= end.getTime();
};

const fmtShort = (d: Date) => {
  const { m, d: day } = berlinCivilComponents(d);
  return `${String(day).padStart(2, "0")}.${String(m).padStart(2, "0")}`;
};

/** Build a Berlin-midnight Date for a civil (y, m, d) triple. */
function berlinDayOfMonth(y: number, m: number, d: number): Date {
  const civil = `${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}-${d.toString().padStart(2, "0")}`;
  return berlinCivilDate(civil);
}

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
  /** Earliest selectable date (days before are greyed out) */
  minDate?: Date | null;
  /** Latest selectable date (days after are greyed out) */
  maxDate?: Date | null;
  /** extra classes for the wrapper */
  className?: string;
  /** When true, shows an in-popover "День / Период" toggle so the user can
   * switch between single-click day selection and two-click range selection
   * without the parent needing to rerender with a different mode prop. */
  allowModeToggle?: boolean;
}

// ─── component ─────────────────────────────────────────────
export default function CalendarPicker({
  mode,
  value,
  onChange,
  onClear,
  minDate,
  maxDate,
  className = "",
  allowModeToggle = false,
}: CalendarPickerProps) {
  // Internal mode shadows the prop when allowModeToggle is true. Default to
  // "single" for toggleable pickers since that's the most common intent.
  const [internalMode, setInternalMode] = useState<"range" | "single">(
    allowModeToggle ? "single" : mode,
  );
  const effectiveMode = allowModeToggle ? internalMode : mode;
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});
  // Start the calendar on maxDate's month if data hasn't reached today.
  // Both branches return a Berlin-midnight Date for the 1st of that month so
  // the rest of the component can navigate / render in a single TZ convention.
  const [month, setMonth] = useState(() => {
    const today = todayBerlinDate();
    const ref = maxDate && maxDate < today ? maxDate : today;
    const { y, m } = berlinCivilComponents(ref);
    return berlinDayOfMonth(y, m, 1);
  });
  const [draft, setDraft] = useState<DateRange>({ start: null, end: null });
  const wrapperRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { setMounted(true); }, []);

  // Sync draft with external value when popup opens
  useEffect(() => {
    if (open) setDraft({ start: value.start, end: value.end });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close on outside click (check both wrapper and portal popup)
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        wrapperRef.current?.contains(target) ||
        popupRef.current?.contains(target)
      ) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const isActive = !!(value.start && (effectiveMode === "single" || value.end));

  // min/max нормализуются к берлинской полуночи их civil-дня (сами пропсы
  // могут быть произвольным моментом суток). НЕ getFullYear/getMonth/getDate —
  // это браузерная зона, west-of-Berlin браузер сдвигал границу на день.
  const isDayDisabled = (date: Date): boolean => {
    if (minDate) {
      const c = berlinCivilComponents(minDate);
      if (date < berlinDayOfMonth(c.y, c.m, c.d)) return true;
    }
    if (maxDate) {
      const c = berlinCivilComponents(maxDate);
      if (date > berlinDayOfMonth(c.y, c.m, c.d)) return true;
    }
    return false;
  };

  const handleDayClick = (date: Date) => {
    if (isDayDisabled(date)) return;
    if (effectiveMode === "single") {
      onChange({ start: date, end: date });
      setOpen(false);
      return;
    }
    // range mode
    if (!draft.start || (draft.start && draft.end)) {
      setDraft({ start: date, end: null });
      return;
    }
    // Second click — commit the range. Same-day click produces {X, X} so the
    // user doesn't need to hit "Apply" just to pick one day inside a range picker.
    const next: DateRange = date >= draft.start
      ? { start: draft.start, end: date }
      : { start: date, end: draft.start };
    setDraft(next);
    onChange(next);
    setOpen(false);
  };

  const applyRange = () => {
    if (draft.start) {
      // Allow single-day selection: if no end date, use start as end
      onChange({ start: draft.start, end: draft.end || draft.start });
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
    ? effectiveMode === "single" && value.start
      ? fmtShort(value.start)
      : value.start && value.end
      ? isSameDay(value.start, value.end)
        ? fmtShort(value.start)
        : `${fmtShort(value.start)} – ${fmtShort(value.end)}`
      : null
    : null;

  const { daysInMonth, firstDayOfMonth } = getDaysInMonth(month);

  return (
    <div ref={wrapperRef} className={`relative ${className}`}>
      {/* Trigger button */}
      <button
        ref={triggerRef}
        onClick={() => {
          if (!open && triggerRef.current) {
            const rect = triggerRef.current.getBoundingClientRect();
            const POPUP_W = 288;
            const POPUP_H = 360; // approximate popup height
            const GAP = 8;
            // Horizontal: keep inside viewport
            let left = rect.left;
            if (left + POPUP_W > window.innerWidth - GAP) {
              left = Math.max(GAP, window.innerWidth - POPUP_W - GAP);
            }
            // Vertical: open above if enough space, else below
            const spaceAbove = rect.top - GAP;
            const bottom = spaceAbove >= POPUP_H
              ? window.innerHeight - rect.top + GAP
              : undefined;
            const top = spaceAbove < POPUP_H
              ? rect.bottom + GAP
              : undefined;
            setDropdownStyle({
              position: "fixed",
              bottom,
              top,
              left,
              zIndex: 9999,
            });
          }
          setOpen((v) => !v);
        }}
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
          <span
            role="button"
            tabIndex={0}
            aria-label="Очистить фильтр дат"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              clear();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                clear();
              }
            }}
            className="ml-0.5 p-0.5 hover:bg-white/10 rounded transition-colors inline-flex items-center justify-center cursor-pointer"
          >
            <X className="w-3 h-3" />
          </span>
        )}
      </button>

      {/* Popup — portal to document.body to escape backdrop-filter/overflow ancestors */}
      {open && mounted && createPortal(
        <div ref={popupRef} style={dropdownStyle} className="bg-slate-900 border border-white/15 rounded-2xl p-4 shadow-2xl w-72 animate-in fade-in duration-150">
          {/* День / Период toggle */}
          {allowModeToggle && (
            <div className="flex bg-slate-800/60 p-0.5 rounded-lg border border-white/5 mb-3 w-fit mx-auto">
              <button
                type="button"
                onClick={() => {
                  setInternalMode("single");
                  setDraft({ start: null, end: null });
                }}
                className={`px-3 py-1 text-[11px] rounded-md transition-all ${
                  effectiveMode === "single" ? "bg-blue-500 text-white" : "text-slate-400 hover:text-white"
                }`}
              >День</button>
              <button
                type="button"
                onClick={() => {
                  setInternalMode("range");
                  setDraft({ start: null, end: null });
                }}
                className={`px-3 py-1 text-[11px] rounded-md transition-all ${
                  effectiveMode === "range" ? "bg-blue-500 text-white" : "text-slate-400 hover:text-white"
                }`}
              >Период</button>
            </div>
          )}

          {/* Year + Month navigation (≪/≫ year, ◀/▶ month) */}
          {(() => {
            const { y: my, m: mm } = berlinCivilComponents(month);
            // Walk months/years in civil-calendar terms; month=Date.UTC overflow
            // handles January-December roll automatically.
            const prevMonth = berlinDayOfMonth(my, mm - 1, 1);
            const nextMonth = berlinDayOfMonth(my, mm + 1, 1);
            const prevYear = berlinDayOfMonth(my - 1, mm, 1);
            const nextYear = berlinDayOfMonth(my + 1, mm, 1);
            const minMonth = minDate
              ? (() => { const c = berlinCivilComponents(minDate); return berlinDayOfMonth(c.y, c.m, 1); })()
              : null;
            const maxMonth = maxDate
              ? (() => { const c = berlinCivilComponents(maxDate); return berlinDayOfMonth(c.y, c.m, 1); })()
              : null;
            const prevDisabled = minMonth !== null && prevMonth < minMonth;
            const nextDisabled = maxMonth !== null && nextMonth > maxMonth;
            const prevYearDisabled = minMonth !== null && prevYear < minMonth;
            const nextYearDisabled = maxMonth !== null && nextYear > maxMonth;
            return (
              <div className="flex items-center justify-between mb-3 gap-1">
                <button
                  onClick={() => { if (!prevYearDisabled) setMonth(prevYear); }}
                  disabled={prevYearDisabled}
                  title="Предыдущий год"
                  className="px-1.5 py-1 text-[11px] font-bold text-slate-400 hover:bg-white/5 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  «
                </button>
                <button
                  onClick={() => { if (!prevDisabled) setMonth(prevMonth); }}
                  disabled={prevDisabled}
                  title="Предыдущий месяц"
                  className="p-1.5 hover:bg-white/5 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <ChevronLeft className="w-4 h-4 text-slate-400" />
                </button>
                <span className="text-xs font-bold text-white capitalize flex-1 text-center">
                  {/* timeZone обязателен: month — берлинская полночь 1-го числа
                      (напр. 1 авг = 31.07 22:00 UTC); без него west-of-Berlin
                      браузер подписывал сетку ПРЕДЫДУЩИМ месяцем, и юзер кликал
                      «июльские» числа, реально выбирая август. */}
                  {month.toLocaleDateString("ru-RU", { month: "long", year: "numeric", timeZone: "Europe/Berlin" })}
                </span>
                <button
                  onClick={() => { if (!nextDisabled) setMonth(nextMonth); }}
                  disabled={nextDisabled}
                  title="Следующий месяц"
                  className="p-1.5 hover:bg-white/5 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <ChevronRight className="w-4 h-4 text-slate-400" />
                </button>
                <button
                  onClick={() => { if (!nextYearDisabled) setMonth(nextYear); }}
                  disabled={nextYearDisabled}
                  title="Следующий год"
                  className="px-1.5 py-1 text-[11px] font-bold text-slate-400 hover:bg-white/5 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  »
                </button>
              </div>
            );
          })()}

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
              const sel = effectiveMode === "range" ? draft : value;
              const today = todayBerlinDate();
              const { y: monthY, m: monthM } = berlinCivilComponents(month);
              for (let day = 1; day <= daysInMonth; day++) {
                const date = berlinDayOfMonth(monthY, monthM, day);
                const isStart = isSameDay(date, sel.start);
                const isEnd = isSameDay(date, sel.end);
                const inRange =
                  effectiveMode === "range" &&
                  sel.start &&
                  sel.end &&
                  isInRange(date, sel.start, sel.end);
                const isToday = isSameDay(date, today);
                const disabled = isDayDisabled(date);

                cells.push(
                  <button
                    key={day}
                    onClick={() => handleDayClick(date)}
                    disabled={disabled}
                    className={`aspect-square flex items-center justify-center text-[11px] rounded-lg transition-all relative ${
                      disabled
                        ? "text-slate-600 cursor-not-allowed"
                        : isStart || isEnd
                        ? "bg-blue-500 text-white font-bold"
                        : inRange
                        ? "bg-blue-500/20 text-blue-300"
                        : "text-slate-300 hover:bg-white/5"
                    } ${isToday && !isStart && !isEnd && !disabled ? "ring-1 ring-blue-500/40" : ""}`}
                  >
                    {day}
                  </button>
                );
              }
              return cells;
            })()}
          </div>

          {/* Range preview — timeZone обязателен по той же причине, что у
              заголовка месяца: без него превью показывало «−1 день». */}
          {effectiveMode === "range" && (
            <div className="flex items-center justify-between text-[10px] text-slate-400 bg-slate-800/50 rounded-lg px-3 py-2 mb-3">
              <span>
                {draft.start
                  ? draft.start.toLocaleDateString("ru-RU", { timeZone: "Europe/Berlin" })
                  : "Начало"}
              </span>
              <span className="text-slate-600 mx-2">→</span>
              <span>
                {draft.end
                  ? draft.end.toLocaleDateString("ru-RU", { timeZone: "Europe/Berlin" })
                  : draft.start
                  ? "Нажмите для одного дня"
                  : "Конец"}
              </span>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2">
            {effectiveMode === "range" ? (
              <>
                <button
                  onClick={applyRange}
                  disabled={!draft.start}
                  className="flex-1 bg-blue-500 hover:bg-blue-600 disabled:bg-slate-700 disabled:text-slate-500 text-white text-xs font-semibold py-2 rounded-lg transition-colors"
                >
                  {draft.start && !draft.end ? "Выбрать день" : "Применить"}
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
        </div>,
        document.body,
      )}
    </div>
  );
}
