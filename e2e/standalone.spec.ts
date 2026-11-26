import { expect, type Locator, type Page } from "@playwright/test";
import { serviceUrl } from "./support/ports.ts";
import { issuePath, projectPath, screens, test } from "./support/screens.ts";

async function pullDown(target: Locator, dy: number, dx = 0) {
  await target.evaluate((element, { dx, dy }) => {
    const touch = (x: number, y: number) => new Touch({ identifier: 1, target: element, clientX: x, clientY: y });
    const start = touch(10, 10);
    const finish = touch(10 + dx, 10 + dy);
    element.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [start], changedTouches: [start] }));
    element.dispatchEvent(new TouchEvent("touchmove", { bubbles: true, touches: [finish], changedTouches: [finish] }));
    element.dispatchEvent(new TouchEvent("touchend", { bubbles: true, changedTouches: [finish] }));
  }, { dx, dy });
}

async function checkWidth(page: Page, ...selectors: string[]) {
  const viewport = page.viewportSize()!;
  const additionalWidth = new Map([[820, 768], [1180, 1024]]).get(viewport.width);
  for (const width of [viewport.width, additionalWidth]) {
    if (width === undefined) continue;
    if (width !== viewport.width) await page.setViewportSize({ ...viewport, width });
    const overflow = await page.evaluate((selectors) => [
      document.documentElement.scrollWidth - window.innerWidth,
      ...selectors.map((selector) => {
        const element = document.querySelector(selector)!;
        return element.scrollWidth - element.clientWidth;
      }),
    ], selectors);
    for (const pixels of overflow) expect(pixels).toBeLessThanOrEqual(0);
    if (await page.evaluate(() => matchMedia("(pointer: coarse)").matches)) {
      for (const control of await page.locator(".installed-refresh:visible").all()) {
        const box = (await control.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
    }
  }
  if (additionalWidth) await page.setViewportSize(viewport);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "standalone", { value: true });
  });
});

test("the overview refresh button and project list pull refresh keep navigation in the app", async ({ page }) => {
  await screens.overview(page);
  const overview = page.getByRole("heading", { name: "Overview" });
  const sync = page.locator(".installed-sync-age");
  await expect(sync).toHaveText("Synced just now");
  await checkWidth(page, ".app", ".project-bar", ".stage");

  const overviewRequest = () => page.waitForRequest((request) => new URL(request.url()).pathname === "/api/overview");
  const search = page.locator(".ov-find input");
  await search.fill("Example");
  await Promise.all([overviewRequest(), page.getByRole("button", { name: "Refresh overview" }).click()]);
  await expect(search).toHaveValue("Example");

  await page.goto(projectPath);
  const board = page.locator(".board-scroll");
  await expect(board).toBeVisible();
  await expect(sync).toHaveText("Synced just now");
  await checkWidth(page, ".app", ".project-bar", ".stage");
  const graphRequest = () => page.waitForRequest((request) => new URL(request.url()).pathname === "/api/projects/fixture/graph");
  await Promise.all([graphRequest(), pullDown(board, 90)]);

  await page.getByRole("button", { name: /^Overview/ }).click();
  await expect(overview).toBeVisible();
});

test("foregrounding the app requests fresh data and shows the prior sync age", async ({ page }) => {
  const start = new Date("2026-01-01T12:00:00Z");
  await page.clock.setFixedTime(start);
  await screens.overview(page);
  const sync = page.locator(".installed-sync-age");
  await expect(sync).toHaveText("Synced just now");

  let release = () => {};
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/overview", async (route) => { await pending; await route.continue(); });
  try {
    const request = page.waitForRequest("**/api/overview");
    await page.clock.setFixedTime(new Date(start.getTime() + 5 * 60_000));
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await request;
    await expect(sync).toHaveText("Synced 5 min ago");
  } finally {
    release();
  }
  await expect(sync).toHaveText("Synced just now");
});

test("opening an outside link keeps the issue open in the app", async ({ page, context }) => {
  await context.route("https://example.com/issue/1", (route) => route.fulfill({ body: "External issue" }));
  await page.goto(issuePath);
  const panel = page.locator(".panel");
  const external = panel.getByRole("link", { name: "Open WG-1 in Linear" });
  await expect(external).toBeVisible();
  await checkWidth(page, ".app", ".panel");
  const [outside] = await Promise.all([page.waitForEvent("popup"), external.click()]);
  await expect(outside.getByText("External issue")).toBeVisible();
  await outside.close();
  await expect(page).toHaveURL(new RegExp("issue=WG-1"));
  await expect(panel).toBeVisible();
  const comments = page.waitForRequest("**/api/issues/issue-1/comments");
  await panel.getByRole("button", { name: "Refresh issue" }).click();
  await comments;
  await panel.getByRole("button", { name: "Close panel" }).click();
  await expect(panel).toHaveCount(0);
});

test("sign-in returns to the requested account screen in the same page", async ({ page, context }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15" });
  });
  await page.goto(serviceUrl() + "/?page=settings");
  await expect(page.getByText(/Add to Home Screen from the signed-in page/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeVisible();
  await checkWidth(page, ".app", ".stage");

  await page.route("**/auth/login?**", (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("next")).toBe("/?page=settings");
    url.searchParams.set("as", "ada");
    return route.continue({ url: url.href });
  });
  await page.getByRole("link", { name: /Sign in with/ }).click();
  const settings = page.getByRole("heading", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();
  expect(context.pages()).toEqual([page]);
  await checkWidth(page, ".app", ".account-bar", ".account-page");

  await Promise.all([
    page.waitForRequest("**/api/account"),
    page.getByRole("button", { name: "Refresh account" }).click(),
  ]);
  await page.getByRole("button", { name: "Open setup guide", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Setup guide", exact: true })).toBeVisible();
  await checkWidth(page, ".app", ".account-bar", ".account-page");
  await page.locator(".account-bar").getByRole("button", { name: "Settings", exact: true }).click();
  await expect(settings).toBeVisible();
  await page.locator(".account-bar").getByRole("button", { name: "Overview", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
});
