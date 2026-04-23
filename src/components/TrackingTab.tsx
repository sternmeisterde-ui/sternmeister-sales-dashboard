"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RefreshCw, Loader2, Filter, ChevronDown, Check } from "lucide-react";
import CalendarPicker, { type DateRange } from "@/components/CalendarPicker";
import {
  EVENT_TYPES,
  EVENT_TYPE_MAP,
  DEFAULT_SELECTED_KEYS,
} from "@/lib/tracking/event-types";

// ==================== Types ====================

type SegmentType = "call" | "crm" | "idle";

interface Segment {
  type: SegmentType;
  startMin: number;
  endMin: number;
  durationMin: number;
  label?: string;
  eventCount?: number;
}

interface DayTimeline {
  date: string;
  mode: "working" | "off";
  offReason?: string;
  shiftStart?: string;
  shiftEnd?: string;
  totalMinutes: number;
  segments: Segment[];
  pct: { call: number; crm: number; idle: number };
}

interface ManagerTimeline {
  id: string;
  name: string;
  line: string | null;
  days: DayTimeline[];
}

interface TrackingResponse {
  department: string;
  dates: string[];
  managers: ManagerTimeline[];
  synced: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
}

interface TrackingTabProps {
  department: "b2g" | "b2b";
}

// ==================== Helpers ====================

function toLocalISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDateShort(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${d}.${m}`;
}

function formatLastSynced(ts: string | null): string {
  if (!ts) return "—";
  const diffSec = Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 1000));
  if (diffSec < 60) return `${diffSec} сек назад`;
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min} мин назад`;
  const h = Math.floor(min / 60);
  return `${h} ч назад`;
}

// ==================== Component ====================

export default function TrackingTab({ department }: TrackingTabProps) {
  // Date range (default today only)
  const today = useMemo(() => {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return t;
  }, []);
  const [range, setRange] = useState<DateRange>({ start: today, end: today });
  const [dateMode, setDateMode] = useState<"single" | "range">("single");

  // Event-type filter
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(
    () => new Set(DEFAULT_SELECTED_KEYS),
  );
  const [filterOpen, setFilterOpen] = useState(false);

  const [data, setData] = useState<TrackingResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(Date.now());

  // Build the query params
  const queryKey = useMemo(() => {
    const from = range.start ? toLocalISO(range.start) : null;
    const to = (range.end ?? range.start) ? toLocalISO(range.end ?? range.start!) : null;
    return { from, to, department };
  }, [range.start, range.end, department]);

  const typesParam = useMemo(() => Array.from(selectedKeys).sort().join(","), [selectedKeys]);

  const fetchData = useCallback(async () => {
    if (!queryKey.from || !queryKey.to) return;
    setLoading(true);
    setErr(null);
    try {
      const url = `/api/tracking?department=${queryKey.department}&from=${queryKey.from}&to=${queryKey.to}&types=${encodeURIComponent(typesParam)}`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`API ${res.status}: ${text}`);
      }
      const json = (await res.json()) as TrackingResponse;
      setData(json);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [queryKey.department, queryKey.from, queryKey.to, typesParam]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Auto refresh every 5 min when viewing a range including today
  useEffect(() => {
    if (!queryKey.to) return;
    const todayIso = toLocalISO(new Date());
    if (queryKey.to !== todayIso && (queryKey.from ?? "") <= todayIso && todayIso <= queryKey.to) {
      // range includes today
    } else if (queryKey.from !== todayIso && queryKey.to !== todayIso) {
      // range fully in the past — no refresh needed
      return;
    }
    const id = setInterval(fetchData, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [fetchData, queryKey.from, queryKey.to]);

  // Re-render the "last synced" relative label every 30s
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const handleClearDate = useCallback(() => {
    setRange({ start: today, end: today });
  }, [today]);

  const managers = data?.managers ?? [];
  const dates = data?.dates ?? [];

  return (
    <div className="flex flex-col gap-4">
      {/* ── Control bar ──────────────────────────────────────────── */}
      <div className="glass-panel rounded-2xl p-4 flex flex-wrap items-center gap-3 border border-white/5">
        <div className="flex bg-slate-800/60 p-0.5 rounded-lg border border-white/5">
          <button
            type="button"
            onClick={() => {
              setDateMode("single");
              setRange({ start: range.start ?? today, end: range.start ?? today });
            }}
            className={`px-2.5 py-1 text-[11px] rounded-md transition-all ${
              dateMode === "single" ? "bg-blue-500 text-white" : "text-slate-400 hover:text-white"
            }`}
          >
            День
          </button>
          <button
            type="button"
            onClick={() => setDateMode("range")}
            className={`px-2.5 py-1 text-[11px] rounded-md transition-all ${
              dateMode === "range" ? "bg-blue-500 text-white" : "text-slate-400 hover:text-white"
            }`}
          >
            Период
          </button>
        </div>

        <CalendarPicker
          mode={dateMode}
          value={range}
          onChange={setRange}
          onClear={handleClearDate}
        />

        <EventTypesFilter
          open={filterOpen}
          setOpen={setFilterOpen}
          selected={selectedKeys}
          onChange={setSelectedKeys}
        />

        <button
          type="button"
          onClick={fetchData}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-800/50 border border-white/5 hover:bg-slate-800 text-xs text-slate-300 disabled:opacity-50 transition-all"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Обновить
        </button>

        <div className="ml-auto flex items-center gap-3 text-[11px] text-slate-400">
          <LegendDot color="bg-blue-500" label="Звонок" />
          <LegendDot color="bg-emerald-500" label="CRM" />
          <LegendDot color="bg-rose-500" label="Простой" />
          {data && (
            <span className="text-slate-500" key={nowTick}>
              синк: {formatLastSynced(data.lastSyncedAt)}
            </span>
          )}
        </div>
      </div>

      {err && (
        <div className="glass-panel rounded-xl p-3 border border-rose-500/30 bg-rose-500/5 text-xs text-rose-300">
          {err}
        </div>
      )}

      {/* ── Main content ─────────────────────────────────────────── */}
      <div className="glass-panel rounded-2xl p-4 border border-white/5">
        {loading && !data ? (
          <div className="flex items-center justify-center py-16 text-slate-400">
            <Loader2 className="w-6 h-6 animate-spin" />
          </div>
        ) : managers.length === 0 ? (
          <div className="text-center py-16 text-slate-500 text-sm">Менеджеры не найдены</div>
        ) : (
          <ManagerList managers={managers} dates={dates} />
        )}
      </div>
    </div>
  );
}

// ==================== Subcomponents ====================

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`w-2.5 h-2.5 rounded-full ${color}`} />
      {label}
    </span>
  );
}

function ManagerList({ managers, dates }: { managers: ManagerTimeline[]; dates: string[] }) {
  const multiDay = dates.length > 1;
  return (
    <div className="flex flex-col gap-2">
      {managers.map((m) => (
        <div
          key={m.id}
          className="grid grid-cols-[180px_1fr] gap-3 items-start py-2 border-b border-white/5 last:border-b-0"
        >
          <div className="flex flex-col pt-1">
            <span className="text-sm font-semibold text-white truncate" title={m.name}>
              {m.name}
            </span>
            {m.line && (
              <span className="text-[10px] uppercase tracking-widest text-slate-500">
                Линия {m.line}
              </span>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            {m.days.map((day) => (
              <div
                key={day.date}
                className={`grid items-center gap-3 ${multiDay ? "grid-cols-[60px_1fr_170px]" : "grid-cols-[1fr_170px]"}`}
              >
                {multiDay && (
                  <span className="text-[11px] text-slate-500 tabular-nums">{formatDateShort(day.date)}</span>
                )}
                <TimelineBar day={day} />
                <PctSummary day={day} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function TimelineBar({ day }: { day: DayTimeline }) {
  if (day.mode === "off") {
    return (
      <div className="relative h-6 rounded-md bg-slate-700/40 border border-slate-600/30 overflow-hidden">
        <div className="absolute inset-0 flex items-center justify-center text-[10px] uppercase tracking-widest text-slate-400">
          {day.offReason ?? "Выходной"}
        </div>
      </div>
    );
  }

  const total = day.totalMinutes || 1;

  return (
    <div className="relative h-6 rounded-md bg-slate-800/60 border border-white/5 overflow-hidden flex">
      {day.segments.map((s, i) => {
        const widthPct = (s.durationMin / total) * 100;
        const bg =
          s.type === "call"
            ? "bg-blue-500"
            : s.type === "crm"
              ? "bg-emerald-500"
              : "bg-rose-500/70";
        return (
          <div
            key={`${s.type}-${s.startMin}-${i}`}
            className={`${bg} h-full relative group transition-opacity hover:opacity-80`}
            style={{ width: `${widthPct}%` }}
            title={s.label ?? ""}
          >
            <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 rounded bg-slate-900 border border-white/10 text-[11px] text-white whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-20 shadow-xl">
              {s.label}
            </div>
          </div>
        );
      })}
      <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-[9px] text-white/70 font-mono pointer-events-none">
        {day.shiftStart}
      </span>
      <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[9px] text-white/70 font-mono pointer-events-none">
        {day.shiftEnd}
      </span>
    </div>
  );
}

function PctSummary({ day }: { day: DayTimeline }) {
  if (day.mode === "off") {
    return <span className="text-[10px] text-slate-500">—</span>;
  }
  return (
    <div className="flex items-center gap-2 text-[11px] font-mono tabular-nums">
      <span className="text-blue-400">{day.pct.call}%</span>
      <span className="text-slate-600">/</span>
      <span className="text-emerald-400">{day.pct.crm}%</span>
      <span className="text-slate-600">/</span>
      <span className="text-rose-400">{day.pct.idle}%</span>
    </div>
  );
}

// ==================== Event types filter popup ====================

interface EventTypesFilterProps {
  open: boolean;
  setOpen: (v: boolean) => void;
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}

function EventTypesFilter({ open, setOpen, selected, onChange }: EventTypesFilterProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({});

  useEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setStyle({
      position: "fixed",
      top: rect.bottom + 8,
      left: rect.left,
      width: 360,
      maxHeight: "70vh",
      zIndex: 100,
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target)) return;
      const pop = document.getElementById("tracking-filter-popover");
      if (pop?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open, setOpen]);

  // Group by EventTypeDef.group
  const grouped = useMemo(() => {
    const byGroup = new Map<string, typeof EVENT_TYPES>();
    for (const def of EVENT_TYPES) {
      let arr = byGroup.get(def.group);
      if (!arr) {
        arr = [];
        byGroup.set(def.group, arr);
      }
      arr.push(def);
    }
    return Array.from(byGroup.entries());
  }, []);

  const toggle = (key: string) => {
    // Calls (incoming_call / outgoing_call) are always on — they're blue, not
    // toggleable. This filter is only for CRM/green.
    if (EVENT_TYPE_MAP[key]?.category === "call") return;
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(next);
  };

  const allCrm = EVENT_TYPES.filter((t) => t.category === "crm");
  const selectAll = () => onChange(new Set(allCrm.map((t) => t.key)));
  const selectNone = () => onChange(new Set());

  const selectedCrmCount = allCrm.filter((t) => selected.has(t.key)).length;

  const popover = open && typeof document !== "undefined" ? createPortal(
    <div
      id="tracking-filter-popover"
      style={style}
      className="rounded-xl border border-white/10 shadow-2xl overflow-hidden flex flex-col bg-slate-900"
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/5 bg-slate-950">
        <span className="text-xs font-semibold text-white">Типы событий (зелёные)</span>
        <span className="text-[11px] text-slate-400 ml-auto">
          {selectedCrmCount}/{allCrm.length}
        </span>
        <button type="button" onClick={selectAll} className="text-[11px] text-blue-400 hover:text-blue-300 px-1.5">
          Все
        </button>
        <button type="button" onClick={selectNone} className="text-[11px] text-rose-400 hover:text-rose-300 px-1.5">
          Снять
        </button>
      </div>
      <div className="overflow-y-auto flex-1 px-2 py-2">
        {grouped.map(([group, items]) => (
          <div key={group} className="mb-2">
            <div className="text-[10px] uppercase tracking-widest text-slate-500 px-1 pb-1">{group}</div>
            <div className="flex flex-col">
              {items.map((def) => {
                const isCall = def.category === "call";
                const checked = selected.has(def.key) || isCall;
                return (
                  <label
                    key={def.key}
                    className={`flex items-center gap-2 px-2 py-1 rounded-md text-xs cursor-pointer ${
                      isCall ? "opacity-70 cursor-not-allowed" : "hover:bg-white/5"
                    }`}
                    title={isCall ? "Звонки всегда синие — фильтр не применяется" : ""}
                  >
                    <span
                      className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${
                        checked
                          ? isCall
                            ? "bg-blue-500 border-blue-500"
                            : "bg-emerald-500 border-emerald-500"
                          : "border-slate-600"
                      }`}
                    >
                      {checked && <Check className="w-2.5 h-2.5 text-white" strokeWidth={3} />}
                    </span>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={isCall}
                      onChange={() => toggle(def.key)}
                      className="sr-only"
                    />
                    <span className={isCall ? "text-blue-300" : "text-slate-200"}>{def.label}</span>
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-800/50 border border-white/5 hover:bg-slate-800 text-xs text-slate-300 transition-all"
      >
        <Filter className="w-3.5 h-3.5" />
        Типы событий
        <span className="text-slate-500">{selectedCrmCount}</span>
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {popover}
    </>
  );
}
