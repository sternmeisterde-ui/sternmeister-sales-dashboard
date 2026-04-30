# Dashboard → «ОКК» (Реальные звонки) — как работает

Last updated: 2026-04-30

Список реальных оценённых звонков (из CallGear/CloudTalk → транскрипт → AI-оценка). Доступен всем авторизованным; менеджеры видят только свои звонки, admin/rop — все.

> Важно: **этот раздел — единственный, который рендерится не отдельным компонентом, а инлайн в `src/app/page.tsx`** (вместе с разделом «AI Ролевки»). Список колонок, фильтры и попап с деталью — всё там.

## Источники данных

Раздел читает из **OKK-базы выбранного отдела**: D2 для B2G, R2 для B2B (`getOkkDbForDepartment(dept)`).

| DB connection | Таблица | Зачем нужна тут | Ключевые колонки |
|---|---|---|---|
| **D2** / **R2** | `calls` | Источник звонка (запись, транскрипт, направление, длительность, Kommo-связи) | `id`, `manager_id`, `manager_name`, `contact_phone`, `duration_seconds`, `direction` (`inbound`/`outbound`), `recording_url`, `audio_path`, `transcript`, `transcript_speakers` (jsonb массив сегментов), `kommo_lead_id`, `kommo_lead_url`, `kommo_status_name`, `status` (`pending`/`evaluated`/`error`), `call_created_at` |
| **D2** / **R2** | `evaluations` | AI-оценка звонка с разбиением по блокам и критериям | `call_id` (FK), `manager_id`, `prompt_type`, `total_score` (0-100), `evaluation_json` (структура `{blocks[], total_score, total_max_score, summary, client_scoring}`), `mistakes`, `recommendations`, `model_used`, `tokens_used`, `call_number`, `override_metadata` (Phase-2 jsonb) |
| **D2** / **R2** | `managers` | Имя/линия/команда менеджера для фильтра и подписи | `id`, `name`, `line` (`1`/`2`/`3`), `role` (`manager`/`rop`), `is_active`, `kommo_user_id` |
| **D2** / **R2** | `voice_feedback` | Голосовой ответ менеджера на оценку (если был) | `call_id`, `transcript`, `ai_response` |

> **Фильтр отображения**: в UI и API показываются только калы где `total_score IS NOT NULL` (т.е. оценённые) И `manager_id IS NOT NULL` (нет orphan-калов). См. CLAUDE.md «OKK Calls Display».

## Layout (инлайн в page.tsx)

1. **Top filters**: департамент (B2G/B2B), линия (1/2/3 для B2G), period (день/неделя/месяц), дата
2. **KPI tiles**: всего звонков, средний балл, % успешных
3. **Per-manager bar**: количество звонков каждого менеджера
4. **Таблица звонков** (CallsChart + ниже основная таблица):
   - Колонки: дата, менеджер, длительность, **call_number** (порядковый номер D1, R1...), score, статус (`evaluated`/`pending`/`error`), кнопка «Открыть»
5. **Попап деталей звонка** (открывается по клику):
   - Аудио-плеер (`/api/okk/audio/[callId]` — подписанный URL)
   - Транскрипт по сегментам (Speaker A vs B — labels зависят от `direction`: outbound = Speaker A — клиент, inbound = Speaker A — менеджер)
   - Блоки оценки + критерии + цитаты + recommendations / mistakes
   - **Client scoring** (только для real_calls): urgency / solvency / need / total
   - Voice feedback менеджера (если есть)

## API

- `GET /api/okk/calls?department=<b2g|b2b>&...filters` — список звонков. Ограничения видимости по роли применяются на бэке.
- `GET /api/okk/calls/[callId]?department=<>` — деталь звонка с full evaluation_json.
- `GET /api/okk/audio/[callId]?department=<>` — стрим аудио (signed URL или прокси).
- `GET /api/okk/worst-calls?department=<>` — топ-N худших звонков за день (для шторки `WorstCallsPanel`).

## Edge cases / gotchas

- B2G линии: `1` = квалификатор, `2` = бератер, `3` = доведение. Менеджеры с `role='rop'` (например ) **включаются** в выдачу как участники линии.
- Speaker labelling зависит от `direction` колонки `calls`. Если `direction` NULL — показывается raw `Speaker A/B` без замены.
- `call_number` в таблице — порядковый номер звонка менеджера в этой OKK-DB (D1, D2, ...), берётся из `evaluations.call_number`. Заполняется бэкендом OKK при оценке.
- `transcript_speakers` отсутствует на старых звонках до миграции на сегментированный транскрипт — UI fall-back на plain `transcript`.

## Файлы

- UI: `src/app/page.tsx` (см. блок `activeTab === "real_calls"` — около строк 793-1700+), `src/components/CallsChart.tsx`, `src/components/WorstCallsPanel.tsx`
- API: `src/app/api/okk/calls/route.ts`, `src/app/api/okk/calls/[callId]/route.ts`, `src/app/api/okk/audio/[callId]/route.ts`, `src/app/api/okk/worst-calls/route.ts`
- Schema: `src/lib/db/schema-okk.ts` (таблицы `okkCalls`, `okkEvaluations`, `okkManagers`, `okkVoiceFeedback`)
- Связанные docs: `DASHBOARD-AUDIT.md` (диагностика того же пула звонков)
