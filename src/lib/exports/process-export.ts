// Воркер выгрузки звонков контакта на Google Drive.
//
// Берёт pending-строки из analytics.contact_call_exports (их кладёт ETL-шаг
// detect-won-exports), для каждой собирает звонки контакта из R2 okk_calls
// (аудио + транскрипт), создаёт папку «{Имя} {дата оплаты}» на Drive и заливает
// файлы, проставляя done/error.
//
// Идемпотентность на всех уровнях, поэтому пересечение двух тиков безопасно:
//   • ensureFolder — find-or-create по имени;
//   • fileExists  — пропуск уже залитого файла;
//   • статус строки переводится в done только после полной обработки.

import { analyticsDb } from "@/lib/db/analytics";
import { getOkkDbForDepartment } from "@/lib/db/okk";
import { sql } from "drizzle-orm";
import { APP_TZ } from "@/lib/utils/date";
import { ensureRootFolder, ensureFolder, fileExists, uploadFile, isGdriveConfigured } from "@/lib/gdrive/client";
import { downloadRecording, audioExt } from "./fetch-recording";

// `& Record<string, unknown>` — db.execute<T> требует индексной сигнатуры.
export type ExportRow = {
  lead_id: number;
  contact_id: number | null;
  contact_name: string | null;
  payment_date: string | null;
} & Record<string, unknown>;

type OkkCallRow = {
  id: string;
  recording_url: string | null;
  transcript: string | null;
  direction: string | null;
  file_stamp: string | null; // 'YYYY-MM-DD_HH-MI' в Berlin
} & Record<string, unknown>;

export interface ProcessResult {
  processed: number;
  done: number;
  errors: number;
  skipped: boolean; // true → Drive не настроен, ничего не делали
}

// Только цифры, последние 10 — для сравнения телефонов разного формата.
function phoneKey(p: string): string {
  return p.replace(/\D/g, "").slice(-10);
}

function safeName(s: string): string {
  // Имя папки/файла без символов, ломающих Drive/ФС.
  return s.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
}

/** Собрать папку контакта на Drive по одной строке очереди (аудио +
 *  транскрипты). Бросает при фатальной ошибке (ловит вызывающий). Идемпотентно. */
export async function exportContactCalls(row: ExportRow): Promise<{ callCount: number; uploaded: number; folderId: string }> {
  const okkDb = getOkkDbForDepartment("b2b");

  // 1. Телефоны контакта и все его сделки — чтобы поймать ВСЕ звонки контакта,
  //    а не только по won-сделке (matchим okk_calls по lead_id ИЛИ телефону).
  let phoneKeys: string[] = [];
  let leadIds: number[] = [row.lead_id];
  if (row.contact_id != null) {
    const meta = await analyticsDb.execute<{ phone: string | null; phones_all: unknown }>(sql`
      SELECT phone, phones_all FROM analytics.contacts WHERE contact_id = ${row.contact_id} LIMIT 1
    `);
    const m = meta.rows[0];
    const phones = new Set<string>();
    if (m?.phone) phones.add(m.phone);
    if (Array.isArray(m?.phones_all)) for (const p of m!.phones_all as unknown[]) if (typeof p === "string") phones.add(p);
    phoneKeys = [...phones].map(phoneKey).filter((p) => p.length >= 7);

    const links = await analyticsDb.execute<{ lead_id: number }>(sql`
      SELECT lead_id FROM analytics.lead_contact_links
      WHERE contact_id = ${row.contact_id} AND is_active = true
    `);
    const ids = new Set<number>(leadIds);
    for (const l of links.rows) ids.add(l.lead_id);
    leadIds = [...ids];
  }

  // 2. Звонки контакта в R2 okk_calls с записью.
  const matchParts = [sql`kommo_lead_id IN (${sql.join(leadIds.map((i) => sql`${String(i)}`), sql`, `)})`];
  if (phoneKeys.length > 0) {
    matchParts.push(sql`right(regexp_replace(coalesce(contact_phone,''), '\\D', '', 'g'), 10) IN (${sql.join(phoneKeys.map((p) => sql`${p}`), sql`, `)})`);
  }
  const calls = await okkDb.execute<OkkCallRow>(sql`
    SELECT id, recording_url, transcript, direction,
           to_char((call_created_at AT TIME ZONE ${APP_TZ}), 'YYYY-MM-DD_HH24-MI') AS file_stamp
    FROM calls
    WHERE recording_url IS NOT NULL
      AND (${sql.join(matchParts, sql` OR `)})
    ORDER BY call_created_at ASC
  `);

  // 3. Папка «{Имя} {дата оплаты}» под корневой папкой приложения.
  const name = safeName(`${row.contact_name ?? "Контакт " + row.lead_id} ${row.payment_date ?? ""}`);
  const rootId = await ensureRootFolder();
  const folderId = await ensureFolder(name, rootId);

  // 4. Заливаем записи (+ транскрипты). Имя по времени звонка, чтобы не
  //    пересекались; при дубле имени добавляем хвост id звонка.
  let uploaded = 0;
  const usedNames = new Set<string>();
  for (const c of calls.rows) {
    if (!c.recording_url) continue;
    const dir = c.direction === "inbound" ? "in" : c.direction === "outbound" ? "out" : "call";
    let base = `${c.file_stamp ?? "no-date"}_${dir}`;
    if (usedNames.has(base)) base = `${base}_${c.id.slice(0, 8)}`;
    usedNames.add(base);

    try {
      const rec = await downloadRecording(c.recording_url);
      const audioName = `${base}.${audioExt(rec.contentType)}`;
      if (!(await fileExists(folderId, audioName))) {
        await uploadFile(folderId, audioName, rec.contentType, rec.buffer);
      }
      uploaded++;
      if (c.transcript && c.transcript.trim().length > 0) {
        const txtName = `${base}.txt`;
        if (!(await fileExists(folderId, txtName))) {
          await uploadFile(folderId, txtName, "text/plain; charset=utf-8", Buffer.from(c.transcript, "utf-8"));
        }
      }
    } catch (e) {
      // Одна недоступная запись не валит всю папку — логируем и идём дальше.
      console.warn(`[export] lead ${row.lead_id} call ${c.id}: ${e instanceof Error ? e.message : e}`);
    }
  }

  return { callCount: calls.rows.length, uploaded, folderId };
}

/** Обработать до `limit` ожидающих выгрузок. */
export async function processPendingExports(limit = 5): Promise<ProcessResult> {
  if (!isGdriveConfigured()) {
    return { processed: 0, done: 0, errors: 0, skipped: true };
  }

  const pending = await analyticsDb.execute<ExportRow>(sql`
    SELECT lead_id, contact_id, contact_name, payment_date
    FROM analytics.contact_call_exports
    WHERE status = 'pending'
    ORDER BY detected_at ASC
    LIMIT ${limit}
  `);

  let done = 0;
  let errors = 0;
  for (const row of pending.rows) {
    try {
      const r = await exportContactCalls(row);
      await analyticsDb.execute(sql`
        UPDATE analytics.contact_call_exports
        SET status = 'done', gdrive_folder_id = ${r.folderId},
            folder_name = ${safeName(`${row.contact_name ?? "Контакт " + row.lead_id} ${row.payment_date ?? ""}`)},
            call_count = ${r.callCount}, uploaded_count = ${r.uploaded},
            attempts = attempts + 1, error = NULL,
            completed_at = NOW(), updated_at = NOW()
        WHERE lead_id = ${row.lead_id}
      `);
      done++;
    } catch (e) {
      errors++;
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      await analyticsDb.execute(sql`
        UPDATE analytics.contact_call_exports
        SET status = 'error', error = ${msg}, attempts = attempts + 1, updated_at = NOW()
        WHERE lead_id = ${row.lead_id}
      `);
      console.error(`[export] lead ${row.lead_id} failed:`, e);
    }
  }

  return { processed: pending.rows.length, done, errors, skipped: false };
}
