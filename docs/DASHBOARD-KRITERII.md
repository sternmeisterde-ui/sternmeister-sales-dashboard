# Dashboard → «Критерии» — как работает

Last updated: 2026-08-06

Просмотр конфигураций критериев оценки реальных звонков, которые использует OKK-пайплайн. Раздел доступен только администратору и работает без редактирования.

## Источники данных

**Источник правды — D2 OKK, таблица `criteria_configs`.** JSON-файлы в Dashboard
служат резервной копией на случай недоступности D2 и должны синхронизироваться с
финальными файлами OKK.

| Источник | Путь | Зачем |
|---|---|---|
| **D2 OKK** (read) | `criteria_configs` | Актуальная версия конфигурации для одного prompt_type |
| **Файловая система** (fallback) | `src/criteria/<prompt_type>.json` | Резервная копия для чтения при ошибке D2 |
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

- **Аналитика** (`/api/analytics`) читает те же JSON-файлы при построении отчёта по блокам/критериям. Это `canonical` структура, по которой группируются `evaluation_json` из `evaluations.evaluation_json`. Исключение: для Коммерсов (r2_commercial / r2_med_commercial) РАСКЛАДКА ПО БЛОКАМ берётся не из stages конфига, а из `SPELLIT_GROUPING` в route.ts (сверено с «Дашбордом 1» Spellit); состав и имена критериев по-прежнему из JSON.
- **OKK-бэкенд** (отдельный сервис, `okk-backend` репо) читает эти же JSON через mounted volume и шлёт в LLM как часть промпта.
- При сохранении (POST) дёргается `clearCache()` — сбрасывается 2-минутный TTL `/api/analytics`, чтобы новые критерии видны были сразу.

## API

- `GET /api/criteria?prompt_type=<id>` — любая сессия; не-админ читает только prompt_type'ы своего отдела (403 на чужие). Возвращает текущий JSON.
- `POST /api/criteria` — 405. Критерии редактируются в OKK-репо (`src/criteria/*.json`) и синкаются в D2 `criteria_configs` на деплое (см. `scripts/migrate-criteria-to-db.ts`).

## Edge cases / gotchas

- UI фильтрует критерии по выбранной дате так же, как OKK: `effective_from`
  включительно, `effective_until` исключительно. По умолчанию архив скрыт; его можно
  открыть отдельной кнопкой.
- Для первой линии после 2026-08-01: `d2_qualifier` v4.0 и
  `d2_med_qualifier` v2.0 основаны на бизнес-скрипте «Первая линия v3.0».

- `prompt_type` валидируется через `isValidPromptType` против `ALL_PROMPT_TYPES`. Несовпадение → 400.
- Раздел работает только на чтение. Изменения выполняются в OKK-репозитории и
  синхронизируются в D2 при деплое OKK; резервные JSON Dashboard обновляются тем же релизом.
- Для B2B обычно один prompt_type на отдел; для B2G их несколько (квалификатор, бератер, доведение) — ссылка на `getLines(dept)` определяет селектор.

## Файлы

- UI: `src/components/CriteriaTab.tsx`
- API: `src/app/api/criteria/route.ts`
- Конфиги: `src/criteria/*.json`
- Tenant: `src/lib/config/tenant.ts`
