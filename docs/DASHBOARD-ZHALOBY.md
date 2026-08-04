# Вкладка «Жалобы» (`complaints`)

Last updated: 2026-08-05

Реестр жалоб менеджеров на оценки ОКК/ролевок для обоих отделов (b2g/b2b).
Показывает: текст жалобы, дату подачи, оценку ОКК «до» (с детализацией
критериев — общий `EvalDetailView`, тот же вид, что «Детализация оценок» в
Аналитике b2b), статус обработки, дату рассмотрения, решение, оценку «после».

Доступ: `adminOnly: false` — вкладку видят менеджеры обоих отделов, но
**менеджер видит только свои жалобы** (server-гейт в `/api/complaints`);
admin — весь отдел + фильтры по статусу/менеджерам/датам. Менять
статус/решение могут только admin и РОП (`masterRole`), как в модерации
analytics/exclude.

Реестр ведётся **с 1 августа 2026** (`COMPLAINTS_SINCE`) — решение владельца:
глубокий бэкфилл не нужен, августовские жалобы на момент запуска ещё не
разбирались.

---

## Источники (ничего нового не изобретаем — агрегируем существующее)

| source | Механизм подачи | Legacy-таблица | Кто исторически |
|---|---|---|---|
| `error_report` | форма «Отправить жалобу» в попапе звонка (вкладки ОКК / AI Ролевки) | `evaluation_error_reports` в Neon-базе **«daily»** (`DAILY_DATABASE_URL`, drizzle-модели нет — raw SQL) | b2g (все ~700 строк на июль-2026) |
| `bug_report` | попап «Сообщить об ошибке» (`ReportBugPopup`) | `bug_reports` в D1 | b2b; берём только `reporter_role IN ('manager','teamlead')` — строки admin/rop это настоящие баг-репорты |

Наполнение реестра (`public.complaints` в D1, миграция `drizzle/d1/0004_complaints.sql`):

1. **Dual-write** — оба POST-роута (`/api/error-report`, `/api/bug-reports`)
   после своей legacy-вставки зовут `ingestErrorReport`/`ingestBugReport`
   (`src/lib/complaints/ingest.ts`). Сбой ingest не роняет legacy-запись.
2. **Догоняющий синк** `syncComplaints()` — fire-and-forget из
   `GET /api/complaints` (троттлинг 60с, лимит 10 новых строк на источник за
   прогон): первичный бэкфилл августа + ремонт пропусков dual-write.

Идемпотентность: `UNIQUE(source, source_id)` + `ON CONFLICT DO NOTHING`.

Попутно закрыта дыра безопасности: `/api/error-report` теперь требует
сессию (раньше личность бралась из тела запроса), telegram — из сессии.

## Снимки оценок «до» и «после» — почему заморожены

Переоценка в ОКК-сервисе — **UPSERT: одна строка `evaluations` на звонок,
старая перезаписывается**; cleanup-job со временем удаляет старые звонки
целиком. Поэтому реконструировать «оценку на момент подачи» задним числом
нельзя — реестр замораживает снимки в jsonb:

- `eval_before` + `score_before` — при регистрации жалобы (для
  `error_report` балл берётся из `call_score` исходной строки — он снят в
  момент подачи; снимок — best-effort);
- `eval_after` + `score_after` — **один раз** при первом переходе в
  Рассмотрена/Отклонена (повторный resolve обновляет текст решения, но не
  пере-снимает).

Формат снимка — `FrozenEvalPayload` (`src/lib/eval/snapshot.ts`): blocks
(как их отдаёт `/api/okk/calls/[callId]`, с таймкодами цитат) + meta + балл;
транскрипт/аудио в снимок не входят. `snapshotEval()` понимает оба типа
звонков: `okk` (D2/R2) и `ai` (ролевки D1/R1).

## Статусы

`new` (Новая) → `in_review` (В работе) → `resolved` (Рассмотрена) |
`rejected` (Отклонена). Плюс `not_complaint` (Не жалоба) — триаж-статус для
строк bug_reports, оказавшихся обычными багами дашборда: скрыт от
менеджеров и из дефолтного списка (у админа — отдельный чип фильтра).

`verdict` (`valid`/`partial`/`invalid`) — вердикт адъюдикатора, опционален.
`decision` — решение свободным текстом.

## API

| Метод | Путь | Auth | Что делает |
|---|---|---|---|
| GET | `/api/complaints?department&status=csv&managers=csv&from&to` | сессия; менеджер — только свой отдел и свои строки | Лёгкий список без jsonb (`hasEvalBefore/After` флагами) + `allManagers` для фильтра |
| GET | `/api/complaints/[id]/eval?phase=before\|after` | сессия; менеджер — только свои | `FrozenEvalPayload` для модалки |
| PATCH | `/api/complaints/[id]` | сессия, `masterRole` admin\|rop | `{status, decision?, verdict?}` — семантика `applyResolution` |
| POST | `/api/complaints/resolve` | **Bearer `COMPLAINTS_API_TOKEN`** | Batch-приём решений от OKK-адъюдикатора (см. контракт ниже) |

Владение менеджера: resolved `master_manager_id` (матч telegram → имя к
`master_managers`) ЛИБО telegram/имя на самой строке жалобы — страховка от
несмэтченных строк (дрейф имён).

`/api/complaints/resolve` whitelist'ится в `src/middleware.ts` (exact match)
— без этого токенный запрос 307-ится в `/login` (класс бага `d9079c6`).
`COMPLAINTS_API_TOKEN` обязан быть в `environment:` блоке `app` в
docker-compose (ловушка env-whitelist) и задан в Dokploy. Не задан →
endpoint отвечает 401 (выключен).

## Контракт для OKK-адъюдикатора

Разбор жалоб остаётся процессом OKK-репо (Claude-агенты, брифинг
`_adjudicator_brief.md`). Итог каждой жалобы отправляется в дашборд:

```
POST https://dashboard.sternmeister.online/api/complaints/resolve
Authorization: Bearer <COMPLAINTS_API_TOKEN>
Content-Type: application/json

[
  {
    "call_id": "<uuid звонка>",        // или "complaint_id" / "source_id" (id в evaluation_error_reports)
    "status": "resolved",               // resolved | rejected | in_review
    "verdict": "partial",               // valid | partial | invalid (опционально)
    "decision": "Критерий 12 снят как несправедливый, балл 42→67. Пересчитано 05.08.",
    "resolved_by": "okk-adjudicator"    // опционально, default
  }
]
```

Ответ — HTTP 200 с per-item результатами `{ target, ok, id?, error? }`
(ненайденная жалоба не валит остальной batch).

**Правила:**

1. **Порядок**: если по жалобе применяется пересмотр оценки (re-eval /
   retro-fix) — сначала применить его в D2/R2, ПОТОМ звать resolve: снимок
   «после» замораживается в момент resolve.
2. Таргетинг по `call_id` берёт самую свежую **открытую** (new/in_review)
   жалобу по звонку; если открытых нет — самую свежую вообще (повторный
   resolve обновит текст решения, но не пере-заморозит снимок).
3. «Сделка изъята» (calls.error_message `Removed…`): оценка «после» может
   быть недоступна — истина в тексте `decision`, UI покажет «—».
4. Пометить «взяли в работу» можно тем же endpoint'ом со `status: "in_review"`
   (decision обязателен — можно короткое «в разборе окна 01–07.08»).

## Файлы

```
src/components/ComplaintsTab.tsx        ← вкладка (таблица, фильтры, модалка снимка, редактор решения)
src/components/eval/EvalDetail.tsx      ← общий EvalDetailView (вынесен из AnalyticsTab)
src/lib/eval/snapshot.ts                ← fetch*CallDetail + snapshotEval (общее с detail-роутами)
src/lib/complaints/ingest.ts            ← dual-write + догоняющий синк + матч менеджеров
src/lib/complaints/resolve.ts           ← applyResolution (общая семантика PATCH и batch)
src/app/api/complaints/route.ts         ← GET список
src/app/api/complaints/[id]/route.ts    ← PATCH статус/решение (admin/rop)
src/app/api/complaints/[id]/eval/route.ts ← GET снимок для модалки
src/app/api/complaints/resolve/route.ts ← POST batch (Bearer, для OKK-репо)
drizzle/d1/0004_complaints.sql          ← миграция (применять в Neon SQL editor, D1)
```

## Ловушки

1. **Снимок ≠ живая оценка.** Модалка «Оценка до/после» рендерит jsonb-снимок;
   живая оценка могла быть с тех пор перезаписана или удалена — это фича.
2. **bug_report без call_id** — балл/детализация недоступны в принципе
   («—» в обеих колонках); жалоба всё равно проходит полный цикл статусов.
3. **`evaluation_error_reports` живёт в 7-й БД** («daily» Neon,
   `DAILY_DATABASE_URL`) без drizzle-модели — читаем raw SQL. Недоступность
   daily-БД не валит вкладку: реестр отдаётся из D1, синк просто пропустит тик.
4. **Снимок «до» для догнанных строк** (catch-up, а не dual-write) может
   отражать уже пересмотренную оценку — `score_before` при этом всегда
   исходный (из `call_score`). Для dual-write пути расхождения нет.
5. **teamlead** видит вкладку как админ (gate role admin), но карандаша
   редактирования не имеет (`canModerate` = masterRole admin|rop).
