import { captureMessage, globalHandlersIntegration, init } from "@sentry/react";
import { ErrorBoundary } from "../components/ErrorBoundary";
import type { ErrorEvent } from "@sentry/react";

export interface BrowserSentryConfig {
  dsn: string;
  environment: string;
  release: string;
  test?: boolean;
}

const testMessage = "work-graph sentry test";
const errorTypes = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError"]);

function assetPath(url?: string) {
  return url?.split(/[?#]/, 1)[0].match(/\/assets\/[a-zA-Z][\w.-]*-[\w-]{8}\.js$/)?.[0];
}

// Page URLs, breadcrumbs, exception messages and source context can contain private data.
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const values = event.exception?.values?.map(({ type, stacktrace }) => ({
    type: type && errorTypes.has(type) ? type : "Error",
    value: "Page error",
    stacktrace: { frames: stacktrace?.frames?.map(({ filename, lineno, colno }) => ({
      filename: assetPath(filename) ?? "<source>",
      lineno, colno,
    })) },
  }));
  const images = event.debug_meta?.images?.flatMap(image => {
    const file = assetPath(image.code_file);
    if (image.type !== "sourcemap" || !file || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(image.debug_id)) return [];
    return [{ type: image.type, debug_id: image.debug_id, code_file: file }];
  });
  return {
    ...(images?.length ? { debug_meta: { images } } : {}),
    type: undefined, event_id: event.event_id, timestamp: event.timestamp, level: event.level,
    platform: "javascript", environment: event.environment, release: event.release,
    ...(values ? { exception: { values } } : { message: event.message === testMessage ? testMessage : "Page error" }),
  };
}

export function startSentry({ dsn, environment, release, test }: BrowserSentryConfig) {
  init({
    dsn, environment, release, sendDefaultPii: false, sendClientReports: false,
    defaultIntegrations: false, integrations: [globalHandlersIntegration()],
    beforeSend: scrubEvent,
    transportOptions: { fetchOptions: { credentials: "omit", referrerPolicy: "no-referrer" } },
  });
  if (test === true) captureMessage(testMessage, "info");
  return ErrorBoundary;
}
