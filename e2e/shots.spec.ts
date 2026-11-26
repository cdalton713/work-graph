import { join } from "node:path";
import { screens, test } from "./support/screens.ts";

for (const [name, open] of Object.entries(screens)) {
  test(`capture ${name} @shots`, async ({ page }, testInfo) => {
    await open(page);
    await page.screenshot({ path: join("shots", testInfo.project.name, `${name}.png`), animations: "disabled" });
  });
}
