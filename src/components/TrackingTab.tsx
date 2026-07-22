"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RefreshCw, Loader2, Filter, ChevronDown, Check, Users, Search, X, Clock, Info } from "lucide-react";
import CalendarPicker, { type DateRange } from "@/components/CalendarPicker";
import {
  EVENT_TYPES,
  EVENT_TYPE_MAP,
  DEFAULT_SELECTED_KEYS,
} from "@/lib/tracking/event-types";
import { fmtLocalDate, todayBerlinDate } from "@/lib/utils/date";

// ==================== Types ====================

type SegmentType =
  | "call" | "crm" | "idle" | "dialer" | "manual"
  | "lunch" | "meeting" | "dayend";

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
  // `dialer`/`manual` are populated only by the dialer view; general leaves
  // them undefined. `dialer` = time in dialer-campaign calls, `manual` = time
  // in CloudTalk calls outside the dialer; `idle` there = no calls.
  // `talk` — general view: чистое время в диалоге (call там = в телефоне,
  // т.е. разговор + дозвон исходящих; для b2b совпадает с talk).
  // `lunch`/`meeting` — минуты ручных статусов (b2g).
  pct: { call: number; crm: number; idle: number; dialer?: number; manual?: number };
  minutes: {
    call: number; crm: number; idle: number;
    talk?: number; lunch?: number; meeting?: number;
    dialer?: number; manual?: number;
  };
  // Dialer view only: per-channel call counts for the day.
  counts?: { dialer: number; manual: number };
}

interface ManagerTimeline {
  id: string;
  name: string;
  line: string | null;
  // CallGear-only менеджер: его звонки приходят с задержкой ~7ч (эмбарго
  // CallGear API) — показываем пометку, чтобы не выглядело багом.
  callgearDelayed?: boolean;
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
// segments), so it renders through the shared TimelineBar. Segments mark
// CloudTalk call events by attribution channel: «в дайлере» (dialer, green) /
// «вне дайлера» (manual, red) / «без звонков» (idle, gray).
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

  // Ручные статусы (b2g): кто мы (manager self / admin) и активный статус.
  // Managers получают плашку «Мой статус», админ — ретро-правку в модалке.
  const [statusInfo, setStatusInfo] = useState<StatusInfoDto | null>(null);
  useEffect(() => {
    if (department !== "b2g") return;
    let cancelled = false;
    fetch(`/api/tracking/status?department=b2g`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: StatusInfoDto | null) => {
        if (!cancelled && j) setStatusInfo(j);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [department]);

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
      {/* ── Плашка «Мой статус» — только менеджерская сессия b2g. ── */}
      {department === "b2g" && statusInfo?.self && (
        <MyStatusBar
          active={statusInfo.active}
          onChanged={(active) => {
            setStatusInfo((prev) => (prev ? { ...prev, active } : prev));
            fetchData({ background: true });
          }}
        />
      )}

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
              <span
                className="px-1.5 py-0.5 rounded bg-sky-500/10 border border-sky-500/30 text-sky-300 text-[10px] font-semibold uppercase tracking-wider"
                title="Раздел построен на данных телефонии CloudTalk: каждый звонок сверен с историей кампаний дайлера"
              >
                CloudTalk
              </span>
              <LegendDot color="bg-emerald-500" label="В дайлере" />
              <LegendDot color="bg-rose-500" label="Вне дайлера" />
              <LegendDot color="bg-slate-600" label="Без звонков в CloudTalk" />
            </>
          ) : (
            <>
              <LegendDot color="bg-blue-500" label="Телефон" />
              <LegendDot color="bg-emerald-500" label="CRM" />
              {department === "b2g" && (
                <>
                  <LegendDot color="bg-yellow-400/80" label="Обед" />
                  <LegendDot color="bg-violet-500/80" label="Встреча" />
                </>
              )}
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

      {/* Инфо-блок для не-технических пользователей (общий вид). */}
      {!isDialer && data && data.managers.length > 0 && (
        <div className="glass-panel rounded-2xl border border-white/5 p-4 mt-4 text-[12px] text-slate-400 leading-relaxed">
          <div className="flex items-center gap-2 mb-2.5 text-slate-300 font-semibold">
            <Info className="w-4 h-4 text-blue-400 shrink-0" /> Как читать эту вкладку
          </div>
          <ul className="flex flex-col gap-2">
            <li>
              <b className="text-slate-300">Полоска дня</b> — рабочий день менеджера с 09:00 до 20:00 (или шире, если он звонил/работал раньше или позже).{" "}
              <span className="text-blue-400 font-semibold">Синий</span> — время в телефоне,{" "}
              <span className="text-emerald-400 font-semibold">зелёный</span> — работа в CRM,{" "}
              <span className="text-rose-400 font-semibold">красный</span> — простой.
            </li>
            {department === "b2g" && (
              <li>
                <b className="text-slate-300">«В телефоне» и «в диалоге».</b> В синее время входит и дозвон: набор номера и гудки по исходящим — это тоже работа, в том числе когда клиент не взял трубку. Чистое время разговора показано отдельно строкой «в диалоге».
              </li>
            )}
            {department === "b2g" && (
              <li>
                <b className="text-slate-300">Статусы менеджера.</b> Менеджер отмечает в шапке вкладки: <span className="text-yellow-400 font-semibold">обед</span> (не считается простоем до 60 мин/день), <span className="text-violet-400 font-semibold">встреча</span> (рабочее время) и «завершил день». Статус ставится только в моменте; задним числом интервалы правит админ через лупу дня.
              </li>
            )}
            <li>
              <b className="text-slate-300">Простой</b> считается от нормы 8 рабочих часов: 8 часов минус время активности (звонки + работа в CRM).
            </li>
            <li>
              <b className="text-slate-300">Обновление данных.</b> Вкладка сама обновляется примерно раз в 5 минут. Звонки попадают сюда из телефонии не мгновенно: по CloudTalk — обычно в течение ~10 минут после звонка.
            </li>
            <li>
              <b className="text-slate-300">Пометка «CallGear · ~7ч».</b> У части менеджеров звонки идут через CallGear, и их данные приходят с задержкой около 7 часов. Это ограничение самого сервиса CallGear, а не ошибка: если менеджер позвонил сейчас, звонок появится в отчёте через несколько часов.
            </li>
          </ul>
        </div>
      )}

      {/* Сводная таблица общего вида — пофамильные итоги за период. */}
      {!isDialer && data?.view === "general" && data.managers.length > 0 && (
        <GeneralSummaryTable managers={data.managers} department={department} />
      )}

      {/* Касания по лидам (Новый лид / Недозвон): этапы — на конец выбранного
          периода (прошлые даты реконструируются по истории), касания —
          накопительно + за период, разбивка в дайлере / вне дайлера. */}
      {isDialer && data?.view === "dialer" && dates.length > 0 && (
        <DialerLeadTouchesPanel
          department={department}
          fromISO={dates[0]}
          toISO={dates[dates.length - 1]}
        />
      )}

      {/* Инфо-блок для дайлер-вида: что значат цвета и откуда данные. */}
      {isDialer && data && data.managers.length > 0 && (
        <div className="glass-panel rounded-2xl border border-white/5 p-4 mt-4 text-[12px] text-slate-400 leading-relaxed">
          <div className="flex items-center gap-2 mb-2.5 text-slate-300 font-semibold">
            <Info className="w-4 h-4 text-sky-400 shrink-0" /> Как читать этот раздел
          </div>
          <ul className="flex flex-col gap-2">
            <li>
              <b className="text-slate-300">Полоска дня</b> — звонки менеджера в CloudTalk с 09:00 до 20:00.{" "}
              <span className="text-emerald-400 font-semibold">Зелёный</span> — звонок из дайлера (кампании автообзвона),{" "}
              <span className="text-rose-400 font-semibold">красный</span> — звонок вне дайлера (ручной набор или входящий),{" "}
              серый — без звонков в CloudTalk.
            </li>
            <li>
              <b className="text-slate-300">Источник — телефония CloudTalk.</b> Каждый исходящий звонок сверяется с историей кампаний дайлера в CloudTalk, поэтому «в дайлере / вне дайлера» — точная привязка, а не оценка по косвенным признакам. Привязка ведётся с 1 июля 2026 — более ранние дни целиком показываются как «вне дайлера».
            </li>
            <li>
              <b className="text-slate-300">Входящие звонки</b> всегда относятся к «вне дайлера»: дайлер делает только исходящие.
            </li>
            <li>
              <b className="text-slate-300">Менеджеры.</b> В разделе показана только 1-я линия — дайлер обзванивает именно её базу.
            </li>
          </ul>
        </div>
      )}

      {detailTarget && (
        <DetailModal
          department={department}
          view={view}
          target={detailTarget}
          typesParam={typesParam}
          canEditStatuses={department === "b2g" && statusInfo?.role === "admin"}
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
            {m.callgearDelayed && (
              <span
                className="mt-0.5 inline-flex w-fit items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider bg-amber-500/15 text-amber-400"
                title="CallGear отдаёт данные о звонках с задержкой ~7 часов (эмбарго их API) — это ожидаемо, не баг. CloudTalk обновляется за ~10 минут."
              >
                <Clock className="w-2.5 h-2.5" /> CallGear · ~7ч
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
// response is the same DayTimeline shape, with segments coloured green
// («в дайлере» — dialer-campaign calls) / red («вне дайлера» — CloudTalk calls
// outside the dialer) / gray (no calls). Channel is per-call ground truth from
// analytics.dialer_call_attribution, not a heuristic.

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
            {m.callgearDelayed && (
              <span
                className="mt-0.5 inline-flex w-fit items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider bg-amber-500/15 text-amber-400"
                title="CallGear отдаёт данные о звонках с задержкой ~7 часов (эмбарго их API) — это ожидаемо, не баг. CloudTalk обновляется за ~10 минут."
              >
                <Clock className="w-2.5 h-2.5" /> CallGear · ~7ч
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
                <TimelineBar day={day} dialerView />
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

// Side-panel for the dialer view: time + call count per channel. «В дайлере»
// (green) = dialer-campaign calls, «Вне дайлера» (red) = CloudTalk calls
// outside the dialer. Times are in-call time (ring + talk) within the shift.
function DialerSummary({ day }: { day: DayTimeline }) {
  if (day.mode === "off") {
    return <span className="text-[10px] text-slate-500">—</span>;
  }
  const dialer = day.minutes.dialer ?? 0;
  const manual = day.minutes.manual ?? 0;
  const nDialer = day.counts?.dialer ?? 0;
  const nManual = day.counts?.manual ?? 0;
  // No calls at all → the bar already says «Без звонков»; a column of zeros
  // here would just add noise.
  if (nDialer + nManual === 0) {
    return <span className="text-[10px] text-slate-500">—</span>;
  }
  return (
    <div className="flex flex-col items-end font-mono tabular-nums leading-tight gap-0.5">
      <div className="flex items-center gap-1.5 text-[11px]">
        <span className="text-emerald-400">В дайлере {fmtHm(dialer)}</span>
        <span className="text-slate-500">{nDialer} зв.</span>
      </div>
      <div className="flex items-center gap-1.5 text-[11px]">
        <span className="text-rose-400">Вне дайлера {fmtHm(manual)}</span>
        <span className="text-slate-500">{nManual} зв.</span>
      </div>
    </div>
  );
}

// ── Касания по лидам (дайлер-вид) ──
// Leads that were on Новый лид / Недозвон of Бух Гос as of the end of the
// selected period (today → live mirror; past dates → reconstructed from
// lead_status_changes intervals), with call touches split в дайлере / вне
// дайлера — cumulative to that date and within the period.
// Data: /api/tracking/dialer-leads.

interface DialerLeadTouchRowDto {
  leadId: number;
  statusId: number;
  contactName: string | null;
  manager: string | null;
  leadCreatedAt: string | null;
  dialerTouches: number;
  manualTouches: number;
  periodDialerTouches: number;
  periodManualTouches: number;
  lastTouchAt: string | null;
  callers: Array<{ name: string; n: number }>;
}

const NEW_LEAD_STATUS_ID = 83873491; // FIRST_LINE_STATUSES.NEW_LEAD (Бух Гос)
const KOMMO_LEADS_BASE = "https://sternmeister.kommo.com/leads/detail";

// ── Ручные статусы менеджеров (b2g) ──
interface StatusIntervalDto {
  id: number;
  status: string; // 'lunch' | 'meeting' | 'day_end'
  startedAt: string;
  endedAt: string | null;
  createdBy?: string | null;
}
interface StatusInfoDto {
  role: string | null;
  self: { managerId: string; name: string } | null;
  active: StatusIntervalDto | null;
}
const STATUS_LABELS: Record<string, string> = {
  lunch: "Обед",
  meeting: "Встреча",
  day_end: "Завершил день",
};

// Per-campaign dialer stats (analytics.dialer_call_attribution, точная привязка).
interface DialerCampaignDto {
  campaignId: number | null;
  campaignName: string;
  calls: number;
  answered: number;
  talkSec: number;
  avgTalkSec: number;
}

function fmtBerlinDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("ru-RU", {
    timeZone: "Europe/Berlin",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function DialerLeadTouchesPanel({
  department,
  fromISO,
  toISO,
}: {
  department: "b2g" | "b2b";
  fromISO: string;
  toISO: string;
}) {
  const [rows, setRows] = useState<DialerLeadTouchRowDto[] | null>(null);
  const [campaigns, setCampaigns] = useState<DialerCampaignDto[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // NB: no synchronous setState here (react-hooks/set-state-in-effect) — on a
  // date change the previous table stays visible until the new fetch lands.
  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ department, from: fromISO, to: toISO });
    fetch(`/api/tracking/dialer-leads?${params.toString()}`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
        return res.json();
      })
      .then((json: { leads: DialerLeadTouchRowDto[]; campaigns?: DialerCampaignDto[] }) => {
        if (cancelled) return;
        setRows(json.leads);
        setCampaigns(json.campaigns ?? []);
        setErr(null);
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [department, fromISO, toISO]);

  const nNew = rows?.filter((r) => r.statusId === NEW_LEAD_STATUS_ID).length ?? 0;
  const nNoAnswer = (rows?.length ?? 0) - nNew;
  const periodDialerSum = rows?.reduce((s, r) => s + r.periodDialerTouches, 0) ?? 0;
  const periodManualSum = rows?.reduce((s, r) => s + r.periodManualTouches, 0) ?? 0;
  const isCurrent = toISO >= toLocalISO(berlinToday());
  const periodLabel =
    fromISO === toISO ? formatRussianDate(fromISO) : `${formatRussianDate(fromISO)} — ${formatRussianDate(toISO)}`;

  return (
    <>
      {/* Кампании дайлера за период — точные метрики из истории кампаний CloudTalk. */}
      {campaigns && campaigns.length > 0 && (
        <div className="glass-panel rounded-2xl border border-white/5 p-4 mt-4">
          <div className="flex items-baseline gap-2 mb-3">
            <span className="text-sm font-semibold text-white">Кампании дайлера</span>
            <span className="text-[11px] text-slate-500">за период {periodLabel} · CloudTalk</span>
          </div>
          <div className="grid gap-2 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
            {campaigns.map((c) => {
              const pctAnswered = c.calls > 0 ? Math.round((c.answered / c.calls) * 100) : 0;
              return (
                <div key={`${c.campaignId ?? c.campaignName}`} className="rounded-lg bg-slate-800/40 border border-white/5 px-3 py-2">
                  <div className="text-[11px] text-slate-300 font-semibold truncate" title={c.campaignName}>
                    {c.campaignName}
                  </div>
                  <div className="mt-1 font-mono tabular-nums text-[12px] text-white">
                    {c.calls} зв. · <span className="text-emerald-400">дозвон {c.answered}</span>
                    <span className="text-slate-500"> ({pctAnswered}%)</span>
                  </div>
                  <div className="text-[10px] text-slate-500 font-mono tabular-nums">
                    разговор {fmtHm(Math.round(c.talkSec / 60))} · средний {c.avgTalkSec} сек
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

    <div className="glass-panel rounded-2xl border border-white/5 p-4 mt-4">
      <div className="flex items-baseline gap-2 mb-1 flex-wrap">
        <span className="text-sm font-semibold text-white">Касания по лидам</span>
        <span className="text-[11px] text-slate-500">
          «Новый лид» и «Недозвон» (Бух Гос) · этапы {isCurrent ? "на сейчас" : `на конец ${formatRussianDate(toISO)}`} · касания накопительно до этой даты
        </span>
        {rows && (
          <span className="ml-auto text-[11px] text-slate-400 font-mono tabular-nums">
            Новый лид {nNew} · Недозвон {nNoAnswer}
          </span>
        )}
      </div>
      {rows && (
        <div className="text-[11px] text-slate-400 mb-3">
          Касаний за период ({periodLabel}):{" "}
          <span className="font-mono tabular-nums text-slate-200">{periodDialerSum + periodManualSum}</span>
          {" · "}
          <span className="text-emerald-400 font-mono tabular-nums">в дайлере {periodDialerSum}</span>
          {" · "}
          <span className="text-rose-400 font-mono tabular-nums">вне дайлера {periodManualSum}</span>
        </div>
      )}

      {err ? (
        <div className="text-xs text-rose-300">{err}</div>
      ) : !rows ? (
        <div className="flex items-center justify-center py-8 text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : rows.length === 0 ? (
        <div className="text-xs text-slate-500 py-4 text-center">
          На этих этапах сейчас нет лидов
        </div>
      ) : (
        <div className="max-h-[420px] overflow-y-auto rounded-lg border border-white/5">
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10 bg-slate-900">
              <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500">
                <th className="px-3 py-2 font-medium">Лид</th>
                <th className="px-3 py-2 font-medium">Этап</th>
                <th className="px-3 py-2 font-medium">Ответственный</th>
                <th className="px-3 py-2 font-medium" title="Кто фактически звонил по лиду (число звонков) — не всегда ответственный">Кто звонил</th>
                <th className="px-3 py-2 font-medium text-right" title="Касания за выбранный период: в дайлере / вне дайлера">За период</th>
                <th className="px-3 py-2 font-medium text-right" title="Накопительно на конец периода">В дайлере</th>
                <th className="px-3 py-2 font-medium text-right" title="Накопительно на конец периода">Вне дайлера</th>
                <th className="px-3 py-2 font-medium text-right" title="Накопительно на конец периода">Всего</th>
                <th className="px-3 py-2 font-medium text-right">Последнее касание</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {rows.map((r) => {
                const total = r.dialerTouches + r.manualTouches;
                const periodTotal = r.periodDialerTouches + r.periodManualTouches;
                return (
                  <tr key={r.leadId} className="hover:bg-slate-800/40">
                    <td className="px-3 py-1.5 max-w-[220px] truncate">
                      <a
                        href={`${KOMMO_LEADS_BASE}/${r.leadId}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-400 hover:text-blue-300 hover:underline"
                        title={`Открыть лид ${r.leadId} в Kommo`}
                      >
                        {r.contactName || `Лид ${r.leadId}`}
                      </a>
                    </td>
                    <td className="px-3 py-1.5 text-slate-300 whitespace-nowrap">
                      {r.statusId === NEW_LEAD_STATUS_ID ? "Новый лид" : "Недозвон"}
                    </td>
                    <td className="px-3 py-1.5 text-slate-400 max-w-[160px] truncate" title={r.manager ?? ""}>
                      {r.manager ?? "—"}
                    </td>
                    <td
                      className="px-3 py-1.5 text-slate-300 max-w-[200px] truncate"
                      title={r.callers.map((c) => `${c.name} — ${c.n} зв.`).join("\n")}
                    >
                      {r.callers.length === 0 ? (
                        <span className="text-slate-600">—</span>
                      ) : (
                        <>
                          {r.callers.slice(0, 2).map((c, i) => (
                            <span key={c.name}>
                              {i > 0 && <span className="text-slate-600"> · </span>}
                              {c.name}
                              <span className="text-slate-500 font-mono tabular-nums"> {c.n}</span>
                            </span>
                          ))}
                          {r.callers.length > 2 && (
                            <span className="text-slate-500"> +{r.callers.length - 2}</span>
                          )}
                        </>
                      )}
                    </td>
                    <td
                      className="px-3 py-1.5 text-right font-mono tabular-nums whitespace-nowrap"
                      title={`За период: в дайлере ${r.periodDialerTouches}, вне дайлера ${r.periodManualTouches}`}
                    >
                      {periodTotal > 0 ? (
                        <>
                          <span className="text-emerald-400">{r.periodDialerTouches}</span>
                          <span className="text-slate-600"> / </span>
                          <span className="text-rose-400">{r.periodManualTouches}</span>
                        </>
                      ) : (
                        <span className="text-slate-600">0</span>
                      )}
                    </td>
                    <td className={`px-3 py-1.5 text-right font-mono tabular-nums ${r.dialerTouches > 0 ? "text-emerald-400" : "text-slate-600"}`}>
                      {r.dialerTouches}
                    </td>
                    <td className={`px-3 py-1.5 text-right font-mono tabular-nums ${r.manualTouches > 0 ? "text-rose-400" : "text-slate-600"}`}>
                      {r.manualTouches}
                    </td>
                    <td className={`px-3 py-1.5 text-right font-mono tabular-nums ${total > 0 ? "text-slate-200" : "text-amber-400"}`}>
                      {total > 0 ? total : "0 ⚠"}
                    </td>
                    <td className="px-3 py-1.5 text-right text-slate-400 font-mono tabular-nums whitespace-nowrap">
                      {fmtBerlinDateTime(r.lastTouchAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
    </>
  );
}

function TimelineBar({ day, dialerView }: { day: DayTimeline; dialerView?: boolean }) {
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
  // muted grey as scheduled-off days plus a badge so the distinction stays
  // (off-day vs no-show vs partial-idle). Dialer view checks call COUNTS,
  // not minutes — a lone 20-second call rounds to 0 minutes but is activity.
  const isFullyIdle = dialerView
    ? (day.counts?.dialer ?? 0) === 0 && (day.counts?.manual ?? 0) === 0
    : day.minutes.call === 0 &&
      day.minutes.crm === 0 &&
      (day.minutes.lunch ?? 0) === 0 &&
      (day.minutes.meeting ?? 0) === 0;
  if (isFullyIdle) {
    return (
      <div className="relative h-6 rounded-md bg-slate-700/40 border border-slate-600/30 overflow-hidden">
        <div className="absolute inset-0 flex items-center justify-center text-[10px] uppercase tracking-widest text-slate-500">
          {dialerView ? "Без звонков в CloudTalk" : "Нет активности"}
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
              : s.type === "crm" || s.type === "dialer"
                ? "bg-emerald-500"
                : s.type === "manual"
                  ? "bg-rose-500"
                  : s.type === "lunch"
                    ? "bg-yellow-400/80"
                    : s.type === "meeting"
                      ? "bg-violet-500/80"
                      : s.type === "dayend"
                        ? "bg-slate-600/60"
                        // idle: gray (base bar) in the dialer view — «без звонков»
                        // is not the same accusation as general-view «простой».
                        : dialerView
                          ? "bg-transparent"
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

// ==================== Плашка «Мой статус» (менеджер b2g) ====================
// Статус ставится только «в моменте» (решение 2026-07-22): Обед / Встреча /
// Завершил день; «Вернулся к работе» закрывает активный. Задним числом правит
// только админ (в модалке дня).
function MyStatusBar({
  active,
  onChanged,
}: {
  active: StatusIntervalDto | null;
  onChanged: (active: StatusIntervalDto | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/tracking/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ department: "b2g", ...body }),
      });
      if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
      const json = (await res.json()) as { active: StatusIntervalDto | null };
      onChanged(json.active ?? null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const sinceLabel = active
    ? new Date(active.startedAt).toLocaleTimeString("ru-RU", {
        timeZone: "Europe/Berlin",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  const btnCls =
    "px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors disabled:opacity-50";

  return (
    <div className="glass-panel rounded-2xl p-3 border border-white/5 flex flex-wrap items-center gap-2">
      <span className="text-xs text-slate-400 mr-1">Мой статус:</span>
      {active ? (
        <>
          <span
            className={`px-2.5 py-1 rounded-lg text-xs font-semibold ${
              active.status === "lunch"
                ? "bg-yellow-400/15 text-yellow-300 border border-yellow-400/30"
                : active.status === "meeting"
                  ? "bg-violet-500/15 text-violet-300 border border-violet-500/30"
                  : "bg-slate-600/20 text-slate-300 border border-slate-500/30"
            }`}
          >
            {STATUS_LABELS[active.status] ?? active.status} · с {sinceLabel}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => post({ action: "stop" })}
            className={`${btnCls} bg-emerald-500/15 text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/25`}
          >
            Вернулся к работе
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() => post({ action: "start", status: "lunch" })}
            className={`${btnCls} bg-yellow-400/10 text-yellow-300 border-yellow-400/30 hover:bg-yellow-400/20`}
          >
            Обед
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => post({ action: "start", status: "meeting" })}
            className={`${btnCls} bg-violet-500/10 text-violet-300 border-violet-500/30 hover:bg-violet-500/20`}
          >
            Встреча
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => post({ action: "start", status: "day_end" })}
            className={`${btnCls} bg-slate-600/20 text-slate-300 border-slate-500/30 hover:bg-slate-600/40`}
          >
            Завершил день
          </button>
        </>
      )}
      <span className="text-[10px] text-slate-500 ml-auto">
        Обед не считается простоем до 60 мин/день; встречи — рабочее время
      </span>
      {err && <span className="text-[10px] text-rose-300 w-full">{err}</span>}
    </div>
  );
}

// ==================== Сводная таблица (общий вид) ====================
// Пофамильные итоги за выбранный период, цифрами (просьба Лилии/Дмитрия,
// 2026-07-22): телефон / диалог / CRM / простой / утилизация. Считается на
// клиенте из уже загруженных дней — отдельного API не нужно.
function GeneralSummaryTable({
  managers,
  department,
}: {
  managers: ManagerTimeline[];
  department: "b2g" | "b2b";
}) {
  const rows = managers
    .map((m) => {
      let workDays = 0;
      let call = 0;
      let talk = 0;
      let crm = 0;
      let idle = 0;
      let lunch = 0;
      let meeting = 0;
      let hasTalk = false;
      for (const d of m.days) {
        if (d.mode !== "working") continue;
        workDays++;
        call += d.minutes.call;
        crm += d.minutes.crm;
        idle += d.minutes.idle;
        lunch += d.minutes.lunch ?? 0;
        meeting += d.minutes.meeting ?? 0;
        if (d.minutes.talk != null) {
          hasTalk = true;
          talk += d.minutes.talk;
        }
      }
      const denom = call + crm + idle;
      const util = denom > 0 ? Math.round(((call + crm) / denom) * 100) : 0;
      return { id: m.id, name: m.name, line: m.line, workDays, call, talk, hasTalk, crm, idle, lunch, meeting, util };
    })
    .filter((r) => r.workDays > 0)
    .sort((a, b) => b.util - a.util || b.call - a.call);

  if (rows.length === 0) return null;
  // «в диалоге» показываем, только если по отделу реально трекается дозвон
  // (b2g); для b2b колонка дублировала бы «в телефоне».
  const showTalk = department === "b2g" && rows.some((r) => r.hasTalk && r.talk !== r.call);
  // Колонки статусов — когда они вообще используются.
  const showStatuses = department === "b2g" && rows.some((r) => r.lunch > 0 || r.meeting > 0);

  return (
    <div className="glass-panel rounded-2xl border border-white/5 p-4 mt-4">
      <div className="flex items-baseline gap-2 mb-3">
        <span className="text-sm font-semibold text-white">Итоги за период</span>
        <span className="text-[11px] text-slate-500">
          суммы по рабочим дням · утилизация = (телефон + CRM) от нормы 8 ч/день
        </span>
      </div>
      <div className="overflow-x-auto rounded-lg border border-white/5">
        <table className="w-full text-xs">
          <thead className="bg-slate-900">
            <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500">
              <th className="px-3 py-2 font-medium">Менеджер</th>
              <th className="px-3 py-2 font-medium text-right">Раб. дней</th>
              <th className="px-3 py-2 font-medium text-right" title="Разговоры + дозвон исходящих">В телефоне</th>
              {showTalk && <th className="px-3 py-2 font-medium text-right" title="Чистое время разговора">В диалоге</th>}
              <th className="px-3 py-2 font-medium text-right">В CRM</th>
              {showStatuses && (
                <>
                  <th className="px-3 py-2 font-medium text-right" title="До 60 мин/день не считается простоем">Обед</th>
                  <th className="px-3 py-2 font-medium text-right" title="Вычитаются из простоя">Встречи</th>
                </>
              )}
              <th className="px-3 py-2 font-medium text-right">Простой</th>
              <th className="px-3 py-2 font-medium text-right" title="(телефон + CRM) / (телефон + CRM + простой)">Утилизация</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-slate-800/40">
                <td className="px-3 py-1.5 text-slate-200 max-w-[220px] truncate" title={r.name}>
                  {r.name}
                  {r.line && <span className="text-slate-500 text-[10px]"> · Л{r.line}</span>}
                </td>
                <td className="px-3 py-1.5 text-right font-mono tabular-nums text-slate-400">{r.workDays}</td>
                <td className="px-3 py-1.5 text-right font-mono tabular-nums text-blue-400">{fmtHm(r.call)}</td>
                {showTalk && (
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums text-blue-300/80">
                    {r.hasTalk ? fmtHm(r.talk) : "—"}
                  </td>
                )}
                <td className="px-3 py-1.5 text-right font-mono tabular-nums text-emerald-400">{fmtHm(r.crm)}</td>
                {showStatuses && (
                  <>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums text-yellow-400/90">
                      {r.lunch > 0 ? fmtHm(r.lunch) : "—"}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums text-violet-400/90">
                      {r.meeting > 0 ? fmtHm(r.meeting) : "—"}
                    </td>
                  </>
                )}
                <td className="px-3 py-1.5 text-right font-mono tabular-nums text-rose-400">{fmtHm(r.idle)}</td>
                <td className={`px-3 py-1.5 text-right font-mono tabular-nums ${r.util >= 60 ? "text-emerald-300" : r.util >= 40 ? "text-amber-300" : "text-rose-300"}`}>
                  {r.util}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
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
        <span className="tracking-call" title="В телефоне: разговоры + дозвон">{fmtHm(day.minutes.call)}</span>
        <span className="text-slate-600">/</span>
        <span className="tracking-crm">{fmtHm(day.minutes.crm)}</span>
        <span className="text-slate-600">/</span>
        <span className="tracking-idle">{fmtHm(day.minutes.idle)}</span>
      </div>
      {/* Чистое время разговора — показываем только когда отличается от
          «в телефоне» (b2g с трекингом дозвона); иначе строка — шум. */}
      {day.minutes.talk != null && day.minutes.talk !== day.minutes.call && (
        <div className="text-[10px] text-slate-500">в диалоге {fmtHm(day.minutes.talk)}</div>
      )}
      {((day.minutes.lunch ?? 0) > 0 || (day.minutes.meeting ?? 0) > 0) && (
        <div className="text-[10px]">
          {(day.minutes.lunch ?? 0) > 0 && (
            <span className="text-yellow-400/90">обед {fmtHm(day.minutes.lunch!)}</span>
          )}
          {(day.minutes.lunch ?? 0) > 0 && (day.minutes.meeting ?? 0) > 0 && (
            <span className="text-slate-600"> · </span>
          )}
          {(day.minutes.meeting ?? 0) > 0 && (
            <span className="text-violet-400/90">встречи {fmtHm(day.minutes.meeting!)}</span>
          )}
        </div>
      )}
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
  statusIntervals?: StatusIntervalDto[];
}

function DetailModal({
  department,
  view,
  target,
  typesParam,
  canEditStatuses,
  onClose,
}: {
  department: "b2g" | "b2b";
  view: "general" | "dialer";
  target: { managerId: string; managerName: string; line: string | null; date: string };
  typesParam: string;
  canEditStatuses?: boolean;
  onClose: () => void;
}) {
  const isDialer = view === "dialer";
  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [hoverSeg, setHoverSeg] = useState<Segment | null>(null);
  // Бамп после админ-правки статусов → рефетч дня (таймлайн + список).
  const [reloadKey, setReloadKey] = useState(0);

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
  }, [department, view, target.managerId, target.date, typesParam, reloadKey]);

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
              <DetailTimelineBar timeline={timeline} dialerView={isDialer} onHover={setHoverSeg} />

              <HourGrid
                shiftStart={timeline.shiftStart!}
                shiftEnd={timeline.shiftEnd!}
                totalMinutes={timeline.totalMinutes}
              />

              <div className="mt-4 grid gap-3 grid-cols-3">
                {isDialer ? (
                  <>
                    <StatTile color="bg-emerald-500" label="В дайлере" minutes={timeline.minutes.dialer ?? 0} pct={timeline.pct.dialer ?? 0} />
                    <StatTile color="bg-rose-500" label="Вне дайлера" minutes={timeline.minutes.manual ?? 0} pct={timeline.pct.manual ?? 0} />
                    <StatTile color="bg-slate-600" label="Без звонков в CloudTalk" minutes={timeline.minutes.idle} pct={timeline.pct.idle} />
                  </>
                ) : (
                  <>
                    <StatTile
                      color="bg-blue-500"
                      label="В телефоне"
                      minutes={timeline.minutes.call}
                      pct={timeline.pct.call}
                      sub={
                        timeline.minutes.talk != null && timeline.minutes.talk !== timeline.minutes.call
                          ? `в диалоге ${Math.floor(timeline.minutes.talk / 60)}ч ${timeline.minutes.talk % 60}м`
                          : undefined
                      }
                    />
                    <StatTile color="bg-emerald-500" label="В CRM" minutes={timeline.minutes.crm} pct={timeline.pct.crm} />
                    <StatTile color="bg-rose-500/70" label="Простой" minutes={timeline.minutes.idle} pct={timeline.pct.idle} />
                  </>
                )}
              </div>

              {/* Статусы дня (b2g, общий вид): список + ретро-правка админа. */}
              {!isDialer && department === "b2g" && (
                <DayStatusSection
                  statuses={data?.statusIntervals ?? []}
                  canEdit={!!canEditStatuses}
                  managerId={target.managerId}
                  dateISO={target.date}
                  onChanged={() => setReloadKey((k) => k + 1)}
                />
              )}

              {hoverSeg ? (
                <SegmentEventList
                  seg={hoverSeg}
                  events={segEvents}
                  shiftStart={timeline.shiftStart!}
                  dialerView={isDialer}
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

// ==================== Статусы дня в модалке ====================
// Список ручных статусов менеджера за день; админ может удалить интервал или
// добавить задним числом (время — Berlin, наивные строки парсит сервер).
function DayStatusSection({
  statuses,
  canEdit,
  managerId,
  dateISO,
  onChanged,
}: {
  statuses: StatusIntervalDto[];
  canEdit: boolean;
  managerId: string;
  dateISO: string;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [addStatus, setAddStatus] = useState("lunch");
  const [addFrom, setAddFrom] = useState("13:00");
  const [addTo, setAddTo] = useState("14:00");

  if (statuses.length === 0 && !canEdit) return null;

  const fmtT = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleTimeString("ru-RU", {
          timeZone: "Europe/Berlin",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "…";

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/tracking/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ department: "b2g", ...body }),
      });
      if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 rounded-lg bg-slate-800/30 border border-white/5 p-3">
      <div className="text-[11px] uppercase tracking-widest text-slate-400 mb-2">
        Статусы дня
        {canEdit && (
          <span className="text-slate-500 normal-case tracking-normal ml-2">(правка задним числом — только админ)</span>
        )}
      </div>
      {statuses.length === 0 ? (
        <div className="text-xs text-slate-500 py-1">Статусы не выставлялись</div>
      ) : (
        <ul className="flex flex-col divide-y divide-white/5">
          {statuses.map((s) => (
            <li key={s.id} className="flex items-center gap-2 py-1.5 text-xs">
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  s.status === "lunch" ? "bg-yellow-400" : s.status === "meeting" ? "bg-violet-500" : "bg-slate-500"
                }`}
              />
              <span className="text-slate-200">{STATUS_LABELS[s.status] ?? s.status}</span>
              <span className="text-slate-500 font-mono tabular-nums">
                {fmtT(s.startedAt)}–{fmtT(s.endedAt)}
              </span>
              {s.createdBy && s.createdBy !== "self" && (
                <span className="text-[10px] text-slate-600">{s.createdBy}</span>
              )}
              {canEdit && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => post({ action: "delete", id: s.id })}
                  className="ml-auto text-[10px] text-rose-400/80 hover:text-rose-300 disabled:opacity-50"
                >
                  удалить
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <select
            value={addStatus}
            onChange={(e) => setAddStatus(e.target.value)}
            className="bg-slate-800 border border-white/10 rounded-md px-2 py-1 text-xs text-slate-200"
          >
            <option value="lunch">Обед</option>
            <option value="meeting">Встреча</option>
            <option value="day_end">Завершил день</option>
          </select>
          <input
            type="time"
            value={addFrom}
            onChange={(e) => setAddFrom(e.target.value)}
            className="bg-slate-800 border border-white/10 rounded-md px-2 py-1 text-xs text-slate-200"
          />
          <span className="text-slate-600">—</span>
          <input
            type="time"
            value={addTo}
            onChange={(e) => setAddTo(e.target.value)}
            className="bg-slate-800 border border-white/10 rounded-md px-2 py-1 text-xs text-slate-200"
          />
          <button
            type="button"
            disabled={busy || !addFrom || !addTo}
            onClick={() =>
              post({
                action: "add",
                managerId,
                status: addStatus,
                from: `${dateISO}T${addFrom}`,
                to: `${dateISO}T${addTo}`,
              })
            }
            className="px-2.5 py-1 rounded-md bg-slate-700 hover:bg-slate-600 border border-white/10 text-slate-200 disabled:opacity-50"
          >
            Добавить
          </button>
          {err && <span className="text-[10px] text-rose-300 w-full">{err}</span>}
        </div>
      )}
    </div>
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
  dialerView,
  onHover,
}: {
  timeline: DayTimeline;
  dialerView?: boolean;
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
            : s.type === "crm" || s.type === "dialer"
              ? "bg-emerald-500"
              : s.type === "manual"
                ? "bg-rose-500"
                : s.type === "lunch"
                  ? "bg-yellow-400/80"
                  : s.type === "meeting"
                    ? "bg-violet-500/80"
                    : s.type === "dayend"
                      ? "bg-slate-600/60"
                      : dialerView
                        ? "bg-transparent"
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
  sub,
}: {
  color: string;
  label: string;
  minutes: number;
  pct: number;
  sub?: string; // optional second line, e.g. «в диалоге 1ч 23м»
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
      {sub && <div className="text-[10px] text-slate-500 font-mono tabular-nums mt-0.5">{sub}</div>}
    </div>
  );
}

function SegmentEventList({
  seg,
  events,
  shiftStart,
  dialerView,
}: {
  seg: Segment;
  events: DetailEvent[];
  shiftStart: string;
  dialerView?: boolean;
}) {
  const segStart = formatSegmentTime(shiftStart, seg.startMin);
  const segEnd = formatSegmentTime(shiftStart, seg.endMin);
  return (
    <div className="mt-4 rounded-lg bg-slate-800/30 border border-white/5 p-3">
      <div className="text-[11px] uppercase tracking-widest text-slate-400 mb-2">
        {seg.type === "call" ? "Звонок" : seg.type === "crm" ? "Работа в CRM" : seg.type === "dialer" ? "В дайлере" : seg.type === "manual" ? "Вне дайлера" : seg.type === "lunch" ? "Обед" : seg.type === "meeting" ? "Встреча" : seg.type === "dayend" ? "День завершён" : dialerView ? "Без звонков в CloudTalk" : "Простой"}
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
