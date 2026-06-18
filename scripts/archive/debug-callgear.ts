// Diagnostic: probe CallGear get.calls_report — narrow down which param
// triggers -32602. Skips the field-bisect (proven irrelevant) and tries
// different request shapes.
//
//   npx tsx scripts/debug-callgear.ts
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

const URL = "https://dataapi.callgear.com/v2.0";

interface RpcRes<T = unknown> {
  jsonrpc: string;
  id: number;
  result?: { data: T[]; metadata?: { total_items?: number } };
  error?: { code: number; message: string; data?: unknown };
}

async function rpc<T = unknown>(
  method: string,
  params: Record<string, unknown>,
  withToken = true,
): Promise<RpcRes<T>> {
  const token = process.env.CALLGEAR_ACCESS_TOKEN;
  if (withToken && !token) throw new Error("CALLGEAR_ACCESS_TOKEN missing");
  const fullParams = withToken ? { access_token: token, ...params } : params;
  const res = await fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * 1e9),
      method,
      params: fullParams,
    }),
  });
  return (await res.json()) as RpcRes<T>;
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

async function probe(label: string, method: string, params: Record<string, unknown>): Promise<void> {
  const r = await rpc(method, params);
  const status = r.error
    ? `FAIL -${Math.abs(r.error.code)} ${r.error.message}${r.error.data ? ` (${JSON.stringify(r.error.data)})` : ""}`
    : `ok (data=${r.result?.data?.length ?? 0}, total=${r.result?.metadata?.total_items ?? "?"})`;
  console.log(`  ${label.padEnd(60)} → ${status}`);
}

async function main(): Promise<void> {
  const tokenLen = process.env.CALLGEAR_ACCESS_TOKEN?.length ?? 0;
  console.log(`=== CallGear probe ===`);
  console.log(`  token: ${tokenLen > 0 ? `present (${tokenLen} chars)` : "MISSING"}\n`);

  // ── A. Auth / method discovery ────────────────────────────────────────
  console.log("[A] Method-level checks (small payloads)");
  await probe("get.account                                   ", "get.account", {});
  await probe("get.employees with limit/offset               ", "get.employees", {
    limit: 5,
    offset: 0,
    fields: ["id", "full_name"],
  });

  // ── B. Date-range variations ──────────────────────────────────────────
  console.log("\n[B] get.calls_report — date range variations");
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const yesterdayMinus1h = new Date(yesterday.getTime() - 60 * 60 * 1000);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const weekAgoPlus5m = new Date(weekAgo.getTime() + 5 * 60 * 1000);

  // Without fields, with limit/offset
  await probe(
    "yesterday window, no fields                  ",
    "get.calls_report",
    {
      date_from: fmt(yesterdayMinus1h),
      date_till: fmt(yesterday),
      limit: 10,
      offset: 0,
    },
  );

  await probe(
    "yesterday window, fields=[id]                ",
    "get.calls_report",
    {
      date_from: fmt(yesterdayMinus1h),
      date_till: fmt(yesterday),
      fields: ["id"],
      limit: 10,
      offset: 0,
    },
  );

  await probe(
    "week-ago narrow, fields=[id]                 ",
    "get.calls_report",
    {
      date_from: fmt(weekAgo),
      date_till: fmt(weekAgoPlus5m),
      fields: ["id"],
      limit: 10,
      offset: 0,
    },
  );

  // No limit/offset
  await probe(
    "yesterday window, no limit/offset, fields=[id]",
    "get.calls_report",
    {
      date_from: fmt(yesterdayMinus1h),
      date_till: fmt(yesterday),
      fields: ["id"],
    },
  );

  // Date-only (no time)
  await probe(
    "date-only YYYY-MM-DD                         ",
    "get.calls_report",
    {
      date_from: fmt(yesterdayMinus1h).slice(0, 10),
      date_till: fmt(yesterday).slice(0, 10),
      fields: ["id"],
      limit: 10,
      offset: 0,
    },
  );

  // ── C. Auth check — bad token ─────────────────────────────────────────
  console.log("\n[C] Auth distinction — what does invalid token look like?");
  const r = await rpc(
    "get.calls_report",
    {
      access_token: "DEFINITELY_INVALID_TOKEN",
      date_from: fmt(yesterdayMinus1h),
      date_till: fmt(yesterday),
      fields: ["id"],
      limit: 10,
      offset: 0,
    },
    false, // don't add real token
  );
  console.log(`  bad-token error: ${r.error ? `code=${r.error.code} msg="${r.error.message}"` : "ok??"}`);

  // ── D. Raw debug dump on the failing request ─────────────────────────
  console.log("\n[D] Verbose dump of the actual failing call");
  const detail = await rpc("get.calls_report", {
    date_from: fmt(yesterdayMinus1h),
    date_till: fmt(yesterday),
    fields: ["id"],
    limit: 10,
    offset: 0,
  });
  console.log(JSON.stringify(detail, null, 2));
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
