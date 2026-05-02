/**
 * Bearer-token store. Loaded once from env on startup. Token-rotation =
 * redeploy with new token map (per §7.2 of MCP-IMPLEMENTATION-PLAN.md).
 *
 * Env shape (MCP_BEARER_TOKENS):
 *   JSON array of { token, userId, name, role, depts, issued }.
 *   Example:
 *     [
 *       { "token": "sk-mcp-xxx", "userId": "antares", "name": "Антон",
 *         "role": "admin", "depts": ["*"], "issued": "2026-04-30" },
 *       { "token": "sk-mcp-yyy", "userId": "dima", "name": "Дмитрий",
 *         "role": "rop", "depts": ["b2g"], "issued": "2026-04-30" }
 *     ]
 *
 * Stdio mode skips this entirely — local dev runs as a virtual admin token
 * (see context.ts createAdminContext).
 */

import { z } from "zod";

export const TokenClaimsSchema = z.object({
  /** The bearer-token string itself (not echoed in logs / audit). */
  token: z.string().min(20),
  /** Stable user identifier (logged in audit). */
  userId: z.string().min(1),
  /** Human-readable name (for chat UX, not security). */
  name: z.string().min(1),
  /** Role gates which tools the user can call. */
  role: z.enum(["admin", "rop", "manager"]),
  /**
   * Department scope. Tools that take a `dept` arg verify it's in this set.
   * Use ["*"] for admin (all departments).
   */
  depts: z.array(z.enum(["b2g", "b2b", "*"])).min(1),
  /** ISO-date the token was issued (for audit). */
  issued: z.string().min(8),
});

export type TokenClaims = z.infer<typeof TokenClaimsSchema>;

const TokensArraySchema = z.array(TokenClaimsSchema);

let cache: Map<string, TokenClaims> | null = null;

/**
 * Load and validate MCP_BEARER_TOKENS once. Throws on malformed JSON or
 * schema mismatch — fail-fast at startup rather than first request.
 */
export function loadTokens(): Map<string, TokenClaims> {
  if (cache) return cache;
  const raw = process.env.MCP_BEARER_TOKENS;
  if (!raw) {
    // HTTP transport will reject all requests until tokens are provisioned.
    cache = new Map();
    return cache;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`MCP_BEARER_TOKENS is not valid JSON: ${(err as Error).message}`);
  }
  const result = TokensArraySchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`MCP_BEARER_TOKENS schema invalid: ${result.error.message}`);
  }
  cache = new Map(result.data.map((t) => [t.token, t]));
  return cache;
}

/** Verify a bearer string and return claims, or null if not found. */
export function verify(token: string | undefined | null): TokenClaims | null {
  if (!token) return null;
  return loadTokens().get(token) ?? null;
}
