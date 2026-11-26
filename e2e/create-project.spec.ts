import { expect } from "@playwright/test";
import { test } from "./support/screens.ts";

test("creation requires the advertised feature", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create project" })).toHaveCount(0);
});

for (const dropResponse of [false, true]) {
  test(dropResponse ? "retry after losing the creation response" : "create from an empty directory", async ({ page }, info) => {
    await page.setExtraHTTPHeaders({ "x-starter-fixture": "1" });
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
