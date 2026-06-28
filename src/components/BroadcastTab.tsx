"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Link2,
  Loader2,
  Megaphone,
  RefreshCw,
} from "lucide-react";
import CalendarPicker, { type DateRange } from "@/components/CalendarPicker";
import DinoLoader from "@/components/DinoLoader";
import DrillModal from "@/components/DrillModal";
import { fmtLocalDate, todayBerlinDate } from "@/lib/utils/date";
import { getMessageContent, campaignLabel } from "@/lib/broadcast/campaign-content";
import { kommoLeadUrl } from "@/components/TerminLeadDrillModal";

// Форма ответа /api/broadcast (зеркалит src/lib/broadcast/stats.ts).
interface StageRow {
  messageId: string;
  sent: number;
  rpClick: number;
  rpDone: number;
  link: number;
}
interface DailyPoint {
  day: string;
  sent: number;
}
interface Recipient {
  sentAt: string;
  messageId: string;
  telegramUsername: string | null;
  leadId: number | null;
  leadName: string | null;
}
interface SubscriptionSummary {
  active: number;
  completed: number;
  excluded: number;
  suppressed: number;
  total: number;
}
interface Subscriber {
  status: string;
  suppressed: boolean;
  telegramUsername: string | null;
  leadId: number | null;
  leadName: string | null;
  anchorAt: string | null;
  terminDate: string | null;
}
interface DeliveryHealth {
  pending: number;
  sent: number;
  skipped: number;
  failed: number;
  total: number;
}
interface CampaignOption {
  campaignId: string;
  deliveries: number;
}
interface BroadcastStats {
  available: boolean;
  campaignId: string | null;
  campaigns: CampaignOption[];
  range: { from: string; to: string } | null;
  stages: StageRow[];
  daily: DailyPoint[];
  recipients: Recipient[];
  recipientsTruncated: boolean;
  subscriptions: SubscriptionSummary;
  subscribers: Subscriber[];
  delivery: DeliveryHealth;
}

type SubKind = "active" | "completed" | "suppressed";
const SUB_KIND_LABEL: Record<SubKind, string> = {
  active: "Активные подписки",
  completed: "Завершённые подписки",
  suppressed: "Отписавшиеся",
};

const SLOT_RU: Record<string, string> = {
  morning: "утро",
  late_morning: "позднее утро",
  afternoon: "день",
  evening: "вечер",
};

function pct(part: number, whole: number): string {
  if (!whole) return "—";
  return `${((part / whole) * 100).toFixed(0)}%`;
}

/** «msg_03» → «Сообщение 3» (или сырой id, если без номера). */
function messageNum(messageId: string): string {
  const m = /(\d+)\s*$/.exec(messageId);
  return m ? `Сообщение ${parseInt(m[1], 10)}` : messageId;
}

/** «День N, слот время» из контент-справочника (или null, если копии нет). */
function dayLabelFor(campaignId: string | null, messageId: string): string | null {
  const c = getMessageContent(campaignId, messageId);
  if (!c) return null;
  const slot = c.slot ? `, ${SLOT_RU[c.slot] ?? c.slot}` : "";
  const time = c.slotTime ? ` ${c.slotTime}` : "";
  return `День ${c.dayOffset + 1}${slot}${time}`;
}

function defaultRange(): DateRange {
  const end = todayBerlinDate();
  const start = new Date(end.getTime() - 29 * 86_400_000);
  return { start, end };
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Berlin",
  });
}

/** ISO-инстант → берлинская дата 'YYYY-MM-DD' (совпадает с группировкой графика на бэке). */
function berlinDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString("en-CA", { timeZone: "Europe/Berlin" });
}

function fmtShortDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Europe/Berlin",
  });
}

function fmtDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "short",
    timeZone: "Europe/Berlin",
  });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export default function BroadcastTab({ department: _department }: { department: "b2g" | "b2b" }) {
  const [stats, setStats] = useState<BroadcastStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [campaign, setCampaign] = useState<string | null>(null);
  const [range, setRange] = useState<DateRange>(defaultRange);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [selectedStage, setSelectedStage] = useState<string | null>(null);
  const [selectedSubKind, setSelectedSubKind] = useState<SubKind | null>(null);

  const load = useCallback(
    async (r: DateRange, campaignId?: string | null) => {
      const start = r.start ?? todayBerlinDate();
      const end = r.end ?? start;
      setLoading(true);
      setError(null);
      setSelectedDay(null);
      setSelectedStage(null);
      setSelectedSubKind(null);
      try {
        const params = new URLSearchParams({
          from: fmtLocalDate(start),
          to: fmtLocalDate(end),
        });
        if (campaignId) params.set("campaign", campaignId);
        const res = await fetch(`/api/broadcast?${params}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: BroadcastStats = await res.json();
        setStats(data);
        setCampaign(data.campaignId);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    load(range, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onRangeChange = (r: DateRange) => {
    setRange(r);
    if (r.start && r.end) load(r, campaign);
  };

  const dailyMax = useMemo(
    () => (stats ? Math.max(1, ...stats.daily.map((d) => d.sent)) : 1),
    [stats],
  );

  // Получатели выбранного дня: фильтруем уже загруженный список периода по БЕРЛИНСКОЙ
  // дате sent_at (так же группируются столбцы графика на бэке). Доп. запрос не нужен.
  const recipientsForDay = useMemo(
    () =>
      stats && selectedDay
        ? stats.recipients.filter((r) => berlinDay(r.sentAt) === selectedDay)
        : [],
    [stats, selectedDay],
  );

  // Подписчики выбранной карточки. Фильтр совпадает с логикой подсчёта (stats.ts):
  // active/completed — по status, suppressed — по флагу.
  const subscribersForKind = useMemo(() => {
    if (!stats || !selectedSubKind) return [];
    if (selectedSubKind === "suppressed") return stats.subscribers.filter((s) => s.suppressed);
    return stats.subscribers.filter((s) => s.status === selectedSubKind);
  }, [stats, selectedSubKind]);

  if (loading && !stats) {
    return (
      <div className="flex items-center justify-center py-24">
        <DinoLoader />
      </div>
    );
  }

  // Пусто = БД недоступна / кампаний нет. НЕ привязываемся к stages.length: «Подписки» и
  // «Доставка» — снимки по всей кампании, а stages period-scoped; за тихий период stages
  // пуст, но снимки валидны и должны показываться (#1 ревью).
  const unavailable = !stats || !stats.available;

  return (
    <div className="flex flex-col gap-6 fade-in">
      {/* Заголовок + кампания + период + обновить */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 text-slate-200">
          <Megaphone className="w-5 h-5 text-blue-400" />
          <span className="text-base font-semibold">Рассылка</span>
        </div>

        {stats && stats.campaigns.length > 1 && (
          <div className="relative">
            <select
              value={campaign ?? ""}
              onChange={(e) => load(range, e.target.value)}
              className="appearance-none rounded-lg border border-white/10 bg-slate-900/95 pl-3 pr-8 py-1.5 text-xs text-slate-200 hover:border-white/20 focus:outline-none"
            >
              {stats.campaigns.map((c) => (
                <option key={c.campaignId} value={c.campaignId}>
                  {campaignLabel(c.campaignId)}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
          </div>
        )}
        {stats && stats.campaigns.length === 1 && stats.campaignId && (
          <span className="rounded-lg border border-white/10 bg-slate-900/60 px-3 py-1.5 text-xs text-slate-300">
            {campaignLabel(stats.campaignId)}
          </span>
        )}

        <CalendarPicker
          mode="range"
          value={range}
          onChange={onRangeChange}
          onClear={() => onRangeChange(defaultRange())}
          maxDate={todayBerlinDate()}
        />

        <button
          onClick={() => load(range, campaign)}
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
          Данных рассылки нет.
          <div className="mt-1 text-xs text-slate-500">
            Кампания не запущена, либо база бота недоступна (BERATER_BOT_DATABASE_URL).
          </div>
        </div>
      )}

      {stats && !unavailable && (
        <>
          {/* Сводка: подписки + доставка — компактно, в один ряд */}
          <div className="grid gap-4 lg:grid-cols-2">
            {/* Подписки (карточки кликабельны → список) */}
            <div className="rounded-lg border border-white/10 bg-slate-900/40 p-4">
              <div className="mb-3 flex items-baseline justify-between gap-2">
                <h3 className="text-xs uppercase tracking-wider text-slate-500">Подписки</h3>
                <span className="text-[11px] text-blue-300/80">нажмите, чтобы увидеть список</span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <MiniStat
                  label="Активные"
                  value={stats.subscriptions.active}
                  accent="text-blue-300"
                  onClick={() => setSelectedSubKind("active")}
                />
                <MiniStat
                  label="Завершённые"
                  value={stats.subscriptions.completed}
                  accent="text-emerald-300"
                  onClick={() => setSelectedSubKind("completed")}
                />
                <MiniStat
                  label="Отписались"
                  value={stats.subscriptions.suppressed}
                  accent="text-amber-300"
                  onClick={() => setSelectedSubKind("suppressed")}
                />
              </div>
            </div>

            {/* Доставка */}
            <div className="rounded-lg border border-white/10 bg-slate-900/40 p-4">
              <h3 className="mb-3 text-xs uppercase tracking-wider text-slate-500">Доставка</h3>
              <div className="grid grid-cols-3 gap-2">
                <MiniStat
                  label="Отправлено"
                  value={stats.delivery.sent}
                  accent="text-emerald-300"
                />
                <MiniStat label="В очереди" value={stats.delivery.pending} accent="text-blue-300" />
                <MiniStat label="Ошибки" value={stats.delivery.failed} accent="text-red-300" />
              </div>
            </div>
          </div>

          {/* Отправки по дням (кликабельный график → получатели дня) */}
          <section>
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <h3 className="text-xs uppercase tracking-wider text-slate-500">
                Отправки по дням (в периоде)
              </h3>
              <span className="text-[11px] text-blue-300/80">
                нажмите на день, чтобы увидеть получателей
              </span>
            </div>
            {stats.daily.length === 0 ? (
              <div className="rounded-lg border border-white/10 bg-slate-900/60 px-4 py-6 text-center text-xs text-slate-500">
                Нет отправок за период.
              </div>
            ) : (
              <div className="rounded-lg border border-white/10 bg-slate-900/40 p-3" style={{ cursor: "pointer" }}>
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart
                    data={stats.daily}
                    margin={{ top: 8, right: 12, bottom: 0, left: -16 }}
                    onClick={(state) => {
                      const lbl = (state as { activeLabel?: string | number } | null)?.activeLabel;
                      if (lbl != null) setSelectedDay(String(lbl));
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
                      allowDecimals={false}
                      domain={[0, dailyMax]}
                      tick={{ fill: "#94a3b8", fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <RTooltip
                      cursor={{ stroke: "rgba(255,255,255,0.15)" }}
                      contentStyle={{
                        background: "#0f172a",
                        border: "1px solid rgba(255,255,255,0.1)",
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                      labelFormatter={(v) => fmtDay(String(v))}
                      formatter={(v) => [v, "Отправлено"]}
                    />
                    <Line
                      type="monotone"
                      dataKey="sent"
                      stroke="#60a5fa"
                      strokeWidth={2}
                      dot={{ r: 2.5, fill: "#60a5fa" }}
                      activeDot={{ r: 4 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </section>

          {/* Этапы рассылки (клик по строке → содержание в модалке) */}
          <section>
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <h3 className="text-xs uppercase tracking-wider text-slate-500">
                Этапы рассылки (в периоде)
              </h3>
              <span className="text-[11px] text-blue-300/80">
                нажмите этап, чтобы увидеть текст сообщения
              </span>
            </div>
            <div className="overflow-x-auto rounded-lg border border-white/10">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 bg-slate-900/60 text-left text-xs text-slate-400">
                    <th className="px-3 py-2 font-medium">Этап / сообщение</th>
                    <th className="px-3 py-2 text-right font-medium">Отправлено</th>
                    <th className="px-3 py-2 text-right font-medium">Клик «ролевка»</th>
                    <th className="px-3 py-2 text-right font-medium">Завершили</th>
                    <th className="px-3 py-2 text-right font-medium">Клик по ссылке</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.stages.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-3 py-6 text-center text-xs text-slate-500">
                        За выбранный период отправок не было.
                      </td>
                    </tr>
                  ) : (
                    stats.stages.map((m) => {
                      const content = getMessageContent(stats.campaignId, m.messageId);
                      return (
                        <StageRow
                          key={m.messageId}
                          m={m}
                          title={content?.title ?? null}
                          dayLabel={dayLabelFor(stats.campaignId, m.messageId)}
                          mediaCount={content?.mediaCount ?? 0}
                          onOpen={() => setSelectedStage(m.messageId)}
                        />
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              Клики — по уникальным пользователям; проценты считаются от отправок (клик) и от
              кликов (завершили). Telegram не отдаёт ботам «прочитано» и просмотры видео.
              Тестовые прогоны (<code>/campaign_test*</code>) в статистику не входят.
            </p>
          </section>

        </>
      )}

      {selectedDay && (
        <DayRecipientsModal
          day={selectedDay}
          campaignId={stats?.campaignId ?? null}
          recipients={recipientsForDay}
          truncated={stats?.recipientsTruncated ?? false}
          onClose={() => setSelectedDay(null)}
        />
      )}

      {selectedStage && stats && (
        <StageContentModal
          campaignId={stats.campaignId}
          stage={stats.stages.find((s) => s.messageId === selectedStage) ?? null}
          messageId={selectedStage}
          onClose={() => setSelectedStage(null)}
        />
      )}

      {selectedSubKind && (
        <SubscribersModal
          kind={selectedSubKind}
          subscribers={subscribersForKind}
          onClose={() => setSelectedSubKind(null)}
        />
      )}
    </div>
  );
}

function SubscribersModal({
  kind,
  subscribers,
  onClose,
}: {
  kind: SubKind;
  subscribers: Subscriber[];
  onClose: () => void;
}) {
  return (
    <DrillModal
      onClose={onClose}
      header={
        <>
          <div className="text-sm font-semibold text-white">{SUB_KIND_LABEL[kind]}</div>
          <div className="mt-0.5 text-[11px] text-slate-400">{subscribers.length} чел.</div>
        </>
      }
    >
      {subscribers.length === 0 ? (
        <div className="py-12 text-center text-sm text-slate-500">Список пуст.</div>
      ) : (
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10">
            <tr className="border-b border-white/10 bg-slate-900 text-left text-xs text-slate-400">
              <th className="px-3 py-2 font-medium">Получатель</th>
              <th className="px-3 py-2 font-medium">Сделка</th>
              <th className="px-3 py-2 font-medium">Авторизация</th>
              <th className="px-3 py-2 font-medium">Термин</th>
            </tr>
          </thead>
          <tbody>
            {subscribers.map((s, i) => (
              <tr
                key={`${s.leadId ?? s.telegramUsername ?? i}-${i}`}
                className="border-b border-white/5 text-slate-200 last:border-0 hover:bg-white/5"
              >
                <td className="px-3 py-1.5">
                  {s.telegramUsername ? (
                    <span className="text-slate-200">@{s.telegramUsername}</span>
                  ) : (
                    <span className="text-slate-500">—</span>
                  )}
                </td>
                <td className="px-3 py-1.5">
                  {s.leadId ? (
                    <a
                      href={kommoLeadUrl(s.leadId)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-cyan-300 hover:text-cyan-200 hover:underline"
                    >
                      {s.leadName ?? "Открыть сделку"}
                      <ExternalLink className="h-3 w-3 opacity-70" />
                    </a>
                  ) : (
                    <span className="text-slate-500">—</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-1.5 text-xs text-slate-400">
                  {fmtShortDate(s.anchorAt)}
                </td>
                <td className="whitespace-nowrap px-3 py-1.5 text-xs text-slate-400">
                  {fmtShortDate(s.terminDate)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </DrillModal>
  );
}

function DayRecipientsModal({
  day,
  campaignId,
  recipients,
  truncated,
  onClose,
}: {
  day: string;
  campaignId: string | null;
  recipients: Recipient[];
  truncated: boolean;
  onClose: () => void;
}) {
  return (
    <DrillModal
      onClose={onClose}
      header={
        <>
          <div className="text-sm font-semibold text-white">Кому отправили — {fmtDay(day)}</div>
          <div className="mt-0.5 text-[11px] text-slate-400">
            {recipients.length} получателей
            {truncated ? " · список периода усечён (2000)" : ""}
          </div>
        </>
      }
    >
      {recipients.length === 0 ? (
        <div className="py-12 text-center text-sm text-slate-500">
          За этот день получателей нет.
        </div>
      ) : (
        <RecipientsTable recipients={recipients} campaignId={campaignId} />
      )}
    </DrillModal>
  );
}

function StageRow({
  m,
  title,
  dayLabel,
  mediaCount,
  onOpen,
}: {
  m: StageRow;
  title: string | null;
  dayLabel: string | null;
  mediaCount: number;
  onOpen: () => void;
}) {
  return (
    <tr
      onClick={onOpen}
      className="cursor-pointer border-b border-white/5 text-slate-200 last:border-0 hover:bg-white/5"
    >
      <td className="px-3 py-2">
        <div className="flex items-center gap-2">
          <ChevronRight className="h-3.5 w-3.5 text-slate-500" />
          <div>
            <div className="text-sm text-slate-200">
              {dayLabel ?? messageNum(m.messageId)}
              {mediaCount > 0 && (
                <span className="ml-2 text-[10px] text-slate-500">📎 {mediaCount}</span>
              )}
            </div>
            {title && <div className="text-[11px] text-slate-500">{title}</div>}
          </div>
        </div>
      </td>
      <td className="px-3 py-2 text-right">{m.sent || "—"}</td>
      <td className="px-3 py-2 text-right">
        {m.rpClick || "—"}
        {m.rpClick > 0 && m.sent > 0 && (
          <span className="ml-1 text-[10px] text-slate-500">{pct(m.rpClick, m.sent)}</span>
        )}
      </td>
      <td className="px-3 py-2 text-right">
        {m.rpDone || "—"}
        {m.rpDone > 0 && m.rpClick > 0 && (
          <span className="ml-1 text-[10px] text-slate-500">{pct(m.rpDone, m.rpClick)}</span>
        )}
      </td>
      <td className="px-3 py-2 text-right">{m.link || "—"}</td>
    </tr>
  );
}

function StageContentModal({
  campaignId,
  stage,
  messageId,
  onClose,
}: {
  campaignId: string | null;
  stage: StageRow | null;
  messageId: string;
  onClose: () => void;
}) {
  const content = getMessageContent(campaignId, messageId);
  const dayLabel = dayLabelFor(campaignId, messageId);

  return (
    <DrillModal
      onClose={onClose}
      maxWidthClass="max-w-2xl"
      header={
        <>
          <div className="text-sm font-semibold text-white">
            {dayLabel ?? messageNum(messageId)}
            {content?.mediaCount ? (
              <span className="ml-2 text-[11px] font-normal text-slate-500">
                📎 {content.mediaCount}
              </span>
            ) : null}
          </div>
          {content?.title && (
            <div className="mt-0.5 text-[11px] text-slate-400">{content.title}</div>
          )}
          {stage && (
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
              <span>отправлено {stage.sent}</span>
              {stage.rpClick > 0 && <span>клик «ролевка» {stage.rpClick}</span>}
              {stage.rpDone > 0 && <span>завершили {stage.rpDone}</span>}
              {stage.link > 0 && <span>клик по ссылке {stage.link}</span>}
            </div>
          )}
        </>
      }
    >
      <div className="px-5 py-4">
        {content?.textHtml ? (
          <div className="space-y-4">
            <div
              className="broadcast-content text-sm leading-relaxed text-slate-300"
              // Доверенный контент кампании (наш HTML, не пользовательский ввод).
              dangerouslySetInnerHTML={{ __html: content.textHtml }}
            />
            {content.buttons.length > 0 && (
              <div className="flex flex-wrap gap-2 border-t border-white/5 pt-3">
                {content.buttons.map((b, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-slate-800/60 px-2.5 py-1 text-xs text-slate-300"
                  >
                    {b.type === "url" && <Link2 className="h-3 w-3 text-blue-400" />}
                    {b.label}
                    {b.type === "roleplay" && b.level && (
                      <span className="text-[10px] text-slate-500">({b.level})</span>
                    )}
                  </span>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="py-8 text-center text-xs text-slate-500">
            Текста этого сообщения нет в локальной копии кампании (возможно, кампания
            обновилась — обнови src/lib/broadcast/campaign-content-*.json).
          </div>
        )}
      </div>
    </DrillModal>
  );
}

function RecipientsTable({
  recipients,
  campaignId,
}: {
  recipients: Recipient[];
  campaignId: string | null;
}) {
  return (
    <table className="w-full text-sm">
        <thead className="sticky top-0 z-10">
          <tr className="border-b border-white/10 bg-slate-900 text-left text-xs text-slate-400">
            <th className="px-3 py-2 font-medium">Когда</th>
            <th className="px-3 py-2 font-medium">Сообщение</th>
            <th className="px-3 py-2 font-medium">Получатель</th>
            <th className="px-3 py-2 font-medium">Сделка</th>
          </tr>
        </thead>
        <tbody>
          {recipients.map((r, i) => {
            const day = dayLabelFor(campaignId, r.messageId);
            return (
              <tr
                key={`${r.sentAt}-${r.messageId}-${i}`}
                className="border-b border-white/5 text-slate-200 last:border-0 hover:bg-white/5"
              >
                <td className="whitespace-nowrap px-3 py-1.5 text-xs text-slate-400">
                  {fmtDateTime(r.sentAt)}
                </td>
                <td className="px-3 py-1.5">
                  <div className="text-xs text-slate-200">{day ?? messageNum(r.messageId)}</div>
                  {day && <div className="text-[10px] text-slate-500">{messageNum(r.messageId)}</div>}
                </td>
                <td className="px-3 py-1.5">
                  {r.telegramUsername ? (
                    <span className="text-slate-200">@{r.telegramUsername}</span>
                  ) : (
                    <span className="text-slate-500">—</span>
                  )}
                </td>
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
              </tr>
            );
          })}
        </tbody>
    </table>
  );
}

function MiniStat({
  label,
  value,
  accent = "text-slate-200",
  onClick,
}: {
  label: string;
  value: number;
  accent?: string;
  onClick?: () => void;
}) {
  const clickable = !!onClick && value > 0;
  return (
    <div
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
