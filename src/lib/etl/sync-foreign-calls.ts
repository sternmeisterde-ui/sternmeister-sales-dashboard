// ETL: pull call notes from Kommo /notes that did NOT come from CloudTalk or
// CallGear — i.e. telephony providers we don't have a direct CDR pull for
// (WhatsApp calls via Wazzup, Zadarma, …). Discovered 2026-07-10: a Ольга
// Пуховская WhatsApp call was visible in Kommo's own «Звонки» report but
// absent from analytics.communications, since sync-telephony only pulls
// CallGear+CloudTalk. Kommo /notes turned out to carry it anyway (PBX-style
// call_out note, pbxSource="WhatsApp (GPT)") — same shape amo_zadarma notes
// use for B2G.
//
// Deliberately NOT a general Kommo-notes-as-calls sync: the 2026-04-28
// hard-split (see sync-communications.ts header) removed that because it
// double-counted CloudTalk/CallGear calls that already have a CDR row. This
// step re-adds ONLY the leftover notes whose pbxSource isn't cloudtalk/
// CallGear, so there's no overlap with sync-telephony's rows.
//
// Lead/pipeline resolution is NOT done here — rows are written with
// lead_id=NULL + phone set, exactly like raw telephony CDRs, so the existing
// enrich-telephony-leads step (phone → contact → lead, Pattern A fan-out)
// picks them up on the same pass. Must run BEFORE enrichTelephonyLeads in
// runSync() for that to happen same-tick.

import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { masterManagers } from "@/lib/db/schema-existing";
import { analyticsDb } from "@/lib/db/analytics";
import { communications } from "@/lib/db/schema-analytics";
import { getAllCallNotesByDate, type CallNoteRow } from "@/lib/kommo/client";

type CommRow = typeof communications.$inferInsert;

// Sources already covered by direct CDR pull (sync-telephony.ts) — skip them
// here or every CloudTalk/CallGear call would be double-counted. Substring
// match, not exact: Kommo's PBX integrations aren't consistent about casing
// OR exact wording (seen both "cloudtalk" and "CloudTalk"; an exact Set
// lookup would misclassify a variant like "CloudTalk PBX" as foreign and
// double-insert a call sync-telephony already has).
const CDR_COVERED_SOURCE_SUBSTRINGS = ["cloudtalk", "callgear"];

function isCdrCoveredSource(pbxSource: string): boolean {
  const lower = pbxSource.toLowerCase();
  return CDR_COVERED_SOURCE_SUBSTRINGS.some((s) => lower.includes(s));
}

// A handful of legacy notes (Feb–Jul 2026, all call_status=6 "wrong_num",
// duration≈0) carry the dialed phone number in params.source instead of a
// provider name — not a real telephony source, just a misdialed number
// logged by whatever wrote the note (found during backfill 2026-07-12, see
// git history for the investigation). A genuine provider name always has a
// letter in it; a phone number never does — cheap, reliable discriminator.
function looksLikeProviderName(pbxSource: string): boolean {
  return /\p{L}/u.test(pbxSource);
}

function isForeignSource(pbxSource: string | undefined): pbxSource is string {
  if (!pbxSource) return false;
  if (isCdrCoveredSource(pbxSource)) return false;
  return looksLikeProviderName(pbxSource);
}

export interface ForeignCallsSyncResult {
  notesScanned: number;
  foreignNotes: number;
  unmatchedManagers: { kommoUserId: number; count: number }[];
  inserted: number;
}

export async function syncForeignCallNotes(
  fromDate: Date,
  toDate: Date,
): Promise<ForeignCallsSyncResult> {
  const links = await db
    .select({ id: masterManagers.id, name: masterManagers.name, kommoUserId: masterManagers.kommoUserId })
    .from(masterManagers)
    .where(eq(masterManagers.isActive, true));
  const byKommoId = new Map<number, string>();
  for (const l of links) {
    if (l.kommoUserId != null) byKommoId.set(l.kommoUserId, l.name);
  }

  const fromTs = Math.floor(fromDate.getTime() / 1000);
  const toTs = Math.floor(toDate.getTime() / 1000);
  const notes = await getAllCallNotesByDate(fromTs, toTs);

  const foreign = notes.filter((n): n is CallNoteRow & { pbxSource: string } =>
    isForeignSource(n.pbxSource),
  );

  const junkSourceCount = notes.filter(
    (n) => n.pbxSource && !isCdrCoveredSource(n.pbxSource) && !looksLikeProviderName(n.pbxSource),
  ).length;
  if (junkSourceCount > 0) {
    console.log(`[ETL foreign-calls] skipped ${junkSourceCount} notes with a phone number in pbxSource (not a real provider — see looksLikeProviderName)`);
  }

  const unmatched = new Map<number, number>();
  const rows: CommRow[] = [];
  for (const n of foreign) {
    const manager = byKommoId.get(n.createdBy) ?? byKommoId.get(n.responsibleUserId) ?? null;
    if (!manager) {
      unmatched.set(n.createdBy, (unmatched.get(n.createdBy) ?? 0) + 1);
    }
    // Normal case: phone drives enrich-telephony-leads' phone→lead resolution
    // (fills lead_id AND full pipeline/status metadata). Fallback: when a note
    // has no phone (seen on some chat-originated "calls") but IS attached
    // directly to a lead in Kommo, use that lead_id so the call isn't
    // permanently unlinked — trade-off is pipeline_id/status stay NULL since
    // this bypasses enrichment (its scan requires lead_id IS NULL), same
    // tolerated state as any other NULL-pipeline row (see CLAUDE.md gotcha #6).
    const fallbackLeadId = !n.phone && n.entityType === "lead" ? n.entityId : null;
    rows.push({
      communicationId: `kommo-note:${n.noteId}`,
      communicationType: n.type,
      entityId: null,
      createdAt: new Date(n.createdAt * 1000),
      leadId: fallbackLeadId,
      pipelineId: null,
      pipelineName: null,
      category: null,
      leadCreatedAt: null,
      leadDayStart: null,
      callStatus: n.callStatus ?? null,
      duration: n.duration,
      manager,
      statusId: null,
      statusName: null,
      utmSource: null,
      firstContactFlg: null,
      lastContactFlg: null,
      firstCallAt: null,
      businessHoursSla: null,
      businessHoursSinceCommunication: null,
      // Linkage key for enrich-telephony-leads — same phone→lead fan-out as
      // raw telephony CDRs (see file header).
      phone: n.phone ?? null,
      // Kommo /notes doesn't carry ring/queue time — only CDR providers do.
      waitSeconds: null,
      lineName: null,
      pbxSource: n.pbxSource,
    });
  }

  if (unmatched.size > 0) {
    console.warn(
      `[ETL foreign-calls] ${unmatched.size} unmatched Kommo user ids — set master_managers.kommo_user_id to attribute them:`,
    );
    for (const [kommoUserId, count] of unmatched) {
      console.warn(`  kommoUserId=${kommoUserId} ${count} calls`);
    }
  }

  if (rows.length === 0) {
    return { notesScanned: notes.length, foreignNotes: foreign.length, unmatchedManagers: [], inserted: 0 };
  }

  // DELETE-by-known-id-then-INSERT, same pattern as sync-telephony.ts —
  // tried switching this to a plain ON CONFLICT DO NOTHING insert (reasoning:
  // a Kommo note is immutable, so no need to ever refresh it) and that
  // reintroduced the exact "mixed-state CDR" bug drain-enrich-telephony.ts's
  // header describes: DO NOTHING only blocks a re-insert at the SAME
  // (comm_id, lead_id) key. Once enrichment has set a real lead_id on a
  // note, a re-sync's fresh row still carries lead_id=NULL — a DIFFERENT
  // key under the COALESCE(lead_id,0) index — so it inserts successfully
  // alongside the already-enriched row instead of being deduped, and
  // enrichment's next pass crashes trying to UPDATE that raw duplicate to
  // the same lead (unique-constraint violation, confirmed against real data
  // 2026-07-12). DELETE-by-id avoids this because it wipes EVERY existing
  // copy — raw and enriched/fanned-out alike — before the fresh INSERT, so
  // there's never more than one row per id until enrichment re-fans it out
  // (which happens same-tick, see enrichment's trigger condition in index.ts).
  const ids = rows.map((r) => r.communicationId).filter((id): id is string => Boolean(id));
  await analyticsDb.execute(
    sql`DELETE FROM analytics.communications
        WHERE communication_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
          AND communication_type IN ('call_in', 'call_out')`,
  );

  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await analyticsDb.insert(communications).values(rows.slice(i, i + CHUNK));
  }

  return {
    notesScanned: notes.length,
    foreignNotes: foreign.length,
    unmatchedManagers: [...unmatched.entries()].map(([kommoUserId, count]) => ({ kommoUserId, count })),
    inserted: rows.length,
  };
}
