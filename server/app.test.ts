import { api as browserApi } from "../src/api.ts";
import { configureSite, site } from "../src/lib/site.ts";
import { connectRedis } from "./redis.ts";
import { localRedis, startLocalRedis } from "./testing/redis.ts";
import { testTenants } from "./testing/tenants.ts";
import { pgliteSql } from "./testing/pglite.ts";
import { credentialCrypto } from "./db/crypto.ts";
import { migrate } from "./db/migrations.ts";
import { dbTenants } from "./db/tenants.ts";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { serve } from "@hono/node-server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { serializeSigned } from "hono/utils/cookie";
import type { Rules } from "./access.ts";
import { SLOW_MS, contractHash, createApp } from "./app.ts";
import { setTransport } from "./linear.ts";
import { DEAD_MS, linkSettings, PING_MS, RESTART_CODE, stopOnSignals, type Timers } from "./link.ts";
import { memoryLinkBus } from "./linkbus.ts";
import { memoryLinkState } from "./linkstate.ts";

const rules: Rules = { port: 4747, tailnet: null };
const local = { host: "127.0.0.1:4747" };
const write = { ...local, origin: "http://127.0.0.1:4747", "content-type": "application/json" };
let dist: string;

it("uses defaults for blank link settings and accepts valid limits", () => {
  expect(linkSettings({ WG_LINK_MAX_AGE: " ", WG_LINK_PONG_MS: "" }))
    .toEqual({ linkMaxAgeMs: undefined, linkPongMs: undefined });
  expect(linkSettings({ WG_LINK_MAX_AGE: "60", WG_LINK_PONG_MS: "25000" }))
    .toEqual({ linkMaxAgeMs: 60_000, linkPongMs: 25_000 });
  expect(linkSettings({ WG_LINK_MAX_AGE: "0", WG_LINK_PONG_MS: "0" }))
    .toEqual({ linkMaxAgeMs: 0, linkPongMs: 0 });
});

it.each([
  ["WG_LINK_MAX_AGE", "59"], ["WG_LINK_MAX_AGE", "bad"], ["WG_LINK_MAX_AGE", "Infinity"],
  ["WG_LINK_PONG_MS", "24999"], ["WG_LINK_PONG_MS", "300001"], ["WG_LINK_PONG_MS", "bad"],
])("rejects an invalid %s value of %s", (name, value) => {
  expect(() => linkSettings({ [name]: value })).toThrow(name);
});

beforeAll(async () => {
  dist = (await mkdtemp(join(tmpdir(), "wg-ui-"))) + sep;
  await mkdir(join(dist, "assets"));
  await writeFile(join(dist, "index.html"), "<html>wg</html>");
  await writeFile(join(dist, "assets", "app.js"), "console.log(1)");
  // gql tries a failed query again after a delay: the tests do not wait for it.
  setTransport({ sleep: async () => {} });
});
afterEach(() => vi.unstubAllGlobals());

// The one workspace of most tests. Its key is read when the app is made, as the server reads its config.
const workWorkspace = () => ({ id: "work", name: "Work", team: "CD", key: process.env.LINEAR_API_KEY ?? "", teamLabels: true });
const app = (linkToken?: string) => createApp(rules, { team: "CD", dist, workspaces: [workWorkspace()], linkToken });
/** An issue that the page may change: in a project of the served team, with no node card. */
const mine = { team: { key: "CD" }, project: { id: "p1" }, description: "", labels: { nodes: [] }, comments: { nodes: [] } };
/** A fetch stub that answers each Linear call with `data`, and records the GraphQL variables. */
function linear(data: unknown) {
  const calls: Record<string, unknown>[] = [];
  vi.stubEnv("LINEAR_API_KEY", "test-key");
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(init.body as string).variables);
    return { ok: true, json: async () => ({ data }) };
  }));
  return calls;
}

describe("static page", () => {
  it("serves the built files with their type, and the app for an unknown path", async () => {
    const js = await app().request("/assets/app.js", { headers: local });
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toBe("text/javascript");
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const deep = await app().request("/projects/abc", { headers: local });
    expect(deep.headers.get("cache-control")).toBe("no-store");
    expect(await deep.text()).toBe("<html>wg</html>");
    expect(deep.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });
  it("answers 404 for a missing file with a known type", async () => {
    expect((await app().request("/assets/gone.js", { headers: local })).status).toBe(404);
  });
});

describe("project links", () => {
  it("looks up IDs and names only in the selected workspace", async () => {
    const { projectFromQuery } = await import("../src/App");
    const project = { id: "p1", name: "A project", url: "u", status: "", statusType: "", workspace: "work", workspaceName: "Work" };
    const directory = {
      workspaces: [{ id: "work", name: "Work" }, { id: "home", name: "Home" }],
      projects: [project],
    };
    const { defaultWorkspace } = site;
    const page = app();
    try {
      const config = await page.request("/api/config", { headers: local });
      configureSite({ defaultWorkspace: (await config.json()).defaultWorkspace });
      expect(projectFromQuery(directory, new URLSearchParams("project=p1")).project).toEqual(project);
      expect(projectFromQuery(directory, new URLSearchParams("project=A+PROJECT")).project).toEqual(project);
      // A project whose name is the id of another one does not take its link.
      const named = { ...project, id: "p0", name: "p1" };
      expect(projectFromQuery({ ...directory, projects: [named, project] }, new URLSearchParams("project=p1")).project).toEqual(project);
      expect(projectFromQuery(directory, new URLSearchParams("workspace=home&project=A+project"))).toEqual({
        project: null, missing: 'No project "A project" in Home',
      });
      expect(projectFromQuery(directory, new URLSearchParams()).missing).toBeNull();
      expect(projectFromQuery(directory, new URLSearchParams("project="))).toEqual({ project: null, missing: null });
      const unavailable = { ...directory, workspaces: [{ id: "home", name: "Home", error: "Unavailable" }] };
      expect(projectFromQuery(unavailable, new URLSearchParams("workspace=home&project=Unknown"))).toEqual({ project: null, missing: null });
    } finally {
      configureSite({ defaultWorkspace });
      page.link.stop();
    }
  });
});

describe("api", () => {
  it("reports the memory link store with no Redis configuration", async () => {
    const page = createApp(rules, { team: "WG", dist, watchMs: 0 });
    try {
      const response = await page.request("/api/status", { headers: local });
      expect(await response.json()).toMatchObject({ linkStore: "memory", redisReady: null });
    } finally {
      page.link.stop();
    }
  });

  it("keeps reads available when Redis cannot connect and keeps its URL private", async () => {
    const redisUrl = "rediss://:private-password@127.0.0.1:1";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const page = createApp(rules, { team: "WG", dist, watchMs: 0, redisUrl, stateDir: "/unused" });
    try {
      expect((await page.request("/", { headers: local })).status).toBe(200);
      const status = await page.request("/api/status", { headers: local });
      expect(await status.json()).toMatchObject({ linkStore: "redis", redisReady: false });
      const started = Date.now();
      const response = await page.request("/api/link?role=coordinator&project=p1", { headers: local });
      expect(Date.now() - started).toBeGreaterThanOrEqual(2900);
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("1");
      expect(await response.text()).not.toContain("private-password");
      expect(JSON.stringify([log.mock.calls, warn.mock.calls, error.mock.calls])).not.toContain("private-password");
    } finally {
      page.link.stop();
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("refuses a caller that is not this page", async () => {
    const response = await app().request("/api/projects", { headers: { host: "evil.example" } });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "bad host" });
  });
  it("lists the projects of the team", async () => {
    const labels = { nodes: [{ name: "AI", parent: null }, { name: "Tooling", parent: { name: "Initiative" } }, { name: "full", parent: { name: "Autonomy" } }, { name: "review:light", parent: { name: "Review" } }, { name: "paused", parent: null }] };
    linear({ teams: { nodes: [{ projects: { nodes: [{ id: "p2", name: "B", url: "u", status: null }, { id: "p1", name: "A", url: "u", status: { name: "Started", type: "started" }, labels }], pageInfo: { hasNextPage: false, endCursor: null } } }] } });
    const response = await app().request("/api/projects", { headers: local });
    expect(await response.json()).toEqual({
      workspaces: [{ id: "work", name: "Work" }],
      projects: [
        { id: "p1", name: "A", url: "u", status: "Started", statusType: "started", initiative: "Tooling", autonomy: "full", review: "light", paused: true, shared: false, workspace: "work", workspaceName: "Work" },
        { id: "p2", name: "B", url: "u", status: "", statusType: "", initiative: null, autonomy: null, review: null, paused: false, shared: false, workspace: "work", workspaceName: "Work" },
      ],
    });
  });
  it("lists both workspaces and keeps concurrent comment requests on their own keys", async () => {
    const keys: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const key = (init.headers as Record<string, string>).Authorization;
      keys.push(key);
      await new Promise((resolve) => setTimeout(resolve, key === "home-key" ? 1 : 5));
      const { query } = JSON.parse(init.body as string);
      const data = query.includes("projects(first")
        ? { teams: { nodes: [{ projects: { nodes: [], pageInfo: { hasNextPage: false } } }] } }
        : { issue: { comments: { nodes: [{ id: key, body: key === "home-key" ? "home" : "work", createdAt: "today", user: null }], pageInfo: { hasNextPage: false } } } };
      return { ok: true, json: async () => ({ data }) };
    }));
    const both = createApp(rules, { team: "CD", dist, workspaces: [
      { id: "work", name: "Work", team: "CD", key: "work-key", teamLabels: true },
      { id: "home", name: "Home", team: "HOM", key: "home-key", teamLabels: false },
    ] });
    const projects = await (await both.request("/api/projects", { headers: local })).json();
    expect(projects).toEqual({
      workspaces: [{ id: "work", name: "Work" }, { id: "home", name: "Home" }],
      projects: [],
    });
    const [work, home] = await Promise.all(["work", "home"].map(async (workspace) => {
      const response = await both.request("/api/issues/same-id/comments", { headers: { ...local, "x-workspace": workspace } });
      return response.json();
    }));
    expect(work[0].body).toBe("work");
    expect(home[0].body).toBe("home");
    const count = keys.length;
    const bad = await both.request("/api/issues/i1/comments", { headers: { ...local, "x-workspace": "missing" } });
    expect(bad.status).toBe(400);
    expect(keys).toHaveLength(count);
    expect(JSON.stringify(projects)).not.toContain("home-key");
  });
  it("marks an unavailable workspace and gives the route of an unknown call", async () => {
    linear({ teams: { nodes: [] } });
    const missing = await app().request("/api/projects", { headers: local });
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({
      workspaces: [{ id: "work", name: "Work", error: "Work is unavailable. Reload to try again." }],
      projects: [],
    });
    const unknown = await app().request("/api/nothing", { headers: local });
    expect(await unknown.json()).toEqual({ error: "no route GET /api/nothing" });
  });
  it("keeps work projects available when the home key fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const home = (init.headers as Record<string, string>).Authorization === "home-key";
      return { ok: !home, status: home ? 401 : 200, json: async () => home
        ? { errors: [{ message: "revoked" }] }
        : { data: { teams: { nodes: [{ projects: { nodes: [{ id: "work-project", name: "Work", url: "u", status: null }], pageInfo: { hasNextPage: false } } }] } } },
      };
    }));
    const both = createApp(rules, { team: "CD", dist, workspaces: [
      { id: "work", name: "Work", team: "CD", key: "work-key", teamLabels: true },
      { id: "home", name: "Home", team: "HOM", key: "home-key", teamLabels: false },
    ] });
    const response = await both.request("/api/projects", { headers: local });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      workspaces: [
        { id: "work", name: "Work" },
        { id: "home", name: "Home", error: "Home is unavailable. Reload to try again." },
      ],
      projects: [{ id: "work-project", name: "Work", url: "u", status: "", statusType: "", initiative: null, autonomy: null, review: null, paused: false, shared: false, workspace: "work", workspaceName: "Work" }],
    });
  });
  it("loads project issues across pages without mixing workspace graph caches", async () => {
    const seen: string[] = [];
    const raw = (id: string, key: string) => ({
      id, identifier: `${key}-${id}`, title: id, description: null, priority: 0, url: "u", sortOrder: 0, updatedAt: "today",
      team: { id: "team", key }, state: { id: "s", name: "Todo", type: "unstarted", color: "" }, assignee: null,
      labels: { nodes: [] }, projectMilestone: null,
      relations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      inverseRelations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      comments: { nodes: [] }, attachments: { nodes: [] }, project: { id: "p" },
    });
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const key = (init.headers as Record<string, string>).Authorization;
      const { query, variables } = JSON.parse(init.body as string);
      seen.push(key);
      let data;
      if (query.includes("viewer{")) data = { viewer: { id: "me" }, project: { id: "p", name: "A project", url: "u", projectMilestones: { nodes: [] } } };
      else if (query.includes("issues(first:25")) data = { project: { issues: {
        nodes: [raw(variables.after ? "2" : "1", key === "home-key" ? "HOM" : "CD")],
        pageInfo: { hasNextPage: !variables.after, endCursor: "page2" },
      } } };
      else if (query.includes("members(first")) data = { teams: { nodes: [{ id: "team", key: "HOM", states: { nodes: [] }, members: { nodes: [] } }] } };
      else data = { issueLabels: { nodes: [], pageInfo: { hasNextPage: false } } };
      return { ok: true, json: async () => ({ data }) };
    }));
    const both = createApp(rules, { team: "CD", dist, workspaces: [
      { id: "work", name: "Work", team: "CD", key: "work-key", teamLabels: true },
      { id: "home", name: "Home", team: "HOM", key: "home-key", teamLabels: false },
    ] });
    for (const workspace of ["work", "home"]) {
      const response = await both.request("/api/projects/p/graph", { headers: { ...local, "x-workspace": workspace } });
      expect(response.status).toBe(200);
      const graph = await response.json();
      expect(graph.issues.map((i: { identifier: string }) => i.identifier)).toEqual(workspace === "home" ? ["HOM-1", "HOM-2"] : ["CD-1", "CD-2"]);
      expect(graph.project.name).toBe("A project");
    }
    expect(seen).toContain("work-key");
    expect(seen).toContain("home-key");
  });
  it("summarizes each open project, and marks a project whose graph did not load", async () => {
    const pr = { number: 7, url: "https://github.com/example/repo/pull/7", status: "open", reviewUrl: "https://linear.app/work/review/review-7" };
    const asked: string[] = [];
    vi.stubEnv("LINEAR_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const { query, variables } = JSON.parse(init.body as string);
      let data;
      if (query.includes("projects(first:50")) data = { teams: { nodes: [{ projects: { nodes: [
        { id: "p1", name: "Open", url: "u", status: { name: "In Progress", type: "started" } },
        { id: "p2", name: "Shut", url: "u", status: { name: "Completed", type: "completed" } },
        { id: "p3", name: "Broken", url: "u", status: { name: "Planned", type: "planned" } },
      ], pageInfo: { hasNextPage: false, endCursor: null } } }] } };
      else if (variables.id === "p3") return { ok: false, status: 500, json: async () => null };
      else if (query.includes("viewer{")) { asked.push(variables.id); data = { viewer: { id: "me" }, project: { id: variables.id, name: "Open", url: "u", projectMilestones: { nodes: [] } } }; }
      else if (query.includes("issues(first:25")) data = { project: { issues: { nodes: [{
        id: "i1", identifier: "CD-1", title: "Answer me", description: null, priority: 0, url: "https://linear.app/work/issue/CD-1", sortOrder: 0, updatedAt: "2026-11-20T00:00:00Z",
        team: { id: "team", key: "CD" }, state: { id: "s", name: "Needs Human", type: "started", color: "" }, assignee: null,
        labels: { nodes: [] }, projectMilestone: null,
        relations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        inverseRelations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        comments: { nodes: [{ id: "c1", body: "**work-graph node card** `k`\n\n```json\n{\"wg\":1}\n```" }] },
        attachments: { nodes: [{ url: pr.url, title: "Open PR", metadata: { status: pr.status } }] }, project: { id: "p1" },
      }], pageInfo: { hasNextPage: false, endCursor: null } } } };
      else if (query.includes("pullRequests(first")) data = { pullRequests: { nodes: [{ url: pr.url, slugId: "review-7" }] } };
      else if (query.includes("members(first")) data = { teams: { nodes: [] } };
      else data = { issueLabels: { nodes: [], pageInfo: { hasNextPage: false } } };
      return { ok: true, json: async () => ({ data }) };
    }));
    const response = await app().request("/api/overview", { headers: local });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.projects.map((p: { id: string }) => p.id)).toEqual(["p3", "p1", "p2"]);
    expect(asked).toEqual(["p1"]); // no graph for the completed project
    const byId = new Map(body.summaries.map((s: { id: string }) => [s.id, s]));
    expect(byId.get("p1")).toMatchObject({ workspace: "work", planned: 1, done: 0, freshness: { state: "never", ran: null }, you: [{ identifier: "CD-1", title: "Answer me", why: "Needs Human", pullRequests: [pr] }] });
    expect(byId.get("p3")).toMatchObject({ you: [], error: expect.stringContaining("Linear") });
    expect(byId.has("p2")).toBe(false);
  });
  it("refuses a body that is not JSON, and a field that is not editable", async () => {
    const bad = await app().request("/api/issues/i1", { method: "PATCH", headers: write, body: "{" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "request body is not JSON" });
    const field = await app().request("/api/issues/i1", { method: "PATCH", headers: write, body: JSON.stringify({ teamId: "x" }) });
    expect(await field.json()).toEqual({ error: "fields not editable: teamId" });
  });
  it("refuses a body over the size limit", async () => {
    const big = await app().request("/api/issues/i1/comments", { method: "POST", headers: write, body: JSON.stringify({ body: "x".repeat(2_000_001) }) });
    expect(big.status).toBe(413);
  });
  it("adds a comment with the body that the page sent", async () => {
    const calls = linear({ issue: mine, commentCreate: { success: true, comment: { id: "c1", body: "hi", createdAt: "2026-11-20", parent: null, user: { name: "C", displayName: "cd" }, botActor: null } } });
    const response = await app().request("/api/issues/i1/comments", { method: "POST", headers: write, body: JSON.stringify({ body: "hi" }) });
    expect(await response.json()).toEqual({ id: "c1", body: "hi", createdAt: "2026-11-20", parentId: null, author: "cd" });
    expect(calls).toEqual([{ id: "i1" }, { i: { issueId: "i1", body: "hi" } }]);
  });
  it.each([
    ["HTTP 500", () => ({ ok: false, status: 500, json: async () => null })],
    ["success: false", () => ({ ok: true, json: async () => ({ data: { issueUpdate: { success: false } } }) })],
    ["success: true", () => ({ ok: true, json: async () => ({ data: { issueUpdate: { success: true } } }) })],
  ])("saves the answer once and tells the coordinator when the answered label update gives %s", async (result, labelAnswer) => {
    // A fictional team, so that the fixture names no installation.
    const team = "TM";
    vi.stubEnv("LINEAR_API_KEY", "test-key");
    const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
    const mutations: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const { query } = JSON.parse(init.body as string);
      if (query.includes("mutation")) mutations.push(query.match(/\{\s*(\w+)/)![1]);
      let data;
      if (query.includes("viewer{")) data = { viewer: { id: "me" }, project: { id: "p1", name: "P", url: "u", projectMilestones: { nodes: [] } } };
      else if (query.includes("issues(first:25")) data = { project: { issues: { nodes: [{
        id: "i1", identifier: `${team}-1`, title: "Ask", description: null, priority: 0, url: "https://linear.example/issue/1", sortOrder: 0, updatedAt: "today",
        team: { id: "team", key: team }, state: { id: "s", name: "Needs Human", type: "started", color: "" }, assignee: null,
        labels: { nodes: [] }, projectMilestone: null, relations: empty, inverseRelations: empty,
        comments: { nodes: [] }, attachments: { nodes: [] }, project: { id: "p1" },
      }], pageInfo: { hasNextPage: false, endCursor: null } } } };
      else if (query.includes("members(first")) data = { teams: { nodes: [] } };
      else if (query.includes("commentCreate")) data = { commentCreate: { success: true, comment: { id: "c1", body: "yes", createdAt: "today", parent: null, user: { name: "H", displayName: "human" }, botActor: null } } };
      else if (query.includes("issueLabels(first:10")) data = { issueLabels: { nodes: [{ id: "answered-id" }] } };
      else if (query.includes("addedLabelIds")) return labelAnswer();
      else if (query.includes("issue(id:")) data = { issue: { ...mine, team: { key: team } } };
      else data = { issueLabels: empty };
      return { ok: true, json: async () => ({ data }) };
    }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = createApp(rules, { team, dist, workspaces: [{ ...workWorkspace(), team }] });
    const response = await a.request("/api/issues/i1/comments", { method: "POST", headers: { ...write, "x-project": "p1" }, body: JSON.stringify({ body: "yes" }) });
    expect(response.status).toBe(200);
    const answered = result === "success: true";
    expect(await response.json()).toEqual({ id: "c1", body: "yes", createdAt: "today", parentId: null, author: "human", answered });
    expect(mutations).toEqual(["commentCreate", "issueUpdate"]); // one comment; the label mutation is not sent again
    const sent: string[] = [];
    const connection = await a.link.hub.joinCoordinator({ send: (t) => sent.push(t), close: () => {} }, { workspace: "work", id: "p1" });
    await connection.receive(JSON.stringify({ v: 1, type: "hello", payload: { session: "s" } }));
    expect(sent.map((t) => JSON.parse(t))).toContainEqual(expect.objectContaining({ type: "answer", payload: { issue: `${team}-1`, key: null, body: "yes" } }));
  });
  it.each([["data: null", { data: null }], ["no data", {}]])("answers 502 when Linear gives %s for the new comment", async (_name, answer) => {
    vi.stubEnv("LINEAR_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const { query } = JSON.parse(init.body as string);
      return { ok: true, json: async () => (query.includes("commentCreate") ? answer : { data: { issue: mine } }) };
    }));
    const response = await app().request("/api/issues/i1/comments", { method: "POST", headers: write, body: JSON.stringify({ body: "hi" }) });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Linear did not save the comment" });
  });
  it("refuses a write to an issue of another team", async () => {
    for (const issue of [{ ...mine, team: { key: "ENG" } }]) {
      const calls = linear({ issue });
      const patch = await app().request("/api/issues/i1", { method: "PATCH", headers: write, body: JSON.stringify({ priority: 1 }) });
      expect(patch.status).toBe(403);
      expect(await patch.json()).toEqual({ error: "this issue is not in team CD: it is read-only here" });
      const comment = await app().request("/api/issues/i1/comments", { method: "POST", headers: write, body: JSON.stringify({ body: "hi" }) });
      expect(comment.status).toBe(403);
      expect(calls).toEqual([{ id: "i1" }, { id: "i1" }]); // no mutation went to Linear
    }
  });
  it("can comment on home issues with no project using only the home key", async () => {
    const keys: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      keys.push((init.headers as Record<string, string>).Authorization);
      return { ok: true, json: async () => ({ data: {
        issue: { ...mine, team: { key: "HOM" }, project: null },
        commentCreate: { success: true, comment: { id: "c", body: "home comment", createdAt: "today", user: null } },
      } }) };
    }));
    const both = createApp(rules, { team: "CD", dist, workspaces: [
      { id: "work", name: "Work", team: "CD", key: "work-key", teamLabels: true },
      { id: "home", name: "Home", team: "HOM", key: "home-key", teamLabels: false },
    ] });
    const response = await both.request("/api/issues/i1/comments", { method: "POST", headers: { ...write, "x-workspace": "home" }, body: JSON.stringify({ body: "home comment" }) });
    expect(response.status).toBe(200);
    expect((await response.json()).body).toBe("home comment");
    expect(keys).toEqual(["home-key", "home-key"]);
  });
  it("refuses a description save that started from an older text", async () => {
    const calls = linear({ issue: { ...mine, description: "new design" }, issueUpdate: { success: false } });
    const save = (baseDescription: string) => app().request("/api/issues/i1", { method: "PATCH", headers: write, body: JSON.stringify({ description: "mine", baseDescription }) });
    const stale = await save("old design");
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toContain("the description changed in Linear");
    expect(calls).toEqual([{ id: "i1" }]);
    await save("new design");
    expect(calls[2]).toEqual({ id: "i1", i: { description: "mine" } }); // the base text does not go to Linear
  });
  it("moves an ops node to a done status only with its evidence, and writes the evidence first", async () => {
    const ops = { ...mine, labels: { nodes: [{ id: "l", name: "ops", color: "", parent: null }] } };
    const done = { issue: ops, workflowState: { type: "completed" }, commentCreate: { success: true }, issueUpdate: { success: false } };
    const move = (body: object) => app().request("/api/issues/i1", { method: "PATCH", headers: write, body: JSON.stringify(body) });
    let calls = linear(done);
    const bare = await move({ stateId: "s-done" });
    expect(bare.status).toBe(400);
    expect(await bare.json()).toEqual({ error: "an ops node goes to a done status only with its evidence" });
    expect(calls).toEqual([{ id: "i1" }, { id: "s-done" }]); // no comment and no move
    calls = linear(done);
    await move({ stateId: "s-done", note: " deployed abc to beta; check: /healthz; result: 200 " });
    expect(calls.slice(2)).toEqual([
      { i: { issueId: "i1", body: "Evidence: deployed abc to beta; check: /healthz; result: 200" } },
      { id: "i1", i: { stateId: "s-done" } }, // the note itself does not go into the issue update
    ]);
    calls = linear({ ...done, commentCreate: { success: false } });
    expect((await move({ stateId: "s-done", note: "x" })).status).toBe(502);
    expect(calls).toHaveLength(3); // the comment failed: no move
    calls = linear({ ...done, workflowState: { type: "started" } });
    await move({ stateId: "s-needs" });
    expect(calls[2]).toEqual({ id: "i1", i: { stateId: "s-needs" } }); // another status needs no note
    calls = linear({ ...done, issue: { ...mine, labels: { nodes: [{ id: "l", name: "decision", color: "", parent: null }] } } });
    await move({ stateId: "s-done", note: "yes, cut over" });
    expect(calls[2]).toEqual({ i: { issueId: "i1", body: "Answer: yes, cut over" } });
  });
  it("answers 404 for an issue that Linear does not have", async () => {
    linear({ issue: null });
    expect((await app().request("/api/issues/i1", { method: "PATCH", headers: write, body: JSON.stringify({ priority: 1 }) })).status).toBe(404);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ errors: [{ message: "Entity not found: Issue" }] }) })));
    const response = await app().request("/api/issues/i1", { method: "PATCH", headers: write, body: JSON.stringify({ priority: 1 }) });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "issue i1 not found" });
  });
  it("refuses a new title for a wg node, and takes one for an issue with no node card", async () => {
    const calls = linear({ issue: { ...mine, comments: { nodes: [{ id: "card" }] } } });
    const node = await app().request("/api/issues/i1", { method: "PATCH", headers: write, body: JSON.stringify({ title: "New" }) });
    expect(node.status).toBe(400);
    expect((await node.json()).error).toContain("plan.json has the title");
    expect(calls).toEqual([{ id: "i1" }]);
    const plain = linear({ issue: mine, issueUpdate: { success: false } });
    await app().request("/api/issues/i1", { method: "PATCH", headers: write, body: JSON.stringify({ title: "New" }) });
    expect(plain[1]).toEqual({ id: "i1", i: { title: "New" } });
  });
});

describe("hosted page", () => {
  const hosted: Rules = { port: 4747, tailnet: null, hosted: { host: "wg.example.com" } };
  const hostedApp = () => createApp(hosted, { team: "CD", dist, workspaces: [workWorkspace()] });

  it("serves the page and the API under its name", async () => {
    expect(await (await hostedApp().request("/", { headers: { host: "wg.example.com" } })).text()).toBe("<html>wg</html>");
    linear({ teams: { nodes: [{ projects: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }] } });
    expect((await hostedApp().request("/api/projects", { headers: { host: "wg.example.com" } })).status).toBe(200);
  });
  it("refuses the API under another name", async () => {
    expect((await hostedApp().request("/api/projects", { headers: { host: "127.0.0.1:4747" } })).status).toBe(403);
  });
  it("answers the health check under any name", async () => {
    expect((await hostedApp().request("/healthz")).status).toBe(200);
  });
});


describe("close project", () => {
  it("resolves a project slug and marks every issue Done across pages before completing it", async () => {
    const updates: unknown[] = [];
    vi.stubEnv("LINEAR_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const { query, variables } = JSON.parse(init.body as string);
      let data: unknown;
      if (query.includes("CloseProjectInfo")) data = { project: { id: "p1", name: "Example", teams: { nodes: [{ key: "CD" }] } }, projectStatuses: { nodes: [{ id: "complete", name: "Completed", type: "completed" }] } };
      else if (query.includes("CloseProjectIssues")) data = { issues: { nodes: variables.id !== "p1" ? [] : [{ id: variables.after ? "i2" : "i1", team: { key: "CD", states: { nodes: [{ id: "done", name: "Done", type: "completed" }] } }, state: { id: "todo" } }], pageInfo: { hasNextPage: !variables.after, endCursor: "next" } } };
      else if (query.includes("issueUpdate")) { updates.push(variables); data = { issueUpdate: { success: true } }; }
      else if (query.includes("projectUpdate")) { updates.push(variables); data = { projectUpdate: { success: true } }; }
      return { ok: true, json: async () => ({ data }) };
    }));
    const response = await app().request("/api/projects/example-slug/close", { method: "POST", headers: write, body: JSON.stringify({ confirm: true }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ completedIssues: 2 });
    expect(updates).toEqual([
      { id: "i1", stateId: "done" }, { id: "i2", stateId: "done" }, { id: "p1", statusId: "complete" },
    ]);
  });
});


describe("close project safety", () => {
  function setup(options: { failIssue?: boolean; team?: string; issueTeam?: string; missing?: boolean; failProject?: boolean; trashed?: boolean } = {}) {
    const writes: string[] = [];
    vi.stubEnv("LINEAR_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const { query, variables } = JSON.parse(init.body as string);
      let data: unknown;
      if (query.includes("CloseProjectInfo")) data = { project: options.missing ? null : { id: "p1", teams: { nodes: [{ key: options.team ?? "CD" }] } }, projectStatuses: { nodes: [{ id: "complete", name: "Completed", type: "completed" }] } };
      else if (query.includes("CloseProjectIssues")) data = { issues: { nodes: [{ id: "i1", trashed: options.trashed, state: { id: "todo" }, team: { key: options.issueTeam ?? "CD", states: { nodes: [{ id: "done", name: "Done", type: "completed" }] } } }], pageInfo: { hasNextPage: false } } };
      else if (query.includes("issueUpdate")) { writes.push("issue"); data = { issueUpdate: { success: !options.failIssue } }; }
      else if (query.includes("projectUpdate")) { writes.push("project"); data = { projectUpdate: { success: !options.failProject } }; }
      else throw new Error(`Unexpected query: ${query} ${JSON.stringify(variables)}`);
      return { ok: true, json: async () => ({ data }) };
    }));
    return writes;
  }
  const close = (id = "p1", confirm: unknown = true, headers = write) => app().request(`/api/projects/${id}/close`, { method: "POST", headers, body: JSON.stringify({ confirm }) });
  it("requires explicit confirmation and a real project", async () => {
    const writes = setup();
    expect((await close("p1", false)).status).toBe(400);
    expect((await close("all")).status).toBe(400);
    expect(writes).toEqual([]);
  });
  it("refuses foreign projects and mixed-team projects before any write", async () => {
    for (const options of [{ team: "ENG" }, { issueTeam: "ENG" }]) {
      const writes = setup(options);
      expect((await close()).status).toBe(403);
      expect(writes).toEqual([]);
    }
    setup({ missing: true });
    expect((await close()).status).toBe(404);
  });
  it("leaves the project open when an issue fails and permits retry", async () => {
    const writes = setup({ failIssue: true });
    const result = await close();
    expect(result.status).toBe(502);
    expect((await result.json()).error).toContain("project was not closed");
    expect(writes).toEqual(["issue"]);
    setup();
    expect((await close()).status).toBe(200);
  });
  it("does not change deleted issues when closing a project", async () => {
    const writes = setup({ trashed: true });
    const result = await close();
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ completedIssues: 0 });
    expect(writes).toEqual(["project"]);
  });
  it("reports a failed project completion", async () => {
    setup({ failProject: true });
    const result = await close();
    expect(result.status).toBe(502);
    expect((await result.json()).error).toContain("project could not be closed");
  });
  it("applies origin and workspace checks to closeout", async () => {
    const writes = setup();
    expect((await close("p1", true, { ...write, origin: "https://evil.example" })).status).toBe(403);
    expect((await close("p1", true, { ...write, "x-workspace": "unknown" } as typeof write)).status).toBe(400);
    expect(writes).toEqual([]);
  });
});

describe("review effort", () => {
  /** A Linear stub for the label calls: the group `review` exists with the old child `light`, which the project has. */
  function labelLinear() {
    const calls: { query: string; variables: Record<string, any> }[] = [];
    vi.stubEnv("LINEAR_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const { query, variables } = JSON.parse(init.body as string);
      calls.push({ query, variables });
      let data: unknown = { ok: { success: true } };
      if (query.includes("project(id")) {
        data = { project: { id: "p1", teams: { nodes: [{ key: "CD" }] }, labels: { nodes: [{ id: "old-light", parent: { id: "r" } }, { id: "standard-id", parent: { id: "g" } }] } }, teams: { nodes: [{ id: "team-cd" }] } };
      } else if (query.includes("projectLabels(")) {
        data = { projectLabels: { nodes: [{ id: "g", name: "autonomy", isGroup: true, retiredAt: null, parent: null },
          { id: "standard-id", name: "standard", isGroup: false, retiredAt: null, parent: { id: "g" } },
          { id: "r", name: "Review", isGroup: true, retiredAt: null, parent: null },
          { id: "old-light", name: "light", isGroup: false, retiredAt: null, parent: { id: "r" } }] } };
      } else if (query.includes("projectLabelCreate")) {
        data = { projectLabelCreate: { projectLabel: { id: `new-${variables.i.name}` } } };
      }
      return { ok: true, json: async () => ({ data }) };
    }));
    return calls;
  }
  const post = (a: ReturnType<typeof app>, level: unknown) =>
    a.request("/api/projects/p1/review-effort", { method: "POST", headers: write, body: JSON.stringify({ level }) });

  it("sets the label review:<level>, removes the old one, keeps the autonomy label, and wakes the coordinator", async () => {
    const calls = labelLinear();
    const a = app();
    const response = await post(a, "standard");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, level: "standard", queued: 1 });
    expect(calls.find((c) => c.query.includes("projectLabelCreate"))?.variables.i).toEqual({ name: "review:standard", teamId: "team-cd", parentId: "r" });
    expect(calls.filter((c) => c.query.includes("projectRemoveLabel")).map((c) => c.variables)).toEqual([{ id: "p1", l: "old-light" }]);
    expect(calls.find((c) => c.query.includes("projectAddLabel"))?.variables).toEqual({ id: "p1", l: "new-review:standard" });
    const sent: string[] = [];
    const connection = await a.link.hub.joinCoordinator({ send: (t) => sent.push(t), close: () => {} }, { workspace: "work", id: "p1" });
    await connection.receive(JSON.stringify({ v: 1, type: "hello", payload: { session: "s" } }));
    expect(JSON.parse(sent[0])).toMatchObject({ type: "command", payload: { name: "next", key: null, issue: null } });
  });
  it("refuses a level that is not a review effort", async () => {
    const calls = labelLinear();
    const response = await post(app(), "full");
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe("autonomy", () => {
  /** A Linear stub for the label calls: the project has the label `labelled`, and the group exists when `group`. */
  function labelLinear({ teams = ["CD"], group = true, labelled = "standard-id" } = {}) {
    const calls: { query: string; variables: Record<string, any> }[] = [];
    vi.stubEnv("LINEAR_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const { query, variables } = JSON.parse(init.body as string);
      calls.push({ query, variables });
      let data: unknown = {};
      if (query.includes("project(id")) {
        data = { project: { id: "p1", teams: { nodes: teams.map((key) => ({ key })) }, labels: { nodes: labelled ? [{ id: labelled, parent: { id: "g" } }, { id: "init", parent: { id: "other" } }] : [] } },
          teams: { nodes: [{ id: "team-cd" }] } };
      } else if (query.includes("projectLabels(")) {
        data = { projectLabels: { nodes: group ? [{ id: "g", name: "Autonomy", isGroup: true, retiredAt: null, parent: null },
          { id: "standard-id", name: "standard", isGroup: false, retiredAt: null, parent: { id: "g" } }] : [] } };
      } else if (query.includes("projectLabelCreate")) {
        data = { projectLabelCreate: { projectLabel: { id: `new-${variables.i.name}` } } };
      } else {
        data = { ok: { success: true } };
      }
      return { ok: true, json: async () => ({ data }) };
    }));
    return calls;
  }
  const post = (a: ReturnType<typeof app>, level: unknown) =>
    a.request("/api/projects/p1/autonomy", { method: "POST", headers: write, body: JSON.stringify({ level }) });

  it("sets the level label, removes the old one, and tells the coordinator", async () => {
    const calls = labelLinear();
    const a = app();
    const response = await post(a, "full");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, level: "full", queued: 1 });
    const created = calls.find((c) => c.query.includes("projectLabelCreate"));
    expect(created?.variables.i).toEqual({ name: "full", teamId: "team-cd", parentId: "g" });
    expect(calls.find((c) => c.query.includes("projectRemoveLabel"))?.variables).toEqual({ id: "p1", l: "standard-id" });
    expect(calls.find((c) => c.query.includes("projectAddLabel"))?.variables).toEqual({ id: "p1", l: "new-full" });
    // A coordinator that connects now gets the command from the queue.
    const sent: string[] = [];
    const connection = await a.link.hub.joinCoordinator({ send: (t) => sent.push(t), close: () => {} }, { workspace: "work", id: "p1" });
    await connection.receive(JSON.stringify({ v: 1, type: "hello", payload: { session: "s" } }));
    expect(JSON.parse(sent[0])).toMatchObject({ type: "command", payload: { name: "autonomy", key: null, issue: null, level: "full" } });
  });
  it("makes the group when it is missing, and changes nothing for the level the project has", async () => {
    let calls = labelLinear({ group: false, labelled: "" });
    expect((await post(app(), "supervised")).status).toBe(200);
    const made = calls.filter((c) => c.query.includes("projectLabelCreate")).map((c) => c.variables.i);
    expect(made[0]).toMatchObject({ name: "autonomy", isGroup: true, groupType: "singleSelect", teamId: "team-cd" });
    expect(made[1]).toEqual({ name: "supervised", teamId: "team-cd", parentId: "new-autonomy" });
    calls = labelLinear();
    expect((await post(app(), "standard")).status).toBe(200);
    expect(calls.some((c) => /projectLabelCreate|projectRemoveLabel|projectAddLabel/.test(c.query))).toBe(false);
  });
  it("refuses an unknown level and a project of another team", async () => {
    labelLinear();
    expect((await post(app(), "yolo")).status).toBe(400);
    const calls = labelLinear({ teams: ["ENG"] });
    expect((await post(app(), "full")).status).toBe(403);
    expect(calls.some((c) => c.query.includes("mutation"))).toBe(false);
  });
});

/** The fictional team of the graph cache tests. */
const TEAM = "TM";
/** An issue of the fictional team in project `project`, as Linear sends it in a graph. */
const rawIssue = (id: string, identifier: string, project: string) => ({
  id, identifier, title: id, description: null, priority: 0, url: "u", sortOrder: 0, updatedAt: "2026-11-20T00:00:00Z",
  team: { id: "team", key: TEAM }, state: { id: "s", name: "In Progress", type: "started", color: "" }, assignee: null,
  labels: { nodes: [] }, projectMilestone: null,
  relations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  inverseRelations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  comments: { nodes: [] }, attachments: { nodes: [] }, project: { id: project },
});

/**
 * A fake Linear with the open projects p1 and p2 of the team `TEAM`. It counts the full loads of each
 * project, the checks, and the comments, and can fail every request. `issueProject` is the project of the
 * issue that a write changes (null: no project); `issues` are the issues of each project's graph.
 */
function graphLinear() {
  const asked = { loads: [] as string[], one: 0, many: [] as unknown[], comments: [] as string[] };
  const state = { down: false, changed: [] as string[], issueProject: "p1" as string | null, issues: {} as Record<string, unknown[]> };
  const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
  vi.stubEnv("LINEAR_API_KEY", "test-key");
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const { query, variables } = JSON.parse(init.body as string);
    if (state.down) return { ok: false, status: 500, json: async () => null };
    let data;
    if (query.includes("projects(first:50")) data = { teams: { nodes: [{ projects: { nodes: [
      { id: "p1", name: "One", url: "u", status: { name: "Started", type: "started" } },
      { id: "p2", name: "Two", url: "u", status: { name: "Started", type: "started" } },
    ], pageInfo: { hasNextPage: false, endCursor: null } } }] } };
    else if (query.includes("project:{id:{in:$ids}}")) {
      asked.many.push(variables.ids);
      data = { issues: { ...empty, nodes: state.changed.map((id) => ({ updatedAt: "2999-01-01T00:00:00Z", project: { id } })) }, comments: empty,
        ...Object.fromEntries((variables.ids as string[]).map((_, at) => [`d${at}`, { documents: { nodes: [] } }])) };
    } else if (query.includes("issues(first:1,")) {
      asked.one++;
      data = { issues: { nodes: state.changed.includes(variables.id) ? [{ id: "x" }] : [] }, comments: { nodes: [] }, project: { documents: { nodes: [] } } };
    }
    else if (query.includes("viewer{")) { asked.loads.push(variables.id); data = { viewer: { id: "me" }, project: { id: variables.id, name: variables.id, url: "u", projectMilestones: { nodes: [] }, documents: { nodes: [] } } }; }
    else if (query.includes("issues(first:25")) data = { project: { issues: { ...empty, nodes: state.issues[variables.id] ?? [] } } };
    else if (query.includes("commentCreate")) {
      asked.comments.push(variables.i.body);
      data = { commentCreate: { success: true, comment: { id: "c1", body: variables.i.body, createdAt: "2026-11-20", parent: null, user: null, botActor: null } } };
    } else if (query.includes("issue(id:$id)")) data = { issue: { ...mine, team: { key: TEAM }, project: state.issueProject ? { id: state.issueProject } : null } };
    else if (query.includes("teams(first:10)")) data = { project: { id: variables.id, teams: { nodes: [{ key: TEAM }] }, labels: { nodes: [] } }, teams: { nodes: [{ id: "team" }] } };
    else if (query.includes("projectLabels(first:250")) data = { projectLabels: { nodes: [] } };
    else if (query.includes("projectLabelCreate")) data = { projectLabelCreate: { projectLabel: { id: "label-id" } } };
    else if (query.includes("projectAddLabel")) data = { projectAddLabel: { success: true } };
    else if (query.includes("projectRemoveLabel")) data = { projectRemoveLabel: { success: true } };
    else if (query.includes("members(first")) data = { teams: { nodes: [] } };
    else data = { issueLabels: empty };
    return { ok: true, json: async () => ({ data }) };
  }));
  return { asked, state };
}

describe("graph cache of the server", () => {
  const clock = { at: 1_000_000 };
  const workspace = () => ({ ...workWorkspace(), team: TEAM });
  const cached = () => createApp(rules, { team: TEAM, dist, workspaces: [workspace()], watchMs: 0, now: () => clock.at });
  const graph = (server: ReturnType<typeof cached>, id: string, have = "") =>
    server.request(`/api/projects/${id}/graph${have ? `?have=${have}` : ""}`, { headers: local });
  const comment = (server: ReturnType<typeof cached>, headers: Record<string, string>) =>
    server.request("/api/issues/i1/comments", { method: "POST", headers: { ...write, ...headers }, body: JSON.stringify({ body: "hi" }) });

  it("keeps each app's site settings while Linear requests interleave", async () => {
    const { state } = graphLinear();
    const issue = rawIssue("i1", `${TEAM}-1`, "p1");
    state.issues.p1 = [{ ...issue, labels: { nodes: [{ name: "needs-ada" }, { name: "needs-grace" }] } }];
    const respond = vi.mocked(fetch).getMockImplementation()!;
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const { query, variables } = JSON.parse(init!.body as string);
      const key = new Headers(init!.headers).get("authorization");
      if (key === "ada-key" && query.includes("projects(first:50")) {
        enter();
        await held;
      }
      if (query.includes("issueLabels(first:10") && variables.n === "answered") {
        return Response.json({ data: { issueLabels: { nodes: [{ id: "answered-id" }] } } });
      }
      if (query.includes("addedLabelIds")) {
        return Response.json({ data: { issueUpdate: { success: true } } });
      }
      return respond(url, init);
    });
    const page = (human: string, id: string) => createApp(rules, {
      team: TEAM, dist, watchMs: 0, human, workspaces: [{ ...workspace(), id, key: `${id}-key` }],
    });
    const ada = page("Ada", "ada");
    const grace = page("Grace", "grace");
    const overview = (server: ReturnType<typeof page>) => server.request("/api/overview", { headers: local });
    const adaOverview = overview(ada);
    try {
      await entered;
      expect(await (await overview(grace)).json()).toMatchObject({
        summaries: expect.arrayContaining([expect.objectContaining({
          workspace: "grace", id: "p1", you: [expect.objectContaining({ why: "Needs Grace" })],
        })]),
      });
      for (const [server, human, defaultWorkspace] of [[ada, "Ada", "ada"], [grace, "Grace", "grace"]] as const) {
        const config = await server.request("/api/config", { headers: local });
        expect(await config.json()).toMatchObject({ human, defaultWorkspace });
        const reply = await comment(server, { "x-project": "p1" });
        expect(reply.status).toBe(200);
        expect(await reply.json()).toMatchObject({ answered: true });
      }
      release();
      expect(await (await adaOverview).json()).toMatchObject({
        summaries: expect.arrayContaining([expect.objectContaining({
          workspace: "ada", id: "p1", you: [expect.objectContaining({ why: "Needs Ada" })],
        })]),
      });
    } finally {
      release();
      await adaOverview;
      ada.link.stop();
      grace.link.stop();
    }
  });

  it("forgets only the graph of the project of the written issue, not the project that the request names", async () => {
    const { asked, state } = graphLinear();
    const server = cached();
    await graph(server, "p1");
    await graph(server, "p2");
    // The issue is in p1; the header names p2.
    expect((await comment(server, { "x-project": "p2" })).status).toBe(200);
    await graph(server, "p1");
    await graph(server, "p2");
    expect(asked.loads).toEqual(["p1", "p2", "p1"]);
    // A write to an issue with no project forgets every graph of the workspace.
    state.issueProject = null;
    await comment(server, {});
    await graph(server, "p1");
    await graph(server, "p2");
    expect(asked.loads).toEqual(["p1", "p2", "p1", "p1", "p2"]);
    // A change of the autonomy level of p2 forgets only the graph of p2.
    expect((await server.request("/api/projects/p2/autonomy", { method: "POST", headers: write, body: JSON.stringify({ level: "full" }) })).status).toBe(200);
    await graph(server, "p1");
    await graph(server, "p2");
    expect(asked.loads).toEqual(["p1", "p2", "p1", "p1", "p2", "p2"]);
  });
  it("forgets only the graph of the project of a wrote message", async () => {
    const { asked } = graphLinear();
    const server = cached();
    await graph(server, "p1");
    await graph(server, "p2");
    const sent: string[] = [];
    const wg = await server.link.hub.joinCoordinator({ send: (text) => sent.push(text), close: () => {} }, { workspace: "work", id: "p2" });
    await wg.receive(JSON.stringify({ v: 1, type: "wrote", id: "w", project: { workspace: "work", id: "p2" }, at: "", payload: { issues: [`${TEAM}-1`] } }));
    await graph(server, "p1");
    await graph(server, "p2");
    expect(asked.loads).toEqual(["p1", "p2", "p2"]);
  });
  it("does not use a stale graph for a write that depends on the issues of the project", async () => {
    const { asked, state } = graphLinear();
    const server = cached();
    await graph(server, "p1"); // this graph has no issues yet
    state.issues.p1 = [rawIssue("i2", `${TEAM}-2`, "p1")];
    const coordinator = await server.link.hub.joinCoordinator({ send: () => {}, close: () => {} }, { workspace: "work", id: "p1" });
    await coordinator.receive(JSON.stringify({ v: 1, type: "hello", id: "h", project: { workspace: "work", id: "p1" }, at: "", payload: { plan: "p1", session: "p1", host: "test", wg: "1" } }));
    await coordinator.receive(JSON.stringify({ v: 1, type: "asks", id: "x", project: {}, at: "", payload: { asks: [{ id: "msg_q", key: "a", issue: `${TEAM}-2`, from: "w", body: "Which API?", at: "t" }] } }));
    expect(await server.link.hub.ask({ workspace: "work", id: "p1" }, "msg_q")).not.toBeNull();
    state.down = true;
    clock.at += 60_000;
    expect((await graph(server, "p1")).status).toBe(200); // the page still gets the stale graph
    const reply = await server.request("/api/projects/p1/asks/msg_q/reply", { method: "POST", headers: write, body: JSON.stringify({ body: "Use v2." }) });
    expect(reply.status).toBe(502);
    expect(await server.link.hub.ask({ workspace: "work", id: "p1" }, "msg_q")).not.toBeNull(); // the question stays open
    const dispatch = await server.request("/api/projects/p1/commands", { method: "POST", headers: write, body: JSON.stringify({ name: "dispatch", key: "a", issue: `${TEAM}-2` }) });
    expect(dispatch.status).toBe(502);
    expect(asked.comments).toEqual([]);
    // Linear is back: the reply is saved on the issue that the stale graph did not have.
    state.down = false;
    state.changed = ["p1"];
    const saved = await server.request("/api/projects/p1/asks/msg_q/reply", { method: "POST", headers: write, body: JSON.stringify({ body: "Use v2." }) });
    expect(await saved.json()).toEqual({ ok: true, recorded: true });
    expect(asked.comments).toHaveLength(1);
  });
  it("sends the last graph with stale, the error, and its load time when Linear fails, also for the version the page has", async () => {
    const { state } = graphLinear();
    const server = cached();
    const loaded = clock.at;
    const first = await (await graph(server, "p1")).json();
    expect(first.stale).toBeUndefined();
    expect(first.loadedAt).toBeUndefined();
    state.down = true;
    clock.at += 60_000;
    const response = await graph(server, "p1");
    expect(response.status).toBe(200);
    const stale = await response.json();
    expect(stale).toMatchObject({ project: first.project, version: first.version, stale: true, error: expect.stringContaining("HTTP 500"), loadedAt: loaded });
    // The page has this version, but it must learn that the graph is stale: no 204.
    const same = await graph(server, "p1", first.version);
    expect(same.status).toBe(200);
    expect((await same.json()).stale).toBe(true);
    clock.at += 20 * 60_000;
    expect((await graph(server, "p1")).status).toBe(502);
  });
  it("checks all open projects of the overview, and of the link check, with one request for the workspace", async () => {
    const { asked, state } = graphLinear();
    const server = cached();
    await server.request("/api/overview", { headers: local });
    expect(asked.loads.sort()).toEqual(["p1", "p2"]);
    expect(asked.many).toEqual([]); // nothing cached yet: nothing to check
    clock.at += 60_000;
    state.changed = ["p2"];
    const body = await (await server.request("/api/overview", { headers: local })).json();
    expect(body.summaries).toHaveLength(2);
    expect(asked.many).toEqual([["p1", "p2"]]);
    expect(asked.one).toBe(0);
    expect(asked.loads.sort()).toEqual(["p1", "p2", "p2"]);
    // The link check of the projects with a coordinator: one request too.
    for (const id of ["p1", "p2"]) {
      await (await server.link.hub.joinCoordinator({ send: () => {}, close: () => {} }, { workspace: "work", id })).receive(JSON.stringify({ v: 1, type: "hello", id: "h", project: { workspace: "work", id }, at: "", payload: { plan: id, session: id, host: "test", wg: "1" } }));
    }
    expect(await server.link.hub.active()).toHaveLength(2);
    clock.at += 60_000;
    state.changed = [];
    await server.link.check();
    expect(asked.many).toEqual([["p1", "p2"], ["p1", "p2"]]);
    expect(asked.one).toBe(0);
    expect(asked.loads).toHaveLength(3);
  });
});


describe("coordinator link token", () => {
  const linkToken = "a-test-token-with-32-characters-or-more";
  afterEach(() => vi.unstubAllEnvs());

  it("rejects coordinator requests before looking up the project", async () => {
    const path = "/api/link?role=coordinator";
    const server = app(linkToken);
    for (const authorization of ["", "Bearer wrong", `Bearer ${linkToken.slice(0, -1)}x`]) {
      const response = await server.request(path, { headers: { ...local, authorization } });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "coordinator token required" });
    }
    const accepted = await server.request(path, { headers: { ...local, authorization: `Bearer ${linkToken}` } });
    expect(accepted.status).toBe(400);
    expect(await accepted.json()).toEqual({ error: "a coordinator names its project" });
  });

  it("refuses a short server token", () => {
    expect(() => app("too-short")).toThrow("WG_LINK_TOKEN must have at least 32 characters");
  });

  it("treats an empty token as unset", async () => {
    const response = await app("").request("/api/link?role=coordinator", { headers: local });
    expect(response.status).toBe(400);
  });

  it("leaves token configuration to the server entry point", async () => {
    vi.stubEnv("WG_LINK_TOKEN", linkToken);
    const response = await app().request("/api/link?role=coordinator", { headers: local });
    expect(response.status).toBe(400);
  });
});

describe("link sockets of the server", () => {
  const closers: (() => void)[] = [];
  afterEach(() => { closers.splice(0).forEach((close) => close()); });
  const settle = () => new Promise((ok) => setTimeout(ok, 30));

  /** A server with a clock and link timers that move only when the test says so. */
  async function start(linkToken?: string) {
    const clock = { at: Date.parse("2026-11-20T00:00:00Z") };
    const jobs: { fn: () => void; at: number; every: number | null; off: boolean }[] = [];
    const add = (fn: () => void, ms: number, every: boolean) => {
      const job = { fn, at: clock.at + ms, every: every ? ms : null, off: false };
      jobs.push(job);
      return () => { job.off = true; };
    };
    const timers: Timers = { every: (fn, ms) => add(fn, ms, true), after: (fn, ms) => add(fn, ms, false) };
    /** Move the clock by `ms` and run each timer that falls due, in time order. */
    const advance = (ms: number) => {
      const end = clock.at + ms;
      for (;;) {
        const due = jobs.filter((j) => !j.off && j.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        clock.at = due.at;
        if (due.every) due.at += due.every; else due.off = true;
        due.fn();
      }
      clock.at = end;
    };
    const portRules: Rules = { port: 0, tailnet: null };
    const server = createApp(portRules, { team: "CD", dist, workspaces: [workWorkspace()], watchMs: 0, now: () => clock.at, linkTimers: timers, linkToken });
    const http = serve({ fetch: server.fetch, port: 0, hostname: "127.0.0.1" });
    server.injectWebSocket(http as never);
    await new Promise<void>((ok) => http.once("listening", () => ok()));
    portRules.port = (http.address() as AddressInfo).port;
    closers.push(() => { server.link.stop(); http.close(); });
    return { server, port: portRules.port, advance, running: () => jobs.filter((j) => !j.off).length };
  }
  /** An overview page socket. `autoPong: false` is a client that went away without a close. */
  async function page(port: number, autoPong = true) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/link?role=page`, { headers: { origin: `http://127.0.0.1:${port}` }, autoPong });
    let pings = 0;
    ws.on("ping", () => { pings++; });
    const closed = new Promise<number>((ok) => ws.once("close", (code) => ok(code)));
    await new Promise((ok) => ws.once("open", ok));
    closers.push(() => ws.terminate());
    return { ws, closed, pings: () => pings };
  }

  it("requires a token on the coordinator upgrade and accepts a page socket without one", async () => {
    const token = "a-test-token-with-32-characters-or-more";
    linear({ teams: { nodes: [{ projects: {
      nodes: [{ id: "p1", name: "Example", url: "u", status: null }],
      pageInfo: { hasNextPage: false, endCursor: null },
    } }] } });
    const { port } = await start(token);
    await page(port);
    const upgrade = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/link?role=coordinator&project=p1`, { headers });
      closers.push(() => ws.terminate());
      ws.on("error", reject);
      ws.on("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      ws.on("open", () => resolve(101));
    });
    expect(await upgrade({})).toBe(401);
    expect(await upgrade({ authorization: `Bearer ${token}` })).toBe(101);
  });

  it("terminates a socket 45 s after its last pong, also one that sends messages, and keeps one that sends pongs", async () => {
    const { port, advance } = await start();
    const live = await page(port), silent = await page(port, false), talker = await page(port, false);
    for (let t = 10_000; t < DEAD_MS; t += 10_000) {
      talker.ws.send("still here");
      advance(10_000);
      if (t % PING_MS === 0) await vi.waitFor(() => expect(live.pings()).toBe(t / PING_MS));
      await settle(); // the pong of the live socket reaches the server
    }
    expect(silent.pings()).toBe(Math.floor(DEAD_MS / PING_MS));
    advance(DEAD_MS - 40_000 - 1); // 1 ms before the deadline
    await settle();
    expect([silent.ws.readyState, talker.ws.readyState]).toEqual([WebSocket.OPEN, WebSocket.OPEN]);
    advance(1);
    expect(await silent.closed).toBe(1006); // terminated: no close frame
    expect(await talker.closed).toBe(1006);
    expect(live.ws.readyState).toBe(WebSocket.OPEN);
  });

  it.each(["SIGTERM", "SIGINT"] as const)("on %s closes each socket with 1012, refuses a new one with 503, and then exits", async (signal) => {
    const { server, port, running } = await start();
    const a = await page(port), b = await page(port);
    const signals = new EventEmitter();
    const exit = vi.fn();
    stopOnSignals(() => server.link.shutdown(), (signal, fn) => signals.on(signal, fn), exit);
    signals.emit(signal);
    const status = await new Promise<number>((ok) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/link?role=page`, { headers: { origin: `http://127.0.0.1:${port}` } });
      ws.on("unexpected-response", (_req, res) => ok(res.statusCode ?? 0));
      ws.on("open", () => { ws.close(); ok(101); });
    });
    expect(status).toBe(503);
    expect(await a.closed).toBe(RESTART_CODE);
    expect(await b.closed).toBe(RESTART_CODE);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(running()).toBe(0);
  });
});

describe("server status", () => {
  const sink = () => ({ send: () => {}, close: () => {} });
  const msg = (type: string, payload: unknown) => JSON.stringify({ v: 1, type, id: "x", project: { workspace: "work", id: "p1" }, at: "", payload });

  it("gives the contract hash as wg computes it, and the version", async () => {
    const contract = readFileSync(new URL("../skills/work-graph/contract.json", import.meta.url));
    const body = await (await createApp(rules, { team: "CD", dist, workspaces: [workWorkspace()], version: "abc1234" })
      .request("/api/config", { headers: local })).json();
    expect(body.contract).toBe(createHash("sha256").update(contract).digest("hex").slice(0, 12));
    expect(body.contract).toBe(contractHash());
    expect(body.version).toBe("abc1234");
    vi.stubEnv("WG_VERSION", "");
    expect((await (await app().request("/api/config", { headers: local })).json()).version).toBe("dev");
    vi.stubEnv("WG_VERSION", "def5678");
    expect((await (await app().request("/api/config", { headers: local })).json()).version).toBe("def5678");
    vi.unstubAllEnvs();
    expect(contractHash(join(dist, "missing.json"))).toBeNull();
  });

  it("gives the uptime, the Linear budget, the cache size, and the room counts, and no secret", async () => {
    const clock = { at: 1_000_000 };
    graphLinear();
    vi.stubEnv("LINEAR_API_KEY", "secret-key-0123");
    // The graph stub, with the rate-limit headers of Linear and a project name that must not show.
    const stub = globalThis.fetch as unknown as (url: string, init: RequestInit) => Promise<{ json: () => Promise<{ data: Record<string, { name?: string }> }> }>;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const body = await (await stub(url, init)).json();
      if (body.data.project?.name) body.data.project.name = "Secret project name";
      return { ok: true, json: async () => body, headers: new Headers({
        "x-ratelimit-requests-remaining": "4321", "x-ratelimit-requests-limit": "5000", "x-ratelimit-requests-reset": "1700000000000",
      }) };
    }));
    const server = createApp(rules, { team: "CD", dist, workspaces: [workWorkspace()], watchMs: 0, now: () => clock.at, version: "v1" });
    expect((await server.request("/api/projects/p1/graph", { headers: local })).status).toBe(200);
    const coordinator = await server.link.hub.joinCoordinator(sink(), { workspace: "work", id: "p1" });
    await coordinator.receive(msg("hello", { plan: "/plans/a", session: "s1", host: "mac", wg: "1" }));
    await coordinator.receive(msg("asks", { asks: [{ id: "q1", issue: "CD-1", from: "w", body: "Secret question body", at: "" }] }));
    await server.link.hub.joinPage(sink(), { workspace: "work", id: "p1" });
    await server.link.hub.publish({ workspace: "work", id: "p1" }, "reply", { ask: "q1", issue: "CD-1", key: "a", body: "Secret reply body" });
    clock.at += 61_000;
    const response = await server.request("/api/status", { headers: local });
    expect(response.status).toBe(200);
    const text = await response.text();
    const status = JSON.parse(text);
    expect(status).toMatchObject({ version: "v1", uptime: 61, cache: 1 });
    expect(status.workspaces).toEqual([{ id: "work", name: "Work", requestsRemaining: 4321, requestsLimit: 5000, requestsReset: 1700000000000,
      complexityRemaining: null, complexityReset: null, at: expect.any(Number) }]);
    expect(status.rooms).toEqual([{ workspace: "work", project: "p1", coordinators: 1, pages: 1, queued: expect.any(Number), asks: 1 }]);
    expect(status.rooms[0].queued).toBeGreaterThan(0);
    for (const secret of ["secret-key-0123", "Secret project name", "Secret question body", "Secret reply body", "CD-1"]) expect(text).not.toContain(secret);
    server.link.stop();
  });

  it("answers /api/status only behind the host check, and /healthz stays ok", async () => {
    expect((await app().request("/api/status", { headers: { host: "evil.example.com" } })).status).toBe(403);
    expect(await (await app().request("/healthz")).json()).toEqual({ ok: true });
  });

  it("writes one log line for a slow request and for a server error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const clock = { at: 0 };
    vi.stubEnv("LINEAR_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async () => {
      clock.at += SLOW_MS + 1;
      return { ok: true, json: async () => ({ data: { teams: { nodes: [{ projects: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }] } } }) };
    }));
    const server = createApp(rules, { team: "CD", dist, workspaces: [workWorkspace()], watchMs: 0, now: () => clock.at });
    expect((await server.request("/api/projects?x=secret", { headers: local })).status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/^wg api: GET \/api\/projects 200 \d+ms$/);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    vi.stubEnv("LINEAR_API_KEY", "");
    const broken = createApp(rules, { team: "CD", dist, workspaces: [{ ...workWorkspace(), key: "" }], watchMs: 0 });
    expect((await broken.request("/api/issues/i1/comments", { headers: local })).status).toBe(500);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][0]).toMatch(/^wg api: GET \/api\/issues\/i1\/comments 500 \d+ms$/);
    // The 500 has its request line only: no error stack besides it.
    expect(error).not.toHaveBeenCalled();
    expect((await app().request("/api/config", { headers: local })).status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(2);
    // A path with an encoded line break stays one physical line: the log has the encoded path.
    expect((await broken.request("/api/issues/a%0Dwg%20api:%20GET%20%2Ffake%0Ab/comments", { headers: local })).status).toBe(500);
    expect(warn).toHaveBeenCalledTimes(3);
    const line = warn.mock.calls[2][0] as string;
    expect(line.split(/[\r\n]/)).toHaveLength(1);
    expect(line).toMatch(/^wg api: GET \/api\/issues\/a%0Dwg%20api:%20GET%20%2Ffake%0Ab\/comments 500 \d+ms$/);
    expect(error).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("compresses the page and JSON for a client that accepts it, and gives index.html an ETag", async () => {
    const big = join(dist, "assets", "big.js");
    await writeFile(big, "console.log('work graph');\n".repeat(200));
    const js = await app().request("/assets/big.js", { headers: { ...local, "accept-encoding": "gzip" } });
    expect(js.headers.get("content-encoding")).toBe("gzip");
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(gunzipSync(Buffer.from(await js.arrayBuffer())).toString()).toBe("console.log('work graph');\n".repeat(200));
    const plain = await app().request("/assets/big.js", { headers: local });
    expect(plain.headers.get("content-encoding")).toBeNull();
    // Only gzip: a client that accepts deflate or Brotli alone gets the plain file.
    for (const accepted of ["deflate", "br", "br, deflate"]) {
      const other = await app().request("/assets/big.js", { headers: { ...local, "accept-encoding": accepted } });
      expect(other.headers.get("content-encoding")).toBeNull();
      expect(await other.text()).toBe("console.log('work graph');\n".repeat(200));
    }
    const both = await app().request("/assets/big.js", { headers: { ...local, "accept-encoding": "deflate, gzip;q=0.5" } });
    expect(both.headers.get("content-encoding")).toBe("gzip");

    linear({ teams: { nodes: [{ projects: { nodes: Array.from({ length: 30 }, (_, at) => ({ id: `p${at}`, name: `Project ${at}`, url: "u", status: { name: "Started", type: "started" } })),
      pageInfo: { hasNextPage: false, endCursor: null } } }] } });
    const list = await app().request("/api/projects", { headers: { ...local, "accept-encoding": "gzip" } });
    expect(list.headers.get("content-encoding")).toBe("gzip");
    expect(JSON.parse(gunzipSync(Buffer.from(await list.arrayBuffer())).toString()).projects).toHaveLength(30);

    // A small reply is compressed too: the 1 KiB minimum of `compress` needs a Content-Length (README).
    const health = await app().request("/healthz", { headers: { "accept-encoding": "gzip" } });
    expect(health.headers.get("content-encoding")).toBe("gzip");
    expect(JSON.parse(gunzipSync(Buffer.from(await health.arrayBuffer())).toString())).toEqual({ ok: true });

    // The plain and the gzip reply of index.html have the same weak ETag and Vary, and so has each 304.
    const page = await app().request("/", { headers: local });
    const tag = page.headers.get("etag");
    expect(tag).toMatch(/^W\/"[0-9a-f]{40}"$/);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("vary")).toBe("Accept-Encoding");
    expect(page.headers.get("content-encoding")).toBeNull();
    const zipped = await app().request("/", { headers: { ...local, "accept-encoding": "gzip" } });
    expect(zipped.headers.get("content-encoding")).toBe("gzip");
    expect(zipped.headers.get("etag")).toBe(tag);
    expect(zipped.headers.get("vary")).toBe("Accept-Encoding");
    for (const encoding of [{}, { "accept-encoding": "gzip" }] as Record<string, string>[]) {
      for (const sent of [tag!, tag!.slice(2)]) {
        const again = await app().request("/", { headers: { ...local, ...encoding, "if-none-match": sent } });
        expect(again.status).toBe(304);
        expect(await again.text()).toBe("");
        expect(again.headers.get("etag")).toBe(tag);
        expect(again.headers.get("vary")).toBe("Accept-Encoding");
        expect(again.headers.get("content-encoding")).toBeNull();
      }
    }
    expect((await app().request("/", { headers: { ...local, "if-none-match": '"other"' } })).status).toBe(200);
  });
});

const hostedRoles: Rules = { port: 4747, tailnet: null, hosted: { host: "view.example.com" } };
const rolesAuth = { domains: ["example.com"], owners: ["ada@example.com"], clientId: "client", clientSecret: "secret", secret: "a-session-secret-of-32-characters" };
const rolesToken = "a-test-token-with-32-characters-or-more";
const rolesHost = { host: "view.example.com" };
const rolesHeaders = async (email: string, id?: string) => {
  const value = Buffer.from(JSON.stringify({ email, id, hd: "example.com", exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url");
  return { ...rolesHost, cookie: (await serializeSigned("__Host-wg_session", value, rolesAuth.secret, { secure: true, path: "/" })).split(";")[0] };
};
const rolesPage = (now?: () => number) => createApp(hostedRoles, {
  team: "CD", dist, workspaces: [workWorkspace()], readOnly: false, auth: rolesAuth, linkToken: rolesToken, watchMs: 0, now,
});

it("allows each account to join only its shared projects and closes a removed member's link", async () => {
  const sql = await pgliteSql();
  const directory = dbTenants(sql, credentialCrypto({ WG_DATA_KEY: randomBytes(32).toString("base64") }));
  try {
    await migrate(sql);
    const { accounts } = directory;
    const connection = {
      workspaceId: "work", linearOrgId: "org", name: "Work", team: "WG", teamLabels: true,
      credential: { kind: "oauth" as const, key: "access", refreshToken: "refresh", expiresAt: new Date("2030-01-01") },
    };
    const create = (human: string) => accounts.createAccount({
      linearUserId: human, linearOrgId: "org", email: human.toLowerCase() + "@example.com", name: human,
    }, human, connection);
    const ada = await create("Ada"), grace = await create("Grace"), viewer = await create("Viewer");
    const [workspace] = (await accounts.readTenant(ada))!.connections;
    const scope: [string, string, string] = [ada, workspace.id, "p1"];
    const links = (await accounts.shares.make(scope, "Project"))!.created;
    await accounts.shares.join(grace, links.collab!);
    await accounts.shares.join(viewer, links.view!);
    const [collab] = await directory.sharedWorkspaces(grace);
    const [view] = await directory.sharedWorkspaces(viewer);
    const graceToken = (await accounts.createToken(grace, "coordinator")).token;
    const viewToken = (await accounts.createToken(viewer, "coordinator")).token;
    const page = createApp(hostedRoles, { team: "WG", dist, auth: rolesAuth, tenants: directory, watchMs: 0 });
    const path = (id: string, project = "p1", role = "coordinator") => `/api/link?role=${role}&workspace=${id}&project=${project}`;
    const headers = (token: string) => ({ ...rolesHost, authorization: "Bearer " + token });
    const http = serve({ fetch: page.fetch, port: 0, hostname: "127.0.0.1" });
    page.injectWebSocket(http as never);
    const sockets: WebSocket[] = [];
    try {
      expect((await page.request(path(view.id), { headers: headers(viewToken) })).status).toBe(403);
      expect((await page.request(path(collab.id), { headers: headers(viewToken) })).status).toBe(400);
      expect((await page.request(path(collab.id, "other"), { headers: headers(graceToken) })).status).toBe(404);
      if (!http.listening) await new Promise<void>((resolve) => http.once("listening", resolve));
      const { port } = http.address() as AddressInfo;
      const connect = (path: string, headers: Record<string, string>) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
        sockets.push(ws);
        return ws;
      };
      const ws = connect(path(collab.id), headers(graceToken));
      await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
      ws.send(JSON.stringify({ v: 1, type: "hello", payload: { session: "grace" } }));
      const ref = { workspace: "work", id: "p1", tenant: ada };
      await vi.waitFor(async () => expect((await page.link.hub.presence(ref)).coordinators)
        .toMatchObject([{ accountName: "Grace", connected: true }]));
      const pageHeaders = { ...await rolesHeaders("grace@example.com", grace), origin: "https://view.example.com" };
      const memberPage = connect(path(collab.id, "p1", "page"), pageHeaders);
      const presence = new Promise<unknown>((resolve, reject) => {
        memberPage.on("message", (raw) => {
          const frame = JSON.parse(String(raw));
          if (frame.type === "presence") resolve(frame);
        });
        memberPage.once("error", reject);
      });
      expect(await presence).toMatchObject({ project: { workspace: collab.id, id: "p1" }, payload: {
        coordinators: [{ accountName: "Grace" }],
      } });
      const command = new Promise<unknown>((resolve) => ws.on("message", (raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.type === "command") resolve(frame.payload);
      }));
      const next = await page.request("/api/projects/p1/commands", {
        method: "POST", headers: { ...pageHeaders, "content-type": "application/json", "x-workspace": collab.id },
        body: JSON.stringify({ name: "next" }),
      });
      expect(await next.json()).toMatchObject({ ok: true, queued: 1 });
      expect(await command).toMatchObject({ name: "next" });
      const waiting = await page.request("/api/projects/p1/presence", {
        headers: { ...headers(graceToken), "x-workspace": collab.id },
      });
      expect(await waiting.json()).toMatchObject({ waiting: 1 });
      const member = (await accounts.shares.list(scope))!.members.find(({ name }) => name === "Grace")!;
      const closed = sockets.map((socket) => new Promise<number>((resolve) => socket.once("close", resolve)));
      await accounts.shares.changeMember(scope, member.id);
      expect(await Promise.all(closed)).toEqual([RESTART_CODE, RESTART_CODE]);
      expect((await page.link.hub.presence(ref)).coordinators).toEqual([]);
      expect((await page.request(path(collab.id), { headers: headers(graceToken) })).status).toBe(400);
    } finally {
      for (const socket of sockets) socket.terminate();
      http.close();
      page.link.stop();
    }
  } finally {
    directory.close();
    await sql.close();
  }
});

it("keeps queued commands and status in the request tenant", async () => {
  const directory = testTenants(TEAM);
  const page = createApp(hostedRoles, { team: TEAM, dist, auth: rolesAuth, tenants: directory.tenants, watchMs: 0 });
  const headers = { ...await rolesHeaders("ada@example.com"), origin: "https://view.example.com", "content-type": "application/json" };
  const status = async (token: string) =>
    (await page.request("/api/status", { headers: { ...rolesHost, authorization: "Bearer " + token } })).json();
  try {
    const response = await page.request("/api/projects/p1/commands", {
      method: "POST", headers, body: JSON.stringify({ name: "next" }),
    });
    expect(await response.json()).toEqual({ ok: true, queued: 1 });
    expect((await status("ada")).rooms).toEqual([{ workspace: "default", project: "p1", queued: 1, pages: 0, coordinators: 0, asks: 0 }]);
    expect((await status("grace")).rooms).toEqual([]);
    const wrongWorkspace = await page.request("/api/link?role=coordinator&workspace=extra&project=p1", {
      headers: { ...rolesHost, authorization: "Bearer ada" },
    });
    expect(await wrongWorkspace.json()).toEqual({ error: "workspace extra is not configured" });
  } finally {
    page.link.stop();
  }
});

it.each(["org:1/a b", "org\n1", ""])("validates the tenant ID %j before a Linear write", async (id) => {
  const { asked } = graphLinear();
  const { tenants } = testTenants(TEAM);
  const fromSession = tenants.fromSession;
  tenants.fromSession = async (session) => {
    const membership = await fromSession(session);
    return membership && { ...membership, tenant: { ...membership.tenant, id } };
  };
  const page = createApp(hostedRoles, { team: TEAM, dist, auth: rolesAuth, tenants, watchMs: 0 });
  try {
    const headers = { ...await rolesHeaders("ada@example.com"), origin: "https://view.example.com", "content-type": "application/json" };
    const post = (path: string, body: object) =>
      page.request(path, { headers, method: "POST", body: JSON.stringify(body) });
    const result = await post("/api/issues/i1/comments", { body: "One comment" });
    if (id === "org:1/a b") {
      expect(result.status).toBe(200);
      expect(asked.comments).toEqual(["One comment"]);
      expect(await (await post("/api/projects/p1/commands", { name: "next" })).json()).toEqual({ ok: true, queued: 1 });
      expect(await (await page.request("/api/projects/p1/presence", { headers })).json()).toMatchObject({ queued: 1 });
    } else {
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(asked.comments).toEqual([]);
    }
  } finally {
    page.link.stop();
  }
});

it.skipIf(!localRedis).each([
  ["tenant", "remote"], ["tenant", "local"], ["workspace", "remote"], ["workspace", "local"],
])("closes sockets for a removed %s when the %s Redis instance checks first", async (removed, order) => {
  const redis = await startLocalRedis();
  try {
    const { tenants } = testTenants(TEAM);
    const tenant = (await tenants.byId("ada"))!;
    const options = { team: TEAM, dist, auth: rolesAuth, tenants, watchMs: 0, redisUrl: redis.url };
    const local = createApp(hostedRoles, options);
    const remote = createApp(hostedRoles, options);
    try {
      const headers = { ...rolesHost, authorization: "Bearer ada" };
      const status = async (page: typeof local) => (await page.request("/api/status", { headers })).json();
      await vi.waitFor(async () => expect((await status(remote)).redisReady).toBe(true));
      await vi.waitFor(async () => expect((await status(local)).redisReady).toBe(true));
      const ref = { workspace: "default", id: "p1", tenant: "ada" };
      const close = vi.fn();
      const socket = await local.link.hub.joinCoordinator({ close, send: () => {} }, ref);
      await socket.receive(JSON.stringify({ v: 1, type: "hello", payload: { session: "open" } }));
      const byId = tenants.byId;
      tenants.byId = (id) => id === "ada" ? (removed === "tenant" ? null : { ...tenant, workspaces: [] }) : byId(id);
      const checks = order === "remote" ? [remote, local] : [local, remote];
      for (const page of checks) await page.link.check();
      expect(close).toHaveBeenCalledExactlyOnceWith(RESTART_CODE, "server restart");
      expect(await remote.link.hub.roomRefs()).toEqual([]);
      await socket.closed();
      expect(await local.link.hub.roomRefs()).toEqual([]);
    } finally {
      local.link.stop();
      remote.link.stop();
    }
  } finally {
    await redis.close();
  }
});

it.each(["revoked token", "changed role", "changed tenant", "change notice", "notice at open"] as const)(
  "refuses a socket when its identity changes at upgrade: %s", async (change) => {
    graphLinear();
    const directory = testTenants(TEAM);
    const ada = (await directory.tenants.byId("ada"))!;
    const grace = (await directory.tenants.byId("grace"))!;
    let lookups = 0;
    const coordinator = change === "revoked token" || change === "change notice" || change === "notice at open";
    if (coordinator) {
      directory.tenants.fromToken = () => {
        lookups++;
        if ((change === "change notice" && lookups === 1) || (change === "notice at open" && lookups === 2)) directory.change(ada);
        return change === "revoked token" && lookups > 1 ? null : ada;
      };
    } else {
      directory.tenants.fromSession = () => {
        const first = ++lookups === 1;
        return { tenant: !first && change === "changed tenant" ? grace : ada, role: !first && change === "changed role" ? "viewer" : "owner" };
      };
    }
    const page = createApp(hostedRoles, { team: TEAM, dist, auth: rolesAuth, tenants: directory.tenants, watchMs: 0 });
    const server = serve({ fetch: page.fetch, port: 0, hostname: "127.0.0.1" });
    let ws: WebSocket | undefined;
    try {
      page.injectWebSocket(server as never);
      if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
      const suffix = coordinator ? "coordinator&project=p1" : "page";
      const headers = coordinator ? { ...rolesHost, authorization: "Bearer ada" }
        : { ...await rolesHeaders("ada@example.com"), origin: "https://view.example.com" };
      ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/link?role=${suffix}`, { headers });
      let refusal: number | undefined;
      ws.on("error", () => {});
      ws.on("unexpected-response", (_request, response) => {
        refusal = response.statusCode;
        response.resume();
      });
      ws.on("close", (code) => { refusal = code; });
      await vi.waitFor(() => expect(refusal).toBe(change === "change notice" ? 503 : coordinator ? RESTART_CODE : 1008));
      expect(lookups).toBe(change === "change notice" ? 1 : 2);
      expect(await page.link.hub.roomRefs()).toEqual([]);
    } finally {
      ws?.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      page.link.stop();
    }
  },
);

it("requires a session for a tenant page socket even if the directory accepts a null session", async () => {
  const { tenants } = testTenants(TEAM);
  const tenant = (await tenants.byId("ada"))!;
  tenants.fromSession = () => ({ tenant, role: "owner" });
  const page = createApp(hostedRoles, { team: TEAM, dist, tenants, watchMs: 0 });
  try {
    const response = await page.request("/api/link?role=page", {
      headers: { ...rolesHost, origin: "https://view.example.com" },
    });
    expect(response.status).toBe(401);
  } finally {
    page.link.stop();
  }
});

it.each(localRedis ? ["memory", "redis"] : ["memory"])("isolates socket rooms with the %s link store", async (storage) => {
  const { state } = graphLinear();
  const respond = vi.mocked(fetch).getMockImplementation()!;
  const graphKeys: string[] = [];
  let editAda = false;
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    const key = new Headers(init?.headers).get("authorization")!;
    const { query } = JSON.parse(init!.body as string);
    if (query.includes("viewer{")) graphKeys.push(key);
    const response = await respond(url, init);
    const body = await response.json();
    if (query.includes("projects(first:50")) {
      body.data.teams.nodes[0].projects.nodes[0].labels = { nodes: [{ name: "shared", parent: null }] };
    }
    if (query.includes("issues(first:25")) {
      const changed = key === "ada-key" && editAda;
      body.data.project.issues.nodes = [{
        ...rawIssue("i1", `${TEAM}-1`, "p1"),
        updatedAt: changed ? "2026-11-21T00:00:00Z" : "2026-11-20T00:00:00Z",
      }];
    }
    return Response.json(body);
  });
  const redis = storage === "redis" ? await startLocalRedis() : null;
  try {
    const directory = testTenants(TEAM);
    let now = Date.now();
    const options = { team: TEAM, dist, auth: rolesAuth, tenants: directory.tenants, watchMs: 0, redisUrl: redis?.url, now: () => now };
    const first = createApp(hostedRoles, options);
    const second = redis ? createApp(hostedRoles, options) : first;
    const http = [...new Set([first, second])].map((page) => {
      const server = serve({ fetch: page.fetch, port: 0, hostname: "127.0.0.1" });
      page.injectWebSocket(server as never);
      return server;
    });
    const sockets: WebSocket[] = [];
    const origin = "https://view.example.com";
    const ada = { ...await rolesHeaders("ada@example.com"), origin, "content-type": "application/json" };
    const grace = { ...await rolesHeaders("grace@example.com"), origin, "content-type": "application/json" };
    const viewer = { ...await rolesHeaders("ada-viewer@example.com"), origin };
    const connect = async (server: typeof http[number], role: string, headers: Record<string, string>, project = "&project=p1") => {
      const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/link?role=${role}${project}`, { headers });
      sockets.push(ws);
      const messages: { type: string; project: unknown; payload: unknown }[] = [];
      ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
      const closed = new Promise<number>((resolve) => ws.once("close", resolve));
      await new Promise<void>((resolve, reject) => { ws.once("error", reject); ws.once("open", resolve); });
      const send = (type: string, payload: unknown) => ws.send(JSON.stringify({ v: 1, type, payload }));
      return { ws, closed, send, messages, of: (type: string) => messages.filter((message) => message.type === type) };
    };
    const token = (id: string) => ({ ...rolesHost, authorization: "Bearer " + id });
    const post = async (path: string, headers: Record<string, string>, body: object) =>
      second.request("/api/projects/p1/" + path, { method: "POST", headers, body: JSON.stringify(body) });
    try {
      for (const server of http) if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
      const other = http.at(-1)!;
      const a = await connect(http[0], "coordinator", token("ada"));
      a.send("hello", { session: "same-session" });
      const own = await connect(other, "page", ada);
      const view = await connect(other, "page", viewer);
      const foreign = await connect(other, "page", grace);
      await vi.waitFor(() => {
        expect(own.of("presence").at(-1)?.payload).toMatchObject({ coordinators: [{ connected: true }] });
        expect(foreign.of("presence").at(-1)?.payload).toEqual({ coordinators: [], queued: 0 });
      });
      a.send("asks", { asks: [{ id: "q", body: "Ada question" }] });
      a.send("progress", { nodes: [{ key: "ada-node" }] });
      a.send("agents", { agents: [{ id: "ada-agent" }] });
      await vi.waitFor(() => {
        expect(own.of("asks").at(-1)?.payload).toMatchObject({ asks: [{ id: "q" }] });
        expect(own.of("agents")).toHaveLength(1);
        expect(own.of("progress").at(-1)?.payload).toMatchObject({ nodes: [{ key: "ada-node" }] });
      });
      expect(view.of("progress")).toEqual([]);
      expect(view.of("asks")).toEqual([]);
      expect(view.of("agents")).toEqual([]);
      expect(JSON.stringify(foreign.messages)).not.toMatch(/Ada question|ada-node|ada-agent/);
      expect((await post("asks/q/reply", grace, { body: "Wrong room" })).status).toBe(404);
      expect((await post("asks/q/reply", ada, { body: "Own room" })).status).toBe(200);
      expect(await (await post("commands", grace, { name: "next" })).json()).toEqual({ ok: true, queued: 1 });

      const b = await connect(other, "coordinator", token("grace"));
      b.send("hello", { session: "same-session" });
      await vi.waitFor(() => expect(b.of("command")).toHaveLength(1));
      await vi.waitFor(() => expect(a.of("reply")).toHaveLength(1));
      expect(a.of("command")).toEqual([]);
      expect(b.of("reply")).toEqual([]);
      expect(a.ws.readyState).toBe(WebSocket.OPEN);

      b.send("wrote", { issues: [`${TEAM}-2`] });
      await vi.waitFor(() => expect(foreign.of("changed")).toHaveLength(1));
      expect(own.of("changed")).toEqual([]);
      expect(a.of("changed")).toEqual([]);

      const graceOverview = await connect(other, "page", grace, "");
      await second.request("/api/projects", { headers: viewer });
      const viewOverview = await connect(other, "page", viewer, "");
      await vi.waitFor(() => {
        expect(graceOverview.of("presence").at(-1)?.payload).toMatchObject({ coordinators: [{ connected: true }], queued: 1 });
        expect(viewOverview.of("presence").at(-1)?.payload).toMatchObject({ coordinators: [{ session: "0" }], queued: 0 });
      });
      expect(graceOverview.messages.map(({ type }) => type)).toEqual(["presence"]);
      const presence = async (headers: Record<string, string>) => (await second.request("/api/projects/p1/presence", { headers })).json();
      expect(await presence(ada)).toMatchObject({ coordinators: [{ connected: true }], queued: 1 });
      expect(await presence(viewer)).toMatchObject({ coordinators: [{ connected: true, session: "0" }], queued: 0 });
      const unshared = await first.link.hub.joinCoordinator({ send: () => {}, close: () => {} },
        { workspace: "default", id: "p2", tenant: "ada" });
      const sendUnshared = (type: string, payload: object) => unshared.receive(JSON.stringify({ v: 1, type, payload }));
      await sendUnshared("hello", { session: "unshared" });
      await sendUnshared("asks", { asks: [{ id: "unshared" }] });
      await sendUnshared("agents", { agents: [{ id: "unshared" }] });
      await sendUnshared("progress", { nodes: [{ key: "unshared" }] });
      await unshared.closed();
      a.send("asks", { asks: [{ id: "private", body: "Ada only" }] });
      a.send("agents", { agents: [{ id: "private" }] });
      a.send("progress", { nodes: [{ key: "private" }] });
      a.send("wrote", {});
      await vi.waitFor(() => expect(viewOverview.of("changed")).toHaveLength(1));
      expect(viewOverview.messages.map(({ type }) => type)).toEqual(["presence", "changed"]);
      expect(graceOverview.messages.map(({ type }) => type)).toEqual(["presence"]);

      await first.link.check();
      if (redis) await second.link.check();
      expect(new Set(graphKeys)).toEqual(new Set(["ada-key", "grace-key"]));
      editAda = true;
      state.changed = ["p1"];
      now += 60_000;
      await first.link.check();
      if (redis) await second.link.check();
      await vi.waitFor(() => expect(a.of("changed")).toHaveLength(1));
      expect(b.of("changed")).toEqual([]);

      const tenant = (await directory.tenants.byId("ada"))!;
      directory.change(tenant);
      await vi.waitFor(() => expect([a.ws, own.ws, view.ws].every((ws) => ws.readyState === WebSocket.CLOSED)).toBe(true));
      expect(await a.closed).toBe(RESTART_CODE);
      expect(await own.closed).toBe(RESTART_CODE);
      expect(await view.closed).toBe(RESTART_CODE);
      expect(b.ws.readyState).toBe(WebSocket.OPEN);
      expect(foreign.ws.readyState).toBe(WebSocket.OPEN);
      const again = await connect(other, "coordinator", token("ada"));
      again.send("hello", { session: "same-session" });
      await vi.waitFor(() => expect(again.of("reply")).toHaveLength(1));
      expect(again.of("command")).toEqual([]);
      for (const { project } of [...a.messages, ...b.messages, ...own.messages, ...view.messages, ...foreign.messages, ...again.messages]) {
        expect(project).toEqual({ workspace: "default", id: "p1" });
      }
      directory.change({ ...tenant, workspaces: [] });
      await vi.waitFor(() => expect(again.ws.readyState).toBe(WebSocket.CLOSED));
      expect(await again.closed).toBe(RESTART_CODE);
      await first.link.check();
      const status = await (await second.request("/api/status", { headers: token("ada") })).json();
      expect(status.rooms).toEqual([]);
      expect(b.ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      for (const socket of sockets) socket.terminate();
      for (const server of http) await new Promise<void>((resolve) => server.close(() => resolve()));
      first.link.stop();
      if (redis) second.link.stop();
    }
  } finally {
    await redis?.close();
  }
});

it("isolates site, projects, graphs and budgets for tenants with the same workspace id", async () => {
  const { state } = graphLinear();
  const issue = rawIssue("i1", `${TEAM}-1`, "p1");
  state.issues.p1 = [{ ...issue, labels: { nodes: [{ name: "needs-ada" }, { name: "needs-grace" }] } }];
  const respond = vi.mocked(fetch).getMockImplementation()!;
  const loads: string[] = [];
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  let hold = true;
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    const key = new Headers(init?.headers).get("authorization")!;
    const { query } = JSON.parse(init!.body as string);
    const human = key === "ada-key" ? "Ada" : "Grace";
    if (query.includes("viewer{")) loads.push(human);
    if (hold && human === "Ada" && query.includes("projects(first:50")) {
      hold = false;
      enter();
      await held;
    }
    const body = query.includes("members(first") ? { data: { teams: { nodes: [
      { id: "team", key: human, states: { nodes: [] }, members: { nodes: [] } },
    ] } } } : await (await respond(url, init)).json();
    if (body.data.project?.name) body.data.project.name = human;
    for (const project of body.data.teams?.nodes[0]?.projects?.nodes ?? []) {
      project.name = human;
      if (human === "Ada" && project.id === "p1") project.labels = { nodes: [{ name: "shared", parent: null }] };
    }
    return Response.json(body, { headers: { "x-ratelimit-requests-remaining": human === "Ada" ? "11" : "22" } });
  });
  const directory = testTenants(TEAM);
  let time = Date.now() - 30 * 60_000;
  const page = createApp(hostedRoles, { team: TEAM, dist, auth: rolesAuth, tenants: directory.tenants, watchMs: 0, now: () => time });
  const ada = await rolesHeaders("ada@example.com");
  const grace = await rolesHeaders("grace@example.com");
  const get = (path: string, headers: Record<string, string>) => Promise.resolve(page.request("/api" + path, { headers }));
  const overview = get("/overview", ada);
  try {
    const first = await Promise.race([entered.then(() => null), overview]);
    expect(first).toBeNull();
    for (const [headers, human, token, budget] of [[grace, "Grace", "grace", 22], [ada, "Ada", "ada", 11]] as const) {
      expect(await (await get("/config", headers)).json()).toMatchObject({ human, defaultWorkspace: "default" });
      expect(await (await get("/projects", headers)).json()).toMatchObject({ projects: expect.arrayContaining([expect.objectContaining({ name: human })]) });
      expect(await (await get("/projects/p1/graph", headers)).json()).toMatchObject({ project: { name: human }, teams: { team: { key: human } } });
      const status = await (await get("/status", { ...rolesHost, authorization: "Bearer " + token })).json();
      expect(status.workspaces).toHaveLength(human === "Ada" ? 1 : 2);
      expect(status.workspaces[0]).toMatchObject({ name: human, requestsRemaining: budget });
    }
    expect(await (await get("/overview", grace)).json()).toMatchObject({ summaries: expect.arrayContaining([
      expect.objectContaining({ id: "p1", you: [expect.objectContaining({ why: "Needs Grace" })] }),
    ]) });
    release();
    expect(await (await overview).json()).toMatchObject({ summaries: expect.arrayContaining([
      expect.objectContaining({ id: "p1", you: [expect.objectContaining({ why: "Needs Ada" })] }),
    ]) });
    const adaViewer = await rolesHeaders("ada-viewer@example.com");
    const graceViewer = await rolesHeaders("grace-viewer@example.com");
    expect((await get("/projects/p1/graph", adaViewer)).status).toBe(200);
    expect((await get("/projects/p1/graph", graceViewer)).status).toBe(404);
    expect(await (await get("/projects/p1/graph", { ...ada, "x-workspace": "extra" })).json())
      .toEqual({ error: "workspace extra is not configured" });
    const comment = await page.request("/api/issues/i1/comments", {
      method: "POST", headers: { ...ada, origin: "https://view.example.com", "content-type": "application/json" },
      body: JSON.stringify({ body: "A comment" }),
    });
    expect(comment.status).toBe(200);
    loads.length = 0;
    await get("/projects/p1/graph", grace);
    await get("/projects/p1/graph", ada);
    expect(loads).toEqual(["Ada"]);
    const tenant = (await directory.tenants.byId("grace"))!;
    directory.change({ ...tenant, workspaces: tenant.workspaces.slice(0, 1) });
    expect((await get("/projects/p1/graph", { ...grace, "x-workspace": "extra" })).status).toBe(400);
    expect((await (await get("/status", { ...rolesHost, authorization: "Bearer grace" })).json()).workspaces)
      .toMatchObject([{ id: "default", requestsRemaining: null }]);
    loads.length = 0;
    await get("/projects/p1/graph", ada);
    await get("/projects/p1/graph", grace);
    expect(loads).toEqual(["Grace"]);
    time += 30 * 60_000;
    expect((await (await get("/status", { ...rolesHost, authorization: "Bearer ada" })).json()).workspaces)
      .toMatchObject([{ id: "default", requestsRemaining: null }]);
    loads.length = 0;
    await get("/projects/p1/graph", ada);
    expect(loads).toEqual(["Ada"]);
  } finally {
    release();
    await overview.catch(() => {});
    page.link.stop();
  }
});

it.each(["session", "token"] as const)("discards cache fills when a change races a %s lookup", async (lookup) => {
  graphLinear();
  const respond = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    const key = new Headers(init?.headers).get("authorization");
    const { data } = await (await respond(url, init)).json();
    if (data.project?.name) data.project.name = key;
    const project = data.teams?.nodes[0]?.projects?.nodes[0];
    if (project && key === "grace-key") project.labels = { nodes: [{ name: "shared", parent: null }] };
    return Response.json({ data }, { headers: { "x-ratelimit-requests-remaining": key === "grace-key" ? "22" : "33" } });
  });
  const directory = testTenants(TEAM);
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held = false;
  const hold = async <T,>(value: T): Promise<T> => {
    if (!held) {
      held = true;
      enter();
      await gate;
    }
    return value;
  };
  const original = directory.tenants;
  const tenants = {
    ...original,
    fromSession: async (session: Parameters<typeof original.fromSession>[0]) => {
      const membership = await original.fromSession(session);
      return lookup === "session" ? hold(membership) : membership;
    },
    fromToken: async (value: string | undefined) => {
      const tenant = await original.fromToken(value);
      return lookup === "token" ? hold(tenant) : tenant;
    },
  };
  const page = createApp(hostedRoles, { team: TEAM, dist, auth: rolesAuth, tenants, watchMs: 0 });
  const headers = await rolesHeaders(lookup === "session" ? "grace@example.com" : "grace-viewer@example.com");
  const graph = "/api/projects/p1/graph";
  const first = Promise.resolve(page.request(lookup === "session" ? graph : "/api/projects/p1/presence", { headers }));
  try {
    expect(await Promise.race([entered, first])).toBeUndefined();
    const tenant = (await original.byId("grace"))!;
    directory.change({ ...tenant, workspaces: [{ ...tenant.workspaces[0], key: "grace-key-2" }] });
    release();
    expect((await first).status).toBe(200);
    const next = await page.request(graph, { headers });
    if (lookup === "token") expect(next.status).toBe(404);
    else expect(await next.json()).toMatchObject({ project: { name: "grace-key-2" } });
    const status = await page.request("/api/status", { headers: { ...rolesHost, authorization: "Bearer grace", "x-workspace": "unknown" } });
    expect(await status.json()).toMatchObject({ workspaces: [{ requestsRemaining: 33 }] });
  } finally {
    release();
    await first.catch(() => {});
    page.link.stop();
  }
});

it("keeps config workspace selection and errors on the same routes", async () => {
  graphLinear();
  const workspaces = ["a", "b"].map((id) => ({ ...workWorkspace(), id }));
  const page = createApp(rules, { team: TEAM, dist, human: "Ada", workspaces, watchMs: 0 });
  const ask = (path: string, workspace?: string) =>
    page.request(path, { headers: { ...local, ...(workspace ? { "x-workspace": workspace } : {}) } });
  const graph = "/api/projects/p1/graph";
  try {
    expect(await (await ask("/api/config")).json()).toMatchObject({ human: "Ada", defaultWorkspace: "a" });
    for (const [path, header, selected] of [[graph, undefined, "a"], [graph, "b", "b"],
      [graph + "?workspace=b", undefined, "a"], [graph + "?workspace=bogus", undefined, "a"]] as const) {
      const response = await ask(path, header);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ workspace: selected });
    }
    for (const path of [graph, "/api/nope"]) {
      const response = await ask(path, "bogus");
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "workspace bogus is not configured" });
    }
    for (const [path, header] of [["/api/projects", "bogus"], ["/api/overview", "bogus"],
      ["/api/status", "bogus"], ["/api/status", undefined]] as const) {
      const response = await ask(path, header);
      expect(response.status).toBe(200);
      expect((await response.json()).workspaces.map(({ id }: { id: string }) => id)).toEqual(["a", "b"]);
    }
    expect((await ask("/api/projects/p1/presence")).status).toBe(200);
    const link = "/api/link?role=page&workspace=bogus";
    expect((await ask(link)).status).toBe(403);
    expect((await page.request(link, { headers: write })).status).toBe(400);
  } finally {
    page.link.stop();
  }
});

describe("read-only viewer", () => {
  const viewer = () => createApp(rules, { team: "CD", dist, workspaces: [workWorkspace()], readOnly: true });

  it("refuses each write and the link, and says in the config that it is read-only", async () => {
    linear({});
    const patch = await viewer().request("/api/issues/i1", { method: "PATCH", headers: write, body: JSON.stringify({ priority: 1 }) });
    expect(patch.status).toBe(405);
    expect(await patch.json()).toEqual({ error: "this page is read-only" });
    const command = await viewer().request("/api/projects/p1/commands", { method: "POST", headers: write, body: JSON.stringify({ name: "next" }) });
    expect(command.status).toBe(405);
    // The method decides, not the headers of a write: a POST with no Origin and no JSON type gets the same answer.
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      expect([method, (await viewer().request("/api/projects/p1/share", { method, headers: local })).status]).toEqual([method, 405]);
    }
    expect((await viewer().request("/api/projects/p1/share", { method: "POST", headers: { host: "evil.example" } })).status).toBe(403);
    // HEAD reads, as GET does.
    expect((await viewer().request("/api/config", { method: "HEAD", headers: local })).status).toBe(200);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect((await viewer().request("/api/link?role=coordinator&project=p1", { headers: local })).status).toBe(404);
    expect(await (await viewer().request("/api/config", { headers: local })).json()).toMatchObject({ readOnly: true });
    expect(await (await app().request("/api/config", { headers: local })).json()).toMatchObject({ readOnly: false });
  });
  it("lists only the projects that have the label shared", async () => {
    const shared = { nodes: [{ name: "shared", parent: null }] };
    // A child label of a group with the same name does not share the project.
    const child = { nodes: [{ name: "shared", parent: { name: "Initiative" } }] };
    const projects = { nodes: [{ id: "p1", name: "A", url: "u", status: null, labels: shared }, { id: "p2", name: "B", url: "u", status: null },
      { id: "p3", name: "C", url: "u", status: null, labels: child }], pageInfo: { hasNextPage: false, endCursor: null } };
    linear({ teams: { nodes: [{ projects }] } });
    const list = await (await viewer().request("/api/projects", { headers: local })).json();
    expect(list.projects.map((p: { id: string; shared: boolean }) => [p.id, p.shared])).toEqual([["p1", true]]);
    const full = await (await app().request("/api/projects", { headers: local })).json();
    expect(full.projects.map((p: { id: string; shared: boolean }) => [p.id, p.shared])).toEqual([["p1", true], ["p2", false], ["p3", false]]);
  });
  it("finds the label shared on a project that has more than 20 labels", async () => {
    // The list reads the first 20 labels of a project, and asks for the marks by name: here only the second answer has it.
    const many = { nodes: Array.from({ length: 20 }, (_, at) => ({ name: `label ${at}`, parent: null })) };
    const projects = { nodes: [{ id: "p1", name: "A", url: "u", status: null, labels: many, marks: { nodes: [{ name: "shared", parent: null }, { name: "paused", parent: null }] } }],
      pageInfo: { hasNextPage: false, endCursor: null } };
    const calls = linear({ teams: { nodes: [{ projects }] } });
    const list = await (await viewer().request("/api/projects", { headers: local })).json();
    expect(list.projects).toMatchObject([{ id: "p1", shared: true, paused: true }]);
    expect(calls).toHaveLength(1);
  });
  it.each([false, true])("reduces the graph, status, overview and comments (signed-in role: %s)", async (mixed) => {
    const asked: string[] = [];
    // The project of each issue in Linear now. i1 moves later.
    const home: Record<string, string> = { i1: "p1", i9: "p9" };
    const none = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
    const raw = (id: string, identifier: string, title: string, project: string, over: Record<string, unknown> = {}) => ({
      id, identifier, title, description: `text of ${title}`, priority: 0, url: "u", sortOrder: 0, updatedAt: "2026-11-20T00:00:00Z",
      team: { id: "team", key: "CD" }, state: { id: "s", name: "Todo", type: "unstarted", color: "" }, assignee: null,
      labels: { nodes: [] }, projectMilestone: null, relations: none, inverseRelations: none,
      comments: { nodes: [] }, attachments: { nodes: [] }, project: { id: project }, ...over,
    });
    const outside = { id: "o1", identifier: "CD-9", title: "Private plan", url: "u", team: { key: "CD" }, state: { id: "s", name: "Todo", type: "unstarted", color: "" }, project: { id: "p2" } };
    vi.stubEnv("LINEAR_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const { query, variables } = JSON.parse(init.body as string);
      let data;
      if (query.includes("projects(first:50")) data = { teams: { nodes: [{ projects: { nodes: [
        { id: "p1", name: "Shared", url: "u", status: null, labels: { nodes: [{ name: "shared", parent: null }] } },
        { id: "p2", name: "Private", url: "u", status: null },
      ], pageInfo: { hasNextPage: false, endCursor: null } } }] } };
      else if (query.includes("viewer{")) {
        asked.push(`graph ${variables.id}`);
        // The status document of the project, as `wg next` writes it: a line can name an issue that the plan maps from another project.
        const status = "work-graph status\n\n- do ask CD-9: private line\n\n```json\n" + JSON.stringify({ wg: 1, status: "phase 1: 2 tasks; wave a,private-key", wave: ["a", "private-key"], ran: "2026-11-20T00:00:00Z", lines: [{ level: "do", text: "ask CD-9: private line" }] }) + "\n```";
        data = { viewer: { id: "me" }, project: { id: variables.id, name: "Shared", url: "u", projectMilestones: { nodes: [] }, documents: { nodes: [{ content: status, updatedAt: "2026-11-20T00:00:00Z" }] } } };
      }
      // The issue of the private project that blocks CD-1: the full page shows it as an outside node.
      else if (query.includes("issues(first:25,filter:")) data = { issues: { nodes: [raw("o1", "CD-9", "Private plan", "p2", {
        state: { id: "s2", name: "Needs Human", type: "started", color: "" },
        comments: { nodes: [{ id: "c9", body: "**work-graph node card** `private-key`\n\n```json\n{\"wg\":1,\"key\":\"private-key\",\"next\":\"private next step\"}\n```" }] },
      })] } };
      else if (query.includes("issues(first:25")) data = { project: { issues: { nodes: [raw("i1", "CD-1", "One", "p1", {
        comments: { nodes: [{ id: "c1", body: "**work-graph node card** `a`\n\n```json\n{\"wg\":1,\"key\":\"a\"}\n```" }] },
        inverseRelations: { nodes: [{ type: "blocks", issue: outside }], pageInfo: { hasNextPage: false, endCursor: null } },
      })], pageInfo: { hasNextPage: false, endCursor: null } } } };
      else if (query.includes("comments(first:50")) {
        asked.push(`comments ${variables.id}`);
        data = { issue: home[variables.id] ? { project: { id: home[variables.id] }, comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } : null };
      }
      else if (query.includes("members(first")) data = { teams: { nodes: [] } };
      else data = { issueLabels: { nodes: [], pageInfo: { hasNextPage: false } } };
      return { ok: true, json: async () => ({ data }) };
    }));
    const page = mixed ? rolesPage() : viewer();
    const headers = mixed ? await rolesHeaders("viewer@example.com") : local;
    const get = (path: string, project?: string) => page.request(path, { headers: { ...headers, ...(project ? { "x-project": project } : {}) } });
    const graph = await get("/api/projects/p1/graph");
    expect(graph.status).toBe(200);
    const text = await graph.text();
    expect(JSON.parse(text).issues.map((i: { identifier: string; blockedBy: unknown[] }) => [i.identifier, i.blockedBy])).toEqual([["CD-1", []]]);
    for (const secret of ["Private plan", "CD-9", "private next step", "private line", "private-key"]) expect(text).not.toContain(secret);
    // The status of the effort stays: its counts, its times, and the nodes of the wave that the viewer shows.
    // The lines of the coordinator and the key of the outside node do not.
    expect(JSON.parse(JSON.parse(text).status.content.match(/```json\n([\s\S]*?)\n```/)[1])).toEqual({ wg: 1, status: "phase 1: 2 tasks; wave a", wave: ["a"], ran: "2026-11-20T00:00:00Z", lines: [] });
    // The full page shows the outside issue: the test data has it.
    const full = await (await app().request("/api/projects/p1/graph", { headers: local })).text();
    expect(full).toContain("Private plan");
    expect(full).toContain("private next step");
    expect(full).toContain("private line");
    expect(full).toContain("wave a,private-key");
    const hidden = await get("/api/projects/p2/graph");
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual({ error: "no shared project with this id" });
    asked.length = 0;
    expect((await get("/api/issues/i1/comments", "p1")).status).toBe(200);
    // The comments need the shared project of the issue: no project, a private one, an issue of another project,
    // and an issue that Linear does not have give 404.
    expect((await get("/api/issues/i1/comments")).status).toBe(404);
    expect((await get("/api/issues/i1/comments", "p2")).status).toBe(404);
    expect((await get("/api/issues/i9/comments", "p1")).status).toBe(404);
    expect((await get("/api/issues/gone/comments", "p1")).status).toBe(404);
    // The issue moves to the private project. The graph of p1 in memory still has it; Linear decides.
    home.i1 = "p2";
    expect((await get("/api/issues/i1/comments", "p1")).status).toBe(404);
    expect(asked).toEqual(["comments i1", "comments i9", "comments gone", "comments i1"]);
    // The overview counts no outside issue, and does not name it as a move of the human's.
    const overview = await (await get("/api/overview")).json();
    expect(overview.summaries).toMatchObject([{ id: "p1", planned: 1, you: [] }]);
    for (const secret of ["Private plan", "private-key"]) expect(JSON.stringify(overview)).not.toContain(secret);
    expect(overview.summaries[0].effort.status).toBe("phase 1: 2 tasks; wave a");
    expect((await (await app().request("/api/overview", { headers: local })).json()).summaries[0]).toMatchObject({ planned: 2, you: [{ identifier: "CD-9" }] });
  });
  it("stops giving a project at once when a list from Linear shows that it is not shared now", async () => {
    let shared = true;
    vi.stubEnv("LINEAR_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const { query, variables } = JSON.parse(init.body as string);
      let data;
      if (query.includes("projects(first:50")) data = { teams: { nodes: [{ projects: { nodes: [
        { id: "p1", name: "Shared", url: "u", status: null, labels: { nodes: shared ? [{ name: "shared", parent: null }] : [] } },
      ], pageInfo: { hasNextPage: false, endCursor: null } } }] } };
      else if (query.includes("viewer{")) data = { viewer: { id: "me" }, project: { id: variables.id, name: "Shared", url: "u", projectMilestones: { nodes: [] } } };
      else if (query.includes("issues(first:25")) data = { project: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } };
      else if (query.includes("comments(first:50")) data = { issue: { project: { id: "p1" }, comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } };
      else if (query.includes("members(first")) data = { teams: { nodes: [] } };
      else data = { issueLabels: { nodes: [], pageInfo: { hasNextPage: false } } };
      return { ok: true, json: async () => ({ data }) };
    }));
    const page = viewer();
    expect((await page.request("/api/projects/p1/graph", { headers: local })).status).toBe(200);
    // The owner stops the share. The next list that any viewer loads (the overview polls it) ends the grant.
    shared = false;
    expect((await (await page.request("/api/projects", { headers: local })).json()).projects).toEqual([]);
    expect((await page.request("/api/projects/p1/graph", { headers: local })).status).toBe(404);
    expect((await page.request("/api/issues/i1/comments", { headers: { ...local, "x-project": "p1" } })).status).toBe(404);
  });
  it("does not take an older list that ends after a newer one", async () => {
    // Each list request waits until the test lets it go, with the answer of the time when it started.
    const waiting: { shared: boolean; go: () => void }[] = [];
    let shared = true, hold = false;
    vi.stubEnv("LINEAR_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const { query, variables } = JSON.parse(init.body as string);
      let data;
      if (query.includes("projects(first:50")) {
        const then = shared;
        if (hold) await new Promise<void>((go) => waiting.push({ shared: then, go }));
        data = { teams: { nodes: [{ projects: { nodes: [
          { id: "p1", name: "Shared", url: "u", status: null, labels: { nodes: then ? [{ name: "shared", parent: null }] : [] } },
        ], pageInfo: { hasNextPage: false, endCursor: null } } }] } };
      }
      else if (query.includes("viewer{")) data = { viewer: { id: "me" }, project: { id: variables.id, name: "Shared", url: "u", projectMilestones: { nodes: [] } } };
      else if (query.includes("issues(first:25")) data = { project: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } };
      else if (query.includes("members(first")) data = { teams: { nodes: [] } };
      else data = { issueLabels: { nodes: [], pageInfo: { hasNextPage: false } } };
      return { ok: true, json: async () => ({ data }) };
    }));
    const page = viewer();
    expect((await page.request("/api/projects/p1/graph", { headers: local })).status).toBe(200);
    hold = true;
    const older = page.request("/api/projects", { headers: local });
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    shared = false;
    const newer = page.request("/api/projects", { headers: local });
    await vi.waitFor(() => expect(waiting).toHaveLength(2));
    waiting[1].go();
    expect((await (await newer).json()).projects).toEqual([]);
    waiting[0].go();
    expect((await (await older).json()).projects).toHaveLength(1);
    hold = false;
    expect((await page.request("/api/projects/p1/graph", { headers: local })).status).toBe(404);
  });
  it.each([false, true])("gives no project or stale graph when Linear fails (signed-in role: %s)", async (mixed) => {
    let down = false, graphDown = false;
    vi.stubEnv("LINEAR_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const { query, variables } = JSON.parse(init.body as string);
      if (down || (graphDown && !query.includes("projects(first:50"))) return { ok: false, status: 503, json: async () => null };
      let data;
      if (query.includes("projects(first:50")) data = { teams: { nodes: [{ projects: { nodes: [
        { id: "p1", name: "Shared", url: "u", status: null, labels: { nodes: [{ name: "shared", parent: null }] } },
      ], pageInfo: { hasNextPage: false, endCursor: null } } }] } };
      // The check of the cache: nothing changed in the project.
      else if (query.includes("issues(first:1,")) data = { issues: { nodes: [] }, comments: { nodes: [] }, project: { documents: { nodes: [] } } };
      else if (query.includes("viewer{")) data = { viewer: { id: "me" }, project: { id: variables.id, name: "Shared", url: "u", projectMilestones: { nodes: [] } } };
      else if (query.includes("issues(first:25")) data = { project: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } };
      else if (query.includes("members(first")) data = { teams: { nodes: [] } };
      else data = { issueLabels: { nodes: [], pageInfo: { hasNextPage: false } } };
      return { ok: true, json: async () => ({ data }) };
    }));
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    try {
      const page = mixed ? rolesPage() : viewer();
      const headers = mixed ? await rolesHeaders("viewer@example.com") : local;
      expect((await page.request("/api/projects/p1/graph", { headers })).status).toBe(200);
      // The list is too old now, and Linear is down: the server cannot know that the project is still shared.
      down = true;
      clock.mockReturnValue(start + 61_000);
      const closed = await page.request("/api/projects/p1/graph", { headers });
      expect(closed.status).toBe(503);
      expect(await closed.json()).toEqual({ error: "Linear did not confirm that this project is shared. Try again." });
      expect((await page.request("/api/issues/i1/comments", { headers: { ...headers, "x-project": "p1" } })).status).toBe(503);
      down = false;
      clock.mockReturnValue(start + 70_000);
      expect((await page.request("/api/projects/p1/graph", { headers })).status).toBe(200);
      // Linear gives the list but not the graph: the viewer gives no older graph, in which an issue can be that
      // moved to another project since. The full page gives its last graph, marked stale.
      const owner = mixed ? page : app();
      const ownerHeaders = mixed ? await rolesHeaders("ada@example.com") : local;
      expect((await owner.request("/api/projects/p1/graph", { headers: ownerHeaders })).status).toBe(200);
      graphDown = true;
      clock.mockReturnValue(start + 100_000);
      const old = await page.request("/api/projects/p1/graph", { headers });
      expect(old.status).toBeGreaterThanOrEqual(500);
      expect(await old.json()).not.toHaveProperty("issues");
      expect(await (await owner.request("/api/projects/p1/graph", { headers: ownerHeaders })).json()).toMatchObject({ stale: true });
    } finally {
      clock.mockRestore();
    }
  });
});

describe("sign-in of the viewer", () => {
  const hosted: Rules = { port: 4747, tailnet: null, hosted: { host: "view.example.com" } };
  const auth = { domains: ["example.com"], clientId: "client-1", clientSecret: "client-secret", secret: "a-session-secret-of-32-characters" };
  const signedIn = (linkToken?: string) => createApp(hosted, { team: "CD", dist, workspaces: [workWorkspace()], readOnly: true, auth, linkToken });
  const host = { host: "view.example.com" };

  it("gives 401 for the API without a session, and still serves the page, the config, and the health check", async () => {
    linear({ teams: { nodes: [{ projects: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }] } });
    const page = signedIn();
    for (const path of ["/api/projects", "/api/overview", "/api/status", "/api/projects/p1/graph", "/api/issues/i1/comments"]) {
      const response = await page.request(path, { headers: host });
      expect([path, response.status]).toEqual([path, 401]);
      expect(await response.json()).toEqual({ error: "sign in", login: "/auth/login" });
    }
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(await (await page.request("/api/config", { headers: host })).json()).toMatchObject({ readOnly: true, auth: true, user: null });
    expect(await (await page.request("/", { headers: host })).text()).toBe("<html>wg</html>");
    expect((await page.request("/healthz")).status).toBe(200);
    // A page with no sign-in says so, and takes each caller that the host check lets through.
    expect(await (await app().request("/api/config", { headers: local })).json()).toMatchObject({ auth: false, user: null });
  });

  it("accepts only the correct bearer token for a read without a session", async () => {
    const page = signedIn("a-test-token-with-32-characters-or-more");
    const headers = { ...host, authorization: "Bearer a-test-token-with-32-characters-or-more" };
    expect((await page.request("/api/status", { headers })).status).toBe(200);
    expect((await page.request("/api/status", { headers: { ...headers, authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await page.request("/api/issues/i1/comments", { method: "POST", headers })).status).toBe(405);
  });

  /** An ID token as Google's token endpoint gives it: the claims are the middle part. */
  const idToken = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify({
    iss: "https://accounts.google.com", aud: "client-1", exp: Math.floor(Date.now() / 1000) + 600, email_verified: true, ...claims,
  })).toString("base64url")}.s`;
  const cookies = (response: Response) => Object.fromEntries(response.headers.getSetCookie().map((line) => {
    const [pair] = line.split(";");
    return [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)];
  }));
  /** Google and Linear: the token endpoint gives `token`, each other call is a Linear call with an empty project list. */
  const google = (token: unknown) => {
    const sent: URLSearchParams[] = [];
    vi.stubEnv("LINEAR_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (String(url) === "https://oauth2.googleapis.com/token") {
        sent.push(init.body as URLSearchParams);
        return { ok: token !== null, json: async () => token };
      }
      return { ok: true, json: async () => ({ data: { teams: { nodes: [{ projects: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }] } } }) };
    }));
    return sent;
  };
  /** Starts a sign-in and comes back from Google with `code`. */
  const signIn = async (page: ReturnType<typeof signedIn>, next = "") => {
    const login = await page.request(`/auth/login${next}`, { headers: host });
    const to = new URL(login.headers.get("location")!);
    const callback = await page.request(`/auth/callback?code=code-1&state=${to.searchParams.get("state")}`, {
      headers: { ...host, cookie: `__Host-wg_signin=${cookies(login)["__Host-wg_signin"]}` },
    });
    return { login, to, callback };
  };

  it("signs in an account of the domain, and then the API answers", async () => {
    const sent = google({ id_token: idToken({ email: "Ada@Example.com", hd: "example.com" }) });
    const page = signedIn();
    const { login, to, callback } = await signIn(page, "?next=/%3Fproject%3DA");
    expect(login.status).toBe(302);
    expect(to.origin + to.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(to.searchParams)).toMatchObject({
      client_id: "client-1", redirect_uri: "https://view.example.com/auth/callback", response_type: "code", scope: "openid email", hd: "example.com",
    });
    expect(login.headers.getSetCookie()[0]).toMatch(/^__Host-wg_signin=.*; Max-Age=600; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
    expect(Object.fromEntries(sent[0])).toEqual({
      code: "code-1", client_id: "client-1", client_secret: "client-secret", redirect_uri: "https://view.example.com/auth/callback", grant_type: "authorization_code",
    });
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("https://view.example.com/?project=A");
    const session = callback.headers.getSetCookie().find((line) => line.startsWith("__Host-wg_session="))!;
    expect(session).toMatch(/; Max-Age=604800; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
    const cookie = `__Host-wg_session=${cookies(callback)["__Host-wg_session"]}`;
    expect((await page.request("/api/projects", { headers: { ...host, cookie } })).status).toBe(200);
    expect(await (await page.request("/api/config", { headers: { ...host, cookie } })).json()).toMatchObject({ auth: true, user: "ada@example.com" });
    // A changed cookie is no session.
    expect((await page.request("/api/projects", { headers: { ...host, cookie: `${cookie.slice(0, -3)}abc` } })).status).toBe(401);
    const out = await page.request("/auth/logout", { headers: { ...host, cookie } });
    expect(out.headers.get("location")).toBe("https://view.example.com/");
    expect(out.headers.getSetCookie()[0]).toMatch(/^__Host-wg_session=; Max-Age=0/);
  });
  it("gives no session to an account that may not use the page", async () => {
    const page = signedIn();
    const refused = async (token: unknown) => {
      google(token);
      const { callback } = await signIn(page);
      expect(callback.headers.getSetCookie().some((line) => line.startsWith("__Host-wg_session="))).toBe(false);
      return [callback.status, (await callback.json()).error];
    };
    expect(await refused({ id_token: idToken({ email: "eve@other.example", hd: "other.example" }) })).toEqual([403, "this account may not use this page"]);
    // A personal Google account with an address of the domain has no `hd`.
    expect(await refused({ id_token: idToken({ email: "eve@example.com" }) })).toEqual([403, "this account may not use this page"]);
    expect(await refused({ id_token: idToken({ email: "ada@example.com", hd: "example.com", email_verified: false }) })).toEqual([403, "the account has no verified email"]);
    expect(await refused({ id_token: idToken({ email: "ada@example.com", hd: "example.com", aud: "another-client" }) })).toEqual([403, "the ID token is not for this page"]);
    expect(await refused({ id_token: idToken({ email: "ada@example.com", hd: "example.com", exp: 1 }) })).toEqual([403, "the ID token ended"]);
    expect((await refused(null))[0]).toBe(502);
  });
  it("needs both the Workspace domain and the domain of the address in the list", async () => {
    // An organization with two domains: `hd` is its first domain, also for an address of the second one.
    const two = { ...auth, domains: ["example.com", "example.org"] };
    const page = createApp(hosted, { team: "CD", dist, workspaces: [workWorkspace()], readOnly: true, auth: two });
    const status = async (claims: Record<string, unknown>) => {
      google({ id_token: idToken(claims) });
      return (await signIn(page)).callback.status;
    };
    expect(await status({ email: "ada@example.org", hd: "example.com" })).toBe(302);
    expect(await status({ email: "ada@example.net", hd: "example.com" })).toBe(403);
    expect(await status({ email: "ada@example.org", hd: "example.net" })).toBe(403);
    // A session holds both domains: a config that no longer names one of them ends it.
    google({ id_token: idToken({ email: "ada@example.org", hd: "example.com" }) });
    const cookie = `__Host-wg_session=${cookies((await signIn(page)).callback)["__Host-wg_session"]}`;
    const withDomains = (domains: string[]) => createApp(hosted, { team: "CD", dist, workspaces: [workWorkspace()], readOnly: true, auth: { ...auth, domains } })
      .request("/api/projects", { headers: { ...host, cookie } });
    expect((await withDomains(["example.com", "example.org"])).status).toBe(200);
    expect((await withDomains(["example.org"])).status).toBe(401);
    expect((await withDomains(["example.com"])).status).toBe(401);
  });
  it("refuses a callback that this page did not start, and a path to another site after the sign-in", async () => {
    const sent = google({ id_token: idToken({ email: "ada@example.com", hd: "example.com" }) });
    const page = signedIn();
    const login = await page.request("/auth/login", { headers: host });
    const cookie = `__Host-wg_signin=${cookies(login)["__Host-wg_signin"]}`;
    expect((await page.request("/auth/callback?code=code-1&state=another", { headers: { ...host, cookie } })).status).toBe(400);
    expect((await page.request("/auth/callback?code=code-1&state=x", { headers: host })).status).toBe(400);
    expect(sent).toEqual([]);
    expect((await page.request("/auth/login", { headers: { host: "evil.example" } })).status).toBe(403);
    // A browser removes a tab and a line break from a URL, so `/<tab>/evil.example` is `//evil.example` to it.
    for (const next of ["//evil.example/", "https://evil.example/", "/\\evil.example", "/\t/evil.example", "/\n/evil.example", "\t//evil.example", "javascript:alert(1)"]) {
      const { callback } = await signIn(page, `?next=${encodeURIComponent(next)}`);
      expect([next, callback.headers.get("location")]).toEqual([next, "https://view.example.com/"]);
    }
    expect((await signIn(page, `?next=${encodeURIComponent("/?project=A b&issue=CD-1#x")}`)).callback.headers.get("location")).toBe("https://view.example.com/?project=A%20b&issue=CD-1#x");
    // A path that the parser makes shorter can start with `//` then: as a relative Location it would name another
    // site, so the Location is always the full address of this page.
    for (const next of ["/.//evil.example", "/x/..//evil.example"]) {
      const to = (await signIn(page, `?next=${encodeURIComponent(next)}`)).callback.headers.get("location")!;
      expect([next, new URL(to).origin, to.startsWith("https://view.example.com/")]).toEqual([next, "https://view.example.com", true]);
    }
  });
  it("ends a session after 7 days", async () => {
    google({ id_token: idToken({ email: "ada@example.com", hd: "example.com" }) });
    let now = Date.now();
    const page = createApp(hosted, { team: "CD", dist, workspaces: [workWorkspace()], readOnly: true, auth, now: () => now });
    const { callback } = await signIn(page);
    const cookie = `__Host-wg_session=${cookies(callback)["__Host-wg_session"]}`;
    now += 7 * 24 * 3600_000 - 1000;
    expect((await page.request("/api/projects", { headers: { ...host, cookie } })).status).toBe(200);
    now += 1000;
    expect((await page.request("/api/projects", { headers: { ...host, cookie } })).status).toBe(401);
  });
  it("starts a signed-in full page only with owners and a link token", () => {
    const options = { team: "CD", dist, workspaces: [workWorkspace()] };
    expect(() => createApp(rules, { ...options, readOnly: true, auth })).toThrow("the sign-in needs a hosted page");
    expect(() => createApp(hosted, { ...options, auth })).toThrow("auth.owners");
    expect(() => createApp(hosted, { ...options, linkToken: "", auth: { ...auth, owners: ["ada@example.com"] } })).toThrow("WG_LINK_TOKEN");
  });

  it("ends a session on another app before logout redirects", async () => {
    const options = {
      team: "WG", dist, workspaces: [workWorkspace()], readOnly: false, auth: rolesAuth, linkToken: rolesToken,
      watchMs: 0, linkState: memoryLinkState(), linkBus: memoryLinkBus(),
    };
    const a = createApp(hostedRoles, options);
    const b = createApp(hostedRoles, options);
    const http = serve({ fetch: b.fetch, port: 0, hostname: "127.0.0.1" });
    b.injectWebSocket(http as never);
    const headers = { ...await rolesHeaders("ada@example.com"), origin: "https://view.example.com" };
    let socket: WebSocket | undefined;
    try {
      if (!http.listening) await new Promise<void>((ok) => http.once("listening", ok));
      const address = http.address() as AddressInfo;
      socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/link?role=page`, { headers });
      const ws = socket;
      const closed = new Promise<number>((ok) => ws.once("close", ok));
      await new Promise((ok, fail) => { ws.once("open", ok); ws.once("error", fail); });
      expect((await b.request("/api/status", { headers })).status).toBe(200);
      expect((await a.request("/auth/logout", { headers })).status).toBe(302);
      expect((await b.request("/api/status", { headers })).status).toBe(401);
      expect(await closed).toBe(1008);
    } finally {
      socket?.terminate();
      http.close();
      await Promise.all([a.link.shutdown(), b.link.shutdown()]);
    }
  });

  it.skipIf(!localRedis).each(["startup", "reconnect after a pause"])("waits for Redis during %s", async (phase) => {
    const redis = await startLocalRedis();
    if (phase === "startup") await redis.stop();
    const page = createApp(rules, { team: "WG", dist, watchMs: 0, redisUrl: redis.url });
    const now = performance.now.bind(performance);
    const clock = vi.spyOn(performance, "now");
    const status = async () => (await page.request("/api/status", { headers: local })).json();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      if (phase !== "startup") {
        await vi.waitFor(async () => expect(await status()).toMatchObject({ redisReady: true }));
        clock.mockImplementation(() => now() + 5000);
        await redis.stop();
        await vi.waitFor(async () => expect(await status()).toMatchObject({ redisReady: false }));
      }
      const response = page.request("/api/link?role=page", { headers: { ...local, origin: "http://127.0.0.1:4747" } });
      await redis.start();
      // A plain HTTP request reaches the upgrade handler and falls through to 404.
      expect((await response).status).toBe(404);
      expect(warn).not.toHaveBeenCalledWith("Redis link lost");
      expect(log).not.toHaveBeenCalledWith("Redis link back");
    } finally {
      warn.mockRestore();
      log.mockRestore();
      clock.mockRestore();
      page.link.stop();
      await redis.close();
    }
  });

  it.skipIf(!localRedis)("keeps a link socket open when a fresh ping passes after a pause", async () => {
    const redis = await startLocalRedis();
    const admin = connectRedis(redis.url, undefined, undefined, true);
    const page = createApp(rules, { team: "WG", dist, watchMs: 0, redisUrl: redis.url });
    const close = vi.fn();
    const now = performance.now.bind(performance);
    const clock = vi.spyOn(performance, "now");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await page.link.hub.joinPage({ close, send: () => {} }, null);
      await admin.run((client) => client.client("PAUSE", 2200, "ALL"));
      const response = page.request("/api/link?role=page", { headers: { ...local, origin: "http://127.0.0.1:4747" } });
      await new Promise((resolve) => setTimeout(resolve, 100));
      clock.mockImplementation(() => now() + 5000);
      expect((await response).status).toBe(404);
      expect(close).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalledWith("Redis link lost");
    } finally {
      warn.mockRestore();
      clock.mockRestore();
      page.link.stop();
      admin.close();
      await redis.close();
    }
  });

  it.skipIf(!localRedis)("keeps signed-in reads and logout available during Redis loss", async () => {
    const redis = await startLocalRedis();
    const options = { team: "WG", dist, workspaces: [workWorkspace()], readOnly: false, auth: rolesAuth,
      linkToken: rolesToken, watchMs: 0, redisUrl: redis.url };
    const first = createApp(hostedRoles, options), second = createApp(hostedRoles, options);
    const live = await rolesHeaders("ada@example.com", "live");
    const ended = await rolesHeaders("ada@example.com", "ended");
    const pending = await rolesHeaders("ada@example.com", "pending");
    const status = (page: typeof first, headers = live) => page.request("/api/status", { headers });
    try {
      await vi.waitFor(async () => expect(await (await status(second)).json()).toMatchObject({ redisReady: true }));
      const closed = vi.fn();
      const connection = await second.link.hub.joinPage({ session: "ended", send: () => {}, close: closed }, null);
      expect((await first.request("/auth/logout", { headers: ended })).status).toBe(302);
      await vi.waitFor(() => expect(closed).toHaveBeenCalledWith(1008, "session ended"));
      await connection.closed();
      await redis.stop();
      expect((await status(second)).status).toBe(200);
      expect(await (await second.request("/api/config", { headers: live })).json()).toMatchObject({ user: "ada@example.com" });
      expect((await status(second, ended)).status).toBe(401);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const request = () => second.request("/api/link?role=page", {
          headers: { ...live, origin: "https://view.example.com" },
        });
        for (const response of await Promise.all([request(), request()])) expect(response.status).toBe(503);
        expect(warn).not.toHaveBeenCalled();
      } finally { warn.mockRestore(); }
      expect((await second.request("/api/projects/p1/commands", {
        method: "POST", headers: { ...live, origin: "https://view.example.com", "content-type": "application/json" },
        body: JSON.stringify({ name: "next" }),
      })).status).toBe(503);
      const logout = await second.request("/auth/logout", { headers: pending });
      expect(logout.status).toBe(302);
      expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
      expect((await status(second, pending)).status).toBe(401);
      await redis.start();
      await vi.waitFor(async () => expect((await status(first, pending)).status).toBe(401), { timeout: 4000 });
    } finally {
      first.link.stop(); second.link.stop(); await redis.close();
    }
  }, 20_000);

  it("queues a repeated browser request once using the ID of the action", async () => {
    const page = createApp(rules, { team: "WG", dist, watchMs: 0 });
    const fetch = vi.fn(async (path: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      expect(headers.get("Idempotency-Key")).toMatch(/^[a-f0-9]{32}$/);
      for (const [key, value] of Object.entries(write)) headers.set(key, value);
      const send = () => page.request(path, { ...init, headers });
      expect((await send()).status).toBe(200);
      return send();
    });
    vi.stubGlobal("fetch", fetch);
    try {
      await browserApi.command("p1", { name: "next" });
      expect(fetch).toHaveBeenCalledOnce();
      expect((await page.link.hub.state()).rooms[0].queue).toHaveLength(1);
    } finally { page.link.stop(); }
  });

  it("rejects a malformed Redis URL at startup without exposing it", () => {
    expect(() => createApp(rules, { team: "WG", dist, redisUrl: "https://private-value@example.com" }))
      .toThrow(/^invalid Redis link configuration$/);
  });

  it.skipIf(!localRedis)("closes the link and refuses writes across instances when Redis declines writes", async () => {
    const server = await startLocalRedis();
    const admin = connectRedis(server.url, undefined, undefined, true);
    const options = { team: "WG", dist, workspaces: [workWorkspace()], auth: rolesAuth, linkToken: rolesToken,
      redisUrl: server.url, watchMs: 0, readOnly: false };
    const first = createApp(hostedRoles, options), second = createApp(hostedRoles, options);
    const ended = await rolesHeaders("ada@example.com", "refused-logout");
    const active = await rolesHeaders("ada@example.com", "still-active");
    const status = (page: typeof first, headers = active) => page.request("/api/status", { headers });
    const write = (page: typeof first, headers = active) => page.request("/api/projects/p1/commands", {
      method: "POST", headers: { ...headers, origin: "https://view.example.com", "content-type": "application/json" },
      body: JSON.stringify({ name: "next" }),
    });
    const close = vi.fn();
    try {
      await vi.waitFor(async () => expect(await (await status(second)).json()).toMatchObject({ redisReady: true }));
      await first.link.hub.joinPage({ send: () => {}, close }, null);
      await admin.run((client) => client.config("SET", "maxmemory", "1"));
      expect((await first.request("/auth/logout", { headers: ended })).status).toBe(302);
      expect(close).toHaveBeenCalledWith(RESTART_CODE, "server restart");
      expect((await write(second, ended)).status).toBe(503);
      expect((await status(second)).status).toBe(200);
      await admin.run((client) => client.config("SET", "maxmemory", "0"));
      await first.link.hub.beat();
      await second.link.hub.beat();
      await vi.waitFor(async () => expect(await admin.run((client) => client.get("wg:link:ended:refused-logout"))).not.toBeNull());
      expect((await status(second, ended)).status).toBe(401);
      expect((await write(second)).status).toBe(200);
      await admin.run((client) => client.del("wg:link:ended:refused-logout"));
      expect((await status(second, ended)).status).toBe(401);
    } finally { first.link.stop(); second.link.stop(); admin.close(); await server.close(); }
  });

  it.skipIf(!localRedis)("allows reads and rejects writes when Redis refuses the session lookup", async () => {
    const server = await startLocalRedis();
    const admin = connectRedis(server.url, undefined, undefined, true);
    const page = createApp(hostedRoles, {
      team: "WG", dist, workspaces: [workWorkspace()], auth: rolesAuth, linkToken: rolesToken,
      redisUrl: server.url, watchMs: 0, readOnly: false,
    });
    const headers = await rolesHeaders("ada@example.com", "lookup");
    try {
      await vi.waitFor(async () => expect(await (await page.request("/api/status", { headers })).json()).toMatchObject({ redisReady: true }));
      await admin.run((client) => client.acl("SETUSER", "default", "-get"));
      expect(await (await page.request("/api/config", { headers })).json()).toMatchObject({ user: "ada@example.com" });
      expect((await page.request("/api/projects/p1/commands", {
        method: "POST", headers: { ...headers, origin: "https://view.example.com", "content-type": "application/json" },
        body: JSON.stringify({ name: "next" }),
      })).status).toBe(503);
    } finally { page.link.stop(); admin.close(); await server.close(); }
  });

  it.skipIf(!localRedis)("opens only one lazy Redis connection for a read-only viewer", async () => {
    const server = await startLocalRedis();
    const inspector = connectRedis(server.url, undefined, undefined, true);
    const count = async () => String(await inspector.run((client) => client.client("LIST"))).trim().split("\n").length;
    const before = await count();
    const page = createApp(hostedRoles, {
      team: "WG", dist, workspaces: [workWorkspace()], readOnly: true, auth: rolesAuth, redisUrl: server.url,
    });
    try {
      expect((await page.request("/api/status", { headers: rolesHost })).status).toBe(401);
      expect(await count()).toBe(before);
      const headers = await rolesHeaders("ada@example.com", "viewer");
      expect((await page.request("/api/status", { headers })).status).toBe(200);
      expect(await count()).toBe(before + 1);
      const info = await inspector.run((client) => client.info("commandstats"));
      expect(info).not.toMatch(/cmdstat_(scan|subscribe):/);
    } finally { page.link.stop(); inspector.close(); await server.close(); }
  });

  it("redirects and deletes the cookie when the logout event cannot publish", async () => {
    const headers = await rolesHeaders("ada@example.com", "logout");
    const bus = memoryLinkBus();
    const page = createApp(hostedRoles, {
      team: "WG", dist, workspaces: [workWorkspace()], readOnly: false, auth: rolesAuth, linkToken: rolesToken, watchMs: 0,
      linkBus: { ...bus, async publish() { throw new Error("event dropped"); } },
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await page.request("/auth/logout", { headers });
      expect(result.status).toBe(302);
      expect(result.headers.get("set-cookie")).toContain("Max-Age=0");
      expect((await page.request("/api/status", { headers })).status).toBe(401);
    } finally { page.link.stop(); log.mockRestore(); }
  });

  it.each(["missed logout", "failed admission"])("closes a page socket after %s", async (failure) => {
    const state = memoryLinkState();
    let checks = 0, ended = false;
    const page = createApp(hostedRoles, {
      team: "WG", dist, workspaces: [workWorkspace()], readOnly: false, auth: rolesAuth, linkToken: rolesToken, watchMs: 0,
      linkState: {
        ...state,
        async sessionEnded() {
          checks++;
          if (checks > 1 && failure === "failed admission") throw new Error("session state unavailable");
          return ended;
        },
      },
    });
    const http = serve({ fetch: page.fetch, port: 0, hostname: "127.0.0.1" });
    page.injectWebSocket(http as never);
    if (!http.listening) await new Promise<void>((resolve) => http.once("listening", resolve));
    const ws = new WebSocket(`ws://127.0.0.1:${(http.address() as AddressInfo).port}/api/link?role=page`, {
      headers: { ...await rolesHeaders("ada@example.com"), origin: "https://view.example.com" },
    });
    const failed = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const closed = new Promise<number>((resolve) => ws.once("close", resolve));
      await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
      await vi.waitFor(() => expect(checks).toBeGreaterThanOrEqual(2));
      if (failure === "missed logout") {
        ended = true;
        await page.link.hub.beat();
      }
      expect(await closed).toBe(failure === "missed logout" ? 1008 : 1011);
    } finally {
      ws.terminate();
      page.link.stop();
      http.close();
      failed.mockRestore();
    }
  });

  it.each(["expiry", "logout"])("filters real viewer sockets and closes owner sockets on %s", async (endSession) => {
    let shared = true;
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const list = vi.fn(async () => ({ ok: true, json: async () => ({ data: { teams: { nodes: [{ projects: {
      nodes: [{ id: "p1", name: "Shared", url: "u", status: null, labels: { nodes: shared ? [{ name: "shared", parent: null }] : [] } },
        { id: "p2", name: "Private", url: "u", status: null }],
      pageInfo: { hasNextPage: false, endCursor: null },
    } }] } } }) }));
    vi.stubEnv("LINEAR_API_KEY", "test-key");
    vi.stubGlobal("fetch", list);
    const page = rolesPage(() => now);
    const http = serve({ fetch: page.fetch, port: 0, hostname: "127.0.0.1" });
    page.injectWebSocket(http as never);
    const origin = "https://view.example.com";
    const owner = { ...await rolesHeaders("ada@example.com"), origin };
    const viewer = { ...await rolesHeaders("viewer@example.com"), origin };
    const sockets: WebSocket[] = [];
    const peer = { send: () => {}, close: () => {} };
    const ref = { workspace: "work", id: "p1" };
    const coordinator = await page.link.hub.joinCoordinator(peer, ref);
    const send = (type: string, payload: unknown) => coordinator.receive(JSON.stringify({ v: 1, type, payload }));
    await send("hello", { session: "private-session", host: "private-host", plan: "private-path" });
    await (await page.link.hub.joinCoordinator({ ...peer }, ref)).receive(JSON.stringify({ v: 1, type: "hello", payload: { session: "other-session" } }));
    await send("asks", { asks: [{ id: "q", body: "private question" }] });
    await send("agents", { agents: [{ id: "a", said: "private reply" }] });
    await send("progress", { nodes: [{ key: "a", evidence: "private evidence" }] });
    try {
      if (!http.listening) await new Promise<void>((resolve) => http.once("listening", resolve));
      const connect = async (headers: typeof owner, project = "") => {
        const url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}/api/link?role=page&workspace=work${project}`;
        const ws = new WebSocket(url, { headers });
        sockets.push(ws);
        const messages: { type: string; project: { id: string }; payload: unknown }[] = [];
        ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
        const closed = new Promise<number>((resolve) => ws.once("close", resolve));
        await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
        return { messages, closed };
      };
      const own = await connect(owner, "&project=p1");
      const view = await connect(viewer, "&project=p1");
      const overview = await connect(viewer);
      await vi.waitFor(() => expect(own.messages.map((m) => m.type)).toEqual(["presence", "asks", "progress", "agents"]));
      expect((await page.request("/api/status", { headers: viewer })).status).toBe(200);
      expect(await (await page.request("/api/status", { headers: viewer })).json()).toMatchObject({ rooms: [], cache: 0 });
      expect(await (await page.request("/api/status", { headers: owner })).json()).toMatchObject({ rooms: [{ project: "p1", pages: 2 }] });
      expect((await page.request("/api/projects/p2/presence", { headers: viewer })).status).toBe(404);
      const presence = await (await page.request("/api/projects/p1/presence", { headers: viewer })).json();
      expect(presence).toMatchObject({ queued: 0, waiting: 0, coordinators: [{ host: "", plan: "" }, { host: "", plan: "" }] });
      expect(new Set(presence.coordinators.map((row: { session: string }) => row.session)).size).toBe(2);

      const calls = list.mock.calls.length;
      now += 6_000;
      await page.link.hub.publish({ ...ref, id: "p2" }, "changed", { by: "page", what: "issue", issues: ["WG-2"] });
      await send("wrote", { issues: ["WG-1"] });
      await vi.waitFor(() => expect(overview.messages.map((m) => m.type)).toEqual(["presence", "changed"]));
      expect(view.messages.map((m) => m.type)).toEqual(["presence", "changed"]);
      expect(view.messages[1]).toMatchObject({ project: { id: "p1" }, payload: { issues: [] } });
      expect(JSON.stringify(view.messages)).not.toContain("private-");
      expect(list).toHaveBeenCalledTimes(calls);

      now += 60_000;
      await send("wrote", { issues: ["WG-1"] });
      await vi.waitFor(() => expect(own.messages.filter((m) => m.type === "changed")).toHaveLength(2));
      expect(view.messages).toHaveLength(2);
      expect(overview.messages).toHaveLength(2);
      expect(list).toHaveBeenCalledTimes(calls);

      await page.request("/api/projects", { headers: viewer });
      shared = false;
      await page.request("/api/projects", { headers: viewer });
      await send("wrote", { issues: ["WG-1"] });
      await vi.waitFor(() => expect(own.messages.filter((m) => m.type === "changed")).toHaveLength(3));
      expect(view.messages).toHaveLength(2);
      expect(overview.messages).toHaveLength(2);

      if (endSession === "logout") await page.request("/auth/logout", { headers: owner });
      else now += 600_000;
      await send("wrote", { issues: ["WG-1"] });
      await expect(own.closed).resolves.toBe(1008);
      expect(own.messages.filter((m) => m.type === "changed")).toHaveLength(3);
    } finally {
      for (const ws of sockets) ws.terminate();
      page.link.stop();
      http.close();
      clock.mockRestore();
    }
  });

  it("allows only the coordinator reads with a token and no session", async () => {
    const page = rolesPage();
    const headers = { ...host, authorization: `Bearer ${rolesToken}` };
    expect(await (await page.request("/api/config", { headers })).json()).toMatchObject({ role: null, link: null });
    expect(await (await app().request("/api/config", { headers: local })).json()).toMatchObject({ role: "owner", link: "/api/link" });
    for (const path of ["/api/status", "/api/projects/p1/presence", "/healthz"]) {
      expect((await page.request(path, { headers })).status).toBe(200);
    }
    for (const path of ["/api/projects", "/api/overview", "/api/projects/p1/graph", "/api/issues/i1/comments"]) {
      expect((await page.request(path, { headers })).status).toBe(401);
    }
    expect((await page.request("/api/projects/p1/commands", {
      method: "POST", headers: { ...headers, origin: "https://view.example.com", "content-type": "application/json" },
      body: JSON.stringify({ name: "next" }),
    })).status).toBe(401);
  });

  it("gives owners and viewers different access on the same page", async () => {
    const page = createApp(hosted, { linkToken: "a-test-token-with-32-characters-or-more", team: "CD", dist, workspaces: [workWorkspace()], auth: { ...auth, owners: ["ada@example.com"] } });
    const session = async (email: string) => {
      google({ id_token: idToken({ email, hd: "example.com" }) });
      const { callback } = await signIn(page);
      return { ...host, cookie: `__Host-wg_session=${cookies(callback)["__Host-wg_session"]}` };
    };
    const owner = await session("Ada@Example.com");
    const viewer = await session("viewer@example.com");
    linear({ teams: { nodes: [{ projects: { nodes: [
      { id: "p1", name: "Shared", url: "u", status: null, labels: { nodes: [{ name: "shared", parent: null }] } },
      { id: "p2", name: "Private", url: "u", status: null },
    ], pageInfo: { hasNextPage: false, endCursor: null } } }] } });
    for (const [headers, role, ids] of [[owner, "owner", ["p1", "p2"]], [viewer, "viewer", ["p1"]]] as const) {
      expect(await (await page.request("/api/config", { headers })).json()).toMatchObject({ role, link: "/api/link", readOnly: role === "viewer" });
      const list = await (await page.request("/api/projects", { headers })).json();
      expect(list.projects.map((project: { id: string }) => project.id).sort()).toEqual(ids);
    }
    const headers = { ...viewer, origin: "https://view.example.com" };
    expect((await page.request("/api/projects/p2/graph", { headers })).status).toBe(404);
    expect((await page.request("/api/link?role=page&workspace=work&project=p2", { headers })).status).toBe(404);
    expect((await page.request("/api/link?role=page", { headers: { ...host, origin: headers.origin } })).status).toBe(401);
    expect((await page.request("/api/projects/p1/commands", { method: "POST", headers })).status).toBe(405);
    const command = await page.request("/api/projects/p1/commands", { method: "POST", headers: { ...owner, origin: headers.origin, "content-type": "application/json" }, body: JSON.stringify({ name: "next" }) });
    expect(command.status).toBe(200);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ errors: [{ message: "unavailable" }] }) })));
    await page.request("/api/projects", { headers });
    expect((await page.request("/api/projects/p1/graph", { headers })).status).toBe(503);
    expect((await page.request("/api/issues/i1/comments", { headers: { ...headers, "x-project": "p1" } })).status).toBe(503);
    expect((await page.request("/api/link?role=page&workspace=work&project=p1", { headers })).status).toBe(503);
  });
});

describe("share a project with the viewer", () => {
  it("sets and removes the project label shared, and gives the viewer address of the workspace", async () => {
    const marks = { shared: false, created: [] as unknown[] };
    let refuse = false;
    vi.stubEnv("LINEAR_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const { query, variables } = JSON.parse(init.body as string);
      const labels = { nodes: marks.shared ? [{ id: "shared-id", name: "shared", parent: null }] : [] };
      let data;
      if (query.includes("projectLabelCreate")) { marks.created.push(variables.i); data = { projectLabelCreate: { projectLabel: { id: "shared-id" } } }; }
      else if (query.includes("projectAddLabel")) { marks.shared = !refuse; data = { projectAddLabel: { success: !refuse } }; }
      else if (query.includes("projectRemoveLabel")) { marks.shared = false; data = { projectRemoveLabel: { success: true } }; }
      else if (query.includes("projectLabels(first:250")) data = { projectLabels: { nodes: [] } };
      else if (query.includes("projects(first:50")) data = { teams: { nodes: [{ projects: { nodes: [{ id: "p1", name: "A", url: "u", status: null, labels }], pageInfo: { hasNextPage: false, endCursor: null } } }] } };
      else data = { project: { id: "p1", teams: { nodes: [{ key: variables.id === "foreign" ? "ENG" : "CD" }] }, labels }, teams: { nodes: [{ id: "team" }] } };
      return { ok: true, json: async () => ({ data }) };
    }));
    const page = createApp(rules, { team: "CD", dist, workspaces: [{ ...workWorkspace(), shareUrl: "https://view.example.com" }] });
    const share = (body: unknown, id = "p1") => page.request(`/api/projects/${id}/share`, { method: "POST", headers: write, body: JSON.stringify(body) });
    const list = async () => (await page.request("/api/projects", { headers: local })).json();

    const on = await share({ shared: true });
    expect([on.status, await on.json()]).toEqual([200, { ok: true, shared: true }]);
    expect(marks.created).toEqual([{ name: "shared", teamId: "team", description: "work-graph: the read-only viewer shows this project." }]);
    expect(await list()).toMatchObject({ workspaces: [{ id: "work", name: "Work", shareUrl: "https://view.example.com" }], projects: [{ id: "p1", shared: true }] });
    for (const [method, path] of [
      ["GET", "/api/projects/p1/share"], ["POST", "/api/projects/p1/share/view/rotate"],
      ["DELETE", "/api/projects/p1/share/view"], ["PATCH", "/api/projects/p1/members/member"],
      ["DELETE", "/api/projects/p1/members/member"], ["POST", "/api/join"],
    ]) {
      const response = await page.request(path, { method, headers: write });
      expect([response.status, await response.json()]).toEqual([404, { error: "Share route not found" }]);
    }
    expect((await share({ shared: false })).status).toBe(200);
    expect(marks.shared).toBe(false);
    expect((await list()).projects[0].shared).toBe(false);

    const bad = await share({ shared: "yes" });
    expect([bad.status, await bad.json()]).toEqual([400, { error: "shared must be true or false" }]);
    expect((await share({ shared: true }, "foreign")).status).toBe(403);
    expect(marks.shared).toBe(false);
    // Linear answers, but does not add the label: the page must not show the project as shared.
    refuse = true;
    const failed = await share({ shared: true });
    expect([failed.status, await failed.json()]).toEqual([502, { error: "Linear did not add the project label shared" }]);
  });
});

describe("usage events", () => {
  const environment = {
    DD_API_KEY: "test-intake-key", WG_TELEMETRY_WORKSPACES: "work",
    WG_SESSION_SECRET: rolesAuth.secret,
  };
  const make = (telemetryEnv: NodeJS.ProcessEnv, workspaces = [workWorkspace()]) => createApp(hostedRoles, {
    team: "WG", dist, workspaces, auth: rolesAuth, linkToken: rolesToken, watchMs: 0, telemetryEnv,
  });

  it.each([{}, { ...environment, WG_TELEMETRY_WORKSPACES: "" }])("disables telemetry without a key and a workspace list", async (env) => {
    const response = await make(env).request("/api/config", { headers: rolesHost });
    expect(await response.json()).toMatchObject({ telemetry: false });
  });

  it("sends only the selected config workspace and returns while the intake is still pending", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const events: unknown[][] = [];
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const intakeStarted: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/graphql")) {
        const work = new Headers(init.headers).get("authorization") === "work-key";
        return Response.json({ data: {
          viewer: { name: "Ada" }, organization: { id: work ? "org-id" : "other-id", name: "Workspace", urlKey: work ? "org" : "other" },
          teams: { nodes: [{ key: "WG", name: "WG" }], pageInfo: { hasNextPage: false } },
        } });
      }
      intakeStarted.push(url);
      if (url.endsWith("/logs")) events.push(JSON.parse(String(init.body)));
      await pending;
      return new Response(environment.DD_API_KEY, { status: 403 });
    }));
    const tasks: Promise<void>[] = [];
    const page = createApp(hostedRoles, {
      team: "WG", dist, auth: rolesAuth, linkToken: rolesToken, watchMs: 0, telemetryEnv: environment,
      waitUntil: (task) => tasks.push(task),
      workspaces: [
        { ...workWorkspace(), key: "work-key" },
        { ...workWorkspace(), id: "other", key: "other-key" },
      ],
    });
    try {
      const headers = { ...(await rolesHeaders("ada@example.com", "usage-session")), origin: "https://view.example.com",
        "content-type": "application/json" };
      const post = (workspace: string) => page.request("/api/events", {
        method: "POST", headers, body: JSON.stringify({ event: "node_opened", workspace }),
      });
      expect(await (await page.request("/api/config", { headers })).json()).toMatchObject({ telemetry: true });
      expect((await post("work")).status).toBe(204);
      expect((await post("other")).status).toBe(204);
      await vi.waitFor(() => expect(intakeStarted).toHaveLength(2));
      expect(events.flat()).toHaveLength(1);
      // The refusal echoes the key in its body. Only a fixed warning reaches the server log.
      release();
      await Promise.all(tasks);
      expect(warnings.mock.calls).toEqual([["Usage data could not be sent"]]);
    } finally {
      release();
      await Promise.all(tasks);
      page.link.stop();
      warnings.mockRestore();
    }
  });

  it("requires the page origin and a session, checks event names and limits a session to 60 events", async () => {
    const page = make(environment);
    const signed = await rolesHeaders("ada@example.com", "usage-session");
    const post = (event: string, headers: Record<string, string>) => page.request("/api/events", {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ event, workspace: "other" }),
    });
    const origin = "https://view.example.com";
    expect((await post("node_opened", signed)).status).toBe(403);
    expect((await post("node_opened", { ...rolesHost, origin })).status).toBe(401);
    expect((await post("unknown", { ...signed, origin })).status).toBe(400);
    for (let i = 0; i < 60; i++) expect((await post("node_opened", { ...signed, origin })).status).toBe(204);
    expect((await post("node_opened", { ...signed, origin })).status).toBe(429);
  });
});
