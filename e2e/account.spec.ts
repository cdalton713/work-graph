import { expect, type Locator, type Page } from "@playwright/test";
import { serviceUrl } from "./support/ports.ts";
import { screens, test } from "./support/screens.ts";

async function checkLayout(scope: Locator) {
  const page = scope.page();
  const viewport = page.viewportSize()!;
  await checkViewportLayout(scope);
  const additionalWidth = new Map([[820, 768], [1180, 1024]]).get(viewport.width);
  if (additionalWidth) {
    try {
      await page.setViewportSize({ ...viewport, width: additionalWidth });
      await checkViewportLayout(scope);
    } finally {
      await page.setViewportSize(viewport);
    }
  }
}

async function checkViewportLayout(scope: Locator) {
  await expect(scope).toBeVisible();
  const layout = await scope.evaluate((element) => {
    const coarse = matchMedia("(pointer: coarse)").matches;
    const controls = Array.from(element.querySelectorAll(
      "button, a[href], input:not([type=checkbox]), label:has(input[type=checkbox]), select",
    ))
      .filter((control) => control.getClientRects().length > 0);
    return {
      overflow: element.scrollWidth - element.clientWidth,
      bodyOverflow: document.documentElement.scrollWidth - window.innerWidth,
      targets: coarse ? controls.filter((control) => {
        const { width, height } = control.getBoundingClientRect();
        return width < 44 || height < 44;
      }).map((control) => control.textContent || control.getAttribute("aria-label") || control.tagName) : [],
      fields: coarse ? controls.filter((control) => control.matches("input, select"))
        .map((control) => parseFloat(getComputedStyle(control).fontSize)) : [],
    };
  });
  expect(layout.overflow).toBeLessThanOrEqual(0);
  expect(layout.bodyOverflow).toBeLessThanOrEqual(0);
  expect(layout.targets).toEqual([]);
  for (const size of layout.fields) expect(size).toBeGreaterThanOrEqual(16);
}

async function simulateKeyboard(page: Page) {
  // Desktop Chromium has no software keyboard. Shrink just the visual viewport.
  await page.evaluate(() => {
    const viewport = window.visualViewport!;
    Object.defineProperties(viewport, {
      height: { configurable: true, value: 220 },
      offsetTop: { configurable: true, value: 36 },
    });
    viewport.dispatchEvent(new Event("resize"));
  });
}

async function checkKeyboardDialog(dialog: Locator) {
  await expect.poll(async () => {
    const bounds = (await dialog.boundingBox())!;
    return bounds.y >= 36 && bounds.y + bounds.height <= 256;
  }).toBe(true);
}

test("settings dialogs fit a short visual viewport and the token can be copied", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: serviceUrl() });
  await screens.settings(page);
  await checkLayout(page.getByRole("main"));
  const main = page.getByRole("main");
  for (const name of ["Attach another workspace", "Delete account", "Make a token"]) {
    await main.getByRole("button", { name, exact: true }).first().click();
    const dialog = page.getByRole("dialog");
    await checkLayout(dialog);
    if (name === "Attach another workspace") await simulateKeyboard(page);
    await checkKeyboardDialog(dialog);
    if (name !== "Make a token") {
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      continue;
    }
    await dialog.getByRole("textbox", { name: "Token name" }).fill("Example coordinator");
    await dialog.getByRole("button", { name, exact: true }).click();
    await expect(dialog.getByText(/will not appear again/i)).toBeVisible();
    const secret = await dialog.getByLabel("Coordinator token", { exact: true }).inputValue();
    expect(secret.length).toBeGreaterThan(0);
    await dialog.getByRole("button", { name: "Copy coordinator token" }).click();
    await expect(dialog.getByText("Token copied.")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText()) === secret).toBe(true);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
  }
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("setup marks commands that need a computer", async ({ page }) => {
  await screens.setup(page);
  await checkLayout(page.getByRole("main"));
  await page.getByRole("button", { name: /Set up wg/ }).click();
  await expect(page.getByText("Run these commands on your computer")).toBeVisible();
  await expect(page.getByText(/wg login/, { exact: false }).first()).toBeVisible();
  await checkLayout(page.getByRole("main"));
});

test("share members and their actions fit a short visual viewport", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("wg-board", "off"));
  await page.goto(serviceUrl() + "/auth/login?as=ada&next=/?project=project");
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await page.getByRole("button", { name: "Share", exact: true }).press("Enter");
  const dialog = page.getByRole("dialog", { name: "Share project" });
  await expect(dialog).toBeVisible();
  const members = dialog.getByRole("region", { name: "Members" });
  await expect(members.getByText("grace@example.com", { exact: false })).toBeVisible();
  await checkLayout(dialog);
  await simulateKeyboard(page);
  await checkKeyboardDialog(dialog);
  const remove = members.getByRole("button", { name: "Remove", exact: true }).last();
  await remove.click();
  const confirm = dialog.getByRole("button", { name: "Remove member" });
  await confirm.scrollIntoViewIfNeeded();
  await expect(confirm).toBeInViewport();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(remove).toBeFocused();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);
});

test("sign-in and join give recovery instructions in an in-app browser", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Mobile/15E148 [FBAN/FBIOS]" });
  });
  await page.goto(serviceUrl());
  await expect(page.getByRole("link", { name: /Sign in with/ })).toBeVisible();
  await expect(page.getByText(/open this page in your browser/i)).toBeVisible();
  await checkLayout(page.getByRole("main"));

  await page.goto(serviceUrl() + "/join/example");
  await expect(page.getByText(/open this page in your browser/i)).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
  await checkLayout(page.getByRole("main"));

  await page.goto(serviceUrl() + "/join/example?signed-in=1");
  await expect(page.getByText(/open this page in your browser/i)).toBeVisible();
  await expect(page.getByRole("link", { name: "Try signing in again" })).toBeVisible();
  await checkLayout(page.getByRole("main"));
});
