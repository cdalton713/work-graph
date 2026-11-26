// The Node SDK loads only when the server entry point has a DSN.
import { posix } from "node:path";
import type { ErrorEvent } from "@sentry/node";

const testMessage = "work-graph sentry test";
const errorTypes = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError",
  "LinkRoomFull", "NeedsLinearAccess", "LinearSignInRequired", "RedisUnavailable", "RedisCommandFailed", "LinearError"]);

function frameName(filename?: string): string {
  if (!filename || /[?#]/.test(filename)) return "<source>";
  const path = posix.normalize(filename.replaceAll("\\", "/"));
  return /(?:^|\/)(?:server|api)\/(?:[^/]+\/)*([^/]+\.(?:ts|js))$/.exec(path)?.[1] ?? "<source>";
}

// Keep only diagnostic fields. Messages, source lines and request context can all contain plan text.
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const values = event.exception?.values?.map(({ type, stacktrace }) => ({
    type: type && errorTypes.has(type) ? type : "Error",
    value: "Server error",
    stacktrace: { frames: stacktrace?.frames?.map(({ filename, lineno, colno }) => ({
      filename: frameName(filename),
      lineno, colno,
    })) },
  }));
  return {
    type: undefined, event_id: event.event_id, timestamp: event.timestamp, level: event.level,
    platform: "node", environment: event.environment, release: event.release,
    ...(values ? { exception: { values } } : { message: event.message === testMessage ? testMessage : "Server error" }),
  };
}

export function releaseVersion(env: NodeJS.ProcessEnv): string {
  return env.WG_VERSION || env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || "dev";
}

export let sentry: typeof import("@sentry/node") | undefined;

export async function startSentry(env: NodeJS.ProcessEnv) {
  if (!env.WG_SENTRY_DSN || sentry) return;
  const sdk = await import("@sentry/node");
  sdk.init({
    dsn: env.WG_SENTRY_DSN, environment: env.WG_SENTRY_ENVIRONMENT || "production",
    release: releaseVersion(env), sendDefaultPii: false, beforeSend: scrubEvent,
    defaultIntegrations: false, skipOpenTelemetrySetup: true, registerEsmLoaderHooks: false, spotlight: false,
    sendClientReports: false,
  });
  sentry = sdk;
  process.on("unhandledRejection", async (reason) => {
    try {
      sdk.captureException(reason);
      await sdk.flush(2000);
    } finally {
      console.error(reason);
      process.exit(1);
    }
  });
  if (env.WG_SENTRY_TEST_EVENT === "1") {
    sdk.captureMessage(testMessage, "info");
    await sdk.flush(2000);
  }
}
