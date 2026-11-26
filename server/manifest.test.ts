import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createApp } from "./app.ts";
import { createVercelApp } from "./vercel.ts";

it("serves the default manifest and its icons without a sign-in", async () => {
  const app = createApp({ port: 443, tailnet: null, hosted: { host: "example.com" } }, {
    team: "WG",
    dist: fileURLToPath(new URL("../public/", import.meta.url)),
    readOnly: true,
    watchMs: 0,
    auth: { domains: ["example.com"], clientId: "client", clientSecret: "secret", secret: "a-session-secret-of-32-characters" },
  });
  expect((await app.request("https://example.com/api/projects", { headers: { host: "example.com" } })).status).toBe(401);
  const response = await app.request("https://example.com/manifest.json");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/manifest+json");
  const manifest = await response.json();
  expect(manifest).toMatchObject({ name: "work-graph", short_name: "work-graph" });
  expect(manifest.icons).toContainEqual({
    src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable",
  });
  for (const icon of manifest.icons) {
    const response = await app.request(new URL(icon.src, "https://example.com"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
  }
});

it("uses the installation name on the function host", async () => {
  const { app } = createVercelApp({
    WG_HOSTED: "example.com",
    WG_READ_ONLY: "1",
    WG_CONFIG_JSON: JSON.stringify({ app_name: "Example Planner", workspaces: [{ id: "work", team: "WG" }] }),
  });
  const response = await app!.request("https://example.com/manifest.json");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/manifest+json");
  expect(await response.json()).toMatchObject({ name: "Example Planner", short_name: "Example Planner" });
});
