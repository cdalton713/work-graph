import { expect } from "@playwright/test";
import { screens, test } from "./support/screens.ts";

test("the last status count scrolls into view beside the tally", async ({ page }, info) => {
  test.skip(info.project.name !== "tablet-1180x820");
  await screens.project(page);
  const filters = page.getByRole("group", { name: "Show only these statuses" });
  const last = filters.locator(".aspect b").last();
  const tally = page.locator(".rail-bar .tally");
  await expect(last).toBeVisible();
  for (const [width, height] of [[1024, 768], [1133, 744], [1180, 820]]) {
    await page.setViewportSize({ width, height });
    const before = await tally.boundingBox();
    await filters.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    const count = (await last.boundingBox())!;
    const viewport = (await filters.boundingBox())!;
    expect(count.x).toBeGreaterThanOrEqual(viewport.x);
    expect(count.x + count.width).toBeLessThanOrEqual(viewport.x + viewport.width);
    expect(viewport.x + viewport.width).toBeLessThanOrEqual(before!.x);
    expect(await tally.boundingBox()).toEqual(before);
  }
});
