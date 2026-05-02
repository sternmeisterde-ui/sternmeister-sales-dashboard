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

/* Per-request context store. AsyncLocalStorage-backed so concurrent HTTP
 * requests don't bleed into each other. Stdio (single-process, single-user)
 * uses the same store via setProcessContext() which seeds the ALS once. */

import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage<CallContext>();
let processContext: CallContext | null = null;

/** Run `fn` with `ctx` bound — used by HTTP transport per-request. */
export function runWithContext<T>(ctx: CallContext, fn: () => Promise<T> | T): Promise<T> | T {
  return als.run(ctx, fn);
}

/** Stdio mode: set the process-global context once at startup. */
export function setProcessContext(ctx: CallContext): void {
  processContext = ctx;
}

/** Backwards-compatible alias for setProcessContext. */
export const setCurrentContext = setProcessContext;

export function getCurrentContext(): CallContext {
  const fromAls = als.getStore();
  if (fromAls) return fromAls;
  if (processContext) return processContext;
  throw new Error(
    "auth context not initialised; call runWithContext() (HTTP) or setProcessContext() (stdio) first",
  );
}
