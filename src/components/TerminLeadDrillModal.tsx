"use client";

// Drill-down modal for Termin charts. Each chart point is clickable; click
// opens this modal which lazy-loads the underlying lead list from a sibling
// /leads endpoint and renders them sorted by contribution (outliers first).
//
// All Termin charts share this single modal — the calling section provides
// (a) the drill request (URL + params), and (b) the bucket header (title +
// aggregate). The modal owns fetch/loading/error/scroll/keyboard concerns.
//
// Lead list shape: see DrillLead. Each row gets a Kommo deep-link so the ROP
// can verify the value attribution by opening the actual deal.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, Loader2, X, AlertTriangle } from "lucide-react";

const KOMMO_LEADS_BASE = "https://sternmeister.kommo.com/leads/detail";

export function kommoLeadUrl(leadId: number): string {
  return `${KOMMO_LEADS_BASE}/${leadId}`;
}

export interface DrillLead {
  leadId: number;
  statusName: string | null;
  pipelineName: string | null;
  responsible: string | null;
  /** Short label rendered as the per-row contribution (e.g. "ДЦ через 4.2 дн"). */
  contributionLabel: string;
  /** Numeric value for sort/outlier coloring. Null = "missing" / outlier. */
  contributionValue: number | null;
  createdAt?: string | null;
  dcTermin?: string | null;
  aaTermin?: string | null;
  docsSentAt?: string | null;
  startAt?: string | null;
  endAt?: string | null;
  /** Override default "Старт"/"Финиш" labels — funnel uses stage-specific names. */
  startAtLabel?: string | null;
  endAtLabel?: string | null;
}

export interface DrillResponse {
  leads: DrillLead[];
  totalCount: number;
  truncated: boolean;
}

export interface DrillRequest {
  /** Endpoint path, e.g. "/api/dashboard/termins-upcoming/leads" */
  url: string;
  /** Query string params (already URL-safe values). */
  params: Record<string, string>;
  /** Modal title — usually a date or status name. */
  title: string;
  /** Subtitle — usually the aggregate value (e.g. "ДЦ avg 4.2 дн · 12 лидов"). */
  subtitle: string;
}

interface Props {
  request: DrillRequest;
  onClose: () => void;
}

function formatDateTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Berlin",
  });
}

function ContributionBadge({
  label,
  value,
}: {
  label: string;
  value: number | null;
}) {
  // Null contribution = "missing" / strongest outlier; ≥7d = warning;
  // otherwise neutral. Colors echo the chart's outlier-first sort.
  let cls = "bg-slate-700/40 text-slate-200 border-slate-500/30";
  if (value === null) cls = "bg-rose-500/15 text-rose-300 border-rose-500/30";
  else if (value >= 7) cls = "bg-amber-500/15 text-amber-300 border-amber-500/30";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium ${cls}`}
    >
      {label}
    </span>
  );
}

function DateRow({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex items-baseline gap-2 text-[11px]">
      <span className="text-slate-500 w-16 shrink-0">{label}</span>
      <span className="text-slate-300 tabular-nums">{value}</span>
    </div>
  );
}

export default function TerminLeadDrillModal({ request, onClose }: Props) {
  const [data, setData] = useState<DrillResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);

    const qs = new URLSearchParams(request.params).toString();
    fetch(`${request.url}?${qs}`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`API ${res.status}: ${await res.text()}`);
        }
        return (await res.json()) as DrillResponse;
      })
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [request.url, request.params]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-12 px-4 bg-black/70 backdrop-blur-sm"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      role="dialog"
      aria-modal="true"
      tabIndex={-1}
    >
      <div
        className="w-full max-w-3xl max-h-[85vh] overflow-hidden flex flex-col rounded-2xl bg-slate-900 border border-white/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="document"
      >
        <div className="flex items-start gap-3 px-5 py-4 border-b border-white/5 bg-slate-950/60 sticky top-0 z-10">
          <div className="flex flex-col flex-1 min-w-0">
            <div className="text-sm font-semibold text-white">{request.title}</div>
            <div className="text-[11px] text-slate-400 mt-0.5">
              {request.subtitle}
            </div>
            {data && (
              <div className="text-[11px] text-slate-500 mt-1">
                Показано {data.leads.length} из {data.totalCount}
                {data.truncated ? " — список усечён до 500 строк" : ""}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-white/10 text-slate-400 hover:text-white transition-colors shrink-0"
            aria-label="Закрыть"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading && (
            <div className="flex items-center justify-center py-16 text-slate-400">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
              <span className="text-sm">Загрузка лидов…</span>
            </div>
          )}
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-red-500/20 bg-red-500/5 text-red-300 text-sm">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          {!loading && !error && data && data.leads.length === 0 && (
            <div className="text-center text-slate-500 py-12 text-sm">
              В этом сегменте нет лидов.
            </div>
          )}
          {!loading && !error && data && data.leads.length > 0 && (
            <ul className="flex flex-col divide-y divide-white/5">
              {data.leads.map((lead) => (
                <li
                  key={lead.leadId}
                  className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0"
                >
                  <div className="flex items-start gap-3 flex-wrap">
                    <a
                      href={kommoLeadUrl(lead.leadId)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-sm font-semibold text-cyan-300 hover:text-cyan-200 hover:underline"
                    >
                      Сделка #{lead.leadId}
                      <ExternalLink className="w-3 h-3 opacity-70" />
                    </a>
                    <ContributionBadge
                      label={lead.contributionLabel}
                      value={lead.contributionValue}
                    />
                    {lead.statusName && (
                      <span className="text-[11px] text-slate-400 px-2 py-0.5 rounded-md bg-slate-800/60 border border-white/5">
                        <span className="text-slate-500 mr-1">сейчас:</span>
                        {lead.statusName}
                      </span>
                    )}
                    {lead.responsible && (
                      <span className="text-[11px] text-slate-500">
                        {lead.responsible}
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 ml-1">
                    <DateRow label="Создана" value={formatDateTime(lead.createdAt)} />
                    <DateRow label="ДЦ" value={formatDateTime(lead.dcTermin)} />
                    <DateRow label="АА" value={formatDateTime(lead.aaTermin)} />
                    <DateRow
                      label="Док. в ДЦ"
                      value={formatDateTime(lead.docsSentAt)}
                    />
                    <DateRow
                      label={lead.startAtLabel ?? "Старт"}
                      value={formatDateTime(lead.startAt)}
                    />
                    <DateRow
                      label={lead.endAtLabel ?? "Финиш"}
                      value={formatDateTime(lead.endAt)}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
