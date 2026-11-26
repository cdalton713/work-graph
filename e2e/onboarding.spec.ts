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
  await expect(page.getByLabel("Key for Setup workspace", { exact: true })).toHaveValue("WG");
  await page.getByRole("button", { name: "Create private sub-team" }).click();
  const confirmation = page.getByRole("status").filter({ hasText: "Created Work Graph – Alex (WG), private, under DEMO. It is now the team for Setup workspace." });
  await expect(confirmation).toBeFocused();
  await expect(page.getByRole("button", { name: "Create private sub-team" })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Team for Setup workspace", exact: true })).toHaveValue("WG");
  await next.click();
  await expect(page.getByRole("list", { name: "Status flow" }).getByText("Needs Alex")).toBeVisible();
  await page.getByRole("button", { name: /Add \d+ missing/ }).click();
  await expect(page.getByRole("button", { name: "Done Statuses and labels" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: /Added [1-9]\d* items/ })).toBeFocused();
  await expect(page.getByRole("button", { name: "Nothing to add" })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await next.click();
  await expect(page.locator(".account-step h3")).toHaveText([
    "1. Add these settings to ~/.config/work-graph/config.json", "2. Set up your Linear key",
    "3. Coordinator token", "4. Then run these commands",
  ]);
  await page.getByRole("button", { name: "Copy wg config" }).click();
  const config = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(config.workspaces[0].team).toBe("WG");
  await page.getByRole("button", { name: "Copy all", exact: true }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied.split("\n")).toEqual([
    expect.stringMatching(/^wg setup .* --apply$/), "wg login " + origin + " && wg doctor",
  ]);
  await expect(page.getByText("Paste the coordinator token when wg login asks for it.")).toBeVisible();
  await page.getByRole("button", { name: "Make a token" }).click();
  const token = await page.getByLabel("Coordinator token", { exact: true }).inputValue();
  expect((await page.request.get(origin + "/api/status", { headers: { authorization: "Bearer " + token, cookie: "" } })).ok()).toBe(true);
  await next.click();
  await expect(page.getByRole("button", { name: "Go to overview" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Setup steps" }).getByLabel("Done")).toHaveCount(7);
});

test("a refused private sub-team shows the setup command", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: serviceUrl() });
  await page.goto(serviceUrl() + "/auth/login?setup-user=refused");
  await page.getByRole("button", { name: /^(Done|Pending) Team$/ }).click();
  await page.getByRole("button", { name: "Create private sub-team" }).click();
  await expect(page.getByRole("alert")).toContainText(/wg setup .*--team WG .*--private --parent DEMO --apply/);
  const fallback = await page.getByRole("alert").locator("pre").innerText();
  await page.getByRole("button", { name: "Copy fallback command" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(fallback);
});

test("a team that Linear could not make private can be selected", async ({ page }) => {
  await page.goto(serviceUrl() + "/auth/login?setup-user=refused-private");
  await page.getByRole("button", { name: /^(Done|Pending) Team$/ }).click();
  await page.getByRole("button", { name: "Create private sub-team" }).click();
  await expect(page.getByRole("alert")).toContainText("Linear created Work Graph – Alex (WG)");
  await expect(page.getByRole("button", { name: "Copy fallback command" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Team for Setup workspace", exact: true })).toHaveValue("DEMO");
  await page.getByRole("button", { name: "Use this team" }).click();
  await expect(page.getByRole("combobox", { name: "Team for Setup workspace", exact: true })).toHaveValue("WG");
  await expect(page.getByRole("status").filter({ hasText: "public, under DEMO" })).toBeFocused();
  await page.getByRole("button", { name: "Check again" }).click();
  await page.getByRole("button", { name: /Pending Statuses and labels/ }).click();
  await expect(page.getByRole("list", { name: "Status flow" })).toBeVisible();
});
