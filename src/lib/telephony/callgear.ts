// CallGear Data API v2.0 client (JSON-RPC 2.0).
// Docs: https://callgear.github.io/data_api/
//
// We pull two reports and join them in-memory:
//   - get.calls_report      → call session (one per dial attempt, has direction)
//   - get.call_legs_report  → per-operator leg (one per (session, employee))
//
// A leg is the unit we emit as a TelephonyCall — that's what gives us
// 100% dial-attempt coverage at the per-manager grain that the dashboard
// needs. Sessions are only consulted to back-fill the canonical direction
// (the leg's own `direction` field describes the SIP leg, not the user-facing
// inbound/outbound classification).

import type {
  TelephonyCall,
  TelephonyDirection,
  TelephonyStatus,
} from "./types";

const CALLGEAR_API_URL = "https://dataapi.callgear.com/v2.0";
const PAGE_LIMIT = 1000;
const MAX_RETRIES = 3;

interface CallGearSession {
  id: number;
  direction: "in" | "out";
  start_time: string;
  finish_time: string;
  total_duration: number;
  talk_duration: number;
  finish_reason: string | null;
  is_lost: boolean;
  contact_phone_number: string | null;
  virtual_phone_number: string | null;
  call_records: string[];
  wav_call_records: string[];
}

interface CallGearLeg {
  id: number;
  call_session_id: number;
  employee_id: number | null;
  employee_full_name: string | null;
  direction: "in" | "out";
  start_time: string;
  total_duration: number;
  duration: number;
  is_failed: boolean;
  is_operator: boolean;
  is_coach: boolean;
  finish_reason: string | null;
  contact_phone_number: string | null;
  virtual_phone_number: string | null;
}

interface RpcResponse<T> {
  jsonrpc: string;
  id: number;
  result?: { data: T[]; metadata?: { total_items?: number } };
  error?: { code: number; message: string };
}

let rpcIdCounter = 0;

async function rpc<T>(
  method: string,
  params: Record<string, unknown>,
): Promise<{ data: T[]; total: number }> {
  const token = process.env.CALLGEAR_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      "CALLGEAR_ACCESS_TOKEN is not set — required for telephony sync",
    );
  }

  rpcIdCounter += 1;
  const body = {
    jsonrpc: "2.0",
    id: rpcIdCounter,
    method,
    params: { access_token: token, ...params },
  };

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(CALLGEAR_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify(body),
      });

      if (res.status === 429 || res.status >= 500) {
        const wait = 500 * 2 ** attempt;
        console.warn(
          `[CallGear] ${method} HTTP ${res.status}, retrying in ${wait}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
        );
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }

      if (!res.ok) {
        throw new Error(`CallGear ${method} HTTP ${res.status}`);
      }

      const json = (await res.json()) as RpcResponse<T>;
      if (json.error) {
        throw new Error(
          `CallGear ${method} RPC error ${json.error.code}: ${json.error.message}`,
        );
      }
      return {
        data: json.result?.data ?? [],
        total: json.result?.metadata?.total_items ?? 0,
      };
    } catch (err) {
      lastErr = err as Error;
      if (attempt === MAX_RETRIES - 1) break;
      const wait = 500 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr ?? new Error(`CallGear ${method} failed after retries`);
}

// CallGear expects "YYYY-MM-DD HH:MM:SS" in account TZ. The API treats this
// as the account's configured timezone; we send UTC and rely on the join key
// (call_session_id) for downstream consistency rather than parsing the time
// back out per timezone.
function fmtDateTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

async function paginate<T>(
  method: string,
  baseParams: Record<string, unknown>,
): Promise<T[]> {
  const all: T[] = [];
  let offset = 0;
  // Cap pages defensively — per-day totals are typically <2k legs / <1k
  // sessions, so 50k records (50 pages × 1000) covers a worst-case full
  // backfill window before the loop condition kicks in anyway.
  const MAX_PAGES = 50;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, total } = await rpc<T>(method, {
      ...baseParams,
      limit: PAGE_LIMIT,
      offset,
    });
    all.push(...data);
    if (data.length < PAGE_LIMIT) break;
    offset += data.length;
    if (offset >= total) break;
  }
  return all;
}

export interface CallGearEmployee {
  id: number;
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  status: string | null;
}

/**
 * List CallGear employees. Used by /api/managers to auto-resolve
 * `master_managers.callgear_employee_id` by name at save time, mirroring the
 * Kommo `getUsers()` flow. Cheap (one RPC, one page is usually enough — our
 * account has <100 employees).
 */
export async function getEmployees(): Promise<CallGearEmployee[]> {
  const { data } = await rpc<CallGearEmployee>("get.employees", {
    fields: ["id", "full_name", "first_name", "last_name", "email", "status"],
    limit: PAGE_LIMIT,
    offset: 0,
  });
  return data;
}

export async function getSessionsByDate(
  from: Date,
  to: Date,
): Promise<CallGearSession[]> {
  return paginate<CallGearSession>("get.calls_report", {
    date_from: fmtDateTime(from),
    date_till: fmtDateTime(to),
    fields: [
      "id",
      "direction",
      "start_time",
      "finish_time",
      "total_duration",
      "talk_duration",
      "finish_reason",
      "is_lost",
      "contact_phone_number",
      "virtual_phone_number",
      "call_records",
      "wav_call_records",
    ],
  });
}

export async function getLegsByDate(
  from: Date,
  to: Date,
): Promise<CallGearLeg[]> {
  return paginate<CallGearLeg>("get.call_legs_report", {
    date_from: fmtDateTime(from),
    date_till: fmtDateTime(to),
    fields: [
      "id",
      "call_session_id",
      "employee_id",
      "employee_full_name",
      "direction",
      "start_time",
      "total_duration",
      "duration",
      "is_failed",
      "is_operator",
      "is_coach",
      "finish_reason",
      "contact_phone_number",
      "virtual_phone_number",
    ],
  });
}

function classifyStatus(
  leg: CallGearLeg,
  sessionDir: TelephonyDirection,
): TelephonyStatus {
  // CallGear: `duration` = connected talk seconds, `total_duration` = ring+talk+wrap.
  // duration>0 is the only signal that the operator and remote actually spoke.
  if (leg.duration > 0) return "answered";

  const reason = (leg.finish_reason ?? "").toLowerCase();
  if (reason.includes("busy")) return "busy";
  if (reason.includes("no_success_subscriber") || reason.includes("no_answer")) {
    return sessionDir === "incoming" ? "missed" : "no_answer";
  }
  if (reason.includes("disconnect") || reason.includes("failed") || leg.is_failed) {
    return "failed";
  }
  return "unknown";
}

// Strip the "(amoCRM)" annotation CallGear appends to employee names.
function cleanAgentName(raw: string | null): string | null {
  if (!raw) return null;
  return raw.replace(/\s*\(amoCRM\)\s*$/i, "").replace(/\s+/g, " ").trim() || null;
}

function parseStartedAt(s: string): Date {
  // CallGear: "2026-04-27 09:04:23" — assume account TZ ≈ UTC for storage.
  // The dashboard reads these as UTC then renders Europe/Berlin, same as
  // the existing analytics.communications rows.
  const iso = s.includes("T") ? s : s.replace(" ", "T") + "Z";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return new Date();
  return d;
}

/**
 * Fetch all CallGear dial attempts in [from, to) as unified TelephonyCall rows.
 *
 * One row per operator leg (operator-side, non-coach). Sessions with no
 * operator leg (e.g. caller hung up during IVR before routing) are skipped
 * — they have no manager attribution so they wouldn't surface on the dashboard
 * anyway, and counting them inflates "набор" without an actionable owner.
 */
export async function getCallsByDate(
  from: Date,
  to: Date,
): Promise<TelephonyCall[]> {
  const [sessions, legs] = await Promise.all([
    getSessionsByDate(from, to),
    getLegsByDate(from, to),
  ]);

  const sessionById = new Map<number, CallGearSession>();
  for (const s of sessions) sessionById.set(s.id, s);

  const calls: TelephonyCall[] = [];
  const seenLegIds = new Set<number>();
  let skippedNoAgent = 0;

  for (const leg of legs) {
    if (!leg.is_operator) continue;
    if (leg.is_coach) continue;
    if (!leg.employee_id) {
      // Operator legs without an employee_id are queue/IVR rings that
      // expired before routing reached a specific operator. Counted here
      // for visibility but not emitted (no manager to attribute to).
      skippedNoAgent++;
      continue;
    }
    if (seenLegIds.has(leg.id)) continue;
    seenLegIds.add(leg.id);

    const session = sessionById.get(leg.call_session_id);
    const sessionDir: TelephonyDirection =
      session?.direction === "in"
        ? "incoming"
        : session?.direction === "out"
          ? "outgoing"
          : "unknown";

    const phone =
      leg.contact_phone_number ?? session?.contact_phone_number ?? "";
    const virtualPhone =
      leg.virtual_phone_number ?? session?.virtual_phone_number ?? "";

    const recordings = session?.call_records ?? [];
    const recordingUrl = recordings.length > 0 ? recordings[0] : null;

    calls.push({
      source: "callgear",
      externalId: `cg-leg:${leg.id}`,
      sessionId: String(leg.call_session_id),
      agentId: String(leg.employee_id),
      agentName: cleanAgentName(leg.employee_full_name),
      type: sessionDir,
      phone,
      virtualPhone,
      startedAt: parseStartedAt(leg.start_time),
      durationSec: leg.total_duration ?? 0,
      talkDurationSec: leg.duration ?? 0,
      status: classifyStatus(leg, sessionDir),
      finishReason: leg.finish_reason ?? "",
      recordingUrl,
    });
  }

  if (skippedNoAgent > 0) {
    console.log(
      `[CallGear] skipped ${skippedNoAgent} operator legs without employee_id (queue/IVR rings, no manager attribution)`,
    );
  }

  return calls;
}
