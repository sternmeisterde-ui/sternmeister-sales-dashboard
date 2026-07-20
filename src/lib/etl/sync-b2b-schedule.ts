/**
 * Синк графика смен B2B из Google-файла РОПа в D1.manager_schedule.
 *
 * Источник: лист «ГРАФИК АКТУАЛЬНЫЙ» — вертикальные помесячные блоки:
 *   строка «<Месяц> <Год>» (кол. A) + имена дней недели в D..,
 *   строка «№» + номера дней месяца в D..,
 *   затем по строке на менеджера: №, имя, ?, ячейки по дням —
 *   «HH:MM-HH:MM» (смена) или 🌴/другое непустое (выходной); пустая ячейка =
 *   данных нет (день остаётся под fallback-правилом SLA).
 *
 * РОП добавляет новый месяц новым блоком ниже — парсер сканирует весь лист и
 * подхватывает все блоки автоматически. Изменения текущего графика
 * подхватываются полной перезаписью: для каждой пары (менеджер, месяц из
 * файла) строки месяца в manager_schedule удаляются и вставляются заново —
 * в т.ч. очищая дни, стёртые в файле. Строк других менеджеров (b2g,
 * Дейли-календарь) синк не касается.
 *
 * Пишем: is_on_line (смена/выходной) + shift_start_time/shift_end_time +
 * schedule_value («8» = смена, «-» = выходной) — те же коды, что прежний
 * ручной xlsx-импорт (scripts/import-b2b-schedule-from-json.ts), чтобы табель
 * (computePayroll) продолжал считать дни b2b.
 *
 * Потребитель: compute-sla (рабочее время ответственного менеджера) + бонусом
 * выходные в графике «Динамика звонков» и Дейли-календарь b2b.
 */

import { db } from "@/lib/db";
import { masterManagers, managerSchedule } from "@/lib/db/schema-existing";
import { and, eq, inArray } from "drizzle-orm";
import { readSheetRange, googleSheetsConfigured } from "@/lib/google/sheets";

const SPREADSHEET_ID =
  process.env.B2B_SCHEDULE_SPREADSHEET_ID ?? "1LjythVj-OqSf7gG1FUsbMa_bAJiCWrtCgdSfm33xK-4";
const SHEET_RANGE = "'ГРАФИК АКТУАЛЬНЫЙ'!A1:AH600";

const MONTH_BY_NAME: Record<string, number> = {
  "январь": 1, "февраль": 2, "март": 3, "апрель": 4, "май": 5, "июнь": 6,
  "июль": 7, "август": 8, "сентябрь": 9, "октябрь": 10, "ноябрь": 11, "декабрь": 12,
};

const SHIFT_RE = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/;

interface ParsedDay {
  date: string; // YYYY-MM-DD
  isOnLine: boolean;
  start: string | null; // HH:MM
  end: string | null;
}

/** Нормализация имени для матча с master_managers (в файле бывают хвостовые пробелы). */
const normName = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export interface B2bScheduleSyncResult {
  months: string[];         // YYYY-MM, найденные в файле
  managersMatched: number;
  managersUnmatched: string[];
  rowsWritten: number;
}

export async function syncB2bSchedule(): Promise<B2bScheduleSyncResult> {
  if (!googleSheetsConfigured()) {
    // Graceful no-op: без кредов SLA продолжает жить на fallback-правиле.
    return { months: [], managersMatched: 0, managersUnmatched: [], rowsWritten: 0 };
  }

  const rows = await readSheetRange(SPREADSHEET_ID, SHEET_RANGE);

  // ── Парсинг блоков ──
  // byManager: normName → Map<YYYY-MM-DD, ParsedDay>; months: набор покрытых месяцев
  const byManager = new Map<string, { rawName: string; days: Map<string, ParsedDay> }>();
  const months = new Set<string>();

  let cur: { y: number; m: number; dayCols: Array<{ col: number; day: number }> } | null = null;
  for (const row of rows) {
    const a = (row[0] ?? "").trim();
    const headerMatch = a.match(/^([А-Яа-яЁё]+)\s+(20\d\d)/);
    if (headerMatch && MONTH_BY_NAME[headerMatch[1].toLowerCase()]) {
      cur = { y: Number(headerMatch[2]), m: MONTH_BY_NAME[headerMatch[1].toLowerCase()], dayCols: [] };
      continue;
    }
    if (!cur) continue;
    if (a === "№") {
      // строка с номерами дней месяца
      cur.dayCols = [];
      for (let c = 3; c < row.length; c++) {
        const d = Number((row[c] ?? "").trim());
        if (Number.isFinite(d) && d >= 1 && d <= 31) cur.dayCols.push({ col: c, day: d });
      }
      if (cur.dayCols.length > 0) {
        months.add(`${cur.y}-${String(cur.m).padStart(2, "0")}`);
      }
      continue;
    }
    const name = (row[1] ?? "").trim();
    if (!name || cur.dayCols.length === 0) continue; // не строка менеджера

    const key = normName(name);
    let entry = byManager.get(key);
    if (!entry) { entry = { rawName: name, days: new Map() }; byManager.set(key, entry); }
    for (const { col, day } of cur.dayCols) {
      const cell = (row[col] ?? "").trim();
      if (!cell) continue; // пусто = данных нет
      const date = `${cur.y}-${String(cur.m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const m = cell.match(SHIFT_RE);
      if (m) {
        entry.days.set(date, {
          date,
          isOnLine: true,
          start: `${m[1].padStart(2, "0")}:${m[2]}`,
          end: `${m[3].padStart(2, "0")}:${m[4]}`,
        });
      } else {
        // 🌴 и любые другие пометки — выходной
        entry.days.set(date, { date, isOnLine: false, start: null, end: null });
      }
    }
  }

  // ── Резолв имён в master_managers (b2b; включая soft-deleted — график
  // прошлых месяцев уволенных должен сохраняться для исторического SLA) ──
  const masters = await db
    .select({ id: masterManagers.id, name: masterManagers.name })
    .from(masterManagers)
    .where(eq(masterManagers.department, "b2b"));
  const idByNorm = new Map(masters.map((m) => [normName(m.name), m.id]));

  let rowsWritten = 0;
  const unmatched: string[] = [];
  for (const [key, entry] of byManager) {
    const managerId = idByNorm.get(key);
    if (!managerId) {
      unmatched.push(entry.rawName);
      continue;
    }
    // Перезапись по месяцам: удаляем ВСЕ дни месяца этого менеджера (чтобы
    // вычистить стёртые в файле ячейки), вставляем актуальные.
    const byMonth = new Map<string, ParsedDay[]>();
    for (const d of entry.days.values()) {
      const mo = d.date.slice(0, 7);
      if (!byMonth.has(mo)) byMonth.set(mo, []);
      byMonth.get(mo)!.push(d);
    }
    for (const [mo, days] of byMonth) {
      const [y, m] = [Number(mo.slice(0, 4)), Number(mo.slice(5, 7))];
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const allDates = Array.from({ length: lastDay }, (_, i) => `${mo}-${String(i + 1).padStart(2, "0")}`);
      await db
        .delete(managerSchedule)
        .where(and(eq(managerSchedule.userId, managerId), inArray(managerSchedule.scheduleDate, allDates)));
      if (days.length > 0) {
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
  }

  if (unmatched.length > 0) {
    console.warn(`[ETL] sync-b2b-schedule: не сматчены с master_managers: ${unmatched.join("; ")}`);
  }
  console.log(
    `[ETL] sync-b2b-schedule: месяцы [${[...months].join(", ")}], менеджеров ${byManager.size - unmatched.length}/${byManager.size}, строк ${rowsWritten}`,
  );
  return {
    months: [...months].sort(),
    managersMatched: byManager.size - unmatched.length,
    managersUnmatched: unmatched,
    rowsWritten,
  };
}
