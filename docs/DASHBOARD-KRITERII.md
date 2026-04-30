# Dashboard → «Критерии» — как работает

Last updated: 2026-04-30

Редактор JSON-конфигов критериев оценки реальных звонков (используются OKK-пайплайном). Admin-only — на чтение и на запись.

## Источники данных

**Критерии хранятся НЕ в БД, а в JSON-файлах в репозитории.** Это сознательное решение: критерии — версионируемая часть конфигурации, проходят code review при изменениях через прод-пуш.

| Источник | Путь | Зачем |
|---|---|---|
| **Файловая система** (read+write) | `src/criteria/<prompt_type>.json` | Канонический список stages и criteria для одного prompt_type |
| **Tenant config** | `src/lib/config/tenant.ts` (`getLines`, `ALL_PROMPT_TYPES`) | Маппинг department + line → prompt_type |

Список `prompt_type` определяется в `src/lib/config/tenant.ts` через `ALL_PROMPT_TYPES`. Один JSON-файл на один prompt_type. Имя файла = `<prompt_type>.json`.

### Структура JSON

```json
{
  "prompt_type": "b2g_qualifier",
  "version": "1.4.2",
  "stages": [
    {
      "name": "Установление контакта",
      "criteria": [
        {
          "id": 1,
          "name": "Поприветствовал клиента",
          "type": "binary",            // 'binary' | 'scale_0_10' | 'info_tags' | 'info_text' | 'info'
          "conditional": false,
          "condition": null,
          "scoring": true,             // false = критерий-фильтр (не учитывается в score)
          "description": "Менеджер начал разговор с приветствия"
        }
      ]
    }
  ]
}
```

## Связь с остальными разделами

- **Аналитика** (`/api/analytics`) читает те же JSON-файлы при построении отчёта по блокам/критериям. Это `canonical` структура, по которой группируются `evaluation_json` из `evaluations.evaluation_json`.
- **OKK-бэкенд** (отдельный сервис, `okk-backend` репо) читает эти же JSON через mounted volume и шлёт в LLM как часть промпта.
- При сохранении (POST) дёргается `clearCache()` — сбрасывается 2-минутный TTL `/api/analytics`, чтобы новые критерии видны были сразу.

## API

- `GET /api/criteria?prompt_type=<id>` — admin-only. Возвращает текущий JSON.
- `POST /api/criteria` — admin-only. Body `{ prompt_type, config }`. Перезаписывает файл целиком, инвалидирует кеш аналитики.

## Edge cases / gotchas

- `prompt_type` валидируется через `isValidPromptType` против `ALL_PROMPT_TYPES`. Несовпадение → 400.
- Изменение в этом разделе **не пишется в git автоматически** — файл просто перезаписывается на диске prod-инстанса. После рестарта Dokploy-контейнера на CD-пушах изменения **потеряются**, если не закоммичены вручную в репо. Это известное ограничение.
- Для B2B обычно один prompt_type на отдел; для B2G их несколько (квалификатор, бератер, доведение) — ссылка на `getLines(dept)` определяет селектор.

## Файлы

- UI: `src/components/CriteriaTab.tsx`
- API: `src/app/api/criteria/route.ts`
- Конфиги: `src/criteria/*.json`
- Tenant: `src/lib/config/tenant.ts`
