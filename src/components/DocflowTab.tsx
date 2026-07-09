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
import { Briefcase, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import CalendarPicker, { type DateRange } from "@/components/CalendarPicker";
import DinoLoader from "@/components/DinoLoader";
import DrillModal from "@/components/DrillModal";
import { fmtLocalDate, todayBerlinDate } from "@/lib/utils/date";
import { kommoLeadUrl } from "@/components/TerminLeadDrillModal";

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
type UsageBucketKey = keyof UsageBuckets;
interface ClientUsageRow {
  leadId: number | null;
  leadName: string | null;
  sentCount: number;
  done: boolean;
  bucket: UsageBucketKey;
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
            onClick={(entry) => {
              const key = (entry as { key?: UsageBucketKey } | undefined)?.key;
              if (key) onSegmentClick(key);
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
  onClose,
}: {
  title: string;
  rows: ApplicationRow[];
  truncated: boolean;
  onClose: () => void;
}) {
  return (
    <DrillModal
      onClose={onClose}
      header={
        <>
          <div className="text-sm font-semibold text-white">{title}</div>
          <div className="mt-0.5 text-[11px] text-slate-400">
            {rows.length} шт.{truncated ? " · список периода усечён (2000)" : ""}
          </div>
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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export default function DocflowTab({ department: _department }: { department: "b2g" | "b2b" }) {
  const [stats, setStats] = useState<DocflowStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<DateRange>(defaultRange);
  const [clientsModal, setClientsModal] = useState<ClientsModalSelection | null>(null);
  const [appsModal, setAppsModal] = useState<AppsModalSelection | null>(null);

  const load = useCallback(async (r: DateRange) => {
    const start = r.start ?? todayBerlinDate();
    const end = r.end ?? start;
    setLoading(true);
    setError(null);
    setClientsModal(null);
    setAppsModal(null);
    try {
      const params = new URLSearchParams({
        from: fmtLocalDate(start),
        to: fmtLocalDate(end),
      });
      const res = await fetch(`/api/docflow?${params}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStats((await res.json()) as DocflowStats);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
                    setAppsModal({ title: "Отправлено за период", predicate: () => true })
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

          <div className="grid items-stretch gap-4 lg:grid-cols-[280px_1fr]">
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
                      setAppsModal({
                        title: `Отклики — ${fmtDay(day)}`,
                        predicate: (a) => a.day === day,
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
    </div>
  );
}
