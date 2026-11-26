import { expect, type Page } from "@playwright/test";
import type { GraphData } from "../src/lib/types.ts";
import { projectPath, test } from "./support/screens.ts";

test.use({ reducedMotion: "reduce" });

async function openPanel(page: Page, issue: string, path = "/?project=panel") {
  await page.goto(`${path}&issue=WG-${issue}`);
  const panel = page.locator(".panel");
  await expect(panel.getByRole("link", { name: `Open WG-${issue} in Linear` })).toBeVisible();
  return panel;
}

async function addActions(page: Page) {
  await page.route("**/api/projects/panel/graph*", async (route) => {
    const response = await route.fetch();
    if (response.status() !== 200) return route.fulfill({ response });
    const graph: GraphData = await response.json();
    graph.labels.push({ id: "reviewed", name: "reviewed", color: "#4466aa", group: null });
    graph.issues.find(({ id }) => id === "panel-task")!.pullRequests = [{
      number: 42, url: "https://example.com/pull/42", title: "Check the result",
      status: "open", reviewUrl: "https://example.com/review/42",
    }];
    await route.fulfill({ response, json: graph });
  });
  const at = new Date().toISOString();
  await page.routeWebSocket(/\/api\/link\?/, (socket) => {
    const url = new URL(socket.url());
    if (url.searchParams.get("project") !== "panel") return;
    const project = { workspace: "default", id: "panel" };
    socket.send(JSON.stringify({ type: "presence", project, payload: { coordinators: [
      { connected: true, mode: "waiting", lastSeen: at, host: "example.com", plan: "example" },
    ], queued: 0 } }));
    socket.send(JSON.stringify({ type: "agents", project, payload: { at, agents: [
      { id: "worker", role: "worker", key: "panel-task", issue: "WG-14",
        agent: "Worker", state: "running", title: "", said: "", at },
    ] } }));
    socket.send(JSON.stringify({ type: "asks", project, payload: { asks: [
      { id: "question", key: "panel-task", issue: "WG-14", at, body: "What did you find?" },
    ] } }));
  });
}

test("the panel keeps issue actions within reach", async ({ page }, testInfo) => {
  await addActions(page);
  const panel = await openPanel(page, "14");
  await expect(panel.getByText("Agent in Orca:")).toBeVisible();
  await expect(panel.getByRole("button", { name: "About the agent" })).toHaveCount(0);
  const actions = panel.locator(".panel-actions");
  const phone = testInfo.project.name.startsWith("phone-");
  if (phone) {
    await expect(actions.getByRole("button")).toHaveText(["Dispatch", "Mark reviewed", "More"]);
    const beforeScroll = await actions.boundingBox();
    const viewSwitch = page.getByRole("group", { name: "Project view" });
    await expect(viewSwitch).toBeVisible();
    expect(beforeScroll!.y + beforeScroll!.height).toBeCloseTo((await viewSwitch.boundingBox())!.y, 0);
    await panel.locator(".panel-body").evaluate((element) => { element.scrollTop = element.scrollHeight; });
    expect(await actions.boundingBox()).toEqual(beforeScroll);
    for (const button of await actions.getByRole("button").all()) {
      const size = (await button.boundingBox())!;
      expect(size.width).toBeGreaterThanOrEqual(44);
      expect(size.height).toBeGreaterThanOrEqual(44);
    }
    await actions.getByRole("button", { name: "More" }).tap();
    const more = page.getByRole("dialog", { name: "More issue actions" });
    await expect(more.getByRole("link", { name: /GitHub/ })).toHaveAttribute("href", "https://example.com/pull/42");
    await expect(more.getByRole("link", { name: /Linear review/ })).toHaveAttribute("href", "https://example.com/review/42");
    await expect(more.locator(".pr-links [title]")).toHaveCount(0);
    await more.getByRole("button", { name: "About the GitHub link" }).tap();
    await expect(more.getByRole("tooltip")).toHaveText("Open #42 in GitHub");
    await expect(more.getByText("Check the result")).toBeVisible();
    await more.getByRole("button", { name: "Answer" }).tap();
    await expect(more).toBeHidden();
    await expect(panel.getByRole("textbox", { name: "Reply to the worker" })).toBeFocused();

    const command = page.waitForRequest("**/api/projects/panel/commands*");
    await page.route("**/api/projects/panel/commands*", (route) => route.fulfill({ json: { ok: true, queued: 0 } }));
    await actions.getByRole("button", { name: "Dispatch", exact: true }).tap();
    expect((await command).postDataJSON()).toEqual({ name: "dispatch", key: "panel-task", issue: "WG-14" });
  } else {
    await expect(actions).toHaveCount(0);
    await expect(panel.locator(".next-action").getByRole("button", { name: "Dispatch", exact: true })).toBeVisible();
    await expect(panel.locator(".review-row").getByRole("button", { name: "Mark reviewed", exact: true })).toBeVisible();
    await expect(panel.locator(".fields").getByRole("link", { name: /GitHub/ })).toBeVisible();
    expect((await panel.boundingBox())!.width).toBeLessThan(page.viewportSize()!.width);
    if (testInfo.project.name.startsWith("desktop-")) {
      await expect(panel).toHaveCSS("width", "460px");
      await expect(panel.locator(".fields-wg")).toHaveCSS("grid-template-columns", /^\S+px \S+px$/);
    }
  }
});

test("record evidence opens the existing completion form", async ({ page }, testInfo) => {
  const panel = await openPanel(page, "15");
  const shortcut = panel.getByRole("button", { name: "Record evidence" });
  if (testInfo.project.name.startsWith("phone-")) {
    await shortcut.tap();
  } else {
    await expect(shortcut).toHaveCount(0);
    await panel.locator(".fields .picker-trigger").first().click();
    await page.getByRole("option", { name: "Done", exact: true }).click();
  }
  await expect(panel.getByRole("textbox", { name: "The evidence for WG-15" })).toBeFocused();
  const move = panel.getByRole("button", { name: "Move to Done" });
  await expect(move).toBeDisabled();
  await panel.getByRole("textbox", { name: "The evidence for WG-15" }).fill("The check passed.");
  await expect(move).toBeEnabled();
});

test("panel fields, station details, links and Markdown fit the screen", async ({ page }, testInfo) => {
  const desktop = testInfo.project.name.startsWith("desktop-");
  await page.route("**/api/config", (route) => route.fulfill({
    json: { human: "Ada", defaultWorkspace: "default", signIn: "linear", user: "ada" },
  }));
  await page.route("**/api/account", (route) => route.fulfill({
    json: { human: "Ada", connections: [], tokens: [], onboarding: { skipped: true } },
  }));
  await page.route("**/api/projects/panel/graph*", async (route) => {
    const response = await route.fetch();
    if (response.status() !== 200) return route.fulfill({ response });
    const graph: GraphData = await response.json();
    await route.fulfill({ response, json: { ...graph, workspace: "default", waitNames: ["Ada"] } });
  });
  await page.route("**/api/projects/panel/claims*", (route) => route.fulfill({ json: {
    role: "owner",
    claims: [{ node: "panel-task", holder: "Ada", job: "build", claimedAt: "2026-01-01T00:00:00Z",
      renewedAt: "2026-01-01T00:00:00Z", leaseUntil: "2099-01-01T00:00:00Z", stale: false }],
  } }));
  const panel = await openPanel(page, "14");
  await expect(panel.getByText("In the current wave.")).toBeVisible();
  await expect(panel.locator("time[datetime='2099-01-01T00:00:00Z']")).toBeVisible();
  await expect(panel.locator(".chip-claim")).toHaveText("agent:worker");
  await expect(panel.getByText(/Runner: Ada · build · since/)).toBeVisible();
  await expect(panel.locator(".fields-wg")).toContainText("build");
  const blocker = panel.getByRole("button", { name: /WG-13 Blocker/ });
  await expect(blocker).toBeVisible();

  if (!desktop) {
    const body = panel.locator(".panel-body");
    const viewport = page.viewportSize()!;
    const widths = viewport.width === 820 ? [768, 820] : viewport.width === 1180 ? [1024, 1180] : [viewport.width];
    for (const width of widths) {
      await page.setViewportSize({ ...viewport, width });
      expect(await body.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(
        await body.evaluate((element) => element.clientWidth),
      );
      for (const value of await panel.getByText(/^(cd\/long-value|do dispatch long-value)/).all()) {
        await expect(value).toHaveCSS("overflow-wrap", "anywhere");
        expect(await value.evaluate((element) => element.scrollHeight)).toBeGreaterThan(20);
      }
      for (const scroller of await panel.locator(".rich pre, .rich table").all()) {
        expect(await scroller.evaluate((element) => element.scrollWidth)).toBeGreaterThan(
          await scroller.evaluate((element) => element.clientWidth),
        );
        await scroller.evaluate((element) => { element.scrollLeft = 50; });
        expect(await scroller.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
      }
    }
    await expect(panel.locator(".rich table")).toHaveCount(2);
    await expect(panel.locator(".rich pre")).toHaveCount(2);
    for (const field of await panel.locator(".fields > dd, .fields-wg > div").all()) {
      expect((await field.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    expect((await blocker.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const hint = panel.getByRole("button", { name: "About the issue title" });
    await hint.tap();
    await expect(panel.getByRole("tooltip").filter({ hasText: "plan.json has the title" })).toBeVisible();
    await expect(panel.getByRole("textbox", { name: "Issue title" })).toHaveCSS("font-size", "16px");
  }

  await blocker.click();
  await expect(panel.getByRole("link", { name: "Open WG-13 in Linear" })).toBeVisible();
});

test("panel pickers name the field on phones", async ({ page }, testInfo) => {
  const panel = await openPanel(page, "14");
  const phone = testInfo.project.name.startsWith("phone-");
  const triggers = panel.locator(".fields > dd .picker-trigger");
  for (const [index, name] of ["Status", "Priority", "Assignee", "Labels"].entries()) {
    const trigger = triggers.nth(index);
    await trigger.click();
    if (phone) {
      const sheet = page.getByRole("dialog", { name, exact: true });
      await expect(sheet).toBeVisible();
      await expect(sheet.getByRole("textbox", { name: "Filter" })).toHaveCSS("font-size", "16px");
      await sheet.getByRole("button", { name: "Close", exact: true }).tap();
    } else {
      await expect(panel.getByRole("listbox")).toBeVisible();
      await trigger.click();
      await expect(panel.getByRole("listbox")).toBeHidden();
    }
  }
});

test("the title hint preserves desktop panel boxes", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("desktop-"), "Requires a mouse");
  const panel = await openPanel(page, "1", projectPath);
  await expect(panel.getByText("No comments.")).toBeVisible();
  const { withHint, withoutHint } = await panel.locator(".panel-title-hint").evaluate((hint) => {
    const title = hint.firstElementChild!;
    const body = hint.parentElement!;
    const boxes = () => [title, ...body.querySelectorAll(".fields, .wg"), body]
      .map((element) => element.getBoundingClientRect().toJSON());
    const withHint = boxes();
    hint.replaceWith(title);
    const withoutHint = boxes();
    title.replaceWith(hint);
    hint.append(title);
    return { withHint, withoutHint };
  });
  expect(withHint).toEqual(withoutHint);
});
