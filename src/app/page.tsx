"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  LayoutDashboard, Phone, Bot, Play, Pause, FileText, Activity, Users,
  Clock, X, Menu, Search, Calendar, Filter, ChevronRight, ChevronDown, BarChart3, ClipboardList, Loader2, ListChecks, BookText, Database, Bug,
  CalendarClock, Workflow,
} from "lucide-react";
import Image from "next/image";
// recharts moved to DashboardTab component
import { ManagerStat, ManagerCall } from "@/lib/mockData";
import DailyTab from "@/components/DailyTab";
import AnalyticsTab from "@/components/AnalyticsTab";
import TrackingTab from "@/components/TrackingTab";
import DashboardTab from "@/components/DashboardTab";
import ManagersTab from "@/components/ManagersTab";
import AuditTab from "@/components/AuditTab";
import CriteriaTab from "@/components/CriteriaTab";
import ScriptsTab from "@/components/ScriptsTab";
import AnalysisTab from "@/components/AnalysisTab";
import LookerTab from "@/components/LookerTab";
import TerminTab from "@/components/TerminTab";
import FunnelTab from "@/components/FunnelTab";
import AnalyticsLookerSwitch from "@/components/AnalyticsLookerSwitch";
import { getLines, DEPARTMENTS, type DepartmentId } from "@/lib/config/tenant";
import {
  fmtLocalDate,
  parseDisplayDate,
  endOfBerlinDay,
  startOfBerlinDay,
  todayBerlinDate,
  todayCivil,
  addDaysCivil,
  berlinCivilDate,
  berlinCivilComponents,
} from "@/lib/utils/date";
import { useAudioPlayer } from "@/hooks/useAudioPlayer";
import { useTheme } from "@/hooks/useTheme";
import { Sun, Moon } from "lucide-react";
import CalendarPicker, { type DateRange } from "@/components/CalendarPicker";
import CallsChart from "@/components/CallsChart";
import WorstCallsPanel from "@/components/WorstCallsPanel";
import ReportBugPopup from "@/components/ReportBugPopup";

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

// Calendar helpers — Berlin-civil-day correct.
//
// Every Date that flows through the inline filter calendar is a UTC instant
// for 00:00 Berlin of some civil day. Constructing dates with `new Date(y,m,d)`
// uses BROWSER-LOCAL midnight, which silently shifts the civil-day by ±1 in
// non-Berlin browsers (Moscow users were filtering "yesterday" when clicking
// "today"). All math here mirrors CalendarPicker.tsx so both pickers agree.
const getDaysInMonth = (date: Date) => {
  const { y, m } = berlinCivilComponents(date);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const firstDayOfMonth = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); // 0 = Sun
  return { daysInMonth, firstDayOfMonth };
};

const isSameDay = (date1: Date | null, date2: Date | null) => {
  if (!date1 || !date2) return false;
  const a = berlinCivilComponents(date1);
  const b = berlinCivilComponents(date2);
  return a.y === b.y && a.m === b.m && a.d === b.d;
};

const isInRange = (date: Date, start: Date | null, end: Date | null) => {
  if (!start || !end) return false;
  return date.getTime() >= start.getTime() && date.getTime() <= end.getTime();
};

interface SessionUser {
  userId: string;
  name: string;
  role: "admin" | "manager";
  masterRole: "admin" | "rop" | "manager";
  department: "b2g" | "b2b";
  telegramUsername: string;
  line: string | null;
  kommoUserId: number | null;
}

type TabId = "dashboard" | "daily" | "analytics" | "tracking" | "real_calls" | "ai_calls" | "managers" | "criteria" | "scripts" | "call_analysis" | "looker" | "termins" | "audit" | "funnel";
// Единый источник правды по вкладкам сайдбара. Порядок = порядок пунктов меню.
// "audit" здесь НЕТ намеренно: вкладка убрана из навигации (не актуальна), но её
// компонент/render-блок/API сохранены для возможного переиспользования (§6.2).
// Термин/Воронка помечены departments:["b2g"] — это концепции только Бух Гос
// (термины ДЦ/АА, путь к Gutschein); у Коммерсов такого процесса нет (§6.1).
// Подробности: dev_docs/13-РАЗДЕЛЕНИЕ-B2G-B2B.md.
interface NavItem {
  id: TabId;
  icon: React.ElementType;
  label: string;
  /** true → пункт виден только админу (роль admin). */
  adminOnly: boolean;
  /** Если задано — вкладка доступна только этим отделам; не задано → всем. */
  departments?: DepartmentId[];
}

const NAV_ITEMS: NavItem[] = [
  { id: "dashboard", icon: LayoutDashboard, label: "Звонки", adminOnly: true },
  { id: "daily", icon: ClipboardList, label: "Дейли", adminOnly: true },
  { id: "analytics", icon: BarChart3, label: "Аналитика", adminOnly: true },
  { id: "tracking", icon: Activity, label: "Активность", adminOnly: true },
  { id: "termins", icon: CalendarClock, label: "Термин", adminOnly: true, departments: ["b2g"] },
  // Looker: у Госников — отдельная вкладка; у Коммерсов вынесен переключателем
  // внутрь «Аналитики» (departments:["b2g"] прячет пункт для B2B). См. §8.
  { id: "looker", icon: Database, label: "Looker", adminOnly: true, departments: ["b2g"] },
  { id: "funnel", icon: Workflow, label: "Воронка", adminOnly: true, departments: ["b2g"] },
  { id: "real_calls", icon: Phone, label: "ОКК", adminOnly: false },
  { id: "ai_calls", icon: Bot, label: "AI Ролевки", adminOnly: false },
  { id: "managers", icon: Users, label: "Менеджеры", adminOnly: true },
  { id: "call_analysis", icon: Search, label: "Анализ", adminOnly: true },
  { id: "criteria", icon: ListChecks, label: "Критерии", adminOnly: true },
  { id: "scripts", icon: BookText, label: "Скрипты", adminOnly: true },
];

// Деривативы от NAV_ITEMS — один источник правды, списки вручную не дублируем.
// "audit" нет в NAV_ITEMS → нет в VALID_TABS → deep-link #audit не открывается.
const VALID_TABS: ReadonlySet<TabId> = new Set(NAV_ITEMS.map((i) => i.id));
const ADMIN_ONLY_TABS: ReadonlySet<TabId> = new Set(
  NAV_ITEMS.filter((i) => i.adminOnly).map((i) => i.id),
);

/** Доступна ли вкладка в данном отделе (по NAV_ITEMS — единый источник правды).
 *  Вкладки без записи в NAV_ITEMS считаем доступными — их гейтит VALID_TABS. */
function tabAllowedInDept(tabId: TabId, dept: DepartmentId): boolean {
  const item = NAV_ITEMS.find((i) => i.id === tabId);
  return !item?.departments || item.departments.includes(dept);
}

function readTabFromHash(): TabId | null {
  if (typeof window === "undefined") return null;
  const raw = window.location.hash.replace(/^#/, "");
  return VALID_TABS.has(raw as TabId) ? (raw as TabId) : null;
}

// Выбранный админом отдел сохраняем в localStorage, чтобы он переживал F5 и не
// «слетал» обратно на домашний отдел из сессии. Менеджеры отдел не переключают
// (привязаны к session.department) — для них это не используется.
const DEPT_STORAGE_KEY = "sm_active_department";

function readStoredDepartment(): "b2g" | "b2b" | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(DEPT_STORAGE_KEY);
    return v === "b2g" || v === "b2b" ? v : null;
  } catch {
    return null; // localStorage может быть недоступен (приватный режим) — не критично
  }
}

function persistDepartment(dept: "b2g" | "b2b"): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DEPT_STORAGE_KEY, dept);
  } catch {
    /* недоступность localStorage не должна ломать переключение отдела */
  }
}

export default function Dashboard() {
  const [session, setSession] = useState<SessionUser | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [activeDepartment, setActiveDepartment] = useState<"b2g" | "b2b">("b2g");
  // Начальный таб — стабильный SSR-safe "dashboard". Реальный таб из URL hash
  // (#funnel и т.д.) применяется в useEffect ПОСЛЕ монтирования (см. ниже).
  // Читать hash прямо в инициализаторе нельзя: на сервере window нет → "dashboard",
  // на клиенте #funnel → "funnel", и деревья SSR/гидрации расходятся (hydration
  // error). После загрузки сессии таб может перебиться на "real_calls" для
  // manager-роли (manager не попадает в admin-таб даже по прямой ссылке).
  const [activeTab, setActiveTab] = useState<TabId>("dashboard");
  // True после того, как на клиенте прочитан URL hash и выбран реальный таб.
  // До этого контент дефолтного "dashboard"-таба НЕ рендерим (см. ниже и render):
  // иначе при deep-link на #funnel первый кадр успевает смонтировать DashboardTab
  // и дёрнуть его тяжёлый /api/dashboard впустую, замедляя загрузку нужной вкладки.
  const [navReady, setNavReady] = useState(false);
  // Global line filter: "all" OR any line group id from tenant config.
  // Stored as a plain string — tenant.ts is the source of truth for valid values.
  const [lineFilter, setLineFilter] = useState<string>("all");

  // Load session on mount
  useEffect(() => {
    fetch("/api/auth/me")
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data) {
          setSession(data);
          if (data.role === "manager") {
            // Менеджер привязан к своему отделу — выбор не восстанавливаем и не храним.
            setActiveDepartment(data.department);
            // Пробуем сохранить таб из URL hash. Если он admin-only или не задан —
            // fallback на "real_calls".
            const fromHash = readTabFromHash();
            if (!fromHash || ADMIN_ONLY_TABS.has(fromHash)) {
              setActiveTab("real_calls");
            }
          } else {
            // Админ: восстанавливаем ранее выбранный отдел (переживает F5),
            // иначе — домашний отдел из сессии.
            setActiveDepartment(readStoredDepartment() ?? data.department);
          }
        }
      })
      .finally(() => setSessionLoading(false));
  }, []);

  // Применяем URL hash → activeTab ПОСЛЕ монтирования (только клиент). Именно
  // поэтому начальный стейт выше — стабильный "dashboard": первый клиентский
  // рендер обязан совпасть с SSR (где window нет), иначе hydration mismatch.
  // hash доступен лишь в браузере — читаем его здесь, а не в useState-инициализаторе.
  // setActiveTab + setNavReady в одном эффекте → один батч-ререндер: к моменту
  // navReady=true таб уже правильный, поэтому DashboardTab при #funnel НЕ монтируется.
  useEffect(() => {
    const fromHash = readTabFromHash();
    if (fromHash) setActiveTab(fromHash);
    setNavReady(true);
  }, []);

  // Sync activeTab → URL hash (для refresh и shareable links). Первый прогон
  // (на монтировании) пропускаем — иначе он перезапишет реальный #funnel
  // дефолтным #dashboard ещё до того, как эффект выше применит таб из hash.
  const skipFirstHashSync = useRef(true);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (skipFirstHashSync.current) {
      skipFirstHashSync.current = false;
      return;
    }
    const current = window.location.hash.replace(/^#/, "");
    if (current === activeTab) return;
    // history.replaceState — без записи в history (browser back button не ловит вкладки).
    window.history.replaceState(null, "", `#${activeTab}`);
  }, [activeTab]);

  const isAdmin = session?.role === "admin";
  const isManager = session?.role === "manager";

  // Browser navigation (back/forward, ручное редактирование hash) → синхронизируем state.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onHashChange = () => {
      const tab = readTabFromHash();
      if (tab && tab !== activeTab) {
        if (!isAdmin && ADMIN_ONLY_TABS.has(tab)) return; // запрещаем manager-у admin-таб
        setActiveTab(tab);
      }
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [activeTab, isAdmin]);

  // Safety net: если активная вкладка недоступна в текущем отделе (deep-link
  // #funnel при B2B-сессии, ручная правка hash, смена отдела) — сбрасываем на
  // безопасную вкладку, чтобы активная вкладка и URL-hash оставались согласованными.
  // Цель сброса role-aware: админ → dashboard, менеджер → real_calls (dashboard ему
  // недоступен). Сам render вкладок тоже гейтится по отделу (ниже), поэтому неверный
  // контент не покажется даже до срабатывания эффекта. См. dev_docs/13-РАЗДЕЛЕНИЕ-B2G-B2B.md §6.1.
  useEffect(() => {
    if (!tabAllowedInDept(activeTab, activeDepartment)) {
      setActiveTab(isAdmin ? "dashboard" : "real_calls");
    }
  }, [activeDepartment, activeTab, isAdmin]);
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
  const [callModalType, setCallModalType] = useState<"transcript" | "scoring" | "report">("transcript");
  const [reportMessage, setReportMessage] = useState("");
  const [reportSending, setReportSending] = useState(false);
  const [reportSent, setReportSent] = useState(false);
  const [selectedManager, setSelectedManager] = useState<ManagerStat | null>(null);
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [filterDropdownStyle, setFilterDropdownStyle] = useState<React.CSSProperties>({});
  const filterBtnRef = useRef<HTMLButtonElement>(null);
  const filterPopupRef = useRef<HTMLDivElement>(null);
  const [pageMounted, setPageMounted] = useState(false);
  useEffect(() => { setPageMounted(true); }, []);
  const [scoreFilter, setScoreFilter] = useState(0);
  // `dateRange` is the user's in-progress selection inside the inline filter
  // calendar (before they hit "Применить"). The single source of truth for the
  // *applied* filter is `aiCustomRange` — driven by the period pills, the top
  // CalendarPicker, and the inline calendar all setting it. We used to also
  // keep a parallel `activeDateFilter` for the table filter, but the pills /
  // top picker never reset it, so a stale inline-picked range silently zeroed
  // out "День" on next click.
  const [dateRange, setDateRange] = useState<{ start: Date | null; end: Date | null }>({ start: null, end: null });
  // Berlin-civil 1st-of-month for the rendered calendar grid. Using
  // `new Date()` here gave browser-local "today", which then read as the wrong
  // civil month for Moscow users in the first ~2 h of a Berlin civil day.
  const [calendarMonth, setCalendarMonth] = useState<Date>(() => {
    const today = todayBerlinDate();
    const { y, m } = berlinCivilComponents(today);
    return berlinCivilDate(`${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}-01`);
  });
  // "День" — one click applies a single-day filter immediately.
  // "Период" — two clicks pick a start/end range.
  const [dateFilterMode, setDateFilterMode] = useState<"single" | "range">("single");
  const [searchQuery, setSearchQuery] = useState("");
  const [crmSearchUrl, setCrmSearchUrl] = useState("");

  // AI Dashboard period filter. Default "month" so first-load mirrors the user's
  // mental model ("show me this month"). Switching to "Неделя" used to bury the
  // fact that the dashboard was already filtering to the last 7 days.
  const [aiDashPeriod, setAiDashPeriod] = useState<"day" | "week" | "month">("month");
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

  // Theme switcher (light / dark). Default dark. Persists to localStorage.
  const { theme, toggleTheme } = useTheme();

  // "Сообщить об ошибке" popup — opens via the bug icon next to the theme toggle.
  const [bugReportOpen, setBugReportOpen] = useState(false);

  // Audio player — extracted into a dedicated hook so this component doesn't
  // have to manage 7 useState + useRef + 3 useCallback for audio concerns.
  const {
    playingCallId,
    audioLoading,
    audioCurrentTime,
    audioDuration,
    audioPlaybackRate,
    audioPaused,
    toggleAudio,
    stopAudio,
    seekAudio,
    cyclePlaybackRate,
  } = useAudioPlayer();

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

  // Compute OKK date range from period/custom range — Berlin civil days.
  // `to` is one day past the upper bound so calls timestamped at 23:59 Berlin
  // still fall inside the range when `to` is parsed as start-of-day downstream
  // (legacy boundary parsing also accepts end-of-day, but tomorrow is safe in
  // both interpretations and avoids browser-local TZ drift).
  const getOkkDateRange = useCallback((): { from: string; to: string } => {
    if (aiCustomRange.start && aiCustomRange.end) {
      return {
        from: fmtLocalDate(aiCustomRange.start),
        to: fmtLocalDate(aiCustomRange.end),
      };
    }
    const today = todayCivil();
    let from: string;
    if (aiDashPeriod === "day") {
      from = today;
    } else if (aiDashPeriod === "week") {
      from = addDaysCivil(today, -6);
    } else {
      // "month" → 1st of current Berlin civil month, NOT browser-local.
      from = `${today.slice(0, 7)}-01`;
    }
    return { from, to: addDaysCivil(today, 1) };
  }, [aiDashPeriod, aiCustomRange]);

  // Load BOTH datasets in PARALLEL (single useEffect, Promise.all).
  //
  // AbortController alone isn't enough: once a fetch has resolved (response
  // headers received) and the body is being parsed, abort() can't stop the
  // downstream `.then(setState)`. So if a stale request resolves AFTER a fresh
  // one, the stale data clobbers the fresh data — the "I clicked Месяц but
  // numbers are still weekly" bug. The reqIdRef guard makes only the latest
  // request's setState win, regardless of resolution order.
  const okkReqIdRef = useRef(0);
  useEffect(() => {
    const ac = new AbortController();
    const myReqId = ++okkReqIdRef.current;
    const dept = activeDepartment;
    const { from: dateFrom, to: dateTo } = getOkkDateRange();

    // AI data — always reload with date filter
    setIsLoadingAI(true);
    setIsLoadingReal(true);

    const fetches: Promise<void>[] = [];

    fetches.push(
      fetch(`/api/calls?department=${dept}&type=all&from=${dateFrom}&to=${dateTo}`, { signal: ac.signal, cache: "no-store" })
        .then(r => r.json())
        .then(res => {
          if (okkReqIdRef.current !== myReqId) return;
          if (res.success) {
            setAiCalls(res.data.calls);
            setAiManagers(res.data.managers);
          }
        })
        .catch(e => { if (e instanceof DOMException && e.name === "AbortError") return; console.error("Error loading AI calls:", e); })
        .finally(() => { if (okkReqIdRef.current === myReqId) setIsLoadingAI(false); })
    );

    fetches.push(
      fetch(`/api/okk/calls?department=${dept}&from=${dateFrom}&to=${dateTo}${lineFilter !== "all" ? `&line=${lineFilter}` : ""}`, { signal: ac.signal, cache: "no-store" })
        .then(r => r.json())
        .then(res => {
          if (okkReqIdRef.current !== myReqId) return;
          if (res.success) {
            setRealCalls(res.data.calls);
            setRealManagers(res.data.managers);
          }
        })
        .catch(e => { if (e instanceof DOMException && e.name === "AbortError") return; console.error("Error loading OKK calls:", e); })
        .finally(() => { if (okkReqIdRef.current === myReqId) setIsLoadingReal(false); })
    );

    return () => ac.abort();
  }, [activeDepartment, aiDashPeriod, aiCustomRange, getOkkDateRange, lineFilter]);

  // Parse display dates (Сегодня/Вчера/DD.MM) — legacy shim, delegates to
  // the shared util so all consumers have one round-trip implementation.
  const parseCallDate = parseDisplayDate;

  // Calculate manager stats with filters
  useEffect(() => {
    if (!selectedManager) return;

    const currentCalls = activeTab === "real_calls" ? realCalls : aiCalls;

    // All calls for this manager (including unevaluated / score=0)
    const allManagerCalls = currentCalls.filter(
      call => call.name === selectedManager.name
    );

    // Apply period filter — Berlin business calendar. `now` here is just the
    // upper bound for the comparison; using endOfBerlinDay so the cut-off is
    // 23:59:59.999 Berlin of today, not browser-local end-of-day (which is
    // off by ±1–2 h for non-Berlin users).
    const todayStart = todayBerlinDate();
    const now = endOfBerlinDay(todayStart);

    const filteredByPeriod = allManagerCalls.filter(call => {
      const callDate = call.startedAtIso ? new Date(call.startedAtIso) : parseCallDate(call.date);

      if (managerPeriod === "week") {
        const weekAgo = new Date(todayStart.getTime() - 7 * 86_400_000);
        return callDate >= weekAgo && callDate <= now;
      } else if (managerPeriod === "month") {
        const monthAgo = new Date(todayStart.getTime() - 30 * 86_400_000);
        return callDate >= monthAgo && callDate <= now;
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

  // Dashboard stats for calls tabs (managers only, no ROPs/admins).
  // Mirrors `filteredManagers` line-filter logic: B2B uses prompt_type → server
  // already aggregated per-line, so a non-zero totalCalls is the proxy for
  // "this manager belongs to the selected line in this period".
  const callsDashStats = (() => {
    const allCalls = activeCalls;
    const managers = activeManagers
      .filter(m => !m.role || m.role === "manager")
      .filter(m => {
        if (lineFilter === "all") return true;
        if (activeDepartment === "b2b") return m.totalCalls > 0;
        return m.line === lineFilter;
      });
    const managerNames = new Set(managers.map(m => m.name));

    // All bounds are Berlin civil-day aligned: every "today / week / month"
    // button means "Berlin business calendar", not the user's browser locale.
    const todayStart = todayBerlinDate();
    const now = endOfBerlinDay(todayStart);

    let periodStart: Date;
    let periodEnd = now;

    // Custom date range overrides period buttons. The picker now hands us
    // Berlin-midnight Dates already, but normalise to start/end of Berlin
    // day defensively in case anything upstream still emits browser-local.
    if (aiCustomRange.start && aiCustomRange.end) {
      periodStart = startOfBerlinDay(aiCustomRange.start);
      periodEnd = endOfBerlinDay(aiCustomRange.end);
    } else if (aiDashPeriod === "day") {
      periodStart = todayStart;
    } else if (aiDashPeriod === "week") {
      // last 7 calendar days (today + 6 prior). Aligned with `getOkkDateRange`.
      periodStart = new Date(todayStart.getTime() - 6 * 86_400_000);
    } else {
      // "month" → 1st of current Berlin civil month, matching the server-side
      // window so the bento counts and the loaded calls cover the same days.
      const todayCivilStr = todayCivil();
      periodStart = berlinCivilDate(`${todayCivilStr.slice(0, 7)}-01`);
    }

    // ALL calls in period (including unevaluated / score=0)
    const periodCalls = allCalls.filter(call => {
      if (!managerNames.has(call.name)) return false;
      // Prefer raw ISO timestamp when the API provides it — otherwise fall
      // back to the fragile display-string parse for legacy paths/mocks.
      const callDate = call.startedAtIso ? new Date(call.startedAtIso) : parseCallDate(call.date);
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

    // Target: qualifying calls ≥10 min (reuse periodCalls — same filter)
    const perManagerTarget = managers.map(m => {
      const mCalls = periodCalls.filter(c => {
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

  // Filter managers by role + line — totalCalls & avgScore come directly from the API.
  // For B2B the line is bound via prompt_type at the SQL boundary (manager.line is
  // null on commerce side), so the API already aggregates per-line. The previous
  // implementation passed every B2B manager through regardless of line which left
  // off-line managers visible at "0 calls" — confusing in the bento. When a B2B
  // line is active, hide rows that the server returned with totalCalls === 0.
  const filteredManagers = activeManagers
    .filter(m => !m.role || m.role === "manager")
    .filter(m => {
      if (lineFilter === "all") return true;
      if (activeDepartment === "b2b") return m.totalCalls > 0;
      return m.line === lineFilter;
    });

  // Set of manager names matching current line filter (for call filtering)
  const filteredManagerNames = new Set(filteredManagers.map(m => m.name));

  // Filter calls by line, date range, score, and search query
  const filteredCalls = activeCalls.filter(call => {
    // Filter by line (via manager name) — applies to both B2G (manager.line)
    // and B2B (manager has totalCalls in the line-filtered period).
    if (lineFilter !== "all" && !filteredManagerNames.has(call.name)) {
      return false;
    }

    // Filter by date range — Berlin civil days. The API has already filtered
    // by `aiCustomRange` server-side; this client-side guard mainly handles
    // the case where API caching returns a slightly wider window, and keeps
    // the table aligned with whatever the bento is showing.
    if (aiCustomRange.start && aiCustomRange.end) {
      const callDate = call.startedAtIso ? new Date(call.startedAtIso) : parseCallDate(call.date);
      const startOfDay = startOfBerlinDay(aiCustomRange.start);
      const endOfDay = endOfBerlinDay(aiCustomRange.end);

      if (!(callDate >= startOfDay && callDate <= endOfDay)) {
        return false;
      }
    }

    // Filter by minimum score
    if (call.score < scoreFilter) {
      return false;
    }

    // Filter by selected manager
    if (searchQuery) {
      if (call.name !== searchQuery) return false;
    }

    // Filter by CRM link — match lead ID from pasted URL
    if (crmSearchUrl.trim()) {
      const leadIdMatch = crmSearchUrl.match(/leads\/detail\/(\d+)|leads\/(\d+)/);
      const searchId = leadIdMatch?.[1] || leadIdMatch?.[2] || crmSearchUrl.trim();
      const callUrl = call.kommoUrl || "";
      if (!callUrl.includes(searchId)) return false;
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

  // До готовности сессии и навигации показываем лоадер, а не «гостевой» каркас.
  // Иначе на F5 видна многоступенчатая перерисовка (гость → админ: появляются
  // вкладки и переключатель, восстанавливаются отдел и таб) — это и есть «дёрганье».
  // Так получается один плавный переход: лоадер → финальный UI. SSR тоже отдаёт
  // лоадер (sessionLoading=true изначально), поэтому гидрация совпадает.
  if (sessionLoading || !navReady) {
    return (
      <div className="flex items-center justify-center min-h-screen text-slate-100">
        <Loader2 className="w-8 h-8 text-blue-400 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex sm:flex-row flex-col min-h-screen text-slate-100 p-2 sm:p-4 gap-4 relative overflow-hidden text-sm">
      {/* BACKGROUND DECORATIONS (GLOWS) - Changed to Blue tones */}
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-blue-600/10 blur-[120px] rounded-full pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[30%] h-[50%] bg-cyan-500/10 blur-[150px] rounded-full pointer-events-none" />
      <div className="absolute top-[40%] left-[30%] w-[20%] h-[20%] bg-sky-400/5 blur-[100px] rounded-full pointer-events-none" />

      {/* COLLAPSIBLE SIDEBAR */}
      <aside className={`glass-panel rounded-3xl p-4 flex flex-col gap-5 shadow-2xl relative z-20 border border-white/5 transition-all duration-300 ${isSidebarOpen ? "w-full sm:w-48" : "w-full sm:w-16 items-center"
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
          {NAV_ITEMS
            .filter((item) => isAdmin || !item.adminOnly)
            .filter((item) => tabAllowedInDept(item.id, activeDepartment))
            .map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              className={`flex items-center gap-4 px-4 py-3 rounded-2xl transition-all duration-300 font-semibold text-[10px] uppercase tracking-widest whitespace-nowrap ${activeTab === item.id
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

        {/* User info + theme toggle + logout */}
        {session && (
          <div className="mt-auto pt-4 border-t border-white/5 w-full">
            {isSidebarOpen && (
              <div className="text-xs text-slate-400 mb-2 truncate px-2">
                <span className="text-white font-medium">{session.name}</span>
                <span
                  className={`ml-2 inline-block align-middle text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${
                    session.masterRole === "rop"
                      ? "bg-amber-500/20 text-amber-400"
                      : session.masterRole === "admin"
                        ? "bg-purple-500/20 text-purple-400"
                        : "bg-slate-500/20 text-slate-300"
                  }`}
                >
                  {session.masterRole === "rop" ? "РОП" : session.masterRole === "admin" ? "Админ" : "Менеджер"}
                </span>
                <br />
                <span className="text-[10px]">@{session.telegramUsername}</span>
              </div>
            )}
            <button
              onClick={async () => {
                await fetch("/api/auth/logout", { method: "POST" });
                window.location.href = "/login";
              }}
              className="flex items-center gap-3 px-4 py-2 rounded-xl text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition-all w-full text-sm"
              title="Выйти"
            >
              <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
              {isSidebarOpen && <span>Выйти</span>}
            </button>
          </div>
        )}
      </aside>

      {/* MAIN CONTENT AREA */}
      <main className="flex-1 flex flex-col gap-4 relative z-10 min-w-0">

        {/* TOP NAVIGATION / HEADER */}
        <header className="glass-panel rounded-2xl px-5 py-3 flex flex-col sm:flex-row justify-between items-center shadow-lg border border-white/5 gap-4">
          {isAdmin ? (
          <div className="flex bg-slate-800/50 p-1 rounded-xl border border-white/5 shadow-inner w-full sm:w-auto">
            <button
              onClick={() => { setActiveDepartment("b2g"); setLineFilter("all"); persistDepartment("b2g"); }}
              className={`flex-1 sm:flex-none px-6 py-2 rounded-lg text-xs font-semibold tracking-wide transition-all duration-300 ${activeDepartment === "b2g" ? "bg-gradient-to-r from-blue-500 to-cyan-500 text-white shadow-lg" : "text-slate-400 hover:text-white"
                }`}
            >
              Госники (B2G)
            </button>
            <button
              onClick={() => { setActiveDepartment("b2b"); setLineFilter("all"); persistDepartment("b2b"); }}
              className={`flex-1 sm:flex-none px-6 py-2 rounded-lg text-xs font-semibold tracking-wide transition-all duration-300 ${activeDepartment === "b2b" ? "bg-gradient-to-r from-blue-500 to-cyan-500 text-white shadow-lg" : "text-slate-400 hover:text-white"
                }`}
            >
              Коммерсы (B2C)
            </button>
          </div>
          ) : (
            <div className="text-sm text-slate-400 px-2">
              {session?.department === "b2g" ? "Госники (B2G)" : "Коммерсы (B2B)"}
            </div>
          )}

          {/* Right-side action cluster: report bug + theme toggle */}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => setBugReportOpen(true)}
              className="flex items-center justify-center w-9 h-9 rounded-lg border border-rose-400/30 bg-slate-800/40 text-rose-400 hover:bg-rose-500/10 transition-all"
              title="Сообщить об ошибке"
              aria-label="Сообщить об ошибке"
            >
              <Bug className="w-4 h-4" />
            </button>

            {/* Theme toggle — top-right, visible on every page. */}
            <button
              type="button"
              onClick={toggleTheme}
              className="flex items-center justify-center w-9 h-9 rounded-lg border border-amber-400/30 bg-slate-800/40 text-amber-400 hover:bg-amber-500/10 transition-all"
              title={theme === "dark" ? "Светлая тема" : "Тёмная тема"}
              aria-label={theme === "dark" ? "Переключить на светлую тему" : "Переключить на тёмную тему"}
            >
              {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>
        </header>

        {/* --------------------- DASHBOARD VIEW --------------------- */}
        {/* navReady-гейт: "dashboard" — дефолт ДО чтения hash, поэтому при
            deep-link на другой таб (#funnel) его контент рендерим только когда
            hash уже прочитан — иначе DashboardTab монтируется и грузит данные зря. */}
        {navReady && activeTab === "dashboard" && (
          <DashboardTab department={activeDepartment} />
        )}

        {/* --------------------- DAILY VIEW --------------------- */}
        {activeTab === "daily" && (
          <DailyTab department={activeDepartment} />
        )}

        {/* --------------------- ANALYTICS VIEW --------------------- */}
        {/* B2B (Рузанна): Looker встроен в Аналитику переключателем и убран из
            сайдбара. B2G — без изменений: Аналитика и Looker раздельно. См. §8. */}
        {activeTab === "analytics" && (
          activeDepartment === "b2b"
            ? <AnalyticsLookerSwitch department={activeDepartment} />
            : <AnalyticsTab department={activeDepartment} />
        )}

        {activeTab === "tracking" && (
          <TrackingTab department={activeDepartment} />
        )}

        {/* --------------------- MANAGERS VIEW --------------------- */}
        {activeTab === "managers" && (
          <ManagersTab department={activeDepartment} />
        )}

        {/* --------------------- CRITERIA VIEW --------------------- */}
        {activeTab === "call_analysis" && (
          <AnalysisTab department={activeDepartment} />
        )}
        {activeTab === "criteria" && (
          <CriteriaTab department={activeDepartment} lineFilter={lineFilter} />
        )}
        {activeTab === "scripts" && (
          <ScriptsTab department={activeDepartment} lineFilter={lineFilter} isAdmin={isAdmin} />
        )}

        {/* B2B: Looker доступен внутри Аналитики (см. выше), как отдельная вкладка
            не рендерится — гейт по отделу + safety-net сбрасывают #looker на дашборд. */}
        {activeTab === "looker" && tabAllowedInDept("looker", activeDepartment) && <LookerTab department={activeDepartment} />}

        {/* Render-гейт по отделу — детерминированно, не зависит от порядка эффектов:
            funnel/termins (только Бух Гос) никогда не рендерятся под Коммерсами,
            даже на кадр до сброса вкладки safety-net эффектом. См. §6.1. */}
        {activeTab === "funnel" && tabAllowedInDept("funnel", activeDepartment) && (
          <FunnelTab department={activeDepartment} />
        )}

        {activeTab === "termins" && tabAllowedInDept("termins", activeDepartment) && (
          <TerminTab />
        )}

        {/* "Аудит" скрыт из навигации (см. §6.2 dev_docs/13-РАЗДЕЛЕНИЕ-B2G-B2B.md),
            поэтому activeTab === "audit" недостижим. Блок и импорт AuditTab оставлены
            НАМЕРЕННО: чтобы вернуть вкладку, достаточно добавить запись в NAV_ITEMS —
            она сама попадёт в сайдбар и VALID_TABS. Не удалять как «мёртвый». */}
        {activeTab === "audit" && <AuditTab department={activeDepartment} />}

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
                      {activeDepartment === "b2g" && manager.line && (
                        <span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-slate-700 text-slate-400">
                          {manager.line === "1" ? "1я" : manager.line === "2" ? "2я" : "3я"}
                        </span>
                      )}
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
                      onClick={() => {
                        setAiDashPeriod(p.id);
                        setAiCustomRange({ start: null, end: null });
                        // Also drop the inline-picker draft so the dropdown
                        // reopens clean instead of showing a stale selection.
                        setDateRange({ start: null, end: null });
                      }}
                      className={`px-4 py-1.5 rounded-lg text-[11px] uppercase tracking-widest font-bold transition-all ${
                        aiDashPeriod === p.id && !aiCustomRange.start
                          ? "bg-blue-500 text-white shadow-lg shadow-blue-500/30"
                          : "text-slate-400 hover:text-white"
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                {/* Live label of the actually-applied range so the user never
                    has to guess which period is in effect — kills the entire
                    class of "is this week or month?" reports. */}
                {(() => {
                  const { from, to } = getOkkDateRange();
                  const fmt = (s: string) => {
                    const [, m, d] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) ?? [];
                    return d && m ? `${d}.${m}` : s;
                  };
                  // `to` is exclusive (today+1) — show the inclusive label instead.
                  const inclusiveTo = addDaysCivil(to, -1);
                  return (
                    <span className="text-[10px] text-slate-500 font-mono px-2">
                      {fmt(from)} — {fmt(inclusiveTo)}
                    </span>
                  );
                })()}
                <CalendarPicker
                  mode="range"
                  allowModeToggle
                  value={aiCustomRange}
                  onChange={(range) => {
                    setAiCustomRange(range);
                    // Mirror the applied range into the inline-picker draft so
                    // the two pickers don't disagree visually.
                    setDateRange(range);
                  }}
                  onClear={() => {
                    setAiCustomRange({ start: null, end: null });
                    setDateRange({ start: null, end: null });
                  }}
                />
                {/* Line filter pills — sourced from tenant config so adding a
                    line in src/lib/config/tenant.ts shows up here automatically. */}
                <div className="flex gap-1 ml-2">
                  {(() => {
                    // Deduplicate lines by group — the global filter operates
                    // on groups ("1"/"2"/"3") while Scripts has sub-ids like "2a"/"2b".
                    const seen = new Set<string>();
                    const groups = getLines(activeDepartment).filter((l) => {
                      if (seen.has(l.group)) return false;
                      seen.add(l.group);
                      return true;
                    });
                    const options = [{ id: "all", shortLabel: "Все" } as const, ...groups.map((l) => ({ id: l.group, shortLabel: l.shortLabel ?? l.label }))];
                    return options.map((opt) => (
                      <button
                        key={opt.id}
                        onClick={() => setLineFilter(opt.id)}
                        className={`px-2 py-1 text-[10px] rounded-lg transition-all ${lineFilter === opt.id ? "bg-blue-600 text-white" : "bg-slate-800 text-slate-400 hover:bg-slate-700"}`}
                      >
                        {opt.shortLabel}
                      </button>
                    ));
                  })()}
                </div>
              </div>

              {/* Stats Row: KPIs (narrow) + Manager Scores (column) + Chart */}
              <div className="grid grid-cols-2 lg:grid-cols-12 gap-3 items-stretch">
                {/* KPI cards: 2 columns on mobile, narrow strip on desktop */}
                <div className="col-span-2 lg:col-span-2 grid grid-cols-2 lg:grid-cols-1 gap-2">
                  {/* KPI: Average Score */}
                  <div className="glass-panel rounded-2xl px-3 py-2 border border-white/5 flex items-center justify-between">
                    <span className="text-[9px] text-slate-400 uppercase tracking-widest font-semibold">Ср. балл</span>
                    <span className={`text-xl font-black ${
                      callsDashStats.avgScore >= 66 ? "text-emerald-400" :
                      callsDashStats.avgScore >= 41 ? "text-amber-400" : "text-rose-400"
                    }`}>
                      {callsDashStats.avgScore}%
                    </span>
                  </div>

                  {/* KPI: Total Calls */}
                  <div className="glass-panel rounded-2xl px-3 py-2 border border-white/5 flex items-center justify-between">
                    <span className="text-[9px] text-slate-400 uppercase tracking-widest font-semibold">
                      {activeTab === "ai_calls" ? "Ролевок" : "Звонков"}
                    </span>
                    <span className="text-xl font-black text-white">{callsDashStats.totalCalls}</span>
                  </div>

                  {/* KPI: Best by Score */}
                  {(() => {
                    const best = callsDashStats.perManager.filter(m => m.count > 0).sort((a, b) => b.avgScore - a.avgScore)[0];
                    return (
                      <div className="glass-panel rounded-2xl px-3 py-2 border border-white/5 flex flex-col">
                        <span className="text-[9px] text-slate-400 uppercase tracking-widest font-semibold">Лучший балл</span>
                        <div className="flex items-center justify-between mt-0.5">
                          <span className="text-[11px] text-white font-medium truncate mr-1">{best?.name?.split(" ")[0] || "—"}</span>
                          <span className={`text-lg font-black shrink-0 ${
                            best && best.avgScore >= 66 ? "text-emerald-400" :
                            best && best.avgScore >= 41 ? "text-amber-400" : "text-rose-400"
                          }`}>
                            {best ? `${best.avgScore}%` : "—"}
                          </span>
                        </div>
                      </div>
                    );
                  })()}

                  {/* KPI: Best by Count */}
                  {(() => {
                    const best = callsDashStats.perManager.filter(m => m.count > 0).sort((a, b) => b.count - a.count)[0];
                    return (
                      <div className="glass-panel rounded-2xl px-3 py-2 border border-white/5 flex flex-col">
                        <span className="text-[9px] text-slate-400 uppercase tracking-widest font-semibold">Больше всех</span>
                        <div className="flex items-center justify-between mt-0.5">
                          <span className="text-[11px] text-white font-medium truncate mr-1">{best?.name?.split(" ")[0] || "—"}</span>
                          <span className="text-lg font-black text-white shrink-0">
                            {best ? best.count : "—"}
                          </span>
                        </div>
                      </div>
                    );
                  })()}
                </div>

                {/* Manager Scores: single column, fills height, scrolls if needed */}
                <div className="col-span-2 lg:col-span-4 glass-panel rounded-2xl p-3 border border-white/5 flex flex-col gap-2 min-h-0">
                  <span className="text-[10px] text-slate-400 uppercase tracking-widest font-semibold shrink-0">Оценки менеджеров</span>
                  {callsDashStats.perManager.length === 0 ? (
                    <span className="text-sm text-slate-500">Нет данных за период</span>
                  ) : (
                    <div className="flex flex-col gap-0 overflow-y-auto flex-1 min-h-0 pr-1 custom-scrollbar">
                      {callsDashStats.perManager.map((m) => (
                        <div key={m.name} className="flex items-center justify-between py-1.5 border-b border-white/5 last:border-0 shrink-0">
                          <span className="text-sm text-slate-200 truncate mr-3">{m.name}</span>
                          <div className="flex items-center gap-3 shrink-0">
                            <span className="text-sm font-bold text-white">{m.count} <span className="text-[10px] font-normal text-slate-500">{activeTab === "ai_calls" ? "рол." : "зв."}</span></span>
                            <span className={`text-sm font-bold min-w-[36px] text-right ${
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

                {/* Charts: Score trend + Call count trend */}
                <div className="col-span-2 lg:col-span-6 glass-panel rounded-2xl p-3 border border-white/5 flex flex-col gap-1">
                  <span className="text-[10px] text-slate-400 uppercase tracking-widest font-semibold">Динамика</span>
                  <CallsChart
                    calls={(() => {
                      const allCalls = activeTab === "real_calls" ? realCalls : aiCalls;
                      const managers = activeManagers
                        .filter(m => !m.role || m.role === "manager")
                        .filter(m => {
                          if (lineFilter === "all") return true;
                          if (activeDepartment === "b2b") return m.totalCalls > 0;
                          return m.line === lineFilter;
                        });
                      const managerNames = new Set(managers.map(m => m.name));
                      return allCalls.filter(c => managerNames.has(c.name));
                    })()}
                    parseCallDate={parseCallDate}
                    type={activeTab === "real_calls" ? "real_calls" : "ai_calls"}
                  />
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

            {/* WORST CALLS PANEL */}
            {activeTab === "real_calls" && (() => {
              const { from, to } = getOkkDateRange();
              return <WorstCallsPanel department={activeDepartment} from={from} to={to} lineFilter={lineFilter} />;
            })()}

            {/* DATA TABLE */}
            <div className="glass-panel rounded-2xl flex-1 border border-white/5 overflow-hidden flex flex-col shadow-2xl">
              {/* `light-panel-header` is a no-op in dark mode (the
                  dark-theme styles come from the Tailwind utilities
                  below); globals.css repaints it blue in light mode. */}
              <div className="light-panel-header p-4 border-b border-white/5 flex justify-between items-center bg-slate-900/20">
                <h2 className="text-sm font-bold tracking-wide uppercase text-slate-200">
                  {activeTab === "real_calls" ? "Таблица: ОКК" : "Таблица: AI Ролевки"}
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
                  {/* CRM link search — only for real calls */}
                  {activeTab === "real_calls" && (
                    <div className="hidden sm:flex items-center bg-slate-800/50 rounded-lg px-3 py-1.5 border border-white/5">
                      <Activity className="w-3.5 h-3.5 text-cyan-400 mr-2 shrink-0" />
                      <input
                        type="text"
                        placeholder="Вставьте ссылку CRM..."
                        value={crmSearchUrl}
                        onChange={(e) => setCrmSearchUrl(e.target.value)}
                        className="bg-transparent border-none outline-none text-xs text-slate-200 w-44 placeholder-slate-500"
                      />
                      {crmSearchUrl && (
                        <button onClick={() => setCrmSearchUrl("")} className="ml-1 text-slate-500 hover:text-slate-300 transition-colors">
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  )}

                  {/* Filter & Date button */}
                  <div className="relative">
                    <button
                      ref={filterBtnRef}
                      onClick={() => {
                        if (!isFilterOpen && filterBtnRef.current) {
                          const rect = filterBtnRef.current.getBoundingClientRect();
                          setFilterDropdownStyle({
                            position: "fixed",
                            bottom: window.innerHeight - rect.top + 8,
                            right: window.innerWidth - rect.right,
                            zIndex: 9999,
                          });
                        }
                        setIsFilterOpen(!isFilterOpen);
                      }}
                      className={`border hover:bg-white/10 rounded-lg px-3 py-1.5 text-slate-300 flex items-center gap-2 transition-colors relative ${isFilterOpen ? "bg-white/10 border-blue-500/50" : "bg-slate-800/40 border-white/5"}`}
                    >
                      <Filter className="w-3.5 h-3.5 text-blue-400" />
                      <span className="text-xs">Фильтры</span>
                      {aiCustomRange.start && aiCustomRange.end && (
                        <span className="absolute -top-1 -right-1 w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
                      )}
                    </button>

                    {isFilterOpen && pageMounted && createPortal(
                      <div ref={filterPopupRef} style={filterDropdownStyle} className="bg-slate-900 border border-white/10 rounded-2xl p-4 shadow-2xl w-80 flex flex-col gap-4 animate-in fade-in slide-in-from-bottom-2">
                        {/* Manager filter inside widget */}
                        <div>
                          <label className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-2 flex items-center gap-2">
                            <Search className="w-3.5 h-3.5 text-blue-400" /> Менеджер
                          </label>
                          <select
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-xs text-slate-200 outline-none focus:border-blue-500/50 cursor-pointer"
                          >
                            <option value="" className="bg-slate-900">Все менеджеры</option>
                            {(() => {
                              const names = [...new Set(activeCalls.map(c => c.name))].sort();
                              return names.map(n => (
                                <option key={n} value={n} className="bg-slate-900">{n}</option>
                              ));
                            })()}
                          </select>
                        </div>

                        <div>
                          <label className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-3 flex items-center gap-2">
                            <Calendar className="w-3.5 h-3.5 text-blue-400" /> Выбрать период
                          </label>

                          <div className="flex bg-slate-800/60 p-0.5 rounded-lg border border-white/5 mb-3 w-fit">
                            <button
                              type="button"
                              onClick={() => setDateFilterMode("single")}
                              className={`px-2.5 py-1 text-[11px] rounded-md transition-all ${
                                dateFilterMode === "single" ? "bg-blue-500 text-white" : "text-slate-400 hover:text-white"
                              }`}
                            >День</button>
                            <button
                              type="button"
                              onClick={() => setDateFilterMode("range")}
                              className={`px-2.5 py-1 text-[11px] rounded-md transition-all ${
                                dateFilterMode === "range" ? "bg-blue-500 text-white" : "text-slate-400 hover:text-white"
                              }`}
                            >Период</button>
                          </div>

                          <div className="flex items-center justify-between mb-3">
                            <button
                              onClick={() => {
                                const { y, m } = berlinCivilComponents(calendarMonth);
                                // Date.UTC handles Jan→Dec rollover automatically.
                                const ny = m === 1 ? y - 1 : y;
                                const nm = m === 1 ? 12 : m - 1;
                                setCalendarMonth(berlinCivilDate(`${ny}-${String(nm).padStart(2, "0")}-01`));
                              }}
                              className="p-1 hover:bg-white/5 rounded-lg transition-colors"
                            >
                              <ChevronRight className="w-4 h-4 rotate-180 text-slate-400" />
                            </button>
                            <span className="text-xs font-bold text-white">
                              {calendarMonth.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric', timeZone: 'Europe/Berlin' })}
                            </span>
                            <button
                              onClick={() => {
                                const { y, m } = berlinCivilComponents(calendarMonth);
                                const ny = m === 12 ? y + 1 : y;
                                const nm = m === 12 ? 1 : m + 1;
                                setCalendarMonth(berlinCivilDate(`${ny}-${String(nm).padStart(2, "0")}-01`));
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
                              const { y: monthY, m: monthM } = berlinCivilComponents(calendarMonth);
                              const days = [];
                              for (let i = 0; i < firstDayOfMonth; i++) {
                                days.push(<div key={`empty-${i}`} className="aspect-square" />);
                              }
                              for (let day = 1; day <= daysInMonth; day++) {
                                // Berlin-midnight UTC instant for this civil day.
                                // `new Date(y, m, day)` would build BROWSER-LOCAL midnight,
                                // which converts to the wrong civil day in non-Berlin TZs.
                                const date = berlinCivilDate(
                                  `${monthY}-${String(monthM).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
                                );
                                const isStart = isSameDay(date, dateRange.start);
                                const isEnd = isSameDay(date, dateRange.end);
                                const inRange = dateRange.start && dateRange.end && isInRange(date, dateRange.start, dateRange.end);
                                days.push(
                                  <button
                                    key={day}
                                    onClick={() => {
                                      // "День" — one click applies a single-day filter immediately.
                                      if (dateFilterMode === "single") {
                                        const next = { start: date, end: date };
                                        setDateRange(next);
                                        setAiCustomRange(next);
                                        setIsFilterOpen(false);
                                        return;
                                      }
                                      // "Период" — two-click range selection.
                                      if (!dateRange.start || (dateRange.start && dateRange.end)) {
                                        setDateRange({ start: date, end: null });
                                        return;
                                      }
                                      const next = date >= dateRange.start
                                        ? { start: dateRange.start, end: date }
                                        : { start: date, end: dateRange.start };
                                      setDateRange(next);
                                      setAiCustomRange(next);
                                      setIsFilterOpen(false);
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
                            <span>{dateRange.start ? dateRange.start.toLocaleDateString('ru-RU', { timeZone: 'Europe/Berlin' }) : 'Начало'}</span>
                            <span className="text-slate-600">→</span>
                            <span>{dateRange.end ? dateRange.end.toLocaleDateString('ru-RU', { timeZone: 'Europe/Berlin' }) : 'Конец'}</span>
                          </div>

                          <div className="flex gap-2">
                            <button
                              onClick={() => {
                                const range = { start: dateRange.start, end: dateRange.end || dateRange.start };
                                setAiCustomRange(range);
                                setIsFilterOpen(false);
                              }}
                              disabled={!dateRange.start}
                              className="flex-1 bg-blue-500 hover:bg-blue-600 disabled:bg-slate-700 disabled:text-slate-500 text-white text-xs font-semibold py-2 rounded-lg transition-colors"
                            >{dateRange.start && !dateRange.end ? "Выбрать день" : "Применить"}</button>
                            <button
                              onClick={() => { setDateRange({ start: null, end: null }); setAiCustomRange({ start: null, end: null }); }}
                              className="px-4 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold py-2 rounded-lg transition-colors"
                            >Сбросить</button>
                          </div>
                        </div>
                      </div>,
                      document.body,
                    )}
                  </div>
                </div>
              </div>

              <div className="w-full overflow-y-auto max-h-[600px] scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">
                <table className="w-full text-left border-collapse">
                  <thead className="sticky top-0 z-10">
                    <tr className="light-panel-header text-slate-400 text-[10px] uppercase tracking-widest bg-slate-800/90 backdrop-blur-sm">
                      <th className="px-5 py-3 font-semibold">Сотрудник</th>
                      <th className="px-5 py-3 font-semibold">Время & Дата</th>
                      <th className="px-5 py-3 font-semibold text-center">Длительность</th>
                      {activeTab === "real_calls" && (
                        <th className="px-5 py-3 font-semibold text-center">№</th>
                      )}
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
                      <tr><td colSpan={activeTab === "real_calls" ? 8 : 6} className="text-center py-8 text-slate-400">Загрузка данных...</td></tr>
                    ) : filteredCalls.map((call) => (
                      <tr key={call.id} className="hover:bg-white/[0.02] transition-colors group">
                        <td className="px-5 py-3 whitespace-nowrap">
                          <span className="font-medium text-slate-200">{call.name}</span>
                        </td>
                        <td className="px-5 py-3 text-slate-400 whitespace-nowrap">{call.date}</td>
                        <td className="px-5 py-3 text-slate-300 font-mono text-center">{call.callDuration}</td>
                        {activeTab === "real_calls" && (
                          <td className="px-5 py-3 text-center">
                            {call.callNumber ? (
                              <span className="px-2 py-0.5 rounded bg-slate-700/50 text-slate-300 text-xs font-mono">{call.callNumber}</span>
                            ) : (
                              <span className="text-slate-600">—</span>
                            )}
                          </td>
                        )}
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
                            {call.kommoUrl && call.kommoUrl !== "#" ? (
                              <a
                                href={call.kommoUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20 transition-all border border-cyan-500/20 text-[10px] font-medium max-w-[120px] truncate"
                                title={call.kommoUrl}
                              >
                                <Activity className="w-3 h-3 shrink-0" />
                                CRM
                              </a>
                            ) : (
                              <span className="text-slate-600 text-[10px]">—</span>
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
                              const maxScore = cs.solvency !== undefined && cs.solvency > 0 ? 30 : 20;
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
              <button
                onClick={() => { setCallModalType("report"); setReportSent(false); setReportMessage(""); }}
                className={`text-sm font-bold uppercase tracking-wider px-4 py-2 rounded-lg transition-colors ${callModalType === "report" ? "bg-red-500/20 text-red-400" : "text-slate-500 hover:text-slate-300"}`}
              >
                Сообщить об ошибке
              </button>
            </div>

            {/* MODAL CONTENT */}
            {callModalType === "report" ? (
              <div className="flex flex-col gap-4 py-6 px-2">
                <div className="glass-panel rounded-2xl p-5 border border-red-500/20 bg-red-500/5">
                  <h4 className="text-sm font-bold text-red-400 mb-1">Сообщить об ошибке в оценке</h4>
                  <p className="text-[11px] text-slate-400 mb-4">Опишите что именно оценено неправильно. Ваше сообщение будет отправлено руководству.</p>
                  {reportSent ? (
                    <div className="text-center py-8">
                      <span className="text-emerald-400 text-lg font-bold">✓ Отправлено!</span>
                      <p className="text-slate-400 text-xs mt-2">Спасибо за обратную связь. Мы рассмотрим вашу жалобу.</p>
                    </div>
                  ) : (
                    <>
                      <textarea
                        value={reportMessage}
                        onChange={(e) => setReportMessage(e.target.value)}
                        placeholder="Напишите что не так с оценкой этого звонка..."
                        rows={5}
                        className="w-full bg-slate-900/50 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder:text-slate-500 outline-none focus:border-red-500/50 resize-none"
                      />
                      <button
                        disabled={!reportMessage.trim() || reportSending}
                        onClick={async () => {
                          if (!selectedCall || !reportMessage.trim()) return;
                          setReportSending(true);
                          try {
                            await fetch("/api/error-report", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({
                                callId: selectedCall.id,
                                department: activeDepartment,
                                source: activeTab === "real_calls" ? "okk" : "ai",
                                managerName: selectedCall.name,
                                managerTelegram: session?.telegramUsername || null,
                                callDate: selectedCall.date,
                                callScore: selectedCall.score,
                                message: reportMessage.trim(),
                              }),
                            });
                            setReportSent(true);
                          } catch {
                            // silent
                          } finally {
                            setReportSending(false);
                          }
                        }}
                        className="mt-3 w-full py-3 rounded-xl text-sm font-bold uppercase tracking-wider transition-all bg-red-500 text-white hover:bg-red-400 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {reportSending ? "Отправка..." : "Отправить жалобу"}
                      </button>
                    </>
                  )}
                </div>
              </div>
            ) : callDetailLoading ? (
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
                    {selectedCall.totalMaxScore ? (
                      <p className="text-xs text-slate-400 mt-0.5">
                        {Math.round(selectedCall.score / 100 * selectedCall.totalMaxScore)}/{selectedCall.totalMaxScore} баллов
                      </p>
                    ) : (
                      <p className="text-xs text-slate-400 mt-0.5">На базе критериев оценки звонка</p>
                    )}
                  </div>
                  {/* Mini client scoring in the same row (only for real calls) */}
                  {activeTab === "real_calls" && selectedCall.clientScoring && (() => {
                    const cs = selectedCall.clientScoring;
                    const maxScore = cs.solvency !== undefined && cs.solvency > 0 ? 30 : 20;
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

                {/* ── AI Narrative Summary (evaluationJson.summary) ── */}
                {selectedCall.evalSummary && (
                  <div className="bg-slate-900/50 rounded-2xl p-5 border border-white/5 flex flex-col gap-3 shadow-inner">
                    <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2 shrink-0">
                      <Bot className="w-4 h-4 text-blue-400" /> Итоговый вывод
                    </h4>
                    <p className="text-sm text-slate-200 leading-relaxed whitespace-pre-wrap">{cleanText(selectedCall.evalSummary)}</p>
                  </div>
                )}

                {/* ── Evaluation Blocks ── */}
                {selectedCall.blocks && selectedCall.blocks.length > 0 && (
                  <div className="flex flex-col gap-3">
                    <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-wider px-1">Детальный разбор</h4>
                    {selectedCall.blocks.map((block) => {
                      const isOpen = openBlocks.has(block.id);
                      const isInfoBlock = block.maxScore === 0;
                      const blockPct = block.maxScore > 0 ? (block.score / block.maxScore) * 100 : -1;
                      const blockAccent = isInfoBlock
                        ? { text: "text-blue-400", bg: "bg-blue-500/10", border: "border-blue-500/20", bar: "bg-blue-500" }
                        : blockPct >= 70 ? { text: "text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500/20", bar: "bg-emerald-500" }
                        : blockPct >= 40 ? { text: "text-amber-400", bg: "bg-amber-500/10", border: "border-amber-500/20", bar: "bg-amber-500" }
                        : { text: "text-rose-400", bg: "bg-rose-500/10", border: "border-rose-500/20", bar: "bg-rose-500" };

                      return (
                        <div key={block.id} className={`rounded-xl border overflow-hidden ${blockAccent.border} bg-slate-900/30`}>
                          {/* Block header */}
                          <button
                            onClick={() => toggleBlock(block.id)}
                            className="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-white/[0.02] transition-colors"
                            aria-expanded={isOpen}
                          >
                            <div className="flex items-center gap-3 min-w-0">
                              <ChevronDown className={`w-4 h-4 shrink-0 transition-transform duration-200 ${isOpen ? blockAccent.text : "text-slate-500 -rotate-90"}`} />
                              <span className="text-sm font-bold text-white truncate">{block.name}</span>
                            </div>
                            {isInfoBlock ? (
                              <span className="text-[11px] text-blue-400 bg-blue-500/10 px-2.5 py-1 rounded-lg border border-blue-500/20 font-medium shrink-0 ml-3">Аналитика</span>
                            ) : (
                              <div className="flex items-center gap-2.5 shrink-0 ml-3">
                                <div className="w-20 h-1.5 rounded-full bg-slate-700/60 overflow-hidden">
                                  <div className={`h-full rounded-full ${blockAccent.bar}`} style={{ width: `${Math.min(blockPct, 100)}%` }} />
                                </div>
                                <span className={`text-sm font-bold tabular-nums ${blockAccent.text}`}>{Math.round(blockPct)}%</span>
                                <span className="text-[10px] text-slate-500">{block.score}/{block.maxScore}</span>
                              </div>
                            )}
                          </button>

                          {/* Criteria */}
                          {isOpen && (
                            <div className="border-t border-white/[0.04]">
                              {block.criteria && block.criteria.length > 0 ? (
                                block.criteria.map((criterion, cidx) => {
                                  const isBinary = criterion.maxScore === 1;
                                  const isInfo = criterion.maxScore === 0;
                                  const passed = isBinary && criterion.score === 1;
                                  const failed = isBinary && criterion.score === 0;

                                  const rowBg = failed ? "bg-rose-500/[0.04]" : isInfo ? "bg-slate-800/20" : "";
                                  const accentBar = failed ? "bg-rose-500" : passed ? "bg-emerald-500" : "bg-slate-600";

                                  return (
                                    <div key={criterion.id} className={`relative ${rowBg} ${cidx > 0 ? "border-t border-white/[0.03]" : ""}`}>
                                      {/* Left accent bar */}
                                      <div className={`absolute left-0 top-0 bottom-0 w-[3px] ${accentBar}`} />

                                      <div className="pl-6 pr-5 py-4">
                                        {/* Row 1: Status + Criterion name */}
                                        <div className="flex items-start gap-3">
                                          {/* Status badge */}
                                          <div className="shrink-0 mt-0.5">
                                            {passed ? (
                                              <span className="flex items-center justify-center w-6 h-6 rounded-lg bg-emerald-500/15 text-emerald-400 text-xs font-bold">✓</span>
                                            ) : failed ? (
                                              <span className="flex items-center justify-center w-6 h-6 rounded-lg bg-rose-500/15 text-rose-400 text-xs font-bold">✗</span>
                                            ) : (
                                              <span className="flex items-center justify-center w-6 h-6 rounded-lg bg-slate-700/40 text-slate-500 text-[10px] font-bold">—</span>
                                            )}
                                          </div>

                                          {/* Name + number */}
                                          <div className="flex-1 min-w-0">
                                            <div className="flex items-baseline gap-2">
                                              <span className="text-[10px] text-slate-500 font-mono shrink-0">#{criterion.id}</span>
                                              <span className={`text-sm font-semibold leading-snug ${failed ? "text-rose-200" : passed ? "text-white" : "text-slate-300"}`}>
                                                {criterion.name}
                                              </span>
                                            </div>

                                            {/* Feedback — always visible, distinct from name */}
                                            {criterion.feedback && (
                                              <p className={`mt-2 text-xs leading-relaxed ${failed ? "text-rose-300/70" : "text-slate-400"}`}>
                                                {cleanText(criterion.feedback)}
                                              </p>
                                            )}

                                            {/* Quote — visually separated */}
                                            {criterion.quote && criterion.quote !== "Не применимо" && criterion.quote.length > 2 && (
                                              <div className="mt-2.5 flex gap-2">
                                                <div className="w-[2px] rounded-full bg-cyan-500/30 shrink-0" />
                                                <p className="text-[11px] text-cyan-300/60 italic leading-relaxed">
                                                  {criterion.quote}
                                                </p>
                                              </div>
                                            )}
                                          </div>
                                        </div>
                                      </div>
                                    </div>
                                  );
                                })
                              ) : block.feedback ? (
                                <div className="px-6 py-4">
                                  <p className="text-xs text-slate-400 leading-relaxed">{cleanText(block.feedback)}</p>
                                </div>
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

                  const items: { label: string; value: number; max: number }[] = [
                    { label: "Срочность", value: cs.urgency, max: 10 },
                    ...(hasSolvency ? [{ label: "Платежеспособность", value: cs.solvency as number, max: 10 }] : []),
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

                {/* ── Quick Summary: Failures + Growth + Strengths ── */}
                {selectedCall.blocks && selectedCall.blocks.length > 0 && (() => {
                  const failures: Array<{name: string; feedback: string}> = [];
                  const growthAreas: Array<{name: string; feedback: string}> = [];
                  const bestPractices: Array<{name: string; feedback: string}> = [];

                  for (const block of selectedCall.blocks) {
                    if (!block.criteria) continue;
                    for (const c of block.criteria) {
                      if (c.maxScore === 1 && c.score === 0) {
                        failures.push({ name: c.name, feedback: c.feedback || "" });
                      }
                      if (c.maxScore === 0 && c.feedback) {
                        const nl = c.name.toLowerCase();
                        if (nl.includes("зоны роста") || nl.includes("рекомендации продавцу: зоны")) {
                          growthAreas.push({ name: c.name, feedback: c.feedback });
                        } else if (nl.includes("лучшие практики")) {
                          bestPractices.push({ name: c.name, feedback: c.feedback });
                        }
                      }
                    }
                  }

                  if (failures.length === 0 && growthAreas.length === 0 && bestPractices.length === 0) return null;

                  // Parse individual items from feedback — split by ❌/✅ or numbered 1)/2)/3)
                  const parseItems = (text: string): Array<{text: string; type: "pos" | "neg" | "neutral"}> => {
                    // First try ❌/✅ split
                    const emojiParts = text.split(/(?=❌|✅)/).filter(Boolean);
                    if (emojiParts.length > 1) {
                      return emojiParts.map(p => ({
                        text: p.replace(/^[❌✅]\s*/, "").trim(),
                        type: p.startsWith("✅") ? "pos" as const : p.startsWith("❌") ? "neg" as const : "neutral" as const,
                      }));
                    }
                    // Try numbered: "1) text; 2) text" or "1. text 2. text"
                    const numbered = text.split(/(?=\d+[\.\)]\s)/).filter(s => s.trim());
                    if (numbered.length > 1) {
                      return numbered.map(p => ({
                        text: p.replace(/^\d+[\.\)]\s*/, "").trim(),
                        type: "neutral" as const,
                      }));
                    }
                    // Try semicolons
                    const semicolons = text.split(/;\s*/).filter(s => s.trim().length > 10);
                    if (semicolons.length > 1) {
                      return semicolons.map(p => ({ text: p.trim(), type: "neutral" as const }));
                    }
                    return [{ text, type: "neutral" }];
                  };

                  return (
                    <div className="flex flex-col gap-3">
                      {/* Failures — red */}
                      {failures.length > 0 && (
                        <div className="rounded-xl border border-rose-500/15 bg-rose-500/[0.03] p-4">
                          <h4 className="text-[10px] font-bold text-rose-400 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                            Невыполненные критерии ({failures.length})
                          </h4>
                          <div className="flex flex-col gap-2.5">
                            {failures.slice(0, 8).map((f, i) => (
                              <div key={i} className="flex gap-2 items-start">
                                <span className="text-rose-400 text-xs mt-0.5 shrink-0">✗</span>
                                <div className="min-w-0">
                                  <span className="text-xs font-semibold text-rose-200">{f.name}</span>
                                  {f.feedback && (
                                    <p className="text-[11px] text-rose-300/50 leading-relaxed mt-0.5">{cleanText(f.feedback)}</p>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                        {/* Growth areas — amber */}
                        {growthAreas.length > 0 && (
                          <div className="rounded-xl border border-amber-500/15 bg-amber-500/[0.03] p-4">
                            <h4 className="text-[10px] font-bold text-amber-400 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                              <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                              Зоны роста
                            </h4>
                            <div className="flex flex-col gap-2">
                              {growthAreas.map((s, i) => {
                                const items = parseItems(s.feedback);
                                return items.map((item, j) => (
                                  <div key={`${i}-${j}`} className="p-2.5 rounded-lg bg-amber-500/[0.04] border border-amber-500/10">
                                    <div className="flex gap-2 items-start">
                                      <span className="text-amber-400 text-[11px] mt-0.5 shrink-0 font-bold">{j + 1}.</span>
                                      <p className="text-[11px] leading-relaxed text-amber-200/80">{cleanText(item.text)}</p>
                                    </div>
                                  </div>
                                ));
                              })}
                            </div>
                          </div>
                        )}

                        {/* Best practices — green */}
                        {bestPractices.length > 0 && (
                          <div className="rounded-xl border border-emerald-500/15 bg-emerald-500/[0.03] p-4">
                            <h4 className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                              Сильные стороны
                            </h4>
                            <div className="flex flex-col gap-2">
                              {bestPractices.map((s, i) => {
                                const items = parseItems(s.feedback);
                                return items.map((item, j) => (
                                  <div key={`${i}-${j}`} className="p-2.5 rounded-lg bg-emerald-500/[0.04] border border-emerald-500/10">
                                    <div className="flex gap-2 items-start">
                                      <span className="text-emerald-400 text-[11px] mt-0.5 shrink-0 font-bold">{j + 1}.</span>
                                      <p className="text-[11px] leading-relaxed text-emerald-200/80">{cleanText(item.text)}</p>
                                    </div>
                                  </div>
                                ));
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}
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

      {/* Report-a-bug popup — opens via the bug icon next to the theme toggle */}
      <ReportBugPopup
        isOpen={bugReportOpen}
        onClose={() => setBugReportOpen(false)}
        reporter={session
          ? { name: session.name, role: session.masterRole, department: session.department }
          : null}
      />
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
