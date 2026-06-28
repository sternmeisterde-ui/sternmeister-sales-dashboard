// POST /api/analytics/webhook/cloudtalk?token=<CLOUDTALK_WEBHOOK_SECRET>
//
// Receives per-call events from CloudTalk Workflow Automations
// (Trigger: Call Ended → Action: API Request). Stores ground-truth attribution
// the public REST CDR can't give us — notably `campaign_id`, which is populated
// for Power-Dialer (campaign) calls and null for manual ones.
//
// Auth: shared secret (header `x-webhook-secret` OR `?token=`). No session —
// CloudTalk has no browser cookie. Middleware whitelists this path.
//
// Idempotent: ON CONFLICT (call_id) DO UPDATE — re-delivery / retries are safe,
// and a later re-send (e.g. once the agent sets a disposition) updates the row.
//
// Defensive: the whole body is stored in `raw` so unexpected/extra fields are
// never lost — important while we're still validating the payload shape.

import { NextRequest, NextResponse } from "next/server";
import { analyticsDb } from "@/lib/db/analytics";
import { cloudtalkCallEvents } from "@/lib/db/schema-analytics";

export const dynamic = "force-dynamic";

function str(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  return String(v);
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function POST(req: NextRequest) {
  // ── Auth ──
  const expected = process.env.CLOUDTALK_WEBHOOK_SECRET;
  if (!expected) {
    console.error("[cloudtalk webhook] CLOUDTALK_WEBHOOK_SECRET not set");
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }
  const provided =
    req.headers.get("x-webhook-secret") ?? req.nextUrl.searchParams.get("token");
  if (!provided || provided !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── Parse ──
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const callId = str(body.call_id);
  if (!callId) {
    // Without the natural key we can't dedup — log and 400 so it's visible.
    console.warn("[cloudtalk webhook] missing call_id in payload", body);
    return NextResponse.json({ error: "Missing call_id" }, { status: 400 });
  }

  const row = {
    callId,
    callUuid: str(body.call_uuid),
    externalNumber: str(body.external_number),
    internalNumber: str(body.internal_number),
    direction: str(body.direction),
    waitingTime: num(body.waiting_time),
    talkingTime: num(body.talking_time),
    wrapupTime: num(body.wrapup_time),
    agentId: str(body.agent_id),
    campaignId: str(body.campaign_id),
    campaignName: str(body.campaign_name),
    disposition: str(body.disposition),
    raw: body,
  };

  // ── Idempotent upsert ──
  try {
    await analyticsDb
      .insert(cloudtalkCallEvents)
      .values(row)
      .onConflictDoUpdate({
        target: cloudtalkCallEvents.callId,
        set: {
          callUuid: row.callUuid,
          externalNumber: row.externalNumber,
          internalNumber: row.internalNumber,
          direction: row.direction,
          waitingTime: row.waitingTime,
          talkingTime: row.talkingTime,
          wrapupTime: row.wrapupTime,
          agentId: row.agentId,
          campaignId: row.campaignId,
          campaignName: row.campaignName,
          disposition: row.disposition,
          raw: row.raw,
          updatedAt: new Date(),
        },
      });
  } catch (err) {
    // 5xx → CloudTalk will retry; the upsert stays idempotent.
    console.error("[cloudtalk webhook] db upsert failed:", err);
    return NextResponse.json({ error: "DB error" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
