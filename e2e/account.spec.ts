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
  // Use unequal insets to check each edge of the visible viewport.
  await dialog.evaluate((element) => {
    element.style.setProperty("--dialog-safe-start", "47px");
    element.style.setProperty("--dialog-safe-end", "34px");
  });
  try {
    await expect.poll(async () => {
      const bounds = (await dialog.boundingBox())!;
      return bounds.y >= 83 && bounds.y + bounds.height <= 222;
    }).toBe(true);
  } finally {
    await dialog.evaluate((element) => {
      element.style.removeProperty("--dialog-safe-start");
      element.style.removeProperty("--dialog-safe-end");
    });
  }
}

test("settings dialogs fit a short visual viewport and the token can be copied", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: serviceUrl() });
  await screens.settings(page);
  await checkLayout(page.getByRole("main"));
  const main = page.getByRole("main");
  for (const name of ["Use a personal API key", "Delete account", "Make a token"]) {
    await main.getByRole("button", { name, exact: true }).first().click();
    const dialog = page.getByRole("dialog");
    await checkLayout(dialog);
    if (name === "Use a personal API key") await simulateKeyboard(page);
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

test("setup marks steps that need a computer", async ({ page }) => {
  await screens.setup(page);
  await checkLayout(page.getByRole("main"));
  await page.getByRole("button", { name: /Install wg/ }).click();
  await expect(page.getByRole("heading", { name: "3. Set up your Linear key" })).toBeVisible();
  await expect(page.getByText(/set up a local Linear key for each workspace on your computer/i)).toBeVisible();
  await expect(page.getByRole("heading", { name: "2. Add these settings to ~/.config/work-graph/config.json" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "5. Then run these commands" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Copy wg login/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Copy wg setup/ })).toBeVisible();
  await checkLayout(page.getByRole("main"));
});

async function openShare(page: Page) {
  await page.addInitScript(() => localStorage.setItem("wg-board", "off"));
  await page.goto(serviceUrl() + "/auth/login?as=ada&next=/?project=project");
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  const more = page.locator(".bar").getByRole("button", { name: "More", exact: true });
  if (await more.isVisible()) await more.press("Enter");
  await page.getByRole("button", { name: "Share", exact: true }).press("Enter");
  const dialog = page.getByRole("dialog", { name: "Share project" });
  await expect(dialog.getByText("grace@example.com", { exact: false })).toBeVisible();
  return dialog;
}

test("share members and their actions fit a short visual viewport", async ({ page }) => {
  const dialog = await openShare(page);
  const members = dialog.getByRole("region", { name: "Members" });
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

test("one-time share links can be copied without the Clipboard API", async ({ page }) => {
  const url = "https://example.com/join/example";
  await page.route("**/api/projects/project/share/view", (route) => route.fulfill({ json: { url } }));
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: undefined }));
  const dialog = await openShare(page);
  await dialog.getByRole("button", { name: "Make link" }).click();
  await expect(dialog.getByRole("textbox", { name: "New read-only link" })).toHaveValue(url);
  const copy = dialog.getByRole("button", { name: "Copy read-only link" });

  await page.evaluate(() => { document.execCommand = () => false; });
  await copy.click();
  await expect(dialog.getByRole("status").filter({ hasText: /could not copy.*select and copy the link/i })).toBeVisible();
  await expect(copy).toHaveText("Copy");

  await page.evaluate((expected) => {
    document.execCommand = (command) => {
      const field = document.activeElement;
      return command === "copy" && field instanceof HTMLTextAreaElement && !!field.closest("dialog[open]") &&
        field.value.slice(field.selectionStart, field.selectionEnd) === expected;
    };
  }, url);
  await copy.click();
  await expect(dialog.getByRole("status").filter({ hasText: "Link copied." })).toBeVisible();
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

test("an iOS home-screen app signs in and opens a join link without browser help", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Mobile/15E148" });
    const matchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query) => query === "(display-mode: standalone)"
      ? Object.defineProperty(matchMedia(query), "matches", { value: true })
      : matchMedia(query);
  });
  const login = "**/auth/login?**";
  await page.route(login, (route) => route.fulfill({ body: "Sign-in requested" }));

  await page.goto(serviceUrl());
  await expect(page.getByText(/open this page in your browser/i)).toHaveCount(0);
  await page.getByRole("link", { name: /Sign in with/ }).click();
  await expect(page.getByText("Sign-in requested")).toBeVisible();

  await page.goto(serviceUrl() + "/join/example");
  await expect(page.getByText("Sign-in requested")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("next")).toBe("/join/example?signed-in=1");

  await page.goto(serviceUrl() + "/join/example?signed-in=1");
  await expect(page.getByRole("link", { name: "Try signing in again" })).toBeVisible();
  await expect(page.getByText(/open this page in your browser/i)).toHaveCount(0);
  // The installed app has no address bar: the join screen gives a way back, a refresh, and the sign-in help.
  await expect(page.getByText(/finish signing in there/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh" })).toBeVisible();
  await page.getByRole("button", { name: "Overview" }).click();
  await expect(page).toHaveURL(serviceUrl() + "/");
});

async function expectBox(
  locator: Locator,
  { centerX, centerY, ...fixed }: { x?: number; y?: number; width?: number; centerX?: number; centerY?: number },
  textDependent: { y?: number; height: number; heightTolerance?: number },
) {
  await expect(locator).toBeVisible();
  await expect(async () => {
    const { x, y, width, height } = (await locator.boundingBox())!;
    expect({ x: Math.round(x), y: Math.round(y), width: Math.round(width) }).toMatchObject(fixed);
    if (centerX !== undefined) expect(Math.abs(x + width / 2 - centerX)).toBeLessThanOrEqual(1);
    if (centerY !== undefined) expect(Math.abs(y + height / 2 - centerY)).toBeLessThanOrEqual(1);
    if (textDependent.y !== undefined) expect(Math.abs(y - textDependent.y)).toBeLessThanOrEqual(12);
    expect(Math.abs(height - textDependent.height)).toBeLessThanOrEqual(textDependent.heightTolerance ?? 12);
  }).toPass({ timeout: 5000 });
}

test("account screens keep their desktop layout at 1440 pixels", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-1440x900");
  expect(await page.evaluate(() => matchMedia("(pointer: fine)").matches)).toBe(true);
  // Check fixed geometry exactly and allow for text wrapping across system fonts.
  await page.goto(serviceUrl());
  await expectBox(page.getByRole("link", { name: /Sign in with/ }), { centerX: 720 }, { y: 482, height: 33 });
  await page.goto(serviceUrl() + "/join/example?signed-in=1");
  await expect(page.getByRole("link", { name: "Try signing in again" })).toBeVisible();
  await expectBox(page.getByRole("heading", { name: "Join project" }), { x: 491, y: 53, width: 458 }, { height: 38 });
  await expectBox(page.locator(".share-join .account-card"), { x: 470, y: 32, width: 500 }, { height: 141 });

  await screens.settings(page);
  await expectBox(page.getByRole("heading", { name: "Settings", exact: true }), { x: 280, y: 76, width: 880 }, { height: 38 });
  await page.getByRole("button", { name: "Use a personal API key" }).click();
  // The instructions in this dialog can wrap onto one extra line.
  await expectBox(page.getByRole("dialog"), { x: 500, width: 440, centerY: 450 }, { height: 282, heightTolerance: 20 });

  await screens.setup(page);
  await page.getByRole("button", { name: /Install wg/ }).click();
  await expectBox(page.getByRole("heading", { name: "Install wg" }), { x: 507, y: 151, width: 632 }, { height: 26 });
  await expectBox(page.locator(".account-command").first(), { x: 507, width: 632 }, { y: 608, height: 252 });

  await expectBox(await openShare(page), { x: 450, width: 540, centerY: 450 }, { height: 776 });
});
