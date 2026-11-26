import { serviceUrl } from "./support/ports.ts";
import { expect, type Page } from "@playwright/test";
import { test } from "./support/screens.ts";

test("creation requires the advertised feature", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create project" })).toHaveCount(0);
});

for (const dropResponse of [false, true]) {
  test(dropResponse ? "retry after losing the creation response" : "create from an empty directory", async ({ page }, info) => {
    await page.setExtraHTTPHeaders({ "x-starter-fixture": "1" });
    if (dropResponse) await page.addInitScript(() => {
      const write = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (value.length > 512) throw new DOMException("Storage is full", "QuotaExceededError");
        write.call(this, key, value);
      };
    });
    const requests: string[] = [];
    await page.route("**/api/projects", async route => {
      if (route.request().method() === "GET") {
        return route.fulfill({ json: { workspaces: [{ id: "work", name: "Workspace" }], projects: [] } });
      }
      requests.push(route.request().headers()["idempotency-key"]);
      const response = await route.fetch();
      expect(response.ok(), await response.text()).toBe(true);
      if (dropResponse && requests.length === 1) return route.abort();
      return route.fulfill({ response });
    });
    await page.route("**/api/overview", route => route.fulfill({ json: {
      workspaces: [{ id: "work", name: "Workspace" }], projects: [], summaries: [],
    } }));
    await page.goto("/");
    const create = page.getByRole("button", { name: "Create project", exact: true });
    await expect(page.getByText("No projects.", { exact: true })).toBeVisible();
    if (info.project.use.hasTouch) await create.tap();
    else await create.press("Enter");
    const form = page.getByRole("dialog", { name: "Create project" });
    await expect(form.getByLabel("Team")).toHaveValue("WG");
    const name = "Starter " + info.project.name;
    const task = dropResponse ? "Recover the response" : "Build the first task";
    await form.getByLabel("Project name").fill(name);
    await form.getByLabel("First task").fill(task);
    await form.getByLabel("First task").press("Enter");
    if (dropResponse) {
      await expect(form.getByRole("alert")).toBeVisible();
      await expect(form.getByLabel("Project name")).toHaveValue(name);
      await expect(form.getByLabel("First task")).toHaveValue(task);
      await form.getByRole("button", { name: "Create project" }).click();
    }
    const setup = page.getByRole("dialog", { name: "Coordinator setup" });
    await expect(setup.getByText("wg next .", { exact: true })).toBeVisible();
    const id = new URL(page.url()).searchParams.get("project");
    expect(new URL(page.url()).searchParams.get("workspace")).toBe("work");
    for (const file of ["plan", "keymap"]) {
      const [download] = await Promise.all([page.waitForEvent("download"), setup.getByText("Download " + file + ".json").click()]);
      expect(download.suggestedFilename()).toBe(file + ".json");
      const stream = await download.createReadStream();
      const chunks = [];
      for await (const chunk of stream!) chunks.push(chunk);
      const data = JSON.parse(Buffer.concat(chunks).toString());
      if (file === "plan") expect(data.nodes.map((n: { title: string }) => n.title)).toEqual([task, "Merge the first task", "Verify the first release"]);
      else expect(data.project.id).toBe(id);
    }
    await setup.getByRole("button", { name: "Close" }).press("Escape");
    await expect(page.getByText(task, { exact: true }).first()).toBeVisible();
    expect(requests).toHaveLength(dropResponse ? 2 : 1);
    expect(new Set(requests).size).toBe(1);
    await page.locator(".bar-home").click();
    await page.goBack();
    await expect(page.getByText(task, { exact: true }).first()).toBeVisible();
    const controls = page.getByRole("button", { name: "More", exact: true });
    if (await controls.isVisible()) await controls.click();
    await page.getByRole("button", { name: "Coordinator setup" }).click();
    await expect(setup).toBeVisible();
  });
}

test("a late team response cannot replace the selected workspace team", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "x-starter-fixture": "1" });
  const list = { projects: [], workspaces: [{ id: "first", name: "First" }, { id: "second", name: "Second" }] };
  await page.route("**/api/projects", route => route.fulfill({ json: list }));
  await page.route("**/api/overview", route => route.fulfill({ json: { ...list, summaries: [] } }));
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/project-creation/teams", async route => {
    const workspace = route.request().headers()["x-workspace"];
    if (workspace === "first") await held;
    await route.fulfill({ json: { teams: [{ key: workspace, name: workspace }] } });
  });
  await page.goto("/");
  const requested = page.waitForRequest(req => req.url().endsWith("/project-creation/teams"));
  await page.getByRole("button", { name: "Create project" }).click();
  await requested;
  await page.getByRole("dialog").getByLabel("Workspace").selectOption("second");
  const team = page.getByRole("dialog").getByLabel("Team");
  await expect(team).toHaveValue("second");
  release();
  await page.unrouteAll({ behavior: "wait" });
  await expect(team).toHaveValue("second");
});

test("hosted setup follows the owner across tabs and clears on sign-out", async ({ page, context }) => {
  const origin = serviceUrl();
  const entry = { workspace: "example", workspaceName: "Example", id: "project", name: "Starter", url: origin, status: "Planned", statusType: "planned" };
  const plan = { effort: { workspace: entry.workspace, team: "WG", name: entry.name }, nodes: [{ title: "Build" }] };
  const keymap = { project: { id: entry.id }, collab: { page: origin, workspace: entry.workspace, project: entry.id } };
  let listed = false;
  let removed = false;
  const workspaces = [{ id: "other", name: "Other" }, { id: "locked", name: "Locked" }, { id: "unfiltered", name: "Unfiltered" },
    { id: "example", name: "Example" }];
  await context.route("**/api/config", async route => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...await response.json(), createProjects: true } });
  });
  await context.route("**/api/account", async route => {
    const response = await route.fetch();
    const account = await response.json();
    const base = account.connections[0];
    await route.fulfill({ json: { ...account, connections: [
      { ...base, id: "other-id", workspace_id: "other" }, { ...base, id: "locked-id", workspace_id: "locked", status: "needs_key" },
      { ...base, id: "unfiltered-id", workspace_id: "unfiltered", team: "" }, base,
    ] } });
  });
  await context.route("**/api/project-creation/teams", route => route.fulfill({
    json: { teams: [{ key: "WG", name: "Build" }] },
  }));
  const directory = () => ({ workspaces, projects: listed && !removed ? [entry] : [] });
  await context.route("**/api/overview", route => route.fulfill({ json: { ...directory(), summaries: [] } }));
  await context.route("**/api/projects", async route => {
    if (route.request().method() === "GET") return route.fulfill({ json: directory() });
    expect(route.request().headers()["x-workspace"]).toBe("example");
    expect(route.request().postDataJSON()).toEqual({ team: "WG", name: "Starter", firstTask: "Build" });
    return route.fulfill({ json: { workspace: "example", project: { id: entry.id, url: entry.url },
      handoff: { plan, keymap, command: "wg pull . --force && wg next ." } } });
  });
  await context.route("**/api/projects/project/graph*", route => removed
    ? route.fulfill({ status: 404, json: { error: "Project removed" } }) : route.continue());

  const login = (target: Page, who: string, next = "/") => target.goto(origin + "/auth/login?" + new URLSearchParams({ as: who, next }));
  async function controls(target: Page) {
    const more = target.getByRole("button", { name: "More", exact: true });
    if (await more.isVisible()) await more.click();
    return target.getByRole("button", { name: "Coordinator setup" });
  }
  await login(page, "ada");
  await page.getByRole("button", { name: "Create project" }).click();
  const form = page.getByRole("dialog", { name: "Create project" });
  await expect(form.getByLabel("Workspace").locator("option")).toHaveText(["Other", "Example"]);
  await form.getByLabel("Workspace").selectOption("example");
  await form.getByLabel("Project name").fill("Starter");
  await form.getByLabel("First task").fill("Build");
  await form.getByRole("button", { name: "Create project" }).click();
  const setup = page.getByRole("dialog", { name: "Coordinator setup" });
  await expect(setup).toBeVisible();
  const projectUrl = new URL(page.url());
  expect(projectUrl.searchParams.get("project")).toBe(entry.id);
  expect(projectUrl.searchParams.get("workspace")).toBe(entry.workspace);

  // The directory has not yet observed the project. The graph endpoint already serves it.
  await page.reload();
  await expect(page.locator(".bar-project")).toContainText(/Starter|Example project/);
  await (await controls(page)).click();
  await expect(setup.getByText("wg login " + origin, { exact: true })).toBeVisible();
  await expect(setup.getByText("wg pull . --force && wg next .", { exact: true })).toBeVisible();
  for (const [filename, expected] of [["plan.json", plan], ["keymap.json", keymap]] as const) {
    const [download] = await Promise.all([page.waitForEvent("download"), setup.getByText("Download " + filename).click()]);
    expect(download.suggestedFilename()).toBe(filename);
    const chunks = [];
    for await (const chunk of (await download.createReadStream())!) chunks.push(chunk);
    expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual(expected);
  }
  listed = true;
  const tab = await context.newPage();
  await tab.goto(projectUrl.href);
  await expect(tab.locator(".bar-project")).toContainText("Starter");
  await expect(await controls(tab)).toBeVisible();

  // Both accounts can see this workspace and project. Only its creator saved the handoff.
  removed = true;
  const denied = tab.waitForResponse(response => response.url().includes("/project/graph") && response.status() === 404);
  await tab.reload();
  await denied;
  await expect(tab.locator(".bar-project")).toHaveText("Open a project");
  await expect(tab.getByText(entry.name, { exact: true })).toHaveCount(0);
  removed = false;
  await login(tab, "pat", "/" + projectUrl.search);
  await expect(tab.locator(".bar-project")).toContainText("Starter");
  await expect(await controls(tab)).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Coordinator setup" })).toHaveCount(0);
  await login(tab, "ada", "/" + projectUrl.search);
  await expect(tab.locator(".bar-project")).toContainText("Starter");
  await expect(await controls(tab)).toBeVisible();
  await tab.getByRole("link", { name: "Sign out" }).click();
  await login(tab, "ada", "/" + projectUrl.search);
  await expect(tab.locator(".bar-project")).toContainText("Starter");
  await expect(await controls(tab)).toHaveCount(0);
});

test("the overview uses its own project list after a workspace read fails", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/overview", async route => {
    await held;
    await route.fulfill({ json: { projects: [], summaries: [], workspaces: [
      { id: "default", name: "Example", error: "Workspace unavailable" },
    ] } });
  });
  await page.goto("/");
  const project = page.locator(".overview .ov-title").getByText("Example project", { exact: true });
  await expect(project).toBeVisible();
  release();
  await expect(page.getByText(/Workspace unavailable/).first()).toBeVisible();
  await expect(project).toHaveCount(0);
});
