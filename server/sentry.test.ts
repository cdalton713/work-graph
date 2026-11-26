import { expect, it, vi } from "vitest";
import { scrubEvent, startSentry } from "./sentry.ts";

it("omits request credentials, bodies and copies in SDK context and exception text", () => {
  const secret = "private-test-value";
  const event = scrubEvent({
    type: undefined, event_id: "id",
    request: {
      headers: { Authorization: secret, Cookie: secret, "Set-Cookie": secret },
      url: "/api?token=" + secret, query_string: "key=" + secret, data: secret,
    },
    breadcrumbs: [{ message: secret }], extra: { plan: secret },
    exception: { values: [{ type: "TypeError", value: secret, stacktrace: {
      frames: [{ filename: "/server/app.ts", lineno: 23, vars: { key: secret } }],
    } }] },
  });
  expect(JSON.stringify(event)).not.toContain(secret);
  expect(event.exception?.values?.[0]).toMatchObject({
    type: "TypeError", stacktrace: { frames: [{ filename: "app.ts", lineno: 23 }] },
  });
});

it("starts the SDK only with a DSN and sends the startup event once", async () => {
  const sdk = { init: vi.fn(), captureMessage: vi.fn(), captureException: vi.fn(), flush: vi.fn() };
  const load = vi.fn(() => sdk);
  vi.doMock("@sentry/node", load);
  const previous = process.listeners("unhandledRejection");
  try {
    const env = { WG_SENTRY_TEST_EVENT: "1", WG_VERSION: "build" };
    await startSentry(env);
    expect(load).not.toHaveBeenCalled();
    const enabled = { ...env, WG_SENTRY_DSN: "server" };
    await startSentry(enabled);
    await startSentry(enabled);
    expect(sdk.init).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      dsn: "server", environment: "production", release: "build", sendDefaultPii: false, beforeSend: scrubEvent,
    }));
    expect(sdk.captureMessage).toHaveBeenCalledExactlyOnceWith("work-graph sentry test", "info");
    expect(sdk.flush).toHaveBeenCalledOnce();
    const handler = process.listeners("unhandledRejection").find(listener => !previous.includes(listener));
    const rejection = new Error("private");
    expect(handler).toBeDefined();
    handler!(rejection, Promise.resolve());
    expect(sdk.captureException).toHaveBeenCalledExactlyOnceWith(rejection);
  } finally {
    for (const listener of process.listeners("unhandledRejection")) {
      if (!previous.includes(listener)) process.off("unhandledRejection", listener);
    }
    vi.doUnmock("@sentry/node");
  }
});
