import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { WebSocket } from "ws";
import { RESTART_CODE } from "./link.ts";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "./app.ts";
import { credentialCrypto } from "./db/crypto.ts";
import { migrate } from "./db/migrations.ts";
import { dbTenants } from "./db/tenants.ts";
import { databaseSuites } from "./testing/sql.ts";
import { startTestRedis, testRedis } from "./testing/redis.ts";

const host = "page.example.com";
const rules = { port: 443, tailnet: null, hosted: { host } };
const auth = { clientId: "client", clientSecret: "test-secret", secret: "test-session-secret-of-32-characters" };
const options = { team: "", dist: "/unused/", watchMs: 0, readOnly: false };
const key = () => "lin_api_" + randomUUID().replaceAll("-", "");
const root = "/api/account";
const attach = root + "/workspaces";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("returns 404 for every account route in config mode", async () => {
  const app = createApp(rules, options);
  try {
    for (const [method, path] of [
      ["GET", root], ["POST", attach], ["PUT", attach + "/id/key"], ["PATCH", attach + "/id"],
      ["GET", attach + "/id/teams"], ["DELETE", attach + "/id"],
    ]) {
      expect((await app.request(path, { method, headers: { host } })).status).toBe(404);
    }
  } finally { app.link.stop(); }
});

databaseSuites((open) => {
  async function setup() {
    const sql = await open();
    await migrate(sql);
    const crypto = credentialCrypto({ WG_DATA_KEY: Buffer.alloc(32).toString("base64") });
    const tenants = dbTenants(sql, crypto, { linearAuth: auth });
    const app = createApp(rules, { ...options, linearAuth: auth, tenants });
    async function owner(user: string) {
      const accountId = await tenants.accounts.signIn({
        linearUserId: user, linearOrgId: "work-id", name: "Ada", email: "ada@example.com",
      }, {
        workspaceId: "work", linearOrgId: "work-id", name: "Work", team: "WG", teamLabels: false,
        credential: { kind: "oauth", key: "test-access", refreshToken: "test-refresh", expiresAt: new Date(Date.now() + 3600_000) },
      });
      const value = Buffer.from(JSON.stringify({
        accountId, id: randomUUID(), email: "ada@example.com", exp: Math.floor(Date.now() / 1000) + 600,
      })).toString("base64url");
      const signed = await serializeSigned("__Host-wg_session", value, auth.secret, { secure: true, path: "/" });
      return { accountId, cookie: signed.split(";")[0] };
    }
    const output: string[] = [];
    for (const level of ["log", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation((...args) => output.push(args.join(" ")));
    const identities = new Map<string, { org: string; teams: string[] }>();
    const revoked = new Set<string>();
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.linear.app/graphql");
      const token = new Headers(init.headers).get("authorization")!;
      const { query, variables } = JSON.parse(String(init.body));
      const identity = token === "Bearer test-access" ? { org: "work", teams: ["WG"] } : identities.get(token);
      if (revoked.has(token) || !identity) {
        return Response.json({ errors: [{ message: "Refused " + token.slice(-15) + " from " + token }] }, { status: 401 });
      }
      if (query.includes("projects(")) {
        expect(identity.teams).toContain(variables.k);
        return Response.json({ data: { teams: { nodes: [{ projects: {
          nodes: [{ id: identity.org + "-project", name: "Project" }],
          pageInfo: { hasNextPage: false, endCursor: null },
        } }] } } });
      }
      return Response.json({ data: {
        viewer: { name: "Ada" },
        organization: { id: identity.org + "-id", name: "Workspace", urlKey: identity.org },
        teams: { nodes: identity.teams.map((team) => ({ key: team, name: team })), pageInfo: { hasNextPage: false } },
      } });
    });
    vi.stubGlobal("fetch", fetch);
    return {
      app, owner, output, identities, revoked, fetch, tenants,
      async request(path: string, cookie: string, method = "GET", body?: object, extra?: Record<string, string>) {
        const response = await app.request(path, {
          method, headers: { host, cookie, origin: "https://" + host, "content-type": "application/json", ...extra },
          body: body && JSON.stringify(body),
        });
        output.push(await response.clone().text());
        return response;
      },
      async close() { app.link.stop(); tenants.close(); await sql.close(); },
    };
  }

  it("attaches a private workspace, checks its team, and removes it", async () => {
    const t = await setup();
    try {
      const { accountId, cookie } = await t.owner("ada");
      const other = await t.owner("other");
      const personal = key();
      t.identities.set(personal, { org: "personal", teams: ["HOME", "SIDE"] });
      const response = await t.request(attach, cookie, "POST", { key: personal });
      expect(response.status).toBe(201);
      const { connection, teams } = await response.json();
      expect(connection).toMatchObject({ workspace_id: "personal", kind: "api_key", status: "ok", team: "", owner_name: "Ada", created_at: expect.any(String) });
      expect(teams).toEqual([{ key: "HOME", name: "HOME" }, { key: "SIDE", name: "SIDE" }]);
      const path = attach + "/" + connection.id;
      for (const [method, suffix] of [["GET", "/teams"], ["PATCH", ""], ["PUT", "/key"], ["DELETE", ""]]) {
        expect((await t.request(path + suffix, other.cookie, method)).status).toBe(404);
      }
      expect((await t.request(attach, cookie, "POST", { key: personal }, { origin: "https://other.example.com" })).status).toBe(403);
      expect((await t.request(path, cookie, "PATCH", { team: "NO" })).status).toBe(400);
      expect((await t.request(path, cookie, "PATCH", { team: "HOME", team_labels: true, position: 0 })).status).toBe(200);
      expect(await (await t.request(path + "/teams", cookie)).json()).toEqual({ teams });
      const projects = async () => (await t.request("/api/projects", cookie)).json();
      expect((await projects()).projects.map(({ id }: { id: string }) => id)).toContain("personal-project");
      expect((await t.request("/api/projects/personal-project/share", cookie, "POST", { shared: true }, { "x-workspace": "personal" })).status).toBe(403);
      const { connections } = await (await t.request(root, cookie)).json();
      expect(connections[0]).toMatchObject({ team: "HOME", team_labels: true, position: 0 });
      expect((await t.request(attach + "/" + connections[1].id, cookie, "DELETE")).status).toBe(403);
      const viewer = createApp(rules, { ...options, linearAuth: auth, tenants: t.tenants, readOnly: true });
      try {
        expect((await viewer.request(root, { headers: { host, cookie } })).status).toBe(403);
      } finally { viewer.link.stop(); }
      const token = await t.tenants.accounts.createToken(other.accountId, "Coordinator");
      expect((await t.request(root, "", "GET", undefined, { authorization: "Bearer " + token.token })).status).toBe(401);
      const coordinator = await t.tenants.accounts.createToken(accountId, "Coordinator");
      const server = serve({ fetch: t.app.fetch, port: 0, hostname: "127.0.0.1" });
      t.app.injectWebSocket(server as Parameters<typeof t.app.injectWebSocket>[0]);
      if (!server.listening) await once(server, "listening");
      const socket = new WebSocket(
        `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/link?role=coordinator&workspace=personal&project=personal-project`,
        { headers: { host, authorization: "Bearer " + coordinator.token } },
      );
      try {
        await once(socket, "open");
        socket.send(JSON.stringify({ v: 1, type: "hello", payload: { session: "test-session" } }));
        await vi.waitFor(async () => {
          const status = await (await t.request("/api/status", cookie)).json();
          expect(status.rooms).toMatchObject([{ workspace: "personal", project: "personal-project", coordinators: 1 }]);
        });
        const closed = once(socket, "close");
        expect((await t.request(path, cookie, "DELETE")).status).toBe(200);
        expect((await closed)[0]).toBe(RESTART_CODE);
        await t.app.link.check();
        const status = await (await t.request("/api/status", cookie)).json();
        expect(status.rooms).toEqual([]);
      } finally {
        socket.terminate();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      expect((await projects()).workspaces.map(({ id }: { id: string }) => id)).toEqual(["work"]);
      expect(t.output.join("\n")).not.toContain(personal);
    } finally { await t.close(); }
  });

  it("refuses invalid credentials and repairs only the rejected workspace", async () => {
    const t = await setup();
    try {
      const { cookie } = await t.owner("ada");
      const original = key(), replacement = key(), wrong = key(), duplicate = key(), empty = key(), rejected = key();
      t.identities.set(original, { org: "personal", teams: ["HOME"] });
      t.identities.set(replacement, { org: "personal", teams: ["HOME"] });
      t.identities.set(wrong, { org: "other", teams: ["OTHER"] });
      t.identities.set(duplicate, { org: "work", teams: ["WG"] });
      t.identities.set(empty, { org: "empty", teams: [] });
      expect((await t.request(attach, cookie, "POST", { key: "bad" })).status).toBe(400);
      expect(t.fetch).not.toHaveBeenCalled();
      for (const candidate of [rejected, duplicate, empty]) {
        expect((await t.request(attach, cookie, "POST", { key: candidate })).status).toBe(candidate === duplicate ? 409 : 400);
      }
      const list = async () => (await (await t.request(root, cookie)).json()).connections;
      expect(await list()).toHaveLength(1);
      const { connection } = await (await t.request(attach, cookie, "POST", { key: original })).json();
      const path = attach + "/" + connection.id;
      expect((await t.request(path + "/key", cookie, "PUT", { key: wrong })).status).toBe(400);
      t.revoked.add(original);
      const refused = await (await t.request("/api/projects", cookie)).json();
      expect(refused.workspaces).toMatchObject([{ id: "work" }]);
      expect(refused.workspaces).toHaveLength(1);
      expect((await list()).map(({ status }: { status: string }) => status)).toEqual(["ok", "needs_key"]);
      const projects = async () => (await (await t.request("/api/projects", cookie)).json()).workspaces;
      expect(await projects()).toMatchObject([{ id: "work" }]);
      expect((await t.request(path + "/key", cookie, "PUT", { key: replacement })).status).toBe(200);
      expect((await list()).map(({ status }: { status: string }) => status)).toEqual(["ok", "ok"]);
      expect(await projects()).toMatchObject([{ id: "work" }, { id: "personal" }]);
      for (const secret of [original, replacement, wrong, duplicate, empty, rejected]) {
        expect(t.output.join("\n")).not.toContain(secret.slice(-15));
      }
    } finally { await t.close(); }
  });

  it.skipIf(!testRedis)("shares the key attempt limit across service instances through Redis", async () => {
    const t = await setup();
    const redis = await startTestRedis();
    const redisOptions = { redisUrl: redis.url, redisPrefix: "test:" + randomUUID() + ":" };
    const serviceOptions = { ...options, ...redisOptions, linearAuth: auth, tenants: t.tenants };
    const first = createApp(rules, serviceOptions);
    const second = createApp(rules, serviceOptions);
    try {
      const { cookie } = await t.owner("ada");
      const attempt = (app: typeof first) => app.request(attach, {
        method: "POST", headers: { host, cookie, origin: "https://" + host, "content-type": "application/json" },
        body: JSON.stringify({ key: key() }),
      });
      for (let i = 0; i < 10; i++) expect((await attempt(first)).status).toBe(400);
      const limited = await attempt(second);
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(t.fetch).toHaveBeenCalledTimes(10);
    } finally {
      first.link.stop();
      second.link.stop();
      await redis.close();
      await t.close();
    }
  });

  it("limits both connections and credential attempts", async () => {
    const t = await setup();
    try {
      const { cookie } = await t.owner("ada");
      for (let i = 0; i < 10; i++) {
        const candidate = key();
        t.identities.set(candidate, { org: "workspace-" + i, teams: ["WG"] });
        expect((await t.request(attach, cookie, "POST", { key: candidate })).status).toBe(i < 9 ? 201 : 409);
      }
      const { connections } = await (await t.request(root, cookie)).json();
      expect(connections).toHaveLength(10);
      const limited = await t.request(attach + "/" + connections[1].id + "/key", cookie, "PUT", { key: key() });
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBeTruthy();
    } finally { await t.close(); }
  });
});
