// Read-only diagnostic dump for one Kommo lead.
// Pulls everything we know about a lead from analytics + D2/R2 OKK +
// (when responsible manager resolves) the matching D1/R1 roleplay window.
//
// Usage:
//   npx tsx scripts/diag-lead.ts --lead 18660538
//   npx tsx scripts/diag-lead.ts --lead 19558302 --window-days 5
//
// All queries are pure SELECT — no writes.

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { and, desc, eq, gte, sql } from "drizzle-orm";

import { analyticsDb, analyticsSchema } from "../src/lib/db/analytics";
import { d2OkkDb, r2OkkDb, okkSchema } from "../src/lib/db/okk";
import { db as d1Db, r1Db, schema as d1Schema } from "../src/lib/db";

const args = process.argv.slice(2);
function arg(name: string): string | null {
  const idx = args.indexOf(`--${name}`);
  if (idx < 0) return null;
  return args[idx + 1] ?? null;
}

const leadIdRaw = arg("lead");
if (!leadIdRaw) {
  console.error("--lead <kommo_lead_id> is required");
  process.exit(2);
}
const leadIdNum = Number(leadIdRaw);
const leadIdStr = String(leadIdRaw);
const windowDays = Number(arg("window-days") ?? "7");

function section(title: string): void {
  console.log("\n" + "═".repeat(72));
  console.log(" " + title);
  console.log("═".repeat(72));
}

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

async function main() {
  console.log(`\nDiagnostics for Kommo lead ${leadIdStr}  (window=±${windowDays}d)`);

  // ───────── 1. analytics.leads_cohort ─────────
  section("1. analytics.leads_cohort  (current snapshot)");
  const cohortRows = await analyticsDb
    .select()
    .from(analyticsSchema.leadsCohort)
    .where(eq(analyticsSchema.leadsCohort.leadId, leadIdNum));
  if (cohortRows.length === 0) {
    console.log("  ✗ NOT FOUND in analytics.leads_cohort");
  } else {
    for (const r of cohortRows) {
      console.log(`  lead_id           = ${r.leadId}`);
      console.log(`  pipeline          = ${r.pipeline}  (id=${r.pipelineId})`);
      console.log(`  status            = ${r.status}  (id=${r.statusId}, order=${r.statusOrder})`);
      console.log(`  manager           = ${r.manager}  (responsible_user_id=${r.responsibleUserId})`);
      console.log(`  created_at        = ${fmtDate(r.createdAt)}`);
      console.log(`  contact_date      = ${fmtDate(r.contactDate)}`);
      console.log(`  closed_at         = ${fmtDate(r.closedAt)}`);
      console.log(`  loss_reason       = ${r.lossReason ?? "—"}  (id=${r.lossReasonId ?? "—"})`);
      console.log(`  category          = ${r.category ?? "—"}`);
      console.log(`  budget            = ${r.budget ?? "—"}`);
    }
  }

  // ───────── 2. analytics.lead_status_changes ─────────
  section("2. analytics.lead_status_changes  (chronological)");
  const transitions = await analyticsDb
    .select()
    .from(analyticsSchema.leadStatusChanges)
    .where(eq(analyticsSchema.leadStatusChanges.leadId, leadIdNum))
    .orderBy(analyticsSchema.leadStatusChanges.eventAt);
  if (transitions.length === 0) {
    console.log("  (no status changes recorded)");
  } else {
    for (const t of transitions) {
      console.log(
        `  ${fmtDate(t.eventAt)}  ${(t.pipeline ?? "?").padEnd(20)}  → ${(t.status ?? "?").padEnd(28)}  by ${t.manager ?? "?"}`,
      );
    }
  }

  // ───────── 3. analytics.communications ─────────
  section("3. analytics.communications  (chronological)");
  const comms = await analyticsDb
    .select()
    .from(analyticsSchema.communications)
    .where(eq(analyticsSchema.communications.leadId, leadIdNum))
    .orderBy(analyticsSchema.communications.createdAt);
  if (comms.length === 0) {
    console.log("  (no comms recorded)");
  } else {
    for (const c of comms) {
      const dir = c.callStatus !== null && c.callStatus !== undefined ? `cs=${c.callStatus}` : "";
      const dur = c.duration !== null && c.duration !== undefined ? `${c.duration}s` : "—";
      console.log(
        `  ${fmtDate(c.createdAt)}  ${(c.communicationType ?? "?").padEnd(10)}  ${(c.statusName ?? "?").padEnd(28)}  ${(c.manager ?? "?").padEnd(20)}  ${dir.padEnd(6)}  dur=${dur}  comm_id=${c.communicationId ?? "—"}`,
      );
    }
  }

  // ───────── 4. analytics.sla ─────────
  section("4. analytics.sla  (lead-level SLA snapshot)");
  const slaRows = await analyticsDb
    .select()
    .from(analyticsSchema.sla)
    .where(eq(analyticsSchema.sla.leadId, leadIdNum));
  if (slaRows.length === 0) {
    console.log("  (no SLA row)");
  } else {
    for (const s of slaRows) {
      console.log(`  sla_start         = ${fmtDate(s.slaStart)}`);
      console.log(`  first_contact_at  = ${fmtDate(s.firstContactAt)}`);
      console.log(`  last_contact_at   = ${fmtDate(s.lastContactAt)}`);
      console.log(`  first_call_out_at = ${fmtDate(s.firstCallOutAt)}`);
      console.log(`  is_waiting        = ${s.isWaiting}   is_waiting_call=${s.isWaitingCall}`);
      console.log(`  sla_status        = ${s.slaStatus}`);
    }
  }

  // ───────── 5. OKK calls — D2 (B2G) and R2 (B2B) ─────────
  for (const [deptLabel, db] of [
    ["D2  (B2G)", d2OkkDb],
    ["R2  (B2B)", r2OkkDb],
  ] as const) {
    section(`5. OKK ${deptLabel}  ·  calls + evaluations for kommo_lead_id=${leadIdStr}`);
    let rows: Array<{
      id: string;
      managerId: string | null;
      managerName: string | null;
      callCreatedAt: Date | null;
      durationSeconds: number | null;
      direction: string | null;
      status: string | null;
      kommoStatusName: string | null;
      kommoStatusId: string | null;
      kommoPipelineId: string | null;
      promptType: string | null;
      totalScore: number | null;
      overrideMetadata: unknown;
      modelUsed: string | null;
      evaluatedAt: Date | null;
    }>;
    try {
      rows = await db
        .select({
          id: okkSchema.okkCalls.id,
          managerId: okkSchema.okkCalls.managerId,
          managerName: okkSchema.okkCalls.managerName,
          callCreatedAt: okkSchema.okkCalls.callCreatedAt,
          durationSeconds: okkSchema.okkCalls.durationSeconds,
          direction: okkSchema.okkCalls.direction,
          status: okkSchema.okkCalls.status,
          kommoStatusName: okkSchema.okkCalls.kommoStatusName,
          kommoStatusId: okkSchema.okkCalls.kommoStatusId,
          kommoPipelineId: okkSchema.okkCalls.kommoPipelineId,
          promptType: okkSchema.okkEvaluations.promptType,
          totalScore: okkSchema.okkEvaluations.totalScore,
          overrideMetadata: okkSchema.okkEvaluations.overrideMetadata,
          modelUsed: okkSchema.okkEvaluations.modelUsed,
          evaluatedAt: okkSchema.okkCalls.evaluatedAt,
        })
        .from(okkSchema.okkCalls)
        .leftJoin(
          okkSchema.okkEvaluations,
          eq(okkSchema.okkEvaluations.callId, okkSchema.okkCalls.id),
        )
        .where(eq(okkSchema.okkCalls.kommoLeadId, leadIdStr))
        .orderBy(desc(okkSchema.okkCalls.callCreatedAt));
    } catch (err) {
      console.log(`  ✗ query failed: ${(err as Error).message}`);
      continue;
    }

    if (rows.length === 0) {
      console.log("  (no calls for this lead)");
      continue;
    }
    for (const r of rows) {
      console.log("");
      console.log(`  call_id           = ${r.id}`);
      console.log(`  call_created_at   = ${fmtDate(r.callCreatedAt)}`);
      console.log(`  evaluated_at      = ${fmtDate(r.evaluatedAt)}`);
      console.log(`  manager           = ${r.managerName}  (${r.managerId ?? "—"})`);
      console.log(`  direction/dur     = ${r.direction ?? "?"}  ${r.durationSeconds ?? "?"}s`);
      console.log(`  call.status       = ${r.status ?? "?"}`);
      console.log(`  kommo_status (@call sync) = ${r.kommoStatusName ?? "?"}  (id=${r.kommoStatusId ?? "?"}, pipeline=${r.kommoPipelineId ?? "?"})`);
      console.log(`  prompt_type       = ${r.promptType ?? "(no eval)"}`);
      console.log(`  total_score       = ${r.totalScore ?? "—"}`);
      console.log(`  model_used        = ${r.modelUsed ?? "—"}`);
      if (r.overrideMetadata) {
        console.log(`  override_metadata = ${JSON.stringify(r.overrideMetadata)}`);
      } else {
        console.log(`  override_metadata = —`);
      }

      // Look up manager's line in OKK managers table
      if (r.managerId) {
        const mgr = await db
          .select({
            name: okkSchema.okkManagers.name,
            role: okkSchema.okkManagers.role,
            line: okkSchema.okkManagers.line,
            isActive: okkSchema.okkManagers.isActive,
            telegramId: okkSchema.okkManagers.telegramId,
          })
          .from(okkSchema.okkManagers)
          .where(eq(okkSchema.okkManagers.id, r.managerId))
          .limit(1);
        if (mgr[0]) {
          console.log(
            `  okk.manager.line  = ${mgr[0].line ?? "—"}  role=${mgr[0].role ?? "—"}  active=${mgr[0].isActive}  tg=${mgr[0].telegramId ?? "—"}`,
          );
        }
      }
    }
  }

  // ───────── 6. master_managers via responsible_user_id ─────────
  section("6. master_managers  (responsible manager of the lead)");
  const responsibleUserId = cohortRows[0]?.responsibleUserId ?? null;
  let masterMgrTelegramId: string | null = null;
  let masterMgrTeam: string | null = null;
  let masterMgrLine: string | null = null;
  let masterMgrDept: string | null = null;
  let masterMgrName: string | null = null;
  if (!responsibleUserId) {
    console.log("  (no responsible_user_id in leads_cohort)");
  } else {
    const mm = await d1Db
      .select()
      .from(d1Schema.masterManagers)
      .where(eq(d1Schema.masterManagers.kommoUserId, Number(responsibleUserId)))
      .limit(2);
    if (mm.length === 0) {
      console.log(`  ✗ no master_managers row for kommo_user_id=${responsibleUserId}`);
    } else {
      for (const m of mm) {
        masterMgrTelegramId = m.telegramId;
        masterMgrTeam = m.team;
        masterMgrLine = m.line;
        masterMgrDept = m.department;
        masterMgrName = m.name;
        console.log(`  name              = ${m.name}`);
        console.log(`  department        = ${m.department}   team=${m.team}`);
        console.log(`  role/line         = ${m.role} / ${m.line ?? "—"}`);
        console.log(`  in_okk / in_rolevki = ${m.inOkk} / ${m.inRolevki}`);
        console.log(`  active            = ${m.isActive}`);
        console.log(`  telegram          = @${m.telegramUsername ?? "?"}  (id=${m.telegramId ?? "—"})`);
        console.log(`  kommo_user_id     = ${m.kommoUserId}`);
      }
    }
  }

  // ───────── 7. Roleplay calls for that manager in window ─────────
  section(
    `7. Roleplay calls for responsible manager  (window: last ${windowDays}d)`,
  );
  if (!masterMgrTelegramId) {
    console.log("  (skipped — no telegram_id from master_managers)");
  } else {
    const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000);
    const isB2b = masterMgrDept === "b2b" || masterMgrTeam === "ruzanna";
    const rpDb = isB2b ? r1Db : d1Db;
    const usersTbl = isB2b ? d1Schema.r1Users : d1Schema.d1Users;
    const callsTbl = isB2b ? d1Schema.r1Calls : d1Schema.d1Calls;
    const dbLabel = isB2b ? "R1 (B2B)" : "D1 (B2G)";

    const userRow = await rpDb
      .select({
        id: usersTbl.id,
        name: usersTbl.name,
        telegramId: usersTbl.telegramId,
        telegramUsername: usersTbl.telegramUsername,
        isActive: usersTbl.isActive,
        line: usersTbl.line,
        role: usersTbl.role,
      })
      .from(usersTbl)
      .where(eq(usersTbl.telegramId, masterMgrTelegramId))
      .limit(1);

    if (userRow.length === 0) {
      console.log(
        `  ✗ no row in ${dbLabel}.${isB2b ? "r1_users" : "d1_users"} for telegram_id=${masterMgrTelegramId}`,
      );
      console.log(
        `    (manager may be missing from roleplay DB — check sync from master_managers)`,
      );
    } else {
      const u = userRow[0]!;
      console.log(
        `  ${dbLabel} user: ${u.name}  (uuid=${u.id}, tg=${u.telegramId}, active=${u.isActive}, line=${u.line ?? "—"}, role=${u.role})`,
      );

      const rpCalls = await rpDb
        .select({
          id: callsTbl.id,
          startedAt: callsTbl.startedAt,
          endedAt: callsTbl.endedAt,
          durationSeconds: callsTbl.durationSeconds,
          callType: callsTbl.callType,
          score: callsTbl.score,
          avatarId: callsTbl.avatarId,
          hasTranscript: sql<boolean>`(${callsTbl.transcript} IS NOT NULL)`,
          hasEval: sql<boolean>`(${callsTbl.evaluationJson} IS NOT NULL)`,
          grokSessionId: callsTbl.grokSessionId,
          recordingPath: callsTbl.recordingPath,
        })
        .from(callsTbl)
        .where(and(eq(callsTbl.userId, u.id), gte(callsTbl.startedAt, since)))
        .orderBy(desc(callsTbl.startedAt));

      if (rpCalls.length === 0) {
        console.log(
          `  ✗ NO roleplay calls in last ${windowDays} days for ${masterMgrName}`,
        );
      } else {
        console.log(`  ${rpCalls.length} roleplay call(s) found:`);
        for (const c of rpCalls) {
          console.log(
            `    ${fmtDate(c.startedAt)}  → ${fmtDate(c.endedAt)}  ${String(c.durationSeconds ?? "?").padStart(4)}s  type=${(c.callType ?? "?").padEnd(10)}  score=${c.score ?? "—"}  tr=${c.hasTranscript ? "y" : "n"}  eval=${c.hasEval ? "y" : "n"}  avatar=${c.avatarId ?? "?"}  rec=${c.recordingPath ? "y" : "n"}  id=${c.id.slice(0, 8)}`,
          );
        }
      }
    }
  }

  console.log("\nDone.\n");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
  });
