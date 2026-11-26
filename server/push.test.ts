import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeSigned } from "hono/utils/cookie";
import { expect, test, vi } from "vitest";
import { createApp } from "./app.ts";
import { readVapid } from "./push.ts";
import { filePushStore } from "./pushstore.ts";

const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "jwk" });
const env = {
  WG_VAPID_PUBLIC_KEY: Buffer.concat([Buffer.from([4]), Buffer.from(key.x!, "base64url"), Buffer.from(key.y!, "base64url")]).toString("base64url"),
  WG_VAPID_PRIVATE_KEY: key.d!,
};
const host = "page.example.com";
const auth = { clientId: "client", clientSecret: "secret", secret: "a-session-secret-of-32-characters", owners: ["ada@example.com"], domains: ["example.com"] };
const methods = [["GET", "key"], ["GET", "devices"], ["POST", "devices"], ["DELETE", "devices/id"], ["GET", "settings"], ["PUT", "settings"]];

test("checks key file permissions before reading a pair", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wg-key-"));
  try {
    const file = join(dir, "keys");
    await writeFile(file, JSON.stringify({ publicKey: env.WG_VAPID_PUBLIC_KEY, privateKey: env.WG_VAPID_PRIVATE_KEY }), { mode: 0o600 });
    expect(readVapid({ WG_VAPID_FILE: file })?.publicKey).toBe(env.WG_VAPID_PUBLIC_KEY);
    await chmod(file, 0o644);
    expect(() => readVapid({ WG_VAPID_FILE: file })).toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("push routes check setup, session, role, origin, and device ownership", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wg-push-"));
  const deliveries: Promise<void>[] = [];
  const page = (pushEnv: NodeJS.ProcessEnv, stateDir: string) => createApp({ port: 443, tailnet: null, hosted: { host } }, {
    dist: "/unused", team: "WG", auth, readOnly: false, waitUntil: job => deliveries.push(job), stateDir, pushEnv, linkToken: "a-link-secret-of-at-least-32-characters", watchMs: 0,
  });
  const signed = async (email: string) => {
    const data = Buffer.from(JSON.stringify({ email, hd: "example.com", exp: Date.now() / 1000 + 600 })).toString("base64url");
    return (await serializeSigned("__Host-wg_session", data, auth.secret, { secure: true, path: "/" })).split(";")[0];
  };
  const owner = await signed(auth.owners[0]), viewer = await signed("viewer@example.com");
  try {
    for (const [app, enabled] of [[page({}, dir), false], [page(env, ""), false], [page(env, dir), true]] as const) {
      try {
        const request = (route: string, method: string, cookie: string, data?: unknown) => app.request("/api/push/" + route, {
          method, headers: { host, origin: "https://" + host, "content-type": "application/json", cookie },
          body: data === undefined ? undefined : JSON.stringify(data),
        });
        const config = await app.request("/api/config", { headers: { host, cookie: owner } });
        expect((await config.json()).push).toBe(enabled);
        for (const [method, route] of methods) {
          expect((await request(route, method, viewer)).status).toBe(enabled ? 403 : 503);
          expect((await request(route, method, "")).status).toBe(enabled ? 401 : 503);
        }
        if (!enabled) {
          expect((await request("notices", "POST", "")).status).toBe(503);
          expect((await request("devices/id/test", "POST", owner)).status).toBe(503);
          continue;
        }
        expect(await (await request("key", "GET", owner)).json()).toEqual({ publicKey: env.WG_VAPID_PUBLIC_KEY });
        expect((await request("devices", "POST", owner, {})).status).toBe(400);
        const device = { endpoint: "https://example.com/device", label: "Phone", keys: { auth: randomBytes(16).toString("base64url"), p256dh: env.WG_VAPID_PUBLIC_KEY } };
        expect((await request("devices", "POST", owner, device)).status).toBe(200);
        const { devices } = await (await request("devices", "GET", owner)).json();
        expect(devices).toEqual([{ label: "Phone", id: expect.any(String), time: expect.any(Number) }]);
        await request("settings", "PUT", owner, { enabled: false, kinds: [] });
        expect((await request("devices/" + devices[0].id + "/test", "POST", viewer)).status).toBe(403);
        expect((await request("devices/" + devices[0].id + "/test", "POST", owner)).status).toBe(202);
        expect((await request("devices/" + "0".repeat(64) + "/test", "POST", owner)).status).toBe(404);
        await Promise.all(deliveries);
        await request("settings", "PUT", owner, { enabled: true, kinds: ["decision", "merge", "question", "wait"] });
        expect((await request("devices/" + devices[0].id, "DELETE", owner)).status).toBe(200);
        expect(await (await request("devices", "GET", owner)).json()).toEqual({ devices: [] });
        expect(await (await request("settings", "GET", owner)).json()).toEqual({ enabled: true, kinds: ["decision", "merge", "question", "wait"] });
        const settings = { enabled: false, kinds: ["merge"] };
        expect((await request("settings", "PUT", owner, settings)).status).toBe(200);
        expect(await (await request("settings", "GET", owner)).json()).toEqual(settings);
      } finally { app.link.stop(); }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a shared collaborator registers in their own account and a shared viewer gets 403", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wg-members-"));
  const store = filePushStore(dir);
  const account = { id: "member", human: "Ada", workspaces: [] };
  const workspace = { id: "work", name: "Work", key: "", team: "WG", teamLabels: false };
  const shared = { owner: { ...account, id: "owner" }, name: "Project", projectId: "project", workspace };
  const app = createApp({ port: 443, tailnet: null, hosted: { host } }, {
    dist: "/unused", team: "WG", auth, readOnly: false, pushEnv: env, hostedPushStore: () => store, watchMs: 0,
    tenants: {
      fromSession: session => session && { tenant: account, role: "owner" }, fromToken: () => null,
      byId: () => account, onChange: () => () => {},
      sharedWorkspaces: async () => [{ ...shared, role: "collaborator", id: "shared:member" }, { ...shared, role: "viewer", id: "shared:viewer" }],
    },
  });
  try {
    const data = Buffer.from(JSON.stringify({ email: "ada@example.com", hd: "example.com", exp: Date.now() / 1000 + 600 })).toString("base64url");
    const cookie = (await serializeSigned("__Host-wg_session", data, auth.secret, { secure: true, path: "/" })).split(";")[0];
    const headers = { host, cookie, origin: "https://" + host, "content-type": "application/json" };
    for (const [method, route] of methods) {
      expect((await app.request("/api/push/" + route, { method, headers: { ...headers, "x-workspace": "shared:viewer" } })).status).toBe(403);
    }
    const body = JSON.stringify({ endpoint: "https://example.com/device", label: "Tablet", keys: { auth: randomBytes(16).toString("base64url"), p256dh: env.WG_VAPID_PUBLIC_KEY } });
    const request = (origin: string) => app.request("/api/push/devices", { method: "POST", body, headers: { ...headers, origin, "x-workspace": "shared:member" } });
    expect((await request("https://other.example.com")).status).toBe(403);
    expect((await request(headers.origin)).status).toBe(200);
    expect(await store.list("member")).toHaveLength(1);
    expect(await store.list("owner")).toEqual([]);
  } finally {
    app.link.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the notice route binds the token to its project, limits requests and returns before delivery finishes", async () => {
  const account = { id: "member", human: "Ada", workspaces: [] };
  const workspace = { id: "work", name: "Work", key: "", team: "WG", teamLabels: false };
  const shared = { owner: { ...account, id: "owner" }, name: "Project", projectId: "proj", workspace };
  let finish!: () => void;
  let listed = "";
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const jobs: Promise<void>[] = [];
  const app = createApp({ port: 443, tailnet: null, hosted: { host } }, {
    dist: "/unused", team: "WG", watchMs: 0, readOnly: false, pushEnv: env, now: () => 10,
    hostedPushStore: () => ({ ...filePushStore("/unused"), list: async account => { listed = account; await pending; return []; } }),
    waitUntil: job => { jobs.push(job); },
    tenants: { fromToken: token => token === "Bearer test" ? account : null, fromSession: () => null,
      byId: () => account, onChange: () => () => {}, sharedWorkspaces: async () => [{ ...shared, role: "collaborator", id: "shared:one" }] },
  });
  const request = (token: string, project = "proj", recipient?: string) => app.request("/api/push/notices", {
    method: "POST", headers: { host, authorization: token, "content-type": "application/json" },
    body: JSON.stringify({ workspace: "shared:one", project, kind: "merge", issue: "WG-1", recipient }),
  });
  try {
    expect((await request("wrong")).status).toBe(401);
    expect((await request("Bearer test", "other")).status).toBe(404);
    expect((await request("Bearer test", "proj", "other")).status).toBe(403);
    expect((await request("Bearer test")).status).toBe(202);
    expect(listed).toBe(account.id);
    expect(jobs).toHaveLength(1);
    for (let i = 3; i < 30; ++i) expect((await request("Bearer test")).status).toBe(202);
    expect((await request("Bearer test")).status).toBe(429);
  } finally { finish(); await Promise.all(jobs); app.link.stop(); }
});

test.each([
  [{ WG_VAPID_PUBLIC_KEY: "bad-public", WG_VAPID_PRIVATE_KEY: "bad-private" }, "WG_VAPID_PUBLIC_KEY and WG_VAPID_PRIVATE_KEY"],
  [{ WG_VAPID_FILE: "/unreadable/key-file" }, "WG_VAPID_FILE"],
])("bad VAPID settings leave the page available and push disabled", async (settings, label) => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const app = createApp({ port: 443, tailnet: null, hosted: { host } }, {
      dist: "/unused", team: "WG", pushEnv: settings, stateDir: "/unused-state", watchMs: 0,
    });
    try {
      const config = await app.request("/api/config", { headers: { host } });
      expect(config.status).toBe(200);
      expect((await config.json()).push).toBe(false);
      expect(warning.mock.calls).toEqual([["Push is off. Check " + label + "."]]);
      expect((await app.request("/api/push/notices", { method: "POST", headers: { host } })).status).toBe(503);
    } finally { app.link.stop(); }
  } finally { warning.mockRestore(); }
});
