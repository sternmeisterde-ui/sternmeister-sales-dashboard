// GET /api/dashboard/lost-leads?department=b2g&from=YYYY-MM-DD&to=YYYY-MM-DD&vertical=buh|med|all
//
// Drill-down плитки «Потерянные» (b2g, спека 25 §2): лиды на «Новый лид»/
// «Недозвон» (Бух Гос / Мед Гос по вертикали), у которых последний звонок был
// > 24ч назад или звонков не было вовсе. Снимок на конец периода (asOfEnd =
// конец дня `to`). Счётчик плитки = длина этого списка (та же функция, что в
// /api/dashboard → цифры сходятся по построению). Без группировки по менеджеру.

import { type NextRequest, NextResponse } from "next/server";
import { getB2gLostLeads } from "@/lib/daily/analytics-calls";
import {
  B2G_PIPELINES,
  FIRST_LINE_STATUSES,
  MED_GOV_STATUSES,
  parseVertical,
} from "@/lib/kommo/pipeline-config";
import { parseDateBoundary } from "@/lib/utils/date";

export const dynamic = "force-dynamic";

const PIPELINE_NAME: Record<number, string> = {
  [B2G_PIPELINES.FIRST_LINE]: "Бух Гос",
  [B2G_PIPELINES.MEDICAL_GOV]: "Мед Гос",
};
const STAGE_NAME: Record<number, string> = {
  [FIRST_LINE_STATUSES.NEW_LEAD]: "Новый лид",
  [FIRST_LINE_STATUSES.NO_ANSWER]: "Недозвон",
  [MED_GOV_STATUSES.NEW_LEAD]: "Новый лид",
  [MED_GOV_STATUSES.NO_ANSWER]: "Недозвон",
};

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const sp = req.nextUrl.searchParams;
    const vertical = parseVertical(sp.get("vertical"));
    const toStr = sp.get("to");
    if (!toStr) {
      return NextResponse.json({ error: "to required (YYYY-MM-DD)" }, { status: 400 });
    }
    const toDate = parseDateBoundary(toStr, "end");
    if (!toDate) {
      return NextResponse.json({ error: "bad to" }, { status: 400 });
    }

    const rows = await getB2gLostLeads(toDate, vertical);
    const items = rows.map((r) => ({
      leadId: r.leadId,
      clientName: r.contactName,
      manager: r.manager,
      pipelineName: PIPELINE_NAME[r.pipelineId] ?? null,
      stageName: STAGE_NAME[r.statusId] ?? null,
      leadCreatedAt: r.leadCreatedAt,
      lastCallAt: r.lastCallAt,
    }));
    return NextResponse.json(
      { items },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (error) {
    console.error("[Dashboard lost-leads] error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
