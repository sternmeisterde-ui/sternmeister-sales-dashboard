import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { eq, sql, or } from "drizzle-orm";
import { getDbForDepartment } from "@/lib/db/index";
import { d1Users, r1Users } from "@/lib/db/schema-existing";
import type { SessionUser } from "@/lib/auth";

const THIRTY_DAYS_SECONDS = 60 * 60 * 24 * 30;

// Telegram Bot tokens for resolving username → user ID
const TG_BOT_TOKENS = [
  process.env.TELEGRAM_BOT_TOKEN,
  "8250958994:AAFUQLcauiyr0avVXqr_QF0p_EpX5vZgT1Y", // OKK bot fallback
].filter(Boolean) as string[];

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

function mapRole(dbRole: string): "admin" | "manager" {
  return dbRole === "admin" || dbRole === "rop" ? "admin" : "manager";
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

    const [d1Results, r1Results] = await Promise.all([
      b2gDb.select().from(d1Users).where(conditions(d1Users)).limit(1),
      b2bDb.select().from(r1Users).where(conditions(r1Users as any)).limit(1),
    ]);

    const d1User = d1Results[0] ?? null;
    const r1User = r1Results[0] ?? null;

    if (!d1User && !r1User) {
      return NextResponse.json(
        { error: "Пользователь не найден" },
        { status: 401 },
      );
    }

    let session: SessionUser;

    if (d1User) {
      session = {
        userId: d1User.id,
        name: d1User.name,
        role: mapRole(d1User.role),
        department: "b2g",
        telegramUsername: d1User.telegramUsername ?? username,
        line: d1User.line ?? null,
        kommoUserId: d1User.kommoUserId ?? null,
      };
    } else {
      session = {
        userId: r1User!.id,
        name: r1User!.name,
        role: mapRole(r1User!.role),
        department: "b2b",
        telegramUsername: r1User!.telegramUsername ?? username,
        line: r1User!.line ?? null,
        kommoUserId: r1User!.kommoUserId ?? null,
      };
    }

    const cookieStore = await cookies();
    cookieStore.set("sm_session", JSON.stringify(session), {
      httpOnly: true,
      maxAge: THIRTY_DAYS_SECONDS,
      path: "/",
      sameSite: "lax",
    });

    return NextResponse.json({ ok: true, user: session });
  } catch (error) {
    console.error("Login error:", error);
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }
}
