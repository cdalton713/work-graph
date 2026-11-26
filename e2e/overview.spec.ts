import { expect, type CDPSession, type Locator } from "@playwright/test";
import type { Agents, Ask, Presence } from "../src/lib/link.ts";
import type { ServerStatus } from "../src/lib/types.ts";
import type { OverviewData } from "../src/lib/overview.ts";
import { screens, test } from "./support/screens.ts";

async function bounds(locator: Locator) {
  await expect(locator).toBeVisible();
  return (await locator.boundingBox())!;
}

const issueTitle = "Check the draft and record all questions about the example project before the next review. " +
  "Include the open questions for each project and check whether any of the issues still need a decision.";

async function pull(client: CDPSession, x: number, y: number, beforeRelease?: () => Promise<unknown>) {
  const touchPoints = [{ x: Math.round(x), y: Math.round(y) }];
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints });
  for (const dy of [20, 60, 120]) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove", touchPoints: [{ ...touchPoints[0], y: touchPoints[0].y + dy }],
    });
  }
  await Promise.all([beforeRelease?.(), client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })]);
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
    project.workspaceName = "Build workspace";
    data.workspaces[0].name = "Build workspace";
    data.workspaces.push({ ...data.workspaces[0], id: "other", name: "Other workspace" });
    data.projects.push({ ...project, id: "closed", statusType: "completed" });
    const summary = data.summaries.find(({ id }) => id === project.id)!;
    summary.you = [{
      identifier: "WG-42", title: issueTitle, why: "Review the changes", idle: false, updatedAt: "",
      pullRequests: [{ number: 42, url: "https://example.com/pull/42", reviewUrl: "https://example.com/review/42", title: "Check the draft", status: "open" }],
    }];
    await route.fulfill({ response, json: data });
  });
});

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
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

  const reason = row.locator(".ov-reason");
  const inboxTitle = overview.locator(".inbox-title");
  const isCut = (el: Element) => el.scrollWidth > el.clientWidth;
  await expect.poll(() => reason.evaluate(isCut)).toBe(true);

  if (desktop) {
    await expect(copy).toHaveCSS("opacity", "0");
    await open.hover();
    await expect(copy).toHaveCSS("opacity", "1");
    expect((await bounds(github)).height).toBeLessThan(44);
    expect(await inboxTitle.evaluate(isCut)).toBe(true);
    await expect(reason).toHaveAttribute("title", await reason.textContent() ?? "");
    await expect(row.locator(".ov-track i").first()).toHaveAttribute("title", "Triage · 1");
    await expect(overview.locator(".inbox-open")).toHaveAttribute("title", `Build workspace · Example project: ${issueTitle}`);
    await expect(overview.getByRole("button", { name: "All initiatives" })).toHaveAttribute("title", "Show one initiative");
    await expect(overview.getByTitle("Also show the completed and canceled projects.")).toBeVisible();
    await expect(overview.getByRole("region", { name: "Example initiative" }).getByTitle("Show only this initiative")).toBeVisible();
    await page.setViewportSize({ width: 860, height: page.viewportSize()!.height });
    await expect(inboxTitle).toBeHidden();
    await expect(overview.locator(".inbox-open")).toHaveAttribute("title", `Build workspace · Example project: ${issueTitle}`);
  } else {
    const coordinator = row.getByLabel("Coordinator");
    await expect(coordinator).toHaveText("Listening");
    await expect(coordinator.locator(".lamp")).toBeVisible();
    await expect(overview.locator(".ov-row").filter({ hasText: "Planned project" }).getByLabel("Coordinator")).toHaveText("None");
    const projectDetails = row.getByRole("button", { name: "Project details" });
    await projectDetails.tap();
    const detail = row.locator(".hint-popover:popover-open");
    await expect(detail).toContainText("Example project");
    await expect(detail).toContainText((await reason.textContent())!);
    expect(await inboxTitle.evaluate(isCut)).toBe(false);
    await expect(inboxTitle).toHaveText(issueTitle);
    await expect(detail).toContainText("Triage · 1");
    await projectDetails.tap();
    await expect(row.getByText("Build started", { exact: true }).first()).toBeHidden();
    const agents = row.getByText("1 agent", { exact: true });
    expect((await bounds(agents)).height).toBeGreaterThanOrEqual(44);
    await agents.tap();
    await row.getByText("Build started", { exact: true }).first().tap();
    await expect(row.getByText("Check build output", { exact: true })).toBeVisible();
    await overview.getByRole("button", { name: "Linear budget details" }).tap();
    await expect(overview.locator(".hint-popover:popover-open")).toContainText("12 of 5000");
    await overview.getByRole("button", { name: "Linear budget details" }).tap();
    await overview.getByRole("button", { name: "About closed projects" }).tap();
    await expect(overview.locator(".hint-popover:popover-open")).toHaveText("Also show the completed and canceled projects.");
    await overview.getByRole("button", { name: "About closed projects" }).tap();
    await overview.getByRole("button", { name: "About this initiative filter" }).first().tap();
    await expect(overview.locator(".hint-popover:popover-open")).toHaveText("Show only this initiative");
  }
});

test("a picker sheet keeps arrow keys out of the overview", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("phone"), "Requires a touch phone");
  await screens.overview(page);
  const overview = page.locator(".overview");
  const active = overview.locator(".ov-row.is-active");
  const initial = await active.locator(".ov-title").textContent();
  await overview.getByRole("button", { name: "All initiatives" }).tap();
  await expect(page.getByRole("dialog").getByText("Show one initiative")).toBeVisible();
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
  await expect(page.getByText(/12 Linear requests left/)).toBeVisible();
  let navigations = 0;
  page.on("domcontentloaded", () => { navigations++; });
  await stage.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  expect(await stage.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await pull(client, x + 50, y + 24);
  await stage.evaluate((el) => { el.scrollTop = 0; });
  expect(navigations).toBe(0);

  await pull(client, x + 50, y + 24, () => page.waitForEvent("domcontentloaded"));
  await expect(page.getByText(/12 Linear requests left/)).toBeVisible();
  await expect(page.locator(".overview .ov-title").getByText("Example project", { exact: true })).toBeVisible();
});

test("a pull keeps the unsent inbox reply", async ({ page, context }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("phone"), "Requires a touch phone");
  await page.addInitScript(() => Object.defineProperty(navigator, "standalone", { value: true }));
  const ask: Ask = { id: "example-ask", from: "worker", key: null, issue: null, body: "Can the draft go ahead?", at: new Date().toISOString() };
  await page.routeWebSocket(/\/api\/link\?role=page$/, (socket) => {
    socket.send(JSON.stringify({
      type: "asks", project: { workspace: "default", id: "fixture" }, payload: { asks: [ask] },
    }));
  });
  await screens.overview(page);
  await page.locator(".inbox").getByRole("button", { name: /Can the draft go ahead/ }).tap();
  const reply = page.getByRole("textbox", { name: "Reply to the worker" });
  const draft = "Check the evidence first.\n".repeat(20);
  await reply.fill(draft);
  const stage = page.locator(".stage");
  await stage.evaluate((el) => { el.scrollTop = 0; });
  const client = await context.newCDPSession(page);
  const field = await bounds(reply);
  const top = await bounds(stage);
  expect(await reply.evaluate((el, point) => document.elementFromPoint(point.x, point.y) === el,
    { x: field.x + 20, y: field.y + 20 })).toBe(true);
  let navigations = 0;
  page.on("domcontentloaded", () => { navigations++; });
  await pull(client, field.x + 20, field.y + 20);
  await expect(reply).toHaveValue(draft);
  await stage.evaluate((el) => { el.scrollTop = 0; });
  await pull(client, top.x + 50, top.y + 24);
  await expect(reply).toHaveValue(draft);
  expect(navigations).toBe(0);
});

test("the inbox keeps questions in scope while searching projects", async ({ page }) => {
  const now = new Date();
  const old = new Date(now.getTime() - 30 * 60_000).toISOString();
  const ask: Ask = { id: "example-ask", from: "worker", key: null, issue: null, body: "Can the draft go ahead?", at: old };
  await page.route("**/api/overview*", async (route) => {
    const response = await route.fetch();
    const data: OverviewData = await response.json();
    const project = data.projects.find(({ id }) => id === "fixture")!;
    const summary = data.summaries.find(({ id }) => id === project.id)!;
    for (const item of data.summaries) item.you = [];
    const extras = Array.from({ length: 10 }, (_, index) => ({ ...project, id: `extra-${index}`, name: `Extra project ${index}` }));
    data.projects.push(...extras);
    data.summaries.push(...extras.map(({ id }) => ({ ...summary, id, you: [], updatedAt: old })));
    const stalled = data.summaries.find(({ id }) => id === "extra-0")!;
    stalled.liveJobs = [{ identifier: "WG-90", title: "Check build", state: "running", startedAt: old }];
    const action = data.summaries.find(({ id }) => id === "extra-1")!;
    action.you = [{ identifier: "WG-91", title: "Merge the change", why: "Merge the change", idle: false, updatedAt: old, pullRequests: [] }];
    const question = data.summaries.find(({ id }) => id === "extra-2")!;
    question.you = [{ identifier: "WG-92", title: "Choose a release", why: "Choose a release", idle: true, updatedAt: old, pullRequests: [], answer: { issueId: "release", sent: false } }];
    await route.fulfill({ response, json: data });
  });
  await page.routeWebSocket(/\/api\/link\?role=page$/, (socket) => {
    const send = (type: string, id: string, payload: unknown) =>
      socket.send(JSON.stringify({ type, project: { workspace: "default", id }, payload }));
    send("asks", "fixture", { asks: [ask] });
    send("presence", "extra-0", { queued: 0, coordinators: [] });
    send("agents", "extra-3", { at: now.toISOString(), agents: [{
      id: "prompt", role: "worker", key: "example", issue: "WG-93", agent: "worker",
      state: "waiting", title: "Waiting for a decision", said: "Which build?", at: now.toISOString(),
    }] });
  });
  await page.route("**/api/projects/*/asks/*/reply", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    expect(route.request().postDataJSON()).toEqual({ body: "Go ahead with the draft." });
    await route.fulfill({ json: { ok: true, recorded: true } });
  });
  await page.route("**/api/issues/release/comments", async (route) => {
    const comment = { id: "release-comment", createdAt: old, body: "Which release should ship?" };
    if (route.request().method() === "GET") await route.fulfill({ json: [comment] });
    else {
      expect(route.request().postDataJSON()).toEqual({ body: "Ship the first release." });
      await route.fulfill({ json: { ...comment, answered: true } });
    }
  });
  await screens.overview(page);
  const inbox = page.locator(".inbox");
  const filters = inbox.getByRole("group", { name: "Inbox category" });
  const questions = filters.getByRole("button", { name: "Questions 3" });
  const stalls = filters.getByRole("button", { name: "Possible stalls 2" });
  const actions = filters.getByRole("button", { name: "Other actions 1" });
  await expect(inbox.locator(".inbox-open").first()).toContainText(/No agent view|No coordinator/);
  await page.getByRole("searchbox").fill("Extra project 9");
  await expect(page.locator(".ov-row")).toHaveCount(1);
  await expect(page.locator(".ov-row")).toContainText(/Last activity.*30 min ago/);
  await questions.click();
  await expect(inbox.getByText("Which build?")).toBeVisible();
  await expect(inbox.getByText("WG-92")).toBeVisible();
  const visibleRows = inbox.locator(".inbox-row:not([hidden]) .inbox-open");
  await visibleRows.first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(visibleRows.nth(1)).toBeFocused();
  await inbox.getByRole("button", { name: /Can the draft go ahead/ }).click();
  const reply = inbox.getByRole("textbox", { name: "Reply to the worker" });
  await reply.fill("Go ahead with the draft.");
  await stalls.click();
  await expect(inbox.getByText("No coordinator", { exact: true })).toBeVisible();
  await expect(reply).toBeHidden();
  await actions.click();
  await expect(inbox.getByText("Merge the change", { exact: true })).toBeVisible();
  await questions.click();
  await expect(reply).toHaveValue("Go ahead with the draft.");
  await reply.press("Control+Enter");
  await expect(inbox.getByRole("status").filter({ hasText: "sent" })).toBeVisible();

  await inbox.getByRole("button", { name: /WG-92/ }).click();
  await expect(inbox.getByText("Which release should ship?")).toBeVisible();
  await inbox.getByRole("textbox", { name: "Send answer" }).fill("Ship the first release.");
  await inbox.getByRole("button", { name: "Send answer" }).click();
  await expect(inbox.locator(".inbox-row").filter({ hasText: "WG-92" }).getByRole("status")).toHaveText("sent");
});

test("incomplete summaries cannot give an all-clear headline", async ({ page }) => {
  await page.route("**/api/overview*", async (route) => {
    const response = await route.fetch();
    const data: OverviewData = await response.json();
    const summary = data.summaries.find(({ id }) => id === "fixture")!;
    summary.you = [];
    summary.error = "The project could not load";
    data.summaries = [summary];
    await route.fulfill({ response, json: data });
  });
  await screens.overview(page);
  await expect(page.locator(".ov-sum")).toContainText("Project data incomplete");
  await page.getByRole("button", { name: "Questions 0" }).click();
  await expect(page.getByText(/No questions in this scope/)).toBeVisible();
});

test("collapsed agents keep their inline reply and delivery receipt", async ({ page }) => {
  const at = new Date().toISOString();
  const project = { workspace: "default", id: "fixture" };
  const report: Agents = { at, replies: true, agents: [{
    id: "finished-agent", role: "worker", key: "finished", issue: "WG-5", agent: "worker",
    state: "done", title: "Check build output", said: "Build complete", at,
  }] };
  await page.routeWebSocket(/\/api\/link\?role=page$/, (socket) => {
    socket.send(JSON.stringify({ type: "agents", project, payload: report }));
  });
  await page.routeWebSocket(/\/api\/link\?role=page&workspace=default&project=fixture$/, (socket) => {
    socket.send(JSON.stringify({ type: "agent-reply-result", project, payload: {
      id: "reply-id", agent: "finished-agent", status: "delivered", messageId: "message-id",
    } }));
  });
  await page.route("**/api/projects/fixture/agents/finished-agent/reply", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ body: "Check the release build." });
    await route.fulfill({ json: { id: "reply-id" } });
  });
  await screens.overview(page);
  const agentGroup = page.locator(".ov-agent-group");
  const disclosure = agentGroup.getByText("1 agent", { exact: true });
  const reply = agentGroup.getByRole("textbox", { name: "Reply to the agent" });
  await expect(reply).toBeHidden();
  await disclosure.press("Enter");
  await agentGroup.locator(".ov-agent > summary").press("Enter");
  await reply.fill("Check the release build.");
  await agentGroup.getByRole("button", { name: "Reply to the agent" }).click();
  await expect(agentGroup.getByRole("status")).toHaveText("delivered");
  await disclosure.click();
  await expect(agentGroup.getByRole("status")).toBeHidden();
  await disclosure.click();
  await expect(agentGroup.getByRole("status")).toHaveText("delivered");
});

test("questions use prompt age and identify the workspace before sending", async ({ page }) => {
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const issueMove = (identifier: string, updatedAt: string) => ({
    identifier, updatedAt, title: "Choose a release", why: "Choose a release", idle: true, blocks: 1,
    pullRequests: [], answer: { issueId: identifier, sent: false },
  });
  await page.route("**/api/overview*", async (route) => {
    const response = await route.fetch();
    const data: OverviewData = await response.json();
    const project = data.projects.find(({ id }) => id === "fixture")!;
    const summary = data.summaries.find(({ id }) => id === project.id)!;
    data.workspaces[0].name = "Build workspace";
    data.workspaces.push({ ...data.workspaces[0], id: "release", name: "Release workspace" });
    project.workspaceName = "Build workspace";
    data.projects = [project, { ...project, workspace: "release", workspaceName: "Release workspace" }];
    summary.you = [issueMove("WG-11", minutesAgo(60)), issueMove("WG-12", minutesAgo(10))];
    data.summaries = [summary, { ...summary, workspace: "release", you: [] }];
    await route.fulfill({ response, json: data });
  });
  await page.routeWebSocket(/\/api\/link\?role=page$/, (socket) => {
    const send = (type: string, workspace: string, payload: unknown) =>
      socket.send(JSON.stringify({ type, project: { workspace, id: "fixture" }, payload }));
    const ask: Ask = { id: "same-ask", from: "worker", key: null, issue: null, body: "Can the draft go ahead?", at: minutesAgo(1) };
    send("asks", "default", { asks: [ask] });
    send("asks", "release", { asks: [ask] });
    send("agents", "default", { at: minutesAgo(0), agents: [
      { id: "newer", issue: "WG-11", at: minutesAgo(5) },
      { id: "older", issue: "WG-12", at: minutesAgo(25) },
    ].map((agent) => ({ ...agent, role: "worker", agent: "worker", state: "waiting", title: "Choose a release", said: "Which build?" })) });
  });
  await page.route("**/api/projects/fixture/asks/same-ask/reply", async (route) => {
    expect(route.request().headers()["x-workspace"]).toBe("release");
    expect(route.request().postDataJSON()).toEqual({ body: "Go ahead." });
    await route.fulfill({ json: { ok: true, recorded: true } });
  });
  await page.goto("/");
  const inbox = page.getByRole("region", { name: "Inbox" });
  await inbox.getByRole("button", { name: "Questions 4" }).click();
  const promptRows = inbox.getByRole("button", { name: /WG-1[12]/ });
  await expect(promptRows.nth(0)).toHaveAccessibleName(/WG-12.*25 min ago/);
  await expect(promptRows.nth(1)).toHaveAccessibleName(/WG-11.*5 min ago/);

  await expect(inbox.getByRole("button", { name: /Can the draft go ahead.*Example project.*Build workspace/ })).toBeVisible();
  const releaseQuestion = inbox.getByRole("button", { name: /Can the draft go ahead.*Example project.*Release workspace/ });
  await releaseQuestion.click();
  const detail = inbox.locator(".inbox-detail:not([hidden])");
  await expect(detail.getByText("Release workspace · Example project", { exact: true })).toBeVisible();
  await detail.getByRole("textbox", { name: "Reply to the worker" }).fill("Go ahead.");
  await detail.getByRole("button", { name: "Reply to the worker" }).click();
  await expect(releaseQuestion.getByRole("status")).toHaveText("sent");
});
