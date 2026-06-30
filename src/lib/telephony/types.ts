// Unified telephony call shape — produced by CallGear and CloudTalk clients,
// consumed by the ETL writer that lands rows into analytics.communications.
//
// One TelephonyCall row = one dial attempt by one operator. For multi-leg
// sessions (e.g. routing tree, transfer) each operator that participated
// gets their own row, attributed via agentId.

export type TelephonySource = "callgear" | "cloudtalk";

export type TelephonyDirection = "incoming" | "outgoing" | "unknown";

// Coarse-grained outcome buckets, normalised across providers. The original
// provider-specific reason is preserved in `finishReason` for debugging.
export type TelephonyStatus =
  | "answered"   // operator + caller actually talked (talk_duration > 0)
  | "no_answer"  // rang but no one picked up on the operator side
  | "busy"
  | "failed"     // technical failure (e.g. operator_disconnects, network)
  | "missed"     // inbound that no operator answered
  | "unknown";

export type TelephonyCall = {
  source: TelephonySource;

  // Stable per-leg identifier. Distinct across providers via `cg-leg:` /
  // `ct:` prefix so analytics.communications.communication_id can carry it
  // without colliding with Kommo note ids.
  externalId: string;

  // Underlying session (multiple legs share the same sessionId — e.g. an
  // inbound that hunts through 3 operators has one sessionId, three legs).
  sessionId: string;

  // Operator on this leg, mapped to master_managers via callgearEmployeeId
  // / cloudtalkAgentId. Null when the leg has no assigned operator
  // (e.g. caller hung up before routing reached anyone).
  agentId: string | null;
  agentName: string | null;

  type: TelephonyDirection;
  phone: string;          // remote party (caller / dialed) E.164-ish
  virtualPhone: string;   // company DID

  startedAt: Date;
  durationSec: number;    // total leg duration (rings + talk + wrap, provider-defined)
  talkDurationSec: number; // pure conversation seconds (0 for not-connected)
  // Seconds the caller waited before someone picked up (ring/queue time).
  //   • CloudTalk — exact `waiting_time` field.
  //   • CallGear  — approximated as max(0, durationSec - talkDurationSec),
  //                 since there's no dedicated wait field (includes wrap-up).
  // Drives the "Ожидание (сек)" KPI tile on the B2B dashboard.
  waitSec: number;

  // CloudTalk CallNumber.internal_name — the human name of the company line
  // used (e.g. "KOM mobile 2", "GOS landline 3"). Carries the department.
  // null for CallGear (no equivalent field) and for any provider without it.
  lineName: string | null;

  // True when no operator was attached to the call (CloudTalk user_id/Agent.id
  // null — queue ring / missed inbound nobody answered). These are dropped from
  // per-agent metrics but counted in inbound-by-line (CloudTalk's group model).
  noAgent: boolean;

  status: TelephonyStatus;
  finishReason: string;   // raw provider reason (debug)

  recordingUrl: string | null;
};
