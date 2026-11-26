import { expect, type Page } from "@playwright/test";
import { test } from "./support/screens.ts";

test.beforeEach(async ({ page }, info) => {
  await page.addInitScript(() => localStorage.setItem("wg-board", "off"));
  await page.goto("/?project=canvas");
  if (info.project.name.startsWith("phone-")) {
    await page.getByRole("group", { name: "Project view" }).getByRole("button", { name: "Graph" }).tap();
  }
  await expect(page.locator(".react-flow__controls")).toBeVisible();
});

const station = (page: Page, id: number) =>
  page.locator(".react-flow__node").filter({ has: page.getByText(`WG-${id}`, { exact: true }) });

async function centre(page: Page) {
  return page.locator(".react-flow__viewport").evaluate((element) => {
    const pane = element.closest(".react-flow")!.getBoundingClientRect();
    const matrix = new DOMMatrix(getComputedStyle(element).transform);
    return { x: (pane.width / 2 - matrix.e) / matrix.a, y: (pane.height / 2 - matrix.f) / matrix.a, zoom: matrix.a };
  });
}

async function touchInput(page: Page) {
  const session = await page.context().newCDPSession(page);
  return (type: "touchStart" | "touchMove" | "touchEnd", ...points: { x: number; y: number }[]) =>
    session.send("Input.dispatchTouchEvent", { type, touchPoints: points.map((point, id) => ({ ...point, id })) });
}

test("the first view fits the current wave on touch screens", async ({ page, hasTouch }) => {
  test.skip(!hasTouch);
  await expect(station(page, 35)).toBeInViewport({ ratio: 1 });
  await expect(station(page, 36)).toBeInViewport({ ratio: 1 });
  const pane = (await page.locator(".react-flow").boundingBox())!;
  const first = (await station(page, 35).boundingBox())!;
  const last = (await station(page, 36).boundingBox())!;
  expect((first.y + last.y + last.height) / 2).toBeCloseTo(pane.y + pane.height / 2, 0);
  expect(pane.x + pane.width).toBeLessThanOrEqual(page.viewportSize()!.width);
});

test("drag and pinch work from a station without moving the page", async ({ page, hasTouch }) => {
  test.skip(!hasTouch);
  const node = station(page, 35);
  await expect(node).toBeInViewport({ ratio: 1 });
  const box = (await node.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const touch = await touchInput(page);
  const before = await centre(page);
  const pagePosition = () => page.evaluate(() => [window.scrollX, window.scrollY, window.visualViewport!.scale]);
  const initialPage = await pagePosition();
  await touch("touchStart", { x, y });
  await touch("touchMove", { x: x + 40, y: y + 20 });
  await touch("touchMove", { x: x + 60, y: y + 30 });
  await touch("touchEnd");
  await expect.poll(async () => (await centre(page)).x).toBeLessThan(before.x - 20);
  expect((await centre(page)).y).toBeLessThan(before.y - 15);
  await expect(page.locator(".panel")).toHaveCount(0);
  await touch("touchStart", { x: x + 45, y: y + 30 }, { x: x + 75, y: y + 30 });
  await touch("touchMove", { x: x + 25, y: y + 30 }, { x: x + 95, y: y + 30 });
  await touch("touchEnd");
  await expect.poll(async () => (await centre(page)).zoom).toBeGreaterThan(before.zoom);
  expect(await pagePosition()).toEqual(initialPage);
  await expect(page.locator(".react-flow__renderer")).toHaveCSS("touch-action", "none");
});

test("a station at the right edge opens the tablet panel for the current orientation", async ({ page }, info) => {
  test.skip(!info.project.name.startsWith("tablet-"));
  const node = station(page, 35);
  const panel = page.locator(".panel");
  const graph = page.locator(".react-flow");
  await expect(node).toBeInViewport({ ratio: 1 });
  const pane = (await graph.boundingBox())!;
  const box = (await node.boundingBox())!;
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const distance = pane.x + pane.width - 10 - box.x - box.width;
  const touch = await touchInput(page);
  await touch("touchStart", start);
  await touch("touchMove", { x: start.x + distance / 2, y: start.y });
  await touch("touchMove", { x: start.x + distance, y: start.y });
  await touch("touchEnd");
  await expect.poll(async () => {
    const moved = (await node.boundingBox())!;
    return pane.x + pane.width - moved.x - moved.width;
  }).toBeCloseTo(10, 0);
  await node.tap();
  await expect(panel).toContainText("Graph issue 35");
  const { width, height } = page.viewportSize()!;
  if (height > width) {
    await expect(graph).toBeHidden();
    const aside = (await panel.boundingBox())!;
    expect(aside).toEqual(pane);
    await panel.getByRole("button", { name: "Close panel" }).tap();
    await expect(graph).toBeVisible();
    await expect(node).toBeInViewport({ ratio: 0.99 });
    return;
  }
  await expect(node).toBeInViewport({ ratio: 0.99 });
  await expect.poll(async () => {
    const current = (await node.boundingBox())!;
    const aside = (await panel.boundingBox())!;
    return current.x + current.width - aside.x;
  }).toBeLessThanOrEqual(0);
});

test("double tap zooms to a station and fits the graph from the pane", async ({ page, hasTouch }) => {
  test.skip(!hasTouch);
  const node = station(page, 35);
  await expect(node).toBeInViewport({ ratio: 1 });
  const box = (await node.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const before = await centre(page);
  await page.touchscreen.tap(x, y);
  await page.touchscreen.tap(x, y);
  await expect.poll(async () => (await centre(page)).zoom).toBeGreaterThan(before.zoom);
  await expect(page.locator(".panel")).toHaveCount(0);
  const pane = (await page.locator(".react-flow").boundingBox())!;
  await page.touchscreen.tap(pane.x + 8, pane.y + 18);
  await page.touchscreen.tap(pane.x + 8, pane.y + 18);
  await expect(station(page, 21)).toBeInViewport({ ratio: 0.99 });
  await expect(node).toBeInViewport({ ratio: 0.99 });
  const id = node.locator(".station-id");
  await expect.poll(async () => (await id.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(10);
  await node.tap();
  await expect(page.locator(".panel")).toContainText("Graph issue 35");
});

test("a tap near the track shows its note and a pane tap clears it", async ({ page, hasTouch }) => {
  test.skip(!hasTouch);
  await expect(station(page, 35)).toBeInViewport({ ratio: 1 });
  await expect(station(page, 36)).toBeInViewport({ ratio: 1 });
  const track = page.getByRole("img", { name: "WG-36 waits on WG-35", exact: true }).locator("path.react-flow__edge-path");
  const point = await track.evaluate((path: SVGPathElement) => {
    const at = path.getPointAtLength(path.getTotalLength() / 2).matrixTransform(path.getScreenCTM()!);
    return { x: at.x + 11, y: at.y };
  });
  await page.touchscreen.tap(point.x + 3, point.y);
  await expect(page.locator(".track-note")).toHaveCount(0);
  await page.touchscreen.tap(point.x, point.y);
  await expect(page.locator(".track-note")).toContainText(/WG-36\s*waits on\s*WG-35/);
  const pane = (await page.locator(".react-flow").boundingBox())!;
  await page.touchscreen.tap(pane.x + 8, pane.y + 18);
  await expect(page.locator(".track-note")).toHaveCount(0);
});

test("turning the window keeps the graph centre", async ({ page, hasTouch }) => {
  test.skip(!hasTouch);
  await expect(station(page, 35)).toBeInViewport({ ratio: 1 });
  const before = await centre(page);
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: size.height, height: size.width });
  await expect.poll(async () => {
    const after = await centre(page);
    return Math.hypot(after.x - before.x, after.y - before.y);
  }).toBeLessThan(1);
  expect((await centre(page)).zoom).toBeCloseTo(before.zoom, 4);
});

test("the controls and key use the layout for the current input", async ({ page, hasTouch }) => {
  const controls = page.locator(".react-flow__controls button");
  await expect(controls).toHaveCount(3);
  for (const button of await controls.all()) {
    const size = (await button.boundingBox())!;
    if (hasTouch) {
      expect(size.width).toBeGreaterThanOrEqual(44);
      expect(size.height).toBeGreaterThanOrEqual(44);
    } else {
      expect(size.width).toBeLessThan(44);
      expect(size.height).toBeLessThan(44);
    }
  }
  if (hasTouch) {
    const pane = (await page.locator(".react-flow").boundingBox())!;
    const fit = (await page.getByRole("button", { name: "Fit View" }).boundingBox())!;
    expect(pane.y + pane.height - fit.y - fit.height).toBeGreaterThanOrEqual(12);
    expect(fit.x + fit.width).toBeLessThan(pane.x + pane.width / 3);
    const key = page.getByRole("button", { name: "Key", exact: true });
    expect((await key.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await key.tap();
    const sheet = page.getByRole("dialog", { name: "Graph key" });
    await expect(sheet).toContainText("An arrow points from a blocker to the issue that waits on it.");
    await expect(sheet).toContainText("pulsing lamp: worker running");
    await sheet.getByRole("button", { name: "Close" }).click();
    await expect(sheet).toBeHidden();
    await page.getByRole("button", { name: "Fit View" }).tap();
    await expect(station(page, 21)).toBeInViewport({ ratio: 0.99 });
  } else {
    await page.locator(".key summary").click();
    await expect(page.locator(".key details[open] .key-body")).toContainText("waits on blocker");
    await page.locator(".key summary").click();
    await expect(station(page, 35)).toBeInViewport({ ratio: 0.99 });
    await station(page, 35).click();
    await expect(page.locator(".panel")).toContainText("Graph issue 35");
  }
});

for (const [width, height] of [[768, 1024], [1024, 768]]) {
  test(`the canvas and controls fit at ${width}px`, async ({ page }, info) => {
    test.skip(info.project.name !== "tablet-820x1180");
    await page.setViewportSize({ width, height });
    const pane = (await page.locator(".react-flow").boundingBox())!;
    const fit = (await page.getByRole("button", { name: "Fit View" }).boundingBox())!;
    expect(pane.x + pane.width).toBeLessThanOrEqual(width);
    expect(fit.y + fit.height).toBeLessThanOrEqual(height - 12);
    expect(fit.width).toBeGreaterThanOrEqual(44);
  });
}
