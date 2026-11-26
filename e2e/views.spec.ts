import { expect } from "@playwright/test";
import { issuePath, projectPath, test } from "./support/screens.ts";

test("phone opens the list and keeps the chosen view for issue links", async ({ page }, info) => {
  test.skip(!info.project.name.startsWith("phone-"));
  await page.goto(projectPath);
  const board = page.getByRole("navigation", { name: "Issues by the action they need" });
  const graph = page.locator(".react-flow");
  const controls = page.getByRole("group", { name: "Project view" });
  const listView = controls.getByRole("button", { name: "List" });
  const graphView = controls.getByRole("button", { name: "Graph" });
  await expect(board).toBeVisible();
  await expect(graph).toBeHidden();
  await expect(listView).toHaveAttribute("aria-pressed", "true");
  await graphView.tap();
  await expect(graph).toBeVisible();
  const zoom = await graph.locator(".react-flow__controls").boundingBox();
  const switchBox = await controls.boundingBox();
  expect(zoom!.y + zoom!.height).toBeLessThanOrEqual(switchBox!.y);
  expect(switchBox!.y + switchBox!.height).toBe(page.viewportSize()!.height);
  for (const button of [listView, graphView]) {
    const box = (await button.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await page.goto(issuePath);
  await expect(page.locator(".panel")).toBeVisible();
  await expect(graphView).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Close panel" }).tap();
  await listView.tap();
  await page.goto(issuePath);
  await expect(page.locator(".panel")).toBeVisible();
  await expect(listView).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(page.viewportSize()!.width);
});

test("phone back keeps the list scroll and graph viewport", async ({ page }, info) => {
  test.skip(!info.project.name.startsWith("phone-"));
  await page.route("**/api/projects/fixture/graph*", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    const [first, second] = data.issues;
    first.blocks = [{ ...second, inProject: true }];
    data.issues.push(...Array.from({ length: 25 }, (_, index) => ({
      ...first, id: `extra-${index}`, identifier: `WG-${100 + index}`,
      title: `Example task ${index}`, card: null, blocks: [],
    })));
    await route.fulfill({ response, json: data });
  });
  await page.goto(projectPath);
  const list = page.locator(".board-scroll");
  await expect(list).toBeVisible();
  const row = list.getByRole("button", { name: /WG-11[0-9]\b/ }).first();
  await row.scrollIntoViewIfNeeded();
  const scroll = await list.evaluate((element) => element.scrollTop);
  expect(scroll).toBeGreaterThan(0);
  await row.tap();
  const panel = page.locator(".panel");
  await expect(panel).toBeVisible();
  await expect(page).toHaveURL(/issue=WG-11[0-9]/);
  await page.goBack();
  await expect(panel).toBeHidden();
  await expect(list).toBeVisible();
  expect(await list.evaluate((element) => element.scrollTop)).toBe(scroll);

  await list.getByRole("button", { name: /WG-1\b/ }).tap();
  const show = panel.getByRole("button", { name: "Show in graph" });
  await expect(show).toBeVisible();
  expect((await show.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await show.tap();
  await expect(panel).toBeHidden();
  const graph = page.locator(".react-flow");
  const node = graph.locator(".station").filter({ has: page.getByText("WG-1", { exact: true }) });
  const trace = graph.getByRole("img", { name: "WG-2 waits on WG-1" });
  await expect(trace).toHaveClass(/track-lit/);
  const pane = (await graph.boundingBox())!;
  await expect.poll(async () => {
    const box = await node.boundingBox();
    if (!box) return Infinity;
    return Math.hypot(box.x + box.width / 2 - pane.x - pane.width / 2, box.y + box.height / 2 - pane.y - pane.height / 2);
  }).toBeLessThan(0.1);
  const viewport = graph.locator(".react-flow__viewport");
  const transform = await viewport.evaluate((element) => element.style.transform);
  await node.tap();
  await expect(panel).toBeVisible();
  await page.goBack();
  await expect(panel).toBeHidden();
  await expect(graph).toBeVisible();
  expect(await viewport.evaluate((element) => element.style.transform)).toBe(transform);
});

test("tablet panes follow rotation and unfolding without reloading", async ({ page }, info) => {
  test.skip(!info.project.name.startsWith("tablet-"));
  await page.goto(projectPath);
  const board = page.locator(".board");
  const canvas = page.locator(".react-flow");
  const panel = page.locator(".panel");
  await expect(canvas).toBeVisible();
  const search = board.getByRole("searchbox");
  await search.fill("WG-1");
  await board.getByRole("button", { name: /WG-1\b/ }).tap();
  await expect(panel).toBeVisible();
  for (const width of [768, 820, 1024, 1180]) {
    const portrait = width < 900;
    await page.setViewportSize({ width, height: portrait ? 1180 : 820 });
    await expect(board).toBeVisible();
    const boardBox = (await board.boundingBox())!;
    const panelBox = (await panel.boundingBox())!;
    expect(boardBox.width).toBeCloseTo(width / (portrait ? 2 : 3), 0);
    expect(panelBox.width).toBeCloseTo(boardBox.width, 0);
    expect(panelBox.x + panelBox.width).toBeCloseTo(width, 0);
    expect(panelBox.y).toBeCloseTo(boardBox.y, 0);
    if (portrait) {
      await expect(canvas).toBeHidden();
      expect(panelBox.x).toBeCloseTo(boardBox.x + boardBox.width, 0);
    } else {
      await expect(canvas).toBeVisible();
      expect((await canvas.boundingBox())!.width).toBeCloseTo(width / 3, 0);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  }
  await page.setViewportSize({ width: 430, height: 932 });
  await expect(page.getByRole("group", { name: "Project view" })).toBeVisible();
  await expect(panel).toBeVisible();
  await page.getByRole("button", { name: "Close panel" }).tap();
  await expect(search).toHaveValue("WG-1");
  await page.setViewportSize({ width: 768, height: 1024 });
  await expect(canvas).toBeVisible();
  await expect(search).toHaveValue("WG-1");
});

test("desktop keeps the board, canvas and issue panel side by side", async ({ page }, info) => {
  test.skip(!info.project.name.startsWith("desktop-"));
  await page.goto(projectPath);
  const board = page.locator(".board");
  const canvas = page.locator(".react-flow");
  await board.getByRole("button", { name: /WG-1\b/ }).click();
  const panel = page.locator(".panel");
  await expect(panel).toBeVisible();
  await expect(page.getByRole("group", { name: "Project view" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Show in graph" })).toHaveCount(0);
  const boardBox = (await board.boundingBox())!;
  const canvasBox = (await canvas.boundingBox())!;
  const panelBox = (await panel.boundingBox())!;
  expect(boardBox.width).toBe(300);
  expect(panelBox.width).toBe(460);
  expect(canvasBox.x).toBe(boardBox.x + boardBox.width);
  expect(panelBox.x).toBe(canvasBox.x + canvasBox.width);
  expect(panelBox.x + panelBox.width).toBe(1440);
});

test("phone view switch closes an open panel and returns to the project entry", async ({ page }, info) => {
  test.skip(info.project.name !== "phone-390x844");
  await page.goto("/");
  await page.goto(projectPath);
  const board = page.locator(".board");
  const graph = page.locator(".react-flow");
  const panel = page.locator(".panel");
  const controls = page.getByRole("group", { name: "Project view" });
  await board.getByRole("button", { name: /WG-1\b/ }).tap();
  await expect(panel).toBeVisible();
  await controls.getByRole("button", { name: "Graph" }).tap();
  await expect(panel).toBeHidden();
  await expect(graph).toBeVisible();
  await expect(page).toHaveURL(/\?project=fixture$/);

  await page.goForward();
  await expect(panel).toBeVisible();
  await controls.getByRole("button", { name: "List" }).tap();
  await expect(panel).toBeHidden();
  await expect(board).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL("/");
});

test("showing a filtered issue in the graph keeps the saved runner filter", async ({ page }, info) => {
  test.skip(info.project.name !== "phone-390x844");
  const filterKey = "wg:claims:default:fixture";
  await page.addInitScript((key) => localStorage.setItem(key, "mine"), filterKey);
  await page.goto(projectPath);
  await expect(page.locator(".board")).toBeVisible();
  await page.locator(".bar").getByRole("button", { name: "More", exact: true }).tap();
  const menu = page.getByRole("dialog", { name: "Project controls" });
  await menu.getByRole("button", { name: /^View/ }).tap();
  const option = page.getByRole("option", { name: /Open issues only/ });
  await option.tap();
  await expect(option).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Done", exact: true }).tap();
  await menu.getByRole("button", { name: "Close", exact: true }).tap();

  const board = page.locator(".board");
  await board.getByRole("searchbox").fill("WG-11");
  await board.getByRole("button", { name: /WG-11\b/ }).tap();
  await page.getByRole("button", { name: "Show in graph" }).tap();
  await expect(page.locator(".react-flow .station.is-selected").getByText("WG-11", { exact: true })).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), filterKey)).toBe("mine");
});
