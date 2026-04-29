# Sentry — где данные, как подключиться

Centralised error tracking for all SternMeister services. Этот документ — entry-point для агентов и инженеров: где смотреть ошибки, как авторизоваться, какие проекты есть.

## Организация и регион

- **Org slug:** `sm-nf`
- **Region:** EU (`de.sentry.io`) — все API-вызовы должны идти на этот хост, **не** на `sentry.io`
- **Web UI:** <https://sm-nf.sentry.io>

## Проекты

| Project slug | Сервис | Repo | Notes |
|---|---|---|---|
| `okk` | OKK call quality control | `sternmeisterde-ui/okk` | Webhooks, evaluator, telegram-бот |
| `dashboard` | SternMeister Sales Dashboard | `sternmeisterde-ui/Dashbord` | Next.js, Daily/Looker/Tracking/etc. |
| `d1_role` | D1 Roleplay (B2G) | роль-плей API | AI-роль-плей звонки B2G |
| `r1_role` | R1 Roleplay (B2B) | роль-плей API | AI-роль-плей звонки B2B |

## Auth: Sentry user token

Токен лежит **только** локально — `~/.claude/.sentry_token`, права `0600`. **Не коммитить.** Если потеряли — выпустить новый в `sm-nf.sentry.io → Settings → Account → User Auth Tokens` и перезаписать файл.

```bash
# Пример: достать unresolved issues по OKK за 24 часа
curl -sS -H "Authorization: Bearer $(cat /Users/user/.claude/.sentry_token)" \
  "https://de.sentry.io/api/0/projects/sm-nf/okk/issues/?statsPeriod=24h&query=is:unresolved&limit=20"

# Проверить токен живой:
curl -sS -H "Authorization: Bearer $(cat /Users/user/.claude/.sentry_token)" \
  "https://de.sentry.io/api/0/organizations/sm-nf/projects/" | jq -r '.[].slug'
```

**Никогда не передавать токен inline в bash-команде** (`SENTRY_TOKEN='sntryu_...' curl ...`) — harness блокирует на основании защиты от credential leakage. Только через `cat`.

`statsPeriod` принимает: `''`, `24h`, `14d`. Для других окон используйте `start=...&end=...` (ISO-8601, UTC).

## REST API: что чаще всего нужно

| Эндпоинт | Назначение |
|---|---|
| `GET /api/0/projects/sm-nf/{project}/issues/` | Список issues (filter `query=is:unresolved` / `is:resolved` / `event.type:error`) |
| `GET /api/0/issues/{issue_id}/events/latest/` | Последний event с full stack trace, тегами, breadcrumbs |
| `GET /api/0/issues/{issue_id}/events/?full=true` | Все events issue (paginated) |
| `PUT /api/0/issues/{issue_id}/` body `{"status":"resolved"}` | Resolve issue |
| `POST /api/0/projects/sm-nf/{project}/keys/` | Создать DSN |

Полный API: <https://docs.sentry.io/api/>.

## DSN-ы (откуда сервисы пишут)

DSN-ы хранятся в env-переменных каждого сервиса (`SENTRY_DSN`), не в этом репо. Для замены — Sentry UI → Project → Settings → Client Keys (DSN).

## MCP-сервер (опционально)

Если в сессии нет Sentry MCP, можно подключить:

```bash
claude mcp add sentry -- npx -y @sentry/mcp-server@latest --auth-token=$(cat ~/.claude/.sentry_token) --host=de.sentry.io
```

После этого инструменты `mcp__sentry__*` появятся в next session. Без MCP всё работает через REST API + curl как выше.

## Discord workflow

Все unresolved issues автоматически уходят в Discord webhook `#sentry` (см. integration в Sentry org settings). Жалобы на оценку звонка — отдельный webhook `Жалоба на оценку звонка` (см. `src/app/api/error-report/route.ts`), пишут в `evaluation_error_reports` таблицу + параллельно в Discord.

## Известные общие issues (по состоянию на 2026-04-29)

- **OKK-3..6** — 429 от xAI (Grok) с Anthropic-стилем сообщения «Your team {UUID} has either used all available credits or reached its monthly spending limit». Лечится пополнением кредитов в `console.x.ai → Billing`. После пополнения — re-queue failed-звонков:
  ```sql
  UPDATE calls SET status='evaluating', notified_at=NULL, updated_at=now()
  WHERE status='failed' AND error_message ILIKE '%429%';
  ```
  на обеих OKK-БД (R2 `br-falling-mouse-ait2ioye`, D2 `br-polished-queen-ai8072vd`, project `green-fog-15813299`, db `neondb`).

## Жалобы на оценку — где смотреть

Менеджеры в Dashboard → OKK tab → попап анализа звонка → раздел **«Жалоба на оценку звонка»** пишут в:

```
project: orange-brook-29816245   (Neon project "daily")
table:   evaluation_error_reports
```

Колонки: `call_id, department, source ('okk'|'ai'), manager_name, manager_telegram, call_date, call_score, message, created_at`. Параллельно нотифицируется Discord webhook (см. константа `DISCORD_WEBHOOK_URL` в `src/app/api/error-report/route.ts`).

Группировка жалоб для анализа промтов:
```sql
SELECT department, manager_name, count(*)
FROM evaluation_error_reports
WHERE created_at >= now() - interval '7 days'
GROUP BY 1, 2 ORDER BY count DESC;
```
