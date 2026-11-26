import { expect } from "@playwright/test";
import { serviceUrl } from "./support/ports.ts";
import { test } from "./support/screens.ts";

test("a new account completes the verified setup steps", async ({ page, context }) => {
  const origin = serviceUrl();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await page.goto(origin + "/auth/login?setup-user=new");
  const next = page.getByRole("button", { name: "Continue", exact: true });
  await next.click();
  await page.getByRole("button", { name: "Save name" }).click();
  await next.click();
  await expect(page.getByLabel("Parent team")).toHaveValue("DEMO");
  await expect(page.getByLabel("Key", { exact: true })).toHaveValue("WG");
  await page.getByRole("button", { name: "Create private sub-team" }).click();
  await expect(page.getByLabel("Team for Setup workspace")).toHaveValue("WG");
  await next.click();
  await expect(page.getByRole("list", { name: "Status flow" }).getByText("Needs Alex")).toBeVisible();
  await page.getByRole("button", { name: /Add \d+ missing/ }).click();
  await expect(page.getByRole("button", { name: "Done Statuses and labels" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await next.click();
  await page.getByRole("button", { name: "Copy all", exact: true }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("wg doctor");
  expect(copied).toContain('"team": "WG"');
  await page.getByRole("button", { name: "Make a token" }).click();
  const token = await page.getByLabel("Coordinator token", { exact: true }).inputValue();
  expect((await page.request.get(origin + "/api/status", { headers: { authorization: "Bearer " + token, cookie: "" } })).ok()).toBe(true);
  await next.click();
  await expect(page.getByRole("button", { name: "Go to overview" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Setup steps" }).getByLabel("Done")).toHaveCount(7);
});

test("a refused private sub-team shows the setup command", async ({ page }) => {
  await page.goto(serviceUrl() + "/auth/login?setup-user=refused");
  await page.getByRole("button", { name: /^(Done|Pending) Team$/ }).click();
  await page.getByRole("button", { name: "Create private sub-team" }).click();
  await expect(page.getByRole("alert")).toContainText(/wg setup .*--team WG .*--private --parent DEMO --apply/);
});
