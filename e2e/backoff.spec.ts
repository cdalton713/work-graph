import { expect } from "@playwright/test";
import { test } from "./support/screens.ts";

test("project polls, new tabs and visibility wait for the 90-second retry window", async ({ page, context }) => {
  const start = new Date("2026-01-01T00:00:00Z");
  let graphs = 0, overviews = 0, directories = 0;
  await context.route("**/api/projects", route => { directories++; return route.fallback(); });
  await context.route("**/api/overview", route => { overviews++; return route.fallback(); });
  await context.route("**/api/projects/*/graph*", route => {
    if (++graphs > 1) return route.fallback();
    return route.fulfill({ status: 429, headers: { "Retry-After": "90" }, json: { error: "Linear rate limit" } });
  });
  await page.clock.install({ time: start });
  await page.clock.pauseAt(new Date(+start + 1000));
  await page.goto("/?project=fixture");
  await expect(page.getByText("Linear rate limit", { exact: true }).first()).toBeVisible();
  expect(directories).toBe(1);
  expect(overviews).toBe(0);
  const second = await context.newPage();
  await second.goto("/?project=fixture");
  await expect(second.getByText("Linear rate limit", { exact: true }).first()).toBeVisible();
  await page.clock.fastForward(89_000);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(graphs).toBe(1);
  expect(overviews).toBe(0);
  await page.clock.fastForward(1000);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => graphs).toBe(2);
  const beforeHome = directories;
  await page.goto("/");
  await expect.poll(() => overviews).toBe(1);
  await expect.poll(() => directories).toBe(beforeHome + 1);
});

test("a viewer hides a graph when its refresh fails and recovers on a fresh read", async ({ page }) => {
  await page.route("**/api/config", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), readOnly: true } });
  });
  await page.goto("/?project=fixture");
  const board = page.getByRole("navigation", { name: "Issues by the action they need" });
  await expect(board).toBeVisible();
  await page.route("**/api/projects/fixture/graph*", route => route.fulfill({
    status: 503, json: { error: "Cannot confirm this share" },
  }), { times: 1 });
  await page.getByRole("button", { name: "Refresh project" }).click();
  await expect(page.getByText("Cannot confirm this share").first()).toBeVisible();
  await expect(board).toBeHidden();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(board).toBeVisible();
});

test("an anonymous viewer hold applies only to the selected share", async ({ page }) => {
  await page.route("**/api/config", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), readOnly: true, user: null } });
  });
  await page.route("**/api/projects/fixture/graph*", route => route.fulfill({
    status: 429, headers: { "Retry-After": "90" }, json: { error: "Limited share" },
  }));
  await page.goto("/?project=fixture");
  await expect(page.getByText("Limited share", { exact: true }).first()).toBeVisible();
  await Promise.all([page.waitForResponse(r => r.url().includes("/api/projects/planned/graph") && r.ok()),
    page.goto("/?project=planned")]);
  await expect(page.locator(".bar-project")).toContainText("Planned project");
});

for (const globalSeconds of [0, 30]) {
  test(`endpoint backoff spans graph versions and tabs (global seconds: ${globalSeconds})`, async ({ page, context }) => {
    const requests: string[] = [];
    const graphReads = () => requests.filter(path => path === "default/api/projects/fixture/graph").length;
    let limitedRead = 0;
    await context.route("**/api/projects", async route => {
      const response = await route.fetch();
      const list = await response.json();
      list.workspaces.push({ id: "other", name: "Other" });
      list.projects.push({ ...list.projects.find((p: { id: string }) => p.id === "fixture"), workspace: "other" });
      await route.fulfill({ json: list });
    });
    await context.route("**/api/projects/*/graph*", async route => {
      const url = new URL(route.request().url());
      const workspace = route.request().headers()["x-workspace"];
      requests.push(workspace + url.pathname);
      if (workspace === "other") return route.fulfill({ status: 503, json: { error: "Other workspace reached" } });
      if (!limitedRead && workspace === "default" && url.pathname === "/api/projects/fixture/graph" && url.searchParams.has("have")) {
        limitedRead = graphReads();
        return route.fulfill({ status: 429, json: { error: "Endpoint limited" }, headers: {
          "Retry-After": "90", "X-RateLimit-Scope": "endpoint",
          ...(globalSeconds ? { "X-RateLimit-Global-Retry-After": String(globalSeconds) } : {}),
        } });
      }
      return route.fallback();
    });
    const start = new Date("2026-01-01T00:00:00Z");
    await page.clock.install({ time: start });
    await page.clock.pauseAt(new Date(+start + 1000));
    await page.goto("/?project=fixture");
    await expect(page.getByRole("navigation", { name: "Issues by the action they need" })).toBeVisible();
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(page.getByText("Endpoint limited", { exact: false }).first()).toBeVisible();
    const second = await context.newPage();
    const limited = second.getByText("Linear rate limit", { exact: false }).first();
    await second.goto("/?project=fixture");
    await expect(limited).toBeVisible();
    expect(limitedRead).toBeGreaterThan(1);
    expect(graphReads()).toBe(limitedRead);
    await second.goto("/?workspace=other&project=fixture");
    await expect(second.getByText("Other workspace reached").first()).toBeVisible();
    await second.goto("/?project=planned");
    if (globalSeconds) {
      await expect(limited).toBeVisible();
      await page.clock.fastForward(globalSeconds * 1000 - 1);
      await second.reload();
      await expect(limited).toBeVisible();
      expect(requests).not.toContain("default/api/projects/planned/graph");
      await page.clock.fastForward(1);
      await second.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    }
    await expect.poll(() => requests.includes("default/api/projects/planned/graph")).toBe(true);
    await page.clock.fastForward((90 - globalSeconds) * 1000 - 1);
    await second.goto("/?project=fixture");
    await expect(limited).toBeVisible();
    expect(graphReads()).toBe(limitedRead);
    await page.clock.fastForward(1);
    await second.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect.poll(graphReads).toBe(limitedRead + 1);
  });
}
