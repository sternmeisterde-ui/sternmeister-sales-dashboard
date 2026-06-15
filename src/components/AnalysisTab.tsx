"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Search, Download, Loader2, CheckCircle2, XCircle, Clock, RefreshCw, Trash2, RotateCw, Square,
} from "lucide-react";

interface Analysis {
  id: string;
  department: string;
  kommoUrl: string;
  status: string;
  progress: number;
  totalCalls: number;
  processedCalls: number;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string | null;
  errorMessage: string | null;
}

interface AnalysisDetail extends Analysis {
  files: Array<{ id: string; filename: string; fileType: string; leadId: string | null }>;
}

export default function AnalysisTab({ department }: { department: "b2g" | "b2b" }) {
  const [analyses, setAnalyses] = useState<Analysis[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AnalysisDetail | null>(null);

  // Form state
  const [kommoUrl, setKommoUrl] = useState("");
  const [minDuration, setMinDuration] = useState(1);
  const [submitting, setSubmitting] = useState(false);

  const fetchList = useCallback(async () => {
    try {
      const res = await fetch(`/api/analysis?department=${department}`);
      const json = await res.json();
      if (json.success) setAnalyses(json.data);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [department]);

  // Instant kick: ask the server to claim+start the next queued job right
  // now instead of waiting for the next analysis-cron tick (≤60s). Fire and
  // forget — execution is fully server-side (cron-driven, checkpointed), the
  // browser is just a viewer. {claimed|idle} both mean "nothing else to do".
  const triggerProcessing = useCallback(() => {
    fetch("/api/analysis/process").catch(() => { /* tick will pick it up */ });
  }, []);

  useEffect(() => { setLoading(true); fetchList(); }, [fetchList]);

  // Poll the list every 5s while anything is queued/running — the ONLY
  // feedback channel. Processing itself never depends on this tab being
  // open: the analysis-cron service resumes yielded/orphaned jobs.
  useEffect(() => {
    const hasActive = analyses.some(a => a.status === "pending" || a.status === "processing");
    if (!hasActive) return;
    const listInterval = setInterval(fetchList, 5000);
    return () => clearInterval(listInterval);
  }, [analyses, fetchList]);

  // FIFO queue position for a pending row: jobs created earlier + the one
  // currently running ahead of it. Server runs ONE analysis at a time
  // (global single-flight — see src/lib/analysis/worker.ts), so this is an
  // honest "ahead of you in line" count, not a guess.
  const queuePosition = useCallback((a: Analysis) => {
    const ahead =
      analyses.filter((x) => x.status === "pending" && x.createdAt < a.createdAt).length +
      (analyses.some((x) => x.status === "processing") ? 1 : 0);
    return ahead;
  }, [analyses]);

  const fetchDetail = async (id: string) => {
    setSelectedId(id);
    const res = await fetch(`/api/analysis/${id}`);
    const json = await res.json();
    if (json.success) setDetail(json.data);
  };

  const handleSubmit = async () => {
    if (!kommoUrl.includes("kommo.com")) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ department, kommoUrl, minDuration }),
      });
      const json = await res.json();
      if (json.success) {
        setKommoUrl("");
        await fetchList();
        // Instant kick — otherwise the job waits ≤60s for the next cron tick
        triggerProcessing();
      }
    } catch { /* ignore */ }
    finally { setSubmitting(false); }
  };

  const handleDelete = async (id: string) => {
    try {
      await fetch(`/api/analysis/${id}/delete`, { method: "DELETE" });
      setAnalyses((prev) => prev.filter((a) => a.id !== id));
      if (selectedId === id) { setSelectedId(null); setDetail(null); }
    } catch { /* ignore */ }
  };

  const handleCancel = async (id: string) => {
    try {
      const res = await fetch(`/api/analysis/${id}/cancel`, { method: "POST" });
      if (!res.ok) return;
      // Optimistic flip; a RUNNING pipeline notices via its heartbeat and
      // drains within ~30s. Files/checkpoint stay — Resume continues later.
      setAnalyses((prev) =>
        prev.map((a) => (a.id === id ? { ...a, status: "cancelled", errorMessage: "Отменено пользователем" } : a)),
      );
      fetchList();
    } catch { /* ignore */ }
  };

  const handleResume = async (id: string) => {
    try {
      const res = await fetch(`/api/analysis/${id}/resume`, { method: "POST" });
      if (!res.ok) return;
      // Optimistic flip so the row immediately shows the spinner; the next
      // fetchList tick will reconcile against the DB.
      setAnalyses((prev) =>
        prev.map((a) => (a.id === id ? { ...a, status: "pending", errorMessage: null } : a)),
      );
      triggerProcessing();
      fetchList();
    } catch { /* ignore */ }
  };

  const daysLeft = (expiresAt: string | null) => {
    if (!expiresAt) return null;
    const days = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
    return days > 0 ? days : 0;
  };

  return (
    <div className="flex flex-col gap-5 fade-in flex-1 overflow-y-auto pb-6 scrollbar-hide">
      {/* Create form */}
      <div className="glass-panel rounded-2xl border border-white/5 p-5">
        <h3 className="text-sm font-bold uppercase tracking-widest text-slate-300 mb-4">Новая транскрибация звонков</h3>

        <div className="flex flex-col gap-3">
          <input
            type="text"
            value={kommoUrl}
            onChange={(e) => setKommoUrl(e.target.value)}
            placeholder="Вставьте ссылку из Kommo с фильтром..."
            className="w-full bg-slate-800/50 border border-white/10 rounded-xl px-4 py-3 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500/40"
          />

          <div className="flex flex-wrap gap-3 items-center">
            {/* Min duration filter */}
            <div className="flex items-center gap-1.5 bg-slate-800/50 px-3 py-1.5 rounded-xl border border-white/5">
              <span className="text-[10px] text-slate-400 uppercase tracking-wider">от</span>
              {[1, 2, 3, 5, 10].map((d) => (
                <button
                  key={d}
                  onClick={() => setMinDuration(d)}
                  className={`px-2 py-1 rounded-lg text-[11px] font-bold transition-all ${
                    minDuration === d
                      ? "bg-slate-600 text-white"
                      : "text-slate-400 hover:text-white"
                  }`}
                >
                  {d}м
                </button>
              ))}
            </div>

            <button
              onClick={handleSubmit}
              disabled={submitting || !kommoUrl.includes("kommo.com")}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-500 text-white text-xs font-bold uppercase tracking-wider hover:bg-blue-400 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              Транскрибировать
            </button>
          </div>
        </div>
      </div>

      {/* Analyses list */}
      <div className="glass-panel rounded-2xl border border-white/5 overflow-hidden">
        <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-widest font-bold text-slate-400">История транскрибаций</span>
          <button onClick={fetchList} className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-white/5">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>

        {analyses.length === 0 && !loading && (
          <div className="p-8 text-center text-slate-500 text-sm">Нет транскрибаций. Вставьте ссылку выше.</div>
        )}

        <div className="divide-y divide-white/5">
          {analyses.map((a) => {
            const days = daysLeft(a.expiresAt);
            const isActive = selectedId === a.id;
            return (
              <div key={a.id}>
                <button
                  onClick={() => a.status === "done" ? fetchDetail(a.id) : null}
                  className={`w-full px-4 py-4 text-left transition-colors ${
                    isActive ? "bg-blue-500/10" : "hover:bg-white/[0.02]"
                  } ${a.status !== "done" ? "cursor-default" : "cursor-pointer"}`}
                >
                  {/* Row 1: status + url + calls count + actions */}
                  <div className="flex items-center gap-3">
                    {a.status === "done" && <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />}
                    {a.status === "error" && <XCircle className="w-4 h-4 text-rose-400 shrink-0" />}
                    {a.status === "cancelled" && <Square className="w-4 h-4 text-slate-500 shrink-0" />}
                    {(a.status === "pending" || a.status === "processing") && <Loader2 className="w-4 h-4 text-blue-400 animate-spin shrink-0" />}

                    <div className="flex-1 min-w-0">
                      <span className="text-[12px] text-white truncate block">{a.kommoUrl.substring(0, 60)}...</span>
                      <span className="text-[10px] text-slate-500">{new Date(a.createdAt).toLocaleDateString("ru-RU")}</span>
                    </div>

                    {/* Calls count — large */}
                    <span className="text-[18px] font-bold tabular-nums text-white shrink-0">
                      {a.totalCalls || "—"}
                      <span className="text-[10px] text-slate-500 font-normal ml-1">зв.</span>
                    </span>

                    {days !== null && days > 0 && (
                      <span className="text-[10px] text-slate-500 flex items-center gap-1 shrink-0">
                        <Clock className="w-3 h-3" /> {days}д
                      </span>
                    )}

                    {a.status === "done" && (
                      <a href={`/api/analysis/${a.id}/download`} onClick={(e) => e.stopPropagation()}
                        className="p-1.5 rounded-lg text-blue-400 hover:bg-blue-500/10 shrink-0">
                        <Download className="w-4 h-4" />
                      </a>
                    )}

                    {a.status === "error" && (
                      <span
                        className="text-[10px] text-rose-400 max-w-[260px] truncate shrink-0"
                        title={a.errorMessage ?? ""}
                      >
                        {a.errorMessage}
                      </span>
                    )}

                    {a.status === "cancelled" && (
                      <span className="text-[10px] text-slate-500 shrink-0">Отменено</span>
                    )}

                    {/* Resume — error/cancelled rows (continues from checkpoint) */}
                    {(a.status === "error" || a.status === "cancelled") && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleResume(a.id); }}
                        className="p-1.5 rounded-lg text-amber-400 hover:bg-amber-500/10 shrink-0 transition-colors"
                        title="Повторить (продолжит с уже сделанных звонков)"
                      >
                        <RotateCw className="w-3.5 h-3.5" />
                      </button>
                    )}

                    {/* Cancel — stops a queued/running job, keeps its files */}
                    {(a.status === "pending" || a.status === "processing") && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleCancel(a.id); }}
                        className="p-1.5 rounded-lg text-slate-600 hover:text-amber-400 hover:bg-amber-500/10 shrink-0 transition-colors"
                        title="Остановить (файлы сохранятся, можно продолжить позже)"
                      >
                        <Square className="w-3.5 h-3.5" />
                      </button>
                    )}

                    {/* Delete / kill */}
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDelete(a.id); }}
                      className="p-1.5 rounded-lg text-slate-600 hover:text-rose-400 hover:bg-rose-500/10 shrink-0 transition-colors"
                      title="Удалить"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {/* Row 2: Progress bar + time estimate (only for processing) */}
                  {(a.status === "pending" || a.status === "processing") && (
                    <div className="mt-3">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-[13px] text-blue-400 font-bold">
                          {a.errorMessage ? a.errorMessage :
                           a.status === "pending" ? (queuePosition(a) > 0 ? `В очереди (№${queuePosition(a)})` : "Запуск...") :
                           a.totalCalls > 0 ? `Транскрибация звонков: ${a.processedCalls}/${a.totalCalls}` :
                           "Поиск звонков..."}
                        </span>
                        <span className="text-[14px] text-blue-300 font-bold">
                          {a.totalCalls > 0 && a.processedCalls > 0 ? (
                            `~${Math.max(1, Math.round((a.totalCalls - a.processedCalls) * 8))} мин`
                          ) : a.totalCalls > 0 ? (
                            `~${Math.round(a.totalCalls * 8)} мин`
                          ) : "определяем..."}
                        </span>
                      </div>
                      <div className="w-full h-3 bg-slate-700 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-blue-500 to-cyan-400 rounded-full transition-all duration-500"
                          style={{ width: `${Math.max(2, a.progress)}%` }}
                        />
                      </div>
                      <div className="text-[16px] text-blue-400 font-bold mt-2 text-right">{a.progress}%</div>
                    </div>
                  )}
                </button>

                {/* Detail view */}
                {isActive && detail && (
                  <div className="px-4 pb-5 bg-slate-900/30 space-y-4">
                    {/* Files + Download */}
                    <div className="flex items-center gap-3 flex-wrap">
                      <a
                        href={`/api/analysis/${detail.id}/download`}
                        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-500 text-white text-xs font-bold hover:bg-blue-400 transition-colors"
                      >
                        <Download className="w-4 h-4" /> Скачать все транскрипты
                      </a>
                      <span className="text-[11px] text-slate-500">
                        {detail.files.filter(f => f.fileType === "transcript").length} транскриптов
                      </span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
