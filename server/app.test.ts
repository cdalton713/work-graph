import { createHash } from "node:crypto";
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
import type { Rules } from "./access.ts";
import { SLOW_MS, contractHash, createApp } from "./app.ts";
import { setTransport } from "./linear.ts";
import { DEAD_MS, PING_MS, RESTART_CODE, stopOnSignals, type Timers } from "./link.ts";

const rules: Rules = { port: 4747, tailnet: null };
const local = { host: "127.0.0.1:4747" };
const write = { ...local, origin: "http://127.0.0.1:4747", "content-type": "application/json" };
let dist: string;

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
const app = () => createApp(rules, { team: "CD", dist, workspaces: [workWorkspace()] });
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
    expect(projectFromQuery(directory, new URLSearchParams("project=p1")).project).toEqual(project);
    expect(projectFromQuery(directory, new URLSearchParams("project=A+PROJECT")).project).toEqual(project);
    expect(projectFromQuery(directory, new URLSearchParams("workspace=home&project=A+project"))).toEqual({
      project: null, missing: 'No project "A project" in Home',
    });
    expect(projectFromQuery(directory, new URLSearchParams()).missing).toBeNull();
    expect(projectFromQuery(directory, new URLSearchParams("project="))).toEqual({ project: null, missing: null });
    const unavailable = { ...directory, workspaces: [{ id: "home", name: "Home", error: "Unavailable" }] };
    expect(projectFromQuery(unavailable, new URLSearchParams("workspace=home&project=Unknown"))).toEqual({ project: null, missing: null });
  });
});

describe("api", () => {
  it("refuses a caller that is not this page", async () => {
    const response = await app().request("/api/projects", { headers: { host: "evil.example" } });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "bad host" });
  });
  it("lists the projects of the team", async () => {
    const labels = { nodes: [{ name: "AI", parent: null }, { name: "Tooling", parent: { name: "Initiative" } }, { name: "full", parent: { name: "Autonomy" } }, { name: "paused", parent: null }] };
    linear({ teams: { nodes: [{ projects: { nodes: [{ id: "p2", name: "B", url: "u", status: null }, { id: "p1", name: "A", url: "u", status: { name: "Started", type: "started" }, labels }], pageInfo: { hasNextPage: false, endCursor: null } } }] } });
    const response = await app().request("/api/projects", { headers: local });
    expect(await response.json()).toEqual({
      workspaces: [{ id: "work", name: "Work" }],
      projects: [
        { id: "p1", name: "A", url: "u", status: "Started", statusType: "started", initiative: "Tooling", autonomy: "full", paused: true, workspace: "work", workspaceName: "Work" },
        { id: "p2", name: "B", url: "u", status: "", statusType: "", initiative: null, autonomy: null, paused: false, workspace: "work", workspaceName: "Work" },
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
      projects: [{ id: "work-project", name: "Work", url: "u", status: "", statusType: "", initiative: null, autonomy: null, paused: false, workspace: "work", workspaceName: "Work" }],
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
    const connection = a.link.hub.joinCoordinator({ send: (t) => sent.push(t), close: () => {} }, { workspace: "work", id: "p1" });
    connection.receive(JSON.stringify({ v: 1, type: "hello", payload: { session: "s" } }));
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
    const connection = a.link.hub.joinCoordinator({ send: (t) => sent.push(t), close: () => {} }, { workspace: "work", id: "p1" });
    connection.receive(JSON.stringify({ v: 1, type: "hello", payload: { session: "s" } }));
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
    const wg = server.link.hub.joinCoordinator({ send: (text) => sent.push(text), close: () => {} }, { workspace: "work", id: "p2" });
    wg.receive(JSON.stringify({ v: 1, type: "wrote", id: "w", project: { workspace: "work", id: "p2" }, at: "", payload: { issues: [`${TEAM}-1`] } }));
    await graph(server, "p1");
    await graph(server, "p2");
    expect(asked.loads).toEqual(["p1", "p2", "p2"]);
  });
  it("does not use a stale graph for a write that depends on the issues of the project", async () => {
    const { asked, state } = graphLinear();
    const server = cached();
    await graph(server, "p1"); // this graph has no issues yet
    state.issues.p1 = [rawIssue("i2", `${TEAM}-2`, "p1")];
    const coordinator = server.link.hub.joinCoordinator({ send: () => {}, close: () => {} }, { workspace: "work", id: "p1" });
    coordinator.receive(JSON.stringify({ v: 1, type: "hello", id: "h", project: { workspace: "work", id: "p1" }, at: "", payload: { plan: "p1", session: "p1", host: "test", wg: "1" } }));
    coordinator.receive(JSON.stringify({ v: 1, type: "asks", id: "x", project: {}, at: "", payload: { asks: [{ id: "msg_q", key: "a", issue: `${TEAM}-2`, from: "w", body: "Which API?", at: "t" }] } }));
    expect(server.link.hub.ask({ workspace: "work", id: "p1" }, "msg_q")).not.toBeNull();
    state.down = true;
    clock.at += 60_000;
    expect((await graph(server, "p1")).status).toBe(200); // the page still gets the stale graph
    const reply = await server.request("/api/projects/p1/asks/msg_q/reply", { method: "POST", headers: write, body: JSON.stringify({ body: "Use v2." }) });
    expect(reply.status).toBe(502);
    expect(server.link.hub.ask({ workspace: "work", id: "p1" }, "msg_q")).not.toBeNull(); // the question stays open
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
  it("sends the last graph with stale and the error when Linear fails, and 204 for the version the page has", async () => {
    const { state } = graphLinear();
    const server = cached();
    const first = await (await graph(server, "p1")).json();
    expect(first.stale).toBeUndefined();
    state.down = true;
    clock.at += 60_000;
    const response = await graph(server, "p1");
    expect(response.status).toBe(200);
    const stale = await response.json();
    expect(stale).toMatchObject({ project: first.project, version: first.version, stale: true, error: expect.stringContaining("HTTP 500") });
    expect((await graph(server, "p1", first.version)).status).toBe(204);
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
      server.link.hub.joinCoordinator({ send: () => {}, close: () => {} }, { workspace: "work", id })
        .receive(JSON.stringify({ v: 1, type: "hello", id: "h", project: { workspace: "work", id }, at: "", payload: { plan: id, session: id, host: "test", wg: "1" } }));
    }
    expect(server.link.hub.active()).toHaveLength(2);
    clock.at += 60_000;
    state.changed = [];
    await server.link.check();
    expect(asked.many).toEqual([["p1", "p2"], ["p1", "p2"]]);
    expect(asked.one).toBe(0);
    expect(asked.loads).toHaveLength(3);
  });
});


describe("link sockets of the server", () => {
  const closers: (() => void)[] = [];
  afterEach(() => { closers.splice(0).forEach((close) => close()); });
  const settle = () => new Promise((ok) => setTimeout(ok, 30));

  /** A server with a clock and link timers that move only when the test says so. */
  async function start() {
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
    const server = createApp(portRules, { team: "CD", dist, workspaces: [workWorkspace()], watchMs: 0, now: () => clock.at, linkTimers: timers });
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
    const coordinator = server.link.hub.joinCoordinator(sink(), { workspace: "work", id: "p1" });
    coordinator.receive(msg("hello", { plan: "/plans/a", session: "s1", host: "mac", wg: "1" }));
    coordinator.receive(msg("asks", { asks: [{ id: "q1", issue: "CD-1", from: "w", body: "Secret question body", at: "" }] }));
    server.link.hub.joinPage(sink(), { workspace: "work", id: "p1" });
    server.link.hub.publish({ workspace: "work", id: "p1" }, "reply", { ask: "q1", issue: "CD-1", key: "a", body: "Secret reply body" });
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
    vi.spyOn(console, "error").mockImplementation(() => {});
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
    expect((await app().request("/api/config", { headers: local })).status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("compresses the page and JSON for a client that accepts it, and gives index.html an ETag", async () => {
    const big = join(dist, "assets", "big.js");
    await writeFile(big, "console.log('work graph');\n".repeat(200));
    const js = await app().request("/assets/big.js", { headers: { ...local, "accept-encoding": "gzip, br" } });
    expect(js.headers.get("content-encoding")).toBe("gzip");
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(gunzipSync(Buffer.from(await js.arrayBuffer())).toString()).toBe("console.log('work graph');\n".repeat(200));
    const plain = await app().request("/assets/big.js", { headers: local });
    expect(plain.headers.get("content-encoding")).toBeNull();

    linear({ teams: { nodes: [{ projects: { nodes: Array.from({ length: 30 }, (_, at) => ({ id: `p${at}`, name: `Project ${at}`, url: "u", status: { name: "Started", type: "started" } })),
      pageInfo: { hasNextPage: false, endCursor: null } } }] } });
    const list = await app().request("/api/projects", { headers: { ...local, "accept-encoding": "gzip" } });
    expect(list.headers.get("content-encoding")).toBe("gzip");
    expect(JSON.parse(gunzipSync(Buffer.from(await list.arrayBuffer())).toString()).projects).toHaveLength(30);

    const page = await app().request("/", { headers: local });
    const tag = page.headers.get("etag");
    expect(tag).toMatch(/^"[0-9a-f]{40}"$/);
    expect(page.headers.get("cache-control")).toBe("no-store");
    const again = await app().request("/", { headers: { ...local, "if-none-match": tag! } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    expect((await app().request("/", { headers: { ...local, "if-none-match": `W/${tag}` } })).status).toBe(304);
    expect((await app().request("/", { headers: { ...local, "if-none-match": '"other"' } })).status).toBe(200);
  });
});
