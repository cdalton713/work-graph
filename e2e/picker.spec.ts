import { expect, type Locator, type Page } from "@playwright/test";
import type { GraphData, Issue, IssuePatch } from "../src/lib/types.ts";
import { screens, test } from "./support/screens.ts";

test.use({ reducedMotion: "reduce" });

async function box(locator: Locator) {
  await expect(locator).toBeVisible();
  return (await locator.boundingBox())!;
}

async function openSheet(page: Page, trigger: Locator, multi = false) {
  await expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
  await trigger.tap();
  const dialog = page.getByRole("dialog");
  const bounds = await box(dialog);
  const viewport = page.viewportSize()!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
  const close = dialog.getByRole("button", { name: "Close", exact: true });
  await expect(close).toBeFocused();
  await expect(dialog.getByRole("textbox", { name: "Filter" })).toBeVisible();
  const options = await dialog.getByRole("option").all();
  expect(options.length).toBeGreaterThan(0);
  const controls = [close, ...options];
  if (multi) controls.push(dialog.getByRole("button", { name: "Done", exact: true }));
  for (const control of controls) {
    const size = await box(control);
    expect(size.width).toBeGreaterThanOrEqual(44);
    expect(size.height).toBeGreaterThanOrEqual(44);
  }
  return dialog;
}

async function addPanelChoices(page: Page) {
  const ada = { id: "ada", name: "Ada", avatarUrl: null };
  const labels = Array.from({ length: 30 }, (_, i) => ({
    id: `label-${i + 1}`, name: `Label ${String(i + 1).padStart(2, "0")}`, color: "#4466aa", group: null,
  }));
  let graph: GraphData;
  let issue: Issue;
  await page.route("**/api/projects/fixture/graph*", async (route) => {
    const response = await route.fetch();
    if (response.status() !== 200) return route.fulfill({ response });
    graph = await response.json();
    issue = graph.issues.find((entry) => entry.identifier === "WG-1")!;
    graph.teams[issue.teamId].members = [ada];
    graph.labels = labels;
    await route.fulfill({ response, json: graph });
  });
  await page.route("**/api/issues/issue-1", async (route) => {
    const patch: IssuePatch = route.request().postDataJSON();
    const state = graph.teams[issue.teamId].states.find((entry) => entry.id === patch.stateId) ?? issue.state;
    const assignee = patch.assigneeId === undefined ? issue.assignee : patch.assigneeId === ada.id ? ada : null;
    issue = {
      ...issue, state, assignee, priority: patch.priority ?? issue.priority,
      labels: patch.labelIds ? labels.filter(({ id }) => patch.labelIds!.includes(id)) : issue.labels,
    };
    await route.fulfill({ json: issue });
  });
}

test("bar pickers open as sheets and apply choices", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("phone-"), "Requires a touch phone");
  await page.route(/\/api\/projects\/fixture\/(autonomy|review-effort)$/, (route) =>
    route.fulfill({ json: { ok: true, queued: 0, ...route.request().postDataJSON() } }),
  );
  await screens.project(page);
  const bar = page.locator(".bar");
  const view = bar.getByRole("button", { name: /^View/ });
  let dialog = await openSheet(page, view, true);
  const openOnly = dialog.getByRole("option", { name: /Open issues only/ });
  const selected = await openOnly.getAttribute("aria-selected");
  await openOnly.tap();
  await expect(openOnly).toHaveAttribute("aria-selected", selected === "true" ? "false" : "true");
  await dialog.getByRole("button", { name: "Done", exact: true }).tap();
  await expect(dialog).toBeHidden();
  await expect(view).toBeFocused();

  for (const [name, choice] of [["Autonomy", "supervised"], ["Review", "light"]]) {
    const trigger = bar.getByRole("button", { name: new RegExp(`^${name} `) });
    dialog = await openSheet(page, trigger);
    const option = dialog.getByRole("option").filter({ hasText: choice });
    await expect(option.locator(".picker-hint")).toHaveCSS("white-space", "normal");
    await option.tap();
    await expect(dialog).toBeHidden();
    await expect(trigger).toContainText(choice);
  }

  const project = bar.getByRole("button", { name: /Example project/ });
  dialog = await openSheet(page, project);
  await dialog.getByRole("option").filter({ hasText: "Planned project" }).tap();
  await expect(dialog).toBeHidden();
  await expect(bar.getByRole("button", { name: /Planned project/ })).toBeVisible();
});

test("panel pickers apply choices and keep controls outside the scrolling rows", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("phone-"), "Requires a touch phone");
  await addPanelChoices(page);
  await screens.issue(page);
  const panel = page.locator(".panel");
  for (const [current, choice] of [["Triage", "Backlog"], ["No priority", "High"], ["No assignee", "Ada"]]) {
    const trigger = panel.getByRole("button", { name: current, exact: true });
    const dialog = await openSheet(page, trigger);
    await expect(dialog.getByRole("option", { selected: true })).toContainText(current);
    if (current === "No priority") {
      const filter = dialog.getByRole("textbox", { name: "Filter" });
      await filter.tap();
      await expect(filter).toBeFocused();
      await filter.fill(choice);
      await filter.press("Enter");
    } else {
      await dialog.getByRole("option").filter({ hasText: choice }).tap();
    }
    await expect(dialog).toBeHidden();
    await expect(panel.getByRole("button", { name: choice, exact: true })).toBeVisible();
  }

  const dialog = await openSheet(page, panel.locator(".fields").getByRole("button", { name: "Edit", exact: true }), true);
  const filter = dialog.getByRole("textbox", { name: "Filter" });
  const done = dialog.getByRole("button", { name: "Done", exact: true });
  const list = dialog.getByRole("listbox");
  const filterBefore = await box(filter);
  const doneBefore = await box(done);
  await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  expect(await list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await box(filter)).toEqual(filterBefore);
  expect(await box(done)).toEqual(doneBefore);
  const listBounds = await box(list);
  expect(listBounds.y).toBeGreaterThanOrEqual(filterBefore.y + filterBefore.height);
  expect(listBounds.y + listBounds.height).toBeLessThanOrEqual(doneBefore.y);
  const label = dialog.getByRole("option", { name: "Label 30", exact: true });
  await label.tap();
  await expect(label).toHaveAttribute("aria-selected", "true");
  await done.tap();
  await expect(dialog).toBeHidden();
  await expect(panel.locator(".fields").getByText("Label 30", { exact: true })).toBeVisible();
});

test("the desktop picker keeps its list, Escape, and mouse selection", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("desktop-"), "Requires a mouse");
  await screens.project(page);
  const trigger = page.locator(".bar").getByRole("button", { name: /Example project/ });
  await expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
  await trigger.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("listbox").getByRole("option", { selected: true })).toContainText("Example project");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.getByRole("option", { name: /Planned project/ }).click();
  await expect(page.getByRole("listbox")).toBeHidden();
  await expect(page.locator(".bar").getByRole("button", { name: /Planned project/ })).toBeVisible();
});
