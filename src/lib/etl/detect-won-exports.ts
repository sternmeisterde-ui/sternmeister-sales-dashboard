// ETL-шаг: поставить в очередь выгрузку звонков для B2B-сделок, которые попали
// в «Рассрочка» или «Успешно реализовано» (WON). Лёгкий — только SELECT+INSERT
// в analytics.contact_call_exports; тяжёлую работу (скачать записи, залить на
// Drive) делает отдельный воркер /api/exports/process/tick.
//
// Идемпотентно: PK = lead_id + ON CONFLICT DO NOTHING. Повторный заход того же
// лида в статус на следующем тике ничего не сбрасывает.

import { analyticsDb } from "@/lib/db/analytics";
import { sql } from "drizzle-orm";
import { APP_TZ } from "@/lib/utils/date";
import {
  COMMERCIAL_STATUSES,
  MEDICAL_COMM_STATUSES,
  B2B_ALL_PIPELINE_IDS,
} from "@/lib/kommo/pipeline-config";

// «Успешно реализовано» = WON (142, общий для обеих B2B-воронок) +
// «Рассрочка» (своя по каждой воронке).
const TARGET_STATUS_IDS = [
  COMMERCIAL_STATUSES.WON, // 142
  COMMERCIAL_STATUSES.INSTALLMENT, // 82946499
  MEDICAL_COMM_STATUSES.INSTALLMENT, // 101858279
];

// Окно по дате оплаты: на первом прогоне детект иначе подхватил бы ВСЕ
// исторические won/рассрочка-сделки (большой бэклог). Берём только сделки с
// датой оплаты за последние N дней (EXPORT_SINCE_DAYS, по умолчанию 5); дальше
// в очередь попадают только новые. Поставь 0/пусто, чтобы снять ограничение.
function sinceDays(): number {
  const raw = Number(process.env.EXPORT_SINCE_DAYS ?? "5");
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/** Ставит в очередь новые won/installment-сделки. Возвращает число добавленных. */
export async function detectWonExports(): Promise<number> {
  const days = sinceDays();
  // Дата оплаты сделки (та же, что идёт в имя папки).
  const paymentExpr = sql`COALESCE(lc.first_payment_date, lc.prepayment_date, lc.closed_at, lc.updated_at)`;
  const sinceClause = days > 0
    ? sql` AND ${paymentExpr} >= (now() - ${`${days} days`}::interval)`
    : sql``;

  const res = await analyticsDb.execute<{ lead_id: number }>(sql`
    INSERT INTO analytics.contact_call_exports
      (lead_id, contact_id, contact_name, payment_date, pipeline_id, status_id, status)
    SELECT DISTINCT ON (lc.lead_id)
      lc.lead_id,
      ct.contact_id,
      ct.name,
      to_char(((${paymentExpr} AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TZ}), 'YYYY-MM-DD') AS payment_date,
      lc.pipeline_id,
      lc.status_id,
      'pending'
    FROM analytics.leads_cohort lc
    JOIN analytics.lead_contact_links lcl
      ON lcl.lead_id = lc.lead_id AND lcl.is_active = true
    JOIN analytics.contacts ct
      ON ct.contact_id = lcl.contact_id
    WHERE lc.pipeline_id IN (${sql.join(B2B_ALL_PIPELINE_IDS.map((p) => sql`${p}`), sql`, `)})
      AND lc.status_id IN (${sql.join(TARGET_STATUS_IDS.map((s) => sql`${s}`), sql`, `)})
      AND lc.is_deleted = false${sinceClause}
    ORDER BY lc.lead_id, lcl.first_seen_at ASC
    ON CONFLICT (lead_id) DO NOTHING
    RETURNING lead_id
  `);
  return res.rows.length;
}
