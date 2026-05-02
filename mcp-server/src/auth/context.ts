/**
 * Per-request authentication context — propagated through the tool registry
 * so each tool can enforce role/dept policy uniformly.
 *
 * Stdio transport runs as virtual admin (local dev only — env loopback).
 * HTTP transport derives ctx from bearer-token claims; in Phase 2 we'll
 * propagate via AsyncLocalStorage. For Phase 1 (stdio-only), a process-
 * global ctx is sufficient — only one user per process.
 */

import type { TokenClaims } from "./tokens.js";

export interface CallContext {
  userId: string;
  name: string;
  role: TokenClaims["role"];
  depts: TokenClaims["depts"];
  transport: "stdio" | "http";
}

/** Stdio dev context: implicitly admin with all-dept scope. */
export function createAdminContext(): CallContext {
  return {
    userId: "stdio-local",
    name: "Local Dev",
    role: "admin",
    depts: ["*"],
    transport: "stdio",
  };
}

export function fromClaims(claims: TokenClaims): CallContext {
  return {
    userId: claims.userId,
    name: claims.name,
    role: claims.role,
    depts: claims.depts,
    transport: "http",
  };
}

/** Returns true if ctx grants access to a specific department. */
export function hasDept(ctx: CallContext, dept: "b2g" | "b2b"): boolean {
  return ctx.depts.includes("*") || ctx.depts.includes(dept);
}

/* Process-global context store — set once at startup by stdio.ts. Phase 2
 * (HTTP) replaces this with AsyncLocalStorage per-session. */
let current: CallContext | null = null;

export function setCurrentContext(ctx: CallContext): void {
  current = ctx;
}

export function getCurrentContext(): CallContext {
  if (!current) throw new Error("auth context not initialised; call setCurrentContext() first");
  return current;
}
