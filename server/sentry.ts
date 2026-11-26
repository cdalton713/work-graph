// The Node SDK loads only when the server entry point has a DSN.
import type { ErrorEvent } from "@sentry/node";

const testMessage = "work-graph sentry test";
const errorTypes = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError",
  "LinkRoomFull", "NeedsLinearAccess", "LinearSignInRequired", "RedisUnavailable", "RedisCommandFailed", "LinearError"]);

// Keep only diagnostic fields. Messages, source lines and request context can all contain plan text.
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const values = event.exception?.values?.map(({ type, stacktrace }) => ({
    type: type && errorTypes.has(type) ? type : "Error",
    value: "Server error",
    stacktrace: { frames: stacktrace?.frames?.map(({ filename, lineno, colno }) => ({
      filename: filename?.match(/\/server\/((?:app|linear|link|main|vercel|tenants|auth|plans|sentry)\.ts)$/)?.[1] ?? "<source>",
      lineno, colno,
    })) },
  }));
  return {
    type: undefined, event_id: event.event_id, timestamp: event.timestamp, level: event.level,
    platform: "node", environment: event.environment, release: event.release,
    ...(values ? { exception: { values } } : { message: event.message === testMessage ? testMessage : "Server error" }),
  };
}

export let sentry: typeof import("@sentry/node") | undefined;

export async function startSentry(env: NodeJS.ProcessEnv) {
  if (!env.WG_SENTRY_DSN || sentry) return;
  const sdk = await import("@sentry/node");
  sdk.init({
    dsn: env.WG_SENTRY_DSN, environment: env.WG_SENTRY_ENVIRONMENT || "production",
    release: env.WG_VERSION || "dev", sendDefaultPii: false, beforeSend: scrubEvent,
    defaultIntegrations: false, skipOpenTelemetrySetup: true, spotlight: false,
    sendClientReports: false,
  });
  sentry = sdk;
  process.on("unhandledRejection", (reason) => { sdk.captureException(reason); });
  if (env.WG_SENTRY_TEST_EVENT === "1") {
    sdk.captureMessage(testMessage, "info");
    await sdk.flush(2000);
  }
}
