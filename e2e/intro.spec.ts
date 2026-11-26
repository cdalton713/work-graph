import { expect } from "@playwright/test";
import { serviceUrl } from "./support/ports.ts";
import { screens, test } from "./support/screens.ts";

test("a new account sees Welcome and can read the explanation again in Settings", async ({ page }) => {
  // Other tests can create tokens for the same fixture account.
  await page.route("**/api/account", async (route) => {
    const response = await route.fetch();
    const account = await response.json();
    await route.fulfill({ response, json: { ...account, onboarding: {
      name: false, workspaces: true, teams: true, token: false, connected: false, skipped: false,
    } } });
  });
  await page.goto(serviceUrl() + "/auth/login?as=ada&next=/");
  await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
  const track = page.getByRole("list", { name: "How Work Graph works" });
  await expect(track.getByRole("listitem")).toHaveCount(4);
  const first = await track.getByRole("listitem").first().boundingBox();
  const last = await track.getByRole("listitem").last().boundingBox();
  if (page.viewportSize()!.width <= 430) {
    expect(last!.x).toBe(first!.x);
    expect(last!.y).toBeGreaterThan(first!.y);
    expect(last!.x + last!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  }
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your name" })).toBeFocused();
  await screens.settings(page);
  await expect(track).toBeHidden();
  await page.getByText("How Work Graph works", { exact: true }).click();
  await expect(track).toBeVisible();
});
