"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  LayoutDashboard, Phone, Bot, Play, Pause, FileText, Activity, Users,
  Clock, X, Menu, Search, Calendar, Filter, ChevronRight, ChevronDown, BarChart3, ClipboardList, Loader2
} from "lucide-react";
import Image from "next/image";
// recharts moved to DashboardTab component
import { ManagerStat, ManagerCall } from "@/lib/mockData";
import DailyTab from "@/components/DailyTab";
import DashboardTab from "@/components/DashboardTab";
import CalendarPicker, { type DateRange } from "@/components/CalendarPicker";

// Функция для очистки текста от markdown и специальных символов
const cleanText = (text: string) => {
  if (!text) return "";
  return text
    .replace(/\*\*/g, '') // Убрать жирный текст **
    .replace(/\*/g, '')   // Убрать курсив *
    .replace(/\_\_/g, '') // Убрать подчеркивание __
    .replace(/\_/g, '')   // Убрать _
    .replace(/\~/g, '')   // Убрать ~
    .replace(/\`/g, '')   // Убрать `
    .replace(/\[/g, '')   // Убрать [
    .replace(/\]/g, '')   // Убрать ]
    .replace(/\#/g, '')   // Убрать #
    .trim();
};

// Функции для работы с календарем
const getDaysInMonth = (date: Date) => {
  const year = date.getFullYear();
  const month = date.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDayOfMonth = new Date(year, month, 1).getDay();
  return { daysInMonth, firstDayOfMonth };
};

const isSameDay = (date1: Date | null, date2: Date | null) => {
  if (!date1 || !date2) return false;
  return date1.getDate() === date2.getDate() &&
    date1.getMonth() === date2.getMonth() &&
    date1.getFullYear() === date2.getFullYear();
};

const isInRange = (date: Date, start: Date | null, end: Date | null) => {
  if (!start || !end) return false;
  return date >= start && date <= end;
};

export default function Dashboard() {
  const [activeDepartment, setActiveDepartment] = useState<"b2g" | "b2b">("b2g");
  const [activeTab, setActiveTab] = useState<"dashboard" | "daily" | "real_calls" | "ai_calls">("dashboard");
  const [lineFilter, setLineFilter] = useState<"all" | "1" | "2">("all");
  // dailyFilter moved to DailyTab component

  // API Data States
  const [aiCalls, setAiCalls] = useState<ManagerCall[]>([]);
  const [aiManagers, setAiManagers] = useState<ManagerStat[]>([]);
  const [isLoadingAI, setIsLoadingAI] = useState(true);

  // Client-side cache per department
  const [dataCache, setDataCache] = useState<Record<string, { calls: ManagerCall[]; managers: ManagerStat[] }>>({});

  // UI States
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  const [selectedCall, setSelectedCall] = useState<ManagerCall | null>(null);
  const [callDetailLoading, setCallDetailLoading] = useState(false);
  const [callModalType, setCallModalType] = useState<"transcript" | "scoring">("transcript");
  const [selectedManager, setSelectedManager] = useState<ManagerStat | null>(null);
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [scoreFilter, setScoreFilter] = useState(0);
  const [dateRange, setDateRange] = useState<{ start: Date | null; end: Date | null }>({ start: null, end: null });
  const [activeDateFilter, setActiveDateFilter] = useState<{ start: Date | null; end: Date | null }>({ start: null, end: null });
  const [calendarMonth, setCalendarMonth] = useState(new Date());
  const [searchQuery, setSearchQuery] = useState("");

  // AI Dashboard period filter
  const [aiDashPeriod, setAiDashPeriod] = useState<"day" | "week" | "month">("week");
  const [aiCustomRange, setAiCustomRange] = useState<DateRange>({ start: null, end: null });

  // Manager filter states
  const [managerPeriod, setManagerPeriod] = useState<"week" | "month" | "all">("month");
  const [managerMinScore, setManagerMinScore] = useState(0);
  const [managerCalls, setManagerCalls] = useState<ManagerCall[]>([]);
  const [managerStats, setManagerStats] = useState({
    totalCalls: 0,
    avgScore: 0,
    avgDuration: "00:00",
    filteredCalls: 0,
  });

  // Audio player state
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playingCallId, setPlayingCallId] = useState<string | null>(null);
  const [audioLoading, setAudioLoading] = useState<string | null>(null);
  const [audioCurrentTime, setAudioCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [audioPlaybackRate, setAudioPlaybackRate] = useState(1);
  const [audioPaused, setAudioPaused] = useState(false);

  // Accordion state: set of open block IDs in the scoring modal
  const [openBlocks, setOpenBlocks] = useState<Set<string>>(new Set());

  const toggleBlock = (blockId: string) => {
    setOpenBlocks(prev => {
      const next = new Set(prev);
      if (next.has(blockId)) {
        next.delete(blockId);
      } else {
        next.add(blockId);
      }
      return next;
    });
  };

  const stopAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
    }
    setPlayingCallId(null);
    setAudioLoading(null);
    setAudioCurrentTime(0);
    setAudioDuration(0);
    setAudioPaused(false);
  }, []);

  const toggleAudio = useCallback((call: ManagerCall) => {
    if (!call.hasRecording) return;

    // If same call is playing — toggle pause/resume
    if (playingCallId === call.id) {
      const audio = audioRef.current;
      if (audio) {
        if (audio.paused) {
          audio.play();
          setAudioPaused(false);
        } else {
          audio.pause();
          setAudioPaused(true);
        }
      }
      return;
    }

    // Stop previous audio
    stopAudio();

    // Start new audio
    setAudioLoading(call.id);
    setAudioPlaybackRate(1);
    const audio = new Audio();
    audio.preload = "auto";
    audioRef.current = audio;

    audio.onloadedmetadata = () => {
      setAudioDuration(audio.duration);
    };

    audio.ontimeupdate = () => {
      setAudioCurrentTime(audio.currentTime);
    };

    audio.oncanplay = () => {
      setAudioLoading(null);
      setPlayingCallId(call.id);
      setAudioPaused(false);
      audio.play().catch(() => {
        setPlayingCallId(null);
        setAudioLoading(null);
      });
    };

    audio.onended = () => {
      setPlayingCallId(null);
      setAudioCurrentTime(0);
      setAudioPaused(false);
    };

    audio.onerror = () => {
      console.error("Audio error:", audio.error?.message, audio.error?.code);
      setPlayingCallId(null);
      setAudioLoading(null);
    };

    // Set src after listeners to ensure events fire
    audio.src = call.audioUrl;
    audio.load();
  }, [playingCallId, stopAudio]);

  const seekAudio = useCallback((fraction: number) => {
    if (audioRef.current && audioDuration > 0) {
      audioRef.current.currentTime = fraction * audioDuration;
    }
  }, [audioDuration]);

  const cyclePlaybackRate = useCallback(() => {
    const rates = [1, 1.5, 2];
    const nextIdx = (rates.indexOf(audioPlaybackRate) + 1) % rates.length;
    const newRate = rates[nextIdx];
    setAudioPlaybackRate(newRate);
    if (audioRef.current) {
      audioRef.current.playbackRate = newRate;
    }
  }, [audioPlaybackRate]);

  const fmtTime = (sec: number) => {
    if (!sec || !isFinite(sec)) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  // Cleanup audio on unmount or department change
  useEffect(() => {
    return () => { stopAudio(); };
  }, [activeDepartment, stopAudio]);

  // ── OKK Real Calls data ──
  const [realCalls, setRealCalls] = useState<ManagerCall[]>([]);
  const [realManagers, setRealManagers] = useState<ManagerStat[]>([]);
  const [isLoadingReal, setIsLoadingReal] = useState(true);
  const [realDataCache, setRealDataCache] = useState<Record<string, { calls: ManagerCall[]; managers: ManagerStat[] }>>({});

  // Load BOTH datasets in PARALLEL (single useEffect, Promise.all)
  useEffect(() => {
    const ac = new AbortController();
    const dept = activeDepartment;

    // AI data
    const cachedAI = dataCache[dept];
    if (cachedAI) {
      setAiCalls(cachedAI.calls);
      setAiManagers(cachedAI.managers);
      setIsLoadingAI(false);
    } else {
      setIsLoadingAI(true);
    }

    // OKK data
    const cachedOKK = realDataCache[dept];
    if (cachedOKK) {
      setRealCalls(cachedOKK.calls);
      setRealManagers(cachedOKK.managers);
      setIsLoadingReal(false);
    } else {
      setIsLoadingReal(true);
    }

    // Fetch only what's not cached — in PARALLEL
    const fetches: Promise<void>[] = [];

    if (!cachedAI) {
      fetches.push(
        fetch(`/api/calls?department=${dept}&type=all`, { signal: ac.signal })
          .then(r => r.json())
          .then(res => {
            if (res.success) {
              setAiCalls(res.data.calls);
              setAiManagers(res.data.managers);
              setDataCache(prev => ({ ...prev, [dept]: { calls: res.data.calls, managers: res.data.managers } }));
            }
          })
          .catch(e => { if (e instanceof DOMException && e.name === "AbortError") return; console.error("Error loading AI calls:", e); })
          .finally(() => setIsLoadingAI(false))
      );
    }

    if (!cachedOKK) {
      fetches.push(
        fetch(`/api/okk/calls?department=${dept}`, { signal: ac.signal })
          .then(r => r.json())
          .then(res => {
            if (res.success) {
              setRealCalls(res.data.calls);
              setRealManagers(res.data.managers);
              setRealDataCache(prev => ({ ...prev, [dept]: { calls: res.data.calls, managers: res.data.managers } }));
            }
          })
          .catch(e => { if (e instanceof DOMException && e.name === "AbortError") return; console.error("Error loading OKK calls:", e); })
          .finally(() => setIsLoadingReal(false))
      );
    }

    return () => ac.abort();
  }, [activeDepartment]);

  // Parse date from Russian format (Сегодня, Вчера, DD.MM)
  const parseCallDate = (dateStr: string): Date => {
    const now = new Date();

    if (dateStr.startsWith('Сегодня')) {
      return now;
    } else if (dateStr.startsWith('Вчера')) {
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      return yesterday;
    } else {
      // Format: "DD.MM, HH:MM"
      const match = dateStr.match(/(\d{2})\.(\d{2})/);
      if (match) {
        const day = parseInt(match[1]);
        const month = parseInt(match[2]) - 1; // месяцы с 0
        const year = now.getFullYear();
        return new Date(year, month, day);
      }
    }
    return now;
  };

  // Calculate manager stats with filters
  useEffect(() => {
    if (!selectedManager) return;

    const currentCalls = activeTab === "real_calls" ? realCalls : aiCalls;

    // All calls for this manager (including unevaluated / score=0)
    const allManagerCalls = currentCalls.filter(
      call => call.name === selectedManager.name
    );

    // Apply period filter
    const now = new Date();
    now.setHours(23, 59, 59, 999);

    const filteredByPeriod = allManagerCalls.filter(call => {
      const callDate = parseCallDate(call.date);

      if (managerPeriod === "week") {
        const weekAgo = new Date(now);
        weekAgo.setDate(weekAgo.getDate() - 7);
        weekAgo.setHours(0, 0, 0, 0);
        return callDate >= weekAgo;
      } else if (managerPeriod === "month") {
        const monthAgo = new Date(now);
        monthAgo.setDate(monthAgo.getDate() - 30);
        monthAgo.setHours(0, 0, 0, 0);
        return callDate >= monthAgo;
      }
      return true; // all
    });

    const totalInPeriod = filteredByPeriod.length;

    // Apply min score filter
    const filtered = filteredByPeriod.filter(call => call.score >= managerMinScore);

    setManagerCalls(filtered);

    // Calculate stats — avgScore only from scored calls
    const scoredFiltered = filtered.filter(c => c.score > 0);
    const avgScore = scoredFiltered.length > 0
      ? Math.round(scoredFiltered.reduce((sum, c) => sum + c.score, 0) / scoredFiltered.length)
      : 0;

    // Рассчитать ОБЩЕЕ время (сумму)
    const totalSeconds = filtered.reduce((sum, c) => {
      const [min, sec] = c.callDuration.split(':').map(Number);
      return sum + (min * 60 + sec);
    }, 0);

    const totalMin = Math.floor(totalSeconds / 60);
    const totalSec = totalSeconds % 60;
    const totalDuration = `${totalMin} мин ${totalSec} сек`;

    setManagerStats({
      totalCalls: totalInPeriod,
      avgScore,
      avgDuration: totalDuration,
      filteredCalls: filtered.length,
    });
  }, [selectedManager, managerPeriod, managerMinScore, aiCalls, activeTab, realCalls]);

  // Pick data source based on active tab
  const activeCalls = activeTab === "real_calls" ? realCalls : aiCalls;
  const activeManagers = activeTab === "real_calls" ? realManagers : aiManagers;
  const isLoadingCalls = activeTab === "real_calls" ? isLoadingReal : isLoadingAI;

  // Dashboard stats for calls tabs (managers only, no ROPs/admins)
  const callsDashStats = (() => {
    const allCalls = activeCalls;
    const managers = activeManagers
      .filter(m => !m.role || m.role === "manager")
      .filter(m => lineFilter === "all" || m.line === lineFilter);
    const managerNames = new Set(managers.map(m => m.name));

    const now = new Date();
    now.setHours(23, 59, 59, 999);

    let periodStart: Date;
    let periodEnd = now;

    // Custom date range overrides period buttons
    if (aiCustomRange.start && aiCustomRange.end) {
      periodStart = new Date(aiCustomRange.start);
      periodStart.setHours(0, 0, 0, 0);
      periodEnd = new Date(aiCustomRange.end);
      periodEnd.setHours(23, 59, 59, 999);
    } else if (aiDashPeriod === "day") {
      periodStart = new Date(now);
      periodStart.setHours(0, 0, 0, 0);
    } else if (aiDashPeriod === "week") {
      periodStart = new Date(now);
      periodStart.setDate(periodStart.getDate() - 7);
      periodStart.setHours(0, 0, 0, 0);
    } else {
      periodStart = new Date(now);
      periodStart.setDate(periodStart.getDate() - 30);
      periodStart.setHours(0, 0, 0, 0);
    }

    // ALL calls in period (including unevaluated / score=0)
    const periodCalls = allCalls.filter(call => {
      if (!managerNames.has(call.name)) return false;
      const callDate = parseCallDate(call.date);
      return callDate >= periodStart && callDate <= periodEnd;
    });

    const totalRoleplays = periodCalls.length;
    // avgScore only from evaluated calls (score > 0)
    const scoredCalls = periodCalls.filter(c => c.score > 0);
    const avgScore = scoredCalls.length > 0
      ? Math.round(scoredCalls.reduce((sum, c) => sum + c.score, 0) / scoredCalls.length)
      : 0;

    // Per-manager breakdown — count all calls, avg only scored
    const perManager = managers.map(m => {
      const mCalls = periodCalls.filter(c => c.name === m.name);
      const mScored = mCalls.filter(c => c.score > 0);
      const count = mCalls.length;
      const avg = mScored.length > 0
        ? Math.round(mScored.reduce((sum, c) => sum + c.score, 0) / mScored.length)
        : 0;
      return { name: m.name, avgScore: avg, count };
    }).sort((a, b) => b.count - a.count);

    // Target completion: qualifying calls ≥10 min (regardless of score)
    const TARGET_WEEK = 5;
    const TARGET_MONTH = 20;
    // For custom range, estimate target based on range length
    let target: number;
    if (aiCustomRange.start && aiCustomRange.end) {
      const rangeDays = Math.max(1, Math.round((periodEnd.getTime() - periodStart.getTime()) / (1000 * 60 * 60 * 24)));
      target = rangeDays <= 7 ? TARGET_WEEK : Math.round((rangeDays / 30) * TARGET_MONTH);
    } else {
      target = aiDashPeriod === "month" ? TARGET_MONTH : TARGET_WEEK;
    }

    // Filter ALL calls in period for qualifying duration (≥10 min), no score filter
    const periodAllCalls = allCalls.filter(call => {
      if (!managerNames.has(call.name)) return false;
      const callDate = parseCallDate(call.date);
      return callDate >= periodStart && callDate <= periodEnd;
    });

    const perManagerTarget = managers.map(m => {
      const mCalls = periodAllCalls.filter(c => {
        if (c.name !== m.name) return false;
        // Parse "MM:SS" duration to check ≥10 min
        const [min] = c.callDuration.split(":").map(Number);
        return min >= 10;
      });
      const qualifyingCount = mCalls.length;
      const targetPercent = target > 0 ? Math.min(100, Math.round((qualifyingCount / target) * 100)) : 0;
      return { name: m.name, qualifyingCount, target, targetPercent };
    }).sort((a, b) => b.targetPercent - a.targetPercent || b.qualifyingCount - a.qualifyingCount);

    const teamTargetAvg = perManagerTarget.length > 0
      ? Math.round(perManagerTarget.reduce((sum, m) => sum + m.targetPercent, 0) / perManagerTarget.length)
      : 0;

    return { avgScore, totalCalls: totalRoleplays, perManager, perManagerTarget, target, teamTargetAvg };
  })();

  // Filter managers by role + line — totalCalls & avgScore come directly from the API
  const filteredManagers = activeManagers
    .filter(m => !m.role || m.role === "manager")
    .filter(m => lineFilter === "all" || m.line === lineFilter);

  // Set of manager names matching current line filter (for call filtering)
  const filteredManagerNames = new Set(filteredManagers.map(m => m.name));

  // Filter calls by line, date range, score, and search query
  const filteredCalls = activeCalls.filter(call => {
    // Filter by line (via manager name)
    if (lineFilter !== "all" && !filteredManagerNames.has(call.name)) {
      return false;
    }

    // Filter by date range
    if (activeDateFilter.start && activeDateFilter.end) {
      const callDate = parseCallDate(call.date);
      const startOfDay = new Date(activeDateFilter.start);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(activeDateFilter.end);
      endOfDay.setHours(23, 59, 59, 999);

      if (!(callDate >= startOfDay && callDate <= endOfDay)) {
        return false;
      }
    }

    // Filter by minimum score
    if (call.score < scoreFilter) {
      return false;
    }

    // Filter by search query
    if (searchQuery.trim()) {
      return call.name.toLowerCase().includes(searchQuery.toLowerCase());
    }

    return true;
  });

  // When a call is selected, open the first block by default
  useEffect(() => {
    if (selectedCall && selectedCall.blocks && selectedCall.blocks.length > 0) {
      setOpenBlocks(new Set([selectedCall.blocks[0].id]));
    } else {
      setOpenBlocks(new Set());
    }
  }, [selectedCall]);

  // ── Lazy-load call details on click (transcript, blocks, criteria) ──
  const handleSelectCall = useCallback(async (call: ManagerCall, modalType: "transcript" | "scoring") => {
    setCallModalType(modalType);

    // If full data already loaded (transcript non-empty), show immediately
    if (call.transcript) {
      setSelectedCall(call);
      return;
    }

    // Show modal with loading state
    setSelectedCall(call);
    setCallDetailLoading(true);

    try {
      const isOkk = activeTab === "real_calls";
      const url = isOkk
        ? `/api/okk/calls/${call.id}?dept=${activeDepartment}`
        : `/api/calls/${call.id}?department=${activeDepartment}`;
      const res = await fetch(url);
      const json = await res.json();

      if (json.success && json.data) {
        const fullCall: ManagerCall = { ...call, ...json.data };
        setSelectedCall(fullCall);

        // Update cache so next click is instant
        if (isOkk) {
          setRealCalls(prev => prev.map(c => c.id === call.id ? fullCall : c));
          setRealDataCache(prev => {
            const cached = prev[activeDepartment];
            if (!cached) return prev;
            return { ...prev, [activeDepartment]: { ...cached, calls: cached.calls.map(c => c.id === call.id ? fullCall : c) } };
          });
        } else {
          setAiCalls(prev => prev.map(c => c.id === call.id ? fullCall : c));
          setDataCache(prev => {
            const cached = prev[activeDepartment];
            if (!cached) return prev;
            return { ...prev, [activeDepartment]: { ...cached, calls: cached.calls.map(c => c.id === call.id ? fullCall : c) } };
          });
        }
      }
    } catch (e) {
      console.error("Error loading call details:", e);
    } finally {
      setCallDetailLoading(false);
    }
  }, [activeTab, activeDepartment]);

  // Close modals
  const closeModal = () => {
    setSelectedCall(null);
  };
  const closeManagerSidebar = () => setSelectedManager(null);

  return (
    <div className="flex sm:flex-row flex-col min-h-screen text-slate-100 p-2 sm:p-4 gap-4 relative overflow-hidden text-sm">
      {/* BACKGROUND DECORATIONS (GLOWS) - Changed to Blue tones */}
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-blue-600/10 blur-[120px] rounded-full pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[30%] h-[50%] bg-cyan-500/10 blur-[150px] rounded-full pointer-events-none" />
      <div className="absolute top-[40%] left-[30%] w-[20%] h-[20%] bg-sky-400/5 blur-[100px] rounded-full pointer-events-none" />

      {/* COLLAPSIBLE SIDEBAR */}
      <aside className={`glass-panel rounded-3xl p-5 flex flex-col gap-6 shadow-2xl relative z-20 border border-white/5 transition-all duration-300 ${isSidebarOpen ? "w-full sm:w-64" : "w-full sm:w-20 items-center"
        }`}>
        <div className="flex items-center justify-between w-full">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0">
              <Image src="/logo.png" alt="Logo" width={40} height={40} className="rounded-xl" />
            </div>
            {isSidebarOpen && (
              <div>
                <h1 className="font-bold text-base leading-tight tracking-tight">Sternmeister</h1>
                <p className="text-[10px] text-blue-300 uppercase tracking-widest font-semibold">Dashboard</p>
              </div>
            )}
          </div>
          <button onClick={() => setIsSidebarOpen(!isSidebarOpen)} className="text-slate-400 hover:text-white sm:block hidden p-1 rounded-lg hover:bg-white/5">
            <Menu className="w-4 h-4" />
          </button>
        </div>

        <nav className="flex flex-col gap-2 mt-4 w-full">
          {[
            { id: "dashboard", icon: LayoutDashboard, label: "Дашборд" },
            { id: "daily", icon: ClipboardList, label: "Дейли" },
            { id: "real_calls", icon: Phone, label: "ОКК" },
            { id: "ai_calls", icon: Bot, label: "AI Ролевые" },
          ].map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id as any)}
              className={`flex items-center gap-4 px-4 py-3 rounded-2xl transition-all duration-300 font-medium whitespace-nowrap ${activeTab === item.id
                ? "bg-blue-500/20 text-blue-300 shadow-[inset_0_1px_1px_rgba(255,255,255,0.1)] border border-blue-500/30"
                : "text-slate-400 hover:text-white hover:bg-white/5"
                } ${!isSidebarOpen && "justify-center px-0"}`}
              title={!isSidebarOpen ? item.label : undefined}
            >
              <item.icon className="w-5 h-5 shrink-0" />
              {isSidebarOpen && <span>{item.label}</span>}
            </button>
          ))}
        </nav>
      </aside>

      {/* MAIN CONTENT AREA */}
      <main className="flex-1 flex flex-col gap-4 relative z-10 min-w-0">

        {/* TOP NAVIGATION / HEADER */}
        <header className="glass-panel rounded-2xl px-5 py-3 flex flex-col sm:flex-row justify-between items-center shadow-lg border border-white/5 gap-4">
          <div className="flex bg-slate-800/50 p-1 rounded-xl border border-white/5 shadow-inner w-full sm:w-auto">
            <button
              onClick={() => { setActiveDepartment("b2g"); setLineFilter("all"); }}
              className={`flex-1 sm:flex-none px-6 py-2 rounded-lg text-xs font-semibold tracking-wide transition-all duration-300 ${activeDepartment === "b2g" ? "bg-gradient-to-r from-blue-500 to-cyan-500 text-white shadow-lg" : "text-slate-400 hover:text-white"
                }`}
            >
              Госники (B2G)
            </button>
            <button
              onClick={() => { setActiveDepartment("b2b"); setLineFilter("all"); }}
              className={`flex-1 sm:flex-none px-6 py-2 rounded-lg text-xs font-semibold tracking-wide transition-all duration-300 ${activeDepartment === "b2b" ? "bg-gradient-to-r from-blue-500 to-cyan-500 text-white shadow-lg" : "text-slate-400 hover:text-white"
                }`}
            >
              Коммерсы (B2C)
            </button>
          </div>

        </header>

        {/* --------------------- DASHBOARD VIEW --------------------- */}
        {activeTab === "dashboard" && (
          <DashboardTab department={activeDepartment} />
        )}

        {/* --------------------- DAILY VIEW --------------------- */}
        {activeTab === "daily" && (
          <DailyTab department={activeDepartment} />
        )}

        {/* --------------------- CALLS VIEW (Real / AI) --------------------- */}
        {(activeTab === "real_calls" || activeTab === "ai_calls") && (
          <div className="flex flex-col gap-4 fade-in flex-1">

            {/* Top Managers List Row */}
            <div className="flex gap-4 overflow-x-auto pb-2 scrollbar-hide">
              {filteredManagers.map((manager) => (
                <button
                  key={manager.id}
                  onClick={() => setSelectedManager(manager)}
                  className="glass-panel flex-shrink-0 flex items-center gap-3 p-3 pr-6 rounded-2xl border border-white/5 hover:border-blue-500/30 transition-all text-left group"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="font-semibold text-slate-100 text-xs group-hover:text-blue-300">{manager.name}</h4>
                      {manager.role && (
                        <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-md ${
                          manager.role === 'rop' ? 'bg-amber-500/20 text-amber-400' :
                          manager.role === 'admin' ? 'bg-purple-500/20 text-purple-400' :
                          'bg-blue-500/20 text-blue-400'
                        }`}>
                          {manager.role === 'rop' ? 'РОП' : manager.role === 'admin' ? 'Админ' : 'Менеджер'}
                        </span>
                      )}
                      {activeDepartment === "b2g" && (() => {
                        const mgr = activeManagers.find(am => am.name === manager.name);
                        const lineLabel = mgr?.line === "1" ? "1я" : mgr?.line === "2" ? "2я" : null;
                        return lineLabel ? <span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-slate-700 text-slate-400">{lineLabel}</span> : null;
                      })()}
                    </div>
                    <p className="text-[10px] text-slate-400 mt-0.5">Звонков: <span className="text-white font-medium">{manager.totalCalls}</span></p>
                  </div>
                </button>
              ))}
            </div>

            {/* CALLS DASHBOARD — stats for ai_calls */}
            <div className="flex flex-col gap-3">
              {/* Period Filter + Calendar */}
              <div className="flex items-center gap-2 flex-wrap">
                <div className="flex bg-slate-800/50 p-1 rounded-xl border border-white/5 shadow-inner">
                  {([
                    { id: "day", label: "День" },
                    { id: "week", label: "Неделя" },
                    { id: "month", label: "Месяц" },
                  ] as const).map((p) => (
                    <button
                      key={p.id}
                      onClick={() => { setAiDashPeriod(p.id); setAiCustomRange({ start: null, end: null }); }}
                      className={`px-4 py-1.5 rounded-lg text-[11px] uppercase tracking-widest font-bold transition-all ${
                        aiDashPeriod === p.id && !aiCustomRange.start
                          ? "bg-blue-500/20 text-blue-400 border border-blue-500/30"
                          : "text-slate-400 hover:text-white"
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                <CalendarPicker
                  mode="range"
                  value={aiCustomRange}
                  onChange={(range) => setAiCustomRange(range)}
                  onClear={() => setAiCustomRange({ start: null, end: null })}
                />
                {activeDepartment === "b2g" && (
                  <div className="flex gap-1 ml-2">
                    {(["all", "1", "2"] as const).map(val => (
                      <button key={val} onClick={() => setLineFilter(val)}
                        className={`px-2 py-1 text-[10px] rounded-lg transition-all ${lineFilter === val ? "bg-blue-600 text-white" : "bg-slate-800 text-slate-400 hover:bg-slate-700"}`}>
                        {val === "all" ? "Все" : val === "1" ? "Квалиф." : "Бератер"}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Stats Row: compact KPIs left + wide manager list right */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 items-stretch">
                {/* Left column: KPI cards stacked */}
                <div className="flex flex-col gap-3">
                  {/* KPI: Average Score */}
                  <div className="glass-panel rounded-2xl px-4 py-3 border border-white/5 flex items-center justify-between flex-1">
                    <span className="text-[10px] text-slate-400 uppercase tracking-widest font-semibold">Ср. балл отдела</span>
                    <span className={`text-2xl font-black ${
                      callsDashStats.avgScore >= 66 ? "text-emerald-400" :
                      callsDashStats.avgScore >= 41 ? "text-amber-400" : "text-rose-400"
                    }`}>
                      {callsDashStats.avgScore}%
                    </span>
                  </div>

                  {/* KPI: Total Calls */}
                  <div className="glass-panel rounded-2xl px-4 py-3 border border-white/5 flex items-center justify-between flex-1">
                    <div className="flex flex-col">
                      <span className="text-[10px] text-slate-400 uppercase tracking-widest font-semibold">
                        {activeTab === "ai_calls" ? "Ролевок" : "Звонков"}
                      </span>
                      <span className="text-[10px] text-slate-500">
                        {aiDashPeriod === "day" ? "за сегодня" : aiDashPeriod === "week" ? "за неделю" : "за месяц"}
                      </span>
                    </div>
                    <span className="text-2xl font-black text-white">{callsDashStats.totalCalls}</span>
                  </div>

                  {/* KPI: Best by Score */}
                  {(() => {
                    const best = callsDashStats.perManager.filter(m => m.count > 0).sort((a, b) => b.avgScore - a.avgScore)[0];
                    return (
                      <div className="glass-panel rounded-2xl px-4 py-3 border border-white/5 flex items-center justify-between flex-1">
                        <div className="flex flex-col min-w-0">
                          <span className="text-[10px] text-slate-400 uppercase tracking-widest font-semibold">Лучший по качеству</span>
                          <span className="text-xs text-white font-medium truncate">{best?.name || "—"}</span>
                        </div>
                        <span className={`text-2xl font-black shrink-0 ${
                          best && best.avgScore >= 66 ? "text-emerald-400" :
                          best && best.avgScore >= 41 ? "text-amber-400" : "text-rose-400"
                        }`}>
                          {best ? `${best.avgScore}%` : "—"}
                        </span>
                      </div>
                    );
                  })()}

                  {/* KPI: Best by Count */}
                  {(() => {
                    const best = callsDashStats.perManager.filter(m => m.count > 0).sort((a, b) => b.count - a.count)[0];
                    return (
                      <div className="glass-panel rounded-2xl px-4 py-3 border border-white/5 flex items-center justify-between flex-1">
                        <div className="flex flex-col min-w-0">
                          <span className="text-[10px] text-slate-400 uppercase tracking-widest font-semibold">Лучший по количеству</span>
                          <span className="text-xs text-white font-medium truncate">{best?.name || "—"}</span>
                        </div>
                        <span className="text-2xl font-black text-white shrink-0">
                          {best ? best.count : "—"}
                        </span>
                      </div>
                    );
                  })()}
                </div>

                {/* Right column: Per-Manager Scores (2/3 width) */}
                <div className="lg:col-span-2 glass-panel rounded-2xl p-4 border border-white/5 flex flex-col gap-3">
                  <span className="text-[10px] text-slate-400 uppercase tracking-widest font-semibold">Оценки менеджеров</span>
                  {callsDashStats.perManager.length === 0 ? (
                    <span className="text-sm text-slate-500">Нет данных за период</span>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
                      {callsDashStats.perManager.map((m) => (
                        <div key={m.name} className="flex items-center justify-between py-1.5 border-b border-white/5 last:border-0">
                          <span className="text-sm text-slate-200 truncate mr-3">{m.name}</span>
                          <div className="flex items-center gap-4 shrink-0">
                            <span className="text-sm font-bold text-white">{m.count} <span className="text-xs font-normal text-slate-500">{activeTab === "ai_calls" ? "рол." : "зв."}</span></span>
                            <span className={`text-sm font-bold min-w-[40px] text-right ${
                              m.avgScore >= 66 ? "text-emerald-400" :
                              m.avgScore >= 41 ? "text-amber-400" :
                              m.count === 0 ? "text-slate-600" : "text-rose-400"
                            }`}>
                              {m.count > 0 ? `${m.avgScore}%` : "—"}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* TARGET COMPLETION: qualifying roleplays ≥10 min */}
            {activeTab === "ai_calls" && (
              <div className="glass-panel rounded-2xl p-4 border border-white/5 flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-[10px] text-slate-400 uppercase tracking-widest font-semibold">Таргет выполнения</span>
                    <span className="text-[10px] text-slate-500">
                      {aiDashPeriod === "month" ? "месяц: 20 ролевок от 10 мин" : "неделя: 5 ролевок от 10 мин"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-slate-500 uppercase">Команда</span>
                    <span className={`text-sm font-black ${
                      callsDashStats.teamTargetAvg >= 100 ? "text-emerald-400" :
                      callsDashStats.teamTargetAvg >= 50 ? "text-amber-400" :
                      callsDashStats.teamTargetAvg === 0 ? "text-slate-600" : "text-rose-400"
                    }`}>
                      {callsDashStats.teamTargetAvg}%
                    </span>
                  </div>
                </div>

                {callsDashStats.perManagerTarget.length === 0 ? (
                  <span className="text-sm text-slate-500">Нет данных за период</span>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-2">
                    {callsDashStats.perManagerTarget.map((m) => {
                      const color = m.targetPercent >= 100 ? "emerald" :
                        m.targetPercent >= 50 ? "amber" :
                        m.qualifyingCount === 0 ? "slate" : "rose";
                      return (
                        <div key={m.name} className="flex flex-col gap-1 py-1.5 border-b border-white/5 last:border-0">
                          <div className="flex items-center justify-between">
                            <span className="text-sm text-slate-200 truncate mr-3">{m.name}</span>
                            <div className="flex items-center gap-3 shrink-0">
                              <span className="text-xs text-slate-400">
                                {m.qualifyingCount}<span className="text-slate-600">/{m.target}</span>
                              </span>
                              <span className={`text-sm font-bold min-w-[36px] text-right ${
                                color === "emerald" ? "text-emerald-400" :
                                color === "amber" ? "text-amber-400" :
                                color === "slate" ? "text-slate-600" : "text-rose-400"
                              }`}>
                                {m.targetPercent}%
                              </span>
                            </div>
                          </div>
                          {/* Progress bar */}
                          <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all duration-500 ${
                                color === "emerald" ? "bg-emerald-500" :
                                color === "amber" ? "bg-amber-500" :
                                color === "slate" ? "bg-slate-700" : "bg-rose-500"
                              }`}
                              style={{ width: `${m.targetPercent}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* DATA TABLE */}
            <div className="glass-panel rounded-2xl flex-1 border border-white/5 overflow-hidden flex flex-col shadow-2xl">
              <div className="p-4 border-b border-white/5 flex justify-between items-center bg-slate-900/20">
                <h2 className="text-sm font-bold tracking-wide uppercase text-slate-200">
                  {activeTab === "real_calls" ? "Таблица: ОКК" : "Таблица: Ролевые AI Звонки"}
                </h2>
                {/* Advanced Table Filters */}
                <div className="flex gap-3 items-center">
                  <div className="hidden sm:flex items-center bg-slate-800/50 rounded-lg px-3 py-1.5 border border-white/5 gap-2">
                    <BarChart3 className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                    <span className="text-[10px] text-slate-400 whitespace-nowrap">от</span>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={scoreFilter}
                      onChange={(e) => setScoreFilter(parseInt(e.target.value))}
                      className="w-20 accent-blue-500 cursor-pointer"
                    />
                    <span className="text-xs font-bold text-blue-400 w-8 text-right">{scoreFilter}%</span>
                  </div>
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

                  {/* Filter & Date button */}
                  <div className="relative">
                    <button
                      onClick={() => setIsFilterOpen(!isFilterOpen)}
                      className={`border hover:bg-white/10 rounded-lg px-3 py-1.5 text-slate-300 flex items-center gap-2 transition-colors relative ${isFilterOpen ? "bg-white/10 border-blue-500/50" : "bg-slate-800/40 border-white/5"}`}
                    >
                      <Filter className="w-3.5 h-3.5 text-blue-400" />
                      <span className="text-xs">Фильтры</span>
                      {activeDateFilter.start && activeDateFilter.end && (
                        <span className="absolute -top-1 -right-1 w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
                      )}
                    </button>

                    {isFilterOpen && (
                      <div className="absolute top-10 right-0 bg-slate-900 border border-white/10 rounded-2xl p-4 shadow-2xl z-50 w-80 flex flex-col gap-4 animate-in fade-in slide-in-from-top-2">
                        <div>
                          <label className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-3 flex items-center gap-2">
                            <Calendar className="w-3.5 h-3.5 text-blue-400" /> Выбрать период
                          </label>

                          <div className="flex items-center justify-between mb-3">
                            <button
                              onClick={() => {
                                const newMonth = new Date(calendarMonth);
                                newMonth.setMonth(newMonth.getMonth() - 1);
                                setCalendarMonth(newMonth);
                              }}
                              className="p-1 hover:bg-white/5 rounded-lg transition-colors"
                            >
                              <ChevronRight className="w-4 h-4 rotate-180 text-slate-400" />
                            </button>
                            <span className="text-xs font-bold text-white">
                              {calendarMonth.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })}
                            </span>
                            <button
                              onClick={() => {
                                const newMonth = new Date(calendarMonth);
                                newMonth.setMonth(newMonth.getMonth() + 1);
                                setCalendarMonth(newMonth);
                              }}
                              className="p-1 hover:bg-white/5 rounded-lg transition-colors"
                            >
                              <ChevronRight className="w-4 h-4 text-slate-400" />
                            </button>
                          </div>

                          <div className="grid grid-cols-7 gap-1 mb-2">
                            {['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'].map((day) => (
                              <div key={day} className="text-center text-[10px] font-semibold text-slate-500 py-1">{day}</div>
                            ))}
                            {(() => {
                              const { daysInMonth, firstDayOfMonth } = getDaysInMonth(calendarMonth);
                              const days = [];
                              for (let i = 0; i < firstDayOfMonth; i++) {
                                days.push(<div key={`empty-${i}`} className="aspect-square" />);
                              }
                              for (let day = 1; day <= daysInMonth; day++) {
                                const date = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), day);
                                const isStart = isSameDay(date, dateRange.start);
                                const isEnd = isSameDay(date, dateRange.end);
                                const inRange = dateRange.start && dateRange.end && isInRange(date, dateRange.start, dateRange.end);
                                days.push(
                                  <button
                                    key={day}
                                    onClick={() => {
                                      if (!dateRange.start || (dateRange.start && dateRange.end)) {
                                        setDateRange({ start: date, end: null });
                                      } else if (date >= dateRange.start) {
                                        setDateRange({ ...dateRange, end: date });
                                      } else {
                                        setDateRange({ start: date, end: dateRange.start });
                                      }
                                    }}
                                    className={`aspect-square flex items-center justify-center text-[11px] rounded-lg transition-all ${
                                      isStart || isEnd ? 'bg-blue-500 text-white font-bold' :
                                      inRange ? 'bg-blue-500/20 text-blue-300' :
                                      'text-slate-300 hover:bg-white/5'
                                    }`}
                                  >{day}</button>
                                );
                              }
                              return days;
                            })()}
                          </div>

                          <div className="flex items-center justify-between text-[10px] text-slate-400 bg-slate-800/50 rounded-lg px-2 py-1.5 mb-3">
                            <span>{dateRange.start ? dateRange.start.toLocaleDateString('ru-RU') : 'Начало'}</span>
                            <span className="text-slate-600">→</span>
                            <span>{dateRange.end ? dateRange.end.toLocaleDateString('ru-RU') : 'Конец'}</span>
                          </div>

                          <div className="flex gap-2">
                            <button
                              onClick={() => { setActiveDateFilter(dateRange); setIsFilterOpen(false); }}
                              disabled={!dateRange.start || !dateRange.end}
                              className="flex-1 bg-blue-500 hover:bg-blue-600 disabled:bg-slate-700 disabled:text-slate-500 text-white text-xs font-semibold py-2 rounded-lg transition-colors"
                            >Применить</button>
                            <button
                              onClick={() => { setDateRange({ start: null, end: null }); setActiveDateFilter({ start: null, end: null }); }}
                              className="px-4 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold py-2 rounded-lg transition-colors"
                            >Сбросить</button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="w-full overflow-y-auto max-h-[600px] scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">
                <table className="w-full text-left border-collapse">
                  <thead className="sticky top-0 z-10">
                    <tr className="text-slate-400 text-[10px] uppercase tracking-widest bg-slate-800/90 backdrop-blur-sm">
                      <th className="px-5 py-3 font-semibold">Сотрудник</th>
                      <th className="px-5 py-3 font-semibold">Время & Дата</th>
                      <th className="px-5 py-3 font-semibold text-center">Длительность</th>
                      <th className="px-5 py-3 font-semibold text-center">Транскрибация</th>
                      {activeTab === "real_calls" && (
                        <th className="px-5 py-3 font-semibold text-center">CRM</th>
                      )}
                      <th className="px-5 py-3 font-semibold text-center">AI Оценка</th>
                      {activeTab === "real_calls" && (
                        <th className="px-5 py-3 font-semibold text-center">Скоринг клиента</th>
                      )}
                      <th className="px-5 py-3 font-semibold text-center">Аудио</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5 text-xs">
                    {isLoadingCalls ? (
                      <tr><td colSpan={6} className="text-center py-8 text-slate-400">Загрузка данных...</td></tr>
                    ) : filteredCalls.map((call) => (
                      <tr key={call.id} className="hover:bg-white/[0.02] transition-colors group">
                        <td className="px-5 py-3 whitespace-nowrap">
                          <span className="font-medium text-slate-200">{call.name}</span>
                        </td>
                        <td className="px-5 py-3 text-slate-400 whitespace-nowrap">{call.date}</td>
                        <td className="px-5 py-3 text-slate-300 font-mono text-center">{call.callDuration}</td>
                        <td className="px-5 py-3 text-center">
                          <button
                            onClick={() => handleSelectCall(call, "transcript")}
                            className="p-1.5 rounded-lg bg-slate-800 text-slate-400 hover:bg-blue-500 hover:text-white transition-all shadow-inner border border-white/5"
                          >
                            <FileText className="w-3.5 h-3.5" />
                          </button>
                        </td>
                        {activeTab === "real_calls" && (
                          <td className="px-5 py-3 text-center">
                            {call.kommoUrl ? (
                              <a href={call.kommoUrl} target="_blank" rel="noreferrer" className="inline-block p-1.5 rounded-lg bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20 transition-all shadow-inner border border-cyan-500/20">
                                <Activity className="w-3.5 h-3.5" />
                              </a>
                            ) : (
                              <span className="text-slate-600">—</span>
                            )}
                          </td>
                        )}
                        <td className="px-5 py-3">
                          <div className="flex justify-center items-center">
                            <button onClick={() => handleSelectCall(call, "scoring")} className={`relative flex items-center justify-center w-9 h-9 rounded-full border-[2px] cursor-pointer hover:scale-110 transition-transform ${call.score >= 66 ? "border-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.3)] text-emerald-400" :
                              call.score >= 41 ? "border-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.3)] text-amber-400" :
                                "border-rose-400 shadow-[0_0_10px_rgba(251,113,133,0.3)] text-rose-400"
                              }`}>
                              <span className="text-[10px] font-bold">{call.score}%</span>
                            </button>
                          </div>
                        </td>
                        {activeTab === "real_calls" && (
                          <td className="px-5 py-3 text-center">
                            {call.clientScoring ? (() => {
                              const cs = call.clientScoring;
                              const maxScore = cs.solvency !== undefined ? 30 : 20;
                              const pct = maxScore > 0 ? (cs.total / maxScore) * 100 : 0;
                              const colorClass = pct >= 70
                                ? "text-emerald-400 border-emerald-500/40 bg-emerald-500/10"
                                : pct >= 40
                                ? "text-amber-400 border-amber-500/40 bg-amber-500/10"
                                : "text-rose-400 border-rose-500/40 bg-rose-500/10";
                              return (
                                <span className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[11px] font-bold ${colorClass}`}>
                                  {cs.total}/{maxScore}
                                </span>
                              );
                            })() : (
                              <span className="text-slate-600 text-sm">—</span>
                            )}
                          </td>
                        )}
                        <td className="px-3 py-3">
                          {playingCallId === call.id ? (
                            /* ── Active mini-player ── */
                            <div className="flex items-center gap-2 bg-slate-900/70 px-2 py-1.5 rounded-xl border border-blue-500/20 min-w-[180px]">
                              <button
                                onClick={() => toggleAudio(call)}
                                className="w-6 h-6 rounded-full flex items-center justify-center bg-blue-500 text-white hover:scale-105 transition-all shrink-0"
                              >
                                {audioPaused ? <Play className="w-3 h-3 ml-0.5" /> : <Pause className="w-3 h-3" />}
                              </button>
                              {/* Seek bar */}
                              <div
                                className="flex-1 h-1.5 bg-slate-700 rounded-full cursor-pointer relative group"
                                onClick={(e) => {
                                  const rect = e.currentTarget.getBoundingClientRect();
                                  seekAudio((e.clientX - rect.left) / rect.width);
                                }}
                              >
                                <div
                                  className="h-full bg-blue-500 rounded-full relative transition-all"
                                  style={{ width: `${audioDuration > 0 ? (audioCurrentTime / audioDuration) * 100 : 0}%` }}
                                >
                                  <div className="absolute right-0 top-1/2 -translate-y-1/2 w-2.5 h-2.5 bg-white rounded-full shadow-md opacity-0 group-hover:opacity-100 transition-opacity" />
                                </div>
                              </div>
                              {/* Time */}
                              <span className="text-[9px] text-slate-400 font-mono whitespace-nowrap shrink-0">
                                {fmtTime(audioCurrentTime)}
                              </span>
                              {/* Speed */}
                              <button
                                onClick={cyclePlaybackRate}
                                className="text-[9px] font-bold text-blue-400 bg-blue-500/10 px-1.5 py-0.5 rounded-md hover:bg-blue-500/20 transition-colors shrink-0"
                              >
                                {audioPlaybackRate}x
                              </button>
                            </div>
                          ) : (
                            /* ── Idle play button ── */
                            <div className="flex items-center justify-center">
                              <button
                                onClick={() => toggleAudio(call)}
                                disabled={!call.hasRecording}
                                title={call.hasRecording ? "Воспроизвести" : "Запись недоступна"}
                                className={`w-7 h-7 rounded-full flex items-center justify-center transition-all ${
                                  !call.hasRecording
                                    ? "bg-slate-700 text-slate-500 cursor-not-allowed"
                                    : "bg-blue-500 text-white hover:scale-110 hover:shadow-[0_0_12px_rgba(59,130,246,0.4)]"
                                }`}
                              >
                                {audioLoading === call.id ? (
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                ) : (
                                  <Play className="w-3 h-3 ml-0.5" />
                                )}
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* =========================================================
          MODALS & SIDE SHEETS
      ========================================================= */}

      {/* POPUP: Информация о звонке (Транскрипт + Скоринг) */}
      {selectedCall && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-950/60 backdrop-blur-sm" onClick={closeModal} />
          <div className="bg-slate-900 z-10 w-full max-w-5xl rounded-3xl border border-white/10 shadow-2xl p-6 flex flex-col gap-6 max-h-[95vh] overflow-hidden animate-in zoom-in-95 duration-200">
            {/* HEADER */}
            <div className="flex justify-between items-start shrink-0">
              <div className="flex items-center gap-4">
                <div>
                  <h3 className="font-bold text-lg text-white">{selectedCall.name}</h3>
                  <p className="text-xs text-slate-400">{selectedCall.date} • Длительность: {selectedCall.callDuration}</p>
                </div>
              </div>
              <button onClick={closeModal} className="p-2 text-slate-400 hover:text-white bg-white/5 rounded-full hover:bg-white/10 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* TABS HEADER FOR MODAL */}
            <div className="flex gap-4 border-b border-white/5 pb-4 shrink-0">
              <button
                onClick={() => setCallModalType("transcript")}
                className={`text-sm font-bold uppercase tracking-wider px-4 py-2 rounded-lg transition-colors ${callModalType === "transcript" ? "bg-blue-500/20 text-blue-400" : "text-slate-500 hover:text-slate-300"}`}
              >
                Транскрипция
              </button>
              <button
                onClick={() => setCallModalType("scoring")}
                className={`text-sm font-bold uppercase tracking-wider px-4 py-2 rounded-lg transition-colors ${callModalType === "scoring" ? "bg-purple-500/20 text-purple-400" : "text-slate-500 hover:text-slate-300"}`}
              >
                AI Анализ (Скоринг)
              </button>
            </div>

            {/* MODAL CONTENT */}
            {callDetailLoading ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="w-8 h-8 text-blue-400 animate-spin" />
                <span className="ml-3 text-slate-400 text-sm">Загрузка данных...</span>
              </div>
            ) : callModalType === "transcript" ? (
              <div className="flex flex-col gap-6 overflow-y-auto pr-2 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">
                {/* Transcript ONLY */}
                <div className="bg-slate-900/50 rounded-2xl p-5 border border-white/5 flex-1 shadow-inner flex flex-col gap-4">
                  <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2 shrink-0">
                    <FileText className="w-4 h-4 text-blue-400" /> Детальная Расшифровка
                  </h4>
                  <div className="text-sm leading-relaxed overflow-y-auto max-h-[500px] scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-slate-900/50 flex flex-col gap-3 pr-2">
                    {selectedCall.transcript.split('\n').filter(Boolean).map((line, idx) => {
                      // Парсинг для [Продавец]: и [Клиент]:
                      const isManager = line.includes('[Продавец]') || line.startsWith('Менеджер:');
                      const cleanLine = line.replace(/^\[Продавец\]:\s*/, '').replace(/^\[Клиент\]:\s*/, '').replace(/^(Менеджер:|Клиент:)\s*/, '');

                      if (!cleanLine.trim()) return null;

                      return (
                        <div key={idx} className={`flex ${isManager ? 'justify-end' : 'justify-start'} w-full`}>
                          <div className={`flex flex-col gap-1 ${isManager ? 'items-end' : 'items-start'} max-w-[75%]`}>
                            <span className={`text-[10px] uppercase tracking-wider font-bold px-2 ${isManager ? 'text-blue-400' : 'text-emerald-400'}`}>
                              {isManager ? 'Продавец' : 'Клиент'}
                            </span>
                            <div className={`p-3 rounded-2xl ${isManager
                              ? 'bg-blue-500/15 text-blue-50 rounded-tr-none border border-blue-500/30 shadow-sm'
                              : 'bg-emerald-500/10 text-slate-100 rounded-tl-none border border-emerald-500/20 shadow-sm'
                              }`}>
                              {cleanLine}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-4 overflow-y-auto pr-2 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">

                {/* ── Overall Score ── */}
                <div className="bg-slate-900/50 rounded-2xl p-5 border border-white/5 flex items-center gap-5 shadow-inner">
                  <div className={`relative flex items-center justify-center w-20 h-20 rounded-full border-[5px] shrink-0 ${
                    selectedCall.score >= 66
                      ? "border-emerald-400 text-emerald-400 shadow-[0_0_20px_rgba(52,211,153,0.2)]"
                      : selectedCall.score >= 41
                      ? "border-amber-400 text-amber-400 shadow-[0_0_20px_rgba(251,191,36,0.2)]"
                      : "border-rose-400 text-rose-400 shadow-[0_0_20px_rgba(251,113,133,0.2)]"
                  }`}>
                    <span className="text-xl font-black">{selectedCall.score}%</span>
                  </div>
                  <div className="flex-1">
                    <h4 className="text-sm font-black text-white uppercase tracking-wider">Итоговая Оценка</h4>
                    <p className="text-xs text-slate-400 mt-0.5">На базе критериев оценки звонка</p>
                  </div>
                  {/* Mini client scoring in the same row (only for real calls) */}
                  {activeTab === "real_calls" && selectedCall.clientScoring && (() => {
                    const cs = selectedCall.clientScoring;
                    const maxScore = cs.solvency !== undefined ? 30 : 20;
                    const pct = maxScore > 0 ? (cs.total / maxScore) * 100 : 0;
                    const totalColor = pct >= 70 ? "text-emerald-400" : pct >= 40 ? "text-amber-400" : "text-rose-400";
                    return (
                      <div className="flex flex-col items-center bg-slate-800/60 rounded-xl px-4 py-2 border border-purple-500/20 shrink-0">
                        <span className="text-[10px] text-purple-400 uppercase tracking-wider mb-1 font-bold">Клиент</span>
                        <span className={`text-lg font-black ${totalColor}`}>{cs.total}<span className="text-xs font-normal text-slate-500">/{maxScore}</span></span>
                      </div>
                    );
                  })()}
                </div>

                {/* ── Evaluation Blocks Accordion ── */}
                {selectedCall.blocks && selectedCall.blocks.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-wider px-1">Детальный разбор по блокам</h4>
                    {selectedCall.blocks.map((block) => {
                      const isOpen = openBlocks.has(block.id);
                      const isInfoBlock = block.maxScore === 0; // informational block (tags, recommendations, etc.)
                      const blockPct = block.maxScore > 0 ? (block.score / block.maxScore) * 100 : -1;
                      const blockColor = isInfoBlock
                        ? "text-blue-400"
                        : blockPct >= 70 ? "text-emerald-400"
                        : blockPct >= 40 ? "text-amber-400"
                        : "text-rose-400";
                      const blockBorder = isInfoBlock
                        ? "border-blue-500/20"
                        : blockPct >= 70 ? "border-emerald-500/20"
                        : blockPct >= 40 ? "border-amber-500/20"
                        : "border-rose-500/20";

                      return (
                        <div key={block.id} className={`rounded-xl border bg-slate-900/40 overflow-hidden transition-all duration-200 ${blockBorder}`}>
                          {/* Accordion Header */}
                          <button
                            onClick={() => toggleBlock(block.id)}
                            className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-white/[0.03] transition-colors"
                            aria-expanded={isOpen}
                          >
                            <div className="flex items-center gap-3 min-w-0">
                              <ChevronDown className={`w-4 h-4 text-slate-500 shrink-0 transition-transform duration-200 ${isOpen ? "" : "-rotate-90"}`} />
                              <span className="text-sm font-semibold text-slate-100 truncate">{block.name}</span>
                            </div>
                            <span className={`text-xs font-bold shrink-0 ml-3 ${blockColor}`}>
                              {isInfoBlock ? "Инфо" : `${block.score}/${block.maxScore}`}
                            </span>
                          </button>

                          {/* Accordion Content */}
                          {isOpen && (
                            <div className="px-4 pb-4 pt-1 flex flex-col gap-3 border-t border-white/5">
                              {block.criteria && block.criteria.length > 0 ? (
                                block.criteria.map((criterion) => {
                                  const isBinary = criterion.maxScore === 1;
                                  const isInfo = criterion.maxScore === 0;

                                  const badge = isBinary
                                    ? criterion.score === 1
                                      ? { label: "✅", color: "text-emerald-400 bg-emerald-500/10 border-emerald-500/30" }
                                      : { label: "❌", color: "text-rose-400 bg-rose-500/10 border-rose-500/30" }
                                    : { label: "ℹ️", color: "text-blue-400 bg-blue-500/10 border-blue-500/30" };

                                  const borderColor = isBinary
                                    ? criterion.score === 1 ? "border-emerald-500/30" : "border-rose-500/30"
                                    : "border-blue-500/30";

                                  return (
                                    <div key={criterion.id} className={`flex flex-col gap-1.5 pl-3 border-l-2 ${borderColor}`}>
                                      {/* Criterion name + badge */}
                                      <div className="flex items-start gap-2">
                                        <span className={`inline-flex items-center shrink-0 text-[11px] font-bold px-1.5 py-0.5 rounded border mt-0.5 ${badge.color}`}>
                                          {badge.label}
                                        </span>
                                        <span className="text-xs font-semibold text-slate-200 leading-relaxed">{criterion.name}</span>
                                      </div>

                                      {/* Feedback text */}
                                      {criterion.feedback && (
                                        <p className="text-xs text-slate-400 leading-relaxed pl-8">{cleanText(criterion.feedback)}</p>
                                      )}

                                      {/* Quote block */}
                                      {criterion.quote && criterion.quote !== "Не применимо" && (
                                        <blockquote className="ml-8 pl-3 border-l-2 border-blue-500/40 italic text-[11px] text-slate-400 leading-relaxed">
                                          &ldquo;{criterion.quote}&rdquo;
                                        </blockquote>
                                      )}
                                    </div>
                                  );
                                })
                              ) : block.feedback ? (
                                <p className="text-xs text-slate-400 leading-relaxed pl-7">{cleanText(block.feedback)}</p>
                              ) : null}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* ── Client Scoring Accordion (only for real calls) ── */}
                {activeTab === "real_calls" && selectedCall.clientScoring && (() => {
                  const cs = selectedCall.clientScoring;
                  const hasSolvency = cs.solvency !== undefined && cs.solvency > 0;
                  const maxScore = hasSolvency ? 30 : 20;
                  const pct = maxScore > 0 ? (cs.total / maxScore) * 100 : 0;
                  const totalColor = pct >= 70 ? "text-emerald-400" : pct >= 40 ? "text-amber-400" : "text-rose-400";
                  const borderColor = pct >= 70 ? "border-purple-500/20" : pct >= 40 ? "border-purple-500/20" : "border-purple-500/20";
                  const isOpen = openBlocks.has("client_scoring");

                  const items = [
                    { label: "Срочность", value: cs.urgency, max: 10 },
                    ...(hasSolvency ? [{ label: "Платежеспособность", value: cs.solvency, max: 10 }] : []),
                    { label: "Потребность", value: cs.need, max: 10 },
                  ];

                  return (
                    <div className="flex flex-col gap-2">
                      <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-wider px-1">Скоринг клиента</h4>
                      <div className={`rounded-xl border bg-slate-900/40 overflow-hidden transition-all duration-200 ${borderColor}`}>
                        <button
                          onClick={() => toggleBlock("client_scoring")}
                          className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-white/[0.03] transition-colors"
                          aria-expanded={isOpen}
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <ChevronDown className={`w-4 h-4 text-purple-400 shrink-0 transition-transform duration-200 ${isOpen ? "" : "-rotate-90"}`} />
                            <Users className="w-4 h-4 text-purple-400 shrink-0" />
                            <span className="text-sm font-semibold text-slate-100">Оценка клиента</span>
                          </div>
                          <span className={`text-xs font-bold shrink-0 ml-3 ${totalColor}`}>
                            {cs.total}/{maxScore}
                          </span>
                        </button>
                        {isOpen && (
                          <div className="px-4 pb-4 pt-1 flex flex-col gap-3 border-t border-white/5">
                            {items.map((item) => {
                              const itemPct = item.max > 0 ? (item.value / item.max) * 100 : 0;
                              const itemColor = itemPct >= 70 ? "text-emerald-400" : itemPct >= 40 ? "text-amber-400" : "text-rose-400";
                              const barColor = itemPct >= 70 ? "bg-emerald-500" : itemPct >= 40 ? "bg-amber-500" : "bg-rose-500";
                              return (
                                <div key={item.label} className="flex items-center gap-3">
                                  <span className="text-xs text-slate-400 w-36 shrink-0">{item.label}</span>
                                  <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
                                    <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${itemPct}%` }} />
                                  </div>
                                  <span className={`text-xs font-bold shrink-0 w-10 text-right ${itemColor}`}>{item.value}/{item.max}</span>
                                </div>
                              );
                            })}
                            <div className="flex items-center gap-3 pt-2 border-t border-white/5">
                              <span className="text-xs font-bold text-slate-300 w-36 shrink-0">Итого</span>
                              <div className="flex-1 h-2.5 bg-slate-800 rounded-full overflow-hidden">
                                <div className={`h-full rounded-full transition-all ${pct >= 70 ? "bg-emerald-500" : pct >= 40 ? "bg-amber-500" : "bg-rose-500"}`} style={{ width: `${pct}%` }} />
                              </div>
                              <span className={`text-xs font-black shrink-0 w-10 text-right ${totalColor}`}>{cs.total}/{maxScore}</span>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}

                {/* ── AI Summary - Mistakes ── */}
                {selectedCall.summary && (
                  <div className="bg-slate-900/50 rounded-2xl p-5 border border-white/5 flex flex-col gap-3 shadow-inner">
                    <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2 shrink-0">
                      <Bot className="w-4 h-4 text-rose-400" /> Ошибки и Недоработки
                    </h4>
                    <div className="text-sm text-slate-200 leading-relaxed overflow-y-auto max-h-[300px] scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-slate-900/50 pr-2">
                      {selectedCall.summary.split(/(?=\d+[\.\)]\s)/).filter(Boolean).map((point, idx) => {
                        const match = point.match(/^(\d+)[\.\)]\s+([\s\S]+)/);
                        if (match) {
                          return (
                            <div key={idx} className="mb-4 p-3 bg-rose-500/5 border border-rose-500/20 rounded-xl">
                              <div className="flex gap-3">
                                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-rose-500/20 text-rose-400 flex items-center justify-center text-xs font-bold">
                                  {match[1]}
                                </span>
                                <p className="flex-1 text-slate-200 whitespace-pre-wrap">{cleanText(match[2])}</p>
                              </div>
                            </div>
                          );
                        }
                        return <p key={idx} className="text-slate-200 mb-3 whitespace-pre-wrap">{cleanText(point)}</p>;
                      })}
                    </div>
                  </div>
                )}

                {/* ── AI Feedback - Recommendations ── */}
                {selectedCall.aiFeedback && (
                  <div className="bg-slate-900/50 rounded-2xl p-5 border border-white/5 flex flex-col gap-3 shadow-inner">
                    <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2 shrink-0">
                      <Bot className="w-4 h-4 text-emerald-400" /> Рекомендации и Сильные Стороны
                    </h4>
                    <div className="text-sm text-slate-200 leading-relaxed overflow-y-auto max-h-[300px] scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-slate-900/50 pr-2">
                      {selectedCall.aiFeedback.split(/(?=\d+[\.\)]\s)/).filter(Boolean).map((point, idx) => {
                        const match = point.match(/^(\d+)[\.\)]\s+([\s\S]+)/);
                        if (match) {
                          return (
                            <div key={idx} className="mb-4 p-3 bg-emerald-500/5 border border-emerald-500/20 rounded-xl">
                              <div className="flex gap-3">
                                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center text-xs font-bold">
                                  {match[1]}
                                </span>
                                <p className="flex-1 text-slate-200 whitespace-pre-wrap">{cleanText(match[2])}</p>
                              </div>
                            </div>
                          );
                        }
                        return <p key={idx} className="text-slate-200 mb-3 whitespace-pre-wrap">{cleanText(point)}</p>;
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

          </div>
        </div>
      )}

      {/* MODAL: Досье менеджера */}
      {selectedManager && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-950/60 backdrop-blur-sm" onClick={closeManagerSidebar} />
          <div className="bg-slate-900 z-10 w-full max-w-2xl rounded-3xl border border-white/10 shadow-2xl p-6 flex flex-col gap-6 max-h-[90vh] overflow-hidden animate-in zoom-in-95 duration-200">

            {/* HEADER */}
            <div className="flex justify-between items-center shrink-0">
              <div className="flex items-center gap-3">
                <h2 className="text-lg font-bold text-white tracking-tight">{selectedManager.name}</h2>
              </div>
              <button onClick={closeManagerSidebar} className="p-2 text-slate-400 hover:text-white bg-white/5 rounded-full hover:bg-white/10 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* FILTERS */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 shrink-0">
              {/* Period Filter */}
              <div>
                <h4 className="text-[10px] uppercase tracking-widest text-slate-500 font-bold mb-3">Период</h4>
                <div className="flex gap-2">
                  <button
                    onClick={() => setManagerPeriod("week")}
                    className={`flex-1 px-3 py-2 rounded-lg text-xs font-semibold transition-all ${
                      managerPeriod === "week"
                        ? "bg-blue-500/20 text-blue-400 border border-blue-500/30"
                        : "bg-slate-800/40 text-slate-400 border border-white/5 hover:bg-white/5"
                    }`}
                  >
                    Неделя
                  </button>
                  <button
                    onClick={() => setManagerPeriod("month")}
                    className={`flex-1 px-3 py-2 rounded-lg text-xs font-semibold transition-all ${
                      managerPeriod === "month"
                        ? "bg-blue-500/20 text-blue-400 border border-blue-500/30"
                        : "bg-slate-800/40 text-slate-400 border border-white/5 hover:bg-white/5"
                    }`}
                  >
                    Месяц
                  </button>
                  <button
                    onClick={() => setManagerPeriod("all")}
                    className={`flex-1 px-3 py-2 rounded-lg text-xs font-semibold transition-all ${
                      managerPeriod === "all"
                        ? "bg-blue-500/20 text-blue-400 border border-blue-500/30"
                        : "bg-slate-800/40 text-slate-400 border border-white/5 hover:bg-white/5"
                    }`}
                  >
                    Все
                  </button>
                </div>
              </div>

              {/* Min Score Filter */}
              <div>
                <div className="flex justify-between items-center mb-3">
                  <h4 className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">Мин. оценка</h4>
                  <span className="text-xs font-bold text-blue-400">{managerMinScore}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="10"
                  value={managerMinScore}
                  onChange={(e) => setManagerMinScore(parseInt(e.target.value))}
                  className="w-full accent-blue-500 cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-slate-500 font-medium mt-1">
                  <span>0%</span>
                  <span>50%</span>
                  <span>100%</span>
                </div>
              </div>
            </div>

            {/* STATISTICS */}
            <div className="bg-slate-900/40 rounded-2xl border border-white/5 p-4 shrink-0">
              <h4 className="text-[10px] uppercase tracking-widest text-slate-500 font-bold mb-4">
                Статистика {managerPeriod === "week" ? "за неделю" : managerPeriod === "month" ? "за месяц" : "за всё время"}
              </h4>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div>
                  <p className="text-xs text-slate-400 mb-1">Всего с оценкой</p>
                  <p className="text-lg font-bold text-white">{managerStats.totalCalls}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400 mb-1">Ср. Скоринг</p>
                  <p className={`text-lg font-bold ${managerStats.avgScore >= 66 ? "text-emerald-400" : managerStats.avgScore >= 41 ? "text-amber-400" : "text-rose-400"}`}>
                    {managerStats.avgScore}%
                  </p>
                </div>
                <div>
                  <p className="text-xs text-slate-400 mb-1">Общее время</p>
                  <p className="text-lg font-bold text-white">{managerStats.avgDuration}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400 mb-1">После фильтра</p>
                  <p className="text-lg font-bold text-blue-400">{managerStats.filteredCalls}</p>
                </div>
              </div>
            </div>

            {/* CALLS LIST */}
            <div className="flex-1 overflow-hidden flex flex-col min-h-0">
              <h4 className="text-[10px] uppercase tracking-widest text-slate-500 font-bold mb-3 shrink-0">
                Звонки ({managerCalls.length})
              </h4>
              <div className="overflow-y-auto scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent grid grid-cols-1 sm:grid-cols-2 gap-2 pr-2">
                {managerCalls.length === 0 ? (
                  <p className="text-slate-400 text-xs text-center py-8 col-span-2">Нет звонков по выбранным фильтрам</p>
                ) : (
                  managerCalls.map(call => (
                    <button
                      key={call.id}
                      onClick={() => handleSelectCall(call, "scoring")}
                      className="bg-slate-800/40 border border-white/5 rounded-xl px-3 py-3 text-left hover:bg-white/5 transition-all group"
                    >
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-[10px] text-slate-400">{call.date}</span>
                        <span className={`text-xs font-bold ${
                          call.score >= 66 ? "text-emerald-400" : call.score >= 41 ? "text-amber-400" : "text-rose-400"
                        }`}>
                          {call.score}%
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-slate-300">{call.callDuration}</span>
                        <ChevronRight className="w-3 h-3 text-slate-500 group-hover:text-blue-400 transition-colors" />
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Sub-Component for Dashboard KPI Card
function KpiCard({ title, value, subValue, dG, wG, icon: Icon }: any) {
  const isPos = (val: string) => val.includes("+");
  return (
    <div className="glass-panel rounded-2xl p-4 border border-white/5 flex flex-col justify-between group hover:border-blue-500/30 transition-all">
      <div className="flex items-center justify-between mb-3">
        <span className="text-slate-400 font-semibold tracking-wider text-[10px] uppercase">{title}</span>
        <div className="p-1.5 bg-blue-500/10 rounded-md text-blue-400">
          <Icon className="w-3.5 h-3.5" />
        </div>
      </div>
      <div>
        <div className="text-2xl font-bold text-white tracking-tight flex items-baseline gap-2">
          {value}
          {subValue && <span className="text-sm font-medium text-slate-400">{subValue}</span>}
        </div>
        <div className="flex gap-3 mt-2 text-[10px] font-semibold text-slate-500">
          <span className="flex items-center gap-1">Д: <span className={isPos(dG) ? "text-emerald-400" : "text-rose-400"}>{dG}</span></span>
          <span className="flex items-center gap-1">Н: <span className={isPos(wG) ? "text-emerald-400" : "text-rose-400"}>{wG}</span></span>
        </div>
      </div>
    </div>
  );
}
