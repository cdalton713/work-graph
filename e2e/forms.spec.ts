import { expect, type Locator, type Page } from "@playwright/test";
import type { GraphData } from "../src/lib/types.ts";
import { screens, test } from "./support/screens.ts";

const worker = {
  id: "question", key: "panel-task", issue: "WG-14", from: "worker",
  at: "2026-01-01T00:00:00Z", body: "What did you find?",
};
const panelProject = "panel";
const projectFor = (issue: number) => issue === 1 ? "fixture" : panelProject;

async function addQuestion(page: Page) {
  await page.routeWebSocket(/\/api\/link\?/, (socket) => {
    socket.send(JSON.stringify({
      type: "asks", project: { workspace: "default", id: panelProject }, payload: { asks: [worker] },
    }));
  });
}

async function panelFor(page: Page, issue: number) {
  await page.addInitScript(() => localStorage.setItem("wg-board", "off"));
  await page.goto(`/?project=${projectFor(issue)}&issue=WG-${issue}`);
  const panel = page.locator(".panel");
  await expect(panel.getByRole("link", { name: `Open WG-${issue} in Linear` })).toBeVisible();
  return panel;
}

function formFor(field: Locator) {
  return field.locator("xpath=ancestor::form");
}

async function checkControls(page: Page, field: Locator, word?: "answer" | "evidence") {
  const form = formFor(field);
  const touch = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
  await expect(field).toHaveAttribute("enterkeyhint", "enter");
  for (const attribute of ["autocapitalize", "autocorrect"]) {
    if (word === "evidence") await expect(field).toHaveAttribute(attribute, "off");
    else expect(await field.getAttribute(attribute)).toBeNull();
  }
  if (touch) {
    for (const button of await form.getByRole("button").all()) {
      const size = (await button.boundingBox())!;
      expect(size.width).toBeGreaterThanOrEqual(44);
      expect(size.height).toBeGreaterThanOrEqual(44);
    }
    await expect(field).toHaveCSS("font-size", "16px");
    await expect(form.getByText("⌘/Ctrl+Enter")).toBeHidden();
  } else {
    await expect(form.getByText("⌘/Ctrl+Enter")).toBeVisible();
  }
  const viewport = page.viewportSize()!;
  const widths = viewport.width === 1440 ? [1280, 1440]
    : viewport.width === 820 ? [768, 820] : viewport.width === 1180 ? [1024, 1180] : [viewport.width];
  for (const width of widths) {
    if (page.viewportSize()!.width !== width) await page.setViewportSize({ ...viewport, width });
    const fits = await form.evaluate((element) => {
      const scroller = element.closest(".panel-body, .stage")!;
      return scroller.scrollWidth <= scroller.clientWidth && element.scrollWidth <= element.clientWidth;
    });
    expect(fits).toBe(true);
    if (!touch) {
      const { rowHeight, buttonHeights, normalHeight } = await form.locator(".text-send-actions").evaluate((row) => {
        const buttonHeights = Array.from(row.querySelectorAll("button"), (button) => button.getBoundingClientRect().height);
        const reference = document.createElement("button");
        reference.textContent = "Send";
        reference.style.position = "absolute";
        row.append(reference);
        const normalHeight = reference.getBoundingClientRect().height;
        reference.remove();
        return { rowHeight: row.getBoundingClientRect().height, buttonHeights, normalHeight };
      });
      expect(rowHeight).toBeCloseTo(normalHeight);
      expect(buttonHeights.length).toBe(word ? 2 : 1);
      for (const buttonHeight of buttonHeights) {
        expect(buttonHeight).toBeCloseTo(normalHeight);
      }
    }
  }
  if (viewport.width === 1440 && await page.locator(".panel").count()) {
    await expect(page.locator(".panel")).toHaveCSS("width", "460px");
  }
}

async function checkKeyboard(page: Page, field: Locator) {
  if (page.viewportSize()!.width > 430) return;
  await field.focus();
  // Emulate a keyboard that shrinks only the visual viewport.
  await page.evaluate(() => {
    const viewport = visualViewport!;
    Object.defineProperty(viewport, "height", { configurable: true, value: 310 });
    viewport.dispatchEvent(new Event("resize"));
  });
  await expect.poll(() => field.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const send = element.closest("form")!.querySelector('button[type="submit"]')!.getBoundingClientRect();
    const local = element.closest(".panel-body, .stage")!.getBoundingClientRect();
    const viewport = visualViewport!;
    return {
      field: Math.max(0, Math.round(Math.max(local.top, viewport.offsetTop) - rect.top)),
      send: Math.max(0, Math.round(send.bottom - Math.min(local.bottom, viewport.offsetTop + viewport.height))),
    };
  })).toEqual({ field: 0, send: 0 });
  await page.evaluate(() => {
    const viewport = visualViewport!;
    Reflect.deleteProperty(viewport, "height");
    viewport.dispatchEvent(new Event("resize"));
  });
}

async function exerciseSend(page: Page, field: Locator, path: RegExp, success: unknown, draft: string, requestBody: object) {
  const form = formFor(field);
  const send = form.locator('button[type="submit"]');
  let requests = 0;
  let release!: () => void;
  const delay = new Promise<void>((resolve) => { release = resolve; });
  await page.route(path, async (route) => {
    if (route.request().method() === "GET") return route.continue();
    expect(route.request().postDataJSON()).toEqual(requestBody);
    if (++requests === 1) {
      await delay;
      return route.fulfill({ status: 503, json: { error: "Try again later." } });
    }
    return route.fulfill({ json: success });
  });
  try {
    await expect(field).toHaveValue(draft);
    await send.click();
    await expect(send).toHaveText("Sending…");
    await expect(send).toBeDisabled();
    await expect(field).toHaveAttribute("readonly", "");
    await field.press("Control+Enter");
    await expect.poll(() => requests).toBe(1);
  } finally {
    release();
  }
  await expect(page.getByRole("alert").filter({ hasText: "Try again later." })).toBeVisible();
  await expect(field).toHaveValue(draft);
  await field.press("Control+Enter");
  await expect.poll(() => requests).toBe(2);
}

test("comments keep a separate draft per issue and clear it after a successful send", async ({ page }) => {
  let panel = await panelFor(page, 14);
  const field = panel.getByRole("textbox", { name: "Comment", exact: true });
  await checkControls(page, field);
  await field.fill("Check passed.");
  await checkKeyboard(page, field);
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: viewport.height, height: viewport.width });
  await expect(field).toHaveValue("Check passed.");
  await page.setViewportSize(viewport);
  await panel.getByRole("button", { name: "Close panel" }).click();
  await expect(panel).toBeHidden();
  panel = await panelFor(page, 15);
  await expect(panel.getByRole("textbox", { name: "Comment", exact: true })).toHaveValue("");
  await panelFor(page, 14);
  await page.reload();
  const created = { id: "new", createdAt: "2026-01-01T00:00:00Z", user: { name: "Ada" }, body: "Check passed." };
  await exerciseSend(page, field, /\/api\/issues\/panel-task\/comments(?:\?|$)/, created, created.body, { body: created.body });
  await expect(field).toHaveValue("");
  await page.reload();
  await expect(field).toHaveValue("");
});

for (const { issue, word, id } of [
  { issue: 1, word: "answer", id: "issue-1" },
  { issue: 15, word: "evidence", id: "panel-ops" },
] as const) {
  test(`a completion keeps its ${word} until the issue moves`, async ({ page }) => {
    let graph: GraphData;
    await page.route(`**/api/projects/${projectFor(issue)}/graph*`, async (route) => {
      const response = await route.fetch();
      if (response.ok()) graph = await response.json();
      await route.fulfill({ response });
    });
    const panel = await panelFor(page, issue);
    async function openCompletion() {
      await panel.locator(".fields .picker-trigger").first().click();
      await page.getByRole("option", { name: "Done", exact: true }).click();
    }
    await openCompletion();
    const field = panel.getByRole("textbox", { name: `The ${word} for WG-${issue}` });
    await checkControls(page, field, word);
    await field.fill("Check passed.");
    await checkKeyboard(page, field);
    await page.reload();
    await openCompletion();
    const saved = graph!.issues.find((entry) => entry.id === id)!;
    const done = graph!.teams[saved.teamId].states.find((state) => state.name === "Done")!;
    await exerciseSend(page, field, new RegExp(`/api/issues/${id}(?:\\?|$)`), { ...saved, state: done },
      "Check passed.", { stateId: done.id, note: "Check passed." });
    await expect(field).toBeHidden();
    await page.reload();
    await openCompletion();
    await expect(field).toHaveValue("");
  });
}

test("the worker reply draft follows the question from the panel to the overview", async ({ page }) => {
  await addQuestion(page);
  const panel = await panelFor(page, 14);
  const label = "Reply to the worker";
  const panelField = panel.getByRole("textbox", { name: label });
  await checkControls(page, panelField);
  await panelField.fill("The output is ready.");
  await checkKeyboard(page, panelField);
  async function openOverviewQuestion() {
    await screens.overview(page);
    await page.locator(".inbox-open").filter({ hasText: "WG-14" }).click();
  }
  await openOverviewQuestion();
  const field = page.locator(".overview").getByRole("textbox", { name: label });
  await checkControls(page, field);
  await checkKeyboard(page, field);
  await exerciseSend(page, field, /\/api\/projects\/panel\/asks\/question\/reply(?:\?|$)/,
    { ok: true, recorded: true }, "The output is ready.", { body: "The output is ready." });
  await expect(field).toBeHidden();
  await panelFor(page, 14);
  await expect(panelField).toHaveValue("");
});
