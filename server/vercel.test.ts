import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { Server } from "node:http";
import { serializeSigned } from "hono/utils/cookie";
import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { startTestRedis, testRedis } from "./testing/redis.ts";
import { createVercelApp } from "./vercel.ts";

const host = "page.example.com";
const headers = { host };
const auth = { domains: ["example.com"], owners: ["ada@example.com"] };
const config = { workspaces: [{ id: "work", team: "WG" }] };
const env = {
  WG_HOSTED: host,
  WG_CONFIG_JSON: JSON.stringify({ ...config, auth }),
  WG_AUTH_CLIENT_ID: "test-client-id",
  WG_AUTH_CLIENT_SECRET: "test-client-secret",
  WG_SESSION_SECRET: "test-session-secret-of-32-characters",
  WG_LINK_TOKEN: "test-link-token-of-32-characters",
  WG_REDIS_URL: "redis://:test-redis-password@example.com",
  WG_READ_ONLY: "0",
};

it.each([undefined, "1"])("serves the viewer with WG_READ_ONLY=%s", async (mode) => {
  const { app, entry } = createVercelApp({ WG_HOSTED: host, WG_CONFIG_JSON: JSON.stringify(config), WG_READ_ONLY: mode });
  expect(entry).toHaveProperty("fetch");
  expect(await (await app.request("/healthz")).json()).toEqual({ ok: true });
  expect(await (await app.request("/api/config", { headers })).json()).toMatchObject({ readOnly: true, auth: false, link: null });
  expect((await app.request("/api/projects/p1/commands", { method: "POST", headers })).status).toBe(405);
  expect((await app.request("/api/link", { headers })).status).toBe(404);
});

it.each([
  ["WG_HOSTED", { WG_HOSTED: undefined }],
  ["auth", { WG_CONFIG_JSON: JSON.stringify(config) }],
  ["auth.owners", { WG_CONFIG_JSON: JSON.stringify({ ...config, auth: { domains: auth.domains } }) }],
  ["WG_AUTH_CLIENT_ID", { WG_AUTH_CLIENT_ID: undefined }],
  ["WG_AUTH_CLIENT_SECRET", { WG_AUTH_CLIENT_SECRET: undefined }],
  ["WG_SESSION_SECRET", { WG_SESSION_SECRET: undefined }],
  ["WG_LINK_TOKEN", { WG_LINK_TOKEN: undefined }],
  ["WG_REDIS_URL", { WG_REDIS_URL: undefined }],
] as const)("refuses each request when %s is missing", async (setting, override) => {
  const { app } = createVercelApp({ ...env, ...override });
  for (const path of ["/healthz", "/api/config", "/api/link"]) {
    const response = await app.request(path, { headers });
    expect(response.status).toBe(500);
    expect(await response.text()).toBe(`Vercel full page requires ${setting}`);
  }
});

async function sessionHeaders(email: string) {
  const value = Buffer.from(JSON.stringify({ email, hd: "example.com", exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url");
  const cookie = await serializeSigned("__Host-wg_session", value, env.WG_SESSION_SECRET, { secure: true, path: "/" });
  return { ...headers, cookie: cookie.split(";")[0], origin: `https://${host}`, "content-type": "application/json" };
}

it.skipIf(!testRedis)("serves owner writes and upgrades the link on the exported Node server", async () => {
  const redis = await startTestRedis();
  const { app, entry } = createVercelApp({ ...env, WG_REDIS_URL: redis.url, WG_REDIS_PREFIX: `test:${randomUUID()}` });
  let socket: WebSocket | undefined;
  try {
    const owner = await sessionHeaders("ada@example.com");
    const viewer = await sessionHeaders("viewer@example.com");
    await vi.waitFor(async () => {
      const response = await app.request("/api/status", { headers: { ...headers, authorization: `Bearer ${env.WG_LINK_TOKEN}` } });
      expect(await response.json()).toMatchObject({ readOnly: false, link: "/api/link", linkStore: "redis", redisReady: true });
    });
    expect(await (await app.request("/api/config", { headers: owner })).json()).toMatchObject({
      readOnly: false, role: "owner", link: "/api/link", linkStore: "redis",
    });
    for (const [actor, status] of [[owner, 200], [viewer, 405]] as const) {
      const response = await app.request("/api/projects/p1/commands", {
        method: "POST", headers: actor, body: JSON.stringify({ name: "next" }),
      });
      expect(response.status).toBe(status);
    }
    expect(entry).toBeInstanceOf(Server);
    if (!(entry instanceof Server)) throw new Error("expected a Node server");
    entry.listen(0, "127.0.0.1");
    await once(entry, "listening");
    const address = entry.address();
    if (!address || typeof address === "string") throw new Error("expected a TCP port");
    expect((await fetch(`http://127.0.0.1:${address.port}/healthz`)).status).toBe(200);
    socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/link?role=page`, { headers: owner });
    await once(socket, "open");
  } finally {
    socket?.terminate();
    if (entry instanceof Server && entry.listening) await new Promise<void>((resolve) => entry.close(() => resolve()));
    if ("link" in app) await app.link.shutdown();
    await redis.close();
  }
});
