import * as Sentry from "@sentry/nextjs";

export async function register() {
  // Force IPv4-ONLY networking on the Node server. This host's container IPv6 is
  // broken in two distinct ways: some Google prefixes are unreachable
  // (ENETUNREACH — Neon hung ~10s per query on the AAAA), and others are
  // HIJACKED — a parked server answers on a Google IPv6 (e.g. sheets.googleapis.com
  // → 2001:4860:4846:400::) and returns an HTTP 400 "ppConfig" parking page.
  //
  // Happy Eyeballs (autoSelectFamily) does NOT save us from the hijack case:
  // the parked IPv6 endpoint connects FAST and wins the race against real
  // Google over IPv4, so the 500ms dead-attempt timeout never fires. The only
  // robust fix is to never attempt IPv6 at all:
  //   • ipv4first — dns.lookup returns the A record
  //   • autoSelectFamily=false — no family race, connect to that single IPv4
  // IPv4 is the proven-clean path here (curl -4 / node family:4 → real Google);
  // IPv6 is actively harmful, so IPv4-only is strictly safer, not just faster.
  // Node-runtime only — node:net / node:dns don't exist in the edge runtime.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const dns = await import("node:dns");
    const net = await import("node:net");
    dns.setDefaultResultOrder("ipv4first");
    net.setDefaultAutoSelectFamily(false);
  }

  Sentry.init({
    dsn: "https://417df473623479125e070780bf30b401@o4511055330410496.ingest.de.sentry.io/4511092564885584",
    sendDefaultPii: true,
    tracesSampleRate: 0.2,
    environment: "production",
    serverName: "Dashboard",
  });
}
