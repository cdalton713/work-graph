import { expect } from "@playwright/test";
import { test } from "./support/screens.ts";

test("project polls, new tabs and visibility wait for the 90-second retry window", async ({ page, context }) => {
  const start = new Date("2026-01-01T00:00:00Z");
  let graphs = 0, overviews = 0, directories = 0;
  await context.route("**/api/projects", route => { directories++; return route.fallback(); });
  await context.route("**/api/overview", route => { overviews++; return route.fallback(); });
  await context.route("**/api/projects/*/graph*", route => {
    if (++graphs > 1) return route.fallback();
    return route.fulfill({ status: 429, headers: { "Retry-After": "90" }, json: { error: "Linear rate limit" } });
  });
  await page.clock.install({ time: start });
  await page.clock.pauseAt(new Date(+start + 1000));
  await page.goto("/?project=fixture");
  await expect(page.getByText("Linear rate limit", { exact: true }).first()).toBeVisible();
  expect(directories).toBe(1);
  expect(overviews).toBe(0);
  const second = await context.newPage();
  await second.goto("/?project=fixture");
  await expect(second.getByText("Linear rate limit", { exact: true }).first()).toBeVisible();
  await page.clock.fastForward(89_000);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(graphs).toBe(1);
  expect(overviews).toBe(0);
  await page.clock.fastForward(1000);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => graphs).toBe(2);
  const beforeHome = directories;
  await page.goto("/");
  await expect.poll(() => overviews).toBe(1);
  expect(directories).toBe(beforeHome);
});

test("a viewer hides a graph when its refresh fails and recovers on a fresh read", async ({ page }) => {
  await page.route("**/api/config", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), readOnly: true } });
  });
  await page.goto("/?project=fixture");
  const board = page.getByRole("navigation", { name: "Issues by the action they need" });
  await expect(board).toBeVisible();
  await page.route("**/api/projects/fixture/graph*", route => route.fulfill({
    status: 503, json: { error: "Cannot confirm this share" },
  }), { times: 1 });
  await page.getByRole("button", { name: "Refresh project" }).click();
  await expect(page.getByText("Cannot confirm this share").first()).toBeVisible();
  await expect(board).toBeHidden();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(board).toBeVisible();
});

test("an anonymous viewer hold applies only to the selected share", async ({ page }) => {
  await page.route("**/api/config", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), readOnly: true, user: null } });
  });
  await page.route("**/api/projects/fixture/graph*", route => route.fulfill({
    status: 429, headers: { "Retry-After": "90" }, json: { error: "Limited share" },
  }));
  await page.goto("/?project=fixture");
  await expect(page.getByText("Limited share", { exact: true }).first()).toBeVisible();
  await Promise.all([page.waitForResponse(r => r.url().includes("/api/projects/planned/graph") && r.ok()),
    page.goto("/?project=planned")]);
  await expect(page.locator(".bar-project")).toContainText("Planned project");
});
