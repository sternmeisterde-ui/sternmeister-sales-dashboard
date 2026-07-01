"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AlertTriangle,
  CalendarDays,
  Check,
  ChevronDown,
  Filter,
  Loader2,
  RefreshCw,
} from "lucide-react";
import CalendarPicker, { type DateRange } from "@/components/CalendarPicker";
import DinoLoader from "@/components/DinoLoader";
import TerminLeadDrillModal, {
  type DrillRequest,
} from "@/components/TerminLeadDrillModal";
import {
  fmtLocalDate as formatDate,
  todayBerlinDate,
} from "@/lib/utils/date";

// ── Shared types & helpers ──────────────────────────

type Granularity = "day" | "week";
type BucketBy = "created_at" | "termin_date";

/** Default initial range when a section first mounts: last 30 Berlin civil
 *  days through today. Used as the seed before the РОП picks anything via
 *  the calendar. */
function defaultRangeLast30Days(): { start: Date; end: Date } {
  const today = todayBerlinDate();
  const start = new Date(today.getTime() - 29 * 86_400_000);
  return { start, end: today };
}

function formatRu(d: Date): string {
  return d.toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "short",
  });
}

function formatBucketLabel(iso: string, granularity: Granularity): string {
  const start = new Date(iso);
  if (Number.isNaN(start.getTime())) return iso;
  if (granularity === "day") {
    return start.toLocaleDateString("ru-RU", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  }
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const fmtShort = (d: Date) =>
    d.toLocaleDateString("ru-RU", { day: "2-digit", month: "short" });
  return `Неделя ${fmtShort(start)} — ${fmtShort(end)}`;
}

// ── Termin section types ────────────────────────────

interface TerminApiRow {
  date: string;
  dcAvgDays: number | null;
  aaAvgDays: number | null;
  dcCount: number;
  aaCount: number;
  count: number;
  rescheduledCount: number;
}

interface TerminTooltipPayload {
  value: number | null;
  dataKey: string;
  payload: TerminApiRow;
}

function TerminChartTooltip({
  active,
  payload,
  label,
  granularity,
}: {
  active?: boolean;
  payload?: TerminTooltipPayload[];
  label?: string;
  granularity: Granularity;
}) {
  if (!active || !payload || payload.length === 0 || !label) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  const display = formatBucketLabel(label, granularity);
  return (
    <div className="rounded-lg border border-white/10 bg-slate-900/95 px-3 py-2 text-xs shadow-lg">
      <div className="mb-1 font-semibold text-slate-200">{display}</div>
      <div className="flex items-center gap-2 text-slate-300">
        <span className="inline-block h-2 w-2 rounded-full bg-blue-400" />
        Термин ДЦ:{" "}
        <span className="ml-auto font-medium text-blue-300">
          {row.dcAvgDays == null ? "—" : `${row.dcAvgDays.toFixed(1)} дн.`}
        </span>
        {row.dcCount > 0 && (
          <span className="text-slate-500 text-[10px]">({row.dcCount})</span>
        )}
      </div>
      <div className="flex items-center gap-2 text-slate-300">
        <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
        Термин АА:{" "}
        <span className="ml-auto font-medium text-emerald-300">
          {row.aaAvgDays == null ? "—" : `${row.aaAvgDays.toFixed(1)} дн.`}
        </span>
        {row.aaCount > 0 && (
          <span className="text-slate-500 text-[10px]">({row.aaCount})</span>
        )}
      </div>
      <div className="mt-1 border-t border-white/5 pt-1 text-[11px] text-slate-400 space-y-0.5">
        <div>
          Сделок: <span className="font-medium text-slate-200">{row.count}</span>
        </div>
        <div>
          Из них перенесено:{" "}
          <span className="font-medium text-amber-300">{row.rescheduledCount}</span>
          {row.count > 0 && (
            <span className="text-slate-500">
              {" "}
              ({((row.rescheduledCount / row.count) * 100).toFixed(0)}%)
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Qual-leads section types ────────────────────────

interface QualLeadsApiRow {
  date: string;
  avgDays: number | null;
  qualCount: number;
  docsCount: number;
  conversion: number | null;
}

interface QualLeadsTooltipPayload {
  value: number | null;
  dataKey: string;
  payload: QualLeadsApiRow;
}

function QualLeadsChartTooltip({
  active,
  payload,
  label,
  granularity,
}: {
  active?: boolean;
  payload?: QualLeadsTooltipPayload[];
  label?: string;
  granularity: Granularity;
}) {
  if (!active || !payload || payload.length === 0 || !label) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  const display = formatBucketLabel(label, granularity);
  return (
    <div className="rounded-lg border border-white/10 bg-slate-900/95 px-3 py-2 text-xs shadow-lg">
      <div className="mb-1 font-semibold text-slate-200">{display}</div>
      <div className="flex items-center gap-2 text-slate-300">
        <span className="inline-block h-2 w-2 rounded-full bg-amber-400" />
        Ср. дней до Док. в ДЦ:{" "}
        <span className="ml-auto font-medium text-amber-300">
          {row.avgDays == null ? "—" : `${row.avgDays.toFixed(1)} дн.`}
        </span>
      </div>
      <div className="mt-1 border-t border-white/5 pt-1 text-[11px] text-slate-400 space-y-0.5">
        <div>
          Квал лидов:{" "}
          <span className="font-medium text-slate-200">{row.qualCount}</span>
        </div>
        <div>
          Перешли:{" "}
          <span className="font-medium text-slate-200">{row.docsCount}</span>
          {row.conversion != null && (
            <span className="text-slate-400"> ({row.conversion.toFixed(1)}%)</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Tab root ────────────────────────────────────────

export default function TerminTab({ vertical }: { vertical?: "buh" | "med" | "all" }) {
  // One fetch of the Kommo status list, shared by both Termin-cohort charts.
  // Vertical-aware: статусы бератер-воронки выбранной вертикали.
  const statusRegistry = useBeraterStatuses(vertical);
  // Ярлык вертикали в заголовке верхних графиков (когортное «среднее до термина»).
  // Секции ниже (Qual/Funnel/Upcoming/PreTermin) пока бух-онли — см. spec 21 §11.
  const verticalTitle = vertical === "med" ? "Мед Бератер" : vertical === "all" ? "Бух + Мед Бератер" : "Бух Бератер";
  return (
    <div className="flex flex-col gap-8 fade-in">
      <TerminDashboardSection
        bucketBy="created_at"
        chartTitle={`Среднее время до термина (${verticalTitle})`}
        xAxisHint={{
          day: "дата создания сделки",
          week: "неделя создания (с понедельника)",
        }}
        statusRegistry={statusRegistry}
        vertical={vertical}
      />
      <TerminDashboardSection
        bucketBy="termin_date"
        chartTitle="Среднее время до термина (по дате термина)"
        xAxisHint={{
          day: "дата термина (ДЦ или АА)",
          week: "неделя термина (с понедельника)",
        }}
        statusRegistry={statusRegistry}
        vertical={vertical}
      />
      <QualLeadsDocsSection />
      <FunnelTimingSection />
      <UpcomingTerminsSection vertical={vertical} />
      <PreTerminSection />
    </div>
  );
}

// ── BERATER status filter (chart 1 + 2) ─────────────
//
// Status list is pulled live from /api/dashboard/berater-statuses, which reads
// the analytics mirror of Kommo. Names and even IDs can change in Kommo; the
// frontend never assumes either. We only keep TWO pieces of stable knowledge
// in code:
//
//   - STATUS_GROUP_BY_ID — visual grouping. IDs are stable across Kommo
//     renames; only the labels move. Unknown IDs (new statuses introduced in
//     Kommo since this map was written) get group "other" and appear at the
//     bottom — they're still selectable, just unsorted.
//   - DEFAULT_EXCLUDED_FROM_SELECTION — initial-state exclusions that mirror
//     the prior implicit `<> TERM_DC_CANCELLED` cohort filter.
//
// Anything else (display names, lead counts, ordering within groups) flows
// from the API.

type StatusGroup = "pre_dc" | "post_dc" | "closed" | "other";

const STATUS_GROUP_BY_ID: Record<number, Exclude<StatusGroup, "other">> = {
  // Pre-ДЦ
  93860331: "pre_dc", // RECEIVED_FROM_FIRST
  102183931: "pre_dc", // DOVEDENIE
  93860335: "pre_dc", // IN_PROGRESS
  93860339: "pre_dc", // NO_ANSWER
  93860863: "pre_dc", // CONTACT_MADE
  102183935: "pre_dc", // CONSULT_BEFORE_DC
  102183939: "pre_dc", // CONSULT_BEFORE_DC_DONE
  93860875: "pre_dc", // TERM_DC_CANCELLED
  // Post-ДЦ
  93886075: "post_dc", // TERM_DC_DONE
  102183943: "post_dc", // CONSULT_BEFORE_AA
  102183947: "post_dc", // CONSULT_BEFORE_AA_DONE
  93860883: "post_dc", // TERM_AA_CANCELLED
  93860879: "post_dc", // TERM_AA
  // Closed / прочие
  93860887: "closed", // BERATER_REVIEW
  95515895: "closed", // DELAYED_START
  93860891: "closed", // APPEAL
  142: "closed", // WON
  143: "closed", // LOST
  93860327: "closed", // UNSORTED
};

// Default-deselected on first load. Mirrors the prior implicit
// `<> TERM_DC_CANCELLED` cohort filter so chart values don't shift for
// existing users.
const DEFAULT_EXCLUDED_FROM_SELECTION: ReadonlySet<number> = new Set([
  93860875, // TERM_DC_CANCELLED
]);

const GROUP_LABELS: Record<StatusGroup, string> = {
  pre_dc: "До термина ДЦ",
  post_dc: "После термина ДЦ",
  closed: "Закрытые / прочие",
  other: "Новые / неклассифицированные",
};

interface StatusMeta {
  id: number;
  name: string;
  leadCount: number;
}

interface BeraterStatusesResponse {
  statuses: StatusMeta[];
}

function loadStoredStatusFilter(storageKey: string): number[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((n: unknown) => typeof n === "number") as number[];
  } catch {
    return null;
  }
}

function defaultStatusIds(statuses: StatusMeta[]): number[] {
  return statuses
    .map((s) => s.id)
    .filter((id) => !DEFAULT_EXCLUDED_FROM_SELECTION.has(id));
}

function BeraterStatusMultiselect({
  options,
  loading,
  selected,
  onChange,
}: {
  options: StatusMeta[];
  loading: boolean;
  selected: number[];
  onChange: (next: number[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const labelById = useMemo(
    () => new Map(options.map((s) => [s.id, s.name])),
    [options],
  );

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const total = options.length;
  const count = selected.length;
  const isAll = total > 0 && count === total;
  const summary = loading
    ? "Загрузка статусов…"
    : total === 0
      ? "Нет данных"
      : count === 0
        ? "Не выбрано"
        : isAll
          ? "Все статусы"
          : count === 1
            ? (labelById.get(selected[0]!) ?? `${selected[0]}`)
            : `Статусы: ${count} из ${total}`;

  const toggle = (id: number) => {
    const next = new Set(selectedSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    // Keep API order stable (matches the registry order from the endpoint).
    onChange(options.filter((s) => next.has(s.id)).map((s) => s.id));
  };
  const selectAll = () => onChange(options.map((s) => s.id));
  const selectDefault = () => onChange(defaultStatusIds(options));
  const clearAll = () => onChange([]);

  const grouped: Record<StatusGroup, StatusMeta[]> = {
    pre_dc: [],
    post_dc: [],
    closed: [],
    other: [],
  };
  for (const opt of options) {
    const g = STATUS_GROUP_BY_ID[opt.id] ?? "other";
    grouped[g].push(opt);
  }
  const groupsToRender: StatusGroup[] = (
    ["pre_dc", "post_dc", "closed", "other"] as const
  ).filter((g) => grouped[g].length > 0);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => !loading && setOpen((v) => !v)}
        disabled={loading}
        className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs transition-colors ${
          loading
            ? "bg-slate-800/40 text-slate-500 border-white/5 cursor-wait"
            : isAll || count === 0
              ? "bg-slate-800/40 text-slate-300 border-white/5 hover:border-white/20"
              : "bg-blue-500/10 text-blue-300 border-blue-500/30"
        }`}
        title="Фильтр по статусам сделок (текущий статус в Kommo)"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <Filter className="w-3.5 h-3.5" />
        <span className="max-w-[200px] truncate">{summary}</span>
        <ChevronDown
          className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && !loading && (
        <div
          className="absolute right-0 top-full mt-1 z-40 w-[340px] rounded-xl border border-white/10 bg-slate-900/98 shadow-2xl backdrop-blur p-3"
          role="listbox"
        >
          <div className="flex items-center justify-between gap-2 mb-2 pb-2 border-b border-white/5">
            <div className="text-[10px] uppercase tracking-wider text-slate-500">
              Фильтр статусов · из Kommo
            </div>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={selectAll}
                className="text-[10px] px-2 py-0.5 rounded hover:bg-white/5 text-slate-400 hover:text-white"
              >
                Все
              </button>
              <button
                type="button"
                onClick={selectDefault}
                className="text-[10px] px-2 py-0.5 rounded hover:bg-white/5 text-slate-400 hover:text-white"
                title="Все статусы кроме «Термин ДЦ отменён/перенесён»"
              >
                По умолч.
              </button>
              <button
                type="button"
                onClick={clearAll}
                className="text-[10px] px-2 py-0.5 rounded hover:bg-white/5 text-slate-400 hover:text-white"
              >
                Сбросить
              </button>
            </div>
          </div>
          <div className="max-h-[360px] overflow-y-auto pr-1 space-y-2">
            {groupsToRender.map((g) => (
              <div key={g}>
                <div className="text-[10px] uppercase tracking-wider text-slate-500 px-2 py-1">
                  {GROUP_LABELS[g]}
                </div>
                <div className="flex flex-col">
                  {grouped[g].map((opt) => {
                    const checked = selectedSet.has(opt.id);
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => toggle(opt.id)}
                        className="flex items-center justify-between gap-2 px-2 py-1.5 rounded hover:bg-white/5 text-left text-xs"
                        role="option"
                        aria-selected={checked}
                      >
                        <span className="flex items-center gap-2 min-w-0">
                          <span
                            className={`flex items-center justify-center w-4 h-4 rounded border shrink-0 ${
                              checked
                                ? "bg-blue-500 border-blue-500"
                                : "border-slate-600"
                            }`}
                          >
                            {checked && <Check className="w-3 h-3 text-white" />}
                          </span>
                          <span
                            className={`truncate ${checked ? "text-slate-200" : "text-slate-400"}`}
                          >
                            {opt.name}
                          </span>
                        </span>
                        <span className="text-[10px] text-slate-500 shrink-0">
                          {opt.leadCount.toLocaleString("ru-RU")}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Loads the BERATER status list once per Termin-tab mount and shares it
 *  across the two TerminDashboardSection instances. */
function useBeraterStatuses(vertical?: "buh" | "med" | "all"): { statuses: StatusMeta[]; loading: boolean } {
  const [statuses, setStatuses] = useState<StatusMeta[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const ac = new AbortController();
    const qs = vertical ? `?vertical=${vertical}` : "";
    fetch(`/api/dashboard/berater-statuses${qs}`, { signal: ac.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<BeraterStatusesResponse>;
      })
      .then((data) => {
        setStatuses(data.statuses ?? []);
        setLoading(false);
      })
      .catch((e) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        // On failure, fall through to empty list — the filter will show
        // "Нет данных" and charts will return whatever the API returns when
        // statusIds is empty (currently: empty result). User can refresh.
        setLoading(false);
      });
    return () => ac.abort();
  }, [vertical]);
  return { statuses, loading };
}

// ── Termin dashboard section ────────────────────────

function TerminDashboardSection({
  bucketBy,
  chartTitle,
  xAxisHint,
  statusRegistry,
  vertical,
}: {
  bucketBy: BucketBy;
  chartTitle: string;
  xAxisHint: Record<Granularity, string>;
  statusRegistry: { statuses: StatusMeta[]; loading: boolean };
  vertical?: "buh" | "med" | "all";
}) {
  const [range, setRange] = useState<{ start: Date; end: Date }>(() =>
    defaultRangeLast30Days(),
  );
  const [granularity, setGranularity] = useState<Granularity>("day");
  // useFirst defaults to TRUE per B1=A: original committed termin date, not
  // whatever's been rescheduled to. Toggle exposed in the filter row.
  const [useFirst, setUseFirst] = useState<boolean>(true);
  // Per-section status filter — each chart (created_at vs termin_date) has its
  // own state + localStorage slot so the РОП can configure them independently.
  // statusIds is null until the Kommo registry resolves: we don't want to
  // fire /termins with stale localStorage IDs before we can validate them
  // against the current Kommo status set.
  const storageKey = `termin-section-status-filter-${bucketBy}`;
  const [statusIds, setStatusIds] = useState<number[] | null>(null);
  const { statuses: statusOptions, loading: statusesLoading } = statusRegistry;

  // Initial seed: once the registry resolves, reconcile localStorage against
  // it (drop unknown IDs) or fall back to the default (everything except
  // CANCELLED). Only runs once per registry-load.
  const initRef = useRef(false);
  useEffect(() => {
    // Не инициализируемся, пока реестр статусов не пришёл НЕПУСТЫМ. Иначе при
    // сетевом сбое (berater-statuses вернул []) мы бы выставили пустой выбор и
    // записали его в localStorage — и «залипли» на «Не выбрано» даже после
    // восстановления БД (баг: пустой сохранённый выбор не откатывался к дефолту).
    if (statusesLoading || initRef.current || statusOptions.length === 0) return;
    initRef.current = true;
    const validIds = new Set(statusOptions.map((s) => s.id));
    const stored = loadStoredStatusFilter(storageKey);
    const reconciled = stored ? stored.filter((id) => validIds.has(id)) : [];
    // Пустой результат (нет localStorage, сохранён [] из прошлого сбоя, или все
    // ID устарели) → дефолт, а не залипание на пустом выборе.
    setStatusIds(
      reconciled.length === 0 ? defaultStatusIds(statusOptions) : reconciled,
    );
  }, [statusOptions, statusesLoading, storageKey]);

  useEffect(() => {
    if (typeof window === "undefined" || statusIds === null) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(statusIds));
    } catch {
      // localStorage may be unavailable (private mode, quota); ignore.
    }
  }, [storageKey, statusIds]);
  // Stable string for fetch deps + URL param — joined CSV.
  const statusIdsParam = (statusIds ?? []).join(",");
  const [data, setData] = useState<TerminApiRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drill, setDrill] = useState<DrillRequest | null>(null);
  const hasDataRef = useRef(false);

  const fetchData = useCallback(
    async (signal?: AbortSignal) => {
      // Defer the first /termins call until the status registry is loaded —
      // otherwise we'd issue it with statusIds="" and immediately get an
      // empty response, only to refetch a moment later.
      if (statusIds === null) return;
      if (!hasDataRef.current) setLoading(true);
      setError(null);
      try {
        const dateFrom = formatDate(range.start);
        const dateTo = formatDate(range.end);
        const useFirstParam = useFirst ? "1" : "0";
        // `statusIds` is always sent (empty value means "all deselected → return
        // empty"). Lets the user observe the empty-state intentionally.
        const verticalParam = vertical ? `&vertical=${vertical}` : "";
        const res = await fetch(
          `/api/dashboard/termins?dateFrom=${dateFrom}&dateTo=${dateTo}&granularity=${granularity}&bucketBy=${bucketBy}&useFirst=${useFirstParam}&statusIds=${encodeURIComponent(statusIdsParam)}${verticalParam}`,
          { signal },
        );
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`API error ${res.status}: ${text}`);
        }
        const json = (await res.json()) as TerminApiRow[];
        setData(json);
        hasDataRef.current = true;
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        if (e instanceof TypeError && e.message === "Failed to fetch") return;
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [
      range.start,
      range.end,
      granularity,
      bucketBy,
      useFirst,
      statusIdsParam,
      statusIds,
      vertical,
    ],
  );

  useEffect(() => {
    const ac = new AbortController();
    fetchData(ac.signal);
    return () => ac.abort();
  }, [fetchData]);

  const handleRangeChange = (r: DateRange) => {
    if (!r.start) return;
    const start = r.start;
    const end = r.end ?? r.start;
    setRange({ start, end });
  };

  const stats = useMemo(() => {
    if (!data || data.length === 0)
      return {
        totalDeals: 0,
        rescheduledTotal: 0,
        dcOverall: null as number | null,
        aaOverall: null as number | null,
      };
    let totalDeals = 0;
    let rescheduledTotal = 0;
    let dcSumWeighted = 0;
    let dcWeight = 0;
    let aaSumWeighted = 0;
    let aaWeight = 0;
    for (const row of data) {
      totalDeals += row.count;
      rescheduledTotal += row.rescheduledCount;
      // Per-leg counts as weights — bucket-level dcCount and aaCount differ
      // from row.count (cohort dedup) in chart 2 where each lead can land in
      // different DC vs AA buckets.
      if (row.dcAvgDays != null && row.dcCount > 0) {
        dcSumWeighted += row.dcAvgDays * row.dcCount;
        dcWeight += row.dcCount;
      }
      if (row.aaAvgDays != null && row.aaCount > 0) {
        aaSumWeighted += row.aaAvgDays * row.aaCount;
        aaWeight += row.aaCount;
      }
    }
    return {
      totalDeals,
      rescheduledTotal,
      dcOverall:
        dcWeight > 0 ? Number((dcSumWeighted / dcWeight).toFixed(1)) : null,
      aaOverall:
        aaWeight > 0 ? Number((aaSumWeighted / aaWeight).toFixed(1)) : null,
    };
  }, [data]);

  if (loading && !data) return <DinoLoader />;

  if (error && !data) {
    return (
      <div className="glass-panel rounded-2xl p-8 border border-red-500/20 text-center">
        <AlertTriangle className="w-10 h-10 text-red-400 mx-auto mb-3" />
        <p className="text-red-400 text-sm">{error}</p>
        <button
          type="button"
          onClick={() => fetchData()}
          className="mt-4 px-4 py-2 bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 rounded-lg text-sm transition-colors"
        >
          Попробовать снова
        </button>
      </div>
    );
  }

  const isRefreshing = loading && !!data;
  const hasData = !!data && data.length > 0;
  const dateDisplay = `${formatRu(range.start)} — ${formatRu(range.end)}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="glass-panel rounded-2xl border border-white/5 p-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 shrink-0">
          <CalendarDays className="w-4 h-4 text-blue-400 shrink-0" />
          <span className="text-xs text-slate-300 font-medium">
            Выберите период:
          </span>
        </div>
          <div className="inline-flex p-0.5 rounded-lg bg-slate-800/60 border border-white/5">
            {(["day", "week"] as const).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setGranularity(g)}
                className={`text-[10px] uppercase tracking-wider px-3 py-1 rounded-md transition-colors ${
                  granularity === g
                    ? "bg-blue-500/20 text-blue-300"
                    : "text-slate-400 hover:text-white"
                }`}
                aria-pressed={granularity === g}
              >
                {g === "day" ? "День" : "Неделя"}
              </button>
            ))}
          </div>
          <div
            className="inline-flex p-0.5 rounded-lg bg-slate-800/60 border border-white/5"
            title="Какая дата термина учитывается: первая назначенная или текущая (после переносов)"
          >
            {(
              [
                ["first", "Первая"],
                ["latest", "Текущая"],
              ] as const
            ).map(([key, label]) => {
              const active = (key === "first") === useFirst;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setUseFirst(key === "first")}
                  className={`text-[10px] uppercase tracking-wider px-3 py-1 rounded-md transition-colors ${
                    active
                      ? "bg-blue-500/20 text-blue-300"
                      : "text-slate-400 hover:text-white"
                  }`}
                  aria-pressed={active}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <BeraterStatusMultiselect
            options={statusOptions}
            loading={statusesLoading}
            selected={statusIds ?? []}
            onChange={setStatusIds}
          />
          <CalendarPicker
            mode="range"
            value={{ start: range.start, end: range.end }}
            onChange={handleRangeChange}
            onClear={() => setRange(defaultRangeLast30Days())}
          />
          <span className="text-xs text-slate-400 hidden sm:inline">
            {dateDisplay}
          </span>
          <button
            type="button"
            onClick={() => fetchData()}
            disabled={loading}
            className="ml-auto p-2 rounded-lg hover:bg-white/5 text-slate-400 hover:text-white transition-colors disabled:opacity-50"
            title="Обновить"
            aria-label="Обновить"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </button>
      </div>

      {isRefreshing && (
        <div className="flex items-center justify-center">
          <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-blue-500/10 border border-blue-500/20">
            <Loader2 className="w-3 h-3 animate-spin text-blue-400" />
            <span className="text-[10px] text-blue-400 font-medium">
              Обновление данных...
            </span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <SummaryTile
          label="Сделок в когорте"
          value={stats.totalDeals.toLocaleString("ru-RU")}
          accent="text-slate-200"
          onClick={
            stats.totalDeals === 0
              ? undefined
              : () => {
                  const dateFrom = formatDate(range.start);
                  const dateTo = formatDate(range.end);
                  setDrill({
                    url: "/api/dashboard/termins/leads",
                    params: {
                      dateFrom,
                      dateTo,
                      mode: "cohort",
                      bucketBy,
                      granularity,
                      useFirst: useFirst ? "1" : "0",
                      statusIds: statusIdsParam,
                    },
                    title: `Когорта · ${dateDisplay}`,
                    subtitle: `${stats.totalDeals} лидов · сверху — с большим числом переносов`,
                  });
                }
          }
        />
        <SummaryTile
          label="Ср. до Термин ДЦ"
          value={
            stats.dcOverall == null ? "—" : `${stats.dcOverall.toFixed(1)} дн.`
          }
          accent="text-blue-300"
          onClick={
            stats.dcOverall == null
              ? undefined
              : () => {
                  const dateFrom = formatDate(range.start);
                  const dateTo = formatDate(range.end);
                  setDrill({
                    url: "/api/dashboard/termins/leads",
                    params: {
                      dateFrom,
                      dateTo,
                      leg: "dc",
                      bucketBy,
                      granularity,
                      useFirst: useFirst ? "1" : "0",
                      statusIds: statusIdsParam,
                    },
                    title: `Термин ДЦ · ${dateDisplay}`,
                    subtitle: `Ср. ${(stats.dcOverall ?? 0).toFixed(1)} дн · сверху — самые долгие`,
                  });
                }
          }
        />
        <SummaryTile
          label="Ср. до Термин АА"
          value={
            stats.aaOverall == null ? "—" : `${stats.aaOverall.toFixed(1)} дн.`
          }
          accent="text-emerald-300"
          onClick={
            stats.aaOverall == null
              ? undefined
              : () => {
                  const dateFrom = formatDate(range.start);
                  const dateTo = formatDate(range.end);
                  setDrill({
                    url: "/api/dashboard/termins/leads",
                    params: {
                      dateFrom,
                      dateTo,
                      leg: "aa",
                      bucketBy,
                      granularity,
                      useFirst: useFirst ? "1" : "0",
                      statusIds: statusIdsParam,
                    },
                    title: `Термин АА · ${dateDisplay}`,
                    subtitle: `Ср. ${(stats.aaOverall ?? 0).toFixed(1)} дн · сверху — самые долгие`,
                  });
                }
          }
        />
        <SummaryTile
          label="Перенесено"
          value={
            stats.totalDeals > 0
              ? `${stats.rescheduledTotal.toLocaleString("ru-RU")} (${(
                  (stats.rescheduledTotal / stats.totalDeals) *
                  100
                ).toFixed(0)}%)`
              : "—"
          }
          accent="text-amber-300"
          onClick={
            stats.rescheduledTotal === 0
              ? undefined
              : () => {
                  const dateFrom = formatDate(range.start);
                  const dateTo = formatDate(range.end);
                  setDrill({
                    url: "/api/dashboard/termins/leads",
                    params: {
                      dateFrom,
                      dateTo,
                      mode: "rescheduled",
                      bucketBy,
                      granularity,
                      useFirst: useFirst ? "1" : "0",
                      statusIds: statusIdsParam,
                    },
                    title: `Перенесено · ${dateDisplay}`,
                    subtitle: `${stats.rescheduledTotal} лидов с переносами · сверху — больше всего переносов`,
                  });
                }
          }
        />
      </div>

      <div className="glass-panel rounded-2xl p-4 sm:p-5 border border-white/5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-slate-300 font-semibold tracking-wide text-xs uppercase">
            {chartTitle}
          </h3>
          <span className="text-[10px] text-slate-500 hidden sm:inline">
            ось X — {xAxisHint[granularity]}
          </span>
        </div>
        {hasData ? (
          <div className="h-[260px] sm:h-[320px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={data ?? []}
                margin={{ top: 5, right: 10, left: -10, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis
                  dataKey="date"
                  tick={{ fill: "#64748b", fontSize: 11 }}
                  axisLine={{ stroke: "#334155" }}
                  tickLine={false}
                  tickFormatter={(v: string) => {
                    const d = new Date(v);
                    if (Number.isNaN(d.getTime())) return v;
                    return d.toLocaleDateString("ru-RU", {
                      day: "2-digit",
                      month: "2-digit",
                    });
                  }}
                />
                <YAxis
                  tick={{ fill: "#64748b", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  allowDecimals
                  unit=" дн"
                />
                <RTooltip
                  content={<TerminChartTooltip granularity={granularity} />}
                />
                <Legend
                  wrapperStyle={{ fontSize: 11, color: "#94a3b8" }}
                  iconType="circle"
                />
                <Line
                  type="monotone"
                  dataKey="dcAvgDays"
                  name="Термин ДЦ"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  dot={{ fill: "#3b82f6", r: 4 }}
                  activeDot={{
                    r: 6,
                    fill: "#3b82f6",
                    cursor: "pointer",
                    onClick: (_e: unknown, payload: unknown) => {
                      const p = payload as
                        | { payload?: TerminApiRow }
                        | undefined;
                      const row = p?.payload;
                      if (!row || row.dcCount === 0) return;
                      setDrill({
                        url: "/api/dashboard/termins/leads",
                        params: {
                          date: row.date,
                          leg: "dc",
                          bucketBy,
                          granularity,
                          useFirst: useFirst ? "1" : "0",
                          statusIds: statusIdsParam,
                        },
                        title: `${formatBucketLabel(row.date, granularity)} · Термин ДЦ`,
                        subtitle: `Ср. ${row.dcAvgDays?.toFixed(1) ?? "—"} дн · ${row.dcCount} лидов · сверху — самые долгие`,
                      });
                    },
                  }}
                  connectNulls
                />
                <Line
                  type="monotone"
                  dataKey="aaAvgDays"
                  name="Термин АА"
                  stroke="#10b981"
                  strokeWidth={2}
                  dot={{ fill: "#10b981", r: 4 }}
                  activeDot={{
                    r: 6,
                    fill: "#10b981",
                    cursor: "pointer",
                    onClick: (_e: unknown, payload: unknown) => {
                      const p = payload as
                        | { payload?: TerminApiRow }
                        | undefined;
                      const row = p?.payload;
                      if (!row || row.aaCount === 0) return;
                      setDrill({
                        url: "/api/dashboard/termins/leads",
                        params: {
                          date: row.date,
                          leg: "aa",
                          bucketBy,
                          granularity,
                          useFirst: useFirst ? "1" : "0",
                          statusIds: statusIdsParam,
                        },
                        title: `${formatBucketLabel(row.date, granularity)} · Термин АА`,
                        subtitle: `Ср. ${row.aaAvgDays?.toFixed(1) ?? "—"} дн · ${row.aaCount} лидов · сверху — самые долгие`,
                      });
                    },
                  }}
                  connectNulls
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 text-center text-slate-500">
            <CalendarDays className="w-8 h-8 mb-2 text-slate-600" />
            <p className="text-sm">
              За выбранный период нет сделок с проставленным термином.
            </p>
          </div>
        )}
      </div>
      {drill && (
        <TerminLeadDrillModal request={drill} onClose={() => setDrill(null)} />
      )}
    </div>
  );
}

// ── Qual-leads → Документы отправлены в ДЦ section ───

function QualLeadsDocsSection() {
  const [range, setRange] = useState<{ start: Date; end: Date }>(() =>
    defaultRangeLast30Days(),
  );
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [data, setData] = useState<QualLeadsApiRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drill, setDrill] = useState<DrillRequest | null>(null);
  const hasDataRef = useRef(false);

  const fetchData = useCallback(
    async (signal?: AbortSignal) => {
      if (!hasDataRef.current) setLoading(true);
      setError(null);
      try {
        const dateFrom = formatDate(range.start);
        const dateTo = formatDate(range.end);
        const res = await fetch(
          `/api/dashboard/qual-leads-docs?dateFrom=${dateFrom}&dateTo=${dateTo}&granularity=${granularity}`,
          { signal },
        );
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`API error ${res.status}: ${text}`);
        }
        const json = (await res.json()) as QualLeadsApiRow[];
        setData(json);
        hasDataRef.current = true;
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        if (e instanceof TypeError && e.message === "Failed to fetch") return;
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [range.start, range.end, granularity],
  );

  useEffect(() => {
    const ac = new AbortController();
    fetchData(ac.signal);
    return () => ac.abort();
  }, [fetchData]);

  const handleRangeChange = (r: DateRange) => {
    if (!r.start) return;
    const start = r.start;
    const end = r.end ?? r.start;
    setRange({ start, end });
  };

  const stats = useMemo(() => {
    if (!data || data.length === 0)
      return {
        qualTotal: 0,
        docsTotal: 0,
        avgOverall: null as number | null,
        conversionOverall: null as number | null,
      };
    let qualTotal = 0;
    let docsTotal = 0;
    let avgSumWeighted = 0;
    let avgWeight = 0;
    for (const row of data) {
      qualTotal += row.qualCount;
      docsTotal += row.docsCount;
      if (row.avgDays != null && row.docsCount > 0) {
        avgSumWeighted += row.avgDays * row.docsCount;
        avgWeight += row.docsCount;
      }
    }
    return {
      qualTotal,
      docsTotal,
      avgOverall:
        avgWeight > 0 ? Number((avgSumWeighted / avgWeight).toFixed(1)) : null,
      conversionOverall:
        qualTotal > 0
          ? Number(((docsTotal / qualTotal) * 100).toFixed(1))
          : null,
    };
  }, [data]);

  if (loading && !data) return <DinoLoader />;

  if (error && !data) {
    return (
      <div className="glass-panel rounded-2xl p-8 border border-red-500/20 text-center">
        <AlertTriangle className="w-10 h-10 text-red-400 mx-auto mb-3" />
        <p className="text-red-400 text-sm">{error}</p>
        <button
          type="button"
          onClick={() => fetchData()}
          className="mt-4 px-4 py-2 bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 rounded-lg text-sm transition-colors"
        >
          Попробовать снова
        </button>
      </div>
    );
  }

  const isRefreshing = loading && !!data;
  const hasData = !!data && data.length > 0;
  const dateDisplay = `${formatRu(range.start)} — ${formatRu(range.end)}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="glass-panel rounded-2xl border border-white/5 p-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 shrink-0">
          <CalendarDays className="w-4 h-4 text-amber-400 shrink-0" />
          <span className="text-xs text-slate-300 font-medium">
            Выберите период:
          </span>
        </div>
          <div className="inline-flex p-0.5 rounded-lg bg-slate-800/60 border border-white/5">
            {(["day", "week"] as const).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setGranularity(g)}
                className={`text-[10px] uppercase tracking-wider px-3 py-1 rounded-md transition-colors ${
                  granularity === g
                    ? "bg-amber-500/20 text-amber-300"
                    : "text-slate-400 hover:text-white"
                }`}
                aria-pressed={granularity === g}
              >
                {g === "day" ? "День" : "Неделя"}
              </button>
            ))}
          </div>
          <CalendarPicker
            mode="range"
            value={{ start: range.start, end: range.end }}
            onChange={handleRangeChange}
            onClear={() => setRange(defaultRangeLast30Days())}
          />
          <span className="text-xs text-slate-400 hidden sm:inline">
            {dateDisplay}
          </span>
          <button
            type="button"
            onClick={() => fetchData()}
            disabled={loading}
            className="ml-auto p-2 rounded-lg hover:bg-white/5 text-slate-400 hover:text-white transition-colors disabled:opacity-50"
            title="Обновить"
            aria-label="Обновить"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </button>
      </div>

      {isRefreshing && (
        <div className="flex items-center justify-center">
          <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/20">
            <Loader2 className="w-3 h-3 animate-spin text-amber-400" />
            <span className="text-[10px] text-amber-400 font-medium">
              Обновление данных...
            </span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <SummaryTile
          label="Квал лидов в когорте"
          value={stats.qualTotal.toLocaleString("ru-RU")}
          accent="text-slate-200"
          onClick={
            stats.qualTotal === 0
              ? undefined
              : () => {
                  const dateFrom = formatDate(range.start);
                  const dateTo = formatDate(range.end);
                  setDrill({
                    url: "/api/dashboard/qual-leads-docs/leads",
                    params: { dateFrom, dateTo, mode: "cohort" },
                    title: `Квал-когорта · ${dateDisplay}`,
                    subtitle: `${stats.qualTotal} лидов · сверху — без перехода в «Док. в ДЦ»`,
                  });
                }
          }
        />
        <SummaryTile
          label="Дошли до Док./Termin"
          value={stats.docsTotal.toLocaleString("ru-RU")}
          accent="text-slate-200"
          onClick={
            stats.docsTotal === 0
              ? undefined
              : () => {
                  const dateFrom = formatDate(range.start);
                  const dateTo = formatDate(range.end);
                  setDrill({
                    url: "/api/dashboard/qual-leads-docs/leads",
                    params: { dateFrom, dateTo, mode: "docs" },
                    title: `Дошли до Док. / прямого Termin · ${dateDisplay}`,
                    subtitle: `${stats.docsTotal} лидов · сверху — самые долгие переходы`,
                  });
                }
          }
        />
        <SummaryTile
          label="Ср. дней до перехода"
          value={
            stats.avgOverall == null
              ? "—"
              : `${stats.avgOverall.toFixed(1)} дн.`
          }
          accent="text-amber-300"
          onClick={
            stats.avgOverall == null
              ? undefined
              : () => {
                  const dateFrom = formatDate(range.start);
                  const dateTo = formatDate(range.end);
                  setDrill({
                    url: "/api/dashboard/qual-leads-docs/leads",
                    params: { dateFrom, dateTo, mode: "docs" },
                    title: `Ср. дней до Док. в ДЦ · ${dateDisplay}`,
                    subtitle: `${stats.docsTotal} лидов · ср. ${(stats.avgOverall ?? 0).toFixed(1)} дн · сверху — самые долгие`,
                  });
                }
          }
        />
        <SummaryTile
          label="Конверсия"
          value={
            stats.conversionOverall == null
              ? "—"
              : `${stats.conversionOverall.toFixed(1)}%`
          }
          accent="text-amber-300"
          onClick={
            stats.qualTotal === 0
              ? undefined
              : () => {
                  const dateFrom = formatDate(range.start);
                  const dateTo = formatDate(range.end);
                  setDrill({
                    url: "/api/dashboard/qual-leads-docs/leads",
                    params: { dateFrom, dateTo, mode: "cohort" },
                    title: `Конверсия в «Док. в ДЦ» · ${dateDisplay}`,
                    subtitle: `${stats.docsTotal} из ${stats.qualTotal} (${stats.conversionOverall?.toFixed(1) ?? "—"}%) · сверху — кто не дошёл`,
                  });
                }
          }
        />
      </div>

      <div className="glass-panel rounded-2xl p-4 sm:p-5 border border-white/5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-slate-300 font-semibold tracking-wide text-xs uppercase">
            Среднее время до «Док. в ДЦ» или прямого Termin ДЦ
          </h3>
          <span className="text-[10px] text-slate-500 hidden sm:inline">
            ось X —{" "}
            {granularity === "day"
              ? "дата создания лида"
              : "неделя создания (с понедельника)"}{" "}
            · первое событие из двух
          </span>
        </div>
        {hasData ? (
          <div className="h-[260px] sm:h-[320px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={data ?? []}
                margin={{ top: 5, right: 10, left: -10, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis
                  dataKey="date"
                  tick={{ fill: "#64748b", fontSize: 11 }}
                  axisLine={{ stroke: "#334155" }}
                  tickLine={false}
                  tickFormatter={(v: string) => {
                    const d = new Date(v);
                    if (Number.isNaN(d.getTime())) return v;
                    return d.toLocaleDateString("ru-RU", {
                      day: "2-digit",
                      month: "2-digit",
                    });
                  }}
                />
                <YAxis
                  tick={{ fill: "#64748b", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  allowDecimals
                  unit=" дн"
                />
                <RTooltip
                  content={<QualLeadsChartTooltip granularity={granularity} />}
                />
                <Legend
                  wrapperStyle={{ fontSize: 11, color: "#94a3b8" }}
                  iconType="circle"
                />
                <Line
                  type="monotone"
                  dataKey="avgDays"
                  name="Ср. дней до Док. в ДЦ"
                  stroke="#f59e0b"
                  strokeWidth={2}
                  dot={{ fill: "#f59e0b", r: 4 }}
                  activeDot={{
                    r: 6,
                    fill: "#f59e0b",
                    cursor: "pointer",
                    onClick: (_e: unknown, payload: unknown) => {
                      const p = payload as
                        | { payload?: QualLeadsApiRow }
                        | undefined;
                      const row = p?.payload;
                      if (!row || row.docsCount === 0) return;
                      setDrill({
                        url: "/api/dashboard/qual-leads-docs/leads",
                        params: { date: row.date, granularity },
                        title: formatBucketLabel(row.date, granularity),
                        subtitle: `${row.docsCount} лидов с переходом в «Док. в ДЦ» (из ${row.qualCount} квал-когорты) · ср. ${row.avgDays?.toFixed(1) ?? "—"} дн · самые долгие сверху`,
                      });
                    },
                  }}
                  connectNulls
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 text-center text-slate-500">
            <CalendarDays className="w-8 h-8 mb-2 text-slate-600" />
            <p className="text-sm">
              За выбранный период нет квалифицированных лидов.
            </p>
          </div>
        )}
      </div>
      {drill && (
        <TerminLeadDrillModal request={drill} onClose={() => setDrill(null)} />
      )}
    </div>
  );
}

// ── Funnel timing (E1+E2) ───────────────────────────

interface FunnelStageRow {
  from: string;
  fromName: string;
  to: string;
  toName: string;
  count: number;
  avgDays: number | null;
}

function FunnelTimingSection() {
  // 90d default: stage transitions take 20+ days each, so the 30d default used
  // by the cohort sections leaves the funnel mostly empty (most leads in the
  // window haven't completed the next transition yet). 90d shows mature data.
  const initialRange = useMemo(() => {
    const today = todayBerlinDate();
    const start = new Date(today.getTime() - 89 * 86_400_000);
    return { start, end: today };
  }, []);
  const [range, setRange] = useState<{ start: Date; end: Date }>(initialRange);
  const [data, setData] = useState<FunnelStageRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drill, setDrill] = useState<DrillRequest | null>(null);
  const hasDataRef = useRef(false);

  const fetchData = useCallback(
    async (signal?: AbortSignal) => {
      if (!hasDataRef.current) setLoading(true);
      setError(null);
      try {
        const dateFrom = formatDate(range.start);
        const dateTo = formatDate(range.end);
        const res = await fetch(
          `/api/dashboard/termin-funnel?dateFrom=${dateFrom}&dateTo=${dateTo}`,
          { signal },
        );
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`API error ${res.status}: ${text}`);
        }
        const json = (await res.json()) as FunnelStageRow[];
        setData(json);
        hasDataRef.current = true;
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        if (e instanceof TypeError && e.message === "Failed to fetch") return;
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [range.start, range.end],
  );

  useEffect(() => {
    const ac = new AbortController();
    fetchData(ac.signal);
    return () => ac.abort();
  }, [fetchData]);

  const handleRangeChange = (r: DateRange) => {
    if (!r.start) return;
    setRange({ start: r.start, end: r.end ?? r.start });
  };

  if (loading && !data) return <DinoLoader />;
  if (error && !data) {
    return (
      <div className="glass-panel rounded-2xl p-8 border border-red-500/20 text-center">
        <AlertTriangle className="w-10 h-10 text-red-400 mx-auto mb-3" />
        <p className="text-red-400 text-sm">{error}</p>
      </div>
    );
  }

  const isRefreshing = loading && !!data;
  const hasData = !!data && data.length > 0 && data.some((s) => s.count > 0);
  const dateDisplay = `${formatRu(range.start)} — ${formatRu(range.end)}`;

  // Distinct hue per stage so the bar chart reads as a sequence.
  const stageColors = ["#8b5cf6", "#06b6d4", "#10b981"];
  const chartData = (data ?? []).map((s, i) => ({
    label: `${s.fromName} → ${s.toName}`,
    avgDays: s.avgDays,
    count: s.count,
    color: stageColors[i] ?? "#94a3b8",
    // Stage index is 1-based for the API (matches its query schema), but
    // chartData is rendered in array order — we keep `stage` on the row so
    // the bar onClick can pass it through without index lookups.
    stage: (i + 1) as 1 | 2 | 3,
    fromName: s.fromName,
    toName: s.toName,
  }));

  return (
    <div className="flex flex-col gap-4">
      <div className="glass-panel rounded-2xl border border-white/5 p-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 shrink-0">
          <CalendarDays className="w-4 h-4 text-violet-400 shrink-0" />
          <span className="text-xs text-slate-300 font-medium">
            Выберите период:
          </span>
        </div>
          <CalendarPicker
            mode="range"
            value={{ start: range.start, end: range.end }}
            onChange={handleRangeChange}
            onClear={() => setRange(initialRange)}
          />
          <span className="text-xs text-slate-400 hidden sm:inline">{dateDisplay}</span>
          <button
            type="button"
            onClick={() => fetchData()}
            disabled={loading}
            className="ml-auto p-2 rounded-lg hover:bg-white/5 text-slate-400 hover:text-white transition-colors disabled:opacity-50"
            title="Обновить"
            aria-label="Обновить"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </button>
      </div>

      {isRefreshing && (
        <div className="flex items-center justify-center">
          <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-violet-500/10 border border-violet-500/20">
            <Loader2 className="w-3 h-3 animate-spin text-violet-400" />
            <span className="text-[10px] text-violet-400 font-medium">Обновление данных...</span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {(data ?? []).map((s, i) => {
          const stage = (i + 1) as 1 | 2 | 3;
          return (
            <SummaryTile
              key={s.from + s.to}
              label={`${s.fromName} → ${s.toName}`}
              value={
                s.avgDays == null
                  ? "— дн."
                  : `${s.avgDays.toFixed(1)} дн.`
              }
              sublabel={`${s.count.toLocaleString("ru-RU")} переходов`}
              accent={
                i === 0
                  ? "text-violet-300"
                  : i === 1
                    ? "text-cyan-300"
                    : "text-emerald-300"
              }
              onClick={
                s.count === 0
                  ? undefined
                  : () => {
                      const dateFrom = formatDate(range.start);
                      const dateTo = formatDate(range.end);
                      setDrill({
                        url: "/api/dashboard/termin-funnel/leads",
                        params: {
                          stage: String(stage),
                          dateFrom,
                          dateTo,
                        },
                        title: `${s.fromName} → ${s.toName}`,
                        subtitle: `${s.count} переходов · ср. ${s.avgDays?.toFixed(1) ?? "—"} дн · сверху — самые долгие · окно ${dateDisplay}`,
                      });
                    }
              }
            />
          );
        })}
      </div>

      <div className="glass-panel rounded-2xl p-4 sm:p-5 border border-white/5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-slate-300 font-semibold tracking-wide text-xs uppercase">
            Воронка — среднее время между этапами
          </h3>
          <span className="text-[10px] text-slate-500 hidden sm:inline">
            учтены лиды, чей переход состоялся в окне
          </span>
        </div>
        {hasData ? (
          <div className="h-[260px] sm:h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={chartData}
                layout="vertical"
                margin={{ top: 10, right: 220, left: 0, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" horizontal={false} />
                <XAxis
                  type="number"
                  tick={{ fill: "#64748b", fontSize: 11 }}
                  axisLine={{ stroke: "#334155" }}
                  tickLine={false}
                  unit=" дн"
                />
                <YAxis
                  dataKey="label"
                  type="category"
                  tick={{ fill: "#94a3b8", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={260}
                />
                <Bar
                  dataKey="avgDays"
                  radius={[0, 6, 6, 0]}
                  isAnimationActive={false}
                  cursor="pointer"
                  onClick={(d: unknown) => {
                    const row = d as
                      | (typeof chartData)[number]
                      | undefined;
                    if (!row || row.count === 0) return;
                    const dateFrom = formatDate(range.start);
                    const dateTo = formatDate(range.end);
                    setDrill({
                      url: "/api/dashboard/termin-funnel/leads",
                      params: {
                        stage: String(row.stage),
                        dateFrom,
                        dateTo,
                      },
                      title: `${row.fromName} → ${row.toName}`,
                      subtitle: `${row.count} переходов · самые долгие сверху · окно ${formatRu(range.start)} — ${formatRu(range.end)}`,
                    });
                  }}
                >
                  {chartData.map((d) => (
                    <Cell key={d.label} fill={d.color} />
                  ))}
                  <LabelList
                    dataKey="avgDays"
                    position="right"
                    content={(props) => {
                      const {
                        x = 0,
                        y = 0,
                        width = 0,
                        height = 0,
                        index,
                      } = props as {
                        x?: number;
                        y?: number;
                        width?: number;
                        height?: number;
                        index?: number;
                      };
                      const row =
                        index != null ? chartData[index] : undefined;
                      if (!row) return null;
                      const days =
                        row.avgDays == null
                          ? "—"
                          : `${row.avgDays.toFixed(1)} дн`;
                      return (
                        <text
                          x={Number(x) + Number(width) + 8}
                          y={Number(y) + Number(height) / 2 + 4}
                          fill="#e2e8f0"
                          fontSize={12}
                          fontWeight={600}
                        >
                          Ср. время {days}
                          <tspan fill="#94a3b8" fontWeight={400}>
                            {" "}
                            · переходов: {row.count}
                          </tspan>
                        </text>
                      );
                    }}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 text-center text-slate-500">
            <CalendarDays className="w-8 h-8 mb-2 text-slate-600" />
            <p className="text-sm">За выбранный период нет переходов на этих этапах.</p>
          </div>
        )}
      </div>
      {drill && (
        <TerminLeadDrillModal request={drill} onClose={() => setDrill(null)} />
      )}
    </div>
  );
}

// ── Upcoming termins (D1) ───────────────────────────

interface UpcomingRow {
  date: string;
  dcCount: number;
  aaCount: number;
  totalCount: number;
}

function UpcomingTerminsSection({ vertical }: { vertical?: "buh" | "med" | "all" }) {
  const drillVertical: Record<string, string> = vertical ? { vertical } : {};
  const [days, setDays] = useState<number>(30);
  // Произвольный диапазон с календаря. Если задан (start+end) — переопределяет
  // пресеты days и запрашивается через from/to.
  const [customRange, setCustomRange] = useState<DateRange | null>(null);
  const isCustom = !!(customRange?.start && customRange?.end);
  const periodLabel = isCustom
    ? `${formatRu(customRange!.start!)} — ${formatRu(customRange!.end!)}`
    : `следующие ${days} дней`;
  // Календарь всегда показывает активное окно (как у соседних графиков): либо
  // кастомный диапазон, либо окно пресета [сегодня, сегодня+days-1]. Иначе при
  // активном пресете он выглядел бы пустым и отличался от соседей.
  const calendarRange: DateRange = isCustom
    ? customRange!
    : (() => {
        const start = todayBerlinDate();
        return { start, end: new Date(start.getTime() + (days - 1) * 86_400_000) };
      })();
  // Как в соседних секциях: onChange может прийти с незавершённым диапазоном
  // (end=null на первом клике) — подставляем end=start.
  const handleCalendarChange = (r: DateRange) => {
    if (!r.start) return;
    setCustomRange({ start: r.start, end: r.end ?? r.start });
  };
  const [data, setData] = useState<UpcomingRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drill, setDrill] = useState<DrillRequest | null>(null);
  const hasDataRef = useRef(false);

  const fetchData = useCallback(
    async (signal?: AbortSignal) => {
      if (!hasDataRef.current) setLoading(true);
      setError(null);
      try {
        const vqs = vertical ? `&vertical=${vertical}` : "";
        const qs =
          (customRange?.start && customRange?.end
            ? `from=${formatDate(customRange.start)}&to=${formatDate(customRange.end)}`
            : `days=${days}`) + vqs;
        const res = await fetch(`/api/dashboard/termins-upcoming?${qs}`, {
          signal,
          // Polling-driven refreshes must hit the server. Without no-store the
          // browser HTTP cache could replay a 60s-old response and the
          // dashboard would drift from CRM until the user manually refreshed.
          cache: "no-store",
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`API error ${res.status}: ${text}`);
        }
        const json = (await res.json()) as UpcomingRow[];
        setData(json);
        hasDataRef.current = true;
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        if (e instanceof TypeError && e.message === "Failed to fetch") return;
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [days, customRange, vertical],
  );

  useEffect(() => {
    const ac = new AbortController();
    fetchData(ac.signal);

    // Auto-refresh every 10 minutes — aligned with the ETL cron interval
    // (SYNC_INTERVAL_SECONDS=600). Polling more often than that just hits the
    // server with stale-from-DB results; polling slower means the dashboard
    // lags Kommo by more than one ETL cycle.
    const POLL_INTERVAL_MS = 10 * 60 * 1000;
    const interval = setInterval(() => {
      fetchData();
    }, POLL_INTERVAL_MS);

    // Tab returning to foreground after being hidden: refresh immediately.
    // Browsers throttle setInterval in background tabs, so a polling cadence
    // alone isn't enough — switching back triggers a fresh load.
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        fetchData();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      ac.abort();
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [fetchData]);

  const stats = useMemo(() => {
    if (!data || data.length === 0)
      return { totalDc: 0, totalAa: 0, peakDay: null as { date: string; n: number } | null };
    let totalDc = 0;
    let totalAa = 0;
    let peakDay: { date: string; n: number } | null = null;
    for (const r of data) {
      totalDc += r.dcCount;
      totalAa += r.aaCount;
      if (peakDay == null || r.totalCount > peakDay.n) {
        peakDay = { date: r.date, n: r.totalCount };
      }
    }
    return { totalDc, totalAa, peakDay };
  }, [data]);

  if (loading && !data) return <DinoLoader />;
  if (error && !data) {
    return (
      <div className="glass-panel rounded-2xl p-8 border border-red-500/20 text-center">
        <AlertTriangle className="w-10 h-10 text-red-400 mx-auto mb-3" />
        <p className="text-red-400 text-sm">{error}</p>
      </div>
    );
  }

  const isRefreshing = loading && !!data;
  const hasData = !!data && data.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="glass-panel rounded-2xl border border-white/5 p-4 flex flex-wrap items-center gap-3">
        <CalendarDays className="w-4 h-4 text-cyan-400 shrink-0" />
        {[7, 14, 30, 60, 90].map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => {
              setCustomRange(null);
              setDays(d);
            }}
            className={`text-[10px] uppercase tracking-wider px-3 py-1.5 rounded-lg border transition-colors ${
              days === d && !isCustom
                ? "bg-cyan-500/20 text-cyan-300 border-cyan-500/40"
                : "bg-slate-800/40 text-slate-400 border-white/5 hover:text-white hover:border-white/20"
            }`}
          >
            {d} дн
          </button>
        ))}
        <CalendarPicker
          mode="range"
          value={calendarRange}
          onChange={handleCalendarChange}
          onClear={() => setCustomRange(null)}
        />
        <button
          type="button"
          onClick={() => fetchData()}
          disabled={loading}
          className="ml-auto p-2 rounded-lg hover:bg-white/5 text-slate-400 hover:text-white transition-colors disabled:opacity-50"
          title="Обновить"
          aria-label="Обновить"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {isRefreshing && (
        <div className="flex items-center justify-center">
          <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-cyan-500/10 border border-cyan-500/20">
            <Loader2 className="w-3 h-3 animate-spin text-cyan-400" />
            <span className="text-[10px] text-cyan-400 font-medium">Обновление данных...</span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <SummaryTile
          label="Всего ДЦ-термин на период"
          value={stats.totalDc.toLocaleString("ru-RU")}
          accent="text-blue-300"
          onClick={
            stats.totalDc === 0 || !data || data.length === 0
              ? undefined
              : () => {
                  const dateFrom = data[0].date;
                  const dateTo = data[data.length - 1].date;
                  setDrill({
                    url: "/api/dashboard/termins-upcoming/leads",
                    params: { dateFrom, dateTo, leg: "dc", ...drillVertical },
                    title: `Термин ДЦ · ${periodLabel}`,
                    subtitle: `${stats.totalDc} лидов · по времени слота`,
                  });
                }
          }
        />
        <SummaryTile
          label="Всего АА-термин на период"
          value={stats.totalAa.toLocaleString("ru-RU")}
          accent="text-emerald-300"
          onClick={
            stats.totalAa === 0 || !data || data.length === 0
              ? undefined
              : () => {
                  const dateFrom = data[0].date;
                  const dateTo = data[data.length - 1].date;
                  setDrill({
                    url: "/api/dashboard/termins-upcoming/leads",
                    params: { dateFrom, dateTo, leg: "aa", ...drillVertical },
                    title: `Термин АА · ${periodLabel}`,
                    subtitle: `${stats.totalAa} лидов · по времени слота`,
                  });
                }
          }
        />
        <SummaryTile
          label="Пиковый день"
          value={
            stats.peakDay
              ? `${stats.peakDay.n} (${formatRu(new Date(stats.peakDay.date))})`
              : "—"
          }
          accent="text-cyan-300"
          onClick={
            !stats.peakDay
              ? undefined
              : () => {
                  // Peak-day drill: both legs at the peak date.
                  const peakDate = stats.peakDay!.date;
                  setDrill({
                    url: "/api/dashboard/termins-upcoming/leads",
                    params: {
                      dateFrom: peakDate,
                      dateTo: peakDate,
                      leg: "both",
                      ...drillVertical,
                    },
                    title: `Пиковый день · ${formatRu(new Date(peakDate))}`,
                    subtitle: `${stats.peakDay!.n} слотов (ДЦ + АА) · по времени`,
                  });
                }
          }
        />
      </div>

      <div className="glass-panel rounded-2xl p-4 sm:p-5 border border-white/5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-slate-300 font-semibold tracking-wide text-xs uppercase">
            Запланировано термин — {periodLabel}
          </h3>
          <span className="text-[10px] text-slate-500 hidden sm:inline">
            ось X — дата термина (Берлин); исключены статус «Термин ДЦ отменен»
          </span>
        </div>
        {hasData ? (
          <div className="h-[260px] sm:h-[320px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={data ?? []}
                margin={{ top: 5, right: 10, left: -10, bottom: 0 }}
                stackOffset="sign"
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis
                  dataKey="date"
                  tick={{ fill: "#64748b", fontSize: 11 }}
                  axisLine={{ stroke: "#334155" }}
                  tickLine={false}
                  tickFormatter={(v: string) => {
                    const d = new Date(v);
                    if (Number.isNaN(d.getTime())) return v;
                    return d.toLocaleDateString("ru-RU", {
                      day: "2-digit",
                      month: "2-digit",
                    });
                  }}
                />
                <YAxis
                  tick={{ fill: "#64748b", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  allowDecimals={false}
                />
                <RTooltip
                  content={({ active, payload, label }) => {
                    if (!active || !payload || payload.length === 0 || !label) return null;
                    const r = payload[0]?.payload as UpcomingRow | undefined;
                    if (!r) return null;
                    const d = new Date(label);
                    const dispDate = d.toLocaleDateString("ru-RU", {
                      day: "numeric",
                      month: "long",
                      weekday: "long",
                    });
                    return (
                      <div className="rounded-lg border border-white/10 bg-slate-900/95 px-3 py-2 text-xs shadow-lg">
                        <div className="font-semibold text-slate-200 mb-1">{dispDate}</div>
                        <div className="flex items-center gap-2 text-slate-300">
                          <span className="inline-block h-2 w-2 rounded-full bg-blue-400" />
                          ДЦ: <span className="ml-auto font-medium text-blue-300">{r.dcCount}</span>
                        </div>
                        <div className="flex items-center gap-2 text-slate-300">
                          <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
                          АА: <span className="ml-auto font-medium text-emerald-300">{r.aaCount}</span>
                        </div>
                        <div className="mt-1 border-t border-white/5 pt-1 text-[11px] text-slate-200 font-semibold">
                          Всего: {r.totalCount}
                        </div>
                      </div>
                    );
                  }}
                />
                <Legend
                  wrapperStyle={{ fontSize: 11, color: "#94a3b8" }}
                  iconType="circle"
                />
                <Bar
                  dataKey="dcCount"
                  name="Термин ДЦ"
                  stackId="a"
                  fill="#3b82f6"
                  cursor="pointer"
                  isAnimationActive={false}
                  onClick={(d: unknown) => {
                    const row = d as UpcomingRow | undefined;
                    if (!row || row.dcCount === 0) return;
                    setDrill({
                      url: "/api/dashboard/termins-upcoming/leads",
                      params: { date: row.date, leg: "dc", ...drillVertical },
                      title: `${formatBucketLabel(row.date, "day")} · Термин ДЦ`,
                      subtitle: `${row.dcCount} лидов в этот день — кликни «Сделка #...» чтобы открыть в Kommo`,
                    });
                  }}
                />
                <Bar
                  dataKey="aaCount"
                  name="Термин АА"
                  stackId="a"
                  fill="#10b981"
                  cursor="pointer"
                  isAnimationActive={false}
                  onClick={(d: unknown) => {
                    const row = d as UpcomingRow | undefined;
                    if (!row || row.aaCount === 0) return;
                    setDrill({
                      url: "/api/dashboard/termins-upcoming/leads",
                      params: { date: row.date, leg: "aa", ...drillVertical },
                      title: `${formatBucketLabel(row.date, "day")} · Термин АА`,
                      subtitle: `${row.aaCount} лидов в этот день — кликни «Сделка #...» чтобы открыть в Kommo`,
                    });
                  }}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 text-center text-slate-500">
            <CalendarDays className="w-8 h-8 mb-2 text-slate-600" />
            <p className="text-sm">На выбранный период нет назначенных термин.</p>
          </div>
        )}
      </div>
      {drill && (
        <TerminLeadDrillModal request={drill} onClose={() => setDrill(null)} />
      )}
    </div>
  );
}

// ── Pre-termin (D2) ─────────────────────────────────

interface PreTerminApiRow {
  bucket: "pre_dc" | "post_dc";
  statusId: number;
  statusName: string;
  count: number;
  avgDaysInStatus: number | null;
}

const BUCKET_META: Record<
  PreTerminApiRow["bucket"],
  { label: string; accent: string; barColor: string }
> = {
  pre_dc: {
    label: "До термина ДЦ",
    accent: "text-blue-300",
    barColor: "#3b82f6",
  },
  post_dc: {
    label: "Между ДЦ и Гутшайном",
    accent: "text-emerald-300",
    barColor: "#10b981",
  },
};

function PreTerminSection() {
  const [data, setData] = useState<PreTerminApiRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drill, setDrill] = useState<DrillRequest | null>(null);
  const hasDataRef = useRef(false);

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    if (!hasDataRef.current) setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/dashboard/pre-termin`, { signal });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`API error ${res.status}: ${text}`);
      }
      const json = (await res.json()) as PreTerminApiRow[];
      setData(json);
      hasDataRef.current = true;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      if (e instanceof TypeError && e.message === "Failed to fetch") return;
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    fetchData(ac.signal);
    return () => ac.abort();
  }, [fetchData]);

  if (loading && !data) return <DinoLoader />;
  if (error && !data) {
    return (
      <div className="glass-panel rounded-2xl p-8 border border-red-500/20 text-center">
        <AlertTriangle className="w-10 h-10 text-red-400 mx-auto mb-3" />
        <p className="text-red-400 text-sm">{error}</p>
      </div>
    );
  }

  const isRefreshing = loading && !!data;
  const hasData = !!data && data.some((r) => r.count > 0);

  // API ordering IS the funnel timeline (pre_dc statuses first, then post_dc;
  // within each bucket, statuses are ordered by their funnel position with
  // "перенесён" placed next to its consultation pair). We preserve API order
  // here so changes in pre-termin/route.ts STATUS_BUCKETS propagate directly.
  const sortedRows = (data ?? []).filter((r) => r.count > 0);

  return (
    <div className="flex flex-col gap-4">
      {isRefreshing && (
        <div className="flex items-center justify-center">
          <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-cyan-500/10 border border-cyan-500/20">
            <Loader2 className="w-3 h-3 animate-spin text-cyan-400" />
            <span className="text-[10px] text-cyan-400 font-medium">
              Обновление данных...
            </span>
          </div>
        </div>
      )}

      <div className="glass-panel rounded-2xl p-4 sm:p-5 border border-white/5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-slate-300 font-semibold tracking-wide text-xs uppercase">
            Распределение по статусам
          </h3>
          <div className="flex items-center gap-3">
            <span className="text-[10px] text-slate-500 hidden sm:inline">
              avg-дней — среднее время с последнего перехода
            </span>
            <button
              type="button"
              onClick={() => fetchData()}
              disabled={loading}
              className="p-1.5 rounded-lg hover:bg-white/5 text-slate-400 hover:text-white transition-colors disabled:opacity-50"
              title="Обновить"
              aria-label="Обновить"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>
        {hasData ? (
          <div className="h-[400px] sm:h-[440px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={sortedRows}
                layout="vertical"
                margin={{ top: 5, right: 320, left: 0, bottom: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="#1e293b"
                  horizontal={false}
                />
                <XAxis
                  type="number"
                  tick={{ fill: "#64748b", fontSize: 11 }}
                  axisLine={{ stroke: "#334155" }}
                  tickLine={false}
                  allowDecimals={false}
                />
                <YAxis
                  dataKey="statusName"
                  type="category"
                  tick={{ fill: "#94a3b8", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  width={280}
                />
                <Bar
                  dataKey="count"
                  radius={[0, 6, 6, 0]}
                  isAnimationActive={false}
                  cursor="pointer"
                  onClick={(d: unknown) => {
                    const row = d as PreTerminApiRow | undefined;
                    if (!row || row.count === 0) return;
                    setDrill({
                      url: "/api/dashboard/pre-termin/leads",
                      params: { statusId: String(row.statusId) },
                      title: row.statusName,
                      subtitle: `${row.count} лидов · отсортировано по самым «застрявшим» (выше — дольше в статусе)`,
                    });
                  }}
                >
                  {sortedRows.map((r) => (
                    <Cell key={r.statusId} fill={BUCKET_META[r.bucket].barColor} />
                  ))}
                  <LabelList
                    dataKey="count"
                    position="right"
                    content={(props) => {
                      const {
                        x = 0,
                        y = 0,
                        width = 0,
                        height = 0,
                        index,
                      } = props as {
                        x?: number;
                        y?: number;
                        width?: number;
                        height?: number;
                        index?: number;
                      };
                      const row =
                        index != null ? sortedRows[index] : undefined;
                      if (!row) return null;
                      const days =
                        row.avgDaysInStatus == null
                          ? "—"
                          : `${row.avgDaysInStatus.toFixed(1)} дн`;
                      return (
                        <text
                          x={Number(x) + Number(width) + 8}
                          y={Number(y) + Number(height) / 2 + 4}
                          fill="#e2e8f0"
                          fontSize={11}
                          fontWeight={600}
                        >
                          В статусе: {row.count}
                          <tspan fill="#94a3b8" fontWeight={400}>
                            {" "}
                            · ср. время с последнего перехода: {days}
                          </tspan>
                        </text>
                      );
                    }}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 text-center text-slate-500">
            <CalendarDays className="w-8 h-8 mb-2 text-slate-600" />
            <p className="text-sm">Нет лидов в pre-termin статусах.</p>
          </div>
        )}
      </div>
      {drill && (
        <TerminLeadDrillModal request={drill} onClose={() => setDrill(null)} />
      )}
    </div>
  );
}

// ── Shared tile ─────────────────────────────────────

function SummaryTile({
  label,
  value,
  accent,
  sublabel,
  onClick,
}: {
  label: string;
  value: string;
  accent: string;
  sublabel?: string;
  /** When provided, the tile becomes a button with hover/focus styling. */
  onClick?: () => void;
}) {
  const baseCls = "glass-panel rounded-2xl border border-white/5 p-4";
  const interactiveCls =
    "cursor-pointer transition-colors hover:border-white/20 hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/50";

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`${baseCls} ${interactiveCls} text-left w-full`}
      >
        <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1 flex items-center gap-1">
          <span>{label}</span>
          <span className="text-slate-600 group-hover:text-slate-400">›</span>
        </div>
        <div className={`text-xl font-semibold ${accent}`}>{value}</div>
        {sublabel && (
          <div className="text-[10px] text-slate-500 mt-1">{sublabel}</div>
        )}
      </button>
    );
  }

  return (
    <div className={baseCls}>
      <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">
        {label}
      </div>
      <div className={`text-xl font-semibold ${accent}`}>{value}</div>
      {sublabel && (
        <div className="text-[10px] text-slate-500 mt-1">{sublabel}</div>
      )}
    </div>
  );
}
