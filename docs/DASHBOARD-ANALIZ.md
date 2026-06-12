# Dashboard → «Анализ» — как работает

Last updated: 2026-06-12

Batch-анализ звонков из Kommo-воронки: загружает по URL воронки массив звонков, транскрибирует (ElevenLabs Scribe v2), прогоняет каждый через Grok, выдаёт markdown-summary паттернов по «успешным»/«неуспешным» лидам. Admin-only.

## Источники данных

| DB connection | Таблица | Зачем нужна тут | Ключевые колонки |
|---|---|---|---|
| **D1** (общая БД, `DATABASE_URL`) | `call_analyses` | Заявка на анализ + статус прогона | `id` (uuid), `department` (`b2g`/`b2b`), `kommo_url`, `mode` (`success`/`failure`), `status` (`pending`/`processing`/`done`/`error`/`cancelled`), `progress` (0-100), `total_calls`, `processed_calls`, `result_summary` (markdown от Grok), `error_message` (двойная роль: текст ошибки ИЛИ статусная строка прогресса), `created_by`, `created_at`, `updated_at` (**heartbeat**, каждые ~20с), `expires_at` |
| **D1** | `call_analysis_files` | Транскрипты + сводка + **чекпоинт** конкретного прогона (FK на `call_analyses.id`) | `analysis_id`, `filename`, `content` (markdown / JSON), `file_type` (`transcript`/`summary`/`index`/**`manifest`**), `lead_id`, `call_score`. Unique `(analysis_id, filename)` |

> Анализы хранятся в **D1** (B2G-DB) даже когда `department='b2b'` — единая таблица для обоих отделов. Поэтому очередь воркера — глобальная на оба отдела.

> Внешние данные: **Kommo API** (лиды + call-notes), запись звонка по URL из note, ElevenLabs Scribe v2 (STT), xAI Grok (анализ).

## Архитектура воркера (с 2026-06: cron-driven, чанки, чекпоинты)

```
Юзер вводит Kommo-URL → POST /api/analysis → INSERT call_analyses (status='pending')
                          фронт сразу дёргает GET /api/analysis/process («kick», мгновенный старт)
   ↓
analysis-cron (docker-compose, curl каждые 60с)
   → GET /api/analysis/process/tick (x-cron-secret)
   → claimNextAnalysis() — атомарный UPDATE..RETURNING (src/lib/analysis/worker.ts):
        • single-flight: НЕ берёт ничего, пока другой джоб жив (updated_at < 2 мин)
        • resume-first: прерванный processing (stale heartbeat) раньше новых pending (FIFO)
   ↓
runAnalysisPipeline(id, softDeadline≈20мин)  ← отвязан от ответа через after()
   1) leads из Kommo  ──→ чекпоинт: _manifest.json (file_type='manifest')
   2) скан call-notes по сделкам ──→ чекпоинт каждые 25 сделок (scannedLeadIds, foundCalls)
   3) заморозка списка звонков (dedup, cap 500) → manifest.phase='calls' (фиксирует нумерацию call_NN)
   4) транскрибация+Grok по звонкам (resume = skip существующих файлов)
   5) SUMMARY.md → status='done' → манифест удаляется
   — на soft deadline: чекпоинт + yield (status='processing', updated_at backdated) → следующий тик продолжает
   ↓
Фронт — только viewer: поллит список каждые 5с, SSE больше нет.
```

### Liveness / защита от зависаний

- **Heartbeat внутри пайплайна** (не в роуте!): каждые 20с `UPDATE..SET updated_at=now() WHERE status='processing' RETURNING id`. Ноль строк в ответе = джоб отменён/удалён → воркеры дренятся.
- **Hard deadline** (soft + 45 мин): heartbeat сам останавливается → замороженный пайплайн протухает и переклеймливается следующим тиком. `maxDuration` на self-hosted standalone **не действует** (Vercel-hint).
- Stale = `updated_at` старше 2 мин (см. claim). Yield backdate'ит на 3 мин, чтобы продолжение началось со следующего тика без ожидания.
- Сбой Kommo при скане >10% сделок → НЕ замораживаем список, авто-повтор; после 3 неудачных чанков подряд → `status='error'` с громким сообщением.

## API

- `POST /api/analysis` — admin. Body: `{ department, kommoUrl, mode, minDuration }`. Создаёт pending row.
- `GET /api/analysis?department=<b2g|b2b>` — admin. 50 последних анализов.
- `GET /api/analysis/process` — admin. **JSON-kick**: claim + запуск одного чанка, мгновенный ответ `{claimed|idle}`.
- `GET /api/analysis/process/tick` — **CRON_SECRET** (`x-cron-secret`), без сессии (whitelist в `src/middleware.ts`, exact-match). То же, что kick.
- `GET /api/analysis/[id]` — admin. Деталь: full row + files[] (манифест исключён).
- `GET /api/analysis/[id]/download` — admin. Все файлы одним .md (манифест исключён).
- `POST /api/analysis/[id]/cancel` — admin. pending/processing → `cancelled`; работающий пайплайн замечает ≤20с через heartbeat; файлы и чекпоинт сохраняются.
- `POST /api/analysis/[id]/resume` — admin. `error`/`cancelled` → `pending` (продолжит с чекпоинта/готовых файлов).
- `DELETE /api/analysis/[id]/delete` — admin. Полное удаление (CASCADE).

## Env / compose

- `analysis-cron` сервис в `docker-compose.yml` — curl-loop, `ANALYSIS_TICK_SECONDS` (60).
- `ANALYSIS_SOFT_DEADLINE_MS` — длина чанка (дефолт 20 мин в коде); в whitelist `app`.
- `ANALYSIS_BATCH_DISCOVERY=1` — батч-discovery через bulk `/leads/notes` + `/contacts/notes` c `filter[entity_id][]` (50 id/запрос, ~50x меньше запросов). Держать выключенным, пока не проверено на проде (прецедент: `filter[created_at]` на `/notes` тихо игнорируется). Встроенный guard: если >50% страницы вне запрошенных entity_id → throw (фильтр игнорируется).

## Layout

- Форма: Kommo-URL + mode (success/failure) + минимальная длительность звонка
- Список последних 50 анализов: статус, прогресс, «В очереди (№N)» для pending за работающим
- Деталь: markdown summary + список файлов транскриптов
- Кнопки: ⏹ Cancel (pending/processing), ⟳ Resume (error/cancelled), 🗑 Delete

## Edge cases / gotchas

- **Очередь глобальная**: менеджер может насоздавать сколько угодно анализов — выполняются строго по одному (Kommo-лимит 1 rps общий с ETL-кроном; два параллельных discovery душили друг друга).
- Discovery на сотни сделок занимает десятки минут при 1 rps — нормально: идёт чанками по ~20 мин с чекпоинтами, прогресс в `error_message` («Поиск звонков: N/M сделок...», «Пауза — продолжится автоматически...»).
- `_manifest.json` (file_type='manifest') — внутренний чекпоинт, исключён из detail/download, удаляется при `done`. Битый манифест → Sentry warn + discovery заново.
- `expiresAt` — TTL для cleanup (7 дней после done).
- `kommoUrl` сохраняется с суффиксом `#minDur=<n>` — так minDuration переживает retry/resume.
- Валидация Kommo-URL: hostname должен совпасть с `KOMMO.host` из tenant config.
- История инцидента: до 2026-06 джоб «125/769 сделок» висел сутки — выполнение жило в SSE-роуте, зависело от открытой вкладки, discovery не чекпоинтился, heartbeat умирал раньше пайплайна (дубль-запуски). Все четыре причины закрыты этой архитектурой.

## Файлы

- UI: `src/components/AnalysisTab.tsx`
- API: `src/app/api/analysis/route.ts`, `process/route.ts`, `process/tick/route.ts`, `[id]/{route,cancel,resume,delete,download}/route.ts`
- Worker/claim: `src/lib/analysis/worker.ts`
- Pipeline: `src/lib/analysis/pipeline.ts` (манифест, heartbeat, soft deadline — см. секцию CHUNKED EXECUTION)
- Schema: `src/lib/db/schema-existing.ts` (таблицы `callAnalyses`, `callAnalysisFiles`)
- Cron: `docker-compose.yml` (`analysis-cron`), `src/middleware.ts` (whitelist tick)
