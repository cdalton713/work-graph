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
      registerEsmLoaderHooks: false,
    }));
    expect(sdk.captureMessage).toHaveBeenCalledExactlyOnceWith("work-graph sentry test", "info");
    expect(sdk.flush).toHaveBeenCalledOnce();
    const handler = process.listeners("unhandledRejection").find(listener => !previous.includes(listener));
    const rejection = new Error("private");
    expect(handler).toBeDefined();
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("process exit"); });
    sdk.flush.mockClear();
    await expect(handler!(rejection, Promise.resolve())).rejects.toThrow("process exit");
    expect(sdk.flush).toHaveBeenCalledExactlyOnceWith(2000);
    expect(stderr).toHaveBeenCalledExactlyOnceWith(rejection);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(sdk.captureException).toHaveBeenCalledExactlyOnceWith(rejection);
  } finally {
    for (const listener of process.listeners("unhandledRejection")) {
      if (!previous.includes(listener)) process.off("unhandledRejection", listener);
    }
    vi.restoreAllMocks();
    vi.doUnmock("@sentry/node");
  }
});

it.each([
  ["/build/server/db/tenants.ts", "tenants.ts"],
  ["/build/api/index.js", "index.js"],
  ["/build/server/../private/index.js", "<source>"],
  ["/build/src/index.js", "<source>"],
  ["/build/server/data.json", "<source>"],
  ["/build/server/app.js?token=private", "<source>"],
])("removes private paths from %s", (filename, expected) => {
  const event = scrubEvent({ type: undefined, exception: { values: [{ stacktrace: { frames: [{ filename }] } }] } });
  expect(event.exception?.values?.[0].stacktrace?.frames?.[0]?.filename).toBe(expected);
});

it("captures server errors once and skips expected client errors", async () => {
  const captureException = vi.fn();
  vi.doMock("./sentry.ts", async (original) => ({ ...await original<typeof import("./sentry.ts")>(), sentry: { captureException } }));
  try {
    const { createApp } = await import("./app.ts");
    const { LinearError } = await import("./linear.ts");
    const failure = new Error("service failure");
    const ready = vi.fn().mockRejectedValueOnce(failure).mockRejectedValueOnce(new LinearError("missing", 404));
    const page = createApp({ port: 4747, tailnet: null, hosted: null }, {
      dist: ".", team: "", serviceReady: ready, watchMs: 0,
    });
    expect((await page.request("/api/config")).status).toBe(500);
    expect(captureException).toHaveBeenCalledExactlyOnceWith(failure);
    expect((await page.request("/api/config")).status).toBe(404);
    expect(captureException).toHaveBeenCalledTimes(1);
  } finally {
    vi.doUnmock("./sentry.ts");
    vi.resetModules();
  }
});

it("waits for Sentry to flush before the Vercel entry returns", async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const flush = vi.fn(() => pending);
  vi.doMock("./sentry.ts", async (original) => ({ ...await original<typeof import("./sentry.ts")>(), sentry: { flush } }));
  try {
    const { createVercelApp } = await import("./vercel.ts");
    const { entry } = createVercelApp({
      WG_HOSTED: "localhost", WG_CONFIG_JSON: JSON.stringify({ workspaces: [{ id: "work", team: "WG" }] }),
    });
    if (!("fetch" in entry)) throw new Error("Expected the read-only fetch entry");
    const returned = vi.fn((response: Response) => response.status);
    const response = Promise.resolve(entry.fetch(new Request("https://localhost/api/config", {
      headers: { host: "localhost" },
    }))).then(returned);
    await vi.waitFor(() => expect(flush).toHaveBeenCalledExactlyOnceWith(2000));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(returned).not.toHaveBeenCalled();
    finish();
    expect(await response).toBe(200);
  } finally {
    finish();
    vi.doUnmock("./sentry.ts");
    vi.resetModules();
  }
});

it.each([
  ["release-tag", "123456789abcdef", "release-tag"],
  [undefined, "123456789abcdef", "1234567"],
  [undefined, undefined, "dev"],
])("uses release %s and Vercel commit %s consistently", async (version, commit, expected) => {
  vi.resetModules();
  vi.stubEnv("WG_VERSION", version);
  vi.stubEnv("VERCEL_GIT_COMMIT_SHA", commit);
  vi.stubEnv("SENTRY_AUTH_TOKEN", "build-token");
  vi.stubEnv("SENTRY_ORG", "test-org");
  vi.stubEnv("SENTRY_PROJECT_BROWSER", "browser");
  const upload = vi.fn(() => []);
  const init = vi.fn();
  vi.doMock("@sentry/vite-plugin", () => ({ sentryVitePlugin: upload }));
  vi.doMock("@sentry/node", () => ({ init, flush: vi.fn() }));
  const previous = process.listeners("unhandledRejection");
  try {
    const { default: configureBuild } = await import("../vite.config.ts");
    configureBuild({ command: "build", mode: "production" });
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ release: expect.objectContaining({ name: expected }) }));

    const env = {
      WG_VERSION: version, VERCEL_GIT_COMMIT_SHA: commit, WG_SENTRY_DSN: "server", WG_SENTRY_BROWSER_DSN: "browser",
      WG_HOSTED: "localhost", WG_CONFIG_JSON: JSON.stringify({ workspaces: [{ id: "work", team: "WG" }] }),
    };
    const { startSentry } = await import("./sentry.ts");
    await startSentry(env);
    expect(init).toHaveBeenCalledWith(expect.objectContaining({ release: expected }));
    const { createVercelApp } = await import("./vercel.ts");
    const { app } = createVercelApp(env);
    const response = await app.request("/api/config", { headers: { host: "localhost" } });
    expect(await response.json()).toMatchObject({ version: expected, sentry: { release: expected } });
  } finally {
    for (const listener of process.listeners("unhandledRejection")) {
      if (!previous.includes(listener)) process.off("unhandledRejection", listener);
    }
    vi.unstubAllEnvs();
    vi.doUnmock("@sentry/vite-plugin");
    vi.doUnmock("@sentry/node");
    vi.resetModules();
  }
});
