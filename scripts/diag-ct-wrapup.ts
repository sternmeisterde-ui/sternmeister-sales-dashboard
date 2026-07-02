// Проверка: среднее wrapup_time по CloudTalk-исходящим МОПов за день против
// виджета CT «Avg. wrap-up time» (якорь 26.06: 24с). Поле в БД не хранится —
// читаем сырой API. READ-ONLY.
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { neon } from "@neondatabase/serverless";

const BERLIN = "Europe/Berlin";
const berlinDay = (d: Date) => d.toLocaleDateString("sv", { timeZone: BERLIN });

interface CtItem {
  Cdr: { id: string; type: string; user_id: string | null; started_at: string; wrapup_time: number | string; talking_time: string };
  Agent: { id: string | null };
}

async function main() {
  const ymd = process.argv[2] ?? "2026-06-26";
  const d1 = neon(process.env.DATABASE_URL!);
  const masters = (await d1`
    SELECT cloudtalk_agent_id FROM master_managers
    WHERE department = 'b2b' AND is_active = true
      AND role IN ('manager', 'teamlead', 'rop') AND cloudtalk_agent_id IS NOT NULL`) as Array<{ cloudtalk_agent_id: string }>;
  const ids = new Set(masters.map((m) => String(m.cloudtalk_agent_id)));

  const auth = `Basic ${Buffer.from(`${process.env.CLOUDTALK_API_ID}:${process.env.CLOUDTALK_API_SECRET}`).toString("base64")}`;
  let page = 1;
  let sum = 0, n = 0, withWrap = 0;
  for (; page <= 20; page++) {
    const params = new URLSearchParams({
      date_from: `${ymd} 00:00:00`,
      date_to: `${ymd} 23:59:59`,
      limit: "1000",
      page: String(page),
    });
    const res = await fetch(`https://my.cloudtalk.io/api/calls/index.json?${params}`, {
      headers: { Authorization: auth, Accept: "application/json" },
    });
    const json = (await res.json()) as { responseData: { data: CtItem[]; pageCount: number; pageNumber: number } };
    const items = json.responseData?.data ?? [];
    for (const it of items) {
      const agentId = it.Cdr.user_id ?? it.Agent?.id;
      if (!agentId || !ids.has(String(agentId))) continue;
      if (it.Cdr.type !== "outgoing") continue;
      if (berlinDay(new Date(it.Cdr.started_at)) !== ymd) continue;
      const w = Number(it.Cdr.wrapup_time) || 0;
      n++; sum += w;
      if (w > 0) withWrap++;
    }
    if (items.length < 1000 || page >= (json.responseData?.pageCount ?? 1)) break;
  }
  console.log(`${ymd}: исходящих МОПов=${n}, avg wrapup=${(sum / Math.max(1, n)).toFixed(1)}с (виджет CT: 24с), с wrapup>0: ${withWrap}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
