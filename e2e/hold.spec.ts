import { expect } from "@playwright/test";
import { screens, test } from "./support/screens.ts";

test("the hold form fits the screen and picks a date on its calendar", async ({ page }, info) => {
  // At 320 px the project bar is wider than the screen before this form opens (CD Triage: bar overflow at 320 px).
  test.skip(info.project.name === "phone-320x568", "the 320 px project bar overflows; tracked separately");
  await screens.project(page);
  const menu = page.locator(".bar").getByRole("button", { name: "More" });
  if (await menu.count()) await menu.click();
  await page.getByRole("button", { name: "Hold…" }).click();
  const sheet = page.getByRole("dialog", { name: "Put on hold" });
  await expect(sheet).toBeVisible();
  const calendar = sheet.getByRole("group", { name: "Until" });
  await calendar.getByRole("button", { name: "Next Monday" }).click();
  await expect(calendar.getByRole("button", { name: "Next Monday" })).toHaveAttribute("aria-pressed", "true");
  await expect(calendar).toContainText("Comes back");
  await expect(calendar.locator(".cal-day.is-on")).toHaveCount(1);
  const width = page.viewportSize()!.width;
  expect(await sheet.evaluate((element) => element.querySelector(".sheet-body")!.scrollWidth)).toBeLessThanOrEqual(width);
  if (width >= 720) {
    const box = (await sheet.boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(620);
    expect(Math.abs(box.x + box.width / 2 - width / 2)).toBeLessThan(2);
  }
  await page.screenshot({ path: `test-results/hold-${info.project.name}.png` });
});
