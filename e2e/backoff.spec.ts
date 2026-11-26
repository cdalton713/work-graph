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
