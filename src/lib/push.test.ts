import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

function worker(windows: object[]) {
  const listeners = new Map();
  const showNotification = vi.fn();
  const openWindow = vi.fn();
  runInNewContext(readFileSync("public/sw.js", "utf8"), {
    URL, self: {
      location: { origin: "https://example.com" },
      registration: { showNotification },
      clients: { matchAll: async () => windows, openWindow },
      addEventListener: (name: string, callback: Function) => listeners.set(name, callback),
    },
  });
  const click = (url: string) => new Promise(resolve => listeners.get("notificationclick")({
    notification: { data: { url }, close: vi.fn() }, waitUntil: resolve,
  }));
  return { listeners, showNotification, openWindow, click };
}

describe("notice worker", () => {
  const url = "https://example.com/?workspace=view&project=fixture&issue=WG-1";
  it("only handles delivery and taps, and displays generic text", async () => {
    const w = worker([]);
    expect([...w.listeners.keys()].sort()).toEqual(["notificationclick", "push"]);
    await new Promise(resolve => w.listeners.get("push")({
      data: { json: () => ({ title: "private", body: "Example project", url }) }, waitUntil: resolve,
    }));
    expect(w.showNotification).toHaveBeenCalledWith("A move needs your attention", {
      body: "Example project", data: { url },
    });
  });
  it.each([undefined, { json: () => JSON.parse("plain text") }])("shows a generic notice without JSON", async data => {
    const w = worker([]);
    await new Promise(resolve => w.listeners.get("push")({ data, waitUntil: resolve }));
    expect(w.showNotification).toHaveBeenCalledWith("A move needs your attention", {
      body: "", data: { url: "https://example.com/" },
    });
  });
  it("navigates an existing app window and focuses it", async () => {
    const focus = vi.fn();
    const navigate = vi.fn().mockResolvedValue({ focus });
    await worker([{ url: "https://example.com/", navigate }]).click(url);
    expect(navigate).toHaveBeenCalledWith(url);
    expect(focus).toHaveBeenCalledOnce();
  });
  it("opens the issue when there is no window and rejects external destinations", async () => {
    const w = worker([]);
    await w.click(url);
    expect(w.openWindow).toHaveBeenCalledWith(url);
    await w.click("https://elsewhere.example.com/");
    expect(w.openWindow).toHaveBeenLastCalledWith("https://example.com/");
  });
});

it("sets a badge for outstanding moves and clears it at zero", async () => {
  const { updateBadge } = await import("./push");
  const setAppBadge = vi.fn(), clearAppBadge = vi.fn();
  vi.stubGlobal("navigator", { setAppBadge, clearAppBadge });
  try {
    updateBadge(3);
    expect(setAppBadge).toHaveBeenCalledWith(3);
    updateBadge(0);
    expect(clearAppBadge).toHaveBeenCalledOnce();
  } finally { vi.unstubAllGlobals(); }
});

it("serves the worker script without caching", async () => {
  const { createApp } = await import("../../server/app");
  const { resolve, sep } = await import("node:path");
  const app = createApp({ port: 4747, tailnet: null, hosted: null }, {
    dist: resolve("public") + sep, watchMs: 0, team: "WG",
  });
  const response = await app.request("/sw.js");
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.text()).toContain('addEventListener("push"');
});
