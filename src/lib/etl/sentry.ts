// Tagged Sentry capture helpers for the ETL pipeline.
//
// Why a wrapper instead of `Sentry.captureException` directly: every ETL
// signal needs the same tags (`component: 'etl'`, plus the step name and
// severity), and forgetting one of those tags means the event lands in the
// general bucket where dashboards / alerts can't filter it. The wrapper
// also gives us a single seam to swap to a dedicated Sentry project later
// (just route through a different Hub here).
//
// To split into a dedicated Sentry project later:
//   1. Create a new Sentry project in the same org.
//   2. Set `SENTRY_DSN_ETL` env var to its DSN.
//   3. Initialise a separate Hub here using that DSN and call its
//      `captureException` instead of the global one.
// Filtering by `component:etl` in the existing project works as the
// short-term solution without a code change.

import * as Sentry from "@sentry/nextjs";

export type EtlSeverity = "non_fatal" | "fatal" | "warning";

interface CaptureContext {
  /** ETL step name (e.g., 'sync-communications', 'enrich-telephony-leads') */
  step: string;
  /** non_fatal: pipeline kept running; fatal: whole tick aborted */
  severity: EtlSeverity;
  /** Free-form extra context — sync window, row counts, etc. */
  extra?: Record<string, unknown>;
}

/** Send an exception to Sentry with consistent ETL tags. */
export function captureEtlException(err: unknown, ctx: CaptureContext): void {
  Sentry.captureException(err, {
    tags: {
      component: "etl",
      step: ctx.step,
      severity: ctx.severity,
    },
    extra: ctx.extra,
  });
}

/** Send a non-exception event (e.g., "stale > 30 min", "lock skip") to
 *  Sentry. Use this for signals that aren't thrown errors but still want
 *  to show up on the ETL dashboard. */
export function captureEtlMessage(
  message: string,
  level: "info" | "warning" | "error",
  ctx: CaptureContext,
): void {
  Sentry.captureMessage(message, {
    level,
    tags: {
      component: "etl",
      step: ctx.step,
      severity: ctx.severity,
    },
    extra: ctx.extra,
  });
}
