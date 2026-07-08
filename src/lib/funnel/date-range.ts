// Единый разбор границ периода для funnel-роутов.
//
// Даёт БЕРЛИНСКИЕ гражданские границы (а не UTC-полночь), чтобы фильтр
// `created_at` совпадал с недельной нарезкой когорт (isoWeekStartBerlin —
// тоже берлинская). Раньше каждый роут парсил дату через `Date.UTC(...)`
// (UTC-полночь) — это давало сдвиг ~на 2 часа на границе и «терялся»
// последний день (compute фильтрует `created_at < to`).
//
// Правая граница трактуется ВКЛЮЧИТЕЛЬНО: `funnelToExclusive("2026-05-31")`
// возвращает начало 2026-06-01 по Берлину, поэтому лиды за 31.05 попадают.
import { berlinCivilDate, addDaysCivil } from "@/lib/utils/date";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Нижняя граница: начало берлинского дня `raw`. null при плохом формате. */
export function funnelFrom(raw: string | null): Date | null {
  if (!raw || !YMD.test(raw)) return null;
  try {
    return berlinCivilDate(raw);
  } catch {
    return null;
  }
}

/** Верхняя граница (эксклюзивная): начало берлинского дня ПОСЛЕ `raw` —
 *  так выбранный последний день целиком входит в выборку. null при плохом формате. */
export function funnelToExclusive(raw: string | null): Date | null {
  if (!raw || !YMD.test(raw)) return null;
  try {
    return berlinCivilDate(addDaysCivil(raw, 1));
  } catch {
    return null;
  }
}
