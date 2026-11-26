import { afterEach, expect, it, vi } from "vitest";
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

it.each([
  { path: "/", enabled: false, test: false },
  { path: "/", enabled: true, test: true },
  { path: "/join/invite", enabled: true, test: false },
])("loads monitoring on $path with enabled=$enabled and test=$test", async ({ path, enabled, test }) => {
  const render = vi.fn();
  vi.doMock("react-dom/client", () => ({ createRoot: () => ({ render }) }));
  const init = vi.fn();
  const captureMessage = vi.fn();
  const load = vi.fn(() => ({
    init, captureMessage, globalHandlersIntegration: () => ({ name: "GlobalHandlers" }),
    ErrorBoundary: () => null,
  }));
  vi.doMock("@sentry/react", load);
  vi.stubGlobal("document", { getElementById: () => ({}) });
  vi.stubGlobal("location", { pathname: path, search: "" });
  vi.stubGlobal("history", { replaceState: vi.fn() });
  const config = { dsn: "browser", environment: "preview", release: "build", test };
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => enabled ? { sentry: config } : {} })));
  await import("../main");
  await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
  expect(load).toHaveBeenCalledTimes(enabled ? 1 : 0);
  if (enabled) expect(init).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    dsn: "browser", environment: "preview", release: "build", sendDefaultPii: false,
    defaultIntegrations: false, integrations: [{ name: "GlobalHandlers" }], beforeSend: expect.any(Function),
  }));
  if (test) expect(captureMessage).toHaveBeenCalledExactlyOnceWith("work-graph sentry test", "info");
  else expect(captureMessage).not.toHaveBeenCalled();
});
