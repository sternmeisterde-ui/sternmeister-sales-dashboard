"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Search, Download, Loader2, CheckCircle2, XCircle, Clock, FileText, TrendingDown, TrendingUp, RefreshCw, Trash2,
} from "lucide-react";

interface Analysis {
  id: string;
  department: string;
  kommoUrl: string;
  mode: string;
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
  resultSummary: string | null;
  files: Array<{ id: string; filename: string; fileType: string; leadId: string | null }>;
}

export default function AnalysisTab({ department }: { department: "b2g" | "b2b" }) {
  const [analyses, setAnalyses] = useState<Analysis[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AnalysisDetail | null>(null);

  // Form state
  const [kommoUrl, setKommoUrl] = useState("");
  const [mode, setMode] = useState<"failure" | "success">("failure");
  const [submitting, setSubmitting] = useState(false);

  const fetchList = useCallback(async () => {
    try {
      const res = await fetch(`/api/analysis?department=${department}`);
      const json = await res.json();
      if (json.success) setAnalyses(json.data);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [department]);

  // Trigger processing — calls /process which runs the pipeline
  const triggerProcessing = useCallback(async () => {
    try {
      const res = await fetch("/api/analysis/process");
      const json = await res.json();
      await fetchList();
      if (json.status === "error" || json.status === "done") return;
    } catch {
      await fetchList();
    }
  }, [fetchList]);

  useEffect(() => { setLoading(true); fetchList(); }, [fetchList]);

  // Auto-refresh + auto-trigger processing
  useEffect(() => {
    const hasActive = analyses.some(a => a.status === "pending" || a.status === "processing");
    if (!hasActive) return;

    // Poll list every 5s for progress updates
    const listInterval = setInterval(fetchList, 5000);

    // Trigger processing if pending
    const hasPending = analyses.some(a => a.status === "pending");
    if (hasPending) {
      triggerProcessing();
    }

    return () => clearInterval(listInterval);
  }, [analyses, fetchList, triggerProcessing]);

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
        body: JSON.stringify({ department, kommoUrl, mode }),
      });
      const json = await res.json();
      if (json.success) {
        setKommoUrl("");
        await fetchList();
        // Start processing — long-running request, runs until done or timeout
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

  const daysLeft = (expiresAt: string | null) => {
    if (!expiresAt) return null;
    const days = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
    return days > 0 ? days : 0;
  };

  return (
    <div className="flex flex-col gap-5 fade-in flex-1 overflow-y-auto pb-6 scrollbar-hide">
      {/* Create form */}
      <div className="glass-panel rounded-2xl border border-white/5 p-5">
        <h3 className="text-sm font-bold uppercase tracking-widest text-slate-300 mb-4">Новый анализ звонков</h3>

        <div className="flex flex-col gap-3">
          <input
            type="text"
            value={kommoUrl}
            onChange={(e) => setKommoUrl(e.target.value)}
            placeholder="Вставьте ссылку из Kommo с фильтром..."
            className="w-full bg-slate-800/50 border border-white/10 rounded-xl px-4 py-3 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500/40"
          />

          <div className="flex flex-wrap gap-3 items-center">
            <div className="flex bg-slate-800/50 p-1 rounded-xl border border-white/5">
              <button
                onClick={() => setMode("failure")}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-[11px] uppercase tracking-widest font-bold transition-all ${
                  mode === "failure"
                    ? "bg-rose-500/20 text-rose-400 border border-rose-500/30"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                <TrendingDown className="w-3.5 h-3.5" />
                Почему не получилось
              </button>
              <button
                onClick={() => setMode("success")}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-[11px] uppercase tracking-widest font-bold transition-all ${
                  mode === "success"
                    ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                <TrendingUp className="w-3.5 h-3.5" />
                Почему получилось
              </button>
            </div>

            <button
              onClick={handleSubmit}
              disabled={submitting || !kommoUrl.includes("kommo.com")}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-500 text-white text-xs font-bold uppercase tracking-wider hover:bg-blue-400 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              Анализировать
            </button>
          </div>
        </div>
      </div>

      {/* Analyses list */}
      <div className="glass-panel rounded-2xl border border-white/5 overflow-hidden">
        <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-widest font-bold text-slate-400">История анализов</span>
          <button onClick={fetchList} className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-white/5">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>

        {analyses.length === 0 && !loading && (
          <div className="p-8 text-center text-slate-500 text-sm">Нет анализов. Вставьте ссылку выше.</div>
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
                  {/* Row 1: status + mode + url + calls count + actions */}
                  <div className="flex items-center gap-3">
                    {a.status === "done" && <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />}
                    {a.status === "error" && <XCircle className="w-4 h-4 text-rose-400 shrink-0" />}
                    {(a.status === "pending" || a.status === "processing") && <Loader2 className="w-4 h-4 text-blue-400 animate-spin shrink-0" />}

                    <span className={`text-[9px] px-2 py-0.5 rounded-full font-bold uppercase shrink-0 ${
                      a.mode === "success" ? "bg-emerald-500/15 text-emerald-400" : "bg-rose-500/15 text-rose-400"
                    }`}>
                      {a.mode === "success" ? "Успех" : "Потеря"}
                    </span>

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
                      <span className="text-[10px] text-rose-400 max-w-[200px] truncate shrink-0">{a.errorMessage}</span>
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
                          {a.status === "pending" ? "Загрузка лидов из Kommo..." :
                           a.progress < 10 ? "Транскрибация звонков..." :
                           a.progress < 90 ? `Анализ звонков: ${a.processedCalls}/${a.totalCalls}` :
                           "Генерация сводного отчёта..."}
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
                  <div className="px-4 pb-4 bg-slate-900/30">
                    {/* Summary */}
                    {detail.resultSummary && (
                      <div className="mt-2 p-4 bg-slate-800/30 rounded-xl border border-white/5">
                        <div className="text-[10px] uppercase tracking-widest text-slate-500 font-bold mb-2">Сводный анализ</div>
                        <div className="text-[12px] text-slate-300 leading-relaxed whitespace-pre-wrap max-h-[400px] overflow-y-auto">
                          {detail.resultSummary}
                        </div>
                      </div>
                    )}

                    {/* Files */}
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {detail.files.filter(f => f.fileType === "transcript").map((f) => (
                        <span key={f.id} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-800/50 text-[10px] text-slate-400 border border-white/5">
                          <FileText className="w-3 h-3" /> {f.filename}
                        </span>
                      ))}
                    </div>

                    <a
                      href={`/api/analysis/${detail.id}/download`}
                      className="inline-flex items-center gap-2 mt-3 px-4 py-2 rounded-xl bg-blue-500/20 text-blue-400 text-xs font-bold hover:bg-blue-500/30 transition-colors"
                    >
                      <Download className="w-4 h-4" /> Скачать все файлы
                    </a>
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
