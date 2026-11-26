import { expect, test as playwright, type Page } from "@playwright/test";
import { pageUrl, serviceUrl } from "./ports.ts";

export const test = playwright.extend({
  baseURL: async ({}, use) => use(pageUrl()),
  context: async ({ context }, use) => {
    const fixtureOrigins = [pageUrl(), serviceUrl()];
    await context.route("**/*", (route) => {
      const origin = new URL(route.request().url()).origin;
      return fixtureOrigins.includes(origin) ? route.continue() : route.abort();
    });
    await use(context);
  },
});

export const projectPath = "/?project=fixture";
export const issuePath = `${projectPath}&issue=WG-1`;
const board = (page: Page) => page.getByRole("navigation", { name: "Issues by the action they need" });

export const screens = {
  async overview(page: Page) {
    await page.goto("/");
    await expect(page.locator(".overview .ov-title").getByText("Example project", { exact: true })).toBeVisible();
  },
  async project(page: Page) {
    await page.addInitScript(() => localStorage.setItem("wg-board", "off"));
    await page.goto(projectPath);
    await expect(page.locator(".react-flow")).toBeVisible();
  },
  async issue(page: Page) {
    await page.addInitScript(() => localStorage.setItem("wg-board", "off"));
    await page.goto(issuePath);
    await expect(page.locator(".panel").getByText("Example issue 1", { exact: true })).toBeVisible();
  },
  async board(page: Page) {
    await screens.project(page);
    const toggle = page.getByRole("button", { name: "Board", exact: true });
    if (!(await toggle.isVisible())) {
      await page.locator(".bar").getByRole("button", { name: "More", exact: true }).click();
    }
    await toggle.click();
    await expect(board(page)).toBeVisible();
  },
  async settings(page: Page) {
    await page.goto(`${serviceUrl()}/auth/login?as=ada&next=/?page=settings`);
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  },
  async setup(page: Page) {
    await page.goto(`${serviceUrl()}/auth/login?as=ada&next=/?page=setup`);
    await expect(page.getByRole("heading", { name: "Setup guide", exact: true })).toBeVisible();
  },
};
