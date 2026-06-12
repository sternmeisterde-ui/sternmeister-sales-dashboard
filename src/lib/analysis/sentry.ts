// Tagged Sentry capture helpers for the call-analysis pipeline.
//
// Mirrors the pattern in src/lib/etl/sentry.ts: every analysis signal needs
// the same `component: 'analysis'` tag plus a `step` (transcription, grok-
// per-call, grok-summary) and severity, so dashboards / alerts can filter
// them as a group. Direct Sentry.captureException calls scattered across
// pipeline.ts would bypass this and land in the general bucket.

import * as Sentry from "@sentry/nextjs";

export type AnalysisStep = "discovery" | "transcription" | "grok-per-call" | "grok-summary";
/** non_fatal: caller has a fallback path / will retry. fatal: this call is lost. */
export type AnalysisSeverity = "non_fatal" | "fatal" | "warning";

interface CaptureContext {
  step: AnalysisStep;
  severity: AnalysisSeverity;
  /** Free-form context — analysisId, leadId, audio URL, HTTP status, etc. */
  extra?: Record<string, unknown>;
}

export function captureAnalysisException(err: unknown, ctx: CaptureContext): void {
  Sentry.captureException(err, {
    tags: {
      component: "analysis",
      step: ctx.step,
      severity: ctx.severity,
    },
    extra: ctx.extra,
  });
}

export function captureAnalysisMessage(
  message: string,
  level: "info" | "warning" | "error",
  ctx: CaptureContext,
): void {
  Sentry.captureMessage(message, {
    level,
    tags: {
      component: "analysis",
      step: ctx.step,
      severity: ctx.severity,
    },
    extra: ctx.extra,
  });
}
