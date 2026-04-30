# Dashboard → «AI Ролевки» — как работает

Last updated: 2026-04-30

Список AI-роле­вых тренировочных звонков (менеджер vs AI-аватар, через LiveKit + Grok). Доступен всем авторизованным; менеджеры видят только свои ролевки, admin/rop — все.

> Важно: **этот раздел рендерится инлайн в `src/app/page.tsx`** (вместе с разделом «ОКК»), не отдельным компонентом. Использует общий список колонок и попап деталей с разделом «ОКК», но source = `aiCalls` вместо `realCalls`.

## Источники данных

Источник зависит от department: B2G читает из **D1**, B2B — из **R1** (`getDbForDepartment(dept)`). Структура таблиц идентичная.

| DB connection | Таблица | Зачем нужна тут | Ключевые колонки |
|---|---|---|---|
| **D1** (B2G) или **R1** (B2B) | `d1_calls` / `r1_calls` | AI-роле­вой звонок с транскриптом и оценкой | `id`, `user_id` (FK на `d1_users`/`r1_users`), `avatar_id` (FK на `d1_avatars`/`r1_avatars`), `started_at`, `ended_at`, `duration_seconds`, `transcript`, `generated_prompt`, `evaluation_json` (тот же формат что в OKK: `{blocks[], total_score, total_max_score, summary}`), `score` (0-100), `mistakes`, `recommendations`, `grok_session_id`, `livekit_room_id`, `recording_path`, `recording_expires_at`, `call_type` |
| **D1** / **R1** | `d1_users` / `r1_users` | Менеджер, который проходил ролевку | `id`, `telegram_id`, `name`, `team` (`dima`/`ruzanna`/`all`), `role` (`manager`/`rop`/`admin`), `line`, `kommo_user_id`, `is_active` |
| **D1** / **R1** | `d1_avatars` / `r1_avatars` | AI-аватар клиента, с которым ролевка | `id`, `data` (jsonb: персона, скрипт, voice_id), `is_active` |

> Связь с master_managers: `d1_users.telegram_id` ↔ `master_managers.telegram_id`. Синхронизация в обе стороны через `inRolevki` флаг и API `/api/managers`. См. `DASHBOARD-MANAGERS.md`.

## Layout (инлайн в page.tsx)

Идентичен разделу «ОКК», но другой data source. Различия:

1. В таблице **нет** колонки `call_number` (это OKK-специфика)
2. **Нет** Client scoring в попапе
3. Нет фильтра по линии (роле­вки не теггируются sub-line `2a`/`2b` — collapse в `2`)
4. В попапе показывается **`generated_prompt`** — что AI знал про клиента (промпт ролевки)
5. **`call_type`** показывается явно: тип ролевки (primary/followup/...) — определяет правила оценки
6. Recording из `recording_path` имеет TTL (`recording_expires_at`) — после истечения аудио недоступно

## Where it appears in analytics

- **Аналитика** (`AnalyticsTab`): source `roleplay` — берёт из этих же таблиц
- **Daily**: ролевки участвуют в метрике «количество ролевок» по менеджеру

## Edge cases / gotchas

- **R1 connection**: `R1_DATABASE_URL` может не быть в .env — в этом случае `src/lib/db/index.ts` авто-производит её из `DATABASE_URL` через swap Neon-branch endpoint.
- Юзеры роле­вок ≠ master_managers напрямую — связаны через `telegram_id`. Если у master_managers строки нет `telegramId`, в роле­вки не синкается. См. `project_yulia_smirnova_roleplay_only.md` в memory: пример менеджера, который только в роле­вках (без Kommo).
- Sub-lines `2a`/`2b` в B2G не теггируются на роле­вки — Аналитика принудительно collapse'ит их в group `2` перед запросом.
- `evaluation_json.client_scoring` отсутствует — это OKK-only поле.

## Файлы

- UI: `src/app/page.tsx` (блок `activeTab === "ai_calls"` — общий с `real_calls` блок около строк 793-1700+)
- API: запросы идут через тот же `/api/okk/*` слой? **Нет** — для AI-роле­вок отдельные queries в `src/lib/db/queries-*` или прямо в `page.tsx` через actions. Уточнить при разметке MCP-слоя.
- Schema: `src/lib/db/schema-existing.ts` (таблицы `d1Calls`, `r1Calls`, `d1Users`, `r1Users`, `d1Avatars`, `r1Avatars`, строки 6-124)
- Связанные docs: `DASHBOARD-MANAGERS.md` (sync `inRolevki` флага), `DASHBOARD-OKK.md` (родственный раздел)
