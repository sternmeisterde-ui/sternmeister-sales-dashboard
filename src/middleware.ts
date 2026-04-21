import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySession } from "@/lib/auth";

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Always allow auth routes
  if (pathname.startsWith("/api/auth")) {
    return NextResponse.next();
  }

  // Always allow the login page
  if (pathname === "/login") {
    return NextResponse.next();
  }

  // Always allow Next.js internals and static assets
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.match(/\.(png|jpg|jpeg|svg|ico|webp|gif|woff|woff2|ttf|otf)$/)
  ) {
    return NextResponse.next();
  }

  // Protect everything else: verify signed session cookie.
  // A forged/unsigned cookie returns null from verifySession and is rejected
  // here — so an attacker who sets their own sm_session value can't even load
  // a protected page.
  const cookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = cookie ? await verifySession(cookie) : null;

  if (!session) {
    const loginUrl = new URL("/login", request.url);
    // Drop the invalid cookie so the browser stops sending it.
    const response = NextResponse.redirect(loginUrl);
    if (cookie) response.cookies.delete(SESSION_COOKIE_NAME);
    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
