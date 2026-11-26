import { expect, type Locator } from "@playwright/test";
import type { GraphData, Issue, IssuePatch } from "../src/lib/types";
import { screens, test } from "./support/screens";

const title = "Check each result in the report and record the observed outcome before sending the changes for review";
const reason = "Read the evidence from the last run and confirm that all checks pass before continuing. " +
  "Record each failed check with the full error and the step where it occurred.";
const reviewed = { id: "reviewed", name: "reviewed", color: "#4466aa", group: null };
const runningHint = "A worker runs on it, or it is In Progress.";

async function expectTouchTarget(control: Locator) {
  const size = await control.boundingBox();
  expect(size!.width).toBeGreaterThanOrEqual(44);
  expect(size!.height).toBeGreaterThanOrEqual(44);
}

test.beforeEach(async ({ page }) => {
  let issue: Issue;
  await page.route("**/api/issues/issue-5", (route) => {
    const patch: IssuePatch = route.request().postDataJSON();
    return route.fulfill({ json: { ...issue, labels: [...issue.labels, ...(patch.labelIds?.includes(reviewed.id) ? [reviewed] : [])] } });
  });
  await page.route("**/api/projects/fixture/graph*", async (route) => {
    const response = await route.fetch();
    if (response.status() !== 200) return route.fulfill({ response });
    const graph: GraphData = await response.json();
    issue = graph.issues.find(({ identifier }) => identifier === "WG-5")!;
    issue.title = title;
    issue.labels = [{ id: "runner", name: "agent:codex", color: "#4466aa", group: "agent" }];
    issue.card = { id: "card", body: "**work-graph node card**\n\n```json\n" + JSON.stringify({
      wg: 1, key: "example-5", kind: "task", state: "running",
      started_at: new Date(Date.now() - 60_000).toISOString(), next: "wait human: " + reason,
    }) + "\n```" };
    issue.pullRequests = [{
      url: "https://example.com/pull/42", reviewUrl: "https://example.com/review/42",
      status: "open", number: 42, title: "Example change",
    }];
    graph.labels = [reviewed];
    graph.issues.push(...Array.from({ length: 28 }, (_, index) => ({
      ...issue, id: `extra-${index}`, identifier: `WG-${100 + index}`, title: "Example running issue",
      card: null, pullRequests: [], sortOrder: 100 + index,
    })));
    await route.fulfill({ response, json: graph });
  });
  await screens.board(page);
});

test("issue details and review controls fit the board", async ({ page }, { project }) => {
  const touch = !project.name.startsWith("desktop-");
  const board = page.getByRole("navigation", { name: "Issues by the action they need" });
  const row = board.getByRole("button", { name: /WG-5/ });
  const pr = board.getByRole("link", { name: "GitHub", exact: true });
  const review = board.getByRole("button", { name: "Mark reviewed", exact: true });

  await expect(row).toContainText(title);
  await expect(row).toContainText("codex");
  await expect(row.locator(".run-time:visible")).toHaveText(/\d+m/);
  const why = board.getByText(reason, { exact: true });
  await expect(why).toBeVisible();
  expect(await why.evaluate((el) => el.scrollHeight)).toBe(await why.evaluate((el) => el.clientHeight));

  if (touch) {
    await expectTouchTarget(row);
    await expect(row.getByText("In Progress", { exact: true })).toBeVisible();
    await expect(row.getByText(title, { exact: true })).toHaveCSS("-webkit-line-clamp", "2");
    await expectTouchTarget(pr);
    await expectTouchTarget(board.getByRole("link", { name: "Linear", exact: true }));
    await expectTouchTarget(review);
  } else {
    expect((await board.boundingBox())!.width).toBe(300);
    const shortRow = board.getByRole("button", { name: /WG-100\b/ });
    await expect(shortRow).toHaveCSS("padding-top", "5px");
    await expect(shortRow.getByText("Example running issue")).toHaveCSS("white-space", "nowrap");
  }

  await expect(pr).toHaveAttribute("href", "https://example.com/pull/42");
  await expect(row.getByRole("link")).toHaveCount(0);
  await expect(row.getByRole("button")).toHaveCount(0);
  if (touch) await review.tap();
  else await review.click();
  await expect(board.getByRole("button", { name: "✓ Reviewed" })).toBeVisible();
  await expect(page.locator(".panel")).toHaveCount(0);
  await row.click();
  await expect(page.locator(".panel")).toBeVisible();
});

test("group heads fold and explain their contents", async ({ page }, { project }) => {
  const touch = !project.name.startsWith("desktop-");
  const group = page.locator(".board-running");
  const fold = group.getByRole("button", { name: /^Running \d/ });
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  if (touch) {
    const info = group.getByRole("button", { name: "About Running" });
    await expectTouchTarget(fold);
    await expectTouchTarget(info);
    await info.tap();
    await expect(page.getByRole("tooltip", { name: runningHint })).toBeVisible();
    await expect(fold).toHaveAttribute("aria-expanded", "true");
    await info.tap();
  } else {
    await expect(group.locator(".board-heading")).toHaveAttribute("title", runningHint);
  }
  await fold.click();
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(group.getByRole("list")).toHaveCount(0);
  await fold.click();
  await expect(group.getByRole("list")).toBeVisible();
});

test("find stays above the list and can be cleared", async ({ page }, { project }) => {
  const touch = !project.name.startsWith("desktop-");
  const board = page.locator(".board");
  const find = board.getByRole("searchbox");
  const hint = board.locator("kbd");
  if (touch) {
    await expect(hint).toBeHidden();
    await expect(find).toHaveCSS("font-size", "16px");
  } else {
    await expect(hint).toHaveText("/");
    await expect(hint).toBeVisible();
    await page.keyboard.press("/");
    await expect(find).toBeFocused();
  }
  const top = (await find.boundingBox())!.y;
  const scroll = board.locator(".board-scroll");
  await scroll.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  expect(await scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect((await find.boundingBox())!.y).toBe(top);
  expect(await scroll.evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(await scroll.evaluate((el) => el.clientWidth));
  expect(await board.evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(await board.evaluate((el) => el.clientWidth));
  await find.fill("WG-5");
  await expect(board.getByRole("button", { name: /WG-5/ })).toBeVisible();
  await expect(board.getByRole("button", { name: /WG-1\b/ })).toHaveCount(0);
  const clear = board.getByRole("button", { name: "Clear issue search" });
  if (touch) await expectTouchTarget(clear);
  await clear.click();
  await expect(find).toHaveValue("");
  await expect(find).toBeFocused();
  await expect(board.getByRole("button", { name: /WG-1\b/ })).toBeVisible();
});

for (const width of [768, 1024]) {
  test(`board fits an intermediate tablet width of ${width}`, async ({ page }, { project }) => {
    test.skip(!project.name.startsWith("tablet-820"), "Use one touch tablet project");
    await page.setViewportSize({ width, height: 900 });
    const scroll = page.locator(".board-scroll");
    await expect(scroll).toBeVisible();
    expect(await scroll.evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(await scroll.evaluate((el) => el.clientWidth));
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth)).toBeLessThanOrEqual(width);
  });
}
