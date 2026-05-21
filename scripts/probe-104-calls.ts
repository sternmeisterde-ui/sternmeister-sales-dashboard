// Get the 104 filtered leads and probe what call durations they actually have.
import { kommoFetchPath } from "../src/lib/kommo/client";

const KOMMO_URL = "https://sternmeister.kommo.com/leads/list/pipeline/10935879/?filter%5Bpipe%5D%5B10935879%5D%5B%5D=101935919&filter%5Bpipe%5D%5B10935879%5D%5B%5D=104211575&filter%5Bpipe%5D%5B10935879%5D%5B%5D=142&filter%5Bpipe%5D%5B10935879%5D%5B%5D=143&filter%5Bpipe%5D%5B10935879%5D%5B%5D=83873491&filter%5Bpipe%5D%5B10935879%5D%5B%5D=90367079&filter%5Bpipe%5D%5B10935879%5D%5B%5D=90367083&filter%5Bpipe%5D%5B10935879%5D%5B%5D=90367087&filter%5Bpipe%5D%5B10935879%5D%5B%5D=95514983&filter%5Bpipe%5D%5B10935879%5D%5B%5D=95514987&filter_date_from=14.05.2026&filter_date_to=17.05.2026&filter_date_switch=created&filter%5Bcf%5D%5B879824%5D%5B%5D=744186&filter%5Bcf%5D%5B879824%5D%5B%5D=744188&filter%5Bcf%5D%5B879824%5D%5B%5D=744190&filter%5Bcf%5D%5B879824%5D%5B%5D=744192&filter%5Bcf%5D%5B879824%5D%5B%5D=744304&filter%5Bcf%5D%5B879824%5D%5B%5D=744312&filter%5Bcf%5D%5B879824%5D%5B%5D=744314&filter%5Bcf%5D%5B879824%5D%5B%5D=744316&filter%5Bcf%5D%5B879824%5D%5B%5D=744318&filter%5Bcf%5D%5B879824%5D%5B%5D=744320&filter%5Bcf%5D%5B879824%5D%5B%5D=744384&filter%5Bcf%5D%5B879824%5D%5B%5D=745292&filter%5Bcf%5D%5B879824%5D%5B%5D=745304&filter%5Bcf%5D%5B879824%5D%5B%5D=746174&filter%5Bcf%5D%5B879824%5D%5B%5D=746700&filter%5Bcf%5D%5B879824%5D%5B%5D=750386&filter%5Bcf%5D%5B879824%5D%5B%5D=753840&filter%5Bcf%5D%5B879824%5D%5B%5D=753842&useFilter=y";

async function main() {
  // Fetch leads matching status + pipeline + created_at 14-17.05.2026
  const fp = new URL(KOMMO_URL).searchParams;
  const out = new URLSearchParams();
  let i = 0;
  for (const [k, v] of fp.entries()) {
    const m = k.match(/^filter\[pipe\]\[(\d+)\]\[\]$/);
    if (!m) continue;
    out.append(`filter[statuses][${i}][pipeline_id]`, m[1]);
    out.append(`filter[statuses][${i}][status_id]`, v);
    i++;
  }
  // Berlin 14.05 00:00 = 13.05 22:00 UTC = 1778450400
  // Berlin 17.05 23:59 = 17.05 21:59 UTC = 1778795999
  out.set("filter[created_at][from]", "1778450400");
  out.set("filter[created_at][to]", "1778795999");

  const leads: any[] = [];
  for (let p = 1; p <= 5; p++) {
    const data: any = await kommoFetchPath(`/leads?${out.toString()}&limit=250&page=${p}`);
    const batch = data?._embedded?.leads ?? [];
    if (!batch.length) break;
    leads.push(...batch);
    if (batch.length < 250) break;
  }
  // Apply CF filter (same as pipeline)
  const cfAllowed = new Set([744186,744188,744190,744192,744304,744312,744314,744316,744318,744320,744384,745292,745304,746174,746700,750386,753840,753842]);
  const filtered = leads.filter((l: any) => {
    const f = (l.custom_fields_values || []).find((c: any) => c.field_id === 879824);
    if (!f || !f.values?.length) return true; // empty allowed
    return f.values.some((v: any) => cfAllowed.has(v.enum_id));
  });
  console.log(`Total leads after filter: ${filtered.length}`);

  // Collect call note durations across all those leads
  const buckets = { "0s": 0, "1-30s": 0, "31s-1min": 0, "1-3min": 0, "3-5min": 0, "5-10min": 0, "10-20min": 0, ">20min": 0 };
  const samples: Array<{lead: number, dur: number, link: boolean}> = [];
  let scanned = 0;
  for (const l of filtered) {
    scanned++;
    if (scanned % 20 === 0) console.log(`  scanned ${scanned}/${filtered.length}...`);
    const notes: any = await kommoFetchPath(`/leads/${l.id}/notes?limit=250&filter[note_type][]=call_in&filter[note_type][]=call_out`);
    const arr = notes?._embedded?.notes ?? [];
    for (const n of arr) {
      const d = n.params?.duration || 0;
      const hasLink = !!n.params?.link;
      if (d === 0) buckets["0s"]++;
      else if (d <= 30) buckets["1-30s"]++;
      else if (d <= 60) buckets["31s-1min"]++;
      else if (d <= 180) buckets["1-3min"]++;
      else if (d <= 300) buckets["3-5min"]++;
      else if (d <= 600) buckets["5-10min"]++;
      else if (d <= 1200) buckets["10-20min"]++;
      else buckets[">20min"]++;
      if (d >= 180 && hasLink) samples.push({ lead: l.id, dur: d, link: hasLink });
    }
  }
  console.log("\n=== Duration distribution across 104 leads ===");
  for (const [k, v] of Object.entries(buckets)) console.log(`  ${k.padEnd(10)} ${v}`);
  console.log(`\n=== Samples with ≥3min + recording link ===`);
  samples.sort((a, b) => b.dur - a.dur);
  for (const s of samples.slice(0, 20)) console.log(`  lead ${s.lead}: ${Math.floor(s.dur/60)}min ${s.dur%60}s`);
}
main().catch((e) => { console.error(e); process.exit(1); });
