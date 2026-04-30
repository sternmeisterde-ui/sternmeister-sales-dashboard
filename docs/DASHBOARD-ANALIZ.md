# Dashboard → «Анализ» — как работает

Last updated: 2026-04-30

Batch-анализ звонков из Kommo-воронки: загружает по URL воронки массив звонков, прогоняет каждый через Grok, выдаёт markdown-summary паттернов по «успешным»/«неуспешным» лидам. Admin-only.

## Источники данных

| DB connection | Таблица | Зачем нужна тут | Ключевые колонки |
|---|---|---|---|
| **D1** (общая БД, `DATABASE_URL`) | `call_analyses` | Заявка на анализ + статус прогона | `id` (uuid), `department` (`b2g`/`b2b`), `kommo_url`, `mode` (`success`/`failure`), `status` (`pending`/`processing`/`done`/`error`), `progress` (0-100), `total_calls`, `processed_calls`, `result_summary` (markdown от Grok), `error_message`, `created_by`, `created_at`, `expires_at` |
| **D1** | `call_analysis_files` | Транскрипты + индексные файлы конкретного прогона (FK на `call_analyses.id`) | `analysis_id`, `filename`, `content` (markdown), `file_type` (`transcript`/`summary`/`index`), `lead_id`, `call_score` (Grok-relevance) |

> Анализы хранятся в **D1** (B2G-DB) даже когда `department='b2b'` — единая таблица для обоих отделов. См. в `src/app/api/analysis/route.ts` строку `getDbForDepartment("b2g")`.

> Внешние данные (звонки + транскрипты): тянутся из **Kommo API** + по URL записи звонка через CallGear. См. `src/lib/analysis/`.

## Архитектура потока

```
Юзер вводит Kommo-URL воронки
   ↓
POST /api/analysis  →  INSERT call_analyses (status='pending')
   ↓
SSE /api/analysis/process  ←  атомарно claim'ит первую pending row, переводит в 'processing'
   ↓
Pipeline: fetch leads from Kommo  →  fetch CDR/recording per lead  →  Grok summarize per call
   ↓
INSERT call_analysis_files (по одной строке на лид/файл)
   ↓
UPDATE call_analyses SET status='done', result_summary=<markdown>, processed_calls=N
   ↓
Frontend закрывает SSE по событию 'done'
```

Frontend держит **только один открытый SSE** через `sseRef.current`-guard. На сервере `claim` атомарный — две вкладки не запустят одновременно.

## API

- `POST /api/analysis` — admin. Body: `{ department, kommoUrl, mode, minDuration }`. Создаёт pending row.
- `GET /api/analysis?department=<b2g|b2b>` — admin. Возвращает 50 последних анализов.
- `GET /api/analysis/process` — admin. **SSE-stream**: запускает обработку pending row. Heartbeat пока работает; событие `done`/`error`/`idle` — окончание.
- `GET /api/analysis/[id]` — admin. Деталь одного анализа: full row + files[]. Подписывает скачивание файлов.

## Layout

- Форма: Kommo-URL + mode (success/failure) + минимальная длительность звонка
- Список последних 50 анализов (статус, прогресс, кто создал)
- Деталь: markdown summary + список файлов транскриптов
- Resume / Retry / Delete для проблемных прогонов

## Edge cases / gotchas

- Pipeline live-stream через SSE: serverless-функция Next.js обрывает обычные routes по таймауту, поэтому используется `/api/analysis/process` как long-running SSE с heartbeat'ами.
- `expiresAt` — TTL для cleanup, после которого файлы удаляются (актуально для Dokploy-disk-space).
- `kommoUrl` сохраняется с суффиксом `#minDur=<n>` — так minDuration переживает retry/resume.
- Валидация Kommo-URL: hostname должен совпасть с `KOMMO.host` из tenant config.

## Файлы

- UI: `src/components/AnalysisTab.tsx`
- API: `src/app/api/analysis/route.ts`, `src/app/api/analysis/process/route.ts`, `src/app/api/analysis/[id]/route.ts`
- Pipeline: `src/lib/analysis/`
- Schema: `src/lib/db/schema-existing.ts` (таблицы `callAnalyses`, `callAnalysisFiles`, строки 264-289)
