# Dashboard → «Скрипты» — как работает

Last updated: 2026-08-06

Хранилище скриптов разговоров (текст с разделами и пунктами) для каждой пары `(department, line)`. Доступно всем авторизованным; редактирование — admin-only.

## Источники данных

| DB connection | Таблица | Зачем нужна тут | Ключевые колонки |
|---|---|---|---|
| **D1** (общая БД, `DATABASE_URL`) | `scripts` | Один JSON-документ на пару (department, line) | `department` (`b2g`/`b2b`), `line` (`1`/`2`/`3`/`buh1`/`buh2`/`med1`...), `title`, `notion_url`, `content` (jsonb), `version` (инкрементируется при каждом save), `updated_by`, `updated_at` |

> Таблица **общая для обоих отделов** — лежит в D1 несмотря на наличие department-колонки. Связана с tenant config через `(department, line)`-уникальный ключ, но физического unique-constraint в схеме нет (защищено upsert-логикой в API).

### Структура `content`

```json
{
  "sections": [
    {
      "id": "section_1",
      "title": "Открытие звонка",
      "items": [
        { "id": "item_1", "text": "Здравствуйте! Меня зовут …" },
        { "id": "item_2", "text": "Мы вам помогли …" }
      ]
    }
  ]
}
```

Минимальная валидация на бэке: `content` — объект, в нём `sections` — массив. Остальное — свободная форма.

## Layout

- Селектор `department × line` (на основе `getLines(dept)` из tenant config)
- Внутри: список секций → внутри секций список пунктов
- Опциональная ссылка на Notion (`notion_url`) — выводится как «открыть исходник в Notion»
- Версия и автор последнего изменения (`version`, `updated_by`, `updated_at`)

## API

- `GET /api/scripts?department=<b2g|b2b>&line=<lineId>` — auth required. Возвращает `{ exists, ...row }` или `{ exists: false, ...defaults }` если строки нет.
- `POST /api/scripts` — admin-only. Upsert по паре `(department, line)`. Инкрементирует `version` на каждое сохранение.

## Edge cases / gotchas

- Если в БД нет строки для `(department, line)` — возвращается заглушка с пустым `content.sections=[]`. Никаких 404.
- `version` не атомарен — два одновременных сохранения теоретически могут перезаписать друг друга. Для текущей нагрузки (1 редактор за раз) допустимо.
- `notion_url` опциональная — если null, кнопка «Открыть в Notion» прячется.
- Канонический seed B2G хранится в `src/lib/scripts/b2g-seed.json`. Линия 1 с
  2026-08-01 основана на листах 03, 04 и 05 документа «СКРИПТ ПЕРВОЙ ЛИНИИ v3.0»:
  3 раздела, 44 блока.
- Для безопасной синхронизации только линии 1 используйте
  `npm run scripts:sync-b2g-line1-v3` (предпросмотр). Запись в D1 выполняется только
  с `npm run scripts:sync-b2g-line1-v3 -- --apply` и явно переданным `DATABASE_URL`;
  скрипт сам `.env` не читает.
- Администратор также может выполнить ту же одноразовую операцию кнопкой
  «Загрузить скрипт v3.0» во вкладке B2G → линия 1. Endpoint защищён admin-сессией,
  обновляет найденную запись по её точному `id` и после успешной миграции становится no-op.

## Файлы

- UI: `src/components/ScriptsTab.tsx`
- API: `src/app/api/scripts/route.ts`
- Schema: `src/lib/db/schema-existing.ts` (таблица `scripts`, строка 239)
- Tenant: `src/lib/config/tenant.ts` (`getLines`, `isValidLineId`)
