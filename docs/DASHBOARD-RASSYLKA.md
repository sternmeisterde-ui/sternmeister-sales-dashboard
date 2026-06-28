# Вкладка «Рассылка» (broadcast)

Статистика drip-рассылки Telegram-бота **berater_bot** (соседний репозиторий) —
кампания «прогрев к термину» (`termin_warmup_v2`). B2G/Госники, только `admin`.

> Бот шлёт авторизованным клиентам цепочку из 14 сообщений от даты авторизации до
> термина (см. `berater_bot/_Info/ПЛАН_РАССЫЛКА_TERMIN.md`). Эта вкладка показывает,
> **сколько отправлено, кому, по каким этапам, и как клиенты реагировали**.

## Доступ и навигация

- `NAV_ITEMS` в [`src/app/page.tsx`](../src/app/page.tsx): `{ id: "broadcast", departments: ["b2g"] }`.
- `adminOnly: true` → линейные менеджеры вкладку не видят. На B2B вкладки нет.

## Источники данных (ВАЖНО: три разные БД)

| Что | Откуда | Как |
|---|---|---|
| Доставки, реакции, подписки | **Бот-Neon** (`BERATER_BOT_DATABASE_URL`) | read-only, [`src/lib/db/berater-bot.ts`](../src/lib/db/berater-bot.ts) → `getBeraterBotDb()` |
| Имя сделки получателя | **Analytics** (`ANALYTICS_DATABASE_URL`) | `lead_contact_links` → `contacts.name` по `kommo_lead_id` |
| Содержание сообщений (текст, кнопки, «День N») | **Статическая копия в дашборде** | [`src/lib/broadcast/campaign-content.json`](../src/lib/broadcast/campaign-content.ts) |

Таблицы бота:
- `broadcast_deliveries` — журнал доставок: `message_id` (msg_01…msg_14), `status`
  (`pending`/`sent`/`skipped`/`failed`), `sent_at`, `user_id`.
- `broadcast_interactions` — реакции: `action` = `roleplay_click` / `roleplay_completed`
  / `link_click`, `telegram_id`, `message_id`, `created_at`.
- `broadcast_subscriptions` — подписки: `status` (`active`/`completed`/`excluded`),
  `suppressed` (тихая отписка).
- `users` — `telegram_username`, `kommo_lead_id` (связь с нашей сделкой).

## Что показывает вкладка

1. **Подписки** (снимок по всей кампании): активные / завершённые / отписались. Карточки
   **кликабельны** → модалка со списком подписчиков (получатель, сделка-ссылка, дата
   авторизации, термин). Фильтр совпадает с подсчётом: active/completed по `status`,
   «отписались» по флагу `suppressed`.
2. **Доставка** (снимок по всей кампании): отправлено / пропущено / ошибки / в очереди.
3. **Отправки по дням** (в периоде) — линейный график по `sent_at`. **Кликабельный**:
   клик по дню раскрывает таблицу получателей этого дня (когда, сообщение,
   `@telegram_username`, имя+`#id` сделки). Список периода грузится разом (кап 2000,
   флаг `recipientsTruncated`) и фильтруется по дню на клиенте — доп. запроса нет.
4. **Этапы рассылки** (в периоде) — таблица msg_01…msg_14 с человеческими подписями
   («День N, слот время» + «Сообщение N»): отправлено + уник. клики (ролевка / завершили
   / ссылка). Клик по строке открывает **модалку с текстом сообщения, кнопками и медиа**.

Drill-модалки (получатели дня, текст этапа) — единый паттерн `createPortal` (как
`TerminLeadDrillModal`): оверлей, закрытие по клику-вне/Escape/крестику. Имя сделки в
получателях — гиперссылка на Kommo (`kommoLeadUrl`).

Кампания выбирается дропдауном с человеческими именами («Версия 1» / «Версия 2» —
`campaignLabel()` парсит `_vN`). Контент-копии обеих версий лежат в
`campaign-content-v1.json` / `campaign-content-v2.json`.

## Архитектура кода

```
src/lib/broadcast/
  stats.ts               ← getBroadcastStats({campaignId?, from, to}) — все запросы к бот-Neon
                            + enrichment имён сделок из analytics. Graceful: available:false.
  campaign-content.ts    ← getMessageContent(campaignId, messageId) — текст/кнопки/«День N»
  campaign-content.json  ← КОПИЯ berater_bot/app/content/broadcast_campaign.json
src/app/api/broadcast/route.ts  ← GET ?from=&to=&campaign= (admin-only, maxDuration=30)
src/components/BroadcastTab.tsx  ← UI (фильтр периода CalendarPicker, графики, таблицы)
```

## Исключение тестовых прогонов

Команды бота `/campaign_test`, `/campaign_test_fast`, `/campaign_test_classic` гоняют
кампанию на тестовых аккаунтах (админах). Они метят подписку через
`broadcast_subscriptions.termin_source` = `test` / `test_fast` / `test_classic` (боевые —
`dc`/`aa`). В `stats.ts` собираем `user_id` и `telegram_id` таких подписок и **вычитаем их
из всех запросов** (доставки, реакции, получатели, подписки, здоровье доставки), чтобы
тесты не искажали аналитику.

## Ограничения (важно для ожиданий заказчика)

- **Telegram Bot API не даёт «прочитано»/«открыто» и просмотры видео.** Воронка
  обрывается на «нажал кнопку». Это потолок API, не наш недосбор
  (см. `berater_bot/deploy/BROADCAST_TRACKING.md`).
- **Бот-Neon scale-to-zero «засыпает».** Первая загрузка может занять 2–5 сек (спиннер).
  Читаем напрямую (не зеркало): вкладка admin-only и редко открывается.
- **Дрифт контента.** Текст сообщений — статическая копия. При изменении кампании в боте
  (новый текст / v2→v3) обнови `campaign-content.json`:
  `cp ../berater_bot/app/content/broadcast_campaign.json src/lib/broadcast/campaign-content.json`.
  Цифры (sent/клики) всегда живые из БД — устареть может только текст.
- **Группировка по дню — по UTC-дате `sent_at`** (как `sync-bot-roleplays`). Сдвиг
  относительно Berlin-суток возможен для отправок около полуночи UTC.

## Env

`BERATER_BOT_DATABASE_URL` — уже в `.env.local` и в `docker-compose.yml` (`environment:`
блок `app`, gotcha #9). Без неё вкладка рисует пустое состояние (graceful).
