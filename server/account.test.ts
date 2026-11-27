import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { WebSocket } from "ws";
import { RESTART_CODE } from "./link.ts";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, expect, it, vi } from "vitest";
import type { TeamSetupState } from "../src/lib/types.ts";
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
      ["PATCH", root], ["DELETE", root], ["POST", root + "/onboarding"],
      ["POST", root + "/tokens"], ["DELETE", root + "/tokens/id"],
    ]) {
      expect((await app.request(path, { method, headers: { host } })).status).toBe(404);
    }
  } finally { app.link.stop(); }
});

databaseSuites((open) => {
  it("creates a private sub-team and verifies the same team after a lost create response", async () => {
    const t = await setup();
    try {
      const { cookie } = await t.owner("owner");
      const { connections } = await (await t.request(root, cookie)).json();
      const path = attach + "/" + connections[0].id + "/teams";
      const parent = { id: "parent", key: "ORG", name: "Parent" };
      let team: Record<string, unknown> | undefined;
      let creates = 0;
      vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
        const { query, variables } = JSON.parse(String(init.body));
        let data;
        if (query.includes("teamCreate(")) {
          creates++;
          expect(variables.i.parentId).toBe(parent.id);
          team = { id: "child", key: "NEW", name: "Work", visibility: "public", parent };
          return new Response(null, { status: 503 });
        } else if (query.includes("teamUpdate(")) {
          expect(variables.i).toEqual({ private: true });
          team!.visibility = "private";
          data = { teamUpdate: { success: true } };
        } else if (query.includes("includeArchived")) {
          data = { team: { issues: { nodes: [] }, projects: { nodes: [] } } };
        } else {
          const found = variables.key === "ORG" ? parent : team;
          data = { teams: { nodes: found ? [found] : [] } };
        }
        return Response.json({ data });
      });
      const input = { key: "NEW", name: "Work", parent: "ORG", private: true };
      const refused = await t.request(path, cookie, "POST", input);
      expect(refused.status).toBe(502);
      const retry = await t.request(path, cookie, "POST", input);
      expect(await retry.json()).toMatchObject({ key: "NEW", name: "Work", private: true, parent: { key: "ORG", name: "Parent" } });
      expect(creates).toBe(1);
      expect((await (await t.request(root, cookie)).json()).connections[0].team).toBe("NEW");
    } finally { await t.close(); }
  });

  it("returns a copyable fallback on refusal and stops writing", async () => {
    const t = await setup();
    try {
      const { cookie } = await t.owner("owner");
      const { connections } = await (await t.request(root, cookie)).json();
      const path = attach + "/" + connections[0].id + "/teams";
      const input = { key: "WG", name: "--apply", private: true };
      const fallback = "wg setup --workspace work --team WG --name=--apply --private --apply";
      for (const [response, reason] of [
        [Response.json({ errors: [{ message: "original test-access", extensions: {
          type: "forbidden", userPresentableMessage: "No permission for test-access", code: "FORBIDDEN",
        } }] }), "No permission for [redacted]"],
        [new Response(null, { status: 403 }), "HTTP 403"],
        [Response.json({ errors: [{ message: "Feature not accessible" }] }), "Feature not accessible"],
      ] as const) {
        const fetch = vi.fn().mockResolvedValueOnce(Response.json({ data: { teams: { nodes: [] } } }))
          .mockResolvedValueOnce(response);
        vi.stubGlobal("fetch", fetch);
        const refused = await t.request(path, cookie, "POST", input);
        expect(refused.status).toBe(403);
        expect(await refused.json()).toEqual({ error: "Linear refused: " + reason, fallback });
        expect(fetch).toHaveBeenCalledTimes(2);
      }
      expect(t.output.join(" ")).toContain("original [redacted]");
      expect(t.output.join(" ")).not.toContain("test-access");
      const created = { id: "new", key: "WG", name: "--apply", visibility: "public", parent: null };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ data: { teams: { nodes: [] } } }))
        .mockResolvedValueOnce(Response.json({ data: { teamCreate: { success: true, team: created } } }))
        .mockResolvedValueOnce(new Response(null, { status: 403 })));
      const partial = await t.request(path, cookie, "POST", input);
      expect(partial.status).toBe(409);
      expect(await partial.json()).toMatchObject({ fallback, team: { key: "WG", private: false }, error: expect.stringContaining("private") });

      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "90" } })));
      const limited = await t.request(path, cookie, "POST", input);
      expect(limited.status).toBe(429);
      expect(limited.headers.get("Retry-After")).toBe("90");
    } finally { await t.close(); }
  });

  it.each([false, true])("reads labels and prevents duplicate creation with team scope %s", async teamLabels => {
    const t = await setup();
    try {
      const { cookie } = await t.owner("owner");
      const { connections, human } = await (await t.request(root, cookie)).json();
      const path = attach + "/" + connections[0].id + "/teams/WG/setup";
      const connection = attach + "/" + connections[0].id;
      expect((await t.request(connection, cookie, "PATCH", { team_labels: teamLabels })).status).toBe(200);
      const states = [{ name: "ready", type: "unstarted" }, { name: "Done", type: "started" }];
      const labels: { kind: string; id: string; name: string; team: { id: string } | null;
        parent: { id: string } | null; isGroup: boolean; groupType?: string }[] = [];
      const writes: string[] = [];
      const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false } });
      vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
        const { query, variables } = JSON.parse(String(init.body));
        let data;
        if (query.includes("teams(filter")) {
          data = { teams: page(variables.key === "WG" ? [{ id: "team", key: "WG", name: "Work", visibility: "public", triageEnabled: true }] : []) };
        } else if (query.includes("subscription")) {
          data = { organization: { subscription: { type: "business_monthly_16" } } };
        } else if (query.includes("states(first")) {
          data = { team: { states: page(states) } };
        } else if (query.includes("Create(input:")) {
          const kind = query.match(/(\w+)Create\(input:/)[1];
          const input = variables.i;
          const id = "item-" + writes.length;
          writes.push(input.name);
          if (kind === "workflowState") states.push(input);
          else labels.push({ ...input, id, kind, isGroup: !!input.isGroup,
            team: input.teamId ? { id: input.teamId } : null, parent: input.parentId ? { id: input.parentId } : null });
          data = { [kind + "Create"]: { success: true, [kind]: { id } } };
        } else {
          const kind = query.includes("issueLabels(") ? "issueLabel" : "projectLabel";
          const teamId = variables.f.team.id?.eq;
          data = { [kind + "s"]: page(labels.filter(l => l.kind === kind && l.team?.id === teamId)) };
        }
        return Response.json({ data });
      });
      const absent = await (await t.request(path.replace("/WG/", "/NEW/"), cookie)).json();
      expect(absent.team).toBeNull();
      expect([...absent.statuses, ...absent.labels].every(item => item.state === "missing")).toBe(true);
      const initial = await (await t.request(path, cookie)).json();
      expect(initial).toMatchObject({ fallback: "wg setup --workspace work --team WG --name=Work --apply", plan: { privateTeams: true, subTeams: true } });
      expect(initial.statuses).toEqual(expect.arrayContaining([
        { name: "Ready", type: "unstarted", state: "warn", detail: expect.stringContaining("ready") },
        { name: "Done", type: "completed", state: "warn", detail: expect.stringContaining("started") },
        { name: "Todo", type: "unstarted", state: "missing" },
        { name: "Duplicate", type: "duplicate", state: "warn", detail: expect.stringContaining("Linear manages") },
      ]));
      expect(writes).toEqual([]);
      const applied = await (await t.request(path, cookie, "POST")).json();
      expect(applied.created).toEqual(expect.arrayContaining(["Needs " + human, "agent:codex"]));
      expect(applied.warned).toEqual(expect.arrayContaining(["Ready", "Done", "Duplicate"]));
      expect(applied.state.statuses).toContainEqual({ name: "Needs " + human, type: "started", state: "exists" });
      expect(applied.state.labels).toContainEqual({ name: "agent:codex", scope: "workspace", group: "agent", state: "exists" });
      expect(applied.state.labels).toContainEqual({ name: "answered", scope: "workspace", state: "exists" });
      expect(labels.find(l => l.name === "answered")).toMatchObject({ team: null, parent: null });
      expect(labels.find(l => l.name === "ops")?.team).toEqual({ id: "team" });
      expect(labels.find(l => l.name === "agent:codex")).toMatchObject({
        team: null, parent: { id: labels.find(l => l.name === "agent")!.id },
      });
      const count = writes.length;
      expect(await (await t.request(path, cookie, "POST")).json()).toEqual({ ...applied, created: [] });
      expect(writes).toHaveLength(count);
      expect(writes).not.toContain("Ready");
      expect(writes).not.toContain("Done");
      labels.find(l => l.name === "answered")!.team = { id: "team" };
      expect((await t.request(connection, cookie, "PATCH", { team_labels: !teamLabels })).status).toBe(200);
      const mismatch = await (await t.request(path, cookie, "POST")).json();
      expect(mismatch.created).toEqual([]);
      expect(mismatch.state.suggestedProjectLabelScope).toBe(teamLabels ? "team" : "workspace");
      expect(mismatch.state.labels).toContainEqual(expect.objectContaining({
        name: "answered", state: "warn", detail: expect.stringContaining("workspace"),
      }));
      expect((await t.request(connection, cookie, "PATCH", { team_labels: teamLabels })).status).toBe(200);
      labels.splice(labels.findIndex(l => l.name === "supervised"), 1);
      const corrected: TeamSetupState = await (await t.request(path, cookie)).json();
      expect(corrected.suggestedProjectLabelScope).toBeUndefined();
      expect(corrected.labels.filter(item => item.scope === "project" && item.state !== "exists"))
        .toEqual([{ name: "supervised", scope: "project", group: "autonomy", state: "missing" }]);
    } finally { await t.close(); }
  });

  it("sends page and account events for each account in the listed workspace", async () => {
    const t = await setup({
      DD_API_KEY: "test-key", WG_SESSION_SECRET: auth.secret, WG_TELEMETRY_WORKSPACES: "work-id",
    });
    try {
      const { cookie } = await t.owner("usage");
      const legacy = await t.owner("legacy");
      await t.sql.query("UPDATE tenants SET send_usage_data = false WHERE id = $1", [legacy.accountId]);
      const personal = "lin_api_" + "x".repeat(30);
      t.identities.set(personal, { org: "personal", teams: ["WG"] });
      expect((await t.request(root + "/workspaces", cookie, "POST", { key: personal })).status).toBe(201);
      for (const workspace of ["work", "personal"]) {
        expect((await t.request("/api/events", cookie, "POST", { event: "node_opened", workspace })).status).toBe(204);
      }
      expect((await t.request(root + "/tokens", cookie, "POST", { name: "First token" })).status).toBe(201);
      await Promise.all(t.jobs);
      const messages = () => t.intake.flatMap((entry) => Array.isArray(entry) ? entry.map(({ message }) => message) : []);
      expect(messages()).toEqual(["node_opened", "token_created"]);
      expect((await t.request(root, cookie, "PATCH", { sendUsageData: false })).status).toBe(400);
      const update = await t.request(root, cookie, "PATCH", { human: "Ada", sendUsageData: false });
      expect(update.status).toBe(200);
      expect(await update.json()).not.toHaveProperty("sendUsageData");
      expect(await (await t.request(root, legacy.cookie)).json()).not.toHaveProperty("sendUsageData");
      expect((await t.request(root + "/tokens", legacy.cookie, "POST", { name: "Second token" })).status).toBe(201);
      for (const session of [cookie, legacy.cookie]) {
        expect((await t.request("/api/events", session, "POST", { event: "node_opened", workspace: "work" })).status).toBe(204);
      }
      await Promise.all(t.jobs);
      expect(messages()).toEqual(["node_opened", "token_created", "token_created", "node_opened", "node_opened"]);
    } finally { await t.close(); }
  });

  it("counts a sign-up once and uses the sign-in workspace for account events", async () => {
    const t = await setup({
      DD_API_KEY: "test-key", WG_SESSION_SECRET: auth.secret, WG_TELEMETRY_WORKSPACES: "work",
    });
    try {
      await t.signIn();
      await t.signIn();
      t.setSignInOrg("personal");
      const cookie = await t.signIn();
      const allowedKey = "lin_api_" + "x".repeat(30);
      t.identities.set(allowedKey, { org: "work", teams: ["WG"] });
      expect((await t.request(root + "/workspaces", cookie, "POST", { key: allowedKey })).status).toBe(201);
      expect((await t.request(root + "/tokens", cookie, "POST", { name: "Token" })).status).toBe(201);
      await Promise.all(t.jobs);
      expect(t.intake.flatMap((entry) => Array.isArray(entry) ? entry.map(({ message }) => message) : []))
        .toEqual(["sign_up", "sign_in", "sign_in", "workspace_attached"]);
    } finally { await t.close(); }
  });

  it("queues and claims the first connection once for repeated coordinator requests", async () => {
    const t = await setup({
      DD_API_KEY: "test-key", WG_SESSION_SECRET: auth.secret, WG_TELEMETRY_WORKSPACES: "work",
    });
    try {
      const claim = vi.spyOn(t.tenants.accounts, "claimFirstConnection");
      const { cookie, accountId } = await t.owner("coordinator");
      await t.sql.query("UPDATE tenants SET send_usage_data = false WHERE id = $1", [accountId]);
      const response = await t.request(root + "/tokens", cookie, "POST", { name: "Coordinator" });
      expect(response.status).toBe(201);
      const { token } = await response.json();
      await Promise.all(t.jobs);
      t.jobs.length = 0;

      for (let i = 0; i < 100; i++) {
        expect((await t.request("/api/status", "", "GET", undefined, { authorization: "Bearer " + token })).status).toBe(200);
      }
      await Promise.all(t.jobs);
      expect(t.jobs).toHaveLength(1);
      expect(claim).toHaveBeenCalledTimes(1);
      expect(t.intake.flatMap((entry) => Array.isArray(entry) ? entry.map(({ message }) => message) : []))
        .toContain("first_connection");
    } finally { await t.close(); }
  });

  async function setup(telemetryEnv: NodeJS.ProcessEnv = {}) {
    const sql = await open();
    await migrate(sql);
    const crypto = credentialCrypto({ WG_DATA_KEY: Buffer.alloc(32).toString("base64") });
    const tenants = dbTenants(sql, crypto, { linearAuth: auth });
    const jobs: Promise<void>[] = [];
    const app = createApp(rules, { ...options, linearAuth: auth, tenants, telemetryEnv, waitUntil: (job) => jobs.push(job) });
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
    let signInOrg = "work";
    const identities = new Map<string, { org: string; teams: string[]; plan?: string; parents?: Record<string, string> }>();
    const revoked = new Set<string>();
    const revocations: string[] = [];
    const intake: unknown[] = [];
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/api/v2/logs") || url.endsWith("/api/v2/series")) {
        intake.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 202 });
      }
      if (url.endsWith("/oauth/token")) {
        return Response.json({ access_token: "test-access", refresh_token: "test-refresh", expires_in: 3600 });
      }
      if (url.endsWith("/oauth/revoke")) {
        revocations.push((init.body as URLSearchParams).get("token")!);
        return new Response(null, { status: revoked.has("oauth") ? 503 : 200 });
      }
      expect(url).toBe("https://api.linear.app/graphql");
      const token = new Headers(init.headers).get("authorization")!;
      const { query, variables } = JSON.parse(String(init.body));
      const identity = token === "Bearer test-access" ? { org: signInOrg, teams: ["WG"] } : identities.get(token);
      if (revoked.has(token) || !identity) {
        return Response.json({ errors: [{ message: "Refused " + token.slice(-15) + " from " + token }] }, { status: 401 });
      }
      if (query.includes("subscription") && !query.includes("teams(")) {
        return Response.json({ data: { organization: { subscription: { type: "plan" in identity ? identity.plan : "free" } } } });
      }
      if (query.includes("projects(")) {
        expect(identity.teams).toContain(variables.k);
        return Response.json({ data: { teams: { nodes: [{ projects: {
          nodes: [{ id: identity.org + "-project", name: "Project" }],
          pageInfo: { hasNextPage: false, endCursor: null },
        } }] } } });
      }
      return Response.json({ data: {
        viewer: { id: "ada", name: "Ada", email: "ada@example.com" },
        organization: { id: identity.org + "-id", name: "Workspace", urlKey: identity.org },
        teams: { nodes: identity.teams.map((team) => ({ key: team, name: team, parent: "parents" in identity && identity.parents?.[team] ? { key: identity.parents[team] } : null })), pageInfo: { hasNextPage: false } },
      } });
    });
    vi.stubGlobal("fetch", fetch);
    async function request(path: string, cookie: string, method = "GET", body?: object, extra?: Record<string, string>) {
      const response = await app.request(path, {
        method, headers: { host, cookie, origin: "https://" + host, "content-type": "application/json", ...extra },
        body: body && JSON.stringify(body),
      });
      if (method !== "POST" || path !== root + "/tokens") output.push(await response.clone().text());
      return response;
    }
    return {
      app, owner, intake, jobs, output, identities,
      setSignInOrg(org: string) { signInOrg = org; }, revoked, fetch, tenants, sql, revocations, request,
      async signIn() {
        const login = await request("/auth/login", "");
        const state = new URL(login.headers.get("location")!).searchParams.get("state");
        const flow = login.headers.getSetCookie()[0].split(";")[0];
        const callback = await request("/auth/callback?code=test-code&state=" + state, flow);
        expect(callback.status).toBe(302);
        return callback.headers.getSetCookie().find((value) => value.startsWith("__Host-wg_session="))!.split(";")[0];
      },
      async close() { app.link.stop(); tenants.close(); await sql.close(); },
    };
  }

  it("saves the name and onboarding steps through the account routes", async () => {
    const t = await setup();
    try {
      const { cookie } = await t.owner("ada");
      const account = async () => (await t.request(root, cookie)).json();
      expect(await account()).toMatchObject({
        pageUrl: "https://" + host,
        onboarding: { name: false, workspaces: true, teams: true, token: false, connected: false, skipped: false },
      });
      for (const human of [" ", "a".repeat(41), "Ada\n", "A\u0085da", "A\u202Eda", "A\u2028da", null]) {
        expect((await t.request(root, cookie, "PATCH", { human })).status).toBe(400);
      }
      const response = await t.request(root, cookie, "PATCH", { human: "  Grace  " });
      expect(await response.json()).toMatchObject({ human: "Grace", message: expect.stringContaining("wg") });
      expect(await (await t.request("/api/config", cookie)).json()).toMatchObject({ human: "Grace" });
      expect((await t.request(root + "/onboarding", cookie, "POST", { name: true })).status).toBe(200);
      expect((await t.request(root + "/onboarding", cookie, "POST", { skipped: true })).status).toBe(200);
      expect((await account()).onboarding).toMatchObject({ name: true, skipped: true });
      expect((await t.request(root + "/onboarding", cookie, "POST", { skipped: false })).status).toBe(200);
      const personal = key();
      t.identities.set(personal, { org: "personal", teams: ["HOME", "SIDE"] });
      const { connection } = await (await t.request(attach, cookie, "POST", { key: personal })).json();
      expect((await account()).onboarding).toMatchObject({ name: true, skipped: false, teams: false });
      expect((await t.request(attach + "/" + connection.id, cookie, "PATCH", { team: "HOME" })).status).toBe(200);
      expect((await account()).onboarding.teams).toBe(true);
    } finally { await t.close(); }
  });

  it("saves the default agents of the account", async () => {
    const t = await setup();
    try {
      const { cookie } = await t.owner("ada");
      expect((await (await t.request(root, cookie)).json()).agents).toEqual({});
      for (const agents of [null, { worker: { effort: "high" } }, { worker: { agent: "pi" } }, { reviewer: {} }]) {
        expect((await t.request(root + "/agents", cookie, "PUT", { agents })).status).toBe(400);
      }
      const agents = { coordinator: { agent: "claude", model: "claude-opus-5-5", effort: "high" }, worker: { agent: "codex", model: "" } };
      expect(await (await t.request(root + "/agents", cookie, "PUT", { agents })).json())
        .toEqual({ agents: { coordinator: agents.coordinator, worker: { agent: "codex" } } });
      expect((await (await t.request(root, cookie)).json()).agents)
        .toEqual({ coordinator: agents.coordinator, worker: { agent: "codex" } });
    } finally { await t.close(); }
  });

  async function coordinatorSocket(app: ReturnType<typeof createApp>, token: string) {
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    app.injectWebSocket(server as Parameters<typeof app.injectWebSocket>[0]);
    if (!server.listening) await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/link?role=coordinator&project=work-project`, {
      headers: { host, authorization: "Bearer " + token },
    });
    const close = async () => {
      socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };
    try {
      await once(socket, "open");
      return { socket, close };
    } catch (error) {
      await close();
      throw error;
    }
  }

  it("shows a coordinator token once, records use, and closes its link at revoke", async () => {
    const t = await setup();
    try {
      const { accountId, cookie } = await t.owner("ada");
      const other = await t.owner("other");
      const path = root + "/tokens";
      expect((await t.request(path, cookie, "POST", { name: "De\u200Bsk\u2029" })).status).toBe(400);
      const created = await t.request(path, cookie, "POST", { name: "Desk" });
      expect(created.status).toBe(201);
      expect(created.headers.get("cache-control")).toBe("no-store");
      const { id, token, name } = await created.json();
      expect(name).toBe("Desk");
      const bearer = { authorization: "Bearer " + token };
      const account = async () => (await t.request(root, cookie)).json();
      expect((await account()).onboarding).toMatchObject({ token: true, connected: false });
      expect((await t.request("/api/status", "", "GET", undefined, bearer)).status).toBe(200);
      for (const [method, route] of [["GET", root], ["PATCH", root], ["DELETE", root],
        ["POST", path], ["DELETE", path + "/" + id], ["POST", root + "/onboarding"]]) {
        expect((await t.request(route, "", method, undefined, bearer)).status).toBe(401);
      }
      expect((await t.request(path + "/" + id, other.cookie, "DELETE")).status).toBe(404);
      expect((await account()).tokens).toEqual([{ id, name, createdAt: expect.any(String), lastUsedAt: expect.any(String) }]);
      const link = await coordinatorSocket(t.app, token);
      try {
        const closed = once(link.socket, "close");
        expect((await t.request(path + "/" + id, cookie, "DELETE")).status).toBe(200);
        expect((await closed)[0]).toBe(RESTART_CODE);
      } finally { await link.close(); }
      expect((await t.request("/api/status", "", "GET", undefined, bearer)).status).toBe(401);
      expect(await account()).toMatchObject({ tokens: [], onboarding: { token: false, connected: true } });
      for (let i = 0; i < 10; i++) expect((await t.request(path, cookie, "POST", { name: "Desk" })).status).toBe(201);
      expect((await t.request(path, cookie, "POST", { name: "Desk" })).status).toBe(409);
      const viewer = createApp(rules, { ...options, linearAuth: auth, tenants: {
        ...t.tenants, async fromSession() {
          const tenant = await t.tenants.byId(accountId);
          return tenant ? { tenant, role: "viewer" } : null;
        },
      } });
      try {
        const { connections } = await (await t.request(root, cookie)).json();
        const path = attach + "/" + connections[0].id + "/teams";
        const calls = t.fetch.mock.calls.length;
        for (const [method, endpoint] of [["POST", path], ["POST", path + "/WG/setup"], ["GET", path + "/WG/setup"]]) {
          const response = await viewer.request(endpoint, { method, headers: { host, cookie, origin: "https://" + host } });
          expect(response.status).toBe(403);
        }
        expect(t.fetch.mock.calls).toHaveLength(calls);
        expect((await viewer.request(root, { headers: { host, cookie } })).status).toBe(403);
      } finally { viewer.link.stop(); }
      const output = t.output.join("\n");
      expect(output).not.toContain(token);
      expect(output).not.toContain(createHash("sha256").update(token).digest("hex"));
    } finally { await t.close(); }
  });

  it.each([false, true])("deletes the account when Linear revoke fails = %s", async (fails) => {
    const t = await setup();
    try {
      const { accountId, cookie } = await t.owner("ada");
      const personal = key();
      t.identities.set(personal, { org: "personal", teams: ["HOME"] });
      expect((await t.request(attach, cookie, "POST", { key: personal })).status).toBe(201);
      const { token } = await (await t.request(root + "/tokens", cookie, "POST", { name: "Desk" })).json();
      expect((await t.request(root, cookie, "DELETE", { confirm: "wrong" })).status).toBe(400);
      expect((await t.request(root, cookie, "DELETE", { confirm: "delete" }, { origin: "https://other.example.com" })).status).toBe(403);
      expect(t.revocations).toEqual([]);
      if (fails) t.revoked.add("oauth");
      const link = await coordinatorSocket(t.app, token);
      try {
        const closed = once(link.socket, "close");
        const response = await t.request(root, cookie, "DELETE", { confirm: "delete" });
        expect(response.status).toBe(200);
        expect(response.headers.get("set-cookie")).toMatch(/__Host-wg_session=;.*Max-Age=0/);
        expect(await response.json()).toMatchObject({ ok: true, revoked: !fails, ...(fails ? { message: expect.stringContaining("Linear") } : {}) });
        expect((await closed)[0]).toBe(RESTART_CODE);
      } finally { await link.close(); }
      expect(t.revocations).toEqual(["test-refresh"]);
      expect((await t.request(root, cookie)).status).toBe(401);
      for (const table of ["users", "tenants", "linear_connections", "coordinator_tokens"]) {
        expect(await t.sql.query("SELECT id FROM " + table)).toEqual([]);
      }
      const nextCookie = await t.signIn();
      const tenants = await t.sql.query<{ id: string }>("SELECT id FROM tenants");
      expect(tenants).toHaveLength(1);
      expect(tenants[0].id).not.toBe(accountId);
      expect(await (await t.request(root, nextCookie)).json()).toMatchObject({
        connections: [{ kind: "oauth" }], tokens: [], onboarding: { connected: false, name: false, skipped: false },
      });
      expect((await t.request(root, cookie)).status).toBe(401);
      for (const secret of [personal, token, "test-access", "test-refresh"]) expect(t.output.join("\n")).not.toContain(secret);
    } finally { await t.close(); }
  });

  it("allows another write while revocation waits and deletes after its timeout", async () => {
    const t = await setup();
    try {
      const { cookie } = await t.owner("ada");
      let revocationSignal: AbortSignal | undefined;
      t.fetch.mockImplementationOnce(async (url, init) => {
        expect(url).toBe("https://api.linear.app/oauth/revoke");
        expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({
          token: "test-refresh", token_type_hint: "refresh_token",
        });
        revocationSignal = init.signal!;
        return new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
      });
      const deletion = t.request(root, cookie, "DELETE", { confirm: "delete" });
      await vi.waitFor(() => expect(revocationSignal).toBeDefined());
      expect((await t.request(root, cookie, "PATCH", { human: "Grace" })).status).toBe(200);
      expect(revocationSignal?.aborted).toBe(false);
      expect(await (await deletion).json()).toMatchObject({ ok: true, revoked: false });
      expect((await t.request(root, cookie)).status).toBe(401);
    } finally { await t.close(); }
  });

  it("keeps a new sign-in when an earlier delete finishes after another delete", async () => {
    const t = await setup();
    let finishRevocation: (() => void) | undefined;
    try {
      const { cookie } = await t.owner("ada");
      t.fetch.mockImplementationOnce(async () => new Promise<Response>((resolve) => {
        finishRevocation = () => resolve(new Response(null, { status: 200 }));
      }));
      const deletion = t.request(root, cookie, "DELETE", { confirm: "delete" });
      await vi.waitFor(() => expect(finishRevocation).toBeDefined());
      expect((await t.request(root, cookie, "DELETE", { confirm: "delete" })).status).toBe(200);
      const nextCookie = await t.signIn();
      finishRevocation!();
      expect((await deletion).status).toBe(404);
      expect((await t.request(root, cookie)).status).toBe(401);
      expect(await (await t.request(root, nextCookie)).json()).toMatchObject({
        connections: [{ kind: "oauth" }], tokens: [], onboarding: { connected: false },
      });
      for (const table of ["users", "tenants", "linear_connections"]) {
        expect(await t.sql.query("SELECT id FROM " + table)).toHaveLength(1);
      }
    } finally {
      finishRevocation?.();
      await t.close();
    }
  });

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
      expect(teams).toEqual([{ key: "HOME", name: "HOME", parent: null }, { key: "SIDE", name: "SIDE", parent: null }]);
      const path = attach + "/" + connection.id;
      for (const [method, suffix] of [["GET", "/teams"], ["PATCH", ""], ["PUT", "/key"], ["DELETE", ""]]) {
        expect((await t.request(path + suffix, other.cookie, method)).status).toBe(404);
      }
      expect((await t.request(attach, cookie, "POST", { key: personal }, { origin: "https://other.example.com" })).status).toBe(403);
      expect((await t.request(path, cookie, "PATCH", { team: "NO" })).status).toBe(400);
      expect((await t.request(path, cookie, "PATCH", { team: "HOME", team_labels: true, position: 0 })).status).toBe(200);
      // A plan with sub-teams accepts only a sub-team: a top-level team holds too many projects to load.
      Object.assign(t.identities.get(personal)!, { plan: "business_monthly", parents: { SIDE: "HOME" } });
      const topLevel = await t.request(path, cookie, "PATCH", { team: "HOME" });
      expect(topLevel.status).toBe(400);
      expect((await topLevel.json()).error).toMatch(/sub-team/);
      expect((await t.request(path, cookie, "PATCH", { team: "SIDE" })).status).toBe(200);
      expect((await t.request(path, cookie, "PATCH", { team: "HOME" })).status).toBe(400);
      Object.assign(t.identities.get(personal)!, { plan: undefined, parents: undefined });
      expect((await t.request(path, cookie, "PATCH", { team: "HOME" })).status).toBe(200);
      expect(await (await t.request(path + "/teams", cookie)).json()).toEqual({ teams });
      const projects = async () => (await t.request("/api/projects", cookie)).json();
      expect((await projects()).projects.map(({ id }: { id: string }) => id)).toContain("personal-project");
      expect((await t.request("/api/projects/personal-project/share", cookie, "POST", undefined, { "x-workspace": "personal" })).status).toBe(400);
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
      expect((await t.request(path, cookie, "PATCH", { team: "HOME" })).status).toBe(200);
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
