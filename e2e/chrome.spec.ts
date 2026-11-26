import { expect, type Page } from "@playwright/test";
import { serviceUrl } from "./support/ports.ts";
import { screens, test } from "./support/screens.ts";

const summary = "Phase 6 has nine tasks, five code changes complete, and five reviews to check.";
const lines = [
  { level: "do", text: "Review the full result of the first task and record the result before the next dispatch." },
  { level: "wait", text: "Wait for the owner to confirm the second task before starting the next group." },
];

async function publish(page: Page, warnings = false, project = "fixture") {
  await page.route(`**/api/projects/${project}/graph*`, async (route) => {
    const response = await route.fetch();
    const graph = await response.json();
    const ran = new Date(Date.now() - (warnings ? 21 : 2) * 60_000).toISOString();
    const content = `\`\`\`json\n${JSON.stringify({
      wg: 1, status: summary, ran, lines, ...(warnings ? { contract: "old-record" } : {}),
    })}\n\`\`\``;
    await route.fulfill({ response, json: {
      ...graph, status: { content, updatedAt: ran },
      ...(warnings ? { stale: true, error: "Example refresh failed" } : {}),
    } });
  });
}

test("the status filters scroll with a fixed done count and explain each filter", async ({ page }, info) => {
  const desktop = info.project.name.startsWith("desktop-");
  const phone = info.project.name.startsWith("phone-");
  await publish(page);
  await screens.project(page);
  const rail = page.locator(".rail-bar");
  const filters = rail.getByRole("group", { name: "Show only these statuses" });
  const filter = filters.getByRole("button", { name: /^Triage/ });
  const tally = rail.getByText(/done$/);
  if (desktop) await expect(rail.locator(".tally-track")).toBeVisible();
  else await expect(rail.locator(".tally-track")).toBeHidden();
  const row = page.locator(".effort").filter({ hasText: summary });
  const details = row.getByRole("button", { name: /wg next/i });
  for (const width of info.project.name.startsWith("tablet-820") ? [768, 820, 1024, 1180] : [info.project.use.viewport!.width]) {
    await page.setViewportSize({ width, height: info.project.use.viewport!.height });
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth)).toBeLessThanOrEqual(width);
  }
  const railBox = (await rail.boundingBox())!;
  const rowBox = (await row.boundingBox())!;
  expect(railBox.height).toBe(desktop ? 34 : 44);
  if (phone) expect(railBox.height + rowBox.height).toBeLessThanOrEqual(72);
  if (phone) expect((await filter.boundingBox())!.x - railBox.x).toBeLessThanOrEqual(16);
  const tallyBox = await tally.boundingBox();
  if (!desktop) {
    expect((await filter.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const hint = filters.getByRole("button", { name: "About the Triage filter" });
    expect((await hint.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await hint.tap();
    await expect(page.getByRole("tooltip")).toHaveText("Dim all but Triage");
    await page.keyboard.press("Escape");
    expect(await filters.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
      return element.scrollLeft;
    })).toBeGreaterThan(0);
    expect(await tally.boundingBox()).toEqual(tallyBox);
    await filters.evaluate((element) => { element.scrollLeft = 0; });
  } else {
    // Text metrics differ slightly between the Linux and macOS font renderers.
    expect(Math.abs(rowBox.height - 28.39)).toBeLessThanOrEqual(1.5);
    await expect(filter).toHaveAccessibleDescription("Dim all but Triage");
  }
  await filter.click();
  await expect(filter).toHaveAttribute("aria-pressed", "true");
  await filters.getByRole("button", { name: "Show all" }).click();
  await expect(filter).toHaveAttribute("aria-pressed", "false");
  if (phone) {
    const box = (await details.boundingBox())!;
    // The touch target extends up into the static done tally.
    await page.touchscreen.tap(box.x + box.width - 22, box.y - 16);
  } else {
    await details.click();
  }
  const sheet = page.getByRole("dialog", { name: "wg next" });
  await expect(sheet.getByText(summary)).toBeVisible();
  for (const line of lines) await expect(sheet.getByText(`${line.level} ${line.text}`)).toBeVisible();
  await expect(sheet.getByText(/Published 2 min ago/)).toBeVisible();
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(details).toBeFocused();
});

test("contract and stale warnings stay visible outside the wg next sheet", async ({ page }) => {
  await publish(page, true);
  await screens.project(page);
  await expect(page.getByRole("status").filter({ hasText: "old-record" })).toBeVisible();
  await expect(page.locator(".effort-warning").getByText(/last ran 21 min ago/)).toBeVisible();
  const stale = page.getByRole("button", { name: /Linear is unavailable/ });
  await expect(stale).toBeVisible();
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await stale.click();
  await expect(page.getByRole("dialog", { name: "wg next" }).getByText(/Example refresh failed/)).toBeVisible();
});

test("the sheet shows the coordinator state and sends full-size commands", async ({ page }, info) => {
  await publish(page, false, "project");
  const next = encodeURIComponent("/?workspace=example&project=project");
  await page.goto(`${serviceUrl()}/auth/login?as=ada&next=${next}`);
  const select = page.getByRole("combobox", { name: "Runner" });
  await expect(select).toBeVisible();
  await expect(select).toHaveCSS("font-size", info.project.name.startsWith("desktop-") ? "13px" : "16px");
  const sent: string[] = [];
  await page.route("**/api/projects/project/commands*", async (route) => {
    sent.push(route.request().postDataJSON().name);
    await route.fulfill({ json: { ok: true, queued: 0 } });
  });
  const row = page.locator(".effort").filter({ hasText: summary });
  if (info.project.name.startsWith("desktop-")) await expect(row.getByRole("button", { name: "Pause" })).toBeVisible();
  await row.getByRole("button", { name: /wg next/i }).first().click();
  const sheet = page.getByRole("dialog", { name: "wg next" });
  await expect(sheet.getByText("coordinator listening", { exact: true })).toBeVisible();
  for (const name of ["Run wg next now", "Pause", "Resume"]) {
    const button = sheet.getByRole("button", { name, exact: true });
    const box = (await button.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await button.click();
    if (name === "Pause") {
      await expect(sheet.getByText("Coordinator paused", { exact: true })).toBeVisible();
      if (info.project.name.startsWith("phone-")) {
        await sheet.getByRole("button", { name: "Close", exact: true }).click();
        const lamp = row.getByRole("img", { name: "Coordinator paused" });
        await expect(lamp).toBeVisible();
        expect((await page.locator(".rail-bar").boundingBox())!.height + (await row.boundingBox())!.height).toBeLessThanOrEqual(72);
        await row.getByRole("button", { name: /wg next/i }).click();
      }
    }
  }
  expect(sent).toEqual(["next", "pause", "resume"]);
});

test("the phone shows a coordinator that needs attention before opening the sheet", async ({ page }, info) => {
  test.skip(!info.project.name.startsWith("phone-"));
  await publish(page);
  await page.routeWebSocket(/\/api\/link\?.*project=fixture/, (socket) => {
    const at = new Date().toISOString();
    socket.send(JSON.stringify({
      v: 1, type: "agents", project: { workspace: "default", id: "fixture" },
      payload: { at, agents: [{ role: "coordinator", state: "waiting", at, agent: "Example" }] },
    }));
  });
  await screens.project(page);
  const row = page.locator(".effort-row");
  const attention = "Coordinator needs attention";
  await expect(row.getByRole("img", { name: attention })).toBeVisible();
  expect((await page.locator(".rail-bar").boundingBox())!.height + (await row.boundingBox())!.height).toBeLessThanOrEqual(72);
  await row.getByRole("button", { name: /wg next/i }).tap();
  await expect(page.getByRole("dialog", { name: "wg next" }).getByText(attention, { exact: true })).toBeVisible();
});
