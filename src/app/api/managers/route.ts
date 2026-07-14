import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { masterManagers, d1Users, r1Users } from "@/lib/db/schema-existing";
import { getDbForDepartment } from "@/lib/db/index";
import { getOkkDbForDepartment } from "@/lib/db/okk";
import { okkManagers, okkCalls } from "@/lib/db/schema-okk";
import { eq, and, ne, notInArray, desc, sql, or, inArray } from "drizzle-orm";
import { resolveTelegramUsername } from "@/lib/telegram/resolve";
import { getUsers as getKommoUsers } from "@/lib/kommo/client";
import { getEmployees as getCallGearEmployees } from "@/lib/telephony/callgear";
import { getAgents as getCloudTalkAgents } from "@/lib/telephony/cloudtalk";

// Cap save latency: a save runs Telegram MTProto resolve + Kommo getUsers +
// CallGear get.employees + CloudTalk /agents/index.json sequentially in the
// worst case. Each provider can rate-limit and retry up to 3× with backoff,
// pushing total time toward 20s under contention. Past 30s the runtime
// kills the request and the admin sees a confusing 504 instead of a
// best-effort save with warnings.
export const maxDuration = 30;

// ─── GET: fetch managers for department ───────────────────────

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session || session.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const dept = request.nextUrl.searchParams.get("department") === "b2b" ? "b2b" : "b2g";
    const okkDept = dept === "b2g" ? "d2" : "r2";

    // Lazy OKK → master pull. cloudtalk_agent_id / callgear_employee_id are
    // born in OKK (populated by CloudTalk/CallGear webhooks on the first
    // matched call via OKK/src/webhook/*.ts). Nothing automatically writes
    // them back to master_managers — the reverse-sync in syncToTargets()
    // only fires on manual Save. So between webhook auto-link and next Save,
    // master has null while OKK has the real ID.
    //
    // Fix: on every open of the Managers tab, silently merge any OKK-known
    // IDs into master rows that are still null. Error-isolated so an OKK
    // outage never blocks the admin view.
    await pullTelephonyIdsFromOkk(dept, okkDept).catch((err) => {
      console.warn("[Managers API GET] pull-from-okk failed (non-fatal):", err);
    });

    // Admins are intentionally excluded from the Managers tab — the bot
    // grants them access via role='admin' rows in d1_users/r1_users that are
    // not mirrored into master_managers, so the bulk save flow must never
    // touch them. Keeping them off the list also prevents accidental edits.
    const rows = await db
      .select()
      .from(masterManagers)
      .where(and(
        eq(masterManagers.department, dept),
        eq(masterManagers.isActive, true),
        ne(masterManagers.role, "admin"),
      ))
      .orderBy(masterManagers.name);

    return NextResponse.json({ success: true, data: rows });
  } catch (error) {
    console.error("[Managers API GET]", error);
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * Pull telephony IDs from OKK managers into master_managers for the given
 * department. Only touches master rows where the field is NULL — never
 * overwrites an existing value (master wins on conflict, same precedence as
 * the merge rule inside syncToTargets).
 *
 * Match order, high-to-low confidence:
 *   1. master.kommoUserId  ↔  okkManagers.kommoUserId   (both non-null, exact)
 *   2. master.telegramId   ↔  okkManagers.telegramId    (both non-null, exact)
 *   3. master.name (trimmed) ↔ okkManagers.name (trimmed) within same dept
 */
async function pullTelephonyIdsFromOkk(
  dept: "b2g" | "b2b",
  okkDept: "d2" | "r2",
): Promise<void> {
  const okkDb = getOkkDbForDepartment(dept);

  // Only pull for managers who opted in to OKK sync and are missing at least one ID.
  const masterRows = await db
    .select({
      id: masterManagers.id,
      name: masterManagers.name,
      kommoUserId: masterManagers.kommoUserId,
      telegramId: masterManagers.telegramId,
      callgearEmployeeId: masterManagers.callgearEmployeeId,
      cloudtalkAgentId: masterManagers.cloudtalkAgentId,
    })
    .from(masterManagers)
    .where(
      and(
        eq(masterManagers.department, dept),
        eq(masterManagers.isActive, true),
        eq(masterManagers.inOkk, true),
      ),
    );

  const needsPull = masterRows.filter(
    (m) => m.callgearEmployeeId === null || m.cloudtalkAgentId === null,
  );
  if (needsPull.length === 0) return;

  const okkRows = await okkDb
    .select({
      id: okkManagers.id,
      name: okkManagers.name,
      kommoUserId: okkManagers.kommoUserId,
      telegramId: okkManagers.telegramId,
      callgearEmployeeId: okkManagers.callgearEmployeeId,
      cloudtalkAgentId: okkManagers.cloudtalkAgentId,
    })
    .from(okkManagers)
    .where(and(eq(okkManagers.department, okkDept), eq(okkManagers.isActive, true)));

  const byKommo = new Map<number, typeof okkRows[number]>();
  const byTg = new Map<string, typeof okkRows[number]>();
  const byName = new Map<string, typeof okkRows[number]>();
  for (const r of okkRows) {
    if (r.kommoUserId) byKommo.set(r.kommoUserId, r);
    if (r.telegramId) byTg.set(r.telegramId, r);
    if (r.name) byName.set(r.name.trim(), r);
  }

  for (const m of needsPull) {
    const match =
      (m.kommoUserId && byKommo.get(m.kommoUserId)) ||
      (m.telegramId && byTg.get(m.telegramId)) ||
      byName.get(m.name.trim()) ||
      null;
    if (!match) continue;

    const nextCg = m.callgearEmployeeId ?? match.callgearEmployeeId ?? null;
    const nextCt = m.cloudtalkAgentId ?? match.cloudtalkAgentId ?? null;
    if (nextCg === m.callgearEmployeeId && nextCt === m.cloudtalkAgentId) continue;

    await db
      .update(masterManagers)
      .set({
        callgearEmployeeId: nextCg,
        cloudtalkAgentId: nextCt,
        updatedAt: new Date(),
      })
      .where(eq(masterManagers.id, m.id));

    console.log(
      `[Managers API GET] pulled OKK IDs for "${m.name}" (dept=${dept}): cg=${nextCg}, ct=${nextCt}`,
    );
  }
}

// ─── POST: save all changes + sync to target tables ───────────

interface ManagerInput {
  id?: string;
  name: string;
  telegramUsername: string | null;
  telegramId: string | null;
  kommoUserId: number | null;
  // Optional — webhooks auto-fill these; UI doesn't edit them directly.
  // If absent, we preserve the master_managers existing value.
  callgearEmployeeId?: string | null;
  cloudtalkAgentId?: string | null;
  shiftStartTime?: string | null;
  // Per-day payroll rate. Stringified to match drizzle's numeric serialisation
  // (we never do arithmetic on it client-side). null = not set.
  dailyRate?: string | null;
  role: string;
  line: string | null;
  inOkk: boolean;
  inRolevki: boolean;
}

interface SaveBody {
  department: "b2g" | "b2b";
  managers: ManagerInput[];
  deletedIds: string[];
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const body = (await request.json()) as SaveBody;
    const { department, managers, deletedIds } = body;
    const team = department === "b2b" ? "ruzanna" : "dima";
    const okkDept = department === "b2g" ? "d2" : "r2";
    const warnings: string[] = [];

    // Guard: filter out managers that are also in deletedIds
    const deletedSet = new Set(deletedIds);
    const safeManagers = managers.filter((m) => !m.id || !deletedSet.has(m.id));

    // ── Step 1: Delete removed managers (soft-delete in OKK to preserve call history) ──
    for (const id of deletedIds) {
      const [deleted] = await db
        .select({ telegramId: masterManagers.telegramId, name: masterManagers.name })
        .from(masterManagers)
        .where(eq(masterManagers.id, id));

      if (deleted) {
        if (department === "b2b") {
          // Коммерсы: soft-delete в master. Строка (kommo/cg/ct id, имя, FK на
          // manager_schedule/payroll) нужна, чтобы удалённый менеджер «оживал»
          // за периоды, когда он работал (Звонки/Дейли/Активность/Looker —
          // ревайв через getManagersWithKommoForPeriod и период-aware выборки).
          // Hard delete рвал name→master.id атрибуцию и терял историю.
          await db
            .update(masterManagers)
            .set({ isActive: false, updatedAt: new Date() })
            .where(eq(masterManagers.id, id));
        } else {
          // Госники: прежнее поведение (hard delete) — ревайв для b2g не включён.
          await db.delete(masterManagers).where(eq(masterManagers.id, id));
        }
        await softDeleteFromTargets(department, okkDept, deleted.name, deleted.telegramId, warnings);
      }
    }

    // ── Step 2: Fetch existing records for preservation ──
    const existingMap = new Map<string, {
      kommoUserId: number | null;
      telegramId: string | null;
      telegramUsername: string | null;
      name: string;
      callgearEmployeeId: string | null;
      cloudtalkAgentId: string | null;
      shiftStartTime: string | null;
      dailyRate: string | null;
    }>();
    const existingRows = await db
      .select({
        id: masterManagers.id,
        kommoUserId: masterManagers.kommoUserId,
        telegramId: masterManagers.telegramId,
        telegramUsername: masterManagers.telegramUsername,
        name: masterManagers.name,
        callgearEmployeeId: masterManagers.callgearEmployeeId,
        cloudtalkAgentId: masterManagers.cloudtalkAgentId,
        shiftStartTime: masterManagers.shiftStartTime,
        dailyRate: masterManagers.dailyRate,
      })
      .from(masterManagers)
      .where(and(eq(masterManagers.department, department), eq(masterManagers.isActive, true)));
    for (const row of existingRows) {
      existingMap.set(row.id, row);
    }

    // ── Step 2.5: Soft-deleted rows of this department ──
    // При повторном добавлении человека с тем же telegram_id/именем оживляем
    // его старую master-строку (isActive=true) вместо вставки дубликата: id
    // сохраняется, а с ним — история manager_schedule/payroll и атрибуция
    // name→master.id в аналитике.
    const inactiveByTg = new Map<string, string>();   // telegramId → master id
    const inactiveByName = new Map<string, string>(); // trimmed lowercase name → master id
    const inactiveRows = await db
      .select({
        id: masterManagers.id,
        name: masterManagers.name,
        telegramId: masterManagers.telegramId,
      })
      .from(masterManagers)
      .where(and(eq(masterManagers.department, department), eq(masterManagers.isActive, false)));
    for (const row of inactiveRows) {
      if (row.telegramId) inactiveByTg.set(row.telegramId, row.id);
      inactiveByName.set(row.name.trim().toLowerCase(), row.id);
    }

    // ── Step 3: Resolve telegram_ids (parallel, only when needed) ──
    const resolvePromises = safeManagers.map(async (mgr) => {
      const cleanUsername = mgr.telegramUsername?.replace(/^@/, "").trim() || null;
      const existing = mgr.id ? existingMap.get(mgr.id) : null;

      // If frontend already sent a telegramId (e.g. pre-filled or kept from state), use it directly
      const clientTelegramId = mgr.telegramId?.trim() || null;

      if (!cleanUsername) return clientTelegramId;

      // Check if username changed — force re-resolve
      const existingUsername = existing?.telegramUsername?.replace(/^@/, "").trim() || null;
      const usernameChanged = cleanUsername !== existingUsername;

      // Skip if ID already known, is real, and username unchanged
      const knownId = clientTelegramId || existing?.telegramId || null;
      const isPlaceholder = knownId && Number(knownId) < 1000000;
      if (knownId && !isPlaceholder && !usernameChanged) {
        return knownId;
      }

      try {
        const resolved = await resolveTelegramUsername(cleanUsername);
        if (!resolved) warnings.push(`Telegram: @${cleanUsername} — не удалось зарезолвить (проверьте /api/telegram?username=${cleanUsername})`);
        return resolved;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`Telegram resolve error для @${cleanUsername}: ${msg}`);
        return clientTelegramId;
      }
    });

    const resolvedIds = await Promise.all(resolvePromises);

    // ── Step 3.5: Auto-resolve Kommo User IDs by name ──
    // Load Kommo users once for the whole batch so we can auto-fill the id on
    // freshly-added or previously-blank managers. Match is case-insensitive by
    // display name with a small alias table for the three transliteration
    // drifts the integrator / Kommo feeds have exhibited.
    const KOMMO_NAME_ALIASES: Record<string, string[]> = {
      "Максим Алекперов": ["Maksim Alekperov"],
      "Гульназ Сираждинова": ["Гульназ Cираждинова"],
      "Елизавета Трапезникова": ["Єлизавета Трапезникова"],
    };
    const kommoUserMap = new Map<string, number>(); // lowercase name → kommo user id
    try {
      const kommoUsers = await getKommoUsers();
      for (const ku of kommoUsers) {
        if (ku.id && ku.name) {
          kommoUserMap.set(ku.name.toLowerCase().trim(), ku.id);
        }
      }
      if (kommoUserMap.size > 0) {
        console.log(`[Managers API] Loaded ${kommoUserMap.size} Kommo users for auto-matching`);
      }
    } catch (err) {
      warnings.push(`Не удалось загрузить пользователей из Kommo: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Look up a Kommo id by master manager name, trying aliases if the direct
    // match misses (Cyrillic ↔ Latin, Ukrainian Є ↔ Russian Е).
    const lookupKommoId = (name: string): number | null => {
      const key = name.trim().toLowerCase();
      const direct = kommoUserMap.get(key);
      if (direct !== undefined) return direct;
      const aliases = KOMMO_NAME_ALIASES[name.trim()];
      if (aliases) {
        for (const alias of aliases) {
          const hit = kommoUserMap.get(alias.toLowerCase().trim());
          if (hit !== undefined) return hit;
        }
      }
      return null;
    };

    // ── Step 3.6: Auto-resolve CallGear + CloudTalk IDs by name ──
    // Same pattern as Kommo, except CloudTalk also matches by email since the
    // CT agent records carry it reliably (CallGear sometimes does too but the
    // suffix "(amoCRM)" / "(CloudTalk)" gets stripped by normalizeName).
    // Failures are non-fatal — the OKK webhook still has the legacy auto-link
    // path as fallback for managers that haven't placed a call yet.
    const cgByName = new Map<string, string>();   // normalised name → cg id
    const ctByName = new Map<string, string>();
    const ctByEmail = new Map<string, string>();  // lowercase email → ct id
    const TELEPHONY_NAME_ALIASES: Record<string, string[]> = {
      ...KOMMO_NAME_ALIASES,
      // Add telephony-specific drifts here if any surface — CallGear and
      // CloudTalk both already strip the (amoCRM) suffix in our clients.
    };

    const normTel = (s: string): string =>
      s.replace(/\(amoCRM\)/gi, "")
        .replace(/[()]/g, "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();

    try {
      const cgEmployees = await getCallGearEmployees();
      for (const e of cgEmployees) {
        if (!e.id) continue;
        const idStr = String(e.id);
        if (e.full_name) cgByName.set(normTel(e.full_name), idStr);
        if (e.first_name && e.last_name) {
          cgByName.set(normTel(`${e.first_name} ${e.last_name}`), idStr);
        }
      }
      console.log(`[Managers API] Loaded ${cgByName.size} CallGear employees for auto-matching`);
    } catch (err) {
      warnings.push(`Не удалось загрузить сотрудников CallGear: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      const ctAgents = await getCloudTalkAgents();
      for (const a of ctAgents) {
        if (!a.id) continue;
        const idStr = String(a.id);
        const fullname = [a.firstname, a.lastname].filter(Boolean).join(" ").trim();
        if (fullname) ctByName.set(normTel(fullname), idStr);
        if (a.email) ctByEmail.set(a.email.toLowerCase().trim(), idStr);
      }
      console.log(
        `[Managers API] Loaded ${ctByName.size} CloudTalk agents for auto-matching (${ctByEmail.size} with email)`,
      );
    } catch (err) {
      warnings.push(`Не удалось загрузить агентов CloudTalk: ${err instanceof Error ? err.message : String(err)}`);
    }

    const lookupTelephonyId = (
      map: Map<string, string>,
      name: string,
    ): string | null => {
      const direct = map.get(normTel(name));
      if (direct) return direct;
      const aliases = TELEPHONY_NAME_ALIASES[name.trim()];
      if (aliases) {
        for (const alias of aliases) {
          const hit = map.get(normTel(alias));
          if (hit) return hit;
        }
      }
      return null;
    };

    // ── Step 4: Upsert each manager ──
    const results: (typeof masterManagers.$inferSelect)[] = [];

    for (let idx = 0; idx < safeManagers.length; idx++) {
      const mgr = safeManagers[idx];
      const existing = mgr.id ? existingMap.get(mgr.id) : null;
      const telegramId = resolvedIds[idx] || existing?.telegramId || null;

      // kommoUserId precedence: explicit form input → existing saved value →
      // auto-match by name (via Kommo API). We always attempt auto-match now
      // because Daily/Dashboard call attribution routes through master_managers
      // regardless of `inOkk`; gating it on OKK left new B2G managers without
      // a Kommo id and silently dropped them from per-manager call metrics.
      const autoMatchedKommoId = kommoUserMap.size > 0 ? lookupKommoId(mgr.name) : null;
      const kommoUserId = mgr.kommoUserId ?? existing?.kommoUserId ?? autoMatchedKommoId ?? null;
      if (!mgr.kommoUserId && !existing?.kommoUserId && autoMatchedKommoId) {
        console.log(`[Managers API] auto-matched Kommo id ${autoMatchedKommoId} for ${mgr.name}`);
      } else if (!kommoUserId) {
        warnings.push(`Kommo ID не найден для «${mgr.name}» — заполните вручную или проверьте имя в Kommo.`);
      }

      // Telephony id precedence (same shape as Kommo above): explicit form
      // input → existing saved value → auto-match by name against CallGear
      // get.employees / CloudTalk /agents/index.json → null. Auto-match runs
      // on EVERY save (not just first-time) so a manager renamed in CG/CT
      // gets re-linked rather than silently losing call attribution.
      const autoCg =
        cgByName.size > 0 ? lookupTelephonyId(cgByName, mgr.name) : null;
      const autoCt =
        ctByName.size > 0 ? lookupTelephonyId(ctByName, mgr.name) : null;
      const callgearEmployeeId =
        mgr.callgearEmployeeId ?? existing?.callgearEmployeeId ?? autoCg ?? null;
      const cloudtalkAgentId =
        mgr.cloudtalkAgentId ?? existing?.cloudtalkAgentId ?? autoCt ?? null;
      if (!mgr.callgearEmployeeId && !existing?.callgearEmployeeId && autoCg) {
        console.log(`[Managers API] auto-matched CallGear id ${autoCg} for ${mgr.name}`);
      }
      if (!mgr.cloudtalkAgentId && !existing?.cloudtalkAgentId && autoCt) {
        console.log(`[Managers API] auto-matched CloudTalk id ${autoCt} for ${mgr.name}`);
      }

      const values = {
        name: mgr.name.trim(),
        telegramUsername: mgr.telegramUsername?.replace(/^@/, "").trim() || null,
        telegramId,
        department,
        team,
        role: mgr.role || "manager",
        line: mgr.line || null,
        kommoUserId,
        callgearEmployeeId,
        cloudtalkAgentId,
        shiftStartTime: mgr.shiftStartTime ?? existing?.shiftStartTime ?? null,
        // dailyRate semantics:
        //   undefined in payload → preserve existing (don't accidentally null
        //                          out a saved rate when an older client posts)
        //   null / ""            → explicit clear
        //   "1234.50"            → set
        dailyRate:
          mgr.dailyRate === undefined
            ? existing?.dailyRate ?? null
            : mgr.dailyRate === null || mgr.dailyRate === ""
              ? null
              : String(mgr.dailyRate),
        inOkk: mgr.inOkk,
        inRolevki: mgr.inRolevki,
        isActive: true,
        updatedAt: new Date(),
      };

      let savedRow;
      if (mgr.id) {
        const [updated] = await db
          .update(masterManagers)
          .set(values)
          .where(eq(masterManagers.id, mgr.id))
          .returning();
        savedRow = updated;
      } else {
        // Новый менеджер: сперва ищем soft-deleted строку того же человека
        // (по telegram_id, затем по имени) и реактивируем её — see Step 2.5.
        const reviveId =
          (telegramId ? inactiveByTg.get(telegramId) : undefined) ??
          inactiveByName.get(mgr.name.trim().toLowerCase()) ??
          null;
        if (reviveId) {
          const [revived] = await db
            .update(masterManagers)
            .set(values)
            .where(eq(masterManagers.id, reviveId))
            .returning();
          savedRow = revived;
        } else {
          const [inserted] = await db
            .insert(masterManagers)
            .values(values)
            .returning();
          savedRow = inserted;
        }
      }

      if (savedRow) results.push(savedRow);
    }

    // ── Step 5: Sync to target tables (with error isolation) ──
    await syncToTargets(department, okkDept, results, existingMap, warnings);

    // ── Step 6: Deactivate orphans in targets (managers active in targets but not in master) ──
    await deactivateOrphans(department, okkDept, warnings);

    // Return updated list
    const updatedRows = await db
      .select()
      .from(masterManagers)
      .where(and(eq(masterManagers.department, department), eq(masterManagers.isActive, true)))
      .orderBy(masterManagers.name);

    return NextResponse.json({ success: true, data: updatedRows, warnings });
  } catch (error) {
    console.error("[Managers API POST]", error);
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// ─── Sync helpers ─────────────────────────────────────────────

type MasterRow = typeof masterManagers.$inferSelect;
type ExistingInfo = { kommoUserId: number | null; telegramId: string | null; telegramUsername: string | null; name: string };

async function syncToTargets(
  department: "b2g" | "b2b",
  okkDept: string,
  rows: MasterRow[],
  existingMap: Map<string, ExistingInfo>,
  warnings: string[],
) {
  const roleplayDb = getDbForDepartment(department);
  const okkDb = getOkkDbForDepartment(department);
  const usersTable = department === "b2g" ? d1Users : r1Users;

  for (const row of rows) {
    const oldRecord = row.id ? existingMap.get(row.id) : null;
    const telegramIdChanged = oldRecord && oldRecord.telegramId && oldRecord.telegramId !== row.telegramId;

    // ── Sync to OKK (D2/R2) ──
    // Upsert by telegram_id (stable across renames) first, then fall back to name.
    // Preserves callgear_employee_id and cloudtalk_agent_id from master, and pulls
    // back webhook-assigned IDs to master so rename doesn't drop the link.
    try {
      if (row.inOkk) {
        // 1) Find canonical row: prefer match by telegram_id (if set), else by name+dept
        let canonical: { id: string; isActive: boolean | null; callgearEmployeeId: string | null; cloudtalkAgentId: string | null } | null = null;
        const allSameNameOrTg: { id: string; isActive: boolean | null; callgearEmployeeId: string | null; cloudtalkAgentId: string | null }[] = [];

        if (row.telegramId) {
          const byTg = await okkDb
            .select({ id: okkManagers.id, isActive: okkManagers.isActive, callgearEmployeeId: okkManagers.callgearEmployeeId, cloudtalkAgentId: okkManagers.cloudtalkAgentId })
            .from(okkManagers)
            .where(and(eq(okkManagers.telegramId, row.telegramId), eq(okkManagers.department, okkDept)))
            .orderBy(desc(okkManagers.isActive), desc(okkManagers.updatedAt));
          if (byTg.length > 0) {
            canonical = byTg[0];
            allSameNameOrTg.push(...byTg);
          }
        }

        const byName = await okkDb
          .select({ id: okkManagers.id, isActive: okkManagers.isActive, callgearEmployeeId: okkManagers.callgearEmployeeId, cloudtalkAgentId: okkManagers.cloudtalkAgentId })
          .from(okkManagers)
          .where(and(eq(okkManagers.name, row.name), eq(okkManagers.department, okkDept)))
          .orderBy(desc(okkManagers.isActive), desc(okkManagers.updatedAt));
        for (const r of byName) {
          if (!allSameNameOrTg.find((x) => x.id === r.id)) allSameNameOrTg.push(r);
        }
        if (!canonical && byName.length > 0) canonical = byName[0];

        // 2) Merge IDs: master value wins; otherwise use the most-recent target-side value
        const mergedCgId = row.callgearEmployeeId
          || allSameNameOrTg.find((r) => r.callgearEmployeeId)?.callgearEmployeeId
          || null;
        const mergedCtId = row.cloudtalkAgentId
          || allSameNameOrTg.find((r) => r.cloudtalkAgentId)?.cloudtalkAgentId
          || null;

        let canonicalId: string;
        if (canonical) {
          await okkDb
            .update(okkManagers)
            .set({
              name: row.name,
              role: row.role,
              line: row.line,
              telegramId: row.telegramId,
              kommoUserId: row.kommoUserId,
              callgearEmployeeId: mergedCgId,
              cloudtalkAgentId: mergedCtId,
              isActive: true,
            })
            .where(eq(okkManagers.id, canonical.id));
          canonicalId = canonical.id;

          // Deactivate any sibling duplicates (same name or same tg_id in same dept)
          for (const dup of allSameNameOrTg) {
            if (dup.id === canonical.id) continue;
            if (dup.isActive) {
              await okkDb
                .update(okkManagers)
                .set({ isActive: false })
                .where(eq(okkManagers.id, dup.id));
              warnings.push(`OKK: deactivated duplicate "${row.name}" (id=${dup.id})`);
            }
          }
        } else {
          const [created] = await okkDb
            .insert(okkManagers)
            .values({
              name: row.name,
              telegramId: row.telegramId,
              kommoUserId: row.kommoUserId,
              callgearEmployeeId: mergedCgId,
              cloudtalkAgentId: mergedCtId,
              department: okkDept,
              role: row.role,
              line: row.line,
              isActive: true,
            })
            .returning({ id: okkManagers.id });
          canonicalId = created.id;
        }

        // Re-bind historic "Unmatched agent" calls now that this manager
        // exists/is reactivated in OKK. Pattern matches the webhook's error
        // message shape: "Unmatched agent: employee_id=N, name=..." or
        // "Unmatched agent: ct_id=N, name=...". The OKK rematch cron also
        // covers this, but doing it synchronously gives admins instant
        // feedback after Save.
        const relinkPatterns: string[] = [];
        if (mergedCgId) relinkPatterns.push(`Unmatched agent: employee_id=${mergedCgId},%`);
        if (mergedCtId) relinkPatterns.push(`Unmatched agent: ct_id=${mergedCtId},%`);
        if (relinkPatterns.length > 0) {
          try {
            const relinkConditions = relinkPatterns.map(
              (p) => sql`${okkCalls.errorMessage} LIKE ${p}`,
            );
            const relinked = await okkDb
              .update(okkCalls)
              .set({
                managerId: canonicalId,
                managerName: row.name,
                status: "received",
                errorMessage: null,
                // Push updatedAt 20 min into the past so the OKK
                // received-retry cron (every 10 min) picks them up.
                updatedAt: new Date(Date.now() - 20 * 60 * 1000),
              })
              .where(
                and(
                  eq(okkCalls.status, "received"),
                  or(...relinkConditions),
                ),
              )
              .returning({ id: okkCalls.id });
            if (relinked.length > 0) {
              warnings.push(
                `OKK: re-bound ${relinked.length} historic unmatched calls to "${row.name}" (will be re-evaluated)`,
              );
            }
          } catch (err) {
            warnings.push(
              `OKK relink failed for "${row.name}": ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        // 3) Sync merged IDs back to master_managers so future renames keep them
        if (mergedCgId !== row.callgearEmployeeId || mergedCtId !== row.cloudtalkAgentId) {
          await db
            .update(masterManagers)
            .set({
              callgearEmployeeId: mergedCgId,
              cloudtalkAgentId: mergedCtId,
              updatedAt: new Date(),
            })
            .where(eq(masterManagers.id, row.id));
        }
      } else {
        // Deactivate all matching rows (by name or by tg_id) in this dept
        await okkDb
          .update(okkManagers)
          .set({ isActive: false })
          .where(and(eq(okkManagers.name, row.name), eq(okkManagers.department, okkDept)));
        if (row.telegramId) {
          await okkDb
            .update(okkManagers)
            .set({ isActive: false })
            .where(and(eq(okkManagers.telegramId, row.telegramId), eq(okkManagers.department, okkDept)));
        }
      }
    } catch (err) {
      warnings.push(`OKK sync failed for ${row.name}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ── Sync to Roleplay (D1/R1) ──
    try {
      if (row.inRolevki && row.telegramId) {
        // Roleplay tables (d1_users/r1_users) have a CHECK constraint allowing
        // only role IN ('manager','rop','admin') — no 'teamlead'/'prolongation'.
        // A teamlead does roleplays as a regular manager; a prolongation
        // manager (менеджер продлений) too, while inRolevki=true. Map both
        // down here — without this the sync UPDATE/INSERT is rejected by
        // Postgres (the "Roleplay sync failed" warning). OKK keeps the real
        // role.
        const roleplayRole =
          row.role === "teamlead" || row.role === "prolongation" ? "manager" : row.role;

        // If telegramId changed, deactivate old record
        if (telegramIdChanged && oldRecord.telegramId) {
          await roleplayDb
            .update(usersTable)
            .set({ isActive: false, updatedAt: new Date() })
            .where(eq(usersTable.telegramId, oldRecord.telegramId));
        }

        const [existing] = await roleplayDb
          .select({ id: usersTable.id })
          .from(usersTable)
          .where(eq(usersTable.telegramId, row.telegramId));

        if (existing) {
          await roleplayDb
            .update(usersTable)
            .set({
              name: row.name,
              telegramUsername: row.telegramUsername,
              role: roleplayRole,
              line: row.line,
              team: row.team,
              kommoUserId: row.kommoUserId,
              isActive: true,
              updatedAt: new Date(),
            })
            .where(eq(usersTable.id, existing.id));
        } else {
          await roleplayDb.insert(usersTable).values({
            name: row.name,
            telegramId: row.telegramId,
            telegramUsername: row.telegramUsername,
            role: roleplayRole,
            line: row.line,
            team: row.team,
            kommoUserId: row.kommoUserId,
            isActive: true,
          });
        }
      } else if (row.inRolevki && !row.telegramId) {
        // Warn: cannot sync to roleplay without telegram ID
        warnings.push(`${row.name}: не синхронизирован в Ролевки — нет Telegram ID`);
      } else if (!row.inRolevki && row.telegramId) {
        // Deactivate in roleplay
        await roleplayDb
          .update(usersTable)
          .set({ isActive: false, updatedAt: new Date() })
          .where(eq(usersTable.telegramId, row.telegramId));
      }
    } catch (err) {
      warnings.push(`Roleplay sync failed for ${row.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function softDeleteFromTargets(
  department: "b2g" | "b2b",
  okkDept: string,
  name: string,
  telegramId: string | null,
  warnings: string[],
) {
  const okkDb = getOkkDbForDepartment(department);
  const roleplayDb = getDbForDepartment(department);
  const usersTable = department === "b2g" ? d1Users : r1Users;

  // Soft-delete from OKK (preserve call history). Admins are shielded —
  // they live in target tables but never in master_managers, so the cleanup
  // must not deactivate them. okkManagers.role is nullable, so use
  // IS DISTINCT FROM to also catch rows whose role hasn't been set.
  try {
    await okkDb
      .update(okkManagers)
      .set({ isActive: false })
      .where(and(
        eq(okkManagers.name, name),
        eq(okkManagers.department, okkDept),
        sql`${okkManagers.role} IS DISTINCT FROM 'admin'`,
      ));
  } catch (err) {
    warnings.push(`OKK delete failed for ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Soft-delete from roleplay (may have call history via foreign key).
  // d1Users/r1Users.role is NOT NULL — plain ne() is enough.
  if (telegramId) {
    try {
      await roleplayDb
        .update(usersTable)
        .set({ isActive: false, updatedAt: new Date() })
        .where(and(
          eq(usersTable.telegramId, telegramId),
          ne(usersTable.role, "admin"),
        ));
    } catch (err) {
      warnings.push(`Roleplay delete failed for ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Deactivate orphan managers across ALL four target tables (R2/D2 OKK + R1/D1 Roleplay).
 *
 * An orphan is a row active in a target table whose name (for OKK) or telegram_id
 * (for Roleplay) does not correspond to any active row in master_managers of the
 * matching department. This also cleans up cross-department leakage — e.g. a manager
 * moved B2G → B2B leaves an active ghost in D2; this function deactivates it.
 *
 * Runs on every save regardless of which department was edited, so a single save
 * fully reconciles state.
 */
async function deactivateOrphans(
  _department: "b2g" | "b2b",
  _okkDept: string,
  warnings: string[],
) {
  // Load ALL active master managers grouped by department
  const allMaster = await db
    .select({
      name: masterManagers.name,
      telegramId: masterManagers.telegramId,
      kommoUserId: masterManagers.kommoUserId,
      department: masterManagers.department,
    })
    .from(masterManagers)
    .where(eq(masterManagers.isActive, true));

  const byDept: Record<
    "b2b" | "b2g",
    { names: string[]; telegramIds: string[]; kommoUserIds: number[] }
  > = {
    b2b: { names: [], telegramIds: [], kommoUserIds: [] },
    b2g: { names: [], telegramIds: [], kommoUserIds: [] },
  };
  for (const m of allMaster) {
    const d = m.department === "b2b" ? "b2b" : "b2g";
    byDept[d].names.push(m.name);
    if (m.telegramId) byDept[d].telegramIds.push(m.telegramId);
    if (m.kommoUserId) byDept[d].kommoUserIds.push(m.kommoUserId);
  }

  // ── OKK cleanup in BOTH departments (R2 + D2) ──
  // Orphan = OKK row not matching ANY of {name, telegramId, kommoUserId}
  // from active master rows in the same department. Pure-name match alone
  // was too aggressive: a master rename used to deactivate the OKK row
  // before its cg/ct id could be carried over, which orphaned subsequent
  // webhook calls until manual intervention.
  const okkTargets: Array<{ dept: "b2g" | "b2b"; okkDept: "d2" | "r2" }> = [
    { dept: "b2g", okkDept: "d2" },
    { dept: "b2b", okkDept: "r2" },
  ];

  for (const { dept, okkDept } of okkTargets) {
    const okkDb = getOkkDbForDepartment(dept);
    const allowedNames = byDept[dept].names;
    const allowedTelegramIds = byDept[dept].telegramIds;
    const allowedKommoUserIds = byDept[dept].kommoUserIds;

    try {
      const hasAnyAllowed =
        allowedNames.length > 0 ||
        allowedTelegramIds.length > 0 ||
        allowedKommoUserIds.length > 0;

      if (!hasAnyAllowed) {
        // No active masters for this dept — deactivate everything except admins.
        await okkDb
          .update(okkManagers)
          .set({ isActive: false })
          .where(and(
            eq(okkManagers.department, okkDept),
            eq(okkManagers.isActive, true),
            sql`${okkManagers.role} IS DISTINCT FROM 'admin'`,
          ));
        continue;
      }

      // Build "row matches at least one allowed identifier" predicate, then
      // negate. Each clause guarded by length>0 because empty arrays would
      // produce invalid SQL ("WHERE x IN ()").
      const matchClauses: ReturnType<typeof inArray>[] = [];
      if (allowedNames.length > 0) {
        matchClauses.push(inArray(okkManagers.name, allowedNames));
      }
      if (allowedTelegramIds.length > 0) {
        matchClauses.push(inArray(okkManagers.telegramId, allowedTelegramIds));
      }
      if (allowedKommoUserIds.length > 0) {
        matchClauses.push(inArray(okkManagers.kommoUserId, allowedKommoUserIds));
      }

      const isAllowed = matchClauses.length === 1 ? matchClauses[0] : or(...matchClauses);

      await okkDb
        .update(okkManagers)
        .set({ isActive: false })
        .where(
          and(
            eq(okkManagers.department, okkDept),
            eq(okkManagers.isActive, true),
            sql`NOT (${isAllowed})`,
            // Admins live outside master_managers by design — never deactivate them.
            sql`${okkManagers.role} IS DISTINCT FROM 'admin'`,
          ),
        );
    } catch (err) {
      warnings.push(`OKK ${okkDept} orphan cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Roleplay cleanup in BOTH department tables (D1 + R1) ──
  const rpTargets: Array<{ dept: "b2g" | "b2b"; table: typeof d1Users | typeof r1Users }> = [
    { dept: "b2g", table: d1Users },
    { dept: "b2b", table: r1Users },
  ];

  for (const { dept, table } of rpTargets) {
    const rpDb = getDbForDepartment(dept);
    const allowedTelegramIds = byDept[dept].telegramIds;
    try {
      if (allowedTelegramIds.length > 0) {
        await rpDb
          .update(table)
          .set({ isActive: false, updatedAt: new Date() })
          .where(
            and(
              eq(table.isActive, true),
              notInArray(table.telegramId, allowedTelegramIds),
              // Admins (Aliia, Sasha) live in d1_users/r1_users without a
              // matching master_managers row — keep them active.
              ne(table.role, "admin"),
            )
          );
      } else {
        warnings.push(`No active master managers with telegramId for ${dept} — skipping ${dept === "b2g" ? "D1" : "R1"} cleanup`);
      }
    } catch (err) {
      warnings.push(`Roleplay ${dept} orphan cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
