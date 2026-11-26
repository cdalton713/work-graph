import { expect } from "@playwright/test";
import { screens, test } from "./support/screens.ts";

for (const name of ["overview", "project", "issue", "board"] as const) {
  test(`${name} fits the window`, async ({ page }, testInfo) => {
    await screens[name](page);

    const viewport = page.viewportSize()!;
    const phone = testInfo.project.name.startsWith("phone-");
    const bottom = await page.locator("main.stage").evaluate((stage) => stage.getBoundingClientRect().bottom);
    expect(bottom, "stage bottom").toBeCloseTo(viewport.height, 0);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches))
      .toBe(!testInfo.project.name.startsWith("desktop-"));

    const scrollWidth = await page.evaluate(() => document.scrollingElement!.scrollWidth);
    test.fail(phone && name !== "overview", "bar: the project header overflows on phones");
    expect(scrollWidth, "page width").toBeLessThanOrEqual(viewport.width);
  });
}
