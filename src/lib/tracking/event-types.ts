// ==================== Kommo event types (master list) ====================
// All event types the Tracking tab can display. Keys are Kommo's internal
// `type` field from /api/v4/events. The full canonical list comes from
// /api/v4/events/types?language_code=ru — labels match what Kommo returns.
//
// Categories:
//   - "call" → blue segment (has real duration via note.params.duration)
//   - "crm"  → green segment (instant, we treat as 1-minute activity block)
//
// Incoming/outgoing SMS/Email/chat are classified as "crm" (green), not
// "call" — calls means literal voice calls.

export type EventCategory = "call" | "crm";

export interface EventTypeDef {
  key: string;          // Kommo API type (stable)
  label: string;        // Russian label (matches /events/types output)
  category: EventCategory;
  group: string;        // UI grouping for the filter popup
}

export const EVENT_TYPES: EventTypeDef[] = [
  // ── Calls ──────────────────────────────────────────────────────────
  { key: "incoming_call", label: "Входящий звонок", category: "call", group: "Звонки" },
  { key: "outgoing_call", label: "Исходящий звонок", category: "call", group: "Звонки" },

  // ── Leads (sales) ──────────────────────────────────────────────────
  { key: "lead_added", label: "Новая сделка", category: "crm", group: "Сделки" },
  { key: "lead_deleted", label: "Сделка удалена", category: "crm", group: "Сделки" },
  { key: "lead_restored", label: "Сделка восстановлена", category: "crm", group: "Сделки" },
  { key: "lead_status_changed", label: "Изменение этапа продажи", category: "crm", group: "Сделки" },
  { key: "lead_linked", label: "Прикрепление сделки", category: "crm", group: "Сделки" },
  { key: "lead_unlinked", label: "Открепление сделки", category: "crm", group: "Сделки" },

  // ── Contacts ───────────────────────────────────────────────────────
  { key: "contact_added", label: "Новый контакт", category: "crm", group: "Контакты" },
  { key: "contact_deleted", label: "Контакт удален", category: "crm", group: "Контакты" },
  { key: "contact_restored", label: "Контакт восстановлен", category: "crm", group: "Контакты" },
  { key: "contact_linked", label: "Прикрепление контакта", category: "crm", group: "Контакты" },
  { key: "contact_unlinked", label: "Открепление контакта", category: "crm", group: "Контакты" },

  // ── Companies ──────────────────────────────────────────────────────
  { key: "company_added", label: "Новая компания", category: "crm", group: "Компании" },
  { key: "company_deleted", label: "Компания удалена", category: "crm", group: "Компании" },
  { key: "company_restored", label: "Компания восстановлена", category: "crm", group: "Компании" },
  { key: "company_linked", label: "Прикрепление компании", category: "crm", group: "Компании" },
  { key: "company_unlinked", label: "Открепление компании", category: "crm", group: "Компании" },

  // ── Customers ──────────────────────────────────────────────────────
  // NOTE: Kommo's /api/v4/events filter[entity] does NOT accept "customer"
  // (only lead/contact/company/task). These types exist in Kommo's catalogue
  // but are not currently fetchable by this account's API contract — the
  // entity loop in fetchRawEvents skips `customer`. They remain here so the
  // filter popup matches Simple Sales' UI; if Kommo enables customer scope
  // later, fetchRawEvents will start returning rows automatically.
  { key: "customer_added", label: "Новый покупатель", category: "crm", group: "Покупатели" },
  { key: "customer_deleted", label: "Покупатель удален", category: "crm", group: "Покупатели" },
  { key: "customer_status_changed", label: "Изменение этапа покупателя", category: "crm", group: "Покупатели" },
  { key: "customer_linked", label: "Прикрепление покупателя", category: "crm", group: "Покупатели" },
  { key: "customer_unlinked", label: "Открепление покупателя", category: "crm", group: "Покупатели" },

  // ── Tasks ──────────────────────────────────────────────────────────
  { key: "task_added", label: "Новая задача", category: "crm", group: "Задачи" },
  { key: "task_completed", label: "Завершение задачи", category: "crm", group: "Задачи" },
  { key: "task_deleted", label: "Задача удалена", category: "crm", group: "Задачи" },
  { key: "task_type_changed", label: "Изменение типа задачи", category: "crm", group: "Задачи" },
  { key: "task_deadline_changed", label: "Изменение даты исполнения задачи", category: "crm", group: "Задачи" },
  { key: "task_text_changed", label: "Изменение текста задачи", category: "crm", group: "Задачи" },
  { key: "task_result_added", label: "Результат по задаче", category: "crm", group: "Задачи" },

  // ── Communications (non-call) ──────────────────────────────────────
  { key: "incoming_chat_message", label: "Входящее сообщение", category: "crm", group: "Коммуникации" },
  { key: "outgoing_chat_message", label: "Исходящее сообщение", category: "crm", group: "Коммуникации" },
  { key: "entity_direct_message", label: "Внутреннее сообщение", category: "crm", group: "Коммуникации" },
  { key: "incoming_mail", label: "Входящее письмо", category: "crm", group: "Коммуникации" },
  { key: "outgoing_mail", label: "Исходящее письмо", category: "crm", group: "Коммуникации" },
  { key: "incoming_sms", label: "Входящее SMS", category: "crm", group: "Коммуникации" },
  { key: "outgoing_sms", label: "Исходящее SMS", category: "crm", group: "Коммуникации" },

  // ── Tags / segments / retargeting ─────────────────────────────────
  { key: "entity_tag_added", label: "Теги добавлены", category: "crm", group: "Теги и сегменты" },
  { key: "entity_tag_deleted", label: "Теги убраны", category: "crm", group: "Теги и сегменты" },
  { key: "entity_linked", label: "Прикрепление", category: "crm", group: "Теги и сегменты" },
  { key: "entity_unlinked", label: "Открепление", category: "crm", group: "Теги и сегменты" },
  { key: "entity_segment_attached", label: "Добавлен в сегмент", category: "crm", group: "Теги и сегменты" },
  { key: "entity_segment_detached", label: "Удалён из сегмента", category: "crm", group: "Теги и сегменты" },
  { key: "segment_created", label: "Сегмент создан", category: "crm", group: "Теги и сегменты" },
  { key: "targeting_in_note_added", label: "Добавление в ретаргетинг", category: "crm", group: "Теги и сегменты" },
  { key: "targeting_out_note_added", label: "Удаление из ретаргетинга", category: "crm", group: "Теги и сегменты" },

  // ── Field changes ──────────────────────────────────────────────────
  { key: "entity_responsible_changed", label: "Ответственный изменен", category: "crm", group: "Изменения полей" },
  { key: "sale_field_changed", label: "Изменение поля \"Бюджет\"", category: "crm", group: "Изменения полей" },
  { key: "name_field_changed", label: "Изменение поля \"Название\"", category: "crm", group: "Изменения полей" },
  // Generic AND per-id (`custom_field_<ID>_value_changed`) collapse into this
  // for selection. Normalisation happens in timeline.ts so timed activity
  // counts every per-field event under one filter checkbox.
  { key: "custom_field_value_changed", label: "Изменение поля", category: "crm", group: "Изменения полей" },
  { key: "ltv_field_changed", label: "Сумма покупок", category: "crm", group: "Изменения полей" },
  { key: "intent_identified", label: "Тема вопроса определена", category: "crm", group: "Изменения полей" },

  // ── Notes / files / media ─────────────────────────────────────────
  { key: "common_note_added", label: "Новое примечание", category: "crm", group: "Примечания и файлы" },
  { key: "common_note_deleted", label: "Примечание удалено", category: "crm", group: "Примечания и файлы" },
  { key: "geo_note_added", label: "Новое примечание с гео-меткой", category: "crm", group: "Примечания и файлы" },
  { key: "service_note_added", label: "Новое системное примечание", category: "crm", group: "Примечания и файлы" },
  { key: "attachment_note_added", label: "Добавлен новый файл", category: "crm", group: "Примечания и файлы" },
  { key: "dropbox_attachment", label: "Файл Dropbox", category: "crm", group: "Примечания и файлы" },
  { key: "picture_opened", label: "Картинка была открыта", category: "crm", group: "Примечания и файлы" },
  { key: "picture_closed", label: "Картинка была закрыта", category: "crm", group: "Примечания и файлы" },
  { key: "video_opened", label: "Видео было открыто", category: "crm", group: "Примечания и файлы" },
  { key: "video_closed", label: "Видео было закрыто", category: "crm", group: "Примечания и файлы" },

  // ── Site / links / visits ─────────────────────────────────────────
  { key: "link_followed", label: "Переход по ссылке", category: "crm", group: "Сайт и ссылки" },
  { key: "site_visit_note_added", label: "Заход на сайт", category: "crm", group: "Сайт и ссылки" },
  { key: "page_mention", label: "Упоминание страницы", category: "crm", group: "Сайт и ссылки" },

  // ── Purchases / invoices / NPS ────────────────────────────────────
  { key: "transaction_added", label: "Покупка", category: "crm", group: "Продажи и счета" },
  { key: "invoice_paid", label: "При оплате счета/покупки", category: "crm", group: "Продажи и счета" },
  { key: "invoice_created", label: "Счет/покупка создана", category: "crm", group: "Продажи и счета" },
  { key: "nps_rate_added", label: "Новая оценка NPS", category: "crm", group: "Продажи и счета" },
  { key: "message_to_cashier_note_added", label: "Сообщение кассиру", category: "crm", group: "Продажи и счета" },

  // ── Automation / robot / AI ───────────────────────────────────────
  { key: "robot_replied", label: "Ответ робота", category: "crm", group: "Автоматизация и AI" },
  { key: "ai_result", label: "Kommo AI", category: "crm", group: "Автоматизация и AI" },
  { key: "key_action_completed", label: "Ключевое действие", category: "crm", group: "Автоматизация и AI" },

  // ── Talks / conversations ─────────────────────────────────────────
  { key: "talk_created", label: "Беседа создана", category: "crm", group: "Беседы" },
  { key: "talk_closed", label: "Беседа закрыта", category: "crm", group: "Беседы" },
  { key: "conversation_answered", label: "Не требует ответа", category: "crm", group: "Беседы" },
  { key: "talk_missed_event", label: "Превышено время на ответ", category: "crm", group: "Беседы" },
  { key: "meta_chat_subscription_added", label: "подписан на", category: "crm", group: "Беседы" },
  { key: "meta_chat_subscription_removed", label: "Unsubscribed from", category: "crm", group: "Беседы" },

  // ── Misc ──────────────────────────────────────────────────────────
  { key: "entity_merged", label: "Выполнено объединение", category: "crm", group: "Прочее" },
  { key: "zoom_conference", label: "Zoom conference", category: "crm", group: "Прочее" },
];

export const EVENT_TYPE_MAP: Record<string, EventTypeDef> = Object.fromEntries(
  EVENT_TYPES.map((t) => [t.key, t]),
);

export const CALL_TYPES = new Set<string>(
  EVENT_TYPES.filter((t) => t.category === "call").map((t) => t.key),
);

/** Default selection for the filter popup — all CRM types initially ON. */
export const DEFAULT_SELECTED_KEYS: string[] = EVENT_TYPES
  .filter((t) => t.category === "crm")
  .map((t) => t.key);

// Kommo emits one event type per custom field (e.g. `custom_field_879824_value_changed`)
// IN ADDITION to the generic `custom_field_value_changed`. The per-id variants don't
// appear in EVENT_TYPES (there are 200+ of them, account-specific). Normalise them to
// the generic so a single filter checkbox covers all field-change activity.
const CUSTOM_FIELD_PER_ID = /^custom_field_\d+_value_changed$/;

export function normalizeEventType(rawType: string): string {
  if (CUSTOM_FIELD_PER_ID.test(rawType)) return "custom_field_value_changed";
  return rawType;
}
