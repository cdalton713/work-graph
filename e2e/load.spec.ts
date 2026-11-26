import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { expect } from "@playwright/test";
import { screens, test } from "./support/screens.ts";

test("the overview fits the cold-load JavaScript budget", async ({ page }, info) => {
  test.skip(info.project.name !== "phone-390x844", "Measure once on the reference phone.");

  const client = await page.context().newCDPSession(page);
  await client.send("Network.enable");
  await client.send("Network.setCacheDisabled", { cacheDisabled: true });
  await client.send("Network.emulateNetworkConditions", {
    offline: false, latency: 150, downloadThroughput: 200_000, uploadThroughput: 93_750,
  });
  await client.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const scripts = new Map<string, Promise<unknown>>();
  page.on("response", (response) => {
    if (response.request().resourceType() === "script") scripts.set(response.url(), response.finished());
  });

  await screens.overview(page);
  await Promise.all(scripts.values());
  const sizes = await page.evaluate(() =>
    performance.getEntriesByType("resource")
      .filter((entry): entry is PerformanceResourceTiming => entry instanceof PerformanceResourceTiming)
      .map(({ name, encodedBodySize }) => [name, encodedBodySize] as const),
  );
  const bytes = new Map(sizes);
  expect(scripts.size).toBeGreaterThan(0);
  let total = 0;
  for (const url of scripts.keys()) {
    const size = bytes.get(url) ?? 0;
    expect(size, url).toBeGreaterThan(0);
    total += size;
  }
  // The old entry script transferred 702,677 bytes. The split build is about 115 kB.
  expect(total).toBeLessThan(150_000);
});

test("opening the graph runs layout in a worker and the issue renders Markdown", async ({ page }, info) => {
  test.skip(info.project.name !== "phone-390x844", "Exercise the lazy routes on the reference phone.");

  const worker = page.waitForEvent("worker", { predicate: (worker) => worker.url().includes("/assets/elk-worker.") });
  await screens.project(page);
  await worker;
  await page.goto("/?project=panel&issue=WG-14");
  await expect(page.locator(".panel .rich table").first()).toBeVisible();
});

test("precompressed assets match the final build and keep their cache headers", async ({}, info) => {
  test.skip(info.project.name !== "phone-390x844", "The assets are the same for each browser size.");

  const { createApp } = await import("../server/app.ts");
  const dist = new URL("../dist/", import.meta.url);
  const names = (await readdir(new URL("assets/", dist))).filter((name) => /\.(js|css)$/.test(name));
  expect(names.length).toBeGreaterThan(0);
  const app = createApp({ port: 0, tailnet: null, hosted: null }, {
    team: "WG", dist: fileURLToPath(dist), readOnly: true, watchMs: 0,
  });
  const setting = process.env.WG_PRECOMPRESSED_ASSETS;
  process.env.WG_PRECOMPRESSED_ASSETS = "1";
  try {
    for (const name of names) {
      const response = await app.request(`/assets/${name}`, { headers: { "Accept-Encoding": "gzip" } });
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Encoding")).toBe("gzip");
      expect(response.headers.get("Vary")).toBe("Accept-Encoding");
      expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
      const gzip = Buffer.from(await response.arrayBuffer());
      expect(gzip.equals(await readFile(new URL(`assets/${name}.gz`, dist))), name).toBe(true);
      expect(gunzipSync(gzip).equals(await readFile(new URL(`assets/${name}`, dist))), name).toBe(true);
    }

    const plain = await app.request(`/assets/${names[0]}`, {
      headers: { "Accept-Encoding": "gzip;q=0, *;q=1" },
    });
    expect(plain.headers.has("Content-Encoding")).toBe(false);
    expect(plain.headers.get("Vary")).toBe("Accept-Encoding");
  } finally {
    if (setting === undefined) delete process.env.WG_PRECOMPRESSED_ASSETS;
    else process.env.WG_PRECOMPRESSED_ASSETS = setting;
  }
});

for (const [chunk, path, message] of [
  ["Canvas", "/?project=fixture", "Could not load the graph."],
  ["Panel", "/?project=fixture&issue=WG-1", "Could not load the issue panel."],
  ["react-markdown", "/?project=panel&issue=WG-14", "Could not load Markdown formatting."],
] as const) {
  test(`a missing ${chunk} chunk keeps the app on screen`, async ({ page }, info) => {
    test.skip(info.project.name !== "desktop-1440x900");
    await page.route(new RegExp(`/assets/${chunk}-[^/]+\\.js$`), (route) => route.fulfill({ status: 404 }));
    await page.goto(path);
    const error = page.getByRole("alert").filter({ hasText: message }).first();
    await expect(error.getByRole("button", { name: "Reload" })).toBeVisible();
    await expect(page.locator(".bar")).toBeVisible();
    if (chunk === "react-markdown") {
      await expect(page.locator(".panel .rich").first()).toContainText("First column");
    }
  });
}

test("a missing layout worker shows an error and can retry", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-1440x900");
  const assets = new URL("../dist/assets/", import.meta.url);
  const workers = await Promise.all((await readdir(assets))
    .filter((name) => /^elk-worker\.min-.*\.js$/.test(name))
    .map(async (name) => ({ name, size: (await stat(new URL(name, assets))).size })));
  // The worker script is larger than the generated module that exports its URL.
  const worker = `**/assets/${workers.sort((a, b) => b.size - a.size)[0].name}`;
  await page.route(worker, (route) => route.fulfill({ status: 404 }));
  await page.goto("/?project=fixture");
  const error = page.getByRole("alert").filter({ hasText: "The layout worker failed." });
  await expect(error.getByRole("button", { name: "Reload" })).toBeVisible();
  await expect(page.locator(".bar")).toBeVisible();
  await page.unroute(worker);
  await page.getByRole("button", { name: "Retry layout" }).click();
  await expect(page.locator(".react-flow")).toBeVisible();
  await expect(error).toHaveCount(0);
});

test("the page server caches fonts and honors their validators", async ({ request, baseURL }, info) => {
  test.skip(info.project.name !== "desktop-1440x900");
  const font = new URL("/fonts/plex-sans-400-latin.woff2", baseURL).href;
  const reply = await request.get(font);
  expect(reply.ok()).toBe(true);
  expect(reply.headers()["cache-control"]).toBe("public, max-age=86400");
  const tag = reply.headers().etag;
  expect(tag).toBeTruthy();
  const cached = await request.get(font, { headers: { "If-None-Match": tag } });
  expect(cached.status()).toBe(304);
  expect(cached.headers().etag).toBe(tag);
  expect(cached.headers()["cache-control"]).toBe("public, max-age=86400");
});
