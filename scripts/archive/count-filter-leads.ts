// Apply URL's filter via current pipeline parser & count leads. Read-only.
import { kommoFetchPath } from "../src/lib/kommo/client";

const URL_TO_TEST = "https://sternmeister.kommo.com/leads/list/pipeline/10935879/?filter%5Bpipe%5D%5B10935879%5D%5B%5D=101935919&filter%5Bpipe%5D%5B10935879%5D%5B%5D=104211575&filter%5Bpipe%5D%5B10935879%5D%5B%5D=142&filter%5Bpipe%5D%5B10935879%5D%5B%5D=143&filter%5Bpipe%5D%5B10935879%5D%5B%5D=83873491&filter%5Bpipe%5D%5B10935879%5D%5B%5D=90367079&filter%5Bpipe%5D%5B10935879%5D%5B%5D=90367083&filter%5Bpipe%5D%5B10935879%5D%5B%5D=90367087&filter%5Bpipe%5D%5B10935879%5D%5B%5D=95514983&filter%5Bpipe%5D%5B10935879%5D%5B%5D=95514987&filter_date_from=14.05.2026&filter_date_to=17.05.2026&filter%5Bcf%5D%5B879824%5D%5B%5D=744186&filter%5Bcf%5D%5B879824%5D%5B%5D=744188&filter%5Bcf%5D%5B879824%5D%5B%5D=744190&filter%5Bcf%5D%5B879824%5D%5B%5D=744192&filter%5Bcf%5D%5B879824%5D%5B%5D=744304&filter%5Bcf%5D%5B879824%5D%5B%5D=744312&filter%5Bcf%5D%5B879824%5D%5B%5D=744314&filter%5Bcf%5D%5B879824%5D%5B%5D=744316&filter%5Bcf%5D%5B879824%5D%5B%5D=744318&filter%5Bcf%5D%5B879824%5D%5B%5D=744320&filter%5Bcf%5D%5B879824%5D%5B%5D=744384&filter%5Bcf%5D%5B879824%5D%5B%5D=745292&filter%5Bcf%5D%5B879824%5D%5B%5D=745304&filter%5Bcf%5D%5B879824%5D%5B%5D=746174&filter%5Bcf%5D%5B879824%5D%5B%5D=746700&filter%5Bcf%5D%5B879824%5D%5B%5D=750386&filter%5Bcf%5D%5B879824%5D%5B%5D=753840&filter%5Bcf%5D%5B879824%5D%5B%5D=753842&filter%5Bcf%5D%5B879824%5D%5B%5D=empty&useFilter=y";

// Try several date_switch values and report counts to figure out which Kommo CRM uses.
async function tryWithSwitch(swc: string | null) {
  const url = new URL(URL_TO_TEST);
  if (swc) url.searchParams.set("filter_date_switch", swc);
  else url.searchParams.delete("filter_date_switch");
  // Build API query manually (same logic as pipeline)
  const fp = url.searchParams;
  const out = new URLSearchParams();
  const PIPE_RE = /^filter\[pipe\]\[(\d+)\]\[\]$/;
  let i = 0;
  for (const [k, v] of fp.entries()) {
    const m = k.match(PIPE_RE);
    if (!m) continue;
    out.append(`filter[statuses][${i}][pipeline_id]`, m[1]);
    out.append(`filter[statuses][${i}][status_id]`, v);
    i++;
  }
  const df = fp.get("filter_date_from");
  const dt = fp.get("filter_date_to");
  if (swc && df && dt) {
    const [d1,m1,y1] = df.split('.');
    const [d2,m2,y2] = dt.split('.');
    const from = Math.floor(new Date(Date.UTC(+y1,+m1-1,+d1,0,0,0)).getTime()/1000) - 2*3600; // Berlin DST
    const to = Math.floor(new Date(Date.UTC(+y2,+m2-1,+d2,23,59,59)).getTime()/1000) - 2*3600;
    const field = swc === "closed" ? "closed_at" : swc === "updated" ? "updated_at" : "created_at";
    out.set(`filter[${field}][from]`, String(from));
    out.set(`filter[${field}][to]`, String(to));
  }
  // Collect CF filter (client-side). Also track which fields allow "empty".
  const CF_RE = /^filter\[cf\]\[(\d+)\]\[\]$/;
  const cfFilter = new Map<number, Set<number>>();
  const cfAllowEmpty = new Set<number>();
  for (const [k, v] of fp.entries()) {
    const m = k.match(CF_RE);
    if (!m) continue;
    const fid = Number(m[1]);
    if (v === "empty") { cfAllowEmpty.add(fid); continue; }
    const eid = Number(v);
    if (!Number.isFinite(fid) || !Number.isFinite(eid)) continue;
    if (!cfFilter.has(fid)) cfFilter.set(fid, new Set());
    cfFilter.get(fid)!.add(eid);
  }
  const leads: any[] = [];
  for (let page = 1; page <= 20; page++) {
    const data: any = await kommoFetchPath(`/leads?${out.toString()}&limit=250&page=${page}`);
    const batch = data?._embedded?.leads ?? [];
    if (!batch.length) break;
    leads.push(...batch);
    if (batch.length < 250) break;
  }
  const filtered = leads.filter((l) => {
    if (cfFilter.size === 0 && cfAllowEmpty.size === 0) return true;
    const allFids = new Set<number>([...cfFilter.keys(), ...cfAllowEmpty]);
    for (const fid of allFids) {
      const f = (l.custom_fields_values || []).find((c: any) => c.field_id === fid);
      const isEmpty = !f || !f.values || f.values.length === 0;
      const allowed = cfFilter.get(fid);
      const hasMatch = !isEmpty && allowed && f.values.some((v: any) => v.enum_id !== undefined && allowed.has(v.enum_id));
      if (cfAllowEmpty.has(fid) && isEmpty) continue;
      if (hasMatch) continue;
      return false;
    }
    return true;
  });
  console.log(`switch=${swc ?? '<none>'}: api=${leads.length} → after CF=${filtered.length}`);
}

async function main() {
  for (const s of ["created", "updated", "closed", null]) await tryWithSwitch(s);
}
main().catch((e) => { console.error(e); process.exit(1); });
