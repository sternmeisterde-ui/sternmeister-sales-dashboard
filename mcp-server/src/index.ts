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
 * Phase 2 deploy: Dokploy → Traefik TLS at mcp.sternmeister.de. Single
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
  /** When the session was created — for idle eviction (TODO Phase 2b). */
  createdAt: number;
}

const sessions = new Map<string, SessionEntry>();

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
  sendJson(res, 200, {
    status: "ok",
    version: VERSION,
    uptime_seconds: Math.floor((Date.now() - STARTED_AT) / 1000),
    sessions: sessions.size,
    tokens_loaded: loadTokens().size,
  });
}

async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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
      // Mint a new session.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          sessions.set(sid, { transport, createdAt: Date.now() });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      const server = createMcpServer();
      await server.connect(transport);
      entry = { transport, createdAt: Date.now() };
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

server.listen(PORT, () => {
  process.stderr.write(
    `[mcp-http] listening on :${PORT} — ${loadTokens().size} bearer tokens loaded\n`,
  );
});

const shutdown = (signal: string): void => {
  process.stderr.write(`[mcp-http] ${signal} received — closing\n`);
  server.close(() => process.exit(0));
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
