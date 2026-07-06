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
import { HeartPulse, Loader2, RefreshCw, X } from "lucide-react";
import CalendarPicker, { type DateRange } from "@/components/CalendarPicker";
import DinoLoader from "@/components/DinoLoader";
import { fmtLocalDate, todayBerlinDate } from "@/lib/utils/date";

// Форма ответа /api/enps (используем только weeks + responses; остальные
// агрегаты бэк отдаёт, но упрощённая вкладка их не показывает).
interface WeekPoint {
  weekStart: string;
  count: number;
  avg: number;
}
interface ResponseItem {
  submittedAt: string;
  weekStart: string;
  score: number;
  supports: string | null;
  frustrates: string | null;
}
interface EnpsStats {
  available: boolean;
  syncConfigured: boolean;
  weeks: WeekPoint[];
  responses: ResponseItem[];
}

/** Дефолтный период — последние полгода. */
function defaultRange(): DateRange {
  const end = todayBerlinDate();
  const start = new Date(end.getTime() - 182 * 86_400_000);
  return { start, end };
}

/** "YYYY-MM-DD" → "DD.MM" без таймзонных сюрпризов (чистая строка). */
function fmtWeek(weekStart: string): string {
  return `${weekStart.slice(8, 10)}.${weekStart.slice(5, 7)}`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    timeZone: "Europe/Berlin",
  });
}

function scoreBadgeClass(score: number): string {
  if (score >= 9) return "bg-emerald-500/20 text-emerald-300";
  if (score >= 7) return "bg-amber-500/20 text-amber-300";
  return "bg-red-500/20 text-red-300";
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export default function EnpsTab({ department: _department }: { department: "b2g" | "b2b" }) {
  const [stats, setStats] = useState<EnpsStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<DateRange>(defaultRange);
  const [selectedWeek, setSelectedWeek] = useState<string | null>(null);

  const load = useCallback(async (r: DateRange) => {
    const start = r.start ?? todayBerlinDate();
    const end = r.end ?? start;
    setLoading(true);
    setError(null);
    setSelectedWeek(null);
    try {
      const params = new URLSearchParams({
        from: fmtLocalDate(start),
        to: fmtLocalDate(end),
      });
      const res = await fetch(`/api/enps?${params}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStats((await res.json()) as EnpsStats);
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

  const responses = useMemo(() => {
    const all = stats?.responses ?? [];
    return selectedWeek ? all.filter((r) => r.weekStart === selectedWeek) : all;
  }, [stats, selectedWeek]);

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
      {/* Заголовок + период + обновить */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 text-slate-200">
          <HeartPulse className="w-5 h-5 text-blue-400" />
          <span className="text-base font-semibold">eNPS</span>
        </div>

        <CalendarPicker
          mode="range"
          value={range}
          onChange={onRangeChange}
          onClear={() => onRangeChange(defaultRange())}
          maxDate={todayBerlinDate()}
        />

        {stats && !stats.syncConfigured && (
          <span className="text-[11px] text-amber-300/80">
            автосинк из Google Sheets не настроен — данные из последнего импорта
          </span>
        )}

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
          Не удалось загрузить eNPS: {error}
        </div>
      )}

      {unavailable && !error && (
        <div className="rounded-lg border border-white/10 bg-slate-900/60 px-4 py-8 text-center text-sm text-slate-400">
          Ответов за период нет.
          <div className="mt-1 text-xs text-slate-500">
            Опрос анонимный: менеджеры заполняют Typeform, данные приходят через Google Sheets.
          </div>
        </div>
      )}

      {stats && !unavailable && (
        <>
          {/* Средний балл по неделям. Кол-во ответов — в тултипе: при 5–10
              ответах в неделе балл скачет, объём важен для чтения графика. */}
          <section>
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <h3 className="text-xs uppercase tracking-wider text-slate-500">
                Средний балл по неделям
              </h3>
              <span className="text-[11px] text-blue-300/80">
                нажмите на неделю, чтобы отфильтровать ответы ниже
              </span>
            </div>
            <div className="rounded-lg border border-white/10 bg-slate-900/40 p-3" style={{ cursor: "pointer" }}>
              <ResponsiveContainer width="100%" height={240}>
                <LineChart
                  data={stats.weeks}
                  margin={{ top: 8, right: 12, bottom: 0, left: -24 }}
                  onClick={(state) => {
                    const lbl = (state as { activeLabel?: string | number } | null)?.activeLabel;
                    if (lbl != null) setSelectedWeek(String(lbl));
                  }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis
                    dataKey="weekStart"
                    tickFormatter={fmtWeek}
                    tick={{ fill: "#94a3b8", fontSize: 11 }}
                    axisLine={{ stroke: "rgba(255,255,255,0.1)" }}
                    tickLine={false}
                    minTickGap={24}
                  />
                  <YAxis
                    domain={[0, 10]}
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
                    labelFormatter={(v) => `Неделя с ${fmtWeek(String(v))}`}
                    formatter={(value, _name, entry) => {
                      const count = (entry?.payload as WeekPoint | undefined)?.count;
                      return [`${value}${count != null ? ` · ${count} отв.` : ""}`, "Средний балл"];
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="avg"
                    stroke="#60a5fa"
                    strokeWidth={2}
                    dot={{ r: 2.5, fill: "#60a5fa" }}
                    activeDot={{ r: 4 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>

          {/* Ответы (анонимные) */}
          <section>
            <div className="mb-2 flex flex-wrap items-baseline gap-2">
              <h3 className="text-xs uppercase tracking-wider text-slate-500">Ответы</h3>
              {selectedWeek && (
                <button
                  onClick={() => setSelectedWeek(null)}
                  className="inline-flex items-center gap-1 rounded-md bg-blue-500/15 px-2 py-0.5 text-[11px] text-blue-300 hover:bg-blue-500/25"
                >
                  неделя с {fmtWeek(selectedWeek)}
                  <X className="h-3 w-3" />
                </button>
              )}
              <span className="ml-auto text-[11px] text-slate-500">
                анонимно · {responses.length} отв.
              </span>
            </div>
            {/* Высота ~экран, дальше скролл внутри контейнера; шапка прилипает.
                Паттерн из DailyTab: sticky на thead + НЕпрозрачный инлайн-bg
                и тень (полупрозрачный bg просвечивает строки при скролле). */}
            <div className="max-h-[75vh] overflow-y-auto overflow-x-auto rounded-lg border border-white/10">
              <table className="w-full text-sm">
                <thead
                  className="sticky top-0 z-10"
                  style={{ backgroundColor: "rgb(15, 23, 42)", boxShadow: "0 2px 8px rgba(0,0,0,0.4)" }}
                >
                  <tr className="border-b border-white/10 text-left text-xs text-slate-400">
                    <th className="px-3 py-2 font-medium">Дата</th>
                    <th className="px-3 py-2 font-medium">Балл</th>
                    <th className="px-3 py-2 font-medium">Что поддерживает</th>
                    <th className="px-3 py-2 font-medium">Что мешает</th>
                  </tr>
                </thead>
                <tbody>
                  {responses.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-3 py-6 text-center text-xs text-slate-500">
                        Нет ответов.
                      </td>
                    </tr>
                  ) : (
                    responses.map((r, i) => (
                      <tr
                        key={`${r.submittedAt}-${i}`}
                        className="border-b border-white/5 bg-slate-900/30 align-top last:border-0"
                      >
                        <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-400">
                          {fmtDate(r.submittedAt)}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`inline-block rounded px-1.5 py-0.5 text-xs font-semibold ${scoreBadgeClass(r.score)}`}
                          >
                            {r.score}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-slate-200">{r.supports ?? "—"}</td>
                        <td className="px-3 py-2 text-slate-200">{r.frustrates ?? "—"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
