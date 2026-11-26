import { expect, type Locator, type Page } from "@playwright/test";
import type { ProjectList } from "../src/lib/types.ts";
import { screens, test } from "./support/screens.ts";

async function addProjects(page: Page) {
  await page.route(/\/api\/(projects|overview)$/, async (route) => {
    const response = await route.fetch();
    const list: ProjectList = await response.json();
    const extra = Array.from({ length: 9 }, (_, i) => ({
      ...list.projects[0], id: `extra-${i}`, name: `Extra project ${i}`, initiative: `Initiative ${i}`,
    }));
    await route.fulfill({ response, json: { ...list, projects: [...list.projects, ...extra] } });
  });
}

async function checkTouchFocus(page: Page, trigger: Locator, query: string) {
  await page.evaluate(() => document.addEventListener("focusin", (event) => {
    if (event.target instanceof HTMLInputElement && event.target.matches(".picker-filter")) {
      event.target.dataset.receivedFocus = "true";
    }
  }));
  await trigger.tap();
  const filter = page.getByRole("textbox", { name: "Filter" });
  await expect(filter).toBeVisible();
  if (await trigger.getAttribute("aria-haspopup") === "dialog") {
    const close = page.getByRole("dialog").getByRole("button", { name: "Close", exact: true });
    await expect(close).toBeFocused();
    await expect(close).toHaveJSProperty("autofocus", true);
  } else {
    await expect(page.locator(".picker-list")).toBeFocused();
  }
  await expect(filter).not.toHaveAttribute("data-received-focus", "true");
  await filter.tap();
  await expect(filter).toBeFocused();
  await page.keyboard.type(query);
  await expect(page.getByRole("option")).toHaveCount(1);
  await expect(page.getByRole("option")).toContainText(query);
}

test("touch pickers focus the filter only after a tap", async ({ page }, info) => {
  test.skip(!info.project.use.hasTouch);
  await addProjects(page);
  await screens.project(page);
  await checkTouchFocus(page, page.locator(".bar").getByRole("button", { name: /Example project/ }), "Planned project");
  await screens.overview(page);
  const filters = page.getByRole("button", { name: "Filters", exact: true });
  if (await filters.isVisible()) await filters.tap();
  await checkTouchFocus(page, page.getByTitle("Filter by initiative", { exact: true }), "Initiative 8");
  await screens.issue(page);
  await checkTouchFocus(page, page.locator(".panel").getByRole("button", { name: "Triage", exact: true }), "Backlog");
});

for (const width of [1280, 1440]) {
  test(`mouse picker focuses the filter and accepts arrow keys at ${width}px`, async ({ page }, info) => {
    test.skip(!!info.project.use.hasTouch);
    await page.setViewportSize({ width, height: 900 });
    await screens.issue(page);
    await page.locator(".panel").getByRole("button", { name: "Triage", exact: true }).click();
    const filter = page.getByRole("textbox", { name: "Filter" });
    await expect(filter).toBeFocused();
    await page.mouse.move(0, 0);
    await filter.press("Home");
    await expect(page.getByRole("option").first()).toHaveClass(/is-active/);
    await filter.press("ArrowDown");
    await expect(page.getByRole("option").nth(1)).toHaveClass(/is-active/);
  });
}
