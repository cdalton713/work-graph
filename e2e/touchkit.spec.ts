import { expect } from "@playwright/test";
import { build } from "vite";
import { screens, test } from "./support/screens.ts";

const buildHint = /^The build of the server: /;

test("the build version uses the native title with a mouse", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("desktop-"));
  await screens.project(page);
  await expect(page.locator(".bar-version")).toHaveAttribute("title", buildHint);
});

test.describe("sheet", () => {
  test.skip(({ isMobile }) => !isMobile, "Check the touch controls on phone projects");

  let fixtureScript: string;
  let fixtureStyle: string;

  test.beforeAll(async () => {
    const entry = "virtual:touchkit-fixture";
    const bundle = await build({
      logLevel: "error",
      plugins: [{
        name: "touchkit-fixture",
        resolveId(id) { if (id === entry) return "\0" + id; },
        load(id) {
          if (id !== "\0" + entry) return;
          return `
            import { createElement as h, useState } from "react";
            import { createRoot } from "react-dom/client";
            import { Hint, Sheet } from "/src/components/ui.tsx";
            import "/src/styles.css";

            function Fixture() {
              const [size, setSize] = useState(null);
              return h("main", null,
                h("button", { onClick: () => setSize("short") }, "Open sheet"),
                h("button", { onClick: () => setSize("tall") }, "Open tall sheet"),
                h(Sheet, { open: size !== null, title: "Example sheet", onClose: () => setSize(null) },
                  h("div", { style: size === "tall" ? { minHeight: "200vh" } : undefined },
                    h("button", null, "Last action"))),
                h(Hint, { text: "This is the example hint." }, "Example hint"),
                h("p", { style: { marginTop: 80 } }, "Outside the hint"));
            }
            createRoot(document.getElementById("root")).render(h(Fixture));
          `;
        },
      }],
      build: { write: false, cssCodeSplit: false, rolldownOptions: { input: entry } },
    });
    if (!("output" in bundle)) throw new Error("Expected one fixture bundle");
    for (const file of bundle.output) {
      if (file.type === "chunk" && file.isEntry) fixtureScript = file.code;
      if (file.type === "asset" && file.fileName.endsWith(".css")) fixtureStyle = String(file.source);
    }
    expect(fixtureScript).toBeTruthy();
    expect(fixtureStyle).toBeTruthy();
  });

  test.beforeEach(async ({ page }) => {
    await page.route("**/touchkit-fixture", (route) => route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">'
        + '<link rel="stylesheet" href="/touchkit-fixture.css"><div id="root"></div>'
        + '<script type="module" src="/touchkit-fixture.js"></script>',
    }));
    await page.route("**/touchkit-fixture.js", (route) => route.fulfill({ contentType: "text/javascript", body: fixtureScript }));
    await page.route("**/touchkit-fixture.css", (route) => route.fulfill({ contentType: "text/css", body: fixtureStyle }));
    await page.goto("/touchkit-fixture");
  });

  test("opens and dismisses a hint by touch", async ({ page }) => {
    const hintText = "This is the example hint.";
    const trigger = page.getByRole("button", { name: "Example hint" });
    const hint = page.getByRole("tooltip", { name: hintText });

    await trigger.tap();
    await expect(hint).toBeVisible();
    await expect(trigger).toHaveAccessibleDescription(hintText);
    await trigger.tap();
    await expect(hint).toBeHidden();

    await trigger.tap();
    await expect(hint).toBeVisible();
    await page.getByText("Outside the hint").tap();
    await expect(hint).toBeHidden();
  });

  test("wraps focus and closes with Escape", async ({ page }) => {
    const opener = page.getByRole("button", { name: "Open sheet" });
    const sheet = page.getByRole("dialog", { name: "Example sheet" });
    await opener.tap();
    await expect(sheet).toBeVisible();
    const close = sheet.getByRole("button", { name: "Close" });
    await expect(close).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(sheet.getByRole("button", { name: "Last action" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(opener).toBeFocused();
  });

  for (const name of ["Open sheet", "Open tall sheet"]) {
    test(`tap on the backdrop closes the sheet opened by "${name}"`, async ({ page }) => {
      const opener = page.getByRole("button", { name });
      const sheet = page.getByRole("dialog", { name: "Example sheet" });
      await opener.tap();
      await expect(sheet).toBeVisible();
      expect((await sheet.boundingBox())!.y).toBeGreaterThanOrEqual(44);
      await page.touchscreen.tap(page.viewportSize()!.width / 2, 22);
      await expect(sheet).toBeHidden();
    });
  }
});
