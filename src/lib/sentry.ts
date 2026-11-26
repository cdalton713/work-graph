import { captureMessage, captureReactException, globalHandlersIntegration, init } from "@sentry/react";
import type { ErrorInfo } from "react";
import type { ErrorEvent } from "@sentry/react";

export interface BrowserSentryConfig {
  dsn: string;
  environment: string;
  release: string;
  test?: boolean;
}

const testMessage = "work-graph sentry test";
const boundaryMechanism = "auto.function.react.error_boundary";
const captureMechanisms = new Set([
  boundaryMechanism, "onerror", "onunhandledrejection",
  "auto.browser.global_handlers.onerror", "auto.browser.global_handlers.onunhandledrejection",
]);

function assetPath(url?: string) {
  return url?.split(/[?#]/, 1)[0].match(/\/assets\/[a-zA-Z][\w.-]*-[\w-]{8}\.js$/)?.[0];
}

// Page URLs, breadcrumbs, exception messages and source context can contain private data.
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const values = event.exception?.values?.map(({ type, stacktrace, mechanism }) => ({
    type: type && (type === "DOMException" || /^[A-Z][A-Za-z]{0,40}Error$/.test(type)) ? type : "Error",
    value: "Page error",
    ...(mechanism && { mechanism: {
      type: captureMechanisms.has(mechanism.type) ? mechanism.type : "generic",
      ...(typeof mechanism.handled === "boolean" && { handled: mechanism.handled }),
    } }),
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
  return (error: unknown, info: ErrorInfo) => captureReactException(error, info, {
    mechanism: { type: boundaryMechanism, handled: true },
  });
}
