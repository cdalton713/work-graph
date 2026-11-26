import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { scrubEvent } from "./sentry";

it("drops URL queries, credential headers, breadcrumb bodies and exception text", () => {
  const secret = "private-plan-text";
  const event = scrubEvent({
    type: undefined, event_id: "id", request: {
      url: "/?token=" + secret, headers: { authorization: secret, cookie: secret }, data: secret,
    },
    debug_meta: { images: [{ type: "sourcemap", debug_id: "12345678-1234-1234-1234-123456789abc",
      code_file: "/assets/index-Qx4abc12.js?key=" + secret }] },
    breadcrumbs: [{ category: "fetch", data: { url: "/api?key=" + secret, body: secret } }],
    extra: { plan: secret }, message: secret,
    exception: { values: [{ type: "TypeError", value: secret, stacktrace: {
      frames: [{ filename: "/assets/index-Qx4abc12.js?key=" + secret, lineno: 4, colno: 2, vars: { secret } }],
    } }] },
  });
  expect(JSON.stringify(event)).not.toContain(secret);
  expect(event.debug_meta?.images?.[0].code_file).toBe("/assets/index-Qx4abc12.js");
  expect(event.exception?.values?.[0]).toMatchObject({
    type: "TypeError", stacktrace: { frames: [{ filename: "/assets/index-Qx4abc12.js", lineno: 4, colno: 2 }] },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock("@sentry/react");
  vi.doUnmock("react-dom/client");
});

it("preserves diagnostic exception types and fixed capture mechanisms", () => {
  const mechanism = { type: "auto.browser.global_handlers.onerror", handled: false, data: { secret: "private" } };
  const values = scrubEvent({ type: undefined, exception: { values: [
    { type: "ChunkLoadError", mechanism }, { type: "DOMException" },
    { type: "Private plan", mechanism: { ...mechanism, type: "private" } },
  ] } }).exception?.values;
  expect(values?.map(value => value.type)).toEqual(["ChunkLoadError", "DOMException", "Error"]);
  expect(values?.[0].mechanism).toEqual({ type: mechanism.type, handled: false });
  expect(JSON.stringify(values)).not.toContain("private");
});

function mockPage(path: string) {
  const render = vi.fn();
  vi.doMock("react-dom/client", () => ({ createRoot: () => ({ render }) }));
  vi.stubGlobal("document", { getElementById: () => ({}) });
  vi.stubGlobal("location", { pathname: path, search: "" });
  vi.stubGlobal("history", { replaceState: vi.fn() });
  return render;
}

it("renders the join page while its config request is pending", async () => {
  const render = mockPage("/join/invite");
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  await import("../main");
  expect(render).toHaveBeenCalledOnce();
  expect(render.mock.calls[0][0].props.children.props.path).toBe("/join/invite");
});

it("renders the main page once while the SDK loads and if initialization fails", async () => {
  const render = mockPage("/");
  vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ sentry: { dsn: "browser" } }) }));
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const init = vi.fn(() => { throw new Error("SDK unavailable"); });
  vi.doMock("@sentry/react", async () => {
    await pending;
    return { init, globalHandlersIntegration: vi.fn() };
  });
  await import("../main");
  try {
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
  } finally {
    finish();
    await vi.dynamicImportSettled();
  }
  expect(init).toHaveBeenCalledOnce();
  expect(render).toHaveBeenCalledOnce();
});

it("serves the browser test flag only when enabled", async () => {
  const { createApp } = await import("../../server/app");
  const telemetryEnv: NodeJS.ProcessEnv = { WG_SENTRY_BROWSER_DSN: "browser" };
  const app = createApp({ port: 4747, tailnet: null }, { team: "", dist: "dist", telemetryEnv });
  const config = async () => (await app.request("/api/config", { headers: { host: "127.0.0.1:4747" } })).json();
  expect((await config()).sentry).not.toHaveProperty("test");
  telemetryEnv.WG_SENTRY_TEST_EVENT = "1";
  expect((await config()).sentry.test).toBe(true);
});

it.each([
  { path: "/", enabled: false, test: false },
  { path: "/", enabled: true, test: true },
  { path: "/join/invite", enabled: true, test: false },
])("loads monitoring on $path with enabled=$enabled and test=$test", async ({ path, enabled, test }) => {
  const render = mockPage(path);
  const init = vi.fn();
  const captureMessage = vi.fn();
  const captureReactException = vi.fn();
  const load = vi.fn(() => ({
    init, captureMessage, captureReactException, globalHandlersIntegration: () => ({ name: "GlobalHandlers" }),
  }));
  vi.doMock("@sentry/react", load);
  const config = { dsn: "browser", environment: "preview", release: "build", test };
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => enabled ? { sentry: config } : {} })));
  await import("../main");
  await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
  await vi.dynamicImportSettled();
  expect(load).toHaveBeenCalledTimes(enabled ? 1 : 0);
  if (enabled) expect(init).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    dsn: "browser", environment: "preview", release: "build", sendDefaultPii: false,
    defaultIntegrations: false, integrations: [{ name: "GlobalHandlers" }], beforeSend: expect.any(Function),
  }));
  if (enabled && path === "/") {
    const error = new Error("render error");
    const info = { componentStack: "App" };
    render.mock.calls[0][0].props.children.props.onError(error, info);
    await vi.waitFor(() => expect(captureReactException).toHaveBeenCalledExactlyOnceWith(error, info, {
      mechanism: { type: "auto.function.react.error_boundary", handled: true },
    }));
  }
  if (test) expect(captureMessage).toHaveBeenCalledExactlyOnceWith("work-graph sentry test", "info");
  else expect(captureMessage).not.toHaveBeenCalled();
});

it("shows the fallback and reports a child render error", async () => {
  const { Window } = await import("happy-dom");
  const window = new Window();
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", window.document);
  const { createRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");
  const { ErrorBoundary } = await import("../components/ErrorBoundary");
  const container = document.createElement("div");
  const root = createRoot(container, { onCaughtError: () => {} });
  const onError = vi.fn();
  const error = new Error("private text");
  function Broken(): never { throw error; }

  try {
    flushSync(() => root.render(createElement(ErrorBoundary, { onError, children: createElement(Broken) })));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("The page could not load. Reload the page to try again.");
    expect(onError).toHaveBeenCalledExactlyOnceWith(error, expect.objectContaining({ componentStack: expect.any(String) }));
  } finally {
    root.unmount();
    await window.happyDOM.close();
  }
});
