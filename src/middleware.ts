import { NextRequest, NextResponse } from "next/server";

export function middleware(request: NextRequest) {
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

  // Protect everything else: redirect to /login if no session cookie
  const session = request.cookies.get("sm_session");
  if (!session?.value) {
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
