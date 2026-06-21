import "@/lib/db/neon-setup";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

type BeraterBotDb = ReturnType<typeof drizzle>;

// ==================== Berater-bot DB (Neon, read-only) ====================
// Бот ролевок (репо berater_bot) хранит сессии тренировок клиентов в своём Neon
// (мигрировал с SQLite 2026-06). Связь с нашими сделками — users.kommo_lead_id.
// Подключение ОПЦИОНАЛЬНО: без BERATER_BOT_DATABASE_URL обогащение Воронки
// данными бота становится graceful no-op (getBeraterBotDb() → null).
//
// ВАЖНО (gotcha #9): чтобы переменная была видна в контейнере, её нужно добавить
// в `environment:` блок сервиса `app` в docker-compose.yml, а не только в Dokploy UI.

let instance: BeraterBotDb | null = null;
let resolved = false;

export function getBeraterBotDb(): BeraterBotDb | null {
  if (!resolved) {
    resolved = true;
    const url = process.env.BERATER_BOT_DATABASE_URL;
    if (url) instance = drizzle(neon(url));
  }
  return instance;
}
