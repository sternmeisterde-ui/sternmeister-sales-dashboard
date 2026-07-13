"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Briefcase, ChevronDown, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import CalendarPicker, { type DateRange } from "@/components/CalendarPicker";
import DinoLoader from "@/components/DinoLoader";
import DrillModal from "@/components/DrillModal";
import { fmtLocalDate, todayBerlinDate } from "@/lib/utils/date";
import { kommoLeadUrl } from "@/components/TerminLeadDrillModal";
import type { DocflowUsageBucket } from "@/lib/docflow/stats";

// Форма ответа /api/docflow (зеркалит src/lib/docflow/stats.ts).
interface DayPoint {
  day: string;
  sent: number;
  replied: number;
}
interface ApplicationRow {
  sentAt: string;
  day: string;
  status: string;
  company: string | null;
  position: string | null;
  leadId: number | null;
  leadName: string | null;
}
interface UsageBuckets {
  unused: number;
  one: number;
  many: number;
}
// Тип бакета импортируем из бэка (не keyof UsageBuckets) — так переименование/
// добавление бакета в stats.ts валит компиляцию здесь же (Record<UsageBucketKey,...>
// ниже перестанет собираться), а не расходится молча (#simplification review).
type UsageBucketKey = DocflowUsageBucket;
interface ClientUsageRow {
  leadId: number | null;
  leadName: string | null;
  sentCount: number;
  done: boolean;
  terminDate: string | null;
  bucket: UsageBucketKey;
}
interface FunnelRow {
  leadId: number;
  leadName: string | null;
  filledAnketa: boolean;
  responded: boolean;
}
interface Funnel {
  label: string;
  acceptedFromFirst: number;
  filledAnketa: number;
  responded: number;
  cohort: FunnelRow[];
}
interface DocflowStats {
  available: boolean;
  clients: { total: number; inProgress: number; done: number };
  usage: UsageBuckets;
  clientsList: ClientUsageRow[];
  applications: { sent: number; replied: number; responseRate: number | null };
  days: DayPoint[];
  applicationsList: ApplicationRow[];
  applicationsTruncated: boolean;
  funnels: Funnel[];
}

/** Drill-модалка по клиентам, параметризована заголовком + предикатом (bucket/статус/всё). */
interface ClientsModalSelection {
  title: string;
  predicate: (c: ClientUsageRow) => boolean;
}
/** Drill-модалка по откликам, параметризована заголовком + предикатом (день/статус/всё). */
interface AppsModalSelection {
  title: string;
  predicate: (a: ApplicationRow) => boolean;
  /** Настоящее кол-во по этому срезу (из агрегатов, не из усечённого списка) — для предупреждения о cap. */
  expectedCount?: number;
}
/** Drill-модалка по ступени воронки — уже отфильтрованные строки конкретной воронки. */
interface FunnelModalSelection {
  title: string;
  rows: FunnelRow[];
}

const USAGE_COLORS: Record<UsageBucketKey, string> = {
  unused: "#64748b",
  one: "#60a5fa",
  many: "#34d399",
};
const USAGE_LABELS: Record<UsageBucketKey, string> = {
  unused: "Не использовали",
  one: "1 отклик",
  many: ">1 отклика",
};

const STATUS_LABEL: Record<string, string> = {
  sent: "Отправлено",
  replied: "Получили ответ",
  no_reply: "Без ответа",
  draft: "Черновик",
};

/** Общий стиль тултипов Recharts — без explicit color текст рендерится
 *  почти чёрным и теряется на тёмном фоне (см. HoverTip.tsx — эталон подписей). */
const TOOLTIP_CONTENT_STYLE = {
  background: "#0f172a",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 8,
  fontSize: 12,
  color: "#e2e8f0",
};
const TOOLTIP_ITEM_STYLE = { color: "#e2e8f0" };
const TOOLTIP_LABEL_STYLE = { color: "#94a3b8" };

/** Последние 30 дней — сервис молодой, но диапазон можно расширить фильтром. */
function defaultRange(): DateRange {
  const end = todayBerlinDate();
  const start = new Date(end.getTime() - 29 * 86_400_000);
  return { start, end };
}

/** "YYYY-MM-DD" → "DD.MM" без таймзонных сюрпризов (чистая строка). */
function fmtDay(day: string): string {
  return `${day.slice(8, 10)}.${day.slice(5, 7)}`;
}

/** "YYYY-MM-DD" → "DD.MM.YYYY" (чистая строка, без Date/TZ). */
function fmtTerminDate(day: string | null): string {
  if (!day) return "—";
  return `${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(0, 4)}`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Berlin",
  });
}

function UsageDonut({
  usage,
  onSegmentClick,
}: {
  usage: UsageBuckets;
  onSegmentClick: (bucket: UsageBucketKey) => void;
}) {
  const total = usage.unused + usage.one + usage.many;
  const data = (Object.keys(USAGE_LABELS) as UsageBucketKey[]).map((key) => ({
    key,
    label: USAGE_LABELS[key],
    value: usage[key],
  }));

  return (
    <div>
      <ResponsiveContainer width="100%" height={160}>
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="label"
            innerRadius={45}
            outerRadius={70}
            paddingAngle={total > 0 ? 2 : 0}
            strokeWidth={0}
            cursor="pointer"
            onClick={(_entry, index) => {
              // Индексируем в НАШ типизированный `data`, а не полагаемся на форму
              // объекта, который отдаёт recharts в onClick (может измениться
              // между версиями — #simplification review).
              const item = data[index];
              if (item) onSegmentClick(item.key);
            }}
          >
            {data.map((d) => (
              <Cell key={d.key} fill={USAGE_COLORS[d.key]} />
            ))}
          </Pie>
          <RTooltip
            contentStyle={TOOLTIP_CONTENT_STYLE}
            itemStyle={TOOLTIP_ITEM_STYLE}
            labelStyle={TOOLTIP_LABEL_STYLE}
            formatter={(value, _name, entry) => [
              String(value),
              (entry?.payload as { label?: string } | undefined)?.label ?? "",
            ]}
          />
        </PieChart>
      </ResponsiveContainer>
      <div className="mt-2 flex flex-col gap-1.5">
        {data.map((d) => (
          <button
            key={d.key}
            type="button"
            onClick={() => onSegmentClick(d.key)}
            className="flex items-center gap-2 rounded px-1 py-0.5 text-left text-xs -mx-1 hover:bg-white/5"
          >
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: USAGE_COLORS[d.key] }}
            />
            <span className="text-slate-400">{d.label}</span>
            <span className="ml-auto font-medium text-slate-200">{d.value}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function MiniStat({
  label,
  value,
  accent = "text-slate-200",
  title,
  onClick,
}: {
  label: string;
  value: string;
  accent?: string;
  title?: string;
  onClick?: () => void;
}) {
  const clickable = !!onClick;
  return (
    <div
      title={title}
      onClick={clickable ? onClick : undefined}
      className={
        clickable
          ? "-m-1 rounded-md p-1 cursor-pointer transition-colors hover:bg-white/5"
          : undefined
      }
    >
      <div className={`text-xl font-semibold leading-tight ${accent}`}>{value}</div>
      <div className="mt-0.5 text-[11px] text-slate-400">{label}</div>
    </div>
  );
}

function ClientsListModal({
  title,
  rows,
  onClose,
}: {
  title: string;
  rows: ClientUsageRow[];
  onClose: () => void;
}) {
  return (
    <DrillModal
      onClose={onClose}
      header={
        <>
          <div className="text-sm font-semibold text-white">{title}</div>
          <div className="mt-0.5 text-[11px] text-slate-400">{rows.length} чел.</div>
        </>
      }
    >
      {rows.length === 0 ? (
        <div className="py-12 text-center text-sm text-slate-500">Список пуст.</div>
      ) : (
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10">
            <tr className="border-b border-white/10 bg-slate-900 text-left text-xs text-slate-400">
              <th className="px-3 py-2 font-medium">Лид</th>
              <th className="px-3 py-2 font-medium">Отправлено</th>
              <th className="px-3 py-2 font-medium">Термин</th>
              <th className="px-3 py-2 font-medium">Статус</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={`${r.leadId ?? "?"}-${i}`}
                className="border-b border-white/5 text-slate-200 last:border-0 hover:bg-white/5"
              >
                <td className="px-3 py-1.5">
                  {r.leadId ? (
                    <a
                      href={kommoLeadUrl(r.leadId)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-cyan-300 hover:text-cyan-200 hover:underline"
                    >
                      {r.leadName ?? "Открыть сделку"}
                      <ExternalLink className="h-3 w-3 opacity-70" />
                    </a>
                  ) : (
                    <span className="text-slate-500">—</span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-xs text-slate-400">{r.sentCount}</td>
                <td className="whitespace-nowrap px-3 py-1.5 text-xs text-slate-400">
                  {fmtTerminDate(r.terminDate)}
                </td>
                <td className="px-3 py-1.5 text-xs text-slate-400">
                  {r.done ? "Завершил" : "В работе"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </DrillModal>
  );
}

function ApplicationsListModal({
  title,
  rows,
  truncated,
  expectedCount,
  onClose,
}: {
  title: string;
  rows: ApplicationRow[];
  truncated: boolean;
  /** Настоящее кол-во строк за фильтр (из stats.days/stats.applications) —
   *  applicationsList capped на APPLICATIONS_CAP последних по всему периоду,
   *  так что для старых дней/подмножеств при truncated список может быть
   *  меньше expectedCount или вовсе пуст, даже если график показывает >0. */
  expectedCount?: number;
  onClose: () => void;
}) {
  const possiblyIncomplete =
    truncated && expectedCount != null && rows.length < expectedCount;
  return (
    <DrillModal
      onClose={onClose}
      header={
        <>
          <div className="text-sm font-semibold text-white">{title}</div>
          <div className="mt-0.5 text-[11px] text-slate-400">
            {rows.length} шт.
            {possiblyIncomplete && (
              <span className="text-amber-300/80">
                {" "}
                из {expectedCount} · список периода усечён (2000 последних) — часть могла не попасть
              </span>
            )}
          </div>
        </>
      }
    >
      {rows.length === 0 ? (
        <div className="py-12 text-center text-sm text-slate-500">
          {possiblyIncomplete ? (
            <>
              Записи есть ({expectedCount}), но не попали в усечённый список последних 2000
              откликов периода.
              <div className="mt-1 text-xs text-slate-600">Сузьте период фильтра, чтобы их увидеть.</div>
            </>
          ) : (
            "Список пуст."
          )}
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10">
            <tr className="border-b border-white/10 bg-slate-900 text-left text-xs text-slate-400">
              <th className="px-3 py-2 font-medium">Лид</th>
              <th className="px-3 py-2 font-medium">Компания</th>
              <th className="px-3 py-2 font-medium">Позиция</th>
              <th className="px-3 py-2 font-medium">Статус</th>
              <th className="px-3 py-2 font-medium">Время</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={`${r.leadId ?? "?"}-${r.sentAt}-${i}`}
                className="border-b border-white/5 text-slate-200 last:border-0 hover:bg-white/5"
              >
                <td className="px-3 py-1.5">
                  {r.leadId ? (
                    <a
                      href={kommoLeadUrl(r.leadId)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-cyan-300 hover:text-cyan-200 hover:underline"
                    >
                      {r.leadName ?? "Открыть сделку"}
                      <ExternalLink className="h-3 w-3 opacity-70" />
                    </a>
                  ) : (
                    <span className="text-slate-500">—</span>
                  )}
                </td>
                <td className="px-3 py-1.5">{r.company ?? "—"}</td>
                <td className="px-3 py-1.5">{r.position ?? "—"}</td>
                <td className="px-3 py-1.5 text-xs text-slate-400">
                  {STATUS_LABEL[r.status] ?? r.status}
                </td>
                <td className="whitespace-nowrap px-3 py-1.5 text-xs text-slate-400">
                  {fmtTime(r.sentAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </DrillModal>
  );
}

/**
 * Воронка сервиса в виде убывающих полос (аналогично «Объединённой воронке» во
 * вкладке Воронка): ширина бара ∝ количеству от первой ступени, между
 * ступенями — % перехода. Каждая ступень кликабельна → drill по когорте.
 */
function FunnelPanel({
  funnel,
  onStepClick,
}: {
  funnel: Funnel;
  onStepClick: (sel: FunnelModalSelection) => void;
}) {
  const steps: Array<{
    key: string;
    label: string;
    count: number;
    hint: string;
    predicate: (r: FunnelRow) => boolean;
  }> = [
    {
      key: "accepted",
      label: "Принято от 1-й линии",
      count: funnel.acceptedFromFirst,
      hint: "Лиды, переданные на 2-ю линию (первое попадание в пайплайн Бератер) за период",
      predicate: () => true,
    },
    {
      key: "anketa",
      label: "Заполнили анкету",
      count: funnel.filledAnketa,
      hint: "Из них завели анкету в BGS DocFlow (= зарегались в сервисе)",
      predicate: (r) => r.filledAnketa,
    },
    {
      key: "responded",
      label: "Откликнулись",
      count: funnel.responded,
      hint: "Из заполнивших анкету — хотя бы один отправленный отклик",
      predicate: (r) => r.responded,
    },
  ];
  const max = steps[0].count;

  return (
    <div className="flex flex-col rounded-lg border border-white/10 bg-slate-900/40 p-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h3 className="text-xs uppercase tracking-wider text-slate-500">
          Воронка сервиса · {funnel.label}
        </h3>
        <span className="text-[11px] text-blue-300/80 whitespace-nowrap">
          за период · нажмите на ступень
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        {steps.map((s, i) => {
          const widthPct = max > 0 ? Math.max(2, (s.count / max) * 100) : 0;
          const prev = i > 0 ? steps[i - 1].count : null;
          const transitionPct =
            prev != null && prev > 0 ? Math.round((s.count / prev) * 100) : null;
          return (
            <div key={s.key} className="flex flex-col gap-1.5">
              <button
                type="button"
                title={s.hint}
                onClick={() =>
                  onStepClick({
                    title: `${s.label} · ${funnel.label}`,
                    rows: funnel.cohort.filter(s.predicate),
                  })
                }
                className="group flex flex-col gap-1 text-left"
              >
                <span className="text-[11px] text-slate-300">{s.label}</span>
                <div className="relative h-7 overflow-hidden rounded-md bg-slate-800/40 transition-colors group-hover:bg-slate-800/70">
                  <div
                    className="absolute inset-y-0 left-0 rounded-md bg-gradient-to-r from-blue-500/60 to-cyan-500/45 transition-[width] duration-500"
                    style={{ width: `${widthPct}%` }}
                  />
                  <div className="absolute inset-0 flex items-center px-2">
                    <span className="text-xs font-bold tabular-nums text-white">
                      {s.count}
                    </span>
                  </div>
                </div>
              </button>
              {transitionPct != null && (
                <div className="flex items-center gap-1.5 pl-2 text-[10px] leading-none text-slate-500">
                  <ChevronDown className="h-2.5 w-2.5 shrink-0" />
                  <span className="font-semibold tabular-nums text-slate-400">
                    {transitionPct}%
                  </span>
                  <span className="text-slate-600">от предыдущего</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FunnelListModal({
  title,
  rows,
  onClose,
}: {
  title: string;
  rows: FunnelRow[];
  onClose: () => void;
}) {
  return (
    <DrillModal
      onClose={onClose}
      header={
        <>
          <div className="text-sm font-semibold text-white">{title}</div>
          <div className="mt-0.5 text-[11px] text-slate-400">{rows.length} чел.</div>
        </>
      }
    >
      {rows.length === 0 ? (
        <div className="py-12 text-center text-sm text-slate-500">Список пуст.</div>
      ) : (
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10">
            <tr className="border-b border-white/10 bg-slate-900 text-left text-xs text-slate-400">
              <th className="px-3 py-2 font-medium">Лид</th>
              <th className="px-3 py-2 font-medium">Анкета</th>
              <th className="px-3 py-2 font-medium">Отклик</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={`${r.leadId}-${i}`}
                className="border-b border-white/5 text-slate-200 last:border-0 hover:bg-white/5"
              >
                <td className="px-3 py-1.5">
                  <a
                    href={kommoLeadUrl(r.leadId)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-cyan-300 hover:text-cyan-200 hover:underline"
                  >
                    {r.leadName ?? "Открыть сделку"}
                    <ExternalLink className="h-3 w-3 opacity-70" />
                  </a>
                </td>
                <td className="px-3 py-1.5 text-xs text-slate-400">
                  {r.filledAnketa ? "✓" : "—"}
                </td>
                <td className="px-3 py-1.5 text-xs text-slate-400">
                  {r.responded ? "✓" : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </DrillModal>
  );
}

export default function DocflowTab({
  vertical,
}: {
  department: "b2g" | "b2b";
  /** Вертикаль b2g (Бух/Мед/Все) из общего тоггла в шапке. */
  vertical?: "buh" | "med" | "all";
}) {
  const [stats, setStats] = useState<DocflowStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<DateRange>(defaultRange);
  const [clientsModal, setClientsModal] = useState<ClientsModalSelection | null>(null);
  const [appsModal, setAppsModal] = useState<AppsModalSelection | null>(null);
  const [funnelModal, setFunnelModal] = useState<FunnelModalSelection | null>(null);

  const load = useCallback(async (r: DateRange) => {
    const start = r.start ?? todayBerlinDate();
    const end = r.end ?? start;
    setLoading(true);
    setError(null);
    setClientsModal(null);
    setAppsModal(null);
    setFunnelModal(null);
    try {
      const params = new URLSearchParams({
        from: fmtLocalDate(start),
        to: fmtLocalDate(end),
      });
      if (vertical) params.set("vertical", vertical);
      const res = await fetch(`/api/docflow?${params}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStats((await res.json()) as DocflowStats);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [vertical]);

  // Первичная загрузка + перезагрузка при смене вертикали (тоггл в шапке).
  useEffect(() => {
    load(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vertical]);

  const onRangeChange = (r: DateRange) => {
    setRange(r);
    if (r.start && r.end) load(r);
  };

  const clientsModalRows = useMemo(() => {
    if (!clientsModal || !stats) return [];
    return stats.clientsList.filter(clientsModal.predicate);
  }, [clientsModal, stats]);

  const appsModalRows = useMemo(() => {
    if (!appsModal || !stats) return [];
    return stats.applicationsList.filter(appsModal.predicate);
  }, [appsModal, stats]);

  // Воронки под выбранную вертикаль уже отфильтрованы бэкендом (buh→бух,
  // med→мед, all→обе отдельными блоками). Показываем как есть.
  const visibleFunnels = stats?.funnels ?? [];

  if (loading && !stats) {
    return (
      <div className="flex items-center justify-center py-24">
        <DinoLoader />
      </div>
    );
  }

  const unavailable = !stats || !stats.available;

  return (
    <div className="flex flex-col gap-6 fade-in">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 text-slate-200">
          <Briefcase className="w-5 h-5 text-blue-400" />
          <span className="text-base font-semibold">BGS DocFlow</span>
        </div>

        <CalendarPicker
          mode="range"
          value={range}
          onChange={onRangeChange}
          onClear={() => onRangeChange(defaultRange())}
          maxDate={todayBerlinDate()}
        />

        <button
          onClick={() => load(range)}
          disabled={loading}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-slate-900/60 px-3 py-1.5 text-xs text-slate-300 hover:border-white/20 disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RefreshCw className="w-3.5 h-3.5" />
          )}
          Обновить
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          Не удалось загрузить статистику: {error}
        </div>
      )}

      {unavailable && !error && (
        <div className="rounded-lg border border-white/10 bg-slate-900/60 px-4 py-8 text-center text-sm text-slate-400">
          Данные недоступны.
          <div className="mt-1 text-xs text-slate-500">
            Подключение к БД BGS DocFlow не настроено или сервис недоступен.
          </div>
        </div>
      )}

      {stats && !unavailable && (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-lg border border-white/10 bg-slate-900/40 p-4">
              <h3 className="mb-3 text-xs uppercase tracking-wider text-slate-500">
                Клиенты (всё время)
              </h3>
              <div className="grid grid-cols-3 gap-2">
                <MiniStat
                  label="Всего"
                  value={String(stats.clients.total)}
                  accent="text-blue-300"
                  onClick={() => setClientsModal({ title: "Все клиенты", predicate: () => true })}
                />
                <MiniStat
                  label="В работе"
                  value={String(stats.clients.inProgress)}
                  accent="text-emerald-300"
                  title="Термин ещё не наступил, не привязан или не найден в аналитике"
                  onClick={() =>
                    setClientsModal({ title: "В работе", predicate: (c) => !c.done })
                  }
                />
                <MiniStat
                  label="Завершили"
                  value={String(stats.clients.done)}
                  accent="text-amber-300"
                  title="Термин сделки в Kommo (АА, иначе ДЦ) уже прошёл"
                  onClick={() =>
                    setClientsModal({ title: "Завершили", predicate: (c) => c.done })
                  }
                />
              </div>
            </div>

            <div className="rounded-lg border border-white/10 bg-slate-900/40 p-4">
              <h3 className="mb-3 text-xs uppercase tracking-wider text-slate-500">
                Отклики за период
              </h3>
              <div className="grid grid-cols-3 gap-2">
                <MiniStat
                  label="Отправлено"
                  value={String(stats.applications.sent)}
                  accent="text-blue-300"
                  onClick={() =>
                    setAppsModal({
                      title: "Отправлено за период",
                      predicate: () => true,
                      expectedCount: stats.applications.sent,
                    })
                  }
                />
                <MiniStat
                  label="Получили ответ"
                  value={String(stats.applications.replied)}
                  accent="text-emerald-300"
                  onClick={() =>
                    setAppsModal({
                      title: "Получили ответ за период",
                      predicate: (a) => a.status === "replied",
                      expectedCount: stats.applications.replied,
                    })
                  }
                />
                <MiniStat
                  label="% ответов"
                  value={
                    stats.applications.responseRate != null
                      ? `${Math.round(stats.applications.responseRate * 100)}%`
                      : "—"
                  }
                  accent="text-amber-300"
                />
              </div>
            </div>
          </div>

          <div
            className={`grid items-stretch gap-4 ${
              visibleFunnels.length > 0
                ? "lg:grid-cols-[minmax(260px,1fr)_280px_minmax(0,1.4fr)]"
                : "lg:grid-cols-[280px_1fr]"
            }`}
          >
            {visibleFunnels.length > 0 && (
              <div className="flex flex-col gap-4">
                {visibleFunnels.map((f) => (
                  <FunnelPanel key={f.label} funnel={f} onStepClick={setFunnelModal} />
                ))}
              </div>
            )}

            <div className="flex flex-col rounded-lg border border-white/10 bg-slate-900/40 p-4">
              <div className="mb-3">
                <h3 className="text-xs uppercase tracking-wider text-slate-500">
                  Использование (всё время)
                </h3>
                <span className="text-[11px] text-blue-300/80">нажмите на сегмент</span>
              </div>
              <div className="flex flex-1 flex-col justify-center">
                <UsageDonut usage={stats.usage} onSegmentClick={(bucket) =>
                  setClientsModal({ title: USAGE_LABELS[bucket], predicate: (c) => c.bucket === bucket })
                } />
              </div>
            </div>

            <div className="flex flex-col rounded-lg border border-white/10 bg-slate-900/40 p-4">
              <div className="mb-3 flex items-baseline justify-between gap-2">
                <h3 className="text-xs uppercase tracking-wider text-slate-500 whitespace-nowrap">
                  Отклики по дням
                </h3>
                <span className="text-[11px] text-blue-300/80 whitespace-nowrap">
                  нажмите на день, чтобы увидеть список
                </span>
              </div>
              <div className="min-h-0 flex-1" style={{ cursor: "pointer" }}>
                <ResponsiveContainer width="100%" height="100%" minHeight={220}>
                  <LineChart
                    data={stats.days}
                    margin={{ top: 8, right: 12, bottom: 0, left: -24 }}
                    onClick={(state) => {
                      const lbl = (state as { activeLabel?: string | number } | null)?.activeLabel;
                      if (lbl == null) return;
                      const day = String(lbl);
                      const dayPoint = stats.days.find((d) => d.day === day);
                      setAppsModal({
                        title: `Отклики — ${fmtDay(day)}`,
                        predicate: (a) => a.day === day,
                        expectedCount: dayPoint?.sent,
                      });
                    }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis
                      dataKey="day"
                      tickFormatter={fmtDay}
                      tick={{ fill: "#94a3b8", fontSize: 11 }}
                      axisLine={{ stroke: "rgba(255,255,255,0.1)" }}
                      tickLine={false}
                      minTickGap={24}
                    />
                    <YAxis
                      tick={{ fill: "#94a3b8", fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                      allowDecimals={false}
                    />
                    <RTooltip
                      cursor={{ stroke: "rgba(255,255,255,0.15)" }}
                      contentStyle={TOOLTIP_CONTENT_STYLE}
                      itemStyle={TOOLTIP_ITEM_STYLE}
                      labelStyle={TOOLTIP_LABEL_STYLE}
                      labelFormatter={(v) => fmtDay(String(v))}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line
                      type="monotone"
                      dataKey="sent"
                      name="Отправлено"
                      stroke="#60a5fa"
                      strokeWidth={2}
                      dot={{ r: 2.5, fill: "#60a5fa" }}
                      activeDot={{ r: 4 }}
                    />
                    <Line
                      type="monotone"
                      dataKey="replied"
                      name="Получили ответ"
                      stroke="#34d399"
                      strokeWidth={2}
                      dot={{ r: 2.5, fill: "#34d399" }}
                      activeDot={{ r: 4 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </>
      )}

      {appsModal && (
        <ApplicationsListModal
          title={appsModal.title}
          rows={appsModalRows}
          truncated={stats?.applicationsTruncated ?? false}
          expectedCount={appsModal.expectedCount}
          onClose={() => setAppsModal(null)}
        />
      )}

      {clientsModal && (
        <ClientsListModal
          title={clientsModal.title}
          rows={clientsModalRows}
          onClose={() => setClientsModal(null)}
        />
      )}

      {funnelModal && (
        <FunnelListModal
          title={funnelModal.title}
          rows={funnelModal.rows}
          onClose={() => setFunnelModal(null)}
        />
      )}
    </div>
  );
}
