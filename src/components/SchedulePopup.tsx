"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { X, Save, Loader2, ChevronLeft, ChevronRight } from "lucide-react";

interface Manager {
  id: string;
  name: string;
  line: string | null;
  shiftStartTime?: string | null;
  shiftEndTime?: string | null;
}

interface SchedulePopupProps {
  isOpen: boolean;
  onClose: () => void;
  month: Date;
  department: "b2g" | "b2b";
  managers: Manager[];
  onSaved: () => void;
}

const SCHEDULE_VALUES = ["8", "4", "-", "о"] as const;
type ScheduleVal = (typeof SCHEDULE_VALUES)[number] | "";

const PICKER_OPTIONS: Array<{
  value: Exclude<ScheduleVal, "">;
  label: string;
  symbol: string;
  colorClass: string;
}> = [
  { value: "8", label: "Полный день",  symbol: "☀",   colorClass: "bg-emerald-500/20 text-emerald-400" },
  { value: "4", label: "Половина дня", symbol: "◑",   colorClass: "bg-amber-500/20 text-amber-400" },
  { value: "-", label: "Выходной",     symbol: "—",   colorClass: "bg-slate-700/50 text-slate-400" },
  { value: "о", label: "Отпуск",       symbol: "ОТП", colorClass: "bg-blue-500/20 text-blue-400" },
];

function cellStyle(val: ScheduleVal): string {
  switch (val) {
    case "8": return "bg-emerald-500/20 text-emerald-400 font-bold";
    case "4": return "bg-amber-500/20 text-amber-400 font-bold";
    case "-": return "bg-slate-700/50 text-slate-500";
    case "о": return "bg-blue-500/20 text-blue-400 font-bold !text-[8px]";
    default:  return "text-slate-700";
  }
}

function cellLabel(val: ScheduleVal): string {
  switch (val) {
    case "8": return "☀";
    case "4": return "◑";
    case "-": return "—";
    case "о": return "ОТП";
    default:  return "";
  }
}

function getDaysInMonth(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

function isWeekend(year: number, month: number, day: number): boolean {
  const dow = new Date(year, month, day).getDay();
  return dow === 0 || dow === 6;
}

function fmtDate(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const MONTH_NAMES = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];
const LINE_LABELS: Record<string, string> = {
  "1": "Линия 1 — Квалификатор",
  "2": "Линия 2 — Бератер",
  "3": "Линия 3 — Доведение",
};

interface PickerState {
  managerId: string;
  dayIdx: number;
  style: React.CSSProperties;
}

export default function SchedulePopup({ isOpen, onClose, month, department, managers, onSaved }: SchedulePopupProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const [currentMonth, setCurrentMonth] = useState(month);
  useEffect(() => { if (isOpen) setCurrentMonth(month); }, [isOpen, month]);

  const year = currentMonth.getFullYear();
  const mo   = currentMonth.getMonth();
  const daysCount = getDaysInMonth(currentMonth);
  const monthStr  = `${year}-${String(mo + 1).padStart(2, "0")}`;

  const shiftMonth = (dir: -1 | 1) => {
    const d = new Date(currentMonth);
    d.setMonth(d.getMonth() + dir);
    setCurrentMonth(d);
    setDirty(false);
  };

  const [grid,   setGrid]   = useState<Record<string, ScheduleVal[]>>({});
  const [loading, setLoading] = useState(false);
  const [saving,  setSaving]  = useState(false);
  const [dirty,   setDirty]   = useState(false);
  const [shiftStart, setShiftStart] = useState<Record<string, string>>({});
  const [shiftEnd,   setShiftEnd]   = useState<Record<string, string>>({});

  // Initialize shift maps from managers prop when popup opens
  useEffect(() => {
    if (!isOpen) return;
    const s: Record<string, string> = {};
    const e: Record<string, string> = {};
    for (const m of managers) {
      s[m.id] = m.shiftStartTime ?? "";
      e[m.id] = m.shiftEndTime ?? "";
    }
    setShiftStart(s);
    setShiftEnd(e);
  }, [isOpen, managers]);

  const saveShift = async (managerId: string, field: "shiftStartTime" | "shiftEndTime", value: string) => {
    try {
      await fetch("/api/daily/managers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: managerId, [field]: value || null }),
      });
    } catch (e) {
      console.error("Failed to save shift:", e);
    }
  };

  // Picker rendered via fixed portal to escape overflow clipping
  const [picker, setPicker] = useState<PickerState | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Close picker on outside click
  useEffect(() => {
    if (!picker) return;
    const h = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPicker(null);
      }
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [picker]);

  const openPicker = (managerId: string, dayIdx: number, cellEl: HTMLButtonElement) => {
    if (picker?.managerId === managerId && picker?.dayIdx === dayIdx) {
      setPicker(null);
      return;
    }
    const rect = cellEl.getBoundingClientRect();
    const PICKER_W = 152;
    const PICKER_H = 176;
    const GAP = 4;

    // Horizontal: centre on cell, clamp inside viewport
    let left = rect.left + rect.width / 2 - PICKER_W / 2;
    left = Math.max(GAP, Math.min(left, window.innerWidth - PICKER_W - GAP));

    // Vertical: prefer above, fall back to below
    let top: number;
    if (rect.top - GAP >= PICKER_H) {
      top = rect.top - PICKER_H - GAP;
    } else {
      top = rect.bottom + GAP;
    }

    setPicker({
      managerId,
      dayIdx,
      style: { position: "fixed", top, left, zIndex: 9999, width: PICKER_W },
    });
  };

  const selectValue = (managerId: string, dayIdx: number, val: Exclude<ScheduleVal, "">) => {
    setGrid((prev) => {
      const row = [...(prev[managerId] || Array(daysCount).fill(""))];
      row[dayIdx] = val;
      return { ...prev, [managerId]: row };
    });
    setDirty(true);
    setPicker(null);
  };

  const fillRow = (managerId: string, val: ScheduleVal) => {
    setGrid((prev) => ({ ...prev, [managerId]: Array(daysCount).fill(val) }));
    setDirty(true);
  };

  const loadSchedule = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/daily/schedule?month=${monthStr}`);
      const json = await res.json();
      const entries: Array<{ userId: string; scheduleDate: string; scheduleValue: string | null; isOnLine: boolean }> =
        json.schedule || [];

      const newGrid: Record<string, ScheduleVal[]> = {};
      for (const m of managers) newGrid[m.id] = Array(daysCount).fill("");
      for (const entry of entries) {
        if (!newGrid[entry.userId]) continue;
        const day = Number.parseInt(entry.scheduleDate.split("-")[2], 10);
        if (day >= 1 && day <= daysCount) {
          newGrid[entry.userId][day - 1] = (entry.scheduleValue || (entry.isOnLine ? "8" : "-")) as ScheduleVal;
        }
      }
      setGrid(newGrid);
      setDirty(false);
    } catch (e) {
      console.error("Failed to load schedule:", e);
    } finally {
      setLoading(false);
    }
  }, [monthStr, managers, daysCount]);

  useEffect(() => { if (isOpen) loadSchedule(); }, [isOpen, loadSchedule]);

  const handleSave = async () => {
    setSaving(true);
    try {
      // Bundle only the workday codes (8/4/-/о). Per-day shift_start/end must NOT
      // be replayed here — the input at the top of each row saves via onBlur to
      // master_managers (default). If we also wrote it into every manager_schedule
      // row for the month, every save would overwrite historical per-day overrides
      // with the current input value. Keep shift fields out so snapshots persist.
      const entries: Array<{ userId: string; date: string; scheduleValue: string }> = [];
      for (const [managerId, row] of Object.entries(grid)) {
        for (let d = 0; d < row.length; d++) {
          if (row[d]) {
            entries.push({
              userId: managerId,
              date: fmtDate(year, mo, d + 1),
              scheduleValue: row[d],
            });
          }
        }
      }
      await fetch("/api/daily/schedule", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries }),
      });
      setDirty(false);
      onSaved();
    } catch (e) {
      console.error("Failed to save schedule:", e);
    } finally {
      setSaving(false);
    }
  };

  // Group managers by line.
  // B2B (Коммерция) does not use lines — all managers share one group and we
  // hide the "Без линии" header to avoid an empty section title. B2G keeps
  // per-line grouping and surfaces the "Без линии" bucket when present.
  const lines   = ["1", "2", "3"];
  const grouped: Array<{ line: string; label: string; managers: Manager[] }> = [];
  if (department === "b2b") {
    grouped.push({ line: "all", label: "", managers });
  } else {
    for (const l of lines) {
      const lm = managers.filter((m) => m.line === l);
      if (lm.length > 0) grouped.push({ line: l, label: LINE_LABELS[l] || `Линия ${l}`, managers: lm });
    }
    const noLine = managers.filter((m) => !m.line || !lines.includes(m.line));
    if (noLine.length > 0) grouped.push({ line: "other", label: "Без линии", managers: noLine });
  }

  if (!isOpen || !mounted) return null;

  return createPortal(
    <>
      {/* Backdrop + modal */}
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      >
        <div
          className="bg-slate-900 border border-white/10 rounded-2xl shadow-2xl max-w-[95vw] max-h-[90vh] flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 shrink-0">
            <div className="flex items-center gap-3">
              <button onClick={() => shiftMonth(-1)} className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors">
                <ChevronLeft className="w-4 h-4" />
              </button>
              <div>
                <h2 className="text-lg font-bold text-white">Расписание</h2>
                <p className="text-[11px] text-slate-400">{MONTH_NAMES[mo]} {year}</p>
              </div>
              <button onClick={() => shiftMonth(1)} className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors">
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
            <div className="flex items-center gap-3">
              {/* Legend */}
              <div className="hidden sm:flex items-center gap-3 text-[10px]">
                {PICKER_OPTIONS.map((o) => (
                  <span key={o.value} className="flex items-center gap-1">
                    <span className={`w-4 h-4 rounded flex items-center justify-center text-[9px] font-bold ${o.colorClass}`}>{o.symbol}</span>
                    {o.label}
                  </span>
                ))}
              </div>
              {dirty && (
                <button onClick={handleSave} disabled={saving}
                  className="flex items-center gap-1.5 px-4 py-1.5 rounded-xl text-[11px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/30 transition-colors disabled:opacity-50">
                  {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                  Сохранить
                </button>
              )}
              <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Table */}
          <div className="overflow-auto flex-1 p-4">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-blue-400" />
              </div>
            ) : managers.length === 0 ? (
              <div className="flex items-center justify-center py-12 text-slate-500 text-sm">
                Нет менеджеров для отображения
              </div>
            ) : (
              <table className="border-collapse text-[11px]">
                <thead>
                  <tr>
                    <th className="sticky left-0 z-10 bg-slate-900 px-3 py-2 text-left text-[10px] uppercase tracking-widest text-slate-500 font-semibold min-w-[160px]">
                      Менеджер
                    </th>
                    <th className="sticky left-[160px] z-10 bg-slate-900 px-1 py-2 text-center text-[9px] text-slate-600 min-w-[28px]">⚡</th>
                    {Array.from({ length: daysCount }, (_, i) => {
                      const weekend = isWeekend(year, mo, i + 1);
                      return (
                        <th key={i} className={`px-0 py-2 text-center min-w-[28px] text-[10px] font-bold ${weekend ? "text-rose-400/60" : "text-slate-400"}`}>
                          {i + 1}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {grouped.map((group) => {
                    const dayCounts = Array.from({ length: daysCount }, (_, d) =>
                      group.managers.reduce((n, m) => n + (grid[m.id]?.[d] === "8" ? 1 : 0), 0),
                    );
                    return (
                      <>
                        {group.label && (
                          <tr key={`hdr-${group.line}`} className="border-t border-white/10">
                            <td colSpan={daysCount + 2} className="sticky left-0 z-10 bg-slate-800/60 px-3 py-1.5">
                              <span className="text-[10px] uppercase tracking-widest font-bold text-slate-300">{group.label}</span>
                            </td>
                          </tr>
                        )}
                        {/* Day count row */}
                        <tr key={`cnt-${group.line}`}>
                          <td className="sticky left-0 z-10 bg-slate-900/95 px-3 py-0.5 text-[9px] text-slate-600 italic">онлайн</td>
                          <td className="sticky left-[160px] z-10 bg-slate-900/95" />
                          {dayCounts.map((cnt, i) => (
                            <td key={i} className="px-0 py-0.5 text-center text-[9px] text-slate-600">{cnt > 0 ? cnt : ""}</td>
                          ))}
                        </tr>
                        {group.managers.map((m) => {
                          const row = grid[m.id] || Array(daysCount).fill("");
                          return (
                            <tr key={m.id} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                              <td className="sticky left-0 z-10 bg-slate-900 px-3 py-1.5 text-[11px] text-slate-200 font-medium whitespace-nowrap">
                                <div className="flex flex-col gap-1">
                                  <span>{m.name}</span>
                                  <div className="flex items-center gap-1 text-[10px] text-slate-500">
                                    <span>с</span>
                                    <input
                                      type="text"
                                      value={shiftStart[m.id] ?? ""}
                                      onChange={(e) => setShiftStart((prev) => ({ ...prev, [m.id]: e.target.value }))}
                                      onBlur={(e) => saveShift(m.id, "shiftStartTime", e.target.value)}
                                      placeholder="09:00"
                                      className="w-12 bg-transparent border border-white/15 rounded px-1 py-0.5 text-[10px] font-mono text-white focus:border-blue-500/60 focus:outline-none text-center placeholder-slate-600"
                                    />
                                    <span>до</span>
                                    <input
                                      type="text"
                                      value={shiftEnd[m.id] ?? ""}
                                      onChange={(e) => setShiftEnd((prev) => ({ ...prev, [m.id]: e.target.value }))}
                                      onBlur={(e) => saveShift(m.id, "shiftEndTime", e.target.value)}
                                      placeholder="18:00"
                                      className="w-12 bg-transparent border border-white/15 rounded px-1 py-0.5 text-[10px] font-mono text-white focus:border-blue-500/60 focus:outline-none text-center placeholder-slate-600"
                                    />
                                  </div>
                                </div>
                              </td>
                              <td className="sticky left-[160px] z-10 bg-slate-900 px-1 py-1">
                                <button onClick={() => fillRow(m.id, "8")} title="Заполнить все рабочими"
                                  className="w-5 h-5 rounded text-[8px] bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 transition-colors flex items-center justify-center">
                                  ☀
                                </button>
                              </td>
                              {row.map((val, d) => {
                                const weekend = isWeekend(year, mo, d + 1);
                                return (
                                  <td key={d} className={`px-0 py-1 text-center ${weekend ? "bg-white/[0.02]" : ""}`}>
                                    <button
                                      onClick={(e) => openPicker(m.id, d, e.currentTarget)}
                                      className={`w-6 h-6 rounded text-[10px] transition-all hover:ring-1 hover:ring-white/20 ${cellStyle(val)} ${!val ? "border border-white/5" : ""}`}
                                    >
                                      {cellLabel(val)}
                                    </button>
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* Picker portal — rendered outside modal to avoid overflow clipping */}
      {picker && (
        <div ref={pickerRef} style={picker.style}
          className="bg-slate-800 border border-white/15 rounded-xl shadow-2xl overflow-hidden">
          {PICKER_OPTIONS.map((opt) => {
            const currentVal = grid[picker.managerId]?.[picker.dayIdx] ?? "";
            return (
              <button
                key={opt.value}
                onClick={(e) => { e.stopPropagation(); selectValue(picker.managerId, picker.dayIdx, opt.value); }}
                className={`w-full flex items-center gap-2 px-3 py-2 text-[11px] hover:bg-white/10 transition-colors text-left ${currentVal === opt.value ? "bg-white/5" : ""}`}
              >
                <span className={`w-5 h-5 rounded flex items-center justify-center text-[9px] font-bold shrink-0 ${opt.colorClass}`}>
                  {opt.symbol}
                </span>
                <span className="text-slate-200 leading-tight">{opt.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </>,
    document.body,
  );
}
