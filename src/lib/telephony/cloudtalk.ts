// CloudTalk API client (Basic Auth).
// Docs: https://support.cloudtalk.io/article/14-cloudtalk-api
//
// Endpoint: /api/calls/index.json — paginated CDR list keyed by date_from /
// date_to (inclusive, account TZ). Each item bundles Cdr + Agent + CallNumber
// + Notes + Tags. We emit one TelephonyCall per Cdr — CloudTalk doesn't have
// CallGear's leg/session split, so the model is simpler.

import type {
  TelephonyCall,
  TelephonyDirection,
  TelephonyStatus,
} from "./types";

const CLOUDTALK_API_BASE = "https://my.cloudtalk.io/api";
const PAGE_LIMIT = 1000;
const MAX_RETRIES = 3;

interface CloudTalkCdr {
  id: string;
  type: "incoming" | "outgoing";
  billsec: string;
  talking_time: string;
  public_external: string;
  public_internal: string;
  user_id: string | null;
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
  waiting_time: number | string;
  wrapup_time: number | string;
  recorded: boolean;
  is_voicemail: boolean;
  recording_link?: string;
}

interface CloudTalkAgent {
  id: string | null;
  fullname: string;
  firstname?: string;
  lastname?: string;
  email?: string;
}

interface CloudTalkCall {
  Cdr: CloudTalkCdr;
  Agent: CloudTalkAgent;
}

interface CloudTalkResponse {
  responseData: {
    itemsCount: number;
    pageCount: number;
    pageNumber: number;
    limit: number;
    data: CloudTalkCall[];
  };
}

function authHeader(): string {
  const id = process.env.CLOUDTALK_API_ID;
  const secret = process.env.CLOUDTALK_API_SECRET;
  if (!id || !secret) {
    throw new Error(
      "CLOUDTALK_API_ID / CLOUDTALK_API_SECRET not set — required for CloudTalk sync",
    );
  }
  return `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
}

// CloudTalk wants "YYYY-MM-DD HH:MM:SS" in account TZ. We pass UTC and trust
// the join semantics — Cdr.started_at is returned with explicit offset, so
// timestamps round-trip without ambiguity.
function fmtDateTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

async function fetchPage(
  from: Date,
  to: Date,
  page: number,
): Promise<CloudTalkResponse["responseData"]> {
  const params = new URLSearchParams({
    date_from: fmtDateTime(from),
    date_to: fmtDateTime(to),
    limit: String(PAGE_LIMIT),
    page: String(page),
  });
  const url = `${CLOUDTALK_API_BASE}/calls/index.json?${params.toString()}`;
  const auth = authHeader();

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: auth, Accept: "application/json" },
      });

      if (res.status === 429 || res.status >= 500) {
        const wait = 500 * 2 ** attempt;
        console.warn(
          `[CloudTalk] HTTP ${res.status}, retrying in ${wait}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
        );
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }

      if (!res.ok) {
        throw new Error(`CloudTalk HTTP ${res.status}`);
      }

      const json = (await res.json()) as CloudTalkResponse;
      return json.responseData;
    } catch (err) {
      lastErr = err as Error;
      if (attempt === MAX_RETRIES - 1) break;
      const wait = 500 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr ?? new Error("CloudTalk fetch failed after retries");
}

function parseStartedAt(s: string): Date {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return new Date();
  return d;
}

function classifyStatus(cdr: CloudTalkCdr): TelephonyStatus {
  const talk = Number(cdr.talking_time) || 0;
  if (talk > 0) return "answered";
  if (cdr.is_voicemail) return cdr.type === "incoming" ? "missed" : "no_answer";
  return cdr.type === "incoming" ? "missed" : "no_answer";
}

function cleanAgentName(raw: string | null | undefined): string | null {
  if (!raw || raw === "(unknown)") return null;
  return raw.replace(/\s+/g, " ").trim() || null;
}

export interface CloudTalkAgentRecord {
  id: string;
  firstname: string | null;
  lastname: string | null;
  email: string | null;
  default_number: string | null;
  availability_status: string | null;
}

/**
 * List CloudTalk agents. Used by /api/managers to auto-resolve
 * `master_managers.cloudtalk_agent_id` by name/email at save time, mirroring
 * the CallGear `getEmployees()` and Kommo `getUsers()` flows. Paginated but
 * agents are typically <50 per account so we walk to completion.
 */
export async function getAgents(): Promise<CloudTalkAgentRecord[]> {
  const auth = authHeader();
  const all: CloudTalkAgentRecord[] = [];
  const MAX_PAGES = 20;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${CLOUDTALK_API_BASE}/agents/index.json?limit=${PAGE_LIMIT}&page=${page}`;

    let lastErr: Error | null = null;
    let resp: { data: { Agent: CloudTalkAgentRecord }[]; pageCount: number } | null = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(url, {
          headers: { Authorization: auth, Accept: "application/json" },
        });
        if (res.status === 429 || res.status >= 500) {
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
          continue;
        }
        if (!res.ok) throw new Error(`CloudTalk agents HTTP ${res.status}`);
        const json = (await res.json()) as {
          responseData: { data: { Agent: CloudTalkAgentRecord }[]; pageCount: number };
        };
        resp = json.responseData;
        break;
      } catch (err) {
        lastErr = err as Error;
        if (attempt === MAX_RETRIES - 1) break;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
    if (!resp) throw lastErr ?? new Error("CloudTalk agents fetch failed");

    for (const item of resp.data ?? []) {
      if (item.Agent?.id) all.push(item.Agent);
    }
    if (page >= resp.pageCount) break;
  }
  return all;
}

export async function getCallsByDate(
  from: Date,
  to: Date,
): Promise<TelephonyCall[]> {
  const calls: TelephonyCall[] = [];
  let skippedNoAgent = 0;

  // CloudTalk caps `pageCount` based on the date range size — we just keep
  // walking until we get a short page or the API stops returning data.
  const MAX_PAGES = 100;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const resp = await fetchPage(from, to, page);
    const items = resp.data ?? [];

    for (const item of items) {
      const cdr = item.Cdr;
      const agent = item.Agent;

      // CloudTalk emits one CDR per missed inbound where no agent picked up.
      // user_id null + Agent.id null ⇒ no attribution possible. Logged but
      // not emitted (we'd produce a row that the dashboard can't show
      // anywhere because per-master breakdown groups by manager NAME).
      const agentId = cdr.user_id ?? agent.id ?? null;
      if (!agentId) {
        skippedNoAgent++;
        continue;
      }

      const direction: TelephonyDirection =
        cdr.type === "incoming"
          ? "incoming"
          : cdr.type === "outgoing"
            ? "outgoing"
            : "unknown";

      const billsec = Number(cdr.billsec) || 0;
      const talk = Number(cdr.talking_time) || 0;
      // CloudTalk gives an exact ring/queue time before pickup.
      const wait = Math.max(0, Number(cdr.waiting_time) || 0);

      calls.push({
        source: "cloudtalk",
        externalId: `ct:${cdr.id}`,
        sessionId: cdr.id,
        agentId: String(agentId),
        agentName: cleanAgentName(agent.fullname),
        type: direction,
        phone: cdr.public_external ?? "",
        virtualPhone: cdr.public_internal ?? "",
        startedAt: parseStartedAt(cdr.started_at),
        durationSec: billsec,
        talkDurationSec: talk,
        waitSec: wait,
        status: classifyStatus(cdr),
        finishReason: cdr.is_voicemail ? "voicemail" : "",
        recordingUrl: cdr.recorded && cdr.recording_link ? cdr.recording_link : null,
      });
    }

    if (items.length < PAGE_LIMIT) break;
    if (page >= resp.pageCount) break;
  }

  if (skippedNoAgent > 0) {
    console.log(
      `[CloudTalk] skipped ${skippedNoAgent} calls without agent attribution (queue rings, no agent picked up)`,
    );
  }

  return calls;
}
