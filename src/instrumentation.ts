import * as Sentry from "@sentry/nextjs";

export function register() {
  Sentry.init({
    dsn: "https://417df473623479125e070780bf30b401@o4511055330410496.ingest.de.sentry.io/4511092564885584",
    sendDefaultPii: true,
    tracesSampleRate: 0.2,
    environment: "production",
    serverName: "Dashboard",
  });
}
