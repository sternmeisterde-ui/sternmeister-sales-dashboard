// Авторизация при скачивании записи звонка зависит от провайдера (определяем
// по хосту ссылки, хранящейся в okk_calls.recording_url):
//   • CloudTalk (my.cloudtalk.io/api/calls/recording/…) — Basic-auth теми же
//     CLOUDTALK_API_ID:CLOUDTALK_API_SECRET, что и REST API. Без него — 401.
//   • CallGear  (app.callgear.com/system/media/…)        — ссылка-медиа отдаёт
//     аудио напрямую, доп. авторизация не нужна.
// Проверено на живых b2b-записях (Фаза 0). Используется и роутом проигрывания
// (/api/okk/audio), и выгрузкой звонков на Google Drive.

/** Заголовки авторизации для GET к recording_url данного провайдера.
 *  Пустой объект — авторизация не требуется (CallGear) или креды не заданы. */
export function recordingAuthHeaders(recordingUrl: string): Record<string, string> {
  let host = "";
  try {
    host = new URL(recordingUrl).host;
  } catch {
    return {};
  }

  if (host.includes("cloudtalk.io")) {
    const id = process.env.CLOUDTALK_API_ID;
    const secret = process.env.CLOUDTALK_API_SECRET;
    if (id && secret) {
      const basic = Buffer.from(`${id}:${secret}`).toString("base64");
      return { Authorization: `Basic ${basic}` };
    }
  }

  return {};
}
