import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { masterManagers, d1Users, r1Users } from "@/lib/db/schema-existing";
import { getDbForDepartment } from "@/lib/db/index";
import { getOkkDbForDepartment } from "@/lib/db/okk";
import { okkManagers } from "@/lib/db/schema-okk";
import { eq, and } from "drizzle-orm";
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
    }>();
    const existingRows = await db
      .select({
        id: masterManagers.id,
        kommoUserId: masterManagers.kommoUserId,
        telegramId: masterManagers.telegramId,
        telegramUsername: masterManagers.telegramUsername,
        name: masterManagers.name,
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

      const resolved = await resolveTelegramUsername(cleanUsername);
      if (!resolved) warnings.push(`Не удалось найти Telegram ID для @${cleanUsername}`);
      return resolved;
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
    try {
      if (row.inOkk) {
        // If name changed, deactivate old record first
        if (nameChanged) {
          await okkDb
            .update(okkManagers)
            .set({ isActive: false })
            .where(and(eq(okkManagers.name, oldRecord.name), eq(okkManagers.department, okkDept)));
        }

        const [existing] = await okkDb
          .select({ id: okkManagers.id })
          .from(okkManagers)
          .where(and(eq(okkManagers.name, row.name), eq(okkManagers.department, okkDept)));

        if (existing) {
          await okkDb
            .update(okkManagers)
            .set({
              role: row.role,
              line: row.line,
              telegramId: row.telegramId,
              kommoUserId: row.kommoUserId,
              isActive: true,
            })
            .where(eq(okkManagers.id, existing.id));
        } else {
          await okkDb.insert(okkManagers).values({
            name: row.name,
            telegramId: row.telegramId,
            kommoUserId: row.kommoUserId,
            department: okkDept,
            role: row.role,
            line: row.line,
            isActive: true,
          });
        }
      } else {
        // Deactivate in OKK (with department filter)
        await okkDb
          .update(okkManagers)
          .set({ isActive: false })
          .where(and(eq(okkManagers.name, row.name), eq(okkManagers.department, okkDept)));
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
