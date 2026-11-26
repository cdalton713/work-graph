import { expect, type Page } from "@playwright/test";
import { screens, test } from "./support/screens.ts";
import { noticeKinds, type NoticeSettings } from "../src/lib/types.ts";

async function allowPush(page: Page) {
  await page.route("**/api/config", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), push: true } });
  });
  let settings: NoticeSettings = { enabled: true, kinds: [...noticeKinds] };
  await page.route("**/api/push/settings", async route => {
    if (route.request().method() === "PUT") settings = route.request().postDataJSON();
    await route.fulfill({ json: settings });
  });
}

test("settings and More control this device independently of account preferences", async ({ page }) => {
  await allowPush(page);
  let subscribed = false;
  let tests = 0;
  const id = await import("node:crypto").then(({ createHash }) => createHash("sha256").update("https://example.com/device").digest("hex"));
  await page.route("**/api/push/key", route => route.fulfill({ json: { publicKey: "AAAA" } }));
  await page.route("**/api/push/devices", route => {
    if (route.request().method() === "POST") subscribed = true;
    return route.fulfill({ json: { devices: subscribed ? [{ id }] : [] } });
  });
  await page.route("**/api/push/devices/" + id, route => {
    expect(route.request().method()).toBe("DELETE");
    subscribed = false;
    return route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/push/devices/" + id + "/test", route => {
    tests++;
    return route.fulfill({ json: { ok: true } });
  });
  await page.addInitScript(() => {
    Object.defineProperty(window, "PushManager", { value: class {} });
    Object.defineProperty(window, "Notification", { value: {
      permission: sessionStorage.permission || "granted", requestPermission: async () => {
        if (!navigator.userActivation.isActive) throw new Error("Permission needs a tap.");
        return "granted";
      },
    } });
    const sub = { endpoint: "https://example.com/device", toJSON: () => ({ endpoint: "https://example.com/device" }),
      unsubscribe: async () => { sessionStorage.removeItem("subscription"); return true; } };
    const reg = { pushManager: {
      getSubscription: async () => sessionStorage.subscription ? sub : null,
      subscribe: async () => { sessionStorage.subscription = "on"; return sub; },
    } };
    Object.defineProperty(navigator, "serviceWorker", { value: {
      register: async () => reg, ready: Promise.resolve(reg), getRegistration: async () => reg,
    } });
  });
  await screens.settings(page);
  const device = page.getByRole("switch", { name: "Notices on this device" });
  await device.click();
  await expect(device).toBeChecked();
  expect(subscribed).toBe(true);
  await page.getByRole("button", { name: "Send a test notice" }).click();
  await expect.poll(() => tests).toBe(1);
  const account = page.getByRole("switch", { name: "Allow notices on all devices" });
  for (const name of ["Decisions and ops steps", "Merge requests", "Worker questions", "Other waits"]) {
    const kind = page.getByRole("checkbox", { name });
    await kind.click();
    await expect(kind).not.toBeChecked();
  }
  await account.click();
  await expect(account).not.toBeChecked();
  await page.reload();
  await expect(device).toBeChecked();
  await expect(account).not.toBeChecked();
  await account.click();
  await expect(account).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Other waits" })).not.toBeChecked();
  const more = page.getByRole("button", { name: "More", exact: true });
  if (await more.isVisible()) {
    await more.click();
    await expect(page.getByRole("dialog").getByRole("switch")).toBeChecked();
    await page.getByRole("dialog").getByRole("switch").click();
  } else {
    await device.click();
  }
  await expect.poll(() => subscribed).toBe(false);
  await page.reload();
  await device.click();
  await expect(device).toBeChecked();
  await page.evaluate(() => sessionStorage.removeItem("subscription"));
  await page.reload();
  await expect(device).toBeEnabled();
  await expect(device).not.toBeChecked();
  expect(subscribed).toBe(false);
  await device.click();
  await expect(device).toBeChecked();
  await page.evaluate(() => { sessionStorage.permission = "denied"; });
  await page.reload();
  await expect(page.getByText(/Allow notices in system settings/)).toBeVisible();
  expect(subscribed).toBe(false);
});

test("disabled installations omit notice controls", async ({ page }) => {
  await screens.settings(page);
  await expect(page.getByRole("switch", { name: "Notices on this device" })).toHaveCount(0);
});

for (const state of ["install", "unsupported", "denied"] as const) {
  test("explains the device state: " + state, async ({ page }) => {
    await allowPush(page);
    await page.addInitScript(state => {
      if (state === "install") Object.defineProperty(navigator, "userAgent", { value: "iPhone Safari" });
      if (state === "unsupported") Reflect.deleteProperty(window, "PushManager");
      if (state === "denied") Object.defineProperty(window, "Notification", { value: { permission: "denied" } });
    }, state);
    await screens.settings(page);
    const text = { install: /tap Share, then Add to Home Screen/, denied: /Allow notices in system settings/, unsupported: /Not possible in this browser/ };
    await expect(page.getByText(text[state])).toBeVisible();
    await expect(page.getByRole("switch", { name: "Notices on this device" })).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("notice controls fit the viewport and touch labels have room for a tap", async ({ page }, info) => {
  await allowPush(page);
  await screens.settings(page);
  const current = page.viewportSize()!;
  const widths = info.project.name.startsWith("tablet-820") ? [768, 820, 1024] :
    info.project.name.startsWith("desktop") ? [1280, 1440] : [current.width];
  for (const width of widths) {
    await page.setViewportSize({ width, height: current.height });
    const section = page.getByRole("region", { name: "Notice settings" });
    await expect(section.getByRole("checkbox", { name: "Worker questions" })).toBeVisible();
    expect(await section.evaluate(el => {
      const bounds = el.getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth;
    })).toBe(true);
    if (await page.evaluate(() => matchMedia("(pointer: coarse)").matches)) {
      expect(await section.locator("label,button").evaluateAll(items => items.every(el => {
        const box = el.getBoundingClientRect();
        return box.width >= 44 && box.height >= 44;
      }))).toBe(true);
    }
  }
});

test("the app updates the icon when there are moves", async ({ page }) => {
  await allowPush(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "setAppBadge", { value: async (count: number) => {
      document.documentElement.dataset.testBadge = String(count);
    } });
  });
  await screens.overview(page);
  await expect.poll(() => page.evaluate(() => Number(document.documentElement.dataset.testBadge))).toBeGreaterThan(0);
});

test("a board refresh updates the header, picker and installed badge", async ({ page }) => {
  await allowPush(page);
  await page.addInitScript(() => Object.defineProperty(navigator, "setAppBadge", {
    value: (count: number) => { document.documentElement.dataset.testBadge = String(count); },
  }));
  let count = 2, reads = 0;
  await page.route("**/api/overview?view=waiting", async route => {
    reads++;
    await route.fulfill({ json: { summaries: [{ workspace: "default", id: "fixture",
      you: Array.from({ length: count }, (_, i) => ({ identifier: `WG-${i}` })) }], workspaces: [], projects: [] } });
  });
  await screens.project(page);
  const check = async () => {
    await expect(page.locator(".bar-home-count")).toHaveText(String(count));
    await expect(page.locator("html")).toHaveAttribute("data-test-badge", String(count));
    await page.locator(".bar-project").click();
    const option = page.getByRole("option", { name: /Example project/ });
    await expect(option).toContainText(`${count} for`);
    await option.click();
  };
  await check();
  count = 3;
  await page.getByRole("button", { name: "Refresh project" }).click();
  await check();
  count = 4;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await check();
  expect(reads).toBe(3);
  await page.locator(".bar-home").click();
  count = 5;
  await page.locator(".ov-open").filter({ hasText: "Example project" }).first().click();
  await check();
});

test("desktop notices preserve project picker widths", async ({ page }, info) => {
  test.skip(!info.project.name.startsWith("desktop"));
  const bar = page.locator(".project-bar");
  const widths = async () => {
    await expect(bar.getByRole("button", { name: /^Review/ })).toBeVisible();
    await expect(bar.locator(".sync-time")).toHaveText(/\d+:\d+/);
    await page.evaluate(() => document.fonts.ready);
    const pickers = bar.locator(".picker-trigger");
    await expect(pickers).toHaveCount(4);
    return pickers.evaluateAll(controls => controls.map(el => el.getBoundingClientRect().width));
  };
  for (const width of [1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await screens.project(page);
    const before = await widths();
    await allowPush(page);
    await page.reload();
    const button = bar.getByRole("button", { name: "Notices", exact: true });
    await expect(button).toBeVisible();
    await expect(bar.getByTitle("Notices")).toBeVisible();
    expect(await widths()).toEqual(before);
    await button.click();
    await expect(page.getByRole("dialog", { name: "Notice settings" }).getByRole("group", { name: "Account notices" })).toBeVisible();
    await page.unroute("**/api/config");
  }
});

test("phone notices follow the existing project controls", async ({ page }, info) => {
  test.skip(!info.project.name.startsWith("phone-390"));
  const sheet = page.getByRole("dialog", { name: "Project controls" });
  async function positions() {
    await screens.project(page);
    await page.locator(".bar").getByRole("button", { name: "More" }).click();
    await expect(sheet.getByRole("button", { name: /^Review/ })).toBeVisible();
    await sheet.evaluate(async el => { await Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished)); });
    return Promise.all([/Copy the project link/, /^Autonomy/, /^Review/, /Close project/].map(name =>
      sheet.getByRole("button", { name }).evaluate(el => el.getBoundingClientRect().top)));
  }
  const before = await positions();
  await allowPush(page);
  expect(await positions()).toEqual(before);
  await expect(sheet.getByRole("switch", { name: "Notices on this device" })).toBeVisible();
  await expect(sheet.getByRole("group", { name: "Account notices" })).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: "Send a test notice" })).toHaveCount(0);
  await sheet.getByRole("button", { name: "Notice settings" }).click();
  const settings = page.getByRole("dialog", { name: "Notice settings" });
  await expect(settings.getByRole("group", { name: "Account notices" })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Send a test notice" })).toBeVisible();
});
