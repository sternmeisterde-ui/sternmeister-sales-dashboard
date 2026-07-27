// CloudTalk internal dashboard API (undocumented) — the only source that exposes
// agent PRESENCE with a reason. The public API (`/agents/index.json`, see
// cloudtalk.ts) collapses every idle reason into a single "paused", so it can't
// answer «обед или встреча?» — which is exactly what the Активность timeline needs.
//
// Auth mirrors what dialer-sync already runs in production hourly
// (`dialer-sync/src/dialer_sync/attribution.py`): POST credentials to
// auth.cloudtalk.io, get a ~1h Bearer, call dashboard-api.cloudtalk.io/graphql.
//
// ⚠ Undocumented API. Every quirk below was found by probing our own account
// (2026-07-28) and each one answers HTTP 200 with INTERNAL_SERVER_ERROR when
// violated — no useful message, so they're easy to mistake for an outage:
//   1. `users` with no arguments → 500. Needs at least `input: {}`.
//   2. `input` passed as a GraphQL VARIABLE → 500. Literal in the query only.
//   3. selecting the `role` field → 500 (enum serialisation blows up).
//   4. page size is capped at 20 regardless of `limit` → walk with `offset`.
// See dev_docs/specs/26-СТАТУСЫ-МЕНЕДЖЕРОВ-ИЗ-CLOUDTALK.md.

const AUTH_URL =
  "https://auth.cloudtalk.io/ct-auth/api/auth/login/credentials/password";
const GQL_URL = "https://dashboard-api.cloudtalk.io/graphql";
const ORIGIN = "https://dashboard.cloudtalk.io";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

// Server-side page cap — asking for more silently returns 20.
const PAGE_SIZE = 20;
const MAX_PAGES = 20; // 400 agents; we have 25
// Token lives ~1h; refresh early so a tick never races the expiry.
const TOKEN_TTL_MS = 50 * 60_000;

/** Presence as CloudTalk models it. `on_call` is a distinct state, not a flavour of online. */
export type CloudTalkPresence = "online" | "offline" | "idle" | "on_call";

/**
 * Idle sub-status dictionary. NOT available from any API — CloudTalk exposes
 * only the numeric id. Mapped empirically 2026-07-28 by setting each status in
 * CloudTalk Phone and reading the API back. The five standard ones are
 * consecutive (17→21); 7 and 11 also occur on this account as leftovers of
 * custom statuses created before the standard set — names unknown.
 */
export const IDLE_STATUS_NAMES: Record<number, string> = {
  17: "Занят",
  18: "Перерыв",
  19: "Обед",
  20: "Встреча",
  21: "Обучение",
};

export interface AgentPresence {
  agentId: number;          // CloudTalk user id == master_managers.cloudtalk_agent_id
  fullName: string;
  status: CloudTalkPresence;
  /**
   * Idle reason id — meaningful ONLY when `status === "idle"`.
   * CloudTalk keeps `agentStatusTypeId` populated with the LAST idle status the
   * agent picked, even long after they went offline. Reading it unconditionally
   * paints a permanent "обед" on half the team, so it's nulled out here for
   * every non-idle state rather than left for callers to remember.
   */
  idleTypeId: number | null;
  idleName: string | null;
}

interface GqlUserRow {
  id: number;
  fullName: string | null;
  onlineStatus: string | null;
  agentStatusTypeId: number | null;
}

export class CloudTalkDashboardError extends Error {}

function credentials(): { email: string; password: string } {
  const email = process.env.CT_DASHBOARD_EMAIL;
  // Base64 to match dialer-sync's env contract (avoids shell-quoting pain in
  // Dokploy); plain-text var accepted as a fallback.
  const b64 = process.env.CT_DASHBOARD_PASSWORD_B64;
  const plain = process.env.CT_DASHBOARD_PASSWORD;
  const password = b64 ? Buffer.from(b64, "base64").toString("utf8") : plain;
  if (!email || !password) {
    throw new CloudTalkDashboardError(
      "CT_DASHBOARD_EMAIL / CT_DASHBOARD_PASSWORD_B64 not set — required for CloudTalk status sync",
    );
  }
  return { email, password };
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function login(): Promise<string> {
  const { email, password } = credentials();
  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Origin: ORIGIN,
      Referer: `${ORIGIN}/`,
      "User-Agent": UA,
    },
    body: JSON.stringify({ email, password, source: "dashboard" }),
  });
  if (!res.ok) {
    throw new CloudTalkDashboardError(`CloudTalk login HTTP ${res.status}`);
  }
  const json = (await res.json()) as { data?: { accessToken?: string } };
  const token = json?.data?.accessToken;
  if (!token) {
    throw new CloudTalkDashboardError("CloudTalk login: no accessToken in response");
  }
  cachedToken = { token, expiresAt: Date.now() + TOKEN_TTL_MS };
  return token;
}

async function getToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh && cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.token;
  }
  return login();
}

/**
 * One GraphQL call. `?op=` mirrors what the CloudTalk UI sends — harmless if the
 * gateway ignores it, and it makes their access logs readable on our side.
 * Retries once on 401 with a fresh token (session expired mid-tick).
 */
async function gql<T>(opName: string, query: string): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken(attempt > 0);
    const res = await fetch(`${GQL_URL}?op=${opName}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: ORIGIN,
        Referer: `${ORIGIN}/`,
        "User-Agent": UA,
      },
      body: JSON.stringify({ operationName: opName, query }),
    });
    if (res.status === 401 && attempt === 0) {
      cachedToken = null;
      continue;
    }
    if (!res.ok) {
      throw new CloudTalkDashboardError(`CloudTalk GraphQL HTTP ${res.status}`);
    }
    const json = (await res.json()) as { data?: T; errors?: Array<{ message?: string }> };
    if (json.errors?.length) {
      // INTERNAL_SERVER_ERROR here almost always means the query violated one of
      // the four quirks documented at the top of this file, not a CloudTalk outage.
      throw new CloudTalkDashboardError(
        `CloudTalk GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`,
      );
    }
    if (!json.data) {
      throw new CloudTalkDashboardError("CloudTalk GraphQL: empty data");
    }
    return json.data;
  }
  throw new CloudTalkDashboardError("CloudTalk GraphQL: unauthorized after re-login");
}

function normalizeStatus(raw: string | null): CloudTalkPresence | null {
  switch (raw) {
    case "ONLINE": return "online";
    case "OFFLINE": return "offline";
    case "IDLE": return "idle";
    case "ON_CALL": return "on_call";
    default: return null;
  }
}

/**
 * Current presence of every agent in the account.
 *
 * Pagination is mandatory, not an optimisation: the server caps a page at 20
 * rows whatever `limit` says, so a single call silently drops everyone past the
 * 20th agent (that's how a live manager went missing from the first probe).
 */
export async function fetchAgentPresence(): Promise<AgentPresence[]> {
  const out: AgentPresence[] = [];
  let offset = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    // Literal input on purpose — passing it as a GraphQL variable 500s (quirk 2).
    const data = await gql<{ users?: { totalCount: number; data: GqlUserRow[] } }>(
      "DashboardUsersPresence",
      `query DashboardUsersPresence {
        users(input: { limit: ${PAGE_SIZE}, offset: ${offset} }) {
          totalCount
          data { id fullName onlineStatus agentStatusTypeId }
        }
      }`,
    );
    const rows = data.users?.data ?? [];
    for (const row of rows) {
      const status = normalizeStatus(row.onlineStatus);
      if (!status || !row.id) continue;
      const isIdle = status === "idle";
      const idleTypeId = isIdle ? row.agentStatusTypeId ?? null : null;
      out.push({
        agentId: Number(row.id),
        fullName: (row.fullName ?? "").replace(/\s+/g, " ").trim(),
        status,
        idleTypeId,
        idleName: idleTypeId != null ? IDLE_STATUS_NAMES[idleTypeId] ?? null : null,
      });
    }
    offset += rows.length;
    if (rows.length < PAGE_SIZE) break;
    if (data.users?.totalCount != null && offset >= data.users.totalCount) break;
  }

  return out;
}
