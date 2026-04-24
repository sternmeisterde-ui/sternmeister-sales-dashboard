import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { eq, sql, or } from "drizzle-orm";
import { getDbForDepartment, db as mainDb } from "@/lib/db/index";
import { d1Users, r1Users, masterManagers } from "@/lib/db/schema-existing";
import { SESSION_COOKIE_NAME, signSession, type SessionUser } from "@/lib/auth";

const THIRTY_DAYS_SECONDS = 60 * 60 * 24 * 30;

// Telegram Bot tokens for resolving username → user ID.
// Configure at least one of these env vars. Multiple tokens let us fall back
// if a bot has been blocked by the user (tokens tried in order).
const TG_BOT_TOKENS = [
  process.env.TELEGRAM_BOT_TOKEN,
  process.env.TELEGRAM_OKK_BOT_TOKEN,
].filter(Boolean) as string[];

if (TG_BOT_TOKENS.length === 0) {
  console.warn(
    "[auth] No Telegram bot token configured — username → telegram_id resolution will be skipped. " +
      "Set TELEGRAM_BOT_TOKEN or TELEGRAM_OKK_BOT_TOKEN.",
  );
}

/** Resolve Telegram username to numeric user ID via Bot API getChat */
async function resolveTelegramId(username: string): Promise<string | null> {
  for (const token of TG_BOT_TOKENS) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getChat?chat_id=@${username}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data.ok && data.result?.id) {
        return String(data.result.id);
      }
    } catch {
      // Try next token
    }
  }
  return null;
}

/**
 * Collapse a master-table role into the permission gate used everywhere:
 * ROPs and admins both get full "admin" access, plain managers get "manager".
 * The original master role is preserved separately in session.masterRole
 * so the UI can still show the right badge ("РОП" vs "Админ").
 */
function gateFromMasterRole(masterRole: string | null | undefined): "admin" | "manager" {
  return masterRole === "admin" || masterRole === "rop" ? "admin" : "manager";
}

function normaliseMasterRole(role: string | null | undefined): "admin" | "rop" | "manager" {
  if (role === "admin") return "admin";
  if (role === "rop") return "rop";
  return "manager";
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { username?: unknown };
    const raw = typeof body.username === "string" ? body.username : "";
    const username = raw.replace(/^@/, "").trim().toLowerCase();

    if (!username) {
      return NextResponse.json(
        { error: "Имя пользователя обязательно" },
        { status: 400 },
      );
    }

    // Step 1: Resolve Telegram username → numeric ID
    const telegramId = await resolveTelegramId(username);

    // Step 2: Search DB by telegram_username OR telegram_id (parallel, both DBs)
    const b2gDb = getDbForDepartment("b2g");
    const b2bDb = getDbForDepartment("b2b");

    const conditions = (table: typeof d1Users) => {
      const checks = [eq(sql`lower(${table.telegramUsername})`, username)];
      if (telegramId) {
        checks.push(eq(table.telegramId, telegramId));
      }
      return or(...checks);
    };

    // master_managers is the source of truth for role — also match by
    // username/telegram_id so we pick up ROPs who haven't been synced to the
    // department-specific user tables yet.
    const masterConditions = () => {
      const checks = [eq(sql`lower(${masterManagers.telegramUsername})`, username)];
      if (telegramId) checks.push(eq(masterManagers.telegramId, telegramId));
      return or(...checks);
    };

    const [d1Results, r1Results, masterResults] = await Promise.all([
      b2gDb.select().from(d1Users).where(conditions(d1Users)).limit(1),
      b2bDb.select().from(r1Users).where(conditions(r1Users as any)).limit(1),
      mainDb
        .select()
        .from(masterManagers)
        .where(
          sql`${masterManagers.isActive} = true AND (${masterConditions()})`,
        )
        .limit(1),
    ]);

    const d1User = d1Results[0] ?? null;
    const r1User = r1Results[0] ?? null;
    const masterUser = masterResults[0] ?? null;

    if (!d1User && !r1User && !masterUser) {
      return NextResponse.json(
        { error: "Пользователь не найден" },
        { status: 401 },
      );
    }

    // master_managers is the authoritative source (it's what the Managers tab
    // edits). When the user exists there, master wins for role + department
    // over whatever d1_users/r1_users happen to record — those are sync
    // targets that can drift and shouldn't silently demote a ROP to manager.
    // d1/r1 remain a fallback for legacy users who haven't been added to
    // master yet.
    let session: SessionUser;
    if (masterUser) {
      const masterRole = normaliseMasterRole(masterUser.role);
      const department = (masterUser.department === "b2b" ? "b2b" : "b2g") as "b2g" | "b2b";
      // Prefer the department-table id for downstream joins if it exists in
      // the matching department's table — this keeps call history joins
      // working for legacy managers. Otherwise fall back to master's id.
      const deptUser = department === "b2g" ? d1User : r1User;
      session = {
        userId: deptUser?.id ?? masterUser.id,
        name: masterUser.name,
        role: gateFromMasterRole(masterRole),
        masterRole,
        department,
        telegramUsername: masterUser.telegramUsername ?? username,
        line: masterUser.line ?? deptUser?.line ?? null,
        kommoUserId: masterUser.kommoUserId ?? deptUser?.kommoUserId ?? null,
      };
    } else if (d1User) {
      const masterRole = normaliseMasterRole(d1User.role);
      session = {
        userId: d1User.id,
        name: d1User.name,
        role: gateFromMasterRole(masterRole),
        masterRole,
        department: "b2g",
        telegramUsername: d1User.telegramUsername ?? username,
        line: d1User.line ?? null,
        kommoUserId: d1User.kommoUserId ?? null,
      };
    } else {
      const masterRole = normaliseMasterRole(r1User!.role);
      session = {
        userId: r1User!.id,
        name: r1User!.name,
        role: gateFromMasterRole(masterRole),
        masterRole,
        department: "b2b",
        telegramUsername: r1User!.telegramUsername ?? username,
        line: r1User!.line ?? null,
        kommoUserId: r1User!.kommoUserId ?? null,
      };
    }

    const signedSession = await signSession(session);
    const cookieStore = await cookies();
    cookieStore.set(SESSION_COOKIE_NAME, signedSession, {
      httpOnly: true,
      maxAge: THIRTY_DAYS_SECONDS,
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production" && process.env.COOKIE_INSECURE !== "true",
    });

    return NextResponse.json({ ok: true, user: session });
  } catch (error) {
    console.error("Login error:", error);
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }
}
