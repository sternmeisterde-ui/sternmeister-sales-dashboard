"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Loader2,
  TriangleAlert,
  ExternalLink,
  Info,
} from "lucide-react";
import CalendarPicker from "@/components/CalendarPicker";
import FilterSelect from "@/components/funnel/FilterSelect";
import RoleplayDetailDrawer from "@/components/funnel/RoleplayDetailDrawer";
import { fmtLocalDate, todayBerlinDate } from "@/lib/utils/date";
import type { RoleplaysResult, ClientRow, ManagerRow, SlotCompare } from "@/lib/funnel/roleplays-section";

/**
 * Раздел «Ролевки». Период фильтруется по ДАТЕ КОНСУЛЬТАЦИИ (когда звонили), а
 * не по дате термина — вопрос раздела «сколько провели за неделю», и ответ
 * должен меняться вместе с выбранными неделями.
 *
 * Только таблицы: графики убрали по просьбе заказчика (2026-07-28) — занимали
 * пол-экрана, а читать цифры всё равно приходилось в таблицах.
 */
const PAGE_SIZE = 50;
const cache = new Map<string, RoleplaysResult>();

interface Props {
  vertical?: "buh" | "med" | "all";
}

function fmtDay(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", timeZone: "Europe/Berlin" });
}

/**
 * Ячейка сверки «что стоит в карточке» ↔ «что насчитал бот».
 *
 * Красное = балл в карточке бот не подтверждал: либо поставил другую цифру,
 * либо эту ролевку вовсе не разбирал. Это и есть ответ на вопрос «где ещё
 * стоит оценка менеджера» — цифра держится только на его слове.
 */
function SlotCell({ slot }: { slot: SlotCompare }) {
  const when = slot.day ? fmtDay(`${slot.day}T12:00:00Z`) : "дата не указана";
  const who = slot.editedBy ? `правил руками: ${slot.editedBy}` : null;
  const tip = (text: string) => [`${when}: ${text}`, who].filter(Boolean).join("\n");

  switch (slot.status) {
    case "pending":
      return (
        <span className="text-amber-400 cursor-help" title={tip("разговор сегодня — бот досчитает примерно через два часа")}>
          {slot.kommo ?? "…"}
        </span>
      );
    case "bot_only":
      return (
        <span className="text-rose-300 font-semibold cursor-help" title={tip(`бот оценил на ${slot.bot}, но в карточке пусто — запись не дошла`)}>
          ∅
        </span>
      );
    case "kommo_only":
      return (
        <span className="text-rose-300 font-semibold cursor-help" title={tip(`в карточке ${slot.kommo}, но эту ролевку бот не разбирал — балл ничем не подтверждён`)}>
          {slot.kommo}
        </span>
      );
    case "mismatch":
      return (
        <span className="text-rose-300 font-semibold cursor-help" title={tip(`бот поставил ${slot.bot}, а в карточке ${slot.kommo} — цифру правили после разбора`)}>
          {slot.kommo}
        </span>
      );
    default:
      return (
        <span
          className={`font-semibold ${slot.kommo === null ? "text-slate-600" : scoreColor(slot.kommo)}`}
          title={tip(slot.kommo === null ? "ролевка была, балл не выставлен ни ботом, ни руками" : "совпадает с оценкой бота")}
        >
          {slot.kommo ?? "—"}
        </span>
      );
  }
}

function scoreColor(s: number): string {
  if (s >= 4) return "text-emerald-300";
  if (s === 3) return "text-amber-300";
  return "text-rose-300";
}

export default function RoleplaysView({ vertical }: Props) {
  const today = todayBerlinDate();
  const monthStart = new Date(today);
  monthStart.setDate(1);

  const [range, setRange] = useState<{ start: Date | null; end: Date | null }>({
    start: monthStart,
    end: today,
  });
  const [manager, setManager] = useState("");
  const [data, setData] = useState<RoleplaysResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState<ClientRow | null>(null);

  const from = fmtLocalDate(range.start ?? monthStart);
  const to = fmtLocalDate(range.end ?? range.start ?? today);
  const key = `${from}|${to}|${vertical ?? "-"}`;

  useEffect(() => {
    const ctrl = new AbortController();
    const id = setTimeout(() => {
      const cached = cache.get(key);
      if (cached) {
        setData(cached);
        setError(null);
        return;
      }
      setLoading(true);
      setError(null);
      const params = new URLSearchParams({ from, to });
      if (vertical) params.set("vertical", vertical);
      fetch(`/api/funnel/roleplays-section?${params}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? (r.json() as Promise<RoleplaysResult>) : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((j) => {
          cache.set(key, j);
          setData(j);
        })
        .catch((e) => {
          if ((e as Error).name !== "AbortError") setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => setLoading(false));
    }, 250);
    return () => {
      clearTimeout(id);
      ctrl.abort();
    };
  }, [key, from, to, vertical]);

  const managerOptions = useMemo(
    () => (data?.managers ?? []).map((m) => ({ value: m.name, label: m.name })),
    [data],
  );

  const clients = useMemo(() => {
    if (!data) return [];
    return manager ? data.clients.filter((c) => c.managerName === manager) : data.clients;
  }, [data, manager]);

  const [seen, setSeen] = useState(clients);
  if (seen !== clients) {
    setSeen(clients);
    setVisible(PAGE_SIZE);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="bg-slate-900 shadow-lg sticky top-0 z-20 rounded-2xl border border-white/5 px-4 py-3 flex items-center gap-3 flex-wrap">
        <span className="text-[10px] uppercase tracking-widest font-semibold text-slate-500">
          Период консультаций
        </span>
        <CalendarPicker
          mode="range"
          value={range}
          onChange={setRange}
          onClear={() => setRange({ start: monthStart, end: today })}
        />
        <span className="text-[10px] uppercase tracking-widest font-semibold text-slate-500">
          Менеджер
        </span>
        <FilterSelect
          value={manager}
          options={managerOptions}
          onChange={setManager}
          emptyLabel="Все"
          ariaLabel="Фильтр по менеджеру"
          minWidthClass="min-w-[160px]"
        />
        {loading && <Loader2 className="w-3.5 h-3.5 text-slate-500 animate-spin" />}
        <span className="text-[11px] text-slate-500 ml-auto">
          фильтр по дате звонка, а не термина
        </span>
      </div>

      {error && (
        <div className="glass-panel rounded-2xl border border-rose-500/30 bg-rose-500/5 px-4 py-3 text-sm text-rose-300 flex items-center gap-2">
          <TriangleAlert className="w-4 h-4 shrink-0" />
          <span className="truncate">Не удалось загрузить раздел: {error}</span>
        </div>
      )}

      {!data && loading && (
        <div className="glass-panel rounded-2xl border border-white/5 px-4 py-12 flex items-center justify-center gap-2 text-sm text-slate-400">
          <Loader2 className="w-4 h-4 animate-spin" /> Загрузка…
        </div>
      )}

      {data && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <Tile
              label="Консультаций"
              value={data.totals.consultations}
              hint="Соединённые звонки от 10 минут, сделанные пока сделка стояла на этапе консультации перед ДЦ или АА. Полное покрытие — считается по телефонии, а не по ОКК."
            />
            <Tile
              label="Разобрано ОКК"
              value={data.totals.analyzed}
              sub={data.coveragePct === null ? undefined : `${data.coveragePct}% консультаций`}
              hint="Разбирается не всё: звонок короче порога (с 29.07 — 10 минут, раньше 15), повторный звонок к сделке с 4+ касаниями, уехавший этап, сбой обработки. Причина по каждому клиенту — в подсказке к его строке. Неразобранное ≠ «ролевки не было»."
            />
            <Tile
              label="Ролевка подтверждена"
              value={data.totals.confirmed}
              sub={
                data.totals.analyzed > 0
                  ? `${Math.round((data.totals.confirmed / data.totals.analyzed) * 100)}% разобранных`
                  : undefined
              }
              hint="Из разобранных: клиент реально сам отвечал по-немецки. Менеджерский критерий мягче — он засчитывает и «предложил / перенёс / отправил в тренажёр», поэтому здесь не используется."
            />
            <Tile label="Клиентов" value={data.totals.leads} hint="Уникальных сделок с консультациями за период." />
            <Tile
              label="Консультаций на клиента"
              value={data.totals.perLead ?? 0}
              hint="Ключевая метрика роста: чем больше повторных консультаций на одного клиента, тем выше конверсия в Гутшайн."
            />
          </div>

          <ManagersTable rows={data.managers} onPick={setManager} picked={manager} />

          <ClientsTable
            rows={clients.slice(0, visible)}
            total={clients.length}
            onMore={() => setVisible((v) => v + PAGE_SIZE)}
            onPick={setSelected}
          />

          <div className="glass-panel rounded-2xl border border-white/5 px-4 py-3 text-[11px] text-slate-500 flex gap-2">
            <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>
              Оценки в карточке Kommo заполняют два источника: менеджер руками и — с 22.06.2026 —
              сам бот ОКК (он записывает свой балл автоматически и может перезаписать ручной).
              Колонка «руками» показывает только правки людей: они видны по событиям Kommo,
              записи бота в этот журнал не попадают.
            </span>
          </div>
        </>
      )}

      {selected && (
        <RoleplayDetailDrawer
          leadId={selected.leadId}
          name={selected.name}
          managerName={selected.managerName}
          notAnalyzed={selected.notAnalyzed}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function Tile({
  label,
  value,
  sub,
  hint,
}: {
  label: string;
  value: number;
  sub?: string;
  hint: string;
}) {
  return (
    <div className="glass-panel rounded-2xl border border-white/5 px-4 py-3 cursor-help" title={hint}>
      <div className="text-[10px] uppercase tracking-widest text-slate-500">{label}</div>
      <div className="text-2xl font-semibold text-slate-100 tabular-nums mt-0.5">{value}</div>
      {sub && <div className="text-[11px] text-slate-500">{sub}</div>}
    </div>
  );
}

/** Шапка колонки: короткое название + поясняющая строчка под ним. */
function Th({
  children,
  sub,
  align = "right",
  title,
}: {
  children: React.ReactNode;
  sub?: string;
  align?: "left" | "right" | "center";
  title?: string;
}) {
  return (
    <th className={`px-3 py-2 align-bottom text-${align} font-semibold`} title={title}>
      <div className="text-[11px] normal-case tracking-normal text-slate-300">{children}</div>
      {sub && <div className="text-[10px] normal-case tracking-normal text-slate-500 font-normal">{sub}</div>}
    </th>
  );
}

function ManagersTable({
  rows,
  onPick,
  picked,
}: {
  rows: ManagerRow[];
  onPick: (name: string) => void;
  picked: string;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="glass-panel rounded-2xl border border-white/5 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/5">
        <span className="text-sm font-medium text-slate-200">По менеджерам</span>
        <span className="text-xs text-slate-500">клик по строке — отфильтровать клиентов ниже</span>
      </div>
      <div className="overflow-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-slate-500">
              <Th align="left">Менеджер</Th>
              <Th sub="звонки от 10 минут" title="Соединённые звонки не короче 10 минут, сделанные пока сделка стояла на этапе консультации перед ДЦ или АА. Считается по телефонии — ничего не теряется.">
                Консультаций
              </Th>
              <Th sub="уникальных сделок">Клиентов</Th>
              <Th sub="цель — больше 2" title="Сколько раз в среднем поговорили с одним клиентом. Именно этот показатель тянет конверсию в Гутшайн.">
                Консультаций на клиента
              </Th>
              <Th sub="из консультаций" title="Разбирается не всё: короткий звонок, повторный звонок к сделке с 4+ касаниями, уехавший этап, сбой обработки. Причина по каждому клиенту — в таблице ниже. Неразобранное не значит «ролевки не было».">
                Разобрал ОКК
              </Th>
              <Th sub="клиент отвечал по-немецки" title="Из разобранных: подтверждена настоящая репетиция — клиент сам произносил немецкие ответы.">
                Ролевка была
              </Th>
              <Th sub="посчитал по записи" title="Сколько ролевок бот ОКК оценил сам, разобрав запись разговора.">
                Оценил бот
              </Th>
              <Th sub="стоит фактически" title="Сколько баллов реально заполнено в полях «Ролевка ДЦ/АА-N оценка» в карточках Kommo за период.">
                Оценок в Kommo
              </Th>
              <Th sub="балл не подтверждён ботом" title="Слоты, где цифра в карточке не совпала с ботом или бот эту ролевку вовсе не разбирал. Менеджер вписывает балл сразу, бот считает свой примерно через два часа — если после этого в карточке осталась другая цифра, её поправили руками. Сегодняшние разговоры не в счёт: бот ещё в работе.">
                Расхождений
              </Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr
                key={m.name}
                onClick={() => onPick(picked === m.name ? "" : m.name)}
                className={`border-t border-white/5 cursor-pointer hover:bg-blue-500/5 ${
                  picked === m.name ? "bg-blue-500/10" : ""
                }`}
              >
                <td className="px-3 py-2 text-slate-200">{m.name}</td>
                <td className="px-3 py-2 text-right text-slate-100 tabular-nums font-semibold">{m.consultations}</td>
                <td className="px-3 py-2 text-right text-slate-400 tabular-nums">{m.leads}</td>
                <td className="px-3 py-2 text-right text-slate-300 tabular-nums">{m.perLead ?? "—"}</td>
                <td className="px-3 py-2 text-right text-slate-400 tabular-nums">{m.analyzed}</td>
                <td className="px-3 py-2 text-right text-slate-300 tabular-nums">{m.confirmed}</td>
                <td className="px-3 py-2 text-right text-slate-400 tabular-nums">{m.botScores}</td>
                <td className="px-3 py-2 text-right text-slate-400 tabular-nums">{m.kommoScores}</td>
                <td
                  className={`px-3 py-2 text-right tabular-nums ${
                    m.mismatches > 0 ? "text-rose-300 font-semibold" : "text-slate-600"
                  }`}
                >
                  {m.mismatches}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ClientsTable({
  rows,
  total,
  onMore,
  onPick,
}: {
  rows: ClientRow[];
  total: number;
  onMore: () => void;
  onPick: (c: ClientRow) => void;
}) {
  if (total === 0) return null;
  return (
    <div className="glass-panel rounded-2xl border border-white/5 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/5">
        <span className="text-sm font-medium text-slate-200">По клиентам</span>
        <span className="text-xs text-slate-500 tabular-nums">
          показано {rows.length} из {total}
        </span>
        <span className="text-xs text-slate-500 ml-auto">клик по строке — разбор ролевок по критериям</span>
      </div>
      <div className="overflow-auto max-h-[520px]">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-slate-900/80 backdrop-blur z-10">
            <tr className="text-slate-500">
              <Th align="left">Клиент</Th>
              <Th align="left" sub="ответственный по сделке">Менеджер</Th>
              <Th align="left" sub="на момент последнего звонка" title="Где стояла сделка, когда с клиентом говорили в последний раз, а не где она сейчас.">
                Этап
              </Th>
              <Th align="center" sub="дата в Kommo">Термин</Th>
              <Th sub="звонки от 10 минут">Консультаций</Th>
              <Th sub="из них / всего" title="Сколько консультаций попало в разбор ОКК. Наведите на цифру — покажет, почему остальные не разобраны.">
                Разобрал ОКК
              </Th>
              <Th align="center" sub="1–5, по порядку" title="Балл клиента за ролевку. ○ — репетиция была, но материала мало; ⚠ — сбой авто-оценки.">
                Оценил бот
              </Th>
              <Th align="center" sub="фактически в карточке" title="Что реально стоит в полях «Ролевка ДЦ/АА-N оценка». Красным — цифра не совпала с ботом или бот эту ролевку не разбирал. Наведите на балл: покажет оценку бота, дату и кто правил слот руками.">
                Стоит в Kommo
              </Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr
                key={c.leadId}
                tabIndex={0}
                onClick={() => onPick(c)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onPick(c);
                  }
                }}
                className="border-t border-white/5 hover:bg-blue-500/5 focus:bg-blue-500/10 cursor-pointer outline-none"
              >
                <td className="px-3 py-2 max-w-[190px] truncate">
                  <a
                    href={`https://sternmeister.kommo.com/leads/detail/${c.leadId}`}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="text-slate-200 hover:text-blue-300 inline-flex items-center gap-1"
                  >
                    {c.name}
                    <ExternalLink className="w-3 h-3 opacity-50 shrink-0" />
                  </a>
                </td>
                <td className="px-3 py-2 text-slate-300 max-w-[150px] truncate">{c.managerName ?? "—"}</td>
                <td className="px-3 py-2 text-slate-400 max-w-[190px] truncate">{c.stage ?? "—"}</td>
                <td className="px-3 py-2 text-center text-slate-300 tabular-nums">{fmtDay(c.terminIso)}</td>
                <td className="px-3 py-2 text-right text-slate-100 tabular-nums font-semibold">{c.consultations}</td>
                <td
                  className="px-3 py-2 text-right text-slate-400 tabular-nums"
                  title={
                    c.notAnalyzed.length > 0
                      ? `ОКК не разобрал ${c.notAnalyzed.reduce((s, r) => s + r.count, 0)} звонк(ов):\n` +
                        c.notAnalyzed.map((r) => `• ${r.count} × ${r.reason}`).join("\n") +
                        "\n\nКолонка считает консультации по телефонии, причины — по данным ОКК; наборы могут расходиться на 1–2 звонка."
                      : undefined
                  }
                >
                  {c.analyzed}
                  {c.analyzed < c.consultations && (
                    <span className={c.notAnalyzed.length > 0 ? "text-slate-500 cursor-help" : "text-slate-600"}>
                      {" "}
                      /{c.consultations}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-center">
                  {c.botScores.length === 0 ? (
                    <span className="text-slate-600">—</span>
                  ) : (
                    <span className="inline-flex items-center gap-1 tabular-nums">
                      {c.botScores.map((b, i) => (
                        <span key={i} className="inline-flex items-center gap-1">
                          {i > 0 && <span className="text-slate-600">→</span>}
                          {b.score !== null ? (
                            <span className={`font-semibold ${scoreColor(b.score)}`}>{b.score}</span>
                          ) : b.notScored === "degenerate" ? (
                            <span className="text-amber-500" title="Ролевка была, но авто-оценка сорвалась">⚠</span>
                          ) : (
                            <span className="text-slate-500" title="Ролевка была, но клиент дал слишком мало самостоятельных немецких ответов">○</span>
                          )}
                        </span>
                      ))}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-center">
                  {c.kommoSlots.length === 0 ? (
                    <span className="text-slate-600" title="За этот период в карточке нет ни одной оценки за ролевку">—</span>
                  ) : (
                    <span className="inline-flex items-center gap-1 tabular-nums">
                      {c.kommoSlots.map((slot, i) => (
                        <span key={i} className="inline-flex items-center gap-1">
                          {i > 0 && <span className="text-slate-600">→</span>}
                          <SlotCell slot={slot} />
                        </span>
                      ))}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length < total && (
        <div className="px-4 py-2.5 border-t border-white/5 flex justify-center">
          <button
            type="button"
            onClick={onMore}
            className="text-xs text-slate-400 hover:text-white px-3 py-1 rounded-md hover:bg-white/5"
          >
            Показать ещё
          </button>
        </div>
      )}
    </div>
  );
}
