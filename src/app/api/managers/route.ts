import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { masterManagers, d1Users, r1Users } from "@/lib/db/schema-existing";
import { getDbForDepartment } from "@/lib/db/index";
import { getOkkDbForDepartment } from "@/lib/db/okk";
import { okkManagers } from "@/lib/db/schema-okk";
import { eq, and, notInArray, desc, sql } from "drizzle-orm";
import { resolveTelegramUsername } from "@/lib/telegram/resolve";
import { getUsers as getKommoUsers } from "@/lib/kommo/client";

// ─── GET: fetch managers for department ───────────────────────

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session || session.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const dept = request.nextUrl.searchParams.get("department") === "b2b" ? "b2b" : "b2g";

    const rows = await db
      .select()
      .from(masterManagers)
      .where(and(eq(masterManagers.department, dept), eq(masterManagers.isActive, true)))
      .orderBy(masterManagers.name);

    return NextResponse.json({ success: true, data: rows });
  } catch (error) {
    console.error("[Managers API GET]", error);
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
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
        await db.delete(masterManagers).where(eq(masterManagers.id, id));
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
      })
      .from(masterManagers)
      .where(and(eq(masterManagers.department, department), eq(masterManagers.isActive, true)));
    for (const row of existingRows) {
      existingMap.set(row.id, row);
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
    let kommoUserMap = new Map<string, number>(); // lowercase name → kommo user id
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

    // ── Step 4: Upsert each manager ──
    const results: (typeof masterManagers.$inferSelect)[] = [];

    for (let idx = 0; idx < safeManagers.length; idx++) {
      const mgr = safeManagers[idx];
      const existing = mgr.id ? existingMap.get(mgr.id) : null;
      const telegramId = resolvedIds[idx] || existing?.telegramId || null;

      // kommoUserId: auto-resolve from Kommo API only for OKK managers
      const autoMatchedKommoId = mgr.inOkk
        ? (kommoUserMap.get(mgr.name.trim().toLowerCase()) ?? null)
        : null;
      const kommoUserId = existing?.kommoUserId ?? autoMatchedKommoId ?? mgr.kommoUserId ?? null;

      const values = {
        name: mgr.name.trim(),
        telegramUsername: mgr.telegramUsername?.replace(/^@/, "").trim() || null,
        telegramId,
        department,
        team,
        role: mgr.role || "manager",
        line: mgr.line || null,
        kommoUserId,
        // Preserve existing cg_id/ct_id — these get auto-filled by webhooks and
        // must survive Dashboard edits that don't explicitly set them.
        callgearEmployeeId: mgr.callgearEmployeeId ?? existing?.callgearEmployeeId ?? null,
        cloudtalkAgentId: mgr.cloudtalkAgentId ?? existing?.cloudtalkAgentId ?? null,
        shiftStartTime: mgr.shiftStartTime ?? existing?.shiftStartTime ?? null,
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
        const [inserted] = await db
          .insert(masterManagers)
          .values(values)
          .returning();
        savedRow = inserted;
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
    const nameChanged = oldRecord && oldRecord.name !== row.name;
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
          await okkDb.insert(okkManagers).values({
            name: row.name,
            telegramId: row.telegramId,
            kommoUserId: row.kommoUserId,
            callgearEmployeeId: mergedCgId,
            cloudtalkAgentId: mergedCtId,
            department: okkDept,
            role: row.role,
            line: row.line,
            isActive: true,
          });
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
              role: row.role,
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
            role: row.role,
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

  // Soft-delete from OKK (preserve call history)
  try {
    await okkDb
      .update(okkManagers)
      .set({ isActive: false })
      .where(and(eq(okkManagers.name, name), eq(okkManagers.department, okkDept)));
  } catch (err) {
    warnings.push(`OKK delete failed for ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Soft-delete from roleplay (may have call history via foreign key)
  if (telegramId) {
    try {
      await roleplayDb
        .update(usersTable)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(usersTable.telegramId, telegramId));
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
    .select({ name: masterManagers.name, telegramId: masterManagers.telegramId, department: masterManagers.department })
    .from(masterManagers)
    .where(eq(masterManagers.isActive, true));

  const byDept: Record<"b2b" | "b2g", { names: string[]; telegramIds: string[] }> = {
    b2b: { names: [], telegramIds: [] },
    b2g: { names: [], telegramIds: [] },
  };
  for (const m of allMaster) {
    const d = m.department === "b2b" ? "b2b" : "b2g";
    byDept[d].names.push(m.name);
    if (m.telegramId) byDept[d].telegramIds.push(m.telegramId);
  }

  // ── OKK cleanup in BOTH departments (R2 + D2) ──
  const okkTargets: Array<{ dept: "b2g" | "b2b"; okkDept: "d2" | "r2" }> = [
    { dept: "b2g", okkDept: "d2" },
    { dept: "b2b", okkDept: "r2" },
  ];

  for (const { dept, okkDept } of okkTargets) {
    const okkDb = getOkkDbForDepartment(dept);
    const allowedNames = byDept[dept].names;
    try {
      if (allowedNames.length > 0) {
        await okkDb
          .update(okkManagers)
          .set({ isActive: false })
          .where(
            and(
              eq(okkManagers.department, okkDept),
              eq(okkManagers.isActive, true),
              notInArray(okkManagers.name, allowedNames),
            )
          );
      } else {
        // No active masters for this dept — deactivate everything
        await okkDb
          .update(okkManagers)
          .set({ isActive: false })
          .where(and(eq(okkManagers.department, okkDept), eq(okkManagers.isActive, true)));
      }
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
