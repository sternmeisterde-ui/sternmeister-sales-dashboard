"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RefreshCw, Loader2, Filter, ChevronDown, Check, Users, Search, X } from "lucide-react";
import CalendarPicker, { type DateRange } from "@/components/CalendarPicker";
import {
  EVENT_TYPES,
  EVENT_TYPE_MAP,
  DEFAULT_SELECTED_KEYS,
} from "@/lib/tracking/event-types";
import { fmtLocalDate, todayBerlinDate } from "@/lib/utils/date";

// ==================== Types ====================

type SegmentType = "call" | "crm" | "idle" | "wait";

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
  // `wait` is populated only by the dialer view; general leaves it undefined.
  pct: { call: number; crm: number; idle: number; wait?: number };
  minutes: { call: number; crm: number; idle: number; wait?: number };
}

interface ManagerTimeline {
  id: string;
  name: string;
  line: string | null;
  days: DayTimeline[];
}

interface ManagerOption {
  id: string;
  name: string;
  line: string | null;
}

interface TrackingResponse {
  department: string;
  view: "general";
  dates: string[];
  managers: ManagerTimeline[];
  allManagers: ManagerOption[];
  synced: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
}

// ── Dialer view (CloudTalk) ──
// Same per-manager/day timeline shape as the general view (DayTimeline with
// segments), so it renders through the shared TimelineBar. Segments are
// dialer-native: «разговор» (call) / «ожидание-дозвон» (wait) / «простой» (idle).
interface DialerResponse {
  department: string;
  view: "dialer";
  dates: string[];
  managers: ManagerTimeline[];
  allManagers: ManagerOption[];
  synced: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
}

interface TrackingTabProps {
  department: "b2g" | "b2b";
}

// ==================== Helpers ====================

// Dashboard runs in Berlin time (matches server-side GET route). The date
// the user picks in the calendar is interpreted as a Berlin-local calendar
// date — see berlinToday() below for why the "today" default can't use the
// browser's clock directly.

// Berlin civil "YYYY-MM-DD". `getFullYear/getMonth/getDate` reads BROWSER-LOCAL
// components, so a Berlin-midnight UTC instant (what CalendarPicker emits)
// resolved to the previous civil day in US-east browsers and the API got the
// wrong window with no obvious symptom. Delegate to the shared helper.
function toLocalISO(d: Date): string {
  return fmtLocalDate(d);
}

/**
 * UTC instant for 00:00 Berlin of today's Berlin civil date. Aligned with
 * CalendarPicker's emit shape so range comparisons in this tab don't mix
 * "browser-local-midnight Date with Berlin parts" against "UTC instant for
 * Berlin midnight" — they're not interchangeable across `getTime()`.
 */
function berlinToday(): Date {
  return todayBerlinDate();
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
  // Date range (default today only — Moscow's today, not the browser's)
  const today = useMemo(() => berlinToday(), []);
  const [range, setRange] = useState<DateRange>({ start: today, end: today });

  // View toggle: general call/crm/idle timeline vs CloudTalk dialer metrics.
  // Dialer telephony is B2G-only, so the toggle is shown only for b2g.
  const [view, setView] = useState<"general" | "dialer">("general");
  const isDialer = view === "dialer";

  // Event-type filter
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(
    () => new Set(DEFAULT_SELECTED_KEYS),
  );
  const [filterOpen, setFilterOpen] = useState(false);

  // Manager filter — null = "all" (no `managers=` param sent). Becomes a Set
  // when the user opens the dropdown and toggles. Reset on department switch.
  const [selectedManagerIds, setSelectedManagerIds] = useState<Set<string> | null>(null);
  const [managerFilterOpen, setManagerFilterOpen] = useState(false);

  const [data, setData] = useState<TrackingResponse | DialerResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [revalidating, setRevalidating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(Date.now());

  // Loupe modal — clicking the magnifier icon opens a deep-dive overlay
  // for one (manager, date) pair. We track the target tuple here and the
  // modal lazy-fetches /api/tracking/detail when mounted.
  const [detailTarget, setDetailTarget] = useState<{
    managerId: string;
    managerName: string;
    line: string | null;
    date: string;
  } | null>(null);

  // Reset manager filter when switching department — the manager IDs from
  // b2g aren't valid for b2b and would just show "no data" until cleared.
  useEffect(() => {
    setSelectedManagerIds(null);
    // Dialer is B2G-only — drop back to the general view when not on b2g so a
    // b2b session never sits on an empty dialer screen.
    if (department !== "b2g") setView("general");
  }, [department]);

  // Client-side cache: keyed by department+from+to+types. Switching between
  // departments or flipping filters shows cached data instantly while a fresh
  // fetch runs in the background — no full-page reload / skeleton spinner.
  const cacheRef = useRef<Map<string, TrackingResponse | DialerResponse>>(new Map());

  // Build the query params
  const queryKey = useMemo(() => {
    const from = range.start ? toLocalISO(range.start) : null;
    const to = (range.end ?? range.start) ? toLocalISO(range.end ?? range.start!) : null;
    return { from, to, department };
  }, [range.start, range.end, department]);

  const typesParam = useMemo(() => Array.from(selectedKeys).sort().join(","), [selectedKeys]);
  // Stable string for the manager filter so cache key & fetch URL are
  // deterministic. null → empty string → omit from query → "all" semantics.
  const managersParam = useMemo(
    () => (selectedManagerIds ? Array.from(selectedManagerIds).sort().join(",") : ""),
    [selectedManagerIds],
  );

  const cacheKey = useMemo(
    () => `${queryKey.department}|${queryKey.from ?? ""}|${queryKey.to ?? ""}|${typesParam}|${managersParam}|${view}`,
    [queryKey.department, queryKey.from, queryKey.to, typesParam, managersParam, view],
  );

  const fetchData = useCallback(
    async (opts?: { background?: boolean }) => {
      if (!queryKey.from || !queryKey.to) return;
      if (opts?.background) setRevalidating(true);
      else setLoading(true);
      setErr(null);
      try {
        const params = new URLSearchParams({
          department: queryKey.department,
          from: queryKey.from,
          to: queryKey.to,
          types: typesParam,
        });
        if (managersParam) params.set("managers", managersParam);
        if (view === "dialer") params.set("view", "dialer");
        const res = await fetch(`/api/tracking?${params.toString()}`, { cache: "no-store" });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`API ${res.status}: ${text}`);
        }
        const json = (await res.json()) as TrackingResponse | DialerResponse;
        cacheRef.current.set(cacheKey, json);
        setData(json);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
        setRevalidating(false);
      }
    },
    [queryKey.department, queryKey.from, queryKey.to, typesParam, managersParam, view, cacheKey],
  );

  // When inputs change: serve cached immediately if present (skeleton-free
  // department switching), then quietly revalidate in background.
  useEffect(() => {
    const cached = cacheRef.current.get(cacheKey);
    if (cached) {
      setData(cached);
      fetchData({ background: true });
    } else {
      fetchData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey]);

  // Auto refresh every 5 min when viewing a range including today
  useEffect(() => {
    if (!queryKey.to) return;
    const todayIso = toLocalISO(berlinToday());
    if (queryKey.to !== todayIso && (queryKey.from ?? "") <= todayIso && todayIso <= queryKey.to) {
      // range includes today
    } else if (queryKey.from !== todayIso && queryKey.to !== todayIso) {
      // range fully in the past — no refresh needed
      return;
    }
    const id = setInterval(() => fetchData({ background: true }), 5 * 60 * 1000);
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

  const dates = data?.dates ?? [];

  return (
    <div className="flex flex-col gap-4">
      {/* ── Control bar ──────────────────────────────────────────── */}
      <div className="glass-panel rounded-2xl p-4 flex flex-wrap items-center gap-3 border border-white/5">
        {department === "b2g" && (
          <ViewToggle view={view} onChange={setView} />
        )}

        <CalendarPicker
          mode="range"
          allowModeToggle
          value={range}
          onChange={setRange}
          onClear={handleClearDate}
        />

        {/* CRM event-type filter only applies to the general timeline. */}
        {!isDialer && (
          <EventTypesFilter
            open={filterOpen}
            setOpen={setFilterOpen}
            selected={selectedKeys}
            onChange={setSelectedKeys}
          />
        )}

        <ManagersFilter
          open={managerFilterOpen}
          setOpen={setManagerFilterOpen}
          allManagers={data?.allManagers ?? []}
          selected={selectedManagerIds}
          onChange={setSelectedManagerIds}
        />

        <button
          type="button"
          onClick={() => fetchData()}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-800/50 border border-white/5 hover:bg-slate-800 text-xs text-slate-300 disabled:opacity-50 transition-all"
        >
          {loading || revalidating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Обновить
        </button>

        <div className="ml-auto flex items-center gap-3 text-[11px] text-slate-400">
          {isDialer ? (
            <>
              <LegendDot color="bg-blue-500" label="Разговор" />
              <LegendDot color="bg-amber-500/80" label="Ожидание/дозвон" />
              <LegendDot color="bg-rose-500" label="Простой" />
            </>
          ) : (
            <>
              <LegendDot color="bg-blue-500" label="Звонок" />
              <LegendDot color="bg-emerald-500" label="CRM" />
              <LegendDot color="bg-rose-500" label="Простой" />
            </>
          )}
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
      {/* Branch on the DATA's own `view` discriminant, never on the toggle
          state: on a toggle the new cacheKey may have no cached entry, so
          `data` still holds the previous-shape response until the fetch lands.
          Rendering the wrong component against that stale shape crashed the tab
          (DialerDay has no .minutes/.segments, DayTimeline has no .talkMin).
          `data.view !== view` means we're mid-transition → show the spinner. */}
      <div className="glass-panel rounded-2xl p-4 border border-white/5">
        {!data || data.view !== view ? (
          <div className="flex items-center justify-center py-16 text-slate-400">
            <Loader2 className="w-6 h-6 animate-spin" />
          </div>
        ) : data.managers.length === 0 ? (
          <div className="text-center py-16 text-slate-500 text-sm">Менеджеры не найдены</div>
        ) : data.view === "dialer" ? (
          <DialerList
            managers={data.managers}
            dates={dates}
            onOpenDetail={(managerId, managerName, line, date) =>
              setDetailTarget({ managerId, managerName, line, date })
            }
          />
        ) : (
          <ManagerList
            managers={data.managers}
            dates={dates}
            onOpenDetail={(managerId, managerName, line, date) =>
              setDetailTarget({ managerId, managerName, line, date })
            }
          />
        )}
      </div>

      {detailTarget && (
        <DetailModal
          department={department}
          view={view}
          target={detailTarget}
          typesParam={typesParam}
          onClose={() => setDetailTarget(null)}
        />
      )}
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

// Segmented toggle: «Общая активность» ⇄ «Дайлер». Makes it unambiguous which
// view is on screen — dialer metrics never blend into the general timeline.
function ViewToggle({
  view,
  onChange,
}: {
  view: "general" | "dialer";
  onChange: (v: "general" | "dialer") => void;
}) {
  const cls = (id: "general" | "dialer") =>
    `px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
      view === id ? "bg-blue-600 text-white" : "text-slate-400 hover:text-slate-200"
    }`;
  return (
    <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-800/50 border border-white/5">
      <button type="button" onClick={() => onChange("general")} className={cls("general")}>
        Общая активность
      </button>
      <button type="button" onClick={() => onChange("dialer")} className={cls("dialer")}>
        Дайлер
      </button>
    </div>
  );
}

function ManagerList({
  managers,
  dates,
  onOpenDetail,
}: {
  managers: ManagerTimeline[];
  dates: string[];
  onOpenDetail: (managerId: string, managerName: string, line: string | null, date: string) => void;
}) {
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
                className={`grid items-center gap-3 ${multiDay ? "grid-cols-[60px_1fr_28px_230px]" : "grid-cols-[1fr_28px_230px]"}`}
              >
                {multiDay && (
                  <span className="text-[11px] text-slate-500 tabular-nums">{formatDateShort(day.date)}</span>
                )}
                <TimelineBar day={day} />
                <button
                  type="button"
                  onClick={() => onOpenDetail(m.id, m.name, m.line, day.date)}
                  className="w-6 h-6 flex items-center justify-center rounded-md bg-slate-800/40 hover:bg-slate-700 border border-white/5 text-slate-400 hover:text-white transition-colors"
                  title="Подробнее: события за день"
                  aria-label={`Подробнее по ${m.name} ${day.date}`}
                >
                  <Search className="w-3 h-3" />
                </button>
                <PctSummary day={day} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ==================== Dialer view ====================
// Reuses the general TimelineBar (same 09:00–20:00 segmented axis) — the dialer
// response is the same DayTimeline shape, with segments coloured разговор /
// ожидание-дозвон / простой. Only the side-panel summary differs (talk/wait/
// idle instead of call/crm/idle), so the loupe/detail modal is omitted here.

function DialerList({
  managers,
  dates,
  onOpenDetail,
}: {
  managers: ManagerTimeline[];
  dates: string[];
  onOpenDetail: (managerId: string, managerName: string, line: string | null, date: string) => void;
}) {
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
                className={`grid items-center gap-3 ${multiDay ? "grid-cols-[60px_1fr_28px_230px]" : "grid-cols-[1fr_28px_230px]"}`}
              >
                {multiDay && (
                  <span className="text-[11px] text-slate-500 tabular-nums">{formatDateShort(day.date)}</span>
                )}
                <TimelineBar day={day} />
                <button
                  type="button"
                  onClick={() => onOpenDetail(m.id, m.name, m.line, day.date)}
                  className="w-6 h-6 flex items-center justify-center rounded-md bg-slate-800/40 hover:bg-slate-700 border border-white/5 text-slate-400 hover:text-white transition-colors"
                  title="Подробнее: звонки за день"
                  aria-label={`Подробнее по ${m.name} ${day.date}`}
                >
                  <Search className="w-3 h-3" />
                </button>
                <DialerSummary day={day} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// Side-panel for the dialer view: разговор / ожидание / простой (mirrors
// PctSummary but with the dialer rubrics). `wait` is dialer-only.
function DialerSummary({ day }: { day: DayTimeline }) {
  if (day.mode === "off") {
    return <span className="text-[10px] text-slate-500">—</span>;
  }
  const wait = day.minutes.wait ?? 0;
  const waitPct = day.pct.wait ?? 0;
  return (
    <div className="flex flex-col items-end font-mono tabular-nums leading-tight gap-0.5">
      <div className="flex items-center gap-1.5 text-[11px]">
        <span className="text-blue-400">{day.pct.call}%</span>
        <span className="text-slate-600">/</span>
        <span className="text-amber-400">{waitPct}%</span>
        <span className="text-slate-600">/</span>
        <span className="tracking-idle">{day.pct.idle}%</span>
      </div>
      <div className="flex items-center gap-1.5 text-[11px]">
        <span className="text-blue-400">{fmtHm(day.minutes.call)}</span>
        <span className="text-slate-600">/</span>
        <span className="text-amber-400">{fmtHm(wait)}</span>
        <span className="text-slate-600">/</span>
        <span className="tracking-idle">{fmtHm(day.minutes.idle)}</span>
      </div>
    </div>
  );
}

function TimelineBar({ day }: { day: DayTimeline }) {
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);

  if (day.mode === "off") {
    return (
      <div className="relative h-6 rounded-md bg-slate-700/40 border border-slate-600/30 overflow-hidden">
        <div className="absolute inset-0 flex items-center justify-center text-[10px] uppercase tracking-widest text-slate-400">
          {day.offReason ?? "Выходной"}
        </div>
      </div>
    );
  }

  // Working day with zero activity — manager's schedule says they should
  // have been on shift but no calls and no CRM events landed. Showing this
  // as a wall of red rose-500/70 made every fully-idle day pop out and
  // overpower days with real partial idle worth flagging. Render the same
  // muted grey as scheduled-off days plus a "Нет активности" badge so the
  // distinction stays (off-day vs no-show vs partial-idle).
  const isFullyIdle =
    day.minutes.call === 0 && day.minutes.crm === 0 && (day.minutes.wait ?? 0) === 0;
  if (isFullyIdle) {
    return (
      <div className="relative h-6 rounded-md bg-slate-700/40 border border-slate-600/30 overflow-hidden">
        <div className="absolute inset-0 flex items-center justify-center text-[10px] uppercase tracking-widest text-slate-500">
          Нет активности
        </div>
      </div>
    );
  }

  const total = day.totalMinutes || 1;

  const moveTip = (e: React.MouseEvent<HTMLDivElement>, text: string) => {
    setTip({ text, x: e.clientX, y: e.clientY });
  };

  return (
    <>
      <div className="relative h-6 rounded-md bg-slate-800/60 border border-white/5 overflow-hidden flex">
        {day.segments.map((s, i) => {
          const widthPct = (s.durationMin / total) * 100;
          const bg =
            s.type === "call"
              ? "bg-blue-500"
              : s.type === "crm"
                ? "bg-emerald-500"
                : s.type === "wait"
                  ? "bg-amber-500/80"
                  : "bg-rose-500/70";
          const text = s.label ?? "";
          return (
            <div
              key={`${s.type}-${s.startMin}-${i}`}
              className={`${bg} h-full transition-opacity hover:opacity-80 cursor-pointer`}
              style={{ width: `${widthPct}%` }}
              onMouseEnter={(e) => moveTip(e, text)}
              onMouseMove={(e) => moveTip(e, text)}
              onMouseLeave={() => setTip(null)}
              title={text}
            />
          );
        })}
        <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-[9px] text-white/70 font-mono pointer-events-none">
          {day.shiftStart}
        </span>
        <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[9px] text-white/70 font-mono pointer-events-none">
          {day.shiftEnd}
        </span>
      </div>
      {tip && typeof document !== "undefined" && createPortal(
        <div
          style={{
            position: "fixed",
            top: tip.y - 34,
            left: tip.x,
            transform: "translateX(-50%)",
            pointerEvents: "none",
            zIndex: 1000,
          }}
          className="px-2 py-1 rounded bg-slate-900 border border-white/10 text-[11px] text-white whitespace-nowrap shadow-xl"
        >
          {tip.text}
        </div>,
        document.body,
      )}
    </>
  );
}

function fmtHm(mins: number): string {
  const safe = Math.max(0, Math.round(mins));
  const h = Math.floor(safe / 60);
  const m = safe % 60;
  return `${h}ч ${m}м`;
}

function PctSummary({ day }: { day: DayTimeline }) {
  if (day.mode === "off") {
    return <span className="text-[10px] text-slate-500">—</span>;
  }
  return (
    <div className="flex flex-col items-end font-mono tabular-nums leading-tight gap-0.5">
      <div className="flex items-center gap-1.5 text-[11px]">
        <span className="tracking-call">{day.pct.call}%</span>
        <span className="text-slate-600">/</span>
        <span className="tracking-crm">{day.pct.crm}%</span>
        <span className="text-slate-600">/</span>
        <span className="tracking-idle">{day.pct.idle}%</span>
      </div>
      <div className="flex items-center gap-1.5 text-[11px]">
        <span className="tracking-call">{fmtHm(day.minutes.call)}</span>
        <span className="text-slate-600">/</span>
        <span className="tracking-crm">{fmtHm(day.minutes.crm)}</span>
        <span className="text-slate-600">/</span>
        <span className="tracking-idle">{fmtHm(day.minutes.idle)}</span>
      </div>
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

// ==================== Managers filter popup ====================

interface ManagersFilterProps {
  open: boolean;
  setOpen: (v: boolean) => void;
  allManagers: ManagerOption[];
  /** null = "all" (no filter applied). Set with subset = filter active. */
  selected: Set<string> | null;
  onChange: (next: Set<string> | null) => void;
}

function ManagersFilter({ open, setOpen, allManagers, selected, onChange }: ManagersFilterProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({});

  useEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setStyle({
      position: "fixed",
      top: rect.bottom + 8,
      left: rect.left,
      width: 280,
      maxHeight: "70vh",
      zIndex: 100,
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target)) return;
      const pop = document.getElementById("tracking-managers-popover");
      if (pop?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open, setOpen]);

  // Group managers by line — same convention as the main list (line "1"/"2"/"3")
  const grouped = useMemo(() => {
    const byLine = new Map<string, ManagerOption[]>();
    for (const m of allManagers) {
      const k = m.line ? `Линия ${m.line}` : "Без линии";
      let arr = byLine.get(k);
      if (!arr) { arr = []; byLine.set(k, arr); }
      arr.push(m);
    }
    return Array.from(byLine.entries());
  }, [allManagers]);

  const isAllSelected = selected === null;
  const selectedCount = selected ? selected.size : allManagers.length;

  const toggleOne = (id: string) => {
    // First click after "all" → start with all minus the one being unticked.
    const base = selected ?? new Set(allManagers.map((m) => m.id));
    const next = new Set(base);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    // If user selected literally everyone, collapse back to null ("all") so
    // the param is omitted and cache key matches the default state.
    if (next.size === allManagers.length) onChange(null);
    else onChange(next);
  };

  const selectAll = () => onChange(null);
  const selectNone = () => onChange(new Set());

  const buttonLabel = isAllSelected
    ? `Все (${allManagers.length})`
    : selected!.size === 0
      ? "никто"
      : `${selected!.size}/${allManagers.length}`;

  const popover = open && typeof document !== "undefined" ? createPortal(
    <div
      id="tracking-managers-popover"
      style={style}
      className="rounded-xl border border-white/10 shadow-2xl overflow-hidden flex flex-col bg-slate-900"
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/5 bg-slate-950">
        <span className="text-xs font-semibold text-white">Менеджеры</span>
        <span className="text-[11px] text-slate-400 ml-auto">
          {selectedCount}/{allManagers.length}
        </span>
        <button type="button" onClick={selectAll} className="text-[11px] text-blue-400 hover:text-blue-300 px-1.5">
          Все
        </button>
        <button type="button" onClick={selectNone} className="text-[11px] text-rose-400 hover:text-rose-300 px-1.5">
          Снять
        </button>
      </div>
      <div className="overflow-y-auto flex-1 px-2 py-2">
        {allManagers.length === 0 ? (
          <div className="text-[11px] text-slate-500 px-2 py-4 text-center">Загрузка…</div>
        ) : grouped.map(([groupName, items]) => (
          <div key={groupName} className="mb-2">
            <div className="text-[10px] uppercase tracking-widest text-slate-500 px-1 pb-1">{groupName}</div>
            <div className="flex flex-col">
              {items.map((m) => {
                const checked = isAllSelected || (selected?.has(m.id) ?? false);
                return (
                  <label
                    key={m.id}
                    className="flex items-center gap-2 px-2 py-1 rounded-md text-xs cursor-pointer hover:bg-white/5"
                  >
                    <span
                      className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${
                        checked ? "bg-blue-500 border-blue-500" : "border-slate-600"
                      }`}
                    >
                      {checked && <Check className="w-2.5 h-2.5 text-white" strokeWidth={3} />}
                    </span>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleOne(m.id)}
                      className="sr-only"
                    />
                    <span className="text-slate-200 truncate">{m.name}</span>
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
        <Users className="w-3.5 h-3.5" />
        Менеджеры
        <span className="text-slate-500">{buttonLabel}</span>
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {popover}
    </>
  );
}

// ==================== Detail modal (loupe) ====================

interface DetailEvent {
  eventId: string;
  eventType: string;
  label: string;
  group: string;
  createdAt: string;
  timeBerlin: string;
  durationSec: number;
  entityType: string | null;
  entityId: number | null;
  raw: Record<string, unknown> | null;
}

interface DetailResponse {
  department: string;
  manager: { id: string; name: string; line: string | null };
  date: string;
  timeline: DayTimeline;
  events: DetailEvent[];
}

function DetailModal({
  department,
  view,
  target,
  typesParam,
  onClose,
}: {
  department: "b2g" | "b2b";
  view: "general" | "dialer";
  target: { managerId: string; managerName: string; line: string | null; date: string };
  typesParam: string;
  onClose: () => void;
}) {
  const isDialer = view === "dialer";
  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [hoverSeg, setHoverSeg] = useState<Segment | null>(null);

  // Lazy-load detail when modal mounts
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    const params = new URLSearchParams({
      department,
      managerId: target.managerId,
      date: target.date,
      types: typesParam,
    });
    if (view === "dialer") params.set("view", "dialer");
    fetch(`/api/tracking/detail?${params.toString()}`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
        return res.json();
      })
      .then((json: DetailResponse) => {
        if (!cancelled) setData(json);
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [department, view, target.managerId, target.date, typesParam]);

  // Esc to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  if (typeof document === "undefined") return null;

  const timeline = data?.timeline;
  const events = data?.events ?? [];

  // Bucket events by which timeline segment they fall into. Time-based —
  // converts each event's Berlin timeBerlin to minutes-from-shift-start
  // and matches against [segment.startMin, segment.endMin).
  const eventsBySegment = (() => {
    if (!timeline || timeline.mode !== "working") return new Map<number, DetailEvent[]>();
    const map = new Map<number, DetailEvent[]>();
    const shiftStartMin = parseShiftMin(timeline.shiftStart ?? "09:00");
    for (const ev of events) {
      const evMin = parseShiftMin(ev.timeBerlin) - shiftStartMin;
      const seg = timeline.segments.find(
        (s) => evMin >= s.startMin && evMin < s.endMin,
      );
      if (!seg) continue;
      const list = map.get(seg.startMin) ?? [];
      list.push(ev);
      map.set(seg.startMin, list);
    }
    return map;
  })();

  const segEvents = hoverSeg ? eventsBySegment.get(hoverSeg.startMin) ?? [] : [];

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-12 px-4 bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-5xl max-h-[85vh] overflow-y-auto rounded-2xl bg-slate-900 border border-white/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-white/5 bg-slate-950/50 sticky top-0 z-10">
          <Search className="w-4 h-4 text-slate-400" />
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-white">{target.managerName}</span>
            <span className="text-[11px] text-slate-500">
              {target.line ? `Линия ${target.line} · ` : ""}
              {formatRussianDate(target.date)}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto w-7 h-7 flex items-center justify-center rounded-md bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
            aria-label="Закрыть"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-slate-400">
              <Loader2 className="w-6 h-6 animate-spin" />
            </div>
          ) : err ? (
            <div className="text-rose-300 text-sm">{err}</div>
          ) : !timeline || timeline.mode === "off" ? (
            <div className="text-center py-16 text-slate-400 text-sm">
              {timeline?.offReason ?? "Нет расписания"}
            </div>
          ) : (
            <>
              <DetailTimelineBar timeline={timeline} onHover={setHoverSeg} />

              <HourGrid
                shiftStart={timeline.shiftStart!}
                shiftEnd={timeline.shiftEnd!}
                totalMinutes={timeline.totalMinutes}
              />

              <div className="mt-4 grid grid-cols-3 gap-3">
                {isDialer ? (
                  <>
                    <StatTile color="bg-blue-500" label="Разговор" minutes={timeline.minutes.call} pct={timeline.pct.call} />
                    <StatTile color="bg-amber-500/80" label="Ожидание/дозвон" minutes={timeline.minutes.wait ?? 0} pct={timeline.pct.wait ?? 0} />
                    <StatTile color="bg-rose-500/70" label="Простой" minutes={timeline.minutes.idle} pct={timeline.pct.idle} />
                  </>
                ) : (
                  <>
                    <StatTile color="bg-blue-500" label="На звонках" minutes={timeline.minutes.call} pct={timeline.pct.call} />
                    <StatTile color="bg-emerald-500" label="В CRM" minutes={timeline.minutes.crm} pct={timeline.pct.crm} />
                    <StatTile color="bg-rose-500/70" label="Простой" minutes={timeline.minutes.idle} pct={timeline.pct.idle} />
                  </>
                )}
              </div>

              {hoverSeg ? (
                <SegmentEventList
                  seg={hoverSeg}
                  events={segEvents}
                  shiftStart={timeline.shiftStart!}
                />
              ) : (
                <FullEventList events={events} />
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function parseShiftMin(hm: string): number {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
}

function formatRussianDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

function formatSegmentTime(shiftStart: string, offsetMin: number): string {
  const startMin = parseShiftMin(shiftStart) + offsetMin;
  const h = Math.floor(startMin / 60);
  const m = startMin % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function DetailTimelineBar({
  timeline,
  onHover,
}: {
  timeline: DayTimeline;
  onHover: (seg: Segment | null) => void;
}) {
  const total = timeline.totalMinutes || 1;
  return (
    <div className="relative h-12 rounded-lg bg-slate-800/60 border border-white/5 overflow-hidden flex">
      {timeline.segments.map((s, i) => {
        const widthPct = (s.durationMin / total) * 100;
        const bg =
          s.type === "call"
            ? "bg-blue-500"
            : s.type === "crm"
              ? "bg-emerald-500"
              : s.type === "wait"
                ? "bg-amber-500/80"
                : "bg-rose-500/70";
        return (
          <div
            key={`${s.type}-${s.startMin}-${i}`}
            className={`${bg} h-full transition-opacity hover:opacity-80 cursor-pointer`}
            style={{ width: `${widthPct}%` }}
            onMouseEnter={() => onHover(s)}
            onMouseLeave={() => onHover(null)}
            title={s.label ?? ""}
          />
        );
      })}
      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] text-white/70 font-mono pointer-events-none">
        {timeline.shiftStart}
      </span>
      <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-white/70 font-mono pointer-events-none">
        {timeline.shiftEnd}
      </span>
    </div>
  );
}

function HourGrid({
  shiftStart,
  shiftEnd,
  totalMinutes,
}: {
  shiftStart: string;
  shiftEnd: string;
  totalMinutes: number;
}) {
  const startH = Number(shiftStart.split(":")[0]);
  const endH = Number(shiftEnd.split(":")[0]);
  const hours: number[] = [];
  for (let h = startH; h <= endH; h++) hours.push(h);
  return (
    <div className="relative mt-1.5 h-3">
      {hours.map((h) => {
        const offsetMin = (h - startH) * 60;
        const leftPct = (offsetMin / totalMinutes) * 100;
        return (
          <span
            key={h}
            className="absolute text-[10px] text-slate-500 font-mono -translate-x-1/2"
            style={{ left: `${leftPct}%` }}
          >
            {String(h).padStart(2, "0")}
          </span>
        );
      })}
    </div>
  );
}

function StatTile({
  color,
  label,
  minutes,
  pct,
}: {
  color: string;
  label: string;
  minutes: number;
  pct: number;
}) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return (
    <div className="rounded-lg bg-slate-800/40 border border-white/5 px-3 py-2">
      <div className="flex items-center gap-1.5 mb-1">
        <span className={`w-2 h-2 rounded-full ${color}`} />
        <span className="text-[11px] text-slate-400">{label}</span>
      </div>
      <div className="font-mono tabular-nums">
        <span className="text-base text-white">{h}ч {m}м</span>
        <span className="text-[11px] text-slate-500 ml-1.5">{pct}%</span>
      </div>
    </div>
  );
}

function SegmentEventList({
  seg,
  events,
  shiftStart,
}: {
  seg: Segment;
  events: DetailEvent[];
  shiftStart: string;
}) {
  const segStart = formatSegmentTime(shiftStart, seg.startMin);
  const segEnd = formatSegmentTime(shiftStart, seg.endMin);
  return (
    <div className="mt-4 rounded-lg bg-slate-800/30 border border-white/5 p-3">
      <div className="text-[11px] uppercase tracking-widest text-slate-400 mb-2">
        {seg.type === "call" ? "Звонок" : seg.type === "crm" ? "Работа в CRM" : seg.type === "wait" ? "Ожидание/дозвон" : "Простой"}
        <span className="text-slate-500 normal-case tracking-normal ml-2 font-mono">
          {segStart}–{segEnd}
        </span>
        <span className="text-slate-500 normal-case tracking-normal ml-2">
          {events.length} {events.length === 1 ? "событие" : events.length < 5 ? "события" : "событий"}
        </span>
      </div>
      {events.length === 0 ? (
        <div className="text-xs text-slate-500 py-2">{seg.type === "idle" ? "Без активности" : "Нет деталей"}</div>
      ) : (
        <ul className="flex flex-col divide-y divide-white/5 max-h-72 overflow-y-auto">
          {events.map((ev) => (
            <EventRow key={ev.eventId} ev={ev} />
          ))}
        </ul>
      )}
    </div>
  );
}

function FullEventList({ events }: { events: DetailEvent[] }) {
  return (
    <div className="mt-4 rounded-lg bg-slate-800/30 border border-white/5 p-3">
      <div className="text-[11px] uppercase tracking-widest text-slate-400 mb-2">
        Все события за день · {events.length}
        <span className="text-slate-500 normal-case tracking-normal ml-2">
          (наведи на отрезок чтобы отфильтровать)
        </span>
      </div>
      {events.length === 0 ? (
        <div className="text-xs text-slate-500 py-2">Нет событий</div>
      ) : (
        <ul className="flex flex-col divide-y divide-white/5 max-h-96 overflow-y-auto">
          {events.map((ev) => (
            <EventRow key={ev.eventId} ev={ev} />
          ))}
        </ul>
      )}
    </div>
  );
}

function EventRow({ ev }: { ev: DetailEvent }) {
  const isCall = ev.eventType === "incoming_call" || ev.eventType === "outgoing_call";
  const isMissed = isCall && ev.durationSec === 0;
  const dotColor = isCall
    ? isMissed
      ? "bg-rose-500/60"
      : "bg-blue-500"
    : "bg-emerald-500";

  // Dialer detail rows carry waiting_time in raw.waitSec; presence of the field
  // marks a dialer call, where we label the talk duration explicitly («разговор»)
  // and the ring/queue time («дозвон») so the two numbers can't be confused.
  const waitSec = (ev.raw as { waitSec?: number } | null)?.waitSec;
  const isDialerCall = typeof waitSec === "number";

  let suffix = "";
  if (isCall) {
    if (isMissed) {
      suffix = isDialerCall ? " · недозвон" : " · пропущенный";
    } else {
      const talkLabel = isDialerCall ? "разговор " : "";
      suffix =
        ev.durationSec >= 60
          ? ` · ${talkLabel}${Math.round(ev.durationSec / 60)} мин`
          : ` · ${talkLabel}${ev.durationSec} сек`;
    }
    if (isDialerCall && waitSec! > 0) suffix += ` · дозвон ${waitSec} сек`;
    const phone = (ev.raw as { phone?: string } | null)?.phone;
    if (phone) suffix += ` · ${phone}`;
  }

  return (
    <li className="flex items-baseline gap-2 py-1.5 text-xs">
      <span className="text-slate-500 font-mono tabular-nums w-12 shrink-0">{ev.timeBerlin}</span>
      <span className={`w-1.5 h-1.5 rounded-full ${dotColor} mt-1 shrink-0`} />
      <span className="text-slate-200 truncate">
        {ev.label}
        {suffix && <span className="text-slate-500">{suffix}</span>}
      </span>
      <span className="ml-auto text-[10px] text-slate-600 shrink-0">{ev.group}</span>
    </li>
  );
}
