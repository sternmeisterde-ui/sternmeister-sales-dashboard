// Probe tasks for expected leads to see if any tasks fall into 14-17.05.2026.
//   npx tsx --env-file=.env.local scripts/probe-tasks.ts
import { kommoFetchPath } from "../src/lib/kommo/client";

const EXPECTED = [18808190, 14579346, 18594580, 16329684, 12689418, 14496730, 13026014, 14489140, 11555672];
const FROM = 1778450400; // 14.05.2026 00:00 Berlin
const TO = 1778795999;   // 17.05.2026 23:59 Berlin

async function main() {
  for (const id of EXPECTED) {
    const data: any = await kommoFetchPath(`/tasks?filter[entity_type]=leads&filter[entity_id]=${id}&limit=250`);
    const tasks = data?._embedded?.tasks ?? [];
    const inWin = tasks.filter((t: any) => (t.complete_till >= FROM && t.complete_till <= TO) || (t.updated_at >= FROM && t.updated_at <= TO) || (t.created_at >= FROM && t.created_at <= TO));
    console.log(`${id}: ${tasks.length} tasks total, ${inWin.length} in window`);
    for (const t of inWin) {
      const fmt = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 16);
      console.log(`  task ${t.id}  complete_till=${fmt(t.complete_till)}  updated=${fmt(t.updated_at)}  created=${fmt(t.created_at)}  isCompleted=${t.is_completed}  text=${(t.text||'').slice(0,60)}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
