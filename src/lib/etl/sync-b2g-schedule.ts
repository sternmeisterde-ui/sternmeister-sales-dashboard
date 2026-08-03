/**
 * Синк графика смен B2G из Google-файла РОПа в D1.manager_schedule.
 *
 * Источник: лист «График на месяц» — ОДИН месяц по горизонтали (в отличие от
 * b2b, где месяцы идут вертикальными блоками):
 *   строка дат   — «01.08», «02.08», … в колонках D.. (ищем по формату DD.MM);
 *   строка шапки — «№ п/п | ФИО сотрудника | Смен | сб | вс | пн …»;
 *   строки людей — № | ФИО | сколько смен | ячейки по дням:
 *     «9-18» / «10:00-19:00» — смена; «В» / «ОТ» / любое иное непустое —
 *     нерабочий день; пустая ячейка = данных нет (день уйдёт под fallback SLA).
 *   Между шапкой и людьми бывает строка-разделитель секции («1 линия») — её
 *   отличаем по отсутствию номера в колонке A.
 *
 * ГОДА В ФАЙЛЕ НЕТ (только «01.08»), поэтому он выводится из текущего
 * берлинского месяца: если месяц файла сильно позади текущего (> 6 мес.) —
 * значит это следующий год (декабрьский файл, открытый в январе).
 *
 * Защита истории — как у b2b: месяцы РАНЬШЕ текущего игнорируются. Файл
 * «на месяц» перезаписывается РОПом каждый месяц, и без этой защиты сентябрьский
 * лист стёр бы августовскую историю. База накопительная: месяцы, которых в файле
 * нет, синк не трогает. Ретро-правка — осознанное действие:
 * scripts/sync-b2g-schedule.ts --allow-past (+ recompute-sla за период).
 *
 * Внутри месяца — полная перезапись по паре (менеджер, месяц): дни месяца
 * удаляются и вставляются заново, чтобы вычистить стёртые в файле ячейки.
 * Менеджеров, которых в файле нет, синк не касается вовсе.
 *
 * NB: на 2026-08 в manager_schedule НЕТ ни одной b2g-строки — календарь Дейли
 * для Госников эту таблицу не заполняет, так что конфликта с ручным вводом
 * сейчас нет. Если Дейли-календарь для b2g когда-нибудь включат, перезапись
 * месяца затрёт ручные отметки этих четверых — тогда синк надо будет сузить до
 * колонок времени.
 *
 * Потребитель: compute-sla — «своё» SLA Госников считает рабочие часы по графику
 * того, кто сделал первое касание (первый исходящий звонок по лиду).
 */

import { db } from "@/lib/db";
import { masterManagers, managerSchedule } from "@/lib/db/schema-existing";
import { and, eq, inArray } from "drizzle-orm";
import { readSheetRange, googleSheetsConfigured } from "@/lib/google/sheets";

const SPREADSHEET_ID =
  process.env.B2G_SCHEDULE_SPREADSHEET_ID ?? "1My3p6DsxdZxZ2z9Brheqrj_708wGfDg0bgVJYEWconA";
const SHEET_RANGE = "'График на месяц'!A1:AL200";

/** «9-18», «9:30-18:00», «11-20» → секунды от полуночи. Иначе null. */
const SHIFT_RE = /^(\d{1,2})(?::(\d{2}))?\s*[-–—]\s*(\d{1,2})(?::(\d{2}))?$/;
/** «01.08» / «1.8» в строке дат. */
const DATE_RE = /^(\d{1,2})[.](\d{1,2})[.]?$/;

interface ParsedDay {
  date: string; // YYYY-MM-DD
  isOnLine: boolean;
  start: string | null; // HH:MM
  end: string | null;
}

const normName = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
const hhmm = (h: string, m: string | undefined) =>
  `${String(Number(h)).padStart(2, "0")}:${m ?? "00"}`;

export interface B2gScheduleSyncResult {
  months: string[];
  monthsSkippedPast: string[];
  managersMatched: number;
  managersUnmatched: string[];
  rowsWritten: number;
  /** dryRun: что синк ЗАПИСАЛ БЫ — для проверки разбора листа без записи в БД. */
  preview?: Array<{ manager: string; month: string; shifts: number; daysOff: number; sample: string[] }>;
}

function currentBerlinMonth(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
  }).format(new Date());
}

/**
 * Год для месяца из файла (года в файле нет). Берём текущий берлинский; если
 * месяц файла отстаёт от текущего больше чем на 6 — это следующий год
 * (декабрьский график, открытый в январе).
 */
function inferYear(month: number, curMonth: string): number {
  const curY = Number(curMonth.slice(0, 4));
  const curM = Number(curMonth.slice(5, 7));
  if (month < curM - 6) return curY + 1;
  return curY;
}

export async function syncB2gSchedule(
  opts: { allowPastMonths?: boolean; dryRun?: boolean } = {},
): Promise<B2gScheduleSyncResult> {
  if (!googleSheetsConfigured()) {
    // Graceful no-op: без кредов SLA живёт на fallback-правиле Пн–Сб 09–18.
    return { months: [], monthsSkippedPast: [], managersMatched: 0, managersUnmatched: [], rowsWritten: 0 };
  }

  const rows = await readSheetRange(SPREADSHEET_ID, SHEET_RANGE);
  const curMonth = currentBerlinMonth();

  // ── Строка дат: первая строка, где ≥ 5 ячеек формата DD.MM ──
  let dateCols: Array<{ col: number; date: string }> = [];
  let dateRowIdx = -1;
  for (let i = 0; i < rows.length && dateRowIdx < 0; i++) {
    const found: Array<{ col: number; date: string }> = [];
    rows[i].forEach((raw, col) => {
      const m = (raw ?? "").trim().match(DATE_RE);
      if (!m) return;
      const day = Number(m[1]);
      const mon = Number(m[2]);
      if (day < 1 || day > 31 || mon < 1 || mon > 12) return;
      const year = inferYear(mon, curMonth);
      found.push({
        col,
        date: `${year}-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      });
    });
    if (found.length >= 5) {
      dateRowIdx = i;
      dateCols = found;
    }
  }
  if (dateRowIdx < 0) {
    console.warn("[ETL] sync-b2g-schedule: строка дат не найдена — лист изменился?");
    return { months: [], monthsSkippedPast: [], managersMatched: 0, managersUnmatched: [], rowsWritten: 0 };
  }

  // ── Строки людей: ниже строки дат, есть номер в колонке A и имя в B ──
  const byManager = new Map<string, { rawName: string; days: ParsedDay[] }>();
  const months = new Set<string>();
  for (let i = dateRowIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const num = (row[0] ?? "").trim();
    const name = (row[1] ?? "").trim();
    // Строка-разделитель секции («1 линия») номера не имеет — пропускаем её,
    // как и шапку «№ п/п | ФИО сотрудника». Плюс требуем букву в имени: под
    // строкой дат идёт строка с номерами дней (A=«1», B=«2», далее 1..31), и
    // без этой проверки она разбиралась бы как сотрудник по имени «2».
    if (!name || !/^\d+$/.test(num) || !/[А-Яа-яЁёA-Za-z]/.test(name)) continue;

    const days: ParsedDay[] = [];
    for (const { col, date } of dateCols) {
      const cell = (row[col] ?? "").trim();
      if (!cell) continue; // данных нет → fallback
      const sm = cell.match(SHIFT_RE);
      if (sm) {
        const start = hhmm(sm[1], sm[2]);
        const end = hhmm(sm[3], sm[4]);
        days.push({ date, isOnLine: true, start, end });
      } else {
        // «В» / «ОТ» / «Б» / что угодно иное — нерабочий день.
        days.push({ date, isOnLine: false, start: null, end: null });
      }
      months.add(date.slice(0, 7));
    }
    if (days.length > 0) byManager.set(normName(name), { rawName: name, days });
  }

  const masters = await db
    .select({ id: masterManagers.id, name: masterManagers.name })
    .from(masterManagers)
    .where(eq(masterManagers.department, "b2g"));
  const idByNorm = new Map(masters.map((m) => [normName(m.name), m.id]));

  const skippedPast = new Set<string>();
  const unmatched: string[] = [];
  let rowsWritten = 0;
  const preview: B2gScheduleSyncResult["preview"] = [];

  for (const [key, entry] of byManager) {
    const managerId = idByNorm.get(key);
    if (!managerId) {
      unmatched.push(entry.rawName);
      continue;
    }
    const byMonth = new Map<string, ParsedDay[]>();
    for (const d of entry.days) {
      const mo = d.date.slice(0, 7);
      if (!byMonth.has(mo)) byMonth.set(mo, []);
      byMonth.get(mo)!.push(d);
    }
    for (const [mo, days] of byMonth) {
      if (!opts.allowPastMonths && mo < curMonth) {
        skippedPast.add(mo);
        continue;
      }
      if (opts.dryRun) {
        preview.push({
          manager: entry.rawName,
          month: mo,
          shifts: days.filter((d) => d.isOnLine).length,
          daysOff: days.filter((d) => !d.isOnLine).length,
          sample: days.slice(0, 4).map((d) => `${d.date} ${d.isOnLine ? `${d.start}-${d.end}` : "выходной"}`),
        });
        rowsWritten += days.length;
        continue;
      }
      const [y, m] = [Number(mo.slice(0, 4)), Number(mo.slice(5, 7))];
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const allDates = Array.from({ length: lastDay }, (_, i) => `${mo}-${String(i + 1).padStart(2, "0")}`);
      await db
        .delete(managerSchedule)
        .where(and(eq(managerSchedule.userId, managerId), inArray(managerSchedule.scheduleDate, allDates)));
      await db.insert(managerSchedule).values(
        days.map((d) => ({
          userId: managerId,
          scheduleDate: d.date,
          isOnLine: d.isOnLine,
          scheduleValue: d.isOnLine ? "8" : "-",
          shiftStartTime: d.start,
          shiftEndTime: d.end,
          updatedAt: new Date(),
        })),
      );
      rowsWritten += days.length;
    }
  }

  if (unmatched.length > 0) {
    console.warn(`[ETL] sync-b2g-schedule: не сматчены с master_managers: ${unmatched.join("; ")}`);
  }
  if (skippedPast.size > 0) {
    console.log(
      `[ETL] sync-b2g-schedule: прошедшие месяцы пропущены (история в базе): ${[...skippedPast].join(", ")}`,
    );
  }
  console.log(
    `[ETL] sync-b2g-schedule: месяцы [${[...months].join(", ")}], менеджеров ${byManager.size - unmatched.length}/${byManager.size}, строк ${rowsWritten}`,
  );

  return {
    months: [...months].sort(),
    monthsSkippedPast: [...skippedPast].sort(),
    managersMatched: byManager.size - unmatched.length,
    managersUnmatched: unmatched,
    rowsWritten,
    ...(opts.dryRun ? { preview } : {}),
  };
}
