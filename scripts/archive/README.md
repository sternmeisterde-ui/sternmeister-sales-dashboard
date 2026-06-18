# scripts/archive

Разовые скрипты-«однодневки», уже отработавшие свою задачу: применённые миграции
(`apply-migration-00XX`), диагностика (`diag-*`), пробы Kommo/CDR API (`probe-*`),
разовые аудиты/проверки (`audit-*`, `check-*`, `count-*`, `verify-*`, `inspect-*`),
тесты интеграций (`test-*`, `debug-*`).

Оставлены для истории и как примеры обращения к API/БД. **Не нужны для штатной работы.**
Операционные инструменты (backfill, etl-sync, enrich-telephony, recompute-sla,
link-managers-telephony, генераторы токенов и т.п.) живут уровнем выше — в `scripts/`.
