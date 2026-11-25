import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { serializeSigned } from "hono/utils/cookie";
import { createApp } from "./app.ts";
import { credentialCrypto } from "./db/crypto.ts";
import { migrate } from "./db/migrations.ts";
import { dbTenants } from "./db/tenants.ts";
import { databaseSuites } from "./testing/sql.ts";

const host = "page.example.com";
const secret = "test-session-secret-of-32-characters";
const access = "test-access-credential";
const refresh = "test-refresh-credential";
const code = "test-authorization-code";
const now = Date.now();
const auth = { clientId: "client", clientSecret: "test-client-secret", secret, allowedOrgs: ["work"] };
const rules = { port: 443, tailnet: null, hosted: { host } };

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each(["WG_HOSTED", "WG_DATA_KEY", "WG_SESSION_SECRET", "WG_LINEAR_CLIENT_ID", "WG_LINEAR_CLIENT_SECRET"])(
  "stops the Node service when %s is missing", (name) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env, DATABASE_URL: "postgres://example.com/database", WG_HOSTED: host,
      WG_DATA_KEY: Buffer.alloc(32).toString("base64"), WG_LINEAR_CLIENT_ID: auth.clientId,
      WG_LINEAR_CLIENT_SECRET: auth.clientSecret, WG_SESSION_SECRET: secret,
    };
    delete env[name];
    const result = spawnSync(process.execPath, ["server/main.ts", "--hosted", host], { env, encoding: "utf8", timeout: 5000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`The service requires ${name}`);
    expect(result.stderr).not.toContain(secret);
  },
);

databaseSuites((open) => {
  it("signs in, isolates accounts, rotates credentials, and repairs a refused refresh", async () => {
    const sql = await open();
    const crypto = credentialCrypto({ WG_DATA_KEY: Buffer.alloc(32).toString("base64") });
    const tenants = dbTenants(sql, crypto, { linearAuth: auth, now: () => now });
    const other = dbTenants(sql, crypto, { linearAuth: auth, now: () => now });
    const options = { team: "", dist: "/unused/", watchMs: 0, readOnly: false, linearAuth: auth, now: () => now };
    const app = createApp(rules, { ...options, tenants });
    const second = createApp(rules, { ...options, tenants: other });
    const request = (path: string, cookie?: string, server = app) =>
      server.request(`https://${host}${path}`, { headers: { host, ...(cookie ? { cookie } : {}) } });
    let user = "ada", org = "work", issued = 0, refreshed = 0, fail = false, refuse = false, rejectAccess = "";
    const output: string[] = [];
    for (const level of ["log", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation((...args) => output.push(args.join(" ")));
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      const form = init.body as URLSearchParams;
      if (url.endsWith("/oauth/token")) {
        if (form.get("grant_type") === "refresh_token") {
          refreshed++;
          expect(form.get("refresh_token")).toContain(refresh);
          if (refuse) return Response.json({ error: "invalid_grant", error_description: refresh }, { status: 400 });
          return Response.json({ access_token: access + "new" + refreshed, refresh_token: refresh + refreshed, expires_in: 86400 });
        }
        if (fail) return Response.json({ error: code }, { status: 400 });
        expect(form.get("code")).toBe(code);
        expect(form.get("code_verifier")).toBeTruthy();
        return Response.json({ access_token: access + ++issued, refresh_token: refresh + issued, expires_in: 200 });
      }
      const header = new Headers(init.headers).get("authorization")!;
      expect(header).toMatch(/^Bearer test-access-credential/);
      const { query, variables } = JSON.parse(String(init.body));
      if (query.includes("viewer")) return Response.json({ data: {
        viewer: { id: user, name: "Ada", email: "ada@example.com" },
        organization: { id: "org", name: "Work", urlKey: org },
        teams: { nodes: [{ key: "WG" }] },
      } });
      if (header === rejectAccess) return Response.json({ error: access }, { status: 401 });
      expect(variables.k).toBe("WG");
      return Response.json({ data: { teams: { nodes: [{ projects: {
        nodes: [{ id: header.endsWith("3") && !header.includes("new") ? "other" : "first", name: "Project" }],
        pageInfo: { hasNextPage: false, endCursor: null },
      } }] } } });
    });
    vi.stubGlobal("fetch", fetch);
    async function start() {
      const login = await request("/auth/login?next=//other.example.com");
      const location = new URL(login.headers.get("location")!);
      const flow = login.headers.getSetCookie()[0].split(";")[0];
      expect(location.origin).toBe("https://linear.app");
      expect(location.searchParams.get("actor")).toBe("user");
      expect(location.searchParams.get("code_challenge_method")).toBe("S256");
      const payload = JSON.parse(Buffer.from(flow.split("=")[1].split(".")[0], "base64url").toString());
      expect(location.searchParams.get("code_challenge")).toBe(createHash("sha256").update(payload.verifier).digest("base64url"));
      return { flow, state: location.searchParams.get("state")! };
    }
    async function callback(flow: string, state?: string) {
      const response = await request(`/auth/callback?code=${code}${state ? "&state=" + state : ""}`, flow);
      output.push(response.headers.get("location") ?? "", await response.clone().text());
      return response;
    }
    async function signIn() {
      const { flow, state } = await start();
      const response = await callback(flow, state);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`https://${host}/`);
      return response.headers.getSetCookie().find((value) => value.startsWith("__Host-wg_session="))!.split(";")[0];
    }
    try {
      await migrate(sql);
      const { flow, state } = await start();
      expect((await callback(flow, "wrong")).status).toBe(400);
      expect((await callback(flow)).status).toBe(400);
      const missing = (await serializeSigned("__Host-wg_signin", Buffer.from(JSON.stringify({ state, expiresAt: now + 1000 })).toString("base64url"),
        secret, { path: "/", secure: true })).split(";")[0];
      expect((await callback(missing, state)).status).toBe(400);
      fail = true;
      expect((await callback(flow, state)).status).toBe(502);
      fail = false;
      org = "closed";
      expect((await callback(flow, state)).status).toBe(403);
      expect(await sql.query("SELECT id FROM users")).toEqual([]);
      org = "work";
      issued = 0;
      const first = await signIn();
      const again = await signIn();
      const [{ tenant, id, credential }] = await sql.query<{ tenant: string; id: string; credential: string }>(
        "SELECT tenant_id AS tenant, id, credential FROM linear_connections");
      expect(credential).not.toContain(access);
      expect(await tenants.accounts.readCredential(tenant, id)).toMatchObject({ key: access + "2", refreshToken: refresh + "2" });
      expect(await sql.query("SELECT id FROM users")).toHaveLength(1);
      expect(await sql.query("SELECT id FROM tenants")).toHaveLength(1);
      expect(await sql.query("SELECT id FROM linear_connections")).toHaveLength(1);
      const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => request("/api/projects", first, i % 2 ? app : second)));
      for (const response of responses) expect(await response.json()).toMatchObject({ projects: [{ id: "first", workspace: "work" }] });
      expect(refreshed).toBe(1);
      rejectAccess = "Bearer " + access + "new1";
      expect((await request("/api/projects", again)).status).toBe(200);
      expect(refreshed).toBe(2);
      user = "other";
      const another = await signIn();
      expect(await sql.query("SELECT id FROM tenants")).toHaveLength(2);
      expect(await (await request("/api/config", another)).json()).toMatchObject({ user: "ada@example.com", defaultWorkspace: "work", signIn: "linear" });
      // Make this token usable without a refresh so the stub can distinguish the users.
      await tenants.accounts.replaceCredential((await sql.query<{ id: string }>("SELECT id FROM tenants WHERE id <> $1", [tenant]))[0].id,
        (await sql.query<{ id: string }>("SELECT id FROM linear_connections WHERE id <> $1", [id]))[0].id,
        { kind: "oauth", key: access + "3", refreshToken: refresh + "3", expiresAt: new Date(now + 86400000) });
      expect(await (await request("/api/projects", another)).json()).toMatchObject({ projects: [{ id: "other" }] });
      await app.link.hub.joinPage({ close: () => {}, send: () => {} }, { tenant, workspace: "work", id: "first" }, undefined, tenant);
      expect(await (await request("/api/status", first)).json()).toMatchObject({ rooms: [{ project: "first", workspace: "work" }] });
      expect(await (await request("/api/status", another)).json()).toMatchObject({ rooms: [] });
      refuse = true;
      rejectAccess = "Bearer " + access + "new2";
      const denied = await request("/api/projects", first);
      expect(denied.status).toBe(401);
      expect(await denied.json()).toMatchObject({ login: "/auth/login" });
      expect(await sql.query("SELECT status, credential, refresh_token FROM linear_connections WHERE id = $1", [id]))
        .toEqual([{ status: "needs_key", credential: null, refresh_token: null }]);
      expect((await request("/api/projects", first)).status).toBe(401);
      expect(await (await request("/api/config", first)).json()).toMatchObject({ user: null, signIn: "linear", link: null });
      user = "ada";
      refuse = false;
      const repaired = await signIn();
      expect((await request("/api/projects", repaired)).status).toBe(200);
      await request("/auth/logout", repaired);
      expect((await request("/api/projects", repaired)).status).toBe(401);
      expect((await request("/api/projects", again)).status).toBe(200);
      for (const sensitive of [access, refresh, code, auth.clientSecret, secret]) expect(output.join("\n")).not.toContain(sensitive);
    } finally {
      app.link.stop();
      second.link.stop();
      tenants.close();
      other.close();
      await sql.close();
    }
  });
});
