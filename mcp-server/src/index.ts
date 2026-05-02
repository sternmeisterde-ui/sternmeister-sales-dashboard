/**
 * HTTP entry-point — Streamable HTTP transport behind a bearer-token gate.
 *
 * Topology:
 *   POST /mcp     — JSON-RPC requests (initialize, tools/call, etc).
 *   GET  /mcp     — server-sent events stream for an existing session.
 *   DELETE /mcp   — terminate session (cleanup transport).
 *   GET  /health  — unauthed health probe (status, uptime, version).
 *
 * Auth:
 *   Authorization: Bearer <token>  → matched against MCP_BEARER_TOKENS env JSON.
 *   401 if missing / invalid.
 *
 * Per-request ctx:
 *   The token's claims are pushed onto AsyncLocalStorage via runWithContext()
 *   for the duration of transport.handleRequest. The tool registry's
 *   getCurrentContext() pulls it from the ALS — concurrent requests don't
 *   collide.
 *
 * Session model (per MCP spec):
 *   The first POST without an Mcp-Session-Id is an `initialize` request; the
 *   server mints a session id, stores the transport keyed by id, and returns
 *   it via the Mcp-Session-Id response header. Subsequent requests must echo
 *   the same header. DELETE ends a session.
 *
 * Phase 2 deploy: Dokploy → Traefik TLS at mcp.sternmeister.online. Single
 * replica is fine for 5–15 РОПов; horizontal scale (later) requires moving
 * session state to Redis / sticky routing.
 */

import * as dotenv from "dotenv";
import http from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { createMcpServer } from "./server.js";
import { fromClaims, runWithContext } from "./auth/context.js";
import { verify, loadTokens } from "./auth/tokens.js";
import { initSentry } from "./utils/trace.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env.local") });
initSentry();

const PORT = Number(process.env.PORT ?? 3009);
const STARTED_AT = Date.now();
const VERSION = "0.1.0";

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;
  createdAt: number;
  /** Bumped on every successful handleRequest call — drives idle TTL eviction. */
  lastActivityAt: number;
}

const sessions = new Map<string, SessionEntry>();

// ─── eviction config ────────────────────────────────────────────────────────
// Idle TTL: clients that close their laptop / drop network never trigger
// transport.onclose, so we sweep them periodically. 2h is generous for РОПа
// who steps away mid-conversation.
const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
const SESSION_MAX = 200;
const SESSION_SWEEP_MS = 10 * 60 * 1000;

function evictStaleSessions(): void {
  const now = Date.now();
  for (const [sid, entry] of sessions) {
    if (now - entry.lastActivityAt > SESSION_IDLE_MS) {
      // Delete from the Map directly — don't rely on transport.onclose to
      // fire (it may not, if the transport is already half-dead from a
      // dropped network). transport.close() is fire-and-forget cleanup.
      sessions.delete(sid);
      void entry.transport.close().catch(() => undefined);
      void entry.server.close().catch(() => undefined);
    }
  }
  if (sessions.size > SESSION_MAX) {
    const sorted = [...sessions.entries()].sort(
      (a, b) => a[1].lastActivityAt - b[1].lastActivityAt,
    );
    for (const [sid, entry] of sorted.slice(0, sessions.size - SESSION_MAX)) {
      sessions.delete(sid);
      void entry.transport.close().catch(() => undefined);
      void entry.server.close().catch(() => undefined);
    }
  }
}

// ─── Origin allowlist (CORS / DNS-rebinding defense) ───────────────────────
// Empty/missing Origin is allowed (Claude Desktop, curl). Browser-origin
// requests must be on the whitelist — set MCP_ALLOWED_ORIGINS=a,b,c via env
// or accept the default which covers production + claude.ai.
const allowedOrigins = new Set(
  (process.env.MCP_ALLOWED_ORIGINS ??
    "https://mcp.sternmeister.online,https://claude.ai")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      if (!data) return resolve(undefined);
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error(`bad JSON body: ${(err as Error).message}`));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function authHeader(req: http.IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth) return null;
  const parts = auth.split(" ");
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer") return null;
  return parts[1] ?? null;
}

async function handleHealth(res: http.ServerResponse): Promise<void> {
  // tokens_loaded omitted — count is itself a useful enumeration signal for
  // an attacker. Move to authed /admin/status if we ever need it visible.
  sendJson(res, 200, {
    status: "ok",
    version: VERSION,
    uptime_seconds: Math.floor((Date.now() - STARTED_AT) / 1000),
    sessions: sessions.size,
  });
}

async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // ── origin guard ────────────────────────────────────────────────────────
  // Browsers always send Origin; server-side clients (Claude Desktop, curl)
  // typically don't. Reject only browser-originated calls outside whitelist
  // — protects against DNS-rebinding and stray cross-origin attempts.
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.has(origin)) {
    sendJson(res, 403, { error: `origin '${origin}' not allowed` });
    return;
  }

  // ── auth ────────────────────────────────────────────────────────────────
  const token = authHeader(req);
  const claims = verify(token);
  if (!claims) {
    res.writeHead(401, {
      "Content-Type": "application/json",
      "WWW-Authenticate": 'Bearer realm="mcp"',
    });
    res.end(JSON.stringify({ error: "invalid or missing bearer token" }));
    return;
  }
  const ctx = fromClaims(claims);

  // ── session resolution ──────────────────────────────────────────────────
  const headerSession = req.headers["mcp-session-id"];
  const sessionId = Array.isArray(headerSession) ? headerSession[0] : headerSession;
  let entry: SessionEntry | undefined;

  if (req.method === "POST") {
    let body: unknown;
    try {
      body = await readBody(req);
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message });
      return;
    }
    if (sessionId && sessions.has(sessionId)) {
      entry = sessions.get(sessionId);
    } else if (!sessionId && isInitializeRequest(body)) {
      // Mint a new session. The Map insertion happens inside
      // onsessioninitialized — that callback is the SOLE write path for
      // sessions[]. We capture `transport` and `server` in the closure so
      // onclose can call server.close() to free Drizzle handles.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          sessions.set(sid, {
            transport,
            server,
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
          });
        },
      });
      const server = createMcpServer();
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
        void server.close().catch(() => undefined);
      };
      await server.connect(transport);
      // Don't construct a separate entry object here — onsessioninitialized
      // will populate sessions[] when the SDK is ready. For the FIRST
      // request (this one), we pass the body directly and rely on the
      // transport's internal state.
      await runWithContext(ctx, async () => {
        await transport.handleRequest(req, res, body);
      });
      // After the initialize call returns, the session is registered.
      const justCreated = transport.sessionId
        ? sessions.get(transport.sessionId)
        : undefined;
      if (justCreated) justCreated.lastActivityAt = Date.now();
      return;
    } else {
      sendJson(res, 400, {
        error: "no Mcp-Session-Id header and not an initialize request",
      });
      return;
    }
    if (!entry) {
      sendJson(res, 500, { error: "session resolution failed" });
      return;
    }
    const e = entry;
    await runWithContext(ctx, async () => {
      await e.transport.handleRequest(req, res, body);
    });
    e.lastActivityAt = Date.now();
    return;
  }

  if (req.method === "GET" || req.method === "DELETE") {
    if (!sessionId || !sessions.has(sessionId)) {
      sendJson(res, 404, { error: "unknown or expired session" });
      return;
    }
    const e = sessions.get(sessionId)!;
    await runWithContext(ctx, async () => {
      await e.transport.handleRequest(req, res);
    });
    e.lastActivityAt = Date.now();
    return;
  }

  sendJson(res, 405, { error: `method ${req.method} not allowed on /mcp` });
}

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url) {
      sendJson(res, 400, { error: "no url" });
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/health") {
      await handleHealth(res);
      return;
    }
    if (url.pathname === "/mcp") {
      await handleMcp(req, res);
      return;
    }
    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    process.stderr.write(`[mcp-http] uncaught: ${(err as Error).stack ?? err}\n`);
    if (!res.headersSent) sendJson(res, 500, { error: "internal" });
  }
});

// keepAliveTimeout > Traefik's default 60s so Node closes idle sockets
// before the proxy does (avoids the spurious "client disconnected" race).
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;

server.listen(PORT, async () => {
  process.stderr.write(
    `[mcp-http] listening on :${PORT} — ${loadTokens().size} bearer tokens loaded\n`,
  );
  // Startup connectivity probe — ping each of the 6 RO connections so any
  // env/credentials/network issue surfaces in logs IMMEDIATELY, instead of
  // mysteriously breaking the first tool call. Doesn't fail startup;
  // service stays up so /health responds and user can debug.
  try {
    const probes = [
      { name: "D1", env: "MCP_D1_RO_URL", fallback: "DATABASE_URL" },
      { name: "R1", env: "MCP_R1_RO_URL", fallback: "R1_DATABASE_URL" },
      { name: "D2", env: "MCP_D2_RO_URL", fallback: "D2_OKK_DATABASE_URL" },
      { name: "R2", env: "MCP_R2_RO_URL", fallback: "R2_OKK_DATABASE_URL" },
      { name: "Analytics", env: "MCP_ANALYTICS_RO_URL", fallback: "ANALYTICS_DATABASE_URL" },
      { name: "Tracking", env: "MCP_TRACKING_RO_URL", fallback: "TRACKING_DATABASE_URL" },
    ];
    const { neon: neonClient } = await import("@neondatabase/serverless");
    for (const p of probes) {
      const url = process.env[p.env] ?? process.env[p.fallback];
      if (!url) {
        process.stderr.write(`[mcp-probe] ${p.name}: ${p.env} not set\n`);
        continue;
      }
      // Sanity-check URL shape — flag markdown autocorrect / brackets.
      if (/[\[\]()]/.test(url) || url.includes("mailto:")) {
        process.stderr.write(
          `[mcp-probe] ${p.name}: URL CONTAINS BRACKETS / mailto: — likely markdown autocorrect. Strip them in Dokploy env.\n`,
        );
        continue;
      }
      try {
        const sql = neonClient(url);
        const r = await sql`SELECT 1 AS ok`;
        process.stderr.write(`[mcp-probe] ${p.name}: ok (${JSON.stringify(r)})\n`);
      } catch (err) {
        const msg = (err as Error).message;
        const cause = (err as Error & { cause?: Error }).cause?.message;
        process.stderr.write(`[mcp-probe] ${p.name}: FAIL — ${msg}${cause ? " | " + cause : ""}\n`);
      }
    }
  } catch (err) {
    process.stderr.write(`[mcp-probe] probe loop crashed: ${(err as Error).message}\n`);
  }
});

const sweepTimer = setInterval(evictStaleSessions, SESSION_SWEEP_MS);
sweepTimer.unref();

const shutdown = (signal: string): void => {
  process.stderr.write(`[mcp-http] ${signal} received — closing\n`);
  server.close(() => process.exit(0));
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
