import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { eq, sql, or } from "drizzle-orm";
import { getDbForDepartment, db as mainDb } from "@/lib/db/index";
import { d1Users, r1Users, masterManagers } from "@/lib/db/schema-existing";
import { SESSION_COOKIE_NAME, signSession, type SessionUser } from "@/lib/auth";

const THIRTY_DAYS_SECONDS = 60 * 60 * 24 * 30;

// Unified password for РОП / Администратор bypass — lets ROPs and admins
// log in by username + password without requiring Telegram bot resolution.
// Override via env (ADMIN_BYPASS_PASSWORD) if you need to rotate it.
const ADMIN_BYPASS_PASSWORD = process.env.ADMIN_BYPASS_PASSWORD ?? "987654321";

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
 * ROPs, teamleads and admins all get full "admin" access, plain managers get
 * "manager". The original master role is preserved separately in
 * session.masterRole so the UI can still show the right badge
 * ("РОП" vs "Тимлид" vs "Админ").
 */
function gateFromMasterRole(masterRole: string | null | undefined): "admin" | "manager" {
  return masterRole === "admin" || masterRole === "rop" || masterRole === "teamlead"
    ? "admin"
    : "manager";
}

function normaliseMasterRole(
  role: string | null | undefined,
): "admin" | "rop" | "teamlead" | "manager" {
  if (role === "admin") return "admin";
  if (role === "rop") return "rop";
  if (role === "teamlead") return "teamlead";
  return "manager";
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { username?: unknown; password?: unknown };
    const raw = typeof body.username === "string" ? body.username : "";
    const username = raw.replace(/^@/, "").trim().toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";
    const usingBypassPassword = password.length > 0;

    if (!username) {
      return NextResponse.json(
        { error: "Имя пользователя обязательно" },
        { status: 400 },
      );
    }

    // Reject wrong password up-front so a leaked username doesn't reveal that
    // the password field even matters (and skip the Telegram lookup below
    // for obviously invalid attempts).
    if (usingBypassPassword && password !== ADMIN_BYPASS_PASSWORD) {
      return NextResponse.json({ error: "Неверный пароль" }, { status: 401 });
    }

    // Step 1: Resolve Telegram username → numeric ID
    // Skipped for password-bypass logins — РОПы/админы должны иметь возможность
    // войти даже если бот не настроен или их ID не резолвится.
    const telegramId = usingBypassPassword ? null : await resolveTelegramId(username);

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

    // Password-bypass is intentionally limited to РОП, Тимлид и Администратор —
    // обычным менеджерам этот канал входа недоступен. Проверяем по
    // master_managers (источник истины), а если пользователь есть только
    // в d1/r1 — по их полю role.
    if (usingBypassPassword) {
      const effectiveRole = normaliseMasterRole(
        masterUser?.role ?? d1User?.role ?? r1User?.role ?? null,
      );
      if (effectiveRole !== "admin" && effectiveRole !== "rop" && effectiveRole !== "teamlead") {
        return NextResponse.json(
          { error: "Вход по паролю доступен только для РОП, Тимлида и Администратора" },
          { status: 403 },
        );
      }
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
