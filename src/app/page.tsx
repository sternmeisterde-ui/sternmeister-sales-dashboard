"use client";

import { useState, useEffect } from "react";
import {
  LayoutDashboard, Phone, Bot, Play, FileText, Activity, Users, DollarSign,
  Clock, X, Menu, Search, Calendar, Filter, ChevronRight, BarChart3, TrendingUp, ClipboardList
} from "lucide-react";
import Image from "next/image";
import { AreaChart, Area, XAxis, Tooltip, ResponsiveContainer } from "recharts";
import { mockCalls, salesTrendData, businessMetrics, mockManagers, ManagerStat, ManagerCall, dailyMetrics } from "@/lib/mockData";

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
  const [dailyFilter, setDailyFilter] = useState<"day" | "week" | "month" | "3months" | "6months">("day");

  // API Data States
  const [aiCalls, setAiCalls] = useState<ManagerCall[]>([]);
  const [aiManagers, setAiManagers] = useState<ManagerStat[]>([]);
  const [isLoadingAI, setIsLoadingAI] = useState(false);

  // UI States
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  const [selectedCall, setSelectedCall] = useState<ManagerCall | null>(null);
  const [callModalType, setCallModalType] = useState<"transcript" | "scoring">("transcript");
  const [selectedManager, setSelectedManager] = useState<ManagerStat | null>(null);
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [scoreFilter, setScoreFilter] = useState(80);
  const [dateRange, setDateRange] = useState<{ start: Date | null; end: Date | null }>({ start: null, end: null });
  const [activeDateFilter, setActiveDateFilter] = useState<{ start: Date | null; end: Date | null }>({ start: null, end: null });
  const [calendarMonth, setCalendarMonth] = useState(new Date());
  const [searchQuery, setSearchQuery] = useState("");

  // AI Dashboard period filter
  const [aiDashPeriod, setAiDashPeriod] = useState<"day" | "week" | "month">("day");

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

  // Load calls data from API for both tabs
  useEffect(() => {
    if (activeTab === "ai_calls" || activeTab === "real_calls") {
      setIsLoadingAI(true);

      Promise.all([
        fetch(`/api/calls?department=${activeDepartment}&type=calls`).then(r => r.json()),
        fetch(`/api/calls?department=${activeDepartment}&type=managers`).then(r => r.json())
      ])
        .then(([callsRes, managersRes]) => {
          if (callsRes.success) setAiCalls(callsRes.data);
          if (managersRes.success) setAiManagers(managersRes.data);
        })
        .catch(error => {
          console.error("Error loading calls:", error);
          setAiCalls(mockCalls);
          setAiManagers(mockManagers);
        })
        .finally(() => setIsLoadingAI(false));
    }
  }, [activeDepartment, activeTab]);

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

    const allCalls = !isLoadingAI && aiCalls.length > 0 ? aiCalls : mockCalls;
    const calls = allCalls.filter(call => call.name === selectedManager.name);

    // Apply period filter
    const now = new Date();
    now.setHours(23, 59, 59, 999); // конец сегодняшнего дня

    const filteredByPeriod = calls.filter(call => {
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

    // Apply score filter
    const filteredCalls = filteredByPeriod.filter(call => call.score >= managerMinScore);

    setManagerCalls(filteredCalls);

    // Calculate stats
    const totalCalls = filteredCalls.length;
    const avgScore = totalCalls > 0
      ? Math.round(filteredCalls.reduce((sum, c) => sum + c.score, 0) / totalCalls)
      : 0;

    // Рассчитать ОБЩЕЕ время (сумму) вместо среднего
    const totalSeconds = filteredCalls.reduce((sum, c) => {
      const [min, sec] = c.callDuration.split(':').map(Number);
      return sum + (min * 60 + sec);
    }, 0);

    const totalMin = Math.floor(totalSeconds / 60);
    const totalSec = totalSeconds % 60;
    const totalDuration = `${totalMin} мин ${totalSec} сек`;

    setManagerStats({
      totalCalls,
      avgScore,
      avgDuration: totalDuration,
      filteredCalls: totalCalls,
    });
  }, [selectedManager, managerPeriod, managerMinScore, aiCalls, activeTab]);

  // Dashboard stats for calls tabs (managers only, no ROPs/admins)
  const callsDashStats = (() => {
    const allCalls = !isLoadingAI && aiCalls.length > 0 ? aiCalls : mockCalls;
    const managers = (!isLoadingAI && aiManagers.length > 0 ? aiManagers : mockManagers)
      .filter(m => !m.role || m.role === "manager");
    const managerNames = new Set(managers.map(m => m.name));

    const now = new Date();
    now.setHours(23, 59, 59, 999);

    let periodStart = new Date(now);
    if (aiDashPeriod === "day") {
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

    const periodCalls = allCalls.filter(call => {
      if (!managerNames.has(call.name)) return false;
      if (call.score <= 0) return false; // Исключаем звонки с нулевым скорингом
      const callDate = parseCallDate(call.date);
      return callDate >= periodStart && callDate <= now;
    });

    const totalRoleplays = periodCalls.length;
    const avgScore = totalRoleplays > 0
      ? Math.round(periodCalls.reduce((sum, c) => sum + c.score, 0) / totalRoleplays)
      : 0;

    // Per-manager breakdown
    const perManager = managers.map(m => {
      const mCalls = periodCalls.filter(c => c.name === m.name);
      const count = mCalls.length;
      const avg = count > 0
        ? Math.round(mCalls.reduce((sum, c) => sum + c.score, 0) / count)
        : 0;
      return { name: m.name, avgScore: avg, count };
    }).sort((a, b) => b.count - a.count);

    return { avgScore, totalCalls: totalRoleplays, perManager };
  })();

  // Filter calls by date range and search query
  const filteredCalls = (!isLoadingAI && aiCalls.length > 0 ? aiCalls : mockCalls).filter(call => {
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

  // Update manager stats based on filtered calls
  const filteredManagers = (!isLoadingAI && aiManagers.length > 0 ? aiManagers : mockManagers).map(manager => {
    const managerCalls = filteredCalls.filter(call => call.name === manager.name);
    return {
      ...manager,
      totalCalls: managerCalls.length
    };
  });

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
            { id: "real_calls", icon: Phone, label: "Звонки" },
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
              onClick={() => setActiveDepartment("b2g")}
              className={`flex-1 sm:flex-none px-6 py-2 rounded-lg text-xs font-semibold tracking-wide transition-all duration-300 ${activeDepartment === "b2g" ? "bg-gradient-to-r from-blue-500 to-cyan-500 text-white shadow-lg" : "text-slate-400 hover:text-white"
                }`}
            >
              Коммерсы (B2B)
            </button>
            <button
              onClick={() => setActiveDepartment("b2b")}
              className={`flex-1 sm:flex-none px-6 py-2 rounded-lg text-xs font-semibold tracking-wide transition-all duration-300 ${activeDepartment === "b2b" ? "bg-gradient-to-r from-blue-500 to-cyan-500 text-white shadow-lg" : "text-slate-400 hover:text-white"
                }`}
            >
              Госники (B2G)
            </button>
          </div>

          <div className="flex items-center gap-3 text-xs w-full sm:w-auto relative">
            <button
              onClick={() => setIsFilterOpen(!isFilterOpen)}
              className={`border hover:bg-white/10 rounded-xl px-4 py-2 text-slate-300 flex items-center gap-2 transition-colors relative ${isFilterOpen ? "bg-white/10 border-blue-500/50" : "bg-slate-800/40 border-white/5"
                }`}
            >
              <Filter className="w-3.5 h-3.5 text-blue-400" />
              <span>Фильтры и Дата</span>
              {activeDateFilter.start && activeDateFilter.end && (
                <span className="absolute -top-1 -right-1 w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
              )}
            </button>

            {/* FILTER DROPDOWN */}
            {isFilterOpen && (
              <div className="absolute top-12 right-0 bg-slate-900 border border-white/10 rounded-2xl p-4 shadow-2xl z-50 w-80 flex flex-col gap-4 animate-in fade-in slide-in-from-top-2">
                <div>
                  <label className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-3 flex items-center gap-2">
                    <Calendar className="w-3.5 h-3.5 text-blue-400" /> Выбрать период
                  </label>

                  {/* Calendar Header */}
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

                  {/* Calendar Grid */}
                  <div className="grid grid-cols-7 gap-1 mb-2">
                    {['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'].map((day) => (
                      <div key={day} className="text-center text-[10px] font-semibold text-slate-500 py-1">
                        {day}
                      </div>
                    ))}
                    {(() => {
                      const { daysInMonth, firstDayOfMonth } = getDaysInMonth(calendarMonth);
                      const days = [];

                      // Empty cells before first day
                      for (let i = 0; i < firstDayOfMonth; i++) {
                        days.push(<div key={`empty-${i}`} className="aspect-square" />);
                      }

                      // Days of month
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
                              isStart || isEnd
                                ? 'bg-blue-500 text-white font-bold'
                                : inRange
                                ? 'bg-blue-500/20 text-blue-300'
                                : 'text-slate-300 hover:bg-white/5'
                            }`}
                          >
                            {day}
                          </button>
                        );
                      }

                      return days;
                    })()}
                  </div>

                  {/* Selected Range Display */}
                  <div className="flex items-center justify-between text-[10px] text-slate-400 bg-slate-800/50 rounded-lg px-2 py-1.5 mb-3">
                    <span>
                      {dateRange.start ? dateRange.start.toLocaleDateString('ru-RU') : 'Начало'}
                    </span>
                    <span className="text-slate-600">→</span>
                    <span>
                      {dateRange.end ? dateRange.end.toLocaleDateString('ru-RU') : 'Конец'}
                    </span>
                  </div>

                  {/* Action Buttons */}
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        setActiveDateFilter(dateRange);
                        setIsFilterOpen(false);
                      }}
                      disabled={!dateRange.start || !dateRange.end}
                      className="flex-1 bg-blue-500 hover:bg-blue-600 disabled:bg-slate-700 disabled:text-slate-500 text-white text-xs font-semibold py-2 rounded-lg transition-colors"
                    >
                      Применить
                    </button>
                    <button
                      onClick={() => {
                        setDateRange({ start: null, end: null });
                        setActiveDateFilter({ start: null, end: null });
                      }}
                      className="px-4 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold py-2 rounded-lg transition-colors"
                    >
                      Сбросить
                    </button>
                  </div>
                </div>

                <div className="h-px w-full bg-white/5" />

                <div>
                  <div className="flex justify-between items-center mb-2">
                    <label className="text-xs font-semibold text-slate-400 uppercase tracking-widest flex items-center gap-2">
                      <BarChart3 className="w-3.5 h-3.5 text-blue-400" /> AI Скоринг от:
                    </label>
                    <span className="font-bold text-blue-400">{scoreFilter}%</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={scoreFilter}
                    onChange={(e) => setScoreFilter(parseInt(e.target.value))}
                    className="w-full accent-blue-500 cursor-pointer mb-1"
                  />
                  <div className="flex justify-between text-[10px] text-slate-500 font-medium">
                    <span>0%</span>
                    <span>50%</span>
                    <span>100%</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </header>

        {/* --------------------- DASHBOARD VIEW --------------------- */}
        {activeTab === "dashboard" && (
          <div className="flex flex-col gap-4 fade-in">
            {/* Business KPI Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
              <KpiCard title="Выручка" value={businessMetrics.revenue.value} dG={businessMetrics.revenue.dailyGrowth} wG={businessMetrics.revenue.weeklyGrowth} icon={DollarSign} />
              <KpiCard title="Лучший Менеджер" value={businessMetrics.bestManager.name} subValue={businessMetrics.bestManager.value} dG={businessMetrics.bestManager.dailyGrowth} wG={businessMetrics.bestManager.weeklyGrowth} icon={TrendingUp} />
              <KpiCard title="Звонки (B2G)" value={businessMetrics.callsB2G.value} dG={businessMetrics.callsB2G.dailyGrowth} wG={businessMetrics.callsB2G.weeklyGrowth} icon={Phone} />
              <KpiCard title="Звонки (B2B)" value={businessMetrics.callsB2B.value} dG={businessMetrics.callsB2B.dailyGrowth} wG={businessMetrics.callsB2B.weeklyGrowth} icon={Phone} />
              <KpiCard title="Ср. Время на Линии" value={businessMetrics.avgCallDuration.value} dG={businessMetrics.avgCallDuration.dailyGrowth} wG={businessMetrics.avgCallDuration.weeklyGrowth} icon={Clock} />
            </div>

            {/* General Graph */}
            <div className="glass-panel rounded-2xl p-5 border border-white/5 h-[300px]">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-slate-300 font-semibold tracking-wide text-xs uppercase">Общая динамика звонков по отделам</h3>
              </div>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={salesTrendData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorB2G" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="colorB2B" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#06b6d4" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="name" stroke="#475569" fontSize={11} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px', fontSize: '12px' }} />
                  <Area type="monotone" dataKey="b2gCalls" stroke="#3b82f6" fillOpacity={1} fill="url(#colorB2G)" strokeWidth={2} />
                  <Area type="monotone" dataKey="b2bCalls" stroke="#06b6d4" fillOpacity={1} fill="url(#colorB2B)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {/* --------------------- DAILY VIEW --------------------- */}
        {activeTab === "daily" && (
          <div className="flex flex-col gap-6 fade-in flex-1 overflow-y-auto pb-6 scrollbar-hide">

            {/* Вкладки Фильтров периодов */}
            <div className="flex bg-slate-800/50 p-1.5 rounded-xl border border-white/5 shadow-inner w-full sm:w-max self-start overflow-x-auto scrollbar-hide">
              {[
                { id: "day", label: "День" },
                { id: "week", label: "Неделя" },
                { id: "month", label: "Мес" },
                { id: "3months", label: "3 Мес" },
                { id: "6months", label: "6 Мес" },
              ].map((filter) => (
                <button
                  key={filter.id}
                  onClick={() => setDailyFilter(filter.id as any)}
                  className={`px-4 py-2 rounded-lg text-[11px] uppercase tracking-widest font-bold transition-all duration-300 flex-shrink-0 ${dailyFilter === filter.id
                    ? "bg-blue-500/20 text-blue-400 border border-blue-500/30 shadow-md"
                    : "text-slate-400 hover:text-white"
                    }`}
                >
                  {filter.label}
                </button>
              ))}
            </div>

            {/* Block 1: Воронка продаж */}
            <div className="glass-panel text-slate-200 rounded-3xl overflow-hidden border border-white/5 shadow-2xl flex flex-col">
              <div className="p-5 border-b border-white/5 bg-slate-900/20 flex items-center gap-3">
                <TrendingUp className="w-5 h-5 text-blue-400" />
                <h3 className="text-sm font-bold tracking-widest uppercase text-white">
                  Сделки на активных этапах и Воронка
                </h3>
              </div>
              <div className="w-full overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <tbody className="divide-y divide-white/5 text-sm">
                    {dailyMetrics.funnel.map((m, i) => (
                      <tr key={i} className="hover:bg-white/[0.02] transition-colors group">
                        <td className="px-5 py-3 font-medium text-slate-300 w-2/3 group-hover:text-blue-200 transition-colors">{m.label}</td>
                        <td className="px-5 py-3 font-bold text-white text-right font-mono">{m.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Block 2: Менеджер-квалификатор */}
              <div className="glass-panel text-slate-200 rounded-3xl overflow-hidden border border-white/5 shadow-2xl flex flex-col">
                <div className="p-5 border-b border-white/5 bg-slate-900/20 flex items-center gap-3">
                  <Users className="w-5 h-5 text-emerald-400" />
                  <h3 className="text-sm font-bold tracking-widest uppercase text-white">
                    Менеджер-квалификатор
                  </h3>
                </div>
                <div className="w-full overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <tbody className="divide-y divide-white/5 text-sm">
                      {dailyMetrics.qualifier.map((m, i) => (
                        <tr key={i} className="hover:bg-white/[0.02] transition-colors group">
                          <td className="px-5 py-3 font-medium text-slate-300 group-hover:text-emerald-200 transition-colors w-2/3">{m.label}</td>
                          <td className="px-5 py-3 font-bold text-white text-right font-mono">{m.value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Block 3: Менеджер второй линии */}
              <div className="glass-panel text-slate-200 rounded-3xl overflow-hidden border border-white/5 shadow-2xl flex flex-col">
                <div className="p-5 border-b border-white/5 bg-slate-900/20 flex items-center gap-3">
                  <Activity className="w-5 h-5 text-purple-400" />
                  <h3 className="text-sm font-bold tracking-widest uppercase text-white">
                    Менеджер второй линии
                  </h3>
                </div>
                <div className="w-full overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <tbody className="divide-y divide-white/5 text-sm">
                      {dailyMetrics.secondLine.map((m, i) => (
                        <tr key={i} className="hover:bg-white/[0.02] transition-colors group">
                          <td className="px-5 py-3 font-medium text-slate-300 group-hover:text-purple-200 transition-colors w-2/3">{m.label}</td>
                          <td className="px-5 py-3 font-bold text-white text-right font-mono">{m.value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

          </div>
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
                    </div>
                    <p className="text-[10px] text-slate-400 mt-0.5">Звонков: <span className="text-white font-medium">{manager.totalCalls}</span></p>
                  </div>
                </button>
              ))}
            </div>

            {/* CALLS DASHBOARD — stats for both real_calls and ai_calls */}
            <div className="flex flex-col gap-3">
              {/* Period Filter */}
              <div className="flex bg-slate-800/50 p-1 rounded-xl border border-white/5 shadow-inner w-max">
                {([
                  { id: "day", label: "День" },
                  { id: "week", label: "Неделя" },
                  { id: "month", label: "Месяц" },
                ] as const).map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setAiDashPeriod(p.id)}
                    className={`px-4 py-1.5 rounded-lg text-[11px] uppercase tracking-widest font-bold transition-all ${
                      aiDashPeriod === p.id
                        ? "bg-blue-500/20 text-blue-400 border border-blue-500/30"
                        : "text-slate-400 hover:text-white"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>

              {/* Stats Row: compact KPIs left + wide manager list right */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                {/* Left column: 2 compact KPI cards stacked */}
                <div className="flex flex-col gap-3">
                  {/* KPI: Average Score */}
                  <div className="glass-panel rounded-2xl px-4 py-3 border border-white/5 flex items-center justify-between">
                    <span className="text-[10px] text-slate-400 uppercase tracking-widest font-semibold">Ср. балл отдела</span>
                    <span className={`text-2xl font-black ${
                      callsDashStats.avgScore >= 66 ? "text-emerald-400" :
                      callsDashStats.avgScore >= 41 ? "text-amber-400" : "text-rose-400"
                    }`}>
                      {callsDashStats.avgScore}%
                    </span>
                  </div>

                  {/* KPI: Total Calls */}
                  <div className="glass-panel rounded-2xl px-4 py-3 border border-white/5 flex items-center justify-between">
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
                      <div className="glass-panel rounded-2xl px-4 py-3 border border-white/5 flex flex-col gap-1">
                        <span className="text-[10px] text-slate-400 uppercase tracking-widest font-semibold">
                          Лучший по качеству
                        </span>
                        {best ? (
                          <>
                            <span className="text-sm font-bold text-white truncate">{best.name}</span>
                            <div className="flex items-center gap-2">
                              <span className={`text-lg font-black ${
                                best.avgScore >= 66 ? "text-emerald-400" :
                                best.avgScore >= 41 ? "text-amber-400" : "text-rose-400"
                              }`}>{best.avgScore}%</span>
                              <span className="text-[10px] text-slate-500">{best.count} {activeTab === "ai_calls" ? "рол." : "зв."}</span>
                            </div>
                          </>
                        ) : (
                          <span className="text-xs text-slate-500">Нет данных</span>
                        )}
                      </div>
                    );
                  })()}

                  {/* KPI: Best by Count */}
                  {(() => {
                    const best = callsDashStats.perManager.filter(m => m.count > 0).sort((a, b) => b.count - a.count)[0];
                    return (
                      <div className="glass-panel rounded-2xl px-4 py-3 border border-white/5 flex flex-col gap-1">
                        <span className="text-[10px] text-slate-400 uppercase tracking-widest font-semibold">
                          Лучший по количеству
                        </span>
                        {best ? (
                          <>
                            <span className="text-sm font-bold text-white truncate">{best.name}</span>
                            <div className="flex items-center gap-2">
                              <span className="text-lg font-black text-white">{best.count} <span className="text-xs font-normal text-slate-500">{activeTab === "ai_calls" ? "рол." : "зв."}</span></span>
                              <span className={`text-sm font-bold ${
                                best.avgScore >= 66 ? "text-emerald-400" :
                                best.avgScore >= 41 ? "text-amber-400" : "text-rose-400"
                              }`}>{best.avgScore}%</span>
                            </div>
                          </>
                        ) : (
                          <span className="text-xs text-slate-500">Нет данных</span>
                        )}
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

            {/* DATA TABLE */}
            <div className="glass-panel rounded-2xl flex-1 border border-white/5 overflow-hidden flex flex-col shadow-2xl">
              <div className="p-4 border-b border-white/5 flex justify-between items-center bg-slate-900/20">
                <h2 className="text-sm font-bold tracking-wide uppercase text-slate-200">
                  {activeTab === "real_calls" ? "Таблица: Звонки" : "Таблица: Ролевые AI Звонки"}
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
                      <th className="px-5 py-3 font-semibold text-center">Аудио</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5 text-xs">
                    {isLoadingAI && activeTab === "ai_calls" ? (
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
                            onClick={() => { setSelectedCall(call); setCallModalType("transcript"); }}
                            className="p-1.5 rounded-lg bg-slate-800 text-slate-400 hover:bg-blue-500 hover:text-white transition-all shadow-inner border border-white/5"
                          >
                            <FileText className="w-3.5 h-3.5" />
                          </button>
                        </td>
                        {activeTab === "real_calls" && (
                          <td className="px-5 py-3 text-center">
                            <a href={call.kommoUrl} target="_blank" rel="noreferrer" className="inline-block p-1.5 rounded-lg bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20 transition-all shadow-inner border border-cyan-500/20">
                              <Activity className="w-3.5 h-3.5" />
                            </a>
                          </td>
                        )}
                        <td className="px-5 py-3">
                          <div className="flex justify-center items-center">
                            <button onClick={() => { setSelectedCall(call); setCallModalType("scoring"); }} className={`relative flex items-center justify-center w-9 h-9 rounded-full border-[2px] cursor-pointer hover:scale-110 transition-transform ${call.score >= 66 ? "border-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.3)] text-emerald-400" :
                              call.score >= 41 ? "border-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.3)] text-amber-400" :
                                "border-rose-400 shadow-[0_0_10px_rgba(251,113,133,0.3)] text-rose-400"
                              }`}>
                              <span className="text-[10px] font-bold">{call.score}%</span>
                            </button>
                          </div>
                        </td>
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2 bg-slate-900/50 p-1.5 rounded-full border border-white/5 w-max mx-auto">
                            <button className="w-6 h-6 rounded-full bg-blue-500 text-white flex items-center justify-center hover:scale-105 transition-transform">
                              <Play className="w-3 h-3 ml-0.5" />
                            </button>
                            <div className="flex gap-0.5 items-center mr-2">
                              {[3, 6, 4, 8, 5, 7, 3].map((h, i) => (
                                <div key={i} style={{ height: `${h}px` }} className="w-[2px] bg-blue-500/50 rounded-full" />
                              ))}
                            </div>
                          </div>
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
            {callModalType === "transcript" ? (
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
              <div className="flex flex-col gap-6 overflow-y-auto pr-2 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">
                {/* Overall Score */}
                <div className="bg-slate-900/50 rounded-2xl p-6 border border-white/5 flex items-center justify-between shadow-inner">
                  <div>
                    <h4 className="text-base font-black text-white mb-1 uppercase tracking-wider">Итоговая Оценка</h4>
                    <p className="text-xs text-slate-400">Рассчитана на базе критериев оценки звонка</p>
                  </div>
                  <div className={`relative flex items-center justify-center w-20 h-20 rounded-full border-[5px] shrink-0 ${selectedCall.score >= 66 ? "border-emerald-400 text-emerald-400 shadow-[0_0_20px_rgba(52,211,153,0.2)]" :
                    selectedCall.score >= 41 ? "border-amber-400 text-amber-400 shadow-[0_0_20px_rgba(251,191,36,0.2)]" :
                      "border-rose-400 text-rose-400 shadow-[0_0_20px_rgba(251,113,133,0.2)]"
                    }`}>
                    <span className="text-xl font-black">{selectedCall.score}%</span>
                  </div>
                </div>

                {/* AI Summary - Mistakes */}
                {selectedCall.summary && (
                  <div className="bg-slate-900/50 rounded-2xl p-5 border border-white/5 flex flex-col gap-3 shadow-inner">
                    <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2 shrink-0">
                      <Bot className="w-4 h-4 text-rose-400" /> Ошибки и Недоработки
                    </h4>
                    <div className="text-sm text-slate-200 leading-relaxed overflow-y-auto max-h-[300px] scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-slate-900/50 pr-2">
                      {selectedCall.summary.split(/(?=\d+[\.\)]\s)/).filter(Boolean).map((point, idx) => {
                        // Поддержка форматов: "1. текст" и "1) текст"
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

                {/* AI Feedback - Recommendations */}
                {selectedCall.aiFeedback && (
                  <div className="bg-slate-900/50 rounded-2xl p-5 border border-white/5 flex flex-col gap-3 shadow-inner">
                    <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2 shrink-0">
                      <Bot className="w-4 h-4 text-emerald-400" /> Рекомендации и Сильные Стороны
                    </h4>
                    <div className="text-sm text-slate-200 leading-relaxed overflow-y-auto max-h-[300px] scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-slate-900/50 pr-2">
                      {selectedCall.aiFeedback.split(/(?=\d+[\.\)]\s)/).filter(Boolean).map((point, idx) => {
                        // Поддержка форматов: "1. текст" и "1) текст"
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
                  <p className="text-xs text-slate-400 mb-1">Всего звонков</p>
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
                  <p className="text-xs text-slate-400 mb-1">Отфильтровано</p>
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
                      onClick={() => setSelectedCall(call)}
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
