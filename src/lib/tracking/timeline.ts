import { CALL_TYPES, normalizeEventType } from "./event-types";

// ==================== Timeline builder ====================
// Input:
//   - schedule row for a manager on a specific date (scheduleValue + shift times)
//   - events[] (already filtered to this manager + date from DB)
//   - userSelectedCrmTypes — which CRM types are counted as "green"
//
// Output:
//   - mode: "working" | "off"   — off means the whole bar is grey
//   - totalMinutes — length of the shift in minutes (for % math)
//   - segments[]   — contiguous colored stripes
//   - pct          — {call, crm, idle} summing to ~100
//
// Rules:
//   - Each minute belongs to exactly one of: call | crm | idle (no double colors)
//   - Call priority > CRM > idle. If a call covers a minute, that minute is blue
//     even if a CRM event also fell on it.
//   - Call length = max(1, duration_sec / 60) rounded — anchored at event start
//   - CRM event = 1 minute block at event start. Adjacent CRM minutes (gap ≤ 2 min)
//     are merged into a single green stripe.
//   - Events outside the shift window are clipped to the window.
//   - If a call overruns the shift end, we clip at shift end.

// "wait" is dialer-only (CloudTalk ring/queue time before talk); the general
// timeline never emits it. Kept in the shared union so TimelineBar/Segment can
// render both views from one component.
export type SegmentType = "call" | "crm" | "idle" | "wait";

export interface TimelineEvent {
  eventId: string;
  eventType: string;
  createdAt: Date;
  durationSec: number;
  /**
   * Kommo entity scope: "lead" | "contact" | "company" | "task" | null.
   * Needed for filtering: Kommo emits one generic `entity_linked` /
   * `entity_unlinked` for every type of attachment, with the actual scope
   * carried in this column. The UI filter offers entity-specific keys
   * (`lead_linked`, `contact_linked`, …) — we expand them at match time.
   */
  entityType?: string | null;
}

export interface TimelineSegment {
  type: SegmentType;
  startMin: number;     // minutes from shift start
  endMin: number;       // exclusive
  durationMin: number;  // endMin - startMin
  label?: string;       // tooltip content (e.g. "Исходящий звонок · 43 мин")
  eventCount?: number;  // number of CRM events clustered into this green segment
}

export interface TimelineResult {
  mode: "working" | "off";
  offReason?: string;              // e.g. "Выходной" | "Отпуск" | "Нет смены"
  shiftStart?: string;             // "HH:MM"
  shiftEnd?: string;               // "HH:MM"
  totalMinutes: number;            // 0 if off
  segments: TimelineSegment[];
  // `wait` is populated only by buildDialerTimeline; the general timeline
  // leaves it undefined (treated as 0 by consumers).
  pct: { call: number; crm: number; idle: number; wait?: number };
  minutes: { call: number; crm: number; idle: number; wait?: number };
}

export interface ScheduleRow {
  scheduleDate: string;               // YYYY-MM-DD
  scheduleValue: string | null;       // "8" | "4" | "-" | "о"
  shiftStartTime: string | null;      // "HH:MM"
  shiftEndTime: string | null;        // "HH:MM"
}

// Per user spec 2026-04-28: tracking timeline always renders 09:00–20:00
// Berlin time on working days, regardless of per-manager shift hours stored
// in master_managers / manager_schedule. Late activity (after 18:00) was
// being clipped under the old defaults, hiding real working time.
const TIMELINE_START = "09:00";
const TIMELINE_END = "20:00";

// CRM activity model — calibrated 2026-04-29 against real manager behaviour.
//
// The naive "1 event = 1 minute, cluster gap ≤ 2 min" model under-counts
// real focused CRM work by 3-5x: a manager spending 30 min editing cards
// fires roughly one event every 4-7 minutes (task_text_changed,
// custom_field_*, lead_status_changed) — every gap exceeds 2 min, so each
// event renders as an isolated 1-min stripe. 30 minutes of work shows as
// 6 minutes of green.
//
// Session-based model:
//   • Events within SESSION_MAX_GAP_MIN of each other = one session
//   • Each session's stripe spans first → last event minute
//   • + SESSION_TAIL_MIN appended after the last event (managers don't
//     stop working the instant they emit their last tracked action)
//
// Trade-off: an 8-minute AFK between two clicks counts as work. Acceptable
// — alternative is the 4x under-count we used to have.
const SESSION_MAX_GAP_MIN = 10;
const SESSION_TAIL_MIN = 3;

function parseHm(hm: string): { h: number; m: number } {
  const [hs, ms] = hm.split(":");
  return { h: Number(hs), m: Number(ms) };
}

/**
 * Derive the timeline window for a schedule row.
 * Returns null if the manager doesn't work that day (отпуск / выходной).
 *
 * For working days the window is fixed at 09:00–20:00 — schedule values
 * like "4" or "6" no longer shorten the bar, only "-" / "о" turn it off.
 * Activity outside 09–20 is still clipped (Kommo events with createdAt
 * after 20:00 don't render); raise TIMELINE_END here if that becomes a
 * complaint.
 */
function deriveShiftWindow(sched: ScheduleRow | null): {
  startLocal: { h: number; m: number };
  endLocal: { h: number; m: number };
  totalMinutes: number;
} | null {
  const val = (sched?.scheduleValue ?? "").trim();
  if (val === "-" || val === "о") return null;

  const start = parseHm(TIMELINE_START);
  const end = parseHm(TIMELINE_END);
  const total = end.h * 60 + end.m - (start.h * 60 + start.m);
  return { startLocal: start, endLocal: end, totalMinutes: total };
}

function offReasonFor(sched: ScheduleRow | null): string {
  const val = (sched?.scheduleValue ?? "").trim();
  if (val === "о") return "Отпуск";
  if (val === "-") return "Выходной";
  if (!sched) return "Нет расписания";
  return "Нет смены";
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function fmtHm(t: { h: number; m: number }): string {
  return `${pad2(t.h)}:${pad2(t.m)}`;
}

/** "HH:MM" string for an offset N minutes after shift start. */
function fmtSegmentTime(start: { h: number; m: number }, offsetMin: number): string {
  const total = start.h * 60 + start.m + offsetMin;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

function labelForCall(eventType: string, durationSec: number): string {
  const dir = eventType === "incoming_call" ? "Входящий звонок" : "Исходящий звонок";
  const mins = Math.round(durationSec / 60);
  if (mins >= 1) return `${dir} · ${mins} мин`;
  return `${dir} · ${durationSec} сек`;
}

/**
 * Build a per-minute array and collapse into contiguous segments.
 */
export function buildTimeline(params: {
  scheduleRow: ScheduleRow | null;
  dateISO: string;            // YYYY-MM-DD
  tzOffsetMinutes: number;    // offset of the dashboard's display TZ from UTC
  events: TimelineEvent[];    // ALL events for this manager on this date (already filtered by DB)
  selectedCrmTypes: Set<string>;
}): TimelineResult {
  const { scheduleRow, dateISO, tzOffsetMinutes, events, selectedCrmTypes } = params;
  const window = deriveShiftWindow(scheduleRow);

  if (!window) {
    return {
      mode: "off",
      offReason: offReasonFor(scheduleRow),
      totalMinutes: 0,
      segments: [],
      pct: { call: 0, crm: 0, idle: 0 },
      minutes: { call: 0, crm: 0, idle: 0 },
    };
  }

  const shiftStartLabel = fmtHm(window.startLocal);
  const shiftEndLabel = fmtHm(window.endLocal);
  const total = window.totalMinutes;

  // Absolute UTC timestamps for shift boundaries on this date.
  // dateISO is a calendar date in the dashboard's TZ. Convert to UTC via offset.
  // tzOffsetMinutes: e.g. Europe/Moscow in summer is +180.
  const [y, mo, d] = dateISO.split("-").map(Number);
  // Local time = UTC + offset, so UTC = local - offset
  const shiftStartUtcMs =
    Date.UTC(y, mo - 1, d, window.startLocal.h, window.startLocal.m) -
    tzOffsetMinutes * 60_000;
  const shiftEndUtcMs = shiftStartUtcMs + total * 60_000;

  // Allocate per-minute array: 0 = idle, 1 = crm, 2 = call (highest priority)
  const grid = new Uint8Array(total);
  // Track tooltip providers per minute (call dominates).
  const callAt = new Array<{ start: number; end: number; type: string; dur: number } | null>(total).fill(null);
  // CRM event starts (for labels / cluster merging)
  const crmStarts: Array<{ minute: number; type: string }> = [];
  // EXACT seconds on the line within the shift window. Sums each call's
  // clipped duration in seconds, never the minute-grid count. Used as the
  // canonical "сколько на линии" metric — the minute grid below has a 1-min
  // floor for visibility and would over-count a barrage of <60s calls.
  let callSecExact = 0;

  for (const ev of events) {
    const evMs = ev.createdAt.getTime();
    if (evMs >= shiftEndUtcMs) continue;

    const isCall = CALL_TYPES.has(ev.eventType);

    if (isCall) {
      // Only render non-missed calls — duration > 0 is how we detect a real call.
      // (Missed calls show up with duration = 0.)
      if (!ev.durationSec || ev.durationSec <= 0) continue;

      // Exact metric: seconds inside the shift window (clipped at both ends).
      // A 19:55→20:30 call contributes 5 min, an 08:55→09:05 call contributes 5 min.
      const callStartMs = Math.max(evMs, shiftStartUtcMs);
      const callEndMs = Math.min(evMs + ev.durationSec * 1000, shiftEndUtcMs);
      if (callEndMs > callStartMs) {
        callSecExact += (callEndMs - callStartMs) / 1000;
      }

      // Visual grid: round-to-minute with 1-min floor so a 10s call still
      // shows as a tick. Over-counts call MINUTES, but pct/minutes math below
      // ignores the grid and uses callSecExact instead.
      const startMinFloat = (evMs - shiftStartUtcMs) / 60_000;
      const durationMin = Math.max(1, Math.round(ev.durationSec / 60));
      let startMin = Math.max(0, Math.floor(startMinFloat));
      const endMin = Math.min(total, startMin + durationMin);

      // If call starts before the shift but ends inside — clip at 0.
      if (startMinFloat < 0 && endMin > 0) {
        startMin = 0;
      }

      if (endMin <= startMin) continue;

      for (let i = startMin; i < endMin; i++) grid[i] = 2;
      // Record tooltip source (use first minute as anchor)
      callAt[startMin] = { start: startMin, end: endMin, type: ev.eventType, dur: ev.durationSec };
    } else {
      // CRM event — only count if selected by filter. Three matching paths:
      //   1. direct: eventType matches a selected key (most events)
      //   2. per-id custom_field_<ID>_value_changed → generic
      //   3. entity_linked / entity_unlinked carry entity_type — they
      //      light up the specific lead_linked / contact_linked / etc.
      //      checkbox via the entity_type column. This covers Kommo's
      //      "all link events emit as entity_*, with entity scope in
      //      a separate column" semantics.
      const directKey = normalizeEventType(ev.eventType);
      let matched = selectedCrmTypes.has(directKey);
      if (!matched && (ev.eventType === "entity_linked" || ev.eventType === "entity_unlinked") && ev.entityType) {
        const suffix = ev.eventType === "entity_linked" ? "_linked" : "_unlinked";
        matched = selectedCrmTypes.has(`${ev.entityType}${suffix}`);
      }
      if (!matched) continue;
      if (evMs < shiftStartUtcMs) continue;

      const minute = Math.floor((evMs - shiftStartUtcMs) / 60_000);
      if (minute < 0 || minute >= total) continue;

      // Mark 1 minute CRM (only if not already a call)
      if (grid[minute] !== 2) grid[minute] = Math.max(grid[minute], 1);
      crmStarts.push({ minute, type: ev.eventType });
    }
  }

  // Session model: events whose minutes are within SESSION_MAX_GAP_MIN of
  // each other belong to the same continuous CRM-work session. Fill all
  // minutes between the first and last event of the session, then add
  // SESSION_TAIL_MIN minutes after the last event (managers don't drop the
  // mouse the millisecond they fire their last tracked action).
  //
  // Skips minutes that are already classified as call (grid==2) — calls
  // dominate, no overwrite. CRM stays 1, idle stays 0 outside sessions.
  if (crmStarts.length > 0) {
    // crmStarts are pushed in event-iteration order, not necessarily sorted by minute.
    const sortedMinutes = crmStarts.map((s) => s.minute).sort((a, b) => a - b);

    let sessionStart = sortedMinutes[0];
    let sessionLast = sortedMinutes[0];

    const closeSession = (start: number, last: number) => {
      const end = Math.min(total, last + 1 + SESSION_TAIL_MIN);
      for (let i = start; i < end; i++) {
        if (grid[i] !== 2) grid[i] = 1;
      }
    };

    for (let i = 1; i < sortedMinutes.length; i++) {
      const minute = sortedMinutes[i];
      if (minute - sessionLast <= SESSION_MAX_GAP_MIN) {
        // Same session — extend.
        sessionLast = minute;
      } else {
        // Gap too large — close current session, start new one.
        closeSession(sessionStart, sessionLast);
        sessionStart = minute;
        sessionLast = minute;
      }
    }
    closeSession(sessionStart, sessionLast);
  }

  // Collapse into segments
  const segments: TimelineSegment[] = [];
  let cursor = 0;
  while (cursor < total) {
    const v = grid[cursor];
    let end = cursor + 1;
    while (end < total && grid[end] === v) end++;

    const type: SegmentType = v === 2 ? "call" : v === 1 ? "crm" : "idle";
    const seg: TimelineSegment = {
      type,
      startMin: cursor,
      endMin: end,
      durationMin: end - cursor,
    };

    if (type === "call") {
      // Find the call tooltip anchor falling inside this segment
      for (let i = cursor; i < end; i++) {
        if (callAt[i]) {
          seg.label = labelForCall(callAt[i]!.type, callAt[i]!.dur);
          break;
        }
      }
      if (!seg.label) seg.label = `Звонок · ${seg.durationMin} мин`;
    } else if (type === "crm") {
      const evCount = crmStarts.filter((e) => e.minute >= cursor && e.minute < end).length;
      seg.eventCount = evCount;
      // Format: «Работа в CRM · 09:30–09:45 · 12 событий».
      // Time range is more useful than "X мин" alone — user immediately sees
      // when the session was, plus the visible bar already conveys length.
      // Event count is the user's selected types only (filtered above), so
      // matches the dropdown selection.
      const startHm = fmtSegmentTime(window.startLocal, cursor);
      const endHm = fmtSegmentTime(window.startLocal, end);
      const evWord = evCount === 1 ? "событие" : evCount < 5 ? "события" : "событий";
      seg.label = `Работа в CRM · ${startHm}–${endHm} · ${evCount} ${evWord}`;
    } else {
      seg.label = `Простой · ${seg.durationMin} мин`;
    }

    segments.push(seg);
    cursor = end;
  }

  // Side-panel metrics: independent of the visual minute-grid.
  //   • call comes from callSecExact — actual seconds on the line, clipped
  //     to shift. The grid is allowed to over-count short calls for the
  //     reader's eyes, but the numbers next to the bar must be honest.
  //   • crm = number of grid cells == 1 (1 event = 1 minute, intentional).
  //   • idle = total − call − crm, never below 0.
  const callMin = Math.round(callSecExact / 60);
  let crmMin = 0;
  for (let i = 0; i < total; i++) if (grid[i] === 1) crmMin++;
  const idleMin = Math.max(0, total - callMin - crmMin);
  const pct = {
    call: total > 0 ? Math.round((callMin / total) * 100) : 0,
    crm: total > 0 ? Math.round((crmMin / total) * 100) : 0,
    idle: total > 0 ? Math.round((idleMin / total) * 100) : 0,
  };

  return {
    mode: "working",
    shiftStart: shiftStartLabel,
    shiftEnd: shiftEndLabel,
    totalMinutes: total,
    segments,
    pct,
    minutes: { call: callMin, crm: crmMin, idle: idleMin },
  };
}

// ==================== Dialer timeline builder ====================
// Same 09:00–20:00 Berlin grid + segment shape as buildTimeline, but for
// CloudTalk dialer calls. Each call lays down two contiguous stripes from its
// start: «ожидание/дозвон» (ring/queue = waiting_time) then «разговор» (talk =
// talking_time). Everything else is «простой». Produces a TimelineResult so the
// UI renders it with the same TimelineBar as the general view.

export interface DialerCall {
  startedAt: Date;   // CloudTalk Cdr.started_at (ring start)
  talkSec: number;   // talking_time
  waitSec: number;   // waiting_time (ring/queue before pickup)
}

function labelForDialerSeg(type: SegmentType, durationMin: number): string {
  if (type === "call") return `Разговор · ${durationMin} мин`;
  if (type === "wait") return `Ожидание/дозвон · ${durationMin} мин`;
  return `Простой · ${durationMin} мин`;
}

export function buildDialerTimeline(params: {
  scheduleRow: ScheduleRow | null;
  dateISO: string;
  tzOffsetMinutes: number;
  calls: DialerCall[];
}): TimelineResult {
  const { scheduleRow, dateISO, tzOffsetMinutes, calls } = params;
  const window = deriveShiftWindow(scheduleRow);

  if (!window) {
    return {
      mode: "off",
      offReason: offReasonFor(scheduleRow),
      totalMinutes: 0,
      segments: [],
      pct: { call: 0, crm: 0, idle: 0, wait: 0 },
      minutes: { call: 0, crm: 0, idle: 0, wait: 0 },
    };
  }

  const total = window.totalMinutes;
  const [y, mo, d] = dateISO.split("-").map(Number);
  const shiftStartUtcMs =
    Date.UTC(y, mo - 1, d, window.startLocal.h, window.startLocal.m) -
    tzOffsetMinutes * 60_000;
  const shiftEndUtcMs = shiftStartUtcMs + total * 60_000;

  // grid cell: 0 idle, 1 wait, 2 talk. Talk wins over wait wins over idle when
  // calls overlap (shouldn't normally — an agent is on one call at a time).
  const grid = new Uint8Array(total);
  // Exact seconds within the window (honest side-panel numbers); the grid below
  // floors-to-minute for visibility, like buildTimeline.
  let talkSecExact = 0;
  let waitSecExact = 0;

  const clipSec = (aMs: number, bMs: number): number => {
    const s = Math.max(aMs, shiftStartUtcMs);
    const e = Math.min(bMs, shiftEndUtcMs);
    return e > s ? (e - s) / 1000 : 0;
  };
  const mark = (aMs: number, bMs: number, val: number) => {
    if (bMs <= aMs) return;
    const sMin = Math.max(0, Math.floor((aMs - shiftStartUtcMs) / 60_000));
    const eMin = Math.min(total, Math.ceil((bMs - shiftStartUtcMs) / 60_000));
    for (let i = sMin; i < eMin; i++) if (grid[i] < val) grid[i] = val;
  };

  for (const c of calls) {
    const waitStart = c.startedAt.getTime();
    const waitEnd = waitStart + Math.max(0, c.waitSec) * 1000;
    const talkStart = waitEnd;
    const talkEnd = talkStart + Math.max(0, c.talkSec) * 1000;
    waitSecExact += clipSec(waitStart, waitEnd);
    talkSecExact += clipSec(talkStart, talkEnd);
    mark(waitStart, waitEnd, 1);
    mark(talkStart, talkEnd, 2);
  }

  // Collapse grid into contiguous segments.
  const segments: TimelineSegment[] = [];
  let cursor = 0;
  while (cursor < total) {
    const v = grid[cursor];
    let end = cursor + 1;
    while (end < total && grid[end] === v) end++;
    const type: SegmentType = v === 2 ? "call" : v === 1 ? "wait" : "idle";
    const durationMin = end - cursor;
    segments.push({
      type,
      startMin: cursor,
      endMin: end,
      durationMin,
      label: labelForDialerSeg(type, durationMin),
    });
    cursor = end;
  }

  const callMin = Math.round(talkSecExact / 60);
  const waitMin = Math.round(waitSecExact / 60);
  const idleMin = Math.max(0, total - callMin - waitMin);
  const pct = {
    call: total > 0 ? Math.round((callMin / total) * 100) : 0,
    wait: total > 0 ? Math.round((waitMin / total) * 100) : 0,
    crm: 0,
    idle: total > 0 ? Math.round((idleMin / total) * 100) : 0,
  };

  return {
    mode: "working",
    shiftStart: fmtHm(window.startLocal),
    shiftEnd: fmtHm(window.endLocal),
    totalMinutes: total,
    segments,
    pct,
    minutes: { call: callMin, wait: waitMin, crm: 0, idle: idleMin },
  };
}
