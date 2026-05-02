/**
 * Per-request authentication context — propagated through the tool registry
 * so each tool can enforce role/dept policy uniformly.
 *
 * Stdio transport runs as virtual admin (local dev only — env loopback).
 * HTTP transport derives ctx from bearer-token claims.
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
