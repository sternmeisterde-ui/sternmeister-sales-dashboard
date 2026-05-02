/**
 * Sentry init + helpers. No-op if SENTRY_DSN unset (local dev).
 *
 * Project on Sentry: `sternmeister-mcp-server` (separate from dashboard's
 * `sternmeister-dashboard` and the OKK / roleplay / etl projects).
 */

import * as Sentry from "@sentry/node";

let initialised = false;

/** Idempotent — safe to call from both stdio and HTTP entry-points. */
export function initSentry(): void {
  if (initialised) return;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    process.stderr.write("[mcp-sentry] SENTRY_DSN not set — telemetry disabled\n");
    initialised = true;
    return;
  }
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    release: process.env.MCP_VERSION ?? "0.1.0",
    // Conservative — sample 100% of errors but only 10% of transactions to keep
    // costs low; bump if we add slow-tool diagnostics later.
    tracesSampleRate: 0.1,
    // Don't send default PII headers; we mask phones / names ourselves elsewhere.
    sendDefaultPii: false,
  });
  initialised = true;
  process.stderr.write("[mcp-sentry] initialised\n");
}

/** Capture an exception with optional tag context. Falls through if Sentry off. */
export function captureError(
  err: unknown,
  context?: Record<string, string | number | boolean | null>,
): void {
  if (!initialised || !process.env.SENTRY_DSN) return;
  Sentry.withScope((scope) => {
    if (context) {
      for (const [k, v] of Object.entries(context)) {
        scope.setTag(k, String(v));
      }
    }
    Sentry.captureException(err);
  });
}
