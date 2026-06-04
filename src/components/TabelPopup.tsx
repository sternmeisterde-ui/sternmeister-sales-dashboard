"use client";

// «Табель» popup — year-at-a-glance payroll for a single department.
//
// Layout: rows = active managers, columns = 12 months. Sticky leftmost cell is
// the manager name + an inline editable «Ставка/день» input. Each month cell
// shows the gross payout (= equiv-full-days × dailyRate) for that month with
// a tiny equiv-days subscript. Right-most column is the year total.
//
// Edit flow:
//   • change ставка → onBlur PATCHes /api/daily/managers (single field)
//     and triggers a year refetch so all month columns recompute.
//   • year arrows shift the visible window; refetch fires on each shift.
//
// Read-only for non-admin sessions on the server side; this component
// assumes the caller has gated access.

import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { X, Loader2, ChevronLeft, ChevronRight, Save } from "lucide-react";
import { getDepartment } from "@/lib/config/tenant";

interface MonthEntry {
  equivFullDays: number;
  baseAmount: number;
  bonusAmount: number;
  bonusNote: string | null;
  grossAmount: number;
  statusBreakdown: Record<string, number>;
}

interface YearRow {
  userId: string;
  managerName: string;
  dailyRate: number | null;
  monthly: Record<string, MonthEntry>;
  yearGrossTotal: number;
  yearEquivDaysTotal: number;
}

interface YearPayload {
  success: boolean;
  year: number;
  department: "b2g" | "b2b";
  months: string[];
  rows: YearRow[];
}

interface TabelPopupProps {
  isOpen: boolean;
  onClose: () => void;
  department: "b2g" | "b2b";
  initialYear?: number;
}

const MONTH_NAMES_SHORT = ["Янв","Фев","Мар","Апр","Май","Июн","Июл","Авг","Сен","Окт","Ноя","Дек"];

function fmtMoney(n: number): string {
  // Locale-free thousands separator + 0/2 decimals depending on roundness.
  // Currency symbol intentionally omitted — project doesn't track currency
  // per row; the column header carries the unit if it ever needs one.
  if (!Number.isFinite(n) || n === 0) return "—";
  const rounded = Math.round(n * 100) / 100;
  const isInt = rounded === Math.trunc(rounded);
  return rounded.toLocaleString("ru-RU", {
    minimumFractionDigits: isInt ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

function fmtDays(n: number): string {
  if (!n) return "";
  const rounded = Math.round(n * 100) / 100;
  return rounded.toLocaleString("ru-RU", { maximumFractionDigits: 2 });
}

export default function TabelPopup({ isOpen, onClose, department, initialYear }: TabelPopupProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const [year, setYear] = useState<number>(initialYear ?? new Date().getFullYear());
  useEffect(() => { if (isOpen && initialYear) setYear(initialYear); }, [isOpen, initialYear]);

  const [data, setData] = useState<YearPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  // Local override for the rate input so a mid-edit value doesn't get wiped
  // when the parent state still holds the old number.
  const [rateDraft, setRateDraft] = useState<Record<string, string>>({});

  // Bonus popover state — fixed-position panel anchored to the clicked cell.
  const [bonusEditor, setBonusEditor] = useState<{
    userId: string;
    periodMonth: string;
    amount: string;
    note: string;
    style: React.CSSProperties;
  } | null>(null);
  const bonusRef = useRef<HTMLDivElement>(null);
  const [bonusSaving, setBonusSaving] = useState(false);

  useEffect(() => {
    if (!bonusEditor) return;
    const h = (e: MouseEvent) => {
      if (bonusRef.current && !bonusRef.current.contains(e.target as Node)) {
        setBonusEditor(null);
      }
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [bonusEditor]);

  const fetchYear = useCallback(async () => {
    setLoading(true);
    setAccessError(null);
    try {
      const res = await fetch(`/api/daily/payroll/year?year=${year}&department=${department}`);
      // Distinguish "no permission" from "no data" — 403 ≠ empty department.
      if (res.status === 403) {
        setAccessError("Доступ только для администратора");
        setData(null);
        return;
      }
      const json = (await res.json()) as YearPayload | { error: string };
      if ("success" in json && json.success) {
        setData(json);
        const drafts: Record<string, string> = {};
        for (const r of json.rows) drafts[r.userId] = r.dailyRate !== null ? String(r.dailyRate) : "";
        setRateDraft(drafts);
      } else {
        console.error("[Tabel] fetch failed:", json);
      }
    } catch (e) {
      console.error("[Tabel] fetch failed:", e);
    } finally {
      setLoading(false);
    }
  }, [year, department]);

  useEffect(() => { if (isOpen) fetchYear(); }, [isOpen, fetchYear]);

  const saveRate = async (userId: string) => {
    const raw = (rateDraft[userId] ?? "").trim();
    setSavingId(userId);
    try {
      await fetch("/api/daily/managers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: userId, dailyRate: raw === "" ? null : raw }),
      });
      // Refetch so all 12 month cells recompute against the new rate.
      await fetchYear();
    } catch (e) {
      console.error("[Tabel] save rate failed:", e);
    } finally {
      setSavingId(null);
    }
  };

  const openBonusEditor = (userId: string, periodMonth: string, cell: HTMLElement) => {
    const row = data?.rows.find((r) => r.userId === userId);
    const entry = row?.monthly[periodMonth];
    const rect = cell.getBoundingClientRect();
    const PANEL_W = 240;
    const PANEL_H = 180;
    const GAP = 6;
    let left = rect.left + rect.width / 2 - PANEL_W / 2;
    left = Math.max(GAP, Math.min(left, window.innerWidth - PANEL_W - GAP));
    let top: number;
    if (rect.bottom + GAP + PANEL_H <= window.innerHeight) {
      top = rect.bottom + GAP;
    } else {
      top = rect.top - PANEL_H - GAP;
    }
    setBonusEditor({
      userId,
      periodMonth,
      amount: entry?.bonusAmount ? String(entry.bonusAmount) : "",
      note: entry?.bonusNote ?? "",
      style: { position: "fixed", top, left, zIndex: 9999, width: PANEL_W },
    });
  };

  const saveBonus = async () => {
    if (!bonusEditor) return;
    setBonusSaving(true);
    try {
      await fetch("/api/daily/payroll/bonus", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: bonusEditor.userId,
          periodMonth: bonusEditor.periodMonth,
          amount: bonusEditor.amount === "" ? null : bonusEditor.amount,
          note: bonusEditor.note === "" ? null : bonusEditor.note,
        }),
      });
      await fetchYear();
      setBonusEditor(null);
    } catch (e) {
      console.error("[Tabel] save bonus failed:", e);
    } finally {
      setBonusSaving(false);
    }
  };

  const clearBonus = async () => {
    if (!bonusEditor) return;
    setBonusSaving(true);
    try {
      await fetch("/api/daily/payroll/bonus", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: bonusEditor.userId,
          periodMonth: bonusEditor.periodMonth,
          amount: null,
        }),
      });
      await fetchYear();
      setBonusEditor(null);
    } catch (e) {
      console.error("[Tabel] clear bonus failed:", e);
    } finally {
      setBonusSaving(false);
    }
  };

  if (!isOpen || !mounted) return null;

  // Department total (sum of all rows' yearGrossTotal) — small footer roll-up.
  const deptTotalYear = (data?.rows ?? []).reduce((acc, r) => acc + r.yearGrossTotal, 0);

  // Per-month dept totals for the bottom strip.
  const monthDeptTotals: Record<string, number> = {};
  for (const m of data?.months ?? []) monthDeptTotals[m] = 0;
  for (const r of data?.rows ?? []) {
    for (const [m, entry] of Object.entries(r.monthly)) {
      monthDeptTotals[m] = (monthDeptTotals[m] ?? 0) + entry.grossAmount;
    }
  }

  return createPortal(
    <>
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
            <button
              onClick={() => setYear((y) => y - 1)}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
              aria-label="Предыдущий год"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <div>
              <h2 className="text-lg font-bold text-white">Табель — {getDepartment(department).label}</h2>
              <p className="text-[11px] text-slate-400">{year} год</p>
            </div>
            <button
              onClick={() => setYear((y) => y + 1)}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
              aria-label="Следующий год"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden md:block text-[11px] text-slate-400">
              Итого за год: <span className="text-emerald-400 font-bold">{fmtMoney(deptTotalYear)}</span>
            </span>
            <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="overflow-auto flex-1 p-4">
          {loading && !data ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-blue-400" />
            </div>
          ) : accessError ? (
            <div className="flex items-center justify-center py-12 text-rose-400 text-sm">
              {accessError}
            </div>
          ) : !data || data.rows.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-slate-500 text-sm">
              Нет менеджеров в отделе
            </div>
          ) : (
            <table className="border-collapse text-[11px]">
              <thead>
                <tr>
                  <th className="sticky left-0 z-10 bg-slate-900 px-3 py-2 text-left text-[10px] uppercase tracking-widest text-slate-500 font-semibold min-w-[180px]">
                    Менеджер
                  </th>
                  <th className="sticky left-[180px] z-10 bg-slate-900 px-2 py-2 text-right text-[10px] uppercase tracking-widest text-slate-500 font-semibold min-w-[110px]">
                    Ставка/день
                  </th>
                  {data.months.map((m, i) => (
                    <th key={m} className="px-2 py-2 text-right text-[10px] font-semibold text-slate-400 min-w-[80px]">
                      {MONTH_NAMES_SHORT[i]}
                    </th>
                  ))}
                  <th className="px-3 py-2 text-right text-[10px] uppercase tracking-widest text-emerald-400 font-bold min-w-[100px] border-l border-white/10">
                    Σ Год
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => {
                  const draft = rateDraft[r.userId] ?? "";
                  const noRate = !draft || Number.parseFloat(draft) === 0;
                  return (
                    <tr key={r.userId} className="border-b border-white/[0.04] hover:bg-white/[0.02]">
                      <td className="sticky left-0 z-10 bg-slate-900 px-3 py-1.5 text-slate-200 font-medium whitespace-nowrap">
                        {r.managerName}
                      </td>
                      <td className="sticky left-[180px] z-10 bg-slate-900 px-2 py-1.5">
                        <div className="flex items-center justify-end gap-1">
                          <input
                            type="number"
                            inputMode="decimal"
                            step="0.01"
                            min="0"
                            value={draft}
                            onChange={(e) => setRateDraft((prev) => ({ ...prev, [r.userId]: e.target.value }))}
                            onBlur={() => saveRate(r.userId)}
                            placeholder="0"
                            className="w-20 bg-transparent border border-white/15 rounded px-2 py-1 text-[11px] font-mono text-white focus:border-blue-500/60 focus:outline-none text-right placeholder-slate-600"
                          />
                          {savingId === r.userId && <Loader2 className="w-3 h-3 animate-spin text-blue-400" />}
                        </div>
                      </td>
                      {data.months.map((m) => {
                        const entry = r.monthly[m];
                        const gross = entry?.grossAmount ?? 0;
                        const base = entry?.baseAmount ?? 0;
                        const bonus = entry?.bonusAmount ?? 0;
                        const days = entry?.equivFullDays ?? 0;
                        const hasBonus = bonus > 0;
                        return (
                          <td
                            key={m}
                            onClick={(e) => openBonusEditor(r.userId, m, e.currentTarget)}
                            title={entry?.bonusNote ? `Премия: ${entry.bonusNote}` : "Клик — задать премию"}
                            className={`px-2 py-1.5 text-right font-mono cursor-pointer hover:bg-white/[0.04] transition-colors ${
                              gross ? "text-slate-200" : "text-slate-700"
                            } ${hasBonus ? "bg-amber-500/[0.04]" : ""}`}
                          >
                            <div className={hasBonus ? "text-emerald-400 font-semibold" : ""}>
                              {fmtMoney(gross)}
                            </div>
                            {days > 0 && (
                              <div className="text-[9px] text-slate-500">{fmtDays(days)} дн</div>
                            )}
                            {hasBonus && (
                              <div className="text-[9px] text-amber-400">
                                +{fmtMoney(bonus)} прем
                              </div>
                            )}
                          </td>
                        );
                      })}
                      <td className={`px-3 py-1.5 text-right font-mono font-bold border-l border-white/10 ${r.yearGrossTotal ? "text-emerald-400" : "text-slate-700"}`}>
                        <div>{fmtMoney(r.yearGrossTotal)}</div>
                        {r.yearEquivDaysTotal > 0 && (
                          <div className="text-[9px] text-slate-500 font-normal">{fmtDays(r.yearEquivDaysTotal)} дн</div>
                        )}
                        {noRate && r.yearEquivDaysTotal > 0 && (
                          <div className="text-[9px] text-amber-400 font-normal">нет ставки</div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-white/10 bg-slate-800/40">
                  <td colSpan={2} className="sticky left-0 z-10 bg-slate-800/80 px-3 py-2 text-right text-[10px] uppercase tracking-wider font-bold text-slate-300">
                    Итого по отделу
                  </td>
                  {data.months.map((m) => (
                    <td key={m} className="px-2 py-2 text-right font-mono text-slate-300 font-bold">
                      {fmtMoney(monthDeptTotals[m] ?? 0)}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right font-mono font-bold text-emerald-400 border-l border-white/10">
                    {fmtMoney(deptTotalYear)}
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>

        {/* Footer hint */}
        <div className="flex items-center justify-between px-6 py-3 border-t border-white/10 shrink-0 text-[10px] text-slate-500">
          <span>
            Сумма = эквивалент полных дней × ставка + премия (клик по ячейке).
            Коэффициенты: ☀ 1.0 · ◑ 0.5 · — 0.0 · 🌴 1.0 · 🚀 1.0 · 🔴 1.0
          </span>
          <span className="flex items-center gap-1 text-slate-400">
            <Save className="w-3 h-3" /> ставка по blur, премия в попапе
          </span>
        </div>
      </div>
    </div>

    {/* Bonus editor popover — rendered as a sibling of the modal so the
        backdrop click-handler doesn't close it. Anchored to the cell via
        fixed coords. */}
    {bonusEditor && (
      <div
        ref={bonusRef}
        style={bonusEditor.style}
        className="bg-slate-800 border border-white/15 rounded-xl shadow-2xl p-3 flex flex-col gap-2"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="text-[10px] uppercase tracking-widest text-slate-400 font-bold">
          Премия — {bonusEditor.periodMonth}
        </div>
        <input
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          autoFocus
          value={bonusEditor.amount}
          onChange={(e) =>
            setBonusEditor((prev) => (prev ? { ...prev, amount: e.target.value } : prev))
          }
          placeholder="Сумма"
          className="w-full bg-transparent border border-white/15 rounded px-2 py-1.5 text-[12px] font-mono text-white focus:border-blue-500/60 focus:outline-none placeholder-slate-600"
        />
        <input
          type="text"
          value={bonusEditor.note}
          onChange={(e) =>
            setBonusEditor((prev) => (prev ? { ...prev, note: e.target.value } : prev))
          }
          placeholder="Заметка (за что)"
          className="w-full bg-transparent border border-white/15 rounded px-2 py-1.5 text-[11px] text-white focus:border-blue-500/60 focus:outline-none placeholder-slate-600"
        />
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={clearBonus}
            disabled={bonusSaving}
            className="text-[10px] uppercase tracking-wider px-2 py-1 rounded text-rose-400 hover:bg-rose-500/10 transition-colors disabled:opacity-50"
          >
            Очистить
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setBonusEditor(null)}
              disabled={bonusSaving}
              className="text-[10px] uppercase tracking-wider px-2 py-1 rounded text-slate-400 hover:bg-white/5 transition-colors disabled:opacity-50"
            >
              Отмена
            </button>
            <button
              onClick={saveBonus}
              disabled={bonusSaving}
              className="flex items-center gap-1 text-[10px] uppercase tracking-wider px-3 py-1 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/30 transition-colors disabled:opacity-50 font-bold"
            >
              {bonusSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
              Сохранить
            </button>
          </div>
        </div>
      </div>
    )}
    </>,
    document.body,
  );
}
