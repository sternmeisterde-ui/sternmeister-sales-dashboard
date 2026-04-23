// One-shot ETL runner — bypasses Next.js auth for CLI use
// Usage: node --env-file=.env.local scripts/run-etl.mjs [from] [to]
// Example: node --env-file=.env.local scripts/run-etl.mjs 2026-04-16 2026-04-23
//
// Imports the compiled ETL via Next.js's own module resolution isn't possible from
// plain Node, so this script calls the local API endpoint instead.
// Requires the dev server to be running on port 3008 with an admin session cookie.
//
// ---- ALTERNATIVE: direct DB insert via curl to the sync API ----
// If dev server isn't running, use the helper below to call Kommo directly.

const [fromArg, toArg] = process.argv.slice(2);
const from = fromArg ?? new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
const to   = toArg   ?? new Date().toISOString().slice(0, 10);

const PORT = process.env.DEV_PORT ?? 3008;
const COOKIE = process.env.SESSION_COOKIE ?? "";

if (!COOKIE) {
  console.error("Set SESSION_COOKIE env var to your admin session cookie value");
  console.error("Get it from DevTools → Application → Cookies → session");
  process.exit(1);
}

console.log(`Triggering ETL sync: ${from} → ${to}`);

const res = await fetch(`http://localhost:${PORT}/api/analytics/sync`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Cookie: `session=${COOKIE}`,
  },
  body: JSON.stringify({ from, to }),
});

const json = await res.json();
console.log("Status:", res.status);
console.log("Result:", JSON.stringify(json, null, 2));
