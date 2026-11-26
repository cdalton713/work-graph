import { expect } from "@playwright/test";
import type { OverviewData } from "../src/lib/overview.ts";
import { projectPath, screens, test } from "./support/screens.ts";

test("the phone header gives at least half its width to the project picker", async ({ page }, info) => {
  test.skip(!info.project.name.startsWith("phone-"));
  await page.route("**/api/overview?view=waiting", async (route) => {
    const response = await route.fetch();
    const overview: OverviewData = await response.json();
    const waiting = Array.from({ length: 25 }, (_, index) => ({
      identifier: `WG-${index + 1}`, title: "Example issue", why: "Review", pullRequests: [],
      updatedAt: "2026-01-01T00:00:00Z",
    }));
    await route.fulfill({ response, json: {
      ...overview,
      summaries: overview.summaries.map((summary) => ({ ...summary, you: summary.id === "fixture" ? waiting : [] })),
    } });
  });
  await screens.project(page);
  const bar = page.locator(".project-bar");
  const overview = bar.getByRole("button", { name: /^Overview/ });
  const picker = bar.getByRole("button", { name: /Example project/ });
  const sync = bar.getByRole("button", { name: "Refresh project" });
  const more = bar.getByRole("button", { name: "More", exact: true });
  await expect(overview.locator(".bar-home-count")).toHaveText("25");
  expect(await overview.locator(".bar-home-label").evaluate((label) => label.getBoundingClientRect().width)).toBeLessThanOrEqual(1);
  const barBox = (await bar.boundingBox())!;
  expect((await picker.boundingBox())!.width).toBeGreaterThanOrEqual(barBox.width / 2);
  expect((await overview.boundingBox())!.width).toBeLessThanOrEqual(64);
  expect((await sync.boundingBox())!.width).toBe(44);
  await expect(overview.locator(".bar-home-arrow")).toBeVisible();
  for (const control of [overview, picker, sync, more]) {
    const box = (await control.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBe(44);
    expect(await control.evaluate((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(x + width / 2, y + height / 2));
    })).toBe(true);
  }
  await more.tap();
  const menu = page.getByRole("dialog", { name: "Project controls" });
  await expect(menu.getByText(/Last sync/)).toBeVisible();
  await menu.getByRole("button", { name: "Overview", exact: true }).tap();
  await expect(page.locator(".overview")).toBeVisible();
});

test("the phone issue header contains the graph action and leaves room for the title", async ({ page }, info) => {
  test.skip(!info.project.name.startsWith("phone-"));
  await page.goto(projectPath);
  await page.locator(".board").getByRole("button", { name: /WG-1\b/ }).tap();
  const panel = page.locator(".panel");
  const action = panel.locator("header").first().getByRole("button", { name: "Show in graph" });
  await expect(action).toBeVisible();
  const actionBox = (await action.boundingBox())!;
  expect(actionBox.height).toBe(44);
  expect(actionBox.width).toBeGreaterThanOrEqual(44);
  const title = (await panel.getByRole("textbox", { name: "Issue title" }).boundingBox())!;
  expect(title.y - (await panel.boundingBox())!.y).toBeLessThanOrEqual(110);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(page.viewportSize()!.width);
  await action.tap();
  await expect(panel).toBeHidden();
  await expect(page.locator(".react-flow .station.is-selected").getByText("WG-1", { exact: true })).toBeVisible();
});

test("the desktop keeps the full Overview label and sync time", async ({ page }, info) => {
  test.skip(!info.project.name.startsWith("desktop-"));
  await screens.issue(page);
  const bar = page.locator(".project-bar");
  for (const width of [1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const overview = bar.getByRole("button", { name: /^Overview/ });
    await expect(overview.locator(".bar-home-label")).toBeVisible();
    await expect(overview.locator(".bar-home-arrow")).toBeHidden();
    await expect(bar.getByRole("button", { name: "Refresh project" }).locator(".sync-time")).toBeVisible();
    await expect(bar.getByRole("button", { name: "More", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Show in graph" })).toHaveCount(0);
    expect((await page.locator(".rail-bar").boundingBox())!.height).toBe(34);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  }
});
