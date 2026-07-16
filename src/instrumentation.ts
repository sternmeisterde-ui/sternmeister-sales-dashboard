import * as Sentry from "@sentry/nextjs";

export async function register() {
  // Force IPv4-first networking on the Node server. On networks with broken
  // IPv6 routing the Neon serverless driver (global fetch / undici) otherwise
  // prefers an AAAA address and hangs ~10s per query until it times out —
  // taking down every DB-backed route (all six Neon connections). curl stays
  // fine because it falls back to IPv4 via Happy Eyeballs; we make Node do the
  // same:
  //   • ipv4first — return A records ahead of AAAA from dns.lookup
  //   • autoSelectFamily + short attempt timeout — race address families and
  //     abandon a dead IPv6 attempt after 500ms instead of blocking on it
  // Harmless where IPv6 works: it only biases ordering and adds a fast race.
  // Node-runtime only — node:net / node:dns don't exist in the edge runtime.
  //
  // NB: this biases ordering but does NOT fully pin fetch/undici to IPv4 — on
  // this host undici can still land on a hijacked route for some Google hosts
  // (see src/lib/enps/sheets.ts, which uses node:https + family:4 to work
  // around exactly that). Kept because it fixes the Neon AAAA-hang.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const dns = await import("node:dns");
    const net = await import("node:net");
    dns.setDefaultResultOrder("ipv4first");
    net.setDefaultAutoSelectFamily(true);
    net.setDefaultAutoSelectFamilyAttemptTimeout(500);
  }

  Sentry.init({
    dsn: "https://417df473623479125e070780bf30b401@o4511055330410496.ingest.de.sentry.io/4511092564885584",
    sendDefaultPii: true,
    tracesSampleRate: 0.2,
    environment: "production",
    serverName: "Dashboard",
  });
}
