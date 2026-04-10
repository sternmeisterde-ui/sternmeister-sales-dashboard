// GET /api/daily/health — Diagnostic endpoint for Daily tab data pipeline
import { NextResponse } from "next/server";
import { getKommoHealth } from "@/lib/kommo/client";
import { getLastKommoError } from "@/lib/daily/build-response";

export async function GET() {
  const kommo = getKommoHealth();
  const lastError = getLastKommoError();

  return NextResponse.json({
    kommo: {
      consecutiveFailures: kommo.consecutiveFailures,
      tokenLoadedAt: kommo.tokenLoadedAt,
      status: kommo.consecutiveFailures > 0 ? "degraded" : "ok",
    },
    lastError,
    timestamp: new Date().toISOString(),
  });
}
