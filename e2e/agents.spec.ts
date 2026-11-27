import { expect } from "@playwright/test";
import { screens, test } from "./support/screens.ts";

test("the agents form of a project fits the screen and sends the agents", async ({ page }, info) => {
  // At 320 px the project bar is wider than the screen before this form opens (CD Triage: bar overflow at 320 px).
  test.skip(info.project.name === "phone-320x568", "the 320 px project bar overflows; tracked separately");
  await screens.project(page);
  const menu = page.locator(".bar").getByRole("button", { name: "More" });
  if (await menu.count()) await menu.click();
  await page.getByRole("button", { name: "Agents…" }).click();
  const sheet = page.getByRole("dialog", { name: "Agents of this project" });
  await expect(sheet).toBeVisible();
  await sheet.getByLabel("Worker agent").selectOption("claude");
  await sheet.getByLabel("Worker model").selectOption("claude-sonnet-5-5");
  await sheet.getByLabel("Worker effort").selectOption("max");
  const sent = page.waitForRequest((request) => request.url().endsWith("/agents") && request.method() === "POST");
  await sheet.getByRole("button", { name: "Send to the coordinator" }).click();
  expect((await sent).postDataJSON()).toEqual({ agents: { worker: { agent: "claude", model: "claude-sonnet-5-5", effort: "max" } } });
  await expect(sheet).toBeHidden();
  const width = page.viewportSize()!.width;
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
});
