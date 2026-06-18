// Show all notes (any type) per expected lead in 14-17.05.2026 window.
import { kommoFetchPath } from "../src/lib/kommo/client";

const EXPECTED = [18808190, 14579346, 18594580, 16329684, 12689418, 14496730, 13026014, 14489140, 11555672];
const FROM = 1778450400;
const TO = 1778795999;

async function main() {
  for (const id of EXPECTED) {
    let all: any[] = [];
    for (let p = 1; p <= 10; p++) {
      const data: any = await kommoFetchPath(`/leads/${id}/notes?limit=250&page=${p}`);
      const batch = data?._embedded?.notes ?? [];
      if (!batch.length) break;
      all = all.concat(batch);
      if (batch.length < 250) break;
    }
    const inWin = all.filter((n: any) => n.created_at >= FROM && n.created_at <= TO);
    console.log(`${id}: ${all.length} total notes, ${inWin.length} in window`);
    for (const n of inWin) {
      console.log(`  ${new Date(n.created_at * 1000).toISOString().slice(0, 16)}  type=${n.note_type}  by=${n.created_by}  text=${(n.params?.text || n.params?.link || '').slice(0,60)}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
