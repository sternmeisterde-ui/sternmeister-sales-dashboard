// ==================== Kommo event types (master list) ====================
// Curated to ONLY include events that actually fire on sternmeister.kommo.com.
// Initial list was 81 entries pulled from Kommo's public catalogue; 40 of them
// were dropped after a 4-month backfill (2026-01-01 → 2026-04-28) showed zero
// events on either b2g or b2b. The 41 remaining all have ≥1 occurrence in the
// cache, so the filter dropdown only shows what's real.
//
// If a feature gets enabled later (Zoom, NPS, segments, retargeting, AI bots,
// SMS, etc.) — restore the relevant entry from git history and bump filter_-
// version so a re-backfill picks up the missing window. Reference for full
// canonical names: GET /api/v4/events/types?language_code=ru.
//
// Categories:
//   - "call" → blue segment (real duration via /notes endpoint)
//   - "crm"  → green segment (instant; 1-minute activity block in render)

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
  // Kommo emits `entity_linked` / `entity_unlinked` for ALL link operations,
  // with the actual scope in the entity_type column. The UI labels stay
  // entity-specific (Прикрепление сделки/контакта/компании) for clarity —
  // timeline.ts expands `lead_linked` etc. to match `entity_linked` rows
  // where entity_type='lead' at render time.
  { key: "lead_linked", label: "Прикрепление сделки", category: "crm", group: "Сделки" },
  { key: "lead_unlinked", label: "Открепление сделки", category: "crm", group: "Сделки" },

  // ── Contacts ───────────────────────────────────────────────────────
  { key: "contact_added", label: "Новый контакт", category: "crm", group: "Контакты" },
  { key: "contact_deleted", label: "Контакт удален", category: "crm", group: "Контакты" },
  { key: "contact_restored", label: "Контакт восстановлен", category: "crm", group: "Контакты" },
  { key: "contact_linked", label: "Прикрепление контакта", category: "crm", group: "Контакты" },
  { key: "contact_unlinked", label: "Открепление контакта", category: "crm", group: "Контакты" },

  // ── Companies ──────────────────────────────────────────────────────
  // company_deleted / company_restored never fired in 4 months — dropped to
  // keep the dropdown honest. Add back if a deletion happens on this account.
  { key: "company_added", label: "Новая компания", category: "crm", group: "Компании" },
  { key: "company_linked", label: "Прикрепление компании", category: "crm", group: "Компании" },
  { key: "company_unlinked", label: "Открепление компании", category: "crm", group: "Компании" },

  // ── Tasks ──────────────────────────────────────────────────────────
  { key: "task_added", label: "Новая задача", category: "crm", group: "Задачи" },
  { key: "task_completed", label: "Завершение задачи", category: "crm", group: "Задачи" },
  { key: "task_deleted", label: "Задача удалена", category: "crm", group: "Задачи" },
  { key: "task_type_changed", label: "Изменение типа задачи", category: "crm", group: "Задачи" },
  { key: "task_deadline_changed", label: "Изменение даты исполнения задачи", category: "crm", group: "Задачи" },
  { key: "task_text_changed", label: "Изменение текста задачи", category: "crm", group: "Задачи" },
  { key: "task_result_added", label: "Результат по задаче", category: "crm", group: "Задачи" },

  // ── Communications (non-call) ──────────────────────────────────────
  // Kommo on this account emits OUTGOING chat/mail but never INCOMING via
  // /events — incoming chat presumably surfaces through talks (talk_closed
  // / conversation_answered). incoming/outgoing SMS unused.
  { key: "outgoing_chat_message", label: "Исходящее сообщение", category: "crm", group: "Коммуникации" },
  { key: "entity_direct_message", label: "Внутреннее сообщение", category: "crm", group: "Коммуникации" },
  { key: "incoming_mail", label: "Входящее письмо", category: "crm", group: "Коммуникации" },
  { key: "outgoing_mail", label: "Исходящее письмо", category: "crm", group: "Коммуникации" },

  // ── Tags / links ───────────────────────────────────────────────────
  // Segment / retargeting events never fired — features not configured.
  { key: "entity_tag_added", label: "Теги добавлены", category: "crm", group: "Теги и связи" },
  { key: "entity_tag_deleted", label: "Теги убраны", category: "crm", group: "Теги и связи" },
  { key: "entity_linked", label: "Прикрепление", category: "crm", group: "Теги и связи" },
  { key: "entity_unlinked", label: "Открепление", category: "crm", group: "Теги и связи" },

  // ── Field changes ──────────────────────────────────────────────────
  // ltv_field_changed (Сумма покупок) и intent_identified (Тема вопроса) —
  // not used on this account.
  { key: "entity_responsible_changed", label: "Ответственный изменен", category: "crm", group: "Изменения полей" },
  { key: "sale_field_changed", label: "Изменение поля \"Бюджет\"", category: "crm", group: "Изменения полей" },
  { key: "name_field_changed", label: "Изменение поля \"Название\"", category: "crm", group: "Изменения полей" },
  // Generic and per-id (`custom_field_<ID>_value_changed`) collapse into this
  // for selection. Normalisation happens in timeline.ts so a single checkbox
  // counts every per-field event.
  { key: "custom_field_value_changed", label: "Изменение поля", category: "crm", group: "Изменения полей" },

  // ── Notes ──────────────────────────────────────────────────────────
  // geo_note_added / service_note_added / dropbox_attachment / picture_* /
  // video_* — not used on this account.
  { key: "common_note_added", label: "Новое примечание", category: "crm", group: "Примечания" },
  { key: "common_note_deleted", label: "Примечание удалено", category: "crm", group: "Примечания" },
  { key: "attachment_note_added", label: "Добавлен новый файл", category: "crm", group: "Примечания" },

  // ── Talks ──────────────────────────────────────────────────────────
  // talk_created never fires on /events — it's possibly webhook-only on
  // this account, so we infer talks via talk_closed / conversation_answered.
  // talk_missed_event and meta_chat_subscription_* — not used.
  { key: "talk_closed", label: "Беседа закрыта", category: "crm", group: "Беседы" },
  { key: "conversation_answered", label: "Не требует ответа", category: "crm", group: "Беседы" },

  // ── Misc ───────────────────────────────────────────────────────────
  { key: "entity_merged", label: "Выполнено объединение", category: "crm", group: "Прочее" },
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

// Kommo emits one event type per custom field (e.g. `custom_field_879824_value_changed`).
// Per-id variants don't appear in EVENT_TYPES (200+ of them, account-specific).
// Normalise them to the generic so a single filter checkbox covers all field
// changes. Kommo also emits the bare `custom_field_value_changed` rarely on
// this account; both flow through this same key.
const CUSTOM_FIELD_PER_ID = /^custom_field_\d+_value_changed$/;

export function normalizeEventType(rawType: string): string {
  if (CUSTOM_FIELD_PER_ID.test(rawType)) return "custom_field_value_changed";
  return rawType;
}
