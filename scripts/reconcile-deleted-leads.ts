// Reconciliation: проходит по всем Гос lead_id в нашей analytics.leads_cohort и
// проверяет их в Kommo через /api/v4/leads?filter[id][]=N. Те IDs, которых Kommo
// НЕ возвращает (удалены / soft-deleted / физически нет) → помечает is_deleted=TRUE.
//
// Это надёжнее backfill-lead-deletions (который зависит от ретенции /events),
// но дороже: 1 запрос на ~50 ID, при ~5к лидов = ~100 запросов = ~15-30 сек.
//
//   npx tsx scripts/reconcile-deleted-leads.ts
//   npx tsx scripts/reconcile-deleted-leads.ts --dry-run    # без UPDATE

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { analyticsDb } from "../src/lib/db/analytics";
import {
  getBaseUrl,
  getAuthHeaders,
  rateLimitedFetch,
} from "../src/lib/kommo/client";

const BUH_GOS = 10935879;
const CHUNK = 50; // IDs per Kommo request

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  console.log("=== Reconcile deleted Гос leads vs Kommo ===");
  if (dryRun) console.log("⚠ DRY RUN — никаких UPDATE\n");

  // Все Гос lead_id из нашей analytics.leads_cohort, ещё НЕ помеченные как удалённые
  const r = await analyticsDb.execute<{ leadId: string | number }>(sql`
    SELECT lead_id AS "leadId"
    FROM analytics.leads_cohort
    WHERE pipeline_id = ${BUH_GOS}
      AND is_deleted = FALSE
    ORDER BY lead_id DESC
  `);
  const allIds = r.rows.map((row) => Number(row.leadId));
  console.log(`Из БД: ${allIds.length} Гос лидов (is_deleted=FALSE)\n`);

  const baseUrl = await getBaseUrl();
  const headers = await getAuthHeaders();

  const foundIds = new Set<number>();
  const t0 = Date.now();

  for (let i = 0; i < allIds.length; i += CHUNK) {
    const batch = allIds.slice(i, i + CHUNK);
    const url = new URL(`${baseUrl}/leads`);
    for (const id of batch) {
      url.searchParams.append("filter[id][]", String(id));
    }
    url.searchParams.set("limit", "250");
    try {
      const res = await rateLimitedFetch(url.toString(), { headers });
      if (res.status === 204) {
        // Пустой ответ — никого из batch Kommo не нашёл
      } else if (res.ok) {
        const data = (await res.json()) as {
          _embedded?: { leads?: Array<{ id: number; is_deleted?: boolean }> };
        };
        const returned = data._embedded?.leads ?? [];
        for (const lead of returned) {
          // Только живые. Если is_deleted=true (soft-deleted) — не считаем найденным.
          if (lead.is_deleted !== true) {
            foundIds.add(Number(lead.id));
          }
        }
      } else {
        const text = await res.text().catch(() => "");
        console.error(
          `  batch ${i}-${i + batch.length}: HTTP ${res.status}: ${text}`,
        );
      }
    } catch (e) {
      console.error(
        `  batch ${i}-${i + batch.length} failed:`,
        e instanceof Error ? e.message : String(e),
      );
    }
    if (i > 0 && i % 500 === 0) {
      console.log(
        `  processed ${i}/${allIds.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
      );
    }
  }

  const missingIds = allIds.filter((id) => !foundIds.has(id));
  console.log(
    `\nНайдено в Kommo: ${foundIds.size}, отсутствует: ${missingIds.length}`,
  );

  if (missingIds.length === 0) {
    console.log("Ничего пометить — всё актуально.");
    return;
  }

  if (dryRun) {
    console.log("\nDRY RUN — первые 20 ID для удаления:");
    console.log("  ", missingIds.slice(0, 20).join(", "));
    return;
  }

  // Метим как удалённые. deleted_at = NOW() (точной даты нет — Kommo не сказал когда).
  const CHUNK_UPDATE = 1000;
  let marked = 0;
  for (let i = 0; i < missingIds.length; i += CHUNK_UPDATE) {
    const slice = missingIds.slice(i, i + CHUNK_UPDATE);
    const idsIn = slice.join(",");
    await analyticsDb.execute(sql`
      UPDATE analytics.leads_cohort
      SET
        is_deleted = TRUE,
        deleted_at = COALESCE(deleted_at, NOW())
      WHERE lead_id IN (${sql.raw(idsIn)})
        AND pipeline_id = ${BUH_GOS}
    `);
    marked += slice.length;
  }

  console.log(`\n✅ Помечено как удалённые: ${marked} лидов`);
  console.log(`Время: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("fatal:", e);
    process.exit(1);
  });
