"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, AlertTriangle, AlertCircle } from "lucide-react";

// Polls /api/health/etl every 60s and renders a colored chip:
//   green  → fresh        (latest analytics row < 30 min old)
//   amber  → degraded     (enrichment backlog over threshold, core data still fresh)
//   red    → stale        (some analytics.* table > 30 min behind)
//
// Mounted in the dashboard header for admin users so a stuck cron is
// visible without tailing logs. Click → tooltip with per-table ages.
//
// Why poll the route directly instead of pushing via SSE: a 60s poll is
// cheap (one indexed MAX() per table) and the badge is a "passive" signal
// users glance at — push complexity isn't worth it.

interface FreshnessRow {
  source: string;
  latestAt: string | null;
  ageSec: number | null;
}

interface HealthResp {
  status: "ok" | "degraded" | "stale" | "no_data" | "error";
  timestamp: string;
  freshness?: {
    communications: FreshnessRow;
    leads_cohort: FreshnessRow;
    status_changes: FreshnessRow;
    sla: FreshnessRow;
  };
  enrichment?: { unlinked_calls_pending: number };
  stale_sources?: string[];
  no_data_sources?: string[];
}

const POLL_MS = 60_000;

function formatAge(sec: number | null): string {
  if (sec === null) return "—";
  if (sec < 60) return `${sec} сек`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} мин`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin === 0 ? `${hr} ч` : `${hr} ч ${remMin} мин`;
}

export default function EtlFreshnessBadge() {
  const [data, setData] = useState<HealthResp | null>(null);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Click outside / Escape closes the popover. onMouseLeave alone leaves the
  // tooltip stuck open on touch devices and after tab-key navigation.
  useEffect(() => {
    if (!open) return;
    const handlePointer = (ev: MouseEvent | TouchEvent) => {
      if (containerRef.current && !containerRef.current.contains(ev.target as Node)) {
        setOpen(false);
      }
    };
    const handleKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("touchstart", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("touchstart", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  useEffect(() => {
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const res = await fetch("/api/health/etl", { signal: ac.signal });
        // 503 still has JSON body — read it either way.
        const body: HealthResp = await res.json();
        setData(body);
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setData({
          status: "error",
          timestamp: new Date().toISOString(),
        });
      } finally {
        if (!ac.signal.aborted) {
          timer = setTimeout(poll, POLL_MS);
        }
      }
    };

    poll();

    return () => {
      ac.abort();
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!data) {
    return null;
  }

  const tone =
    data.status === "ok"
      ? { dot: "bg-emerald-500", border: "border-emerald-400/30", text: "text-emerald-400", Icon: CheckCircle2, label: "ETL: ок" }
      : data.status === "no_data"
        ? { dot: "bg-slate-500", border: "border-slate-400/30", text: "text-slate-400", Icon: AlertTriangle, label: "ETL: нет данных" }
        : data.status === "degraded"
          ? { dot: "bg-amber-500", border: "border-amber-400/30", text: "text-amber-400", Icon: AlertTriangle, label: "ETL: backlog" }
          : { dot: "bg-rose-500", border: "border-rose-400/30", text: "text-rose-400", Icon: AlertCircle, label: "ETL: устарело" };

  const oldestAge = data.freshness
    ? Math.max(
        data.freshness.communications.ageSec ?? 0,
        data.freshness.leads_cohort.ageSec ?? 0,
        data.freshness.status_changes.ageSec ?? 0,
        data.freshness.sla.ageSec ?? 0,
      )
    : null;

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-2 h-9 px-3 rounded-lg border ${tone.border} bg-slate-800/40 ${tone.text} hover:bg-slate-800/70 transition-all text-xs font-medium`}
        title="Свежесть данных аналитики"
        aria-label={tone.label}
      >
        <span className={`w-2 h-2 rounded-full ${tone.dot}`} />
        <tone.Icon className="w-3.5 h-3.5" />
        <span className="hidden md:inline">{formatAge(oldestAge)}</span>
      </button>

      {open && data.freshness && (
        <div
          className="absolute right-0 top-full mt-2 w-72 rounded-xl border border-white/10 bg-slate-900/95 backdrop-blur-md shadow-xl p-3 z-50 text-xs"
        >
          <div className="text-slate-300 font-semibold mb-2">Свежесть analytics.*</div>
          <ul className="space-y-1.5 text-slate-400">
            {(["communications", "leads_cohort", "status_changes", "sla"] as const).map((k) => {
              const f = data.freshness![k];
              const stale = data.stale_sources?.includes(k) ?? false;
              return (
                <li key={k} className="flex justify-between items-baseline">
                  <span className="font-mono text-[11px]">{k}</span>
                  <span className={stale ? "text-rose-400 font-semibold" : "text-slate-300"}>
                    {formatAge(f.ageSec)}
                  </span>
                </li>
              );
            })}
          </ul>
          {data.enrichment && data.enrichment.unlinked_calls_pending > 0 && (
            <div className="mt-2 pt-2 border-t border-white/10 text-slate-400 flex justify-between">
              <span>Telephony в очереди</span>
              <span className={data.enrichment.unlinked_calls_pending > 2000 ? "text-amber-400 font-semibold" : "text-slate-300"}>
                {data.enrichment.unlinked_calls_pending.toLocaleString("ru-RU")}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
