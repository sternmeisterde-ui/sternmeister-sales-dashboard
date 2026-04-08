import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { diagnoseTelegram } from "@/lib/telegram/resolve";

/**
 * GET /api/telegram?username=Olga912
 * Diagnostic endpoint — tests MTProto connection and optionally resolves a username.
 * Admin-only.
 */
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const username = request.nextUrl.searchParams.get("username") || undefined;
  const result = await diagnoseTelegram(username);

  return NextResponse.json(result);
}
