import { expect, type Locator } from "@playwright/test";
import type { Agents, Presence } from "../src/lib/link.ts";
import type { ServerStatus } from "../src/lib/types.ts";
import type { OverviewData } from "../src/lib/overview.ts";
import { screens, test } from "./support/screens.ts";

async function bounds(locator: Locator) {
  await expect(locator).toBeVisible();
  return (await locator.boundingBox())!;
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/status", async (route) => {
    const response = await route.fetch();
    const data: ServerStatus = await response.json();
    Object.assign(data.workspaces[0], { requestsRemaining: 12, requestsLimit: 5000 });
    await route.fulfill({ response, json: data });
  });
  await page.route("**/api/overview*", async (route) => {
    const response = await route.fetch();
    const data: OverviewData = await response.json();
    const project = data.projects.find(({ id }) => id === "fixture")!;
    project.initiative = "Example initiative";
    data.workspaces.push({ ...data.workspaces[0], id: "other", name: "Other workspace" });
    data.projects.push({ ...project, id: "closed", statusType: "completed" });
    const summary = data.summaries.find(({ id }) => id === project.id)!;
    summary.you = [{
      identifier: "WG-42", title: "Check the draft", why: "Review the changes", idle: false, updatedAt: "",
      pullRequests: [{ number: 42, url: "https://example.com/pull/42", reviewUrl: "https://example.com/review/42", title: "Check the draft", status: "open" }],
    }];
    await route.fulfill({ response, json: data });
  });
});

test("overview controls fit the screen and show their details", async ({ page }, testInfo) => {
  const desktop = testInfo.project.name.startsWith("desktop");
  const phone = testInfo.project.name.startsWith("phone");
  const now = new Date().toISOString();
  const presence: Presence = { queued: 0, coordinators: [{
    session: "session", host: "example.com", plan: "example", connected: true,
    mode: "waiting", head: null, since: now, lastSeen: now, paused: false,
  }] };
  const agents: Agents = { at: now, agents: [{
    id: "agent", role: "worker", key: "example", issue: "WG-5", agent: "worker",
    state: "working", title: "Check build output", said: "Build started", at: now,
  }] };
  await page.routeWebSocket(/\/api\/link\?role=page$/, (socket) => {
    const project = { workspace: "default", id: "fixture" };
    socket.send(JSON.stringify({ type: "presence", project, payload: presence }));
    socket.send(JSON.stringify({ type: "agents", project, payload: agents }));
  });
  await screens.overview(page);
  const overview = page.locator(".overview");
  const row = overview.locator(".ov-row").filter({ has: page.getByText("Example project", { exact: true }) });
  const open = row.locator(".ov-open");
  const copy = row.getByRole("button", { name: "Copy the project name" });
  const github = overview.getByRole("link", { name: "GitHub" });
  const linear = overview.getByRole("link", { name: "Linear" });
  const find = overview.getByRole("searchbox");
  const filters = overview.locator(".ov-filters");
  const stage = page.locator(".stage");

  for (const width of new Set([page.viewportSize()!.width, ...(phone || desktop ? [] : [768, 1024])])) {
    await page.setViewportSize({ width, height: page.viewportSize()!.height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(await stage.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    const columns = await open.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
    expect(columns).toBe(phone ? 1 : 3);
    if (!desktop) {
      for (const control of [open, copy, github, linear, find, ...await filters.getByRole("button").all()]) {
        const size = await bounds(control);
        expect(size.width).toBeGreaterThanOrEqual(44);
        expect(size.height).toBeGreaterThanOrEqual(44);
      }
      const left = await bounds(github);
      expect((await bounds(linear)).x - (left.x + left.width)).toBeGreaterThanOrEqual(8);
      await expect(copy).toHaveCSS("opacity", "1");
      await expect(find).toHaveCSS("font-size", "16px");
      expect((await bounds(find)).width).toBeCloseTo((await bounds(filters)).width, 0);
    }
  }

  if (desktop) {
    await expect(copy).toHaveCSS("opacity", "0");
    await open.hover();
    await expect(copy).toHaveCSS("opacity", "1");
    expect((await bounds(github)).height).toBeLessThan(44);
  } else {
    const coordinator = row.getByLabel("Coordinator");
    await expect(coordinator).toHaveText("Listening");
    await expect(coordinator.locator(".lamp")).toBeVisible();
    const projectDetails = row.getByRole("button", { name: "Project details" });
    await projectDetails.tap();
    const detail = row.locator(".hint-popover:popover-open");
    await expect(detail).toContainText("Example project");
    await expect(detail).toContainText("Triage · 1");
    await projectDetails.tap();
    await row.getByText("Build started", { exact: true }).first().tap();
    await expect(row.getByText("Check build output", { exact: true })).toBeVisible();
    await overview.getByRole("button", { name: "Linear budget details" }).tap();
    await expect(overview.locator(".hint-popover:popover-open")).toContainText("12 of 5000");
  }
});

test("a picker sheet keeps arrow keys out of the overview", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("phone"), "Requires a touch phone");
  await screens.overview(page);
  const overview = page.locator(".overview");
  const active = overview.locator(".ov-row.is-active");
  const initial = await active.locator(".ov-title").textContent();
  await overview.getByRole("button", { name: "All initiatives" }).tap();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(active.locator(".ov-title")).toHaveText(initial!);
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).tap();
  await page.keyboard.press("ArrowDown");
  await expect(active.locator(".ov-title")).not.toHaveText(initial!);
});

test("a pull from the top refreshes the installed overview", async ({ page, context }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("phone"), "Requires a touch phone");
  await page.setViewportSize({ width: page.viewportSize()!.width, height: 520 });
  await page.addInitScript(() => Object.defineProperty(navigator, "standalone", { value: true }));
  await screens.overview(page);
  const stage = page.locator(".stage");
  const client = await context.newCDPSession(page);
  const { x, y } = await bounds(stage);
  const point = { x: Math.round(x + 50), y: Math.round(y + 24) };
  const touch = async (type: "touchStart" | "touchMove" | "touchEnd", dy = 0) => {
    await client.send("Input.dispatchTouchEvent", {
      type, touchPoints: type === "touchEnd" ? [] : [{ ...point, y: point.y + dy }],
    });
  };

  let navigations = 0;
  page.on("domcontentloaded", () => { navigations++; });
  await stage.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  expect(await stage.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await touch("touchStart");
  await touch("touchMove", 120);
  await touch("touchEnd");
  await stage.evaluate((el) => { el.scrollTop = 0; });
  expect(navigations).toBe(0);

  await touch("touchStart");
  for (const dy of [20, 60, 120]) await touch("touchMove", dy);
  await Promise.all([page.waitForEvent("domcontentloaded"), touch("touchEnd")]);
  await expect(page.locator(".overview .ov-title").getByText("Example project", { exact: true })).toBeVisible();
});
