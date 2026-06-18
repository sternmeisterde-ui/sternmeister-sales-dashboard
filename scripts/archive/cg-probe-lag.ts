// Probe how recent date_till can be before CallGear rejects.
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

const URL = "https://dataapi.callgear.com/v2.0";

async function rpc(params: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "get.calls_report",
      params: { access_token: process.env.CALLGEAR_ACCESS_TOKEN, ...params },
    }),
  });
  return res.json();
}

const fmt = (d: Date): string => d.toISOString().slice(0, 19).replace("T", " ");

interface Res {
  result?: { data: unknown[]; metadata?: { total_items: number } };
  error?: { code: number; message: string; data?: unknown };
}

async function tryOffset(offsetSec: number): Promise<void> {
  const now = new Date();
  const to = new Date(now.getTime() - offsetSec * 1000);
  const from = new Date(to.getTime() - 15 * 60 * 1000);
  const r = (await rpc({
    date_from: fmt(from),
    date_till: fmt(to),
    fields: ["id"],
    limit: 5,
    offset: 0,
  })) as Res;
  const status = r.error
    ? `FAIL ${r.error.code} ${r.error.message}${r.error.data ? ` data=${JSON.stringify(r.error.data)}` : ""}`
    : `ok (data=${r.result?.data?.length ?? 0}, total=${r.result?.metadata?.total_items ?? "?"})`;
  console.log(`  date_till = now - ${String(offsetSec).padStart(5)}s (${fmt(to)})  →  ${status}`);
}

(async (): Promise<void> => {
  console.log("=== probing date_till offsets from now ===");
  for (const sec of [3 * 3600, 6 * 3600, 8 * 3600, 12 * 3600, 16 * 3600, 20 * 3600, 22 * 3600, 23 * 3600, 24 * 3600]) {
    await tryOffset(sec);
  }
})().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
