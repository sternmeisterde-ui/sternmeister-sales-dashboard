import { CALL_TYPES } from "./event-types";

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

export type SegmentType = "call" | "crm" | "idle";

export interface TimelineEvent {
  eventId: string;
  eventType: string;
  createdAt: Date;
  durationSec: number;
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
  pct: { call: number; crm: number; idle: number };
  minutes: { call: number; crm: number; idle: number };
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
const CRM_CLUSTER_GAP_MIN = 2;

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

  for (const ev of events) {
    const evMs = ev.createdAt.getTime();
    if (evMs >= shiftEndUtcMs) continue;

    const isCall = CALL_TYPES.has(ev.eventType);

    if (isCall) {
      // Only render non-missed calls — duration > 0 is how we detect a real call.
      // (Missed calls show up with duration = 0.)
      if (!ev.durationSec || ev.durationSec <= 0) continue;

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
      // CRM event — only count if selected by filter
      if (!selectedCrmTypes.has(ev.eventType)) continue;
      if (evMs < shiftStartUtcMs) continue;

      const minute = Math.floor((evMs - shiftStartUtcMs) / 60_000);
      if (minute < 0 || minute >= total) continue;

      // Mark 1 minute CRM (only if not already a call)
      if (grid[minute] !== 2) grid[minute] = Math.max(grid[minute], 1);
      crmStarts.push({ minute, type: ev.eventType });
    }
  }

  // Cluster CRM: fill gaps ≤ CRM_CLUSTER_GAP_MIN between green minutes, but only
  // through idle cells (never overwrite call). This merges tight activity into a
  // single readable green stripe.
  for (let i = 0; i < total; i++) {
    if (grid[i] !== 1) continue;
    // look ahead up to CRM_CLUSTER_GAP_MIN for another green minute
    for (let gap = 1; gap <= CRM_CLUSTER_GAP_MIN && i + gap < total; gap++) {
      if (grid[i + gap] === 1) {
        for (let k = 1; k < gap; k++) {
          if (grid[i + k] === 0) grid[i + k] = 1;
        }
        break;
      }
    }
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
      seg.label = evCount === 1
        ? `Работа в CRM · ${seg.durationMin} мин · 1 событие`
        : `Работа в CRM · ${seg.durationMin} мин · ${evCount} событий`;
    } else {
      seg.label = `Простой · ${seg.durationMin} мин`;
    }

    segments.push(seg);
    cursor = end;
  }

  // Percentages
  let callMin = 0;
  let crmMin = 0;
  let idleMin = 0;
  for (const s of segments) {
    if (s.type === "call") callMin += s.durationMin;
    else if (s.type === "crm") crmMin += s.durationMin;
    else idleMin += s.durationMin;
  }
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
