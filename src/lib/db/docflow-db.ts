import "@/lib/db/neon-setup";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

type DocflowDb = ReturnType<typeof drizzle>;

// ==================== BGS DocFlow DB (Neon, read-only) ====================
// Отдельный сервис (репо BGS_DocFlow) — автоматизация откликов на вакансии
// для учеников школы (Bildungsgutschein). Свой Neon-проект, с Dashboard не
// пересекается. Подключение ОПЦИОНАЛЬНО: без DOCFLOW_DATABASE_URL вкладка
// «BGS DocFlow» становится graceful no-op (getDocflowDb() → null).
//
// ВАЖНО (gotcha #9 CLAUDE.md): чтобы переменная была видна в контейнере, её
// нужно добавить в `environment:` блок сервиса `app` в docker-compose.yml,
// а не только в Dokploy UI.

let instance: DocflowDb | null = null;
let resolved = false;

export function getDocflowDb(): DocflowDb | null {
  if (!resolved) {
    resolved = true;
    const url = process.env.DOCFLOW_DATABASE_URL;
    if (url) instance = drizzle(neon(url));
  }
  return instance;
}
