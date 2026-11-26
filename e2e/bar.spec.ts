import { expect, type Locator } from "@playwright/test";
import type { ProjectList } from "../src/lib/types.ts";
import { serviceUrl } from "./support/ports.ts";
import { screens, test } from "./support/screens.ts";

async function expectOneRow(bar: Locator, touch: boolean) {
  const bounds = (await bar.boundingBox())!;
  let center: number | undefined;
  for (const control of await bar.getByRole("button").or(bar.getByRole("link")).all()) {
    const box = (await control.boundingBox())!;
    center ??= box.y + box.height / 2;
    expect(box.y + box.height / 2).toBeCloseTo(center, 0);
    expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
    if (touch) {
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      await expect.poll(() => control.evaluate((element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(x + width / 2, y + height / 2));
      })).toBe(true);
    }
  }
  expect(await bar.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(bounds.width);
}

test("the project bar keeps one row and gives touch controls room", async ({ page }, info) => {
  const desktop = info.project.name.startsWith("desktop-");
  const phone = info.project.name.startsWith("phone-");
  await screens.project(page);
  const bar = page.locator(".bar");
  if (info.project.name.startsWith("tablet-820")) {
    for (const width of [768, 820, 1024, 1180]) {
      await page.setViewportSize({ width, height: 820 });
      await expectOneRow(bar, true);
      expect(await page.evaluate(() => document.scrollingElement!.scrollWidth)).toBeLessThanOrEqual(width);
    }
    await page.setViewportSize({ width: 820, height: 1180 });
  }
  await expectOneRow(bar, !desktop);
  const project = bar.getByRole("button", { name: /Example project/ });
  await expect(project).toBeVisible();
  if (phone) {
    await expect(project).toContainText("Example project");
    expect(await project.locator(".bar-project").evaluate((name) => name.scrollWidth)).toBeLessThanOrEqual(
      await project.locator(".bar-project").evaluate((name) => name.clientWidth),
    );
  }
  await expect(bar.getByRole("button", { name: /^Overview/ })).toBeVisible();
  const more = bar.getByRole("button", { name: "More", exact: true });
  const board = bar.getByRole("button", { name: "Board", exact: true });
  await expect(bar.getByRole("button", { name: "Keyboard keys" })).toHaveCount(desktop ? 1 : 0);
  await expect(board).toHaveCount(phone ? 0 : 1);
  if (desktop) {
    await expect(more).toHaveCount(0);
    await expect(bar.getByRole("button", { name: /^Autonomy/ })).toBeVisible();
    await expect(bar.getByRole("button", { name: /^Review/ })).toBeVisible();
    await expect(bar.getByRole("button", { name: "Close project" })).toBeVisible();
  } else {
    await more.click();
    const menu = page.getByRole("dialog", { name: "Project controls" });
    await expect(menu.getByRole("button", { name: "Copy the project link" })).toBeVisible();
    await expect(menu.getByRole("button", { name: /^Autonomy/ })).toBeVisible();
    await expect(menu.getByRole("button", { name: /^Review/ })).toBeVisible();
    await expect(menu.getByText(/^The build of the server:/)).toBeVisible();
    for (const control of await menu.getByRole("button").all()) {
      await expect(control).toHaveCSS("min-width", "44px");
      await expect(control).toHaveCSS("min-height", "44px");
    }
    await expect(menu.getByRole("button", { name: "Board", exact: true })).toHaveCount(phone ? 1 : 0);
    await expect(menu.getByRole("button", { name: /^View/ })).toHaveCount(phone ? 1 : 0);
    const close = menu.getByRole("button", { name: "Close project" });
    await expect(menu.getByRole("button").last()).toHaveText("Close project");
    const confirmation = page.waitForEvent("dialog");
    const click = close.click();
    const dialog = await confirmation;
    expect(dialog.type()).toBe("confirm");
    expect(dialog.message()).toContain("marks every issue");
    await dialog.dismiss();
    await click;
    await expect(menu).toBeVisible();
    await menu.getByRole("button", { name: "Close", exact: true }).click();
    await expect(more).toBeFocused();
  }
  await project.click();
  await expect(page.getByRole("option", { name: /Planned project/ })).toBeVisible();
});

test("the account bar keeps sign out available on touch screens", async ({ page }, info) => {
  const desktop = info.project.name.startsWith("desktop-");
  await screens.settings(page);
  const bar = page.locator(".account-bar");
  await expectOneRow(bar, !desktop);
  if (desktop) {
    await expect(bar.getByRole("link", { name: "Sign out" })).toBeVisible();
  } else {
    await bar.getByRole("button", { name: "More", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Account controls" }).getByRole("link", { name: "Sign out" }))
      .toHaveAttribute("href", "/auth/logout");
  }
});

test("the service project bar keeps sharing and sign out reachable", async ({ page }, info) => {
  const desktop = info.project.name.startsWith("desktop-");
  const next = encodeURIComponent("/?workspace=example&project=project");
  await page.goto(`${serviceUrl()}/auth/login?as=ada&next=${next}`);
  const bar = page.locator(".service-app .bar");
  await expect(bar.getByRole("button", { name: /Example project/ })).toBeVisible();
  await expect(bar.getByRole("button", { name: "Refresh project" })).toBeVisible();
  if (info.project.name.startsWith("tablet-820")) {
    for (const width of [768, 1024, 820]) {
      await page.setViewportSize({ width, height: 820 });
      await expectOneRow(bar, true);
    }
  }
  await expectOneRow(bar, !desktop);
  if (!desktop) await bar.getByRole("button", { name: "More", exact: true }).click();
  const controls = desktop ? bar : page.getByRole("dialog", { name: "Project controls" });
  await expect(controls.getByRole("link", { name: "Sign out" })).toHaveAttribute("href", "/auth/logout");
  const share = controls.getByRole("button", { name: "Share", exact: true });
  if (desktop) await share.click();
  else await share.tap();
  await expect(page.getByRole("dialog", { name: "Share project" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Project controls" })).toHaveCount(0);
});

test("the sync lamp stays still during a refresh with reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await screens.project(page);
  await page.route("**/api/projects/fixture/graph*", () => {});
  await page.getByRole("button", { name: "Refresh project" }).click();
  await expect(page.locator(".sync-dot.is-busy")).toHaveCSS("animation-name", "none");
});

test("the project bar preserves its main-branch tooltip text", async ({ page }, info) => {
  const desktop = info.project.name.startsWith("desktop-");
  const longName = "Example project with a long name that needs all the space available in the bar";
  const viewerUrl = "https://example.com/viewer";
  let shared = false;
  await page.route("**/api/config", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), user: "ada@example.com" } });
  });
  await page.route(/\/api\/(projects|overview)$/, async (route) => {
    const response = await route.fetch();
    const list: ProjectList = await response.json();
    await route.fulfill({ response, json: {
      ...list,
      workspaces: list.workspaces.map((workspace) => ({ ...workspace, shareUrl: viewerUrl })),
      projects: list.projects.map((project) => project.id === "fixture"
        ? { ...project, name: longName, shared, autonomy: null, review: null }
        : project),
    } });
  });

  const titles = [
    "All projects: which ones wait on you, and how far each one is.",
    `Copy the project name: ${longName}`,
    "Autonomy level: what the coordinator may do without you. No label on the project: standard. A change tells the coordinator at once.",
    "Review effort: how much review each PR gets. No label on the project: thorough. A change tells the coordinator at once.",
    "Show or hide the list of issues by the action they need. Press / to find an issue.",
    "View options",
    /^Refresh now\. The graph also refreshes every 15 s\. Last sync .+\.$/,
    /^The build of the server: .+/,
    "Keyboard keys (?)",
    "Signed in as ada@example.com. Select to sign out.",
    "Mark every issue in this project Done and complete the project.",
    "Show this project on the read-only viewer, for each account that may sign in there. The link to copy shows here then.",
  ];
  await screens.project(page);
  const bar = page.locator(".project-bar");
  const name = bar.locator(".bar-project");
  await expect(name).toContainText(longName);
  if (!desktop) {
    const space = await name.evaluate((label) => {
      const bar = label.closest(".project-bar")!;
      const picker = label.closest(".picker")!;
      const trigger = label.closest("button")!;
      const gap = parseFloat(getComputedStyle(bar).columnGap);
      const next = picker.nextElementSibling!.getBoundingClientRect().width
        ? picker.nextElementSibling!
        : picker.nextElementSibling!.nextElementSibling!;
      return {
        unfilled: next.getBoundingClientRect().left - trigger.getBoundingClientRect().right - gap,
        clipped: label.scrollWidth > label.clientWidth,
      };
    });
    expect(space.unfilled).toBeCloseTo(0, 0);
    if (info.project.name.startsWith("phone-")) expect(space.clipped).toBe(true);
  }
  await expect(bar.getByRole("button", { name: "Refresh project" })).toBeVisible();
  const menu = page.getByRole("dialog", { name: "Project controls" });
  const more = bar.getByRole("button", { name: "More", exact: true });
  const checkText = async (text: string | RegExp) => {
    if (desktop) await expect(bar.getByTitle(text, { exact: true })).toHaveCount(1);
    else await expect(menu.getByText(text, { exact: true })).toBeVisible();
  };
  if (!desktop) await more.tap();
  for (const title of titles) await checkText(title);

  shared = true;
  await page.reload();
  await expect(bar.getByRole("button", { name: "Refresh project" })).toBeVisible();
  if (!desktop) await more.tap();
  await checkText("Each account that may sign in to the viewer can read this project there. It cannot change it.");
  await checkText("Remove this project from the viewer.");
  await checkText(/^Copy the viewer link: https:\/\/example\.com\/viewer\/\?.*project=fixture$/);
});

test("a viewer can read the explanation of view-only access", async ({ page }, info) => {
  const desktop = info.project.name.startsWith("desktop-");
  await page.route("**/api/config", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), readOnly: true } });
  });
  await screens.project(page);
  const bar = page.locator(".project-bar");
  const note = "This page changes nothing. The owner of the project changes it on their own page.";
  if (desktop) {
    await expect(bar.getByTitle(note, { exact: true })).toBeVisible();
  } else {
    await bar.getByRole("button", { name: "More", exact: true }).tap();
    const menu = page.getByRole("dialog", { name: "Project controls" });
    await expect(menu.getByText(note, { exact: true })).toBeVisible();
    await expect(menu.getByRole("button", { name: "Copy the project link" })).toBeEnabled();
    await expect(menu.getByRole("button", { name: "Share", exact: true })).toHaveCount(0);
    await expect(menu.getByRole("button", { name: "Close project" })).toHaveCount(0);
  }
});
