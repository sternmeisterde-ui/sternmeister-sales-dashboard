"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  Phone,
  FileText,
  Activity,
  Bot,
  Play,
  Pause,
  X,
  Search,
  BarChart3,
  Filter,
  Clock,
  Shield,
  Loader2,
  ExternalLink,
} from "lucide-react";
import CalendarPicker, { type DateRange } from "@/components/CalendarPicker";
import type {
  OkkApiResponse,
  OkkEvaluationRow,
  OkkManagerStat,
} from "@/app/api/okk/route";
import type { EvalBlock, TranscriptSpeakerSegment } from "@/lib/db/schema-okk";

// ─── helpers ────────────────────────────────────────────────

function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatDateTime(iso: string | null | undefined): {
  date: string;
  time: string;
} {
  if (!iso) return { date: "—", time: "—" };
  const d = new Date(iso);
  const date = d.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  });
  const time = d.toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return { date, time };
}

function scoreColor(score: number | null | undefined): string {
  if (score === null || score === undefined) return "text-slate-500";
  if (score >= 66) return "text-emerald-400";
  if (score >= 41) return "text-amber-400";
  return "text-rose-400";
}

function scoreBorder(score: number | null | undefined): string {
  if (score === null || score === undefined) return "border-slate-600";
  if (score >= 66)
    return "border-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.3)]";
  if (score >= 41)
    return "border-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.3)]";
  return "border-rose-400 shadow-[0_0_10px_rgba(251,113,133,0.3)]";
}

function cleanText(text: string): string {
  if (!text) return "";
  return text
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/\_\_/g, "")
    .replace(/\_/g, "")
    .replace(/\~/g, "")
    .replace(/\`/g, "")
    .replace(/\[/g, "")
    .replace(/\]/g, "")
    .replace(/\#/g, "")
    .trim();
}

// Determine speaker role: Speaker A = manager (right/blue), Speaker B = client (left/green)
function isManagerSpeaker(speaker: string): boolean {
  const s = speaker.toLowerCase();
  return s.includes("a") || s.includes("менеджер") || s.includes("продавец");
}

// ─── sub-components ─────────────────────────────────────────

interface ScoreCircleProps {
  score: number | null;
  size?: "sm" | "lg";
  onClick?: () => void;
}

function ScoreCircle({ score, size = "sm", onClick }: ScoreCircleProps) {
  const dim = size === "lg" ? "w-20 h-20 border-[5px]" : "w-9 h-9 border-[2px]";
  const textSize = size === "lg" ? "text-xl font-black" : "text-[10px] font-bold";
  const label = score !== null && score !== undefined ? `${score}` : "—";

  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className={`relative flex items-center justify-center rounded-full ${dim} ${scoreBorder(score)} ${onClick ? "cursor-pointer hover:scale-110 transition-transform" : "cursor-default"}`}
    >
      <span className={`${textSize} ${scoreColor(score)}`}>{label}</span>
    </button>
  );
}

interface TranscriptBubbleProps {
  segment: TranscriptSpeakerSegment;
}

function TranscriptBubble({ segment }: TranscriptBubbleProps) {
  const isManager = isManagerSpeaker(segment.speaker);
  return (
    <div className={`flex ${isManager ? "justify-end" : "justify-start"} w-full`}>
      <div
        className={`flex flex-col gap-1 ${isManager ? "items-end" : "items-start"} max-w-[75%]`}
      >
        <span
          className={`text-[10px] uppercase tracking-wider font-bold px-2 ${
            isManager ? "text-blue-400" : "text-emerald-400"
          }`}
        >
          {isManager ? "Менеджер" : "Клиент"}
        </span>
        <div
          className={`p-3 rounded-2xl ${
            isManager
              ? "bg-blue-500/15 text-blue-50 rounded-tr-none border border-blue-500/30 shadow-sm"
              : "bg-emerald-500/10 text-slate-100 rounded-tl-none border border-emerald-500/20 shadow-sm"
          }`}
        >
          {segment.text}
        </div>
      </div>
    </div>
  );
}

// Plain-text transcript fallback (no speaker JSONB data)
function PlainTranscriptBubbles({ text }: { text: string }) {
  const lines = text.split("\n").filter(Boolean);
  return (
    <>
      {lines.map((line, idx) => {
        const isManager =
          line.includes("[Продавец]") ||
          line.startsWith("Менеджер:") ||
          line.startsWith("A:");
        const clean = line
          .replace(/^\[Продавец\]:\s*/, "")
          .replace(/^\[Клиент\]:\s*/, "")
          .replace(/^(Менеджер:|Клиент:|A:|B:)\s*/, "");
        if (!clean.trim()) return null;
        const seg: TranscriptSpeakerSegment = {
          speaker: isManager ? "Speaker A" : "Speaker B",
          text: clean,
          start: 0,
          end: 0,
        };
        return <TranscriptBubble key={idx} segment={seg} />;
      })}
    </>
  );
}

// ─── modal ──────────────────────────────────────────────────

type ModalTab = "transcript" | "scoring";

interface EvalModalProps {
  row: OkkEvaluationRow;
  department: "b2g" | "b2b";
  onClose: () => void;
}

function EvalModal({ row, department, onClose }: EvalModalProps) {
  const [tab, setTab] = useState<ModalTab>("transcript");

  const { date, time } = formatDateTime(row.callCreatedAt);
  const duration = formatDuration(row.durationSeconds);

  const blocks: EvalBlock[] =
    row.evaluationJson?.blocks ?? [];
  const totalMaxScore = row.evaluationJson?.total_max_score ?? 100;
  const summary = row.evaluationJson?.summary ?? "";

  // Transcript rendering
  const hasSpeakers =
    Array.isArray(row.transcriptSpeakers) && row.transcriptSpeakers.length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-slate-950/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="bg-slate-900 z-10 w-full max-w-5xl rounded-3xl border border-white/10 shadow-2xl p-6 flex flex-col gap-6 max-h-[95vh] overflow-hidden animate-in zoom-in-95 duration-200">

        {/* Header */}
        <div className="flex justify-between items-start shrink-0">
          <div className="flex items-center gap-4">
            <div>
              <h3 className="font-bold text-lg text-white">
                {row.managerName ?? "Менеджер"}
              </h3>
              <p className="text-xs text-slate-400">
                {time} {date} • Длительность: {duration}
                {row.contactPhone && (
                  <span className="ml-2 text-slate-500">{row.contactPhone}</span>
                )}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-white bg-white/5 rounded-full hover:bg-white/10 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex gap-4 border-b border-white/5 pb-4 shrink-0">
          <button
            onClick={() => setTab("transcript")}
            className={`text-sm font-bold uppercase tracking-wider px-4 py-2 rounded-lg transition-colors ${
              tab === "transcript"
                ? "bg-blue-500/20 text-blue-400"
                : "text-slate-500 hover:text-slate-300"
            }`}
          >
            Транскрипция
          </button>
          <button
            onClick={() => setTab("scoring")}
            className={`text-sm font-bold uppercase tracking-wider px-4 py-2 rounded-lg transition-colors ${
              tab === "scoring"
                ? "bg-purple-500/20 text-purple-400"
                : "text-slate-500 hover:text-slate-300"
            }`}
          >
            AI Анализ (Скоринг)
          </button>
        </div>

        {/* Tab content */}
        {tab === "transcript" ? (
          <div className="flex flex-col gap-6 overflow-y-auto pr-2 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">
            <div className="bg-slate-900/50 rounded-2xl p-5 border border-white/5 shadow-inner flex flex-col gap-4">
              <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2 shrink-0">
                <FileText className="w-4 h-4 text-blue-400" /> Детальная Расшифровка
              </h4>
              <div className="text-sm leading-relaxed overflow-y-auto max-h-[500px] scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-slate-900/50 flex flex-col gap-3 pr-2">
                {hasSpeakers ? (
                  (row.transcriptSpeakers as TranscriptSpeakerSegment[]).map(
                    (seg, i) => <TranscriptBubble key={i} segment={seg} />
                  )
                ) : row.transcript ? (
                  <PlainTranscriptBubbles text={row.transcript} />
                ) : (
                  <p className="text-slate-500 text-sm">Транскрипция недоступна</p>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-6 overflow-y-auto pr-2 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">

            {/* Overall score */}
            <div className="bg-slate-900/50 rounded-2xl p-6 border border-white/5 flex items-center justify-between shadow-inner">
              <div>
                <h4 className="text-base font-black text-white mb-1 uppercase tracking-wider">
                  Итоговая Оценка
                </h4>
                <p className="text-xs text-slate-400">
                  Рассчитана на базе блоков скоринга
                  {totalMaxScore !== 100 && ` (макс. ${totalMaxScore})`}
                </p>
              </div>
              <ScoreCircle score={row.totalScore} size="lg" />
            </div>

            {/* Blocks grid */}
            {blocks.length > 0 && (
              <div className="bg-slate-900/50 rounded-2xl p-5 border border-white/5 flex flex-col gap-4 shadow-inner">
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                  <BarChart3 className="w-4 h-4 text-blue-400" /> Блоки оценки
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {blocks.map((block, i) => {
                    const pct =
                      block.max_score > 0
                        ? Math.round((block.score / block.max_score) * 100)
                        : 0;
                    return (
                      <div
                        key={i}
                        className="bg-slate-800/50 rounded-xl p-4 border border-white/5 flex flex-col gap-2"
                      >
                        <div className="flex justify-between items-start gap-2">
                          <span className="text-xs font-semibold text-slate-200 leading-snug">
                            {block.name}
                          </span>
                          <span
                            className={`text-sm font-black shrink-0 ${scoreColor(pct)}`}
                          >
                            {block.score}
                            <span className="text-[10px] font-normal text-slate-500">
                              /{block.max_score}
                            </span>
                          </span>
                        </div>
                        {/* Progress bar */}
                        <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all duration-500 ${
                              pct >= 66
                                ? "bg-emerald-500"
                                : pct >= 41
                                ? "bg-amber-500"
                                : "bg-rose-500"
                            }`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        {block.feedback && (
                          <p className="text-[11px] text-slate-400 leading-relaxed">
                            {cleanText(block.feedback)}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* AI Summary */}
            {summary && (
              <div className="bg-slate-900/50 rounded-2xl p-5 border border-white/5 flex flex-col gap-3 shadow-inner">
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2 shrink-0">
                  <Bot className="w-4 h-4 text-blue-400" /> Общий анализ
                </h4>
                <p className="text-sm text-slate-200 leading-relaxed whitespace-pre-wrap">
                  {cleanText(summary)}
                </p>
              </div>
            )}

            {/* Mistakes */}
            {row.mistakes && (
              <div className="bg-slate-900/50 rounded-2xl p-5 border border-white/5 flex flex-col gap-3 shadow-inner">
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2 shrink-0">
                  <Bot className="w-4 h-4 text-rose-400" /> Ошибки и Недоработки
                </h4>
                <div className="text-sm text-slate-200 leading-relaxed overflow-y-auto max-h-[300px] scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-slate-900/50 pr-2 flex flex-col gap-2">
                  {row.mistakes
                    .split(/(?=\d+[\.\)]\s)/)
                    .filter(Boolean)
                    .map((point, idx) => {
                      const match = point.match(/^(\d+)[\.\)]\s+([\s\S]+)/);
                      if (match) {
                        return (
                          <div
                            key={idx}
                            className="p-3 bg-rose-500/5 border border-rose-500/20 rounded-xl"
                          >
                            <div className="flex gap-3">
                              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-rose-500/20 text-rose-400 flex items-center justify-center text-xs font-bold">
                                {match[1]}
                              </span>
                              <p className="flex-1 text-slate-200 whitespace-pre-wrap">
                                {cleanText(match[2])}
                              </p>
                            </div>
                          </div>
                        );
                      }
                      return (
                        <p key={idx} className="text-slate-200 whitespace-pre-wrap">
                          {cleanText(point)}
                        </p>
                      );
                    })}
                </div>
              </div>
            )}

            {/* Recommendations */}
            {row.recommendations && (
              <div className="bg-slate-900/50 rounded-2xl p-5 border border-white/5 flex flex-col gap-3 shadow-inner">
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2 shrink-0">
                  <Bot className="w-4 h-4 text-emerald-400" /> Рекомендации
                </h4>
                <div className="text-sm text-slate-200 leading-relaxed overflow-y-auto max-h-[300px] scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-slate-900/50 pr-2 flex flex-col gap-2">
                  {row.recommendations
                    .split(/(?=\d+[\.\)]\s)/)
                    .filter(Boolean)
                    .map((point, idx) => {
                      const match = point.match(/^(\d+)[\.\)]\s+([\s\S]+)/);
                      if (match) {
                        return (
                          <div
                            key={idx}
                            className="p-3 bg-emerald-500/5 border border-emerald-500/20 rounded-xl"
                          >
                            <div className="flex gap-3">
                              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center text-xs font-bold">
                                {match[1]}
                              </span>
                              <p className="flex-1 text-slate-200 whitespace-pre-wrap">
                                {cleanText(match[2])}
                              </p>
                            </div>
                          </div>
                        );
                      }
                      return (
                        <p key={idx} className="text-slate-200 whitespace-pre-wrap">
                          {cleanText(point)}
                        </p>
                      );
                    })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── main component ──────────────────────────────────────────

interface OkkTabProps {
  department: "b2g" | "b2b";
}

export default function OkkTab({ department }: OkkTabProps) {
  // ── Data state ───────────────────────────────────────────
  const [data, setData] = useState<OkkApiResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ── Filter state ─────────────────────────────────────────
  const [dateRange, setDateRange] = useState<DateRange>({ start: null, end: null });
  const [activeDateRange, setActiveDateRange] = useState<DateRange>({
    start: null,
    end: null,
  });
  const [searchQuery, setSearchQuery] = useState("");
  const [scoreFilter, setScoreFilter] = useState(0);
  const [isFilterOpen, setIsFilterOpen] = useState(false);

  // ── Modal state ──────────────────────────────────────────
  const [selectedRow, setSelectedRow] = useState<OkkEvaluationRow | null>(null);

  // ── Audio state ──────────────────────────────────────────
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [audioLoading, setAudioLoading] = useState<string | null>(null);

  // ── Fetch ────────────────────────────────────────────────
  const fetchData = useCallback(
    async (range: DateRange, signal?: AbortSignal) => {
      setIsLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ department });
        if (range.start) params.set("from", range.start.toISOString());
        if (range.end) params.set("to", range.end.toISOString());

        const res = await fetch(`/api/okk?${params.toString()}`, { signal });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        const json: OkkApiResponse = await res.json();
        setData(json);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Ошибка загрузки данных");
      } finally {
        setIsLoading(false);
      }
    },
    [department]
  );

  useEffect(() => {
    const ac = new AbortController();
    fetchData(activeDateRange, ac.signal);
    return () => ac.abort();
  }, [department, activeDateRange, fetchData]);

  // ── Audio controls ───────────────────────────────────────
  const stopAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
    }
    setPlayingId(null);
    setAudioLoading(null);
  }, []);

  useEffect(() => {
    return () => stopAudio();
  }, [department, stopAudio]);

  const toggleAudio = useCallback(
    (row: OkkEvaluationRow) => {
      if (!row.recordingUrl && !row.callId) return;

      if (playingId === row.evaluationId) {
        stopAudio();
        return;
      }
      stopAudio();

      setAudioLoading(row.evaluationId);
      const audio = new Audio();
      audio.preload = "auto";
      audioRef.current = audio;

      const audioSrc = `/api/okk/audio/${row.callId}?dept=${department}`;

      audio.oncanplay = () => {
        setAudioLoading(null);
        setPlayingId(row.evaluationId);
        audio.play().catch(() => {
          setPlayingId(null);
          setAudioLoading(null);
        });
      };
      audio.onended = () => setPlayingId(null);
      audio.onerror = () => {
        setPlayingId(null);
        setAudioLoading(null);
      };

      audio.src = audioSrc;
      audio.load();
    },
    [playingId, stopAudio, department]
  );

  // ── Filtered rows ────────────────────────────────────────
  const filteredRows: OkkEvaluationRow[] = (data?.evaluations ?? []).filter(
    (row) => {
      if (scoreFilter > 0 && (row.totalScore ?? 0) < scoreFilter) return false;
      if (
        searchQuery &&
        !row.managerName?.toLowerCase().includes(searchQuery.toLowerCase())
      )
        return false;
      return true;
    }
  );

  // ── Stats derived from full data ─────────────────────────
  const stats = data?.stats ?? {
    totalCalls: 0,
    avgScore: 0,
    maxScore: 0,
    minScore: 0,
  };
  const byManager: OkkManagerStat[] = data?.byManager ?? [];
  const bestManager = byManager
    .filter((m) => m.count > 0)
    .sort((a, b) => b.avgScore - a.avgScore)[0];

  // ─────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-4 fade-in flex-1">

      {/* ── Top stats cards ──────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 items-stretch">

        {/* Left column: KPI cards */}
        <div className="flex flex-col gap-3">
          {/* Avg Score */}
          <div className="glass-panel rounded-2xl px-4 py-3 border border-white/5 flex items-center justify-between flex-1">
            <div className="flex flex-col">
              <span className="text-[10px] text-slate-400 uppercase tracking-widest font-semibold">
                Ср. балл ОКК
              </span>
              <span className="text-[10px] text-slate-500">по отделу</span>
            </div>
            <span
              className={`text-2xl font-black ${scoreColor(stats.avgScore)}`}
            >
              {stats.avgScore}
            </span>
          </div>

          {/* Total evaluated */}
          <div className="glass-panel rounded-2xl px-4 py-3 border border-white/5 flex items-center justify-between flex-1">
            <div className="flex flex-col">
              <span className="text-[10px] text-slate-400 uppercase tracking-widest font-semibold">
                Оценено звонков
              </span>
              <span className="text-[10px] text-slate-500">за период</span>
            </div>
            <span className="text-2xl font-black text-white">
              {stats.totalCalls}
            </span>
          </div>

          {/* Best manager */}
          <div className="glass-panel rounded-2xl px-4 py-3 border border-white/5 flex items-center justify-between flex-1">
            <div className="flex flex-col min-w-0">
              <span className="text-[10px] text-slate-400 uppercase tracking-widest font-semibold">
                Лучший по качеству
              </span>
              <span className="text-xs text-white font-medium truncate">
                {bestManager?.managerName ?? "—"}
              </span>
            </div>
            <span
              className={`text-2xl font-black shrink-0 ${scoreColor(
                bestManager?.avgScore
              )}`}
            >
              {bestManager ? bestManager.avgScore : "—"}
            </span>
          </div>
        </div>

        {/* Right column: per-manager grid */}
        <div className="lg:col-span-2 glass-panel rounded-2xl p-4 border border-white/5 flex flex-col gap-3">
          <span className="text-[10px] text-slate-400 uppercase tracking-widest font-semibold">
            Оценки менеджеров
          </span>
          {byManager.length === 0 ? (
            <span className="text-sm text-slate-500">
              {isLoading ? "Загрузка..." : "Нет данных за период"}
            </span>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
              {byManager.map((m) => (
                <div
                  key={m.managerId ?? m.managerName}
                  className="flex items-center justify-between py-1.5 border-b border-white/5 last:border-0"
                >
                  <span className="text-sm text-slate-200 truncate mr-3">
                    {m.managerName ?? "Неизвестно"}
                  </span>
                  <div className="flex items-center gap-4 shrink-0">
                    <span className="text-sm font-bold text-white">
                      {m.count}{" "}
                      <span className="text-xs font-normal text-slate-500">
                        зв.
                      </span>
                    </span>
                    <span
                      className={`text-sm font-bold min-w-[40px] text-right ${scoreColor(
                        m.avgScore
                      )}`}
                    >
                      {m.avgScore}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Table card ───────────────────────────────────── */}
      <div className="glass-panel rounded-2xl flex-1 border border-white/5 overflow-hidden flex flex-col shadow-2xl">

        {/* Table header / filters */}
        <div className="p-4 border-b border-white/5 flex justify-between items-center bg-slate-900/20 gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-blue-400" />
            <h2 className="text-sm font-bold tracking-wide uppercase text-slate-200">
              Таблица: ОКК Оценки
            </h2>
          </div>

          <div className="flex gap-3 items-center flex-wrap">
            {/* Date range picker */}
            <CalendarPicker
              mode="range"
              value={dateRange}
              onChange={setDateRange}
              onClear={() => {
                setDateRange({ start: null, end: null });
                setActiveDateRange({ start: null, end: null });
              }}
            />

            {/* Score slider */}
            <div className="hidden sm:flex items-center bg-slate-800/50 rounded-lg px-3 py-1.5 border border-white/5 gap-2">
              <BarChart3 className="w-3.5 h-3.5 text-blue-400 shrink-0" />
              <span className="text-[10px] text-slate-400 whitespace-nowrap">
                от
              </span>
              <input
                type="range"
                min="0"
                max="100"
                value={scoreFilter}
                onChange={(e) => setScoreFilter(parseInt(e.target.value))}
                className="w-20 accent-blue-500 cursor-pointer"
              />
              <span className="text-xs font-bold text-blue-400 w-8 text-right">
                {scoreFilter}
              </span>
            </div>

            {/* Manager search */}
            <div className="hidden sm:flex items-center bg-slate-800/50 rounded-lg px-3 py-1.5 border border-white/5">
              <Search className="w-3.5 h-3.5 text-slate-400 mr-2" />
              <input
                type="text"
                placeholder="Поиск менеджера..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="bg-transparent border-none outline-none text-xs text-slate-200 w-32 placeholder-slate-500"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="ml-1 text-slate-500 hover:text-slate-300 transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>

            {/* Apply date filter button */}
            {dateRange.start && dateRange.end && (
              <button
                onClick={() => setActiveDateRange(dateRange)}
                className="px-3 py-1.5 text-xs font-semibold bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors"
              >
                Применить
              </button>
            )}

            {/* Clear date filter */}
            {(activeDateRange.start || activeDateRange.end) && (
              <button
                onClick={() => {
                  setDateRange({ start: null, end: null });
                  setActiveDateRange({ start: null, end: null });
                }}
                className="px-3 py-1.5 text-xs font-semibold bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg transition-colors flex items-center gap-1"
              >
                <X className="w-3 h-3" />
                Сбросить
              </button>
            )}
          </div>
        </div>

        {/* Table */}
        <div className="w-full overflow-y-auto max-h-[600px] scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">
          <table className="w-full text-left border-collapse">
            <thead className="sticky top-0 z-10">
              <tr className="text-slate-400 text-[10px] uppercase tracking-widest bg-slate-800/90 backdrop-blur-sm">
                <th className="px-5 py-3 font-semibold">Сотрудник</th>
                <th className="px-5 py-3 font-semibold">Клиент</th>
                <th className="px-5 py-3 font-semibold">Время &amp; Дата</th>
                <th className="px-5 py-3 font-semibold text-center">
                  <Clock className="w-3 h-3 inline mr-1" />
                  Длит.
                </th>
                <th className="px-5 py-3 font-semibold text-center">CRM</th>
                <th className="px-5 py-3 font-semibold text-center">Статус CRM</th>
                <th className="px-5 py-3 font-semibold text-center">AI Оценка</th>
                <th className="px-5 py-3 font-semibold text-center">Аудио</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5 text-xs">
              {isLoading ? (
                <tr>
                  <td colSpan={8} className="text-center py-12 text-slate-400">
                    <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
                    Загрузка данных...
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td
                    colSpan={8}
                    className="text-center py-12 text-rose-400 text-sm"
                  >
                    {error}
                  </td>
                </tr>
              ) : filteredRows.length === 0 ? (
                <tr>
                  <td
                    colSpan={8}
                    className="text-center py-12 text-slate-500 text-sm"
                  >
                    Нет оценённых звонков за выбранный период
                  </td>
                </tr>
              ) : (
                filteredRows.map((row) => {
                  const { date, time } = formatDateTime(row.callCreatedAt);
                  const hasRecording = !!row.recordingUrl;
                  const isPlaying = playingId === row.evaluationId;
                  const isAudioLoading = audioLoading === row.evaluationId;

                  return (
                    <tr
                      key={row.evaluationId}
                      className="hover:bg-white/[0.02] transition-colors group"
                    >
                      {/* Сотрудник */}
                      <td className="px-5 py-3 whitespace-nowrap">
                        <span className="font-medium text-slate-200">
                          {row.managerName ?? "—"}
                        </span>
                      </td>

                      {/* Клиент */}
                      <td className="px-5 py-3 whitespace-nowrap text-slate-400 font-mono text-[11px]">
                        {row.contactPhone ?? "—"}
                      </td>

                      {/* Время & Дата */}
                      <td className="px-5 py-3 whitespace-nowrap">
                        <span className="text-slate-300">{time}</span>
                        <span className="text-slate-500 ml-1">{date}</span>
                      </td>

                      {/* Длительность */}
                      <td className="px-5 py-3 text-slate-300 font-mono text-center">
                        {formatDuration(row.durationSeconds)}
                      </td>

                      {/* CRM link */}
                      <td className="px-5 py-3 text-center">
                        {row.kommoLeadUrl ? (
                          <a
                            href={row.kommoLeadUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-block p-1.5 rounded-lg bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20 transition-all shadow-inner border border-cyan-500/20"
                            title="Открыть сделку в Kommo"
                          >
                            <Activity className="w-3.5 h-3.5" />
                          </a>
                        ) : (
                          <span className="text-slate-600">—</span>
                        )}
                      </td>

                      {/* CRM status */}
                      <td className="px-5 py-3 text-center">
                        {row.kommoStatusName ? (
                          <span className="text-[10px] bg-slate-800 text-slate-300 px-2 py-0.5 rounded-full border border-white/5 whitespace-nowrap">
                            {row.kommoStatusName}
                          </span>
                        ) : (
                          <span className="text-slate-600">—</span>
                        )}
                      </td>

                      {/* AI Score */}
                      <td className="px-5 py-3">
                        <div className="flex justify-center items-center">
                          <ScoreCircle
                            score={row.totalScore}
                            size="sm"
                            onClick={() => setSelectedRow(row)}
                          />
                        </div>
                      </td>

                      {/* Audio */}
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2 bg-slate-900/50 p-1.5 rounded-full border border-white/5 w-max mx-auto">
                          <button
                            onClick={() => toggleAudio(row)}
                            disabled={!hasRecording}
                            title={
                              hasRecording
                                ? isPlaying
                                  ? "Пауза"
                                  : "Воспроизвести"
                                : "Запись недоступна"
                            }
                            className={`w-6 h-6 rounded-full flex items-center justify-center transition-all ${
                              !hasRecording
                                ? "bg-slate-700 text-slate-500 cursor-not-allowed"
                                : isPlaying
                                ? "bg-amber-500 text-white hover:scale-105 animate-pulse"
                                : "bg-blue-500 text-white hover:scale-105"
                            }`}
                          >
                            {isAudioLoading ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : isPlaying ? (
                              <Pause className="w-3 h-3" />
                            ) : (
                              <Play className="w-3 h-3 ml-0.5" />
                            )}
                          </button>
                          {/* Waveform bars */}
                          <div className="flex gap-0.5 items-center mr-2">
                            {[3, 6, 4, 8, 5, 7, 3].map((h, i) => (
                              <div
                                key={i}
                                style={{
                                  height: `${h * (isPlaying ? 1.5 : 1)}px`,
                                }}
                                className={`w-[2px] rounded-full transition-all ${
                                  isPlaying
                                    ? "bg-amber-400 animate-pulse"
                                    : hasRecording
                                    ? "bg-blue-500/50"
                                    : "bg-slate-600/30"
                                }`}
                              />
                            ))}
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Row count footer */}
        {!isLoading && !error && filteredRows.length > 0 && (
          <div className="px-5 py-2 border-t border-white/5 bg-slate-900/20">
            <span className="text-[10px] text-slate-500">
              Показано {filteredRows.length} из {data?.evaluations.length ?? 0}{" "}
              оценок
            </span>
          </div>
        )}
      </div>

      {/* ── Eval modal ───────────────────────────────────── */}
      {selectedRow && (
        <EvalModal
          row={selectedRow}
          department={department}
          onClose={() => setSelectedRow(null)}
        />
      )}
    </div>
  );
}
