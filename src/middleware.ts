import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/auth";

/**
 * Middleware runs in the Edge runtime where `process.env.SESSION_SECRET`
 * can be unavailable (Next.js bakes some middleware code at build time, and
 * our Dockerfile doesn't pass runtime-only secrets into the build stage).
 * A silent `verifySession()` failure here would bounce a legitimately-signed
 * cookie back to /login — which is exactly the bug we hit in production.
 *
 * The compromise: middleware now only checks the cookie EXISTS. Full HMAC
 * verification still happens in every server component and API route via
 * `getSession()` (Node runtime, full env access). A forged cookie will get
 * past middleware, load the outer page shell, then hit /api/auth/me or any
 * data API and be rejected with 401 — the app shows the login screen
 * anyway because the session payload fails to hydrate.
 *
 * Net security impact: negligible. Page HTML itself carries no secrets —
 * all sensitive data flows through APIs which still verify.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Always allow auth routes
  if (pathname.startsWith("/api/auth")) {
    return NextResponse.next();
  }

  // Cron endpoints authenticate via CRON_SECRET header/query param — no session.
  // Covers /sync/cron (10-min CloudTalk), /sync/callgear (hourly, 7h-lag), and
  // any future sync/* endpoint added for new ETL slices.
  if (pathname.startsWith("/api/analytics/sync/")) {
    return NextResponse.next();
  }

  // Analysis worker tick (analysis-cron compose service, ~60s loop) — also
  // CRON_SECRET-authed. Exact match on purpose: the rest of /api/analysis/**
  // stays session-protected.
  if (pathname === "/api/analysis/process/tick") {
    return NextResponse.next();
  }

  // Call-export worker tick (etl-cron compose service) — CRON_SECRET-authed.
  // Exact match: the rest of /api/exports/** stays session-protected.
  if (pathname === "/api/exports/process/tick") {
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

  // Existence-only check. A signed-but-wrong cookie still reaches server
  // components / APIs, where `getSession()` does the real HMAC verification
  // (Node runtime has reliable access to SESSION_SECRET).
  const cookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!cookie) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
