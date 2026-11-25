import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { Server } from "node:http";
import { serializeSigned } from "hono/utils/cookie";
import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { startTestRedis, testRedis } from "./testing/redis.ts";
import vercelConfig from "../vercel.json";
import { createVercelApp, VERCEL_MAX_DURATION, vercelLinkSettings } from "./vercel.ts";
import * as tenantService from "./tenants.ts";
import { dbTenants } from "./db/tenants.ts";
import { credentialCrypto } from "./db/crypto.ts";
import { migrate } from "./db/migrations.ts";
import { pgliteSql } from "./testing/sql.ts";

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

it.each(["WG_HOSTED", "WG_DATA_KEY", "WG_SESSION_SECRET", "WG_LINEAR_CLIENT_ID", "WG_LINEAR_CLIENT_SECRET", "WG_REDIS_URL"])(
  "refuses to start the service without %s", async (name) => {
    const { app } = createVercelApp({
      ...env, DATABASE_URL: "postgres://example.com/database",
      WG_DATA_KEY: Buffer.alloc(32).toString("base64"), WG_LINEAR_CLIENT_ID: "linear-client",
      WG_LINEAR_CLIENT_SECRET: "linear-client-secret", [name]: undefined,
    });
    const response = await app.request("/healthz");
    expect(response.status).toBe(500);
    expect(await response.text()).toBe(`Vercel full page requires ${name}`);
  },
);

it("waits for service migrations and starts without the config installation", async () => {
  const sql = await pgliteSql();
  const serviceEnv = {
    ...env, DATABASE_URL: "postgres://example.com/database", WG_CONFIG_JSON: "{",
    WG_DATA_KEY: Buffer.alloc(32).toString("base64"), WG_LINEAR_CLIENT_ID: "linear-client",
    WG_LINEAR_CLIENT_SECRET: "linear-client-secret", WG_LINK_TOKEN: undefined,
  };
  const open = vi.spyOn(tenantService, "openServiceTenants").mockImplementation(async (_env, linearAuth) => {
    await migrate(sql);
    const tenants = dbTenants(sql, credentialCrypto(serviceEnv), { linearAuth });
    return { ...tenants, close: async () => { tenants.close(); } };
  });
  const { app, entry } = createVercelApp(serviceEnv);
  try {
    expect(entry).toBeInstanceOf(Server);
    const [configResponse, login] = await Promise.all([app.request("/api/config", { headers }), app.request("/auth/login", { headers })]);
    expect(await configResponse.json()).toMatchObject({ auth: true, signIn: "linear", user: null, readOnly: false });
    expect(new URL(login.headers.get("location")!).origin).toBe("https://linear.app");
    expect(await sql.query("SELECT id FROM tenants")).toEqual([]);
    expect(open).toHaveBeenCalledTimes(1);
  } finally {
    if ("link" in app) app.link.stop();
    if (open.mock.results[0]) await (await open.mock.results[0].value).close();
    open.mockRestore();
    await sql.close();
  }
});

it.each([undefined, "1", "", "true", "false", " 0", "00"])("serves the viewer with WG_READ_ONLY=%s", async (mode) => {
  const { app, entry } = createVercelApp({ WG_HOSTED: host, WG_CONFIG_JSON: JSON.stringify(config), WG_READ_ONLY: mode });
  expect(entry).toHaveProperty("fetch");
  expect(await (await app.request("/healthz")).json()).toEqual({ ok: true });
  expect(await (await app.request("/api/config", { headers })).json()).toMatchObject({ readOnly: true, auth: false, link: null });
  expect((await app.request("/api/projects/p1/commands", { method: "POST", headers })).status).toBe(405);
  expect((await app.request("/api/link", { headers })).status).toBe(404);
});

it("keeps the signed-in viewer's config and read-only routes", async () => {
  const { app } = createVercelApp({ ...env, WG_READ_ONLY: "1", WG_REDIS_URL: undefined, WG_VERSION: "test" });
  const actor = await sessionHeaders("ada@example.com");
  expect(await (await app.request("/api/config", { headers: actor })).json()).toEqual({
    human: expect.any(String), defaultWorkspace: "work", contract: expect.any(String), version: "test",
    readOnly: true, auth: true, user: "ada@example.com", role: "viewer", link: null,
  });
  expect((await app.request("/api/projects", { headers })).status).toBe(401);
  expect((await app.request("/api/projects/p1/commands", { method: "POST", headers: actor })).status).toBe(405);
  expect((await app.request("/api/link", { headers: actor })).status).toBe(404);
});

it.each([undefined, "", "  "])("uses a 270-second age when the age is %s", (age) => {
  expect(vercelConfig.functions["api/index.ts"].maxDuration).toBe(VERCEL_MAX_DURATION);
  expect(vercelLinkSettings({ WG_LINK_MAX_AGE: age }).linkMaxAgeMs).toBe(270_000);
});

it("accepts a socket age exactly 20 seconds below the duration", () => {
  expect(vercelLinkSettings({ WG_LINK_MAX_AGE: "280" }).linkMaxAgeMs).toBe(280_000);
});

it("exports the viewer handler from the Vercel entry", async () => {
  vi.stubEnv("WG_HOSTED", host);
  vi.stubEnv("WG_CONFIG_JSON", JSON.stringify(config));
  vi.stubEnv("WG_READ_ONLY", "1");
  vi.stubEnv("WG_LINK_TOKEN", undefined);
  vi.stubEnv("WG_REDIS_URL", undefined);
  try {
    const { default: entry } = await import("../api/index.ts");
    if (entry instanceof Server) throw new Error("expected the viewer handler");
    expect(await (await entry.fetch(new Request(`https://${host}/healthz`))).json()).toEqual({ ok: true });
  } finally {
    vi.unstubAllEnvs();
  }
});

it.each([
  ["WG_HOSTED", { WG_HOSTED: undefined }],
  ["WG_HOSTED", { WG_HOSTED: "https://page.example.com/" }],
  ["auth", { WG_CONFIG_JSON: JSON.stringify(config) }],
  ["auth.owners", { WG_CONFIG_JSON: JSON.stringify({ ...config, auth: { domains: auth.domains } }) }],
  ["auth.domains", { WG_CONFIG_JSON: JSON.stringify({ ...config, auth: { owners: auth.owners } }) }],
  ["WG_CONFIG_JSON", { WG_CONFIG_JSON: "{test-secret" }],
  ["WG_AUTH_CLIENT_ID", { WG_AUTH_CLIENT_ID: undefined }],
  ["WG_AUTH_CLIENT_SECRET", { WG_AUTH_CLIENT_SECRET: undefined }],
  ["WG_AUTH_CLIENT_SECRET", { WG_AUTH_CLIENT_SECRET: " " }],
  ["WG_SESSION_SECRET", { WG_SESSION_SECRET: undefined }],
  ["WG_SESSION_SECRET", { WG_SESSION_SECRET: "short-secret" }],
  ["WG_LINK_TOKEN", { WG_LINK_TOKEN: undefined }],
  ["WG_LINK_TOKEN", { WG_LINK_TOKEN: "short-token" }],
  ["WG_REDIS_URL", { WG_REDIS_URL: undefined }],
  ["WG_REDIS_URL", { WG_REDIS_URL: "https://:test-password@example.com" }],
  ["WG_LINK_MAX_AGE", { WG_LINK_MAX_AGE: "0" }],
  ["WG_LINK_MAX_AGE", { WG_LINK_MAX_AGE: "59" }],
  ["WG_LINK_MAX_AGE", { WG_LINK_MAX_AGE: "281" }],
  ["WG_LINK_MAX_AGE", { WG_LINK_MAX_AGE: "test-secret" }],
  ["WG_LINK_PONG_MS", { WG_LINK_PONG_MS: "24999" }],
] as const)("refuses each request when %s is missing or invalid (%j)", async (setting, override) => {
  const { app } = createVercelApp({ ...env, ...override });
  for (const [method, path] of [
    ["GET", "/healthz"], ["GET", "/api/config"], ["GET", "/api/link"], ["GET", "/auth/login"],
    ["POST", "/api/projects/p1/commands"],
  ]) {
    const response = await app.request(path, { method, headers });
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
    }, { timeout: 3_000 });
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

it("keeps health and status available when Redis is lost", async () => {
  const { app } = createVercelApp({ ...env, WG_REDIS_URL: "redis://127.0.0.1:1" });
  try {
    expect((await app.request("/healthz")).status).toBe(200);
    const status = await app.request("/api/status", { headers: { ...headers, authorization: `Bearer ${env.WG_LINK_TOKEN}` } });
    expect(await status.json()).toMatchObject({ readOnly: false, linkStore: "redis", redisReady: false });
    expect((await app.request("/healthz")).status).toBe(200);
  } finally {
    if ("link" in app) await app.link.shutdown();
  }
});
