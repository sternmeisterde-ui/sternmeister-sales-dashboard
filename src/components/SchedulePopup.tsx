"use client";

import { useState, useEffect, useCallback } from "react";
import { X, Save, Loader2, ChevronLeft, ChevronRight } from "lucide-react";

interface Manager {
  id: string;
  name: string;
  line: string | null;
}

interface SchedulePopupProps {
  isOpen: boolean;
  onClose: () => void;
  month: Date;
  department: "b2g" | "b2b";
  managers: Manager[];
  onSaved: () => void;
}

const SCHEDULE_VALUES = ["8", "-", "о"] as const;
type ScheduleVal = typeof SCHEDULE_VALUES[number] | "";

function nextValue(current: ScheduleVal): ScheduleVal {
  switch (current) {
    case "": return "8";
    case "8": return "-";
    case "-": return "о";
    case "о": return "8";
    default: return "8";
  }
}

function cellStyle(val: ScheduleVal): string {
  switch (val) {
    case "8": return "bg-emerald-500/20 text-emerald-400 font-bold";
    case "-": return "bg-slate-700/50 text-slate-500";
    case "о": return "bg-blue-500/20 text-blue-400 font-bold";
    default: return "text-slate-700";
  }
}

function getDaysInMonth(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

function isWeekend(year: number, month: number, day: number): boolean {
  const d = new Date(year, month, day);
  const dow = d.getDay();
  return dow === 0 || dow === 6;
}

function fmtDate(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const MONTH_NAMES = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const LINE_LABELS: Record<string, string> = { "1": "Линия 1 — Квалификатор", "2": "Линия 2 — Бератер", "3": "Линия 3 — Доведение" };

export default function SchedulePopup({ isOpen, onClose, month, managers, onSaved }: SchedulePopupProps) {
  const [currentMonth, setCurrentMonth] = useState(month);

  // Sync with parent when popup opens
  useEffect(() => { if (isOpen) setCurrentMonth(month); }, [isOpen, month]);

  const year = currentMonth.getFullYear();
  const mo = currentMonth.getMonth();
  const daysCount = getDaysInMonth(currentMonth);
  const monthStr = `${year}-${String(mo + 1).padStart(2, "0")}`;

  const shiftMonth = (dir: -1 | 1) => {
    const d = new Date(currentMonth);
    d.setMonth(d.getMonth() + dir);
    setCurrentMonth(d);
    setDirty(false);
  };

  // grid[managerId][day-1] = "8" | "-" | "о" | ""
  const [grid, setGrid] = useState<Record<string, ScheduleVal[]>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Load schedule for month
  const loadSchedule = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/daily/schedule?month=${monthStr}`);
      const json = await res.json();
      const entries: Array<{ userId: string; scheduleDate: string; scheduleValue: string | null; isOnLine: boolean }> = json.schedule || [];

      const newGrid: Record<string, ScheduleVal[]> = {};
      for (const m of managers) {
        newGrid[m.id] = Array(daysCount).fill("");
      }

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

  useEffect(() => {
    if (isOpen) loadSchedule();
  }, [isOpen, loadSchedule]);

  const toggleCell = (managerId: string, dayIdx: number) => {
    setGrid((prev) => {
      const row = [...(prev[managerId] || Array(daysCount).fill(""))];
      row[dayIdx] = nextValue(row[dayIdx]);
      return { ...prev, [managerId]: row };
    });
    setDirty(true);
  };

  // Fill entire row with a value
  const fillRow = (managerId: string, val: ScheduleVal) => {
    setGrid((prev) => {
      const row = Array(daysCount).fill(val);
      return { ...prev, [managerId]: row };
    });
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
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

  // Group managers by line
  const lines = ["1", "2", "3"];
  const grouped = lines.map((l) => ({
    line: l,
    label: LINE_LABELS[l] || `Линия ${l}`,
    managers: managers.filter((m) => m.line === l),
  })).filter((g) => g.managers.length > 0);

  // Also add managers without a line
  const noLine = managers.filter((m) => !m.line || !lines.includes(m.line));
  if (noLine.length > 0) {
    grouped.push({ line: "other", label: "Без линии", managers: noLine });
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-slate-900 border border-white/10 rounded-2xl shadow-2xl max-w-[95vw] max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
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
            <div className="flex items-center gap-3 text-[10px]">
              <span className="flex items-center gap-1"><span className="w-4 h-4 rounded bg-emerald-500/20 text-emerald-400 flex items-center justify-center text-[9px] font-bold">8</span> работает</span>
              <span className="flex items-center gap-1"><span className="w-4 h-4 rounded bg-slate-700/50 text-slate-500 flex items-center justify-center text-[9px]">-</span> не работает</span>
              <span className="flex items-center gap-1"><span className="w-4 h-4 rounded bg-blue-500/20 text-blue-400 flex items-center justify-center text-[9px] font-bold">о</span> отпуск</span>
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
          ) : (
            <table className="border-collapse text-[11px]">
              <thead>
                <tr>
                  <th className="sticky left-0 z-10 bg-slate-900 px-3 py-2 text-left text-[10px] uppercase tracking-widest text-slate-500 font-semibold min-w-[160px]">
                    Менеджер
                  </th>
                  <th className="sticky left-[160px] z-10 bg-slate-900 px-1 py-2 text-center text-[9px] text-slate-600 min-w-[28px]">
                    ⚡
                  </th>
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
                {grouped.map((group) => (
                  <LineGroup key={group.line} group={group} grid={grid} daysCount={daysCount}
                    year={year} mo={mo} onToggle={toggleCell} onFillRow={fillRow} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function LineGroup({ group, grid, daysCount, year, mo, onToggle, onFillRow }: {
  group: { line: string; label: string; managers: Manager[] };
  grid: Record<string, ScheduleVal[]>;
  daysCount: number; year: number; mo: number;
  onToggle: (id: string, day: number) => void;
  onFillRow: (id: string, val: ScheduleVal) => void;
}) {
  // Count working managers per day
  const dayCounts = Array.from({ length: daysCount }, (_, d) => {
    let count = 0;
    for (const m of group.managers) {
      const val = grid[m.id]?.[d] || "";
      if (val === "8") count++;
    }
    return count;
  });

  return (
    <>
      {/* Group header */}
      <tr className="border-t border-white/10">
        <td colSpan={daysCount + 2} className="sticky left-0 z-10 bg-slate-800/60 px-3 py-1.5">
          <span className="text-[10px] uppercase tracking-widest font-bold text-slate-300">{group.label}</span>
        </td>
      </tr>

      {/* Manager rows */}
      {group.managers.map((m) => {
        const row = grid[m.id] || Array(daysCount).fill("");
        return (
          <tr key={m.id} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
            <td className="sticky left-0 z-10 bg-slate-900/95 px-3 py-1 text-[11px] text-slate-300 font-medium whitespace-nowrap">
              {m.name}
            </td>
            <td className="sticky left-[160px] z-10 bg-slate-900/95 px-1 py-1">
              <button onClick={() => onFillRow(m.id, "8")} title="Заполнить все 8"
                className="w-5 h-5 rounded text-[8px] bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 transition-colors flex items-center justify-center">
                8
              </button>
            </td>
            {row.map((val, d) => {
              const weekend = isWeekend(year, mo, d + 1);
              return (
                <td key={d} className={`px-0 py-1 text-center ${weekend ? "bg-white/[0.02]" : ""}`}>
                  <button
                    onClick={() => onToggle(m.id, d)}
                    className={`w-6 h-6 rounded text-[10px] transition-all hover:ring-1 hover:ring-white/20 ${cellStyle(val)} ${!val ? "border border-white/5" : ""}`}
                  >
                    {val || ""}
                  </button>
                </td>
              );
            })}
          </tr>
        );
      })}

      {/* Summary row: count per day */}
      <tr className="border-b border-white/10">
        <td className="sticky left-0 z-10 bg-slate-900/95 px-3 py-1 text-[10px] text-slate-500 font-bold">
          На линии
        </td>
        <td className="sticky left-[160px] z-10 bg-slate-900/95" />
        {dayCounts.map((count, d) => (
          <td key={d} className="px-0 py-1 text-center text-[10px] font-bold text-slate-400">
            {count > 0 ? count : ""}
          </td>
        ))}
      </tr>
    </>
  );
}
