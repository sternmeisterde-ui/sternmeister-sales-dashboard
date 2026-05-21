# Sternmeister Dashboard — TODO (root)

Last reviewed: 2026-05-21

**Status**: Most items from earlier (April) sprints are landed. The active backlog now lives in [`docs/TODO.md`](./docs/TODO.md) (priorities P0–P4 with cross-links to the architecture plans). This file is kept as a quick-scan landing for ad-hoc items not yet promoted into the structured backlog.

## Where things stand

- **B2B Daily tab (Коммерция)** — ✅ landed. `src/lib/daily/metrics-config-b2b.ts`, editable plan/fact for Бух + Мед, L2P rows, Продления, optimistic save. The April spec («TODO: B2B Daily Tab — следующая сессия») is fully implemented.
- **Telephony CDR (CallGear + CloudTalk)** — ✅ landed. Hard-split from Kommo `/notes`. See `src/lib/telephony/` and `src/lib/etl/sync-telephony.ts`.
- **Phone → lead enrichment (Pattern A)** — ✅ landed. Migration 0005, `enrich-telephony-leads.ts`.
- **Термин tab (B2G)** — ✅ landed including charts 1–6, ROP-rework, sticky headers.
- **MCP server** — ✅ Phase 1–3 landed. ~35 tools across managers / okk / daily / analytics / looker / tracking / termin / roleplay / scripts / analiz. See `mcp-server/`.
- **Payroll / Tabel** — ✅ landed (manual monthly bonus, schedule-linked, popover UI).
- **Sticky thead in Analytics/Daily tables** — ✅ landed.

## Live (unchecked) follow-ups parked here

Cross-check against [`docs/TODO.md`](./docs/TODO.md) before picking one of these — many are duplicated and tracked there with more context.

### Operational verification

- [ ] R1 evaluation-service: убедиться что redeploy прошёл (Dockerfile fix — `COPY prompts/`).
- [ ] Discord-уведомления от Sentry для всех 4 проектов.
- [ ] R1 batched evaluation работает после деплоя.
- [ ] Дейли B2G: финальная проверка что `/leads/notes` фикс действительно починил счётчик звонков на проде.

### Будущее (nice-to-have)

- [ ] Корреляция «категория x блок оценки» (heatmap).
- [ ] Тренд по менеджерам (кто растёт, кто падает).
- [ ] Экспорт данных в Excel.
- [ ] Мобильная адаптивность (сейчас оптимизировано под десктоп).

### Hard rules (не правила а правила)

- НИКОГДА не использовать `db:push` на проде — только `db:generate` + `db:migrate`.
- Перед любым INSERT в `analytics.*` — читать `docs/etl-architecture.md` (natural-key + ON CONFLICT + Neon HTTP retry).
- Любой новый env-var должен попасть в whitelist `docker-compose.yml`, иначе он невидим в контейнере на проде.
- Любое изменение в `src/lib/tracking/sync.ts` Kommo-фетча — поднимать `CURRENT_FILTER_VERSION`, иначе кеш `tracking_events` молча расходится.

## Архивный исторический раздел

Полный список того, что было сделано в апреле/мае 2026, перенесён в [`docs/TODO.md`](./docs/TODO.md) (раздел «DONE recently»). Здесь больше не дублируется — этот файл стал слишком длинным.
