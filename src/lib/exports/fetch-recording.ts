// Скачивание записи звонка по ссылке из okk_calls.recording_url.
// Авторизация подбирается по провайдеру (CloudTalk Basic / CallGear плейн) —
// см. src/lib/telephony/recordings.ts. Возвращает байты + content-type.

import { recordingAuthHeaders } from "@/lib/telephony/recordings";

export interface DownloadedRecording {
  buffer: Buffer;
  contentType: string;
}

export async function downloadRecording(url: string): Promise<DownloadedRecording> {
  const resp = await fetch(url, { headers: recordingAuthHeaders(url) });
  if (!resp.ok) {
    throw new Error(`Запись недоступна (${resp.status}) ${new URL(url).host}`);
  }
  const buffer = Buffer.from(await resp.arrayBuffer());
  if (buffer.length === 0) throw new Error("Пустой файл записи");
  const contentType = resp.headers.get("content-type") || "audio/mpeg";
  return { buffer, contentType };
}

/** Расширение файла записи по content-type (для имени на Drive). */
export function audioExt(contentType: string): string {
  if (contentType.includes("wav")) return "wav";
  if (contentType.includes("ogg")) return "ogg";
  if (contentType.includes("mp4") || contentType.includes("m4a")) return "m4a";
  return "mp3"; // CloudTalk отдаёт octet-stream, CallGear — audio/mpeg → mp3
}
