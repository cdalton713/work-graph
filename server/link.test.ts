import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { Envelope } from "../src/lib/link.ts";
import { linkRefusal, type Rules } from "./access.ts";
import { createApp } from "./app.ts";
import { LinkHub, QUEUE_MAX, type Peer } from "./link.ts";

const A = { workspace: "work", id: "p1" }, B = { workspace: "work", id: "p2" };

/** A peer that records what the hub sends. */
function peer() {
  const sent: Envelope[] = [];
  const closed: { code?: number; reason?: string }[] = [];
  const p: Peer & { sent: Envelope[]; closed: typeof closed; of: (type: string) => Envelope[] } = {
    send: (text) => sent.push(JSON.parse(text)), close: (code, reason) => closed.push({ code, reason }),
    sent, closed, of: (type) => sent.filter((m) => m.type === type),
  };
  return p;
}
const msg = (type: string, payload: unknown = {}) => JSON.stringify({ v: 1, type, id: "x", project: A, at: "", payload });
const hello = (session: string) => msg("hello", { plan: "/plans/a", session, host: "mac", wg: "1" });

describe("LinkHub", () => {
  it("keeps a message for a coordinator until one acknowledges it, and sends the queue on hello", () => {
    const hub = new LinkHub();
    const sent = hub.publish(A, "answer", { issue: "CD-1", key: "a", body: "yes" });
    const first = peer(), c1 = hub.joinCoordinator(first, A);
    expect(first.sent).toEqual([]); // nothing before hello
    c1.receive(hello("s1"));
    expect(first.of("answer").map((m) => m.id)).toEqual([sent.id]);
    c1.closed();
    const second = peer(), c2 = hub.joinCoordinator(second, A);
    c2.receive(hello("s2"));
    expect(second.of("answer").map((m) => m.id)).toEqual([sent.id]); // not acknowledged yet
    c2.receive(msg("ack", { ids: [sent.id] }));
    expect(hub.presence(A).queued).toBe(0);
  });

  it("takes wrote before hello: it clears the cache and tells only the pages of the project", () => {
    const cleared: string[] = [];
    const hub = new LinkHub(undefined, (ref) => cleared.push(ref.id));
    const waiting = peer(), pageA = peer(), pageB = peer(), short = peer();
    hub.joinCoordinator(waiting, A).receive(hello("next"));
    hub.joinPage(pageA, A);
    hub.joinPage(pageB, B);
    hub.joinCoordinator(short, A).receive(msg("wrote", { issues: ["CD-1", 7] }));
    expect(short.closed).toEqual([]);
    expect(cleared).toEqual(["p1"]);
    expect(pageA.of("changed").map((m) => m.payload)).toEqual([{ by: "coordinator", what: "issue", issues: ["CD-1"] }]);
    expect(pageB.of("changed")).toEqual([]);
    expect(waiting.of("changed")).toEqual([]); // wg made the change itself
    expect(hub.presence(A)).toMatchObject({ queued: 0 });
    expect(hub.presence(A).coordinators.map((c) => c.session)).toEqual(["next"]); // the short connection is no coordinator
  });

  it("sends each message only to the coordinators and pages of its own project", () => {
    const hub = new LinkHub();
    const a = peer(), b = peer(), pageA = peer(), overview = peer();
    hub.joinCoordinator(a, A).receive(hello("a"));
    hub.joinCoordinator(b, B).receive(hello("b"));
    hub.joinPage(pageA, A);
    hub.joinPage(overview, null);
    hub.publish(B, "changed", { by: "page", what: "status", issues: ["CD-9"] });
    expect(a.of("changed")).toEqual([]);
    expect(b.of("changed")).toHaveLength(1);
    expect(pageA.of("changed")).toEqual([]);
    // The overview gets the presence of every project, and no changes.
    expect(overview.of("presence").some((m) => m.project.id === "p2")).toBe(true);
    expect(overview.of("changed")).toEqual([]);
    expect(hub.active().map((r) => r.id).sort()).toEqual(["p1", "p2"]);
  });

  it("sends the asks of every project to the overview, at once and when they change", () => {
    const hub = new LinkHub();
    const c = hub.joinCoordinator(peer(), A);
    c.receive(hello("a"));
    c.receive(msg("asks", { asks: [{ id: "q1", issue: "CD-1", from: "w", body: "Which table?", at: "" }] }));
    const overview = peer();
    hub.joinPage(overview, null);
    expect(overview.of("asks").at(-1)).toMatchObject({ project: A, payload: { asks: [{ id: "q1", issue: "CD-1" }] } });
    hub.answered(A, "q1");
    expect(overview.of("asks").at(-1)).toMatchObject({ project: A, payload: { asks: [] } });
  });

  it("refuses a message before hello, and anything that is not wg-link/1", () => {
    const hub = new LinkHub();
    const p = peer(), c = hub.joinCoordinator(p, A);
    c.receive(msg("state", { mode: "waiting" }));
    c.receive("{");
    c.receive(JSON.stringify({ v: 2, type: "hello" }));
    expect(p.closed.map((x) => x.reason)).toEqual(["send hello first", "message is not JSON", "not a wg-link/1 message"]);
  });

  it("shows presence: mode, head, and a coordinator that went away", () => {
    let now = new Date("2026-11-20T10:00:00Z");
    const hub = new LinkHub(() => now);
    const page = peer();
    hub.joinPage(page, A);
    const p = peer(), c = hub.joinCoordinator(p, A);
    c.receive(hello("s1"));
    c.receive(msg("state", { mode: "waiting", head: "phase 1: 2 tasks", lines: [{ level: "wait", text: "human a" }] }));
    expect(page.of("presence").at(-1)!.payload).toMatchObject({ coordinators: [{ session: "s1", connected: true, mode: "waiting", head: "phase 1: 2 tasks" }] });
    now = new Date("2026-11-20T10:05:00Z");
    c.closed();
    expect(hub.presence(A).coordinators).toEqual([expect.objectContaining({ connected: false, lastSeen: "2026-11-20T10:05:00.000Z" })]);
    now = new Date("2026-11-22T10:05:00Z");
    expect(hub.presence(A).coordinators).toEqual([]);
  });

  it("gives a reconnect of the same session the place of its old connection", () => {
    const hub = new LinkHub();
    const old = peer(), fresh = peer();
    hub.joinCoordinator(old, A).receive(hello("s1"));
    hub.joinCoordinator(fresh, A).receive(hello("s1"));
    expect(old.closed).toHaveLength(1);
    expect(hub.presence(A).coordinators).toHaveLength(1);
  });

  it("passes asks and progress to the pages, and a new page gets them at once", () => {
    const hub = new LinkHub();
    const c = hub.joinCoordinator(peer(), A);
    c.receive(hello("s1"));
    c.receive(msg("asks", { asks: [{ id: "m1", key: "a", issue: "CD-1", from: "worker", body: "Which API?", at: "t" }] }));
    c.receive(msg("progress", { nodes: [{ key: "a", issue: "CD-1", job: "dispatch", state: "running" }] }));
    const page = peer();
    hub.joinPage(page, A);
    expect(page.of("asks")[0].payload).toEqual({ asks: [{ id: "m1", key: "a", issue: "CD-1", from: "worker", body: "Which API?", at: "t" }] });
    expect(page.of("progress")[0].payload).toEqual({ nodes: [{ key: "a", issue: "CD-1", job: "dispatch", state: "running", ci: null, evidence: null, at: null }] });
  });

  it("drops the oldest changed message first when the queue is full", () => {
    const hub = new LinkHub();
    const answer = hub.publish(A, "answer", { issue: "CD-1", key: null, body: "keep me" });
    for (let i = 0; i < QUEUE_MAX + 5; i++) hub.publish(A, "changed", { by: "linear", what: "issue", issues: [`CD-${i}`] });
    const p = peer();
    hub.joinCoordinator(p, A).receive(hello("s"));
    expect(p.sent.filter((m) => m.type !== "presence")).toHaveLength(QUEUE_MAX);
    expect(p.of("answer").map((m) => m.id)).toEqual([answer.id]);
  });
});

describe("linkRefusal", () => {
  const rules: Rules = { port: 4747, tailnet: null, hosted: { host: "wg.example.com" } };
  const headers = (h: Record<string, string>) => (name: string) => h[name];
  it("takes a page only from its own origin, and a coordinator only with no origin", () => {
    expect(linkRefusal("page", headers({ host: "wg.example.com", origin: "https://wg.example.com" }), rules)).toBeNull();
    expect(linkRefusal("page", headers({ host: "wg.example.com", origin: "https://evil.example" }), rules)).toBe("bad origin");
    expect(linkRefusal("page", headers({ host: "wg.example.com" }), rules)).toBe("bad origin");
    expect(linkRefusal("coordinator", headers({ host: "wg.example.com" }), rules)).toBeNull();
    expect(linkRefusal("coordinator", headers({ host: "wg.example.com", origin: "https://wg.example.com" }), rules)).toBe("a coordinator sends no Origin");
    expect(linkRefusal("coordinator", headers({ host: "evil.example" }), rules)).toBe("bad host");
    expect(linkRefusal("admin", headers({ host: "wg.example.com" }), rules)).toBe("role must be page or coordinator");
  });
});

describe("/api/link over a real socket", () => {
  const closers: (() => void)[] = [];
  afterEach(() => { closers.splice(0).forEach((close) => close()); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  /** Linear with two projects; issue i1 (CD-1) is in p1. Each comment create is recorded. */
  /** `team`: the team key of the issue of p1 in its graph. */
  function fakeLinear(team = "CD") {
    const comments: string[] = [];
    const marks = { answered: [] as string[], paused: false };
    let updatedAt = "2026-11-20T00:00:00Z", card = "";
    const none = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
    vi.stubEnv("LINEAR_API_KEY", "k");
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const { query, variables } = JSON.parse(init.body as string);
      let data: unknown;
      if (query.includes("projects(first:50")) data = { teams: { nodes: [{ projects: { nodes: [
        { id: "p1", name: "Effort A", url: "u", status: { name: "Started", type: "started" } },
        { id: "p2", name: "Effort B", url: "u", status: { name: "Started", type: "started" } },
      ], pageInfo: { hasNextPage: false, endCursor: null } } }] } };
      else if (query.includes("issueLabelCreate")) data = { issueLabelCreate: { issueLabel: { id: "answered-id" } } };
      else if (query.includes("issueLabels(first:10")) data = { issueLabels: { nodes: [] } };
      else if (query.includes("addedLabelIds")) { marks.answered.push(variables.id); data = { issueUpdate: { success: true } }; }
      else if (query.includes("teams(first:10)")) data = { project: { id: variables.id, teams: { nodes: [{ key: "CD" }] },
        labels: { nodes: marks.paused ? [{ id: "paused-id", name: "paused", parent: null }] : [] } }, teams: { nodes: [{ id: "team" }] } };
      else if (query.includes("projectLabels(first:250")) data = { projectLabels: { nodes: [] } };
      else if (query.includes("projectLabelCreate")) data = { projectLabelCreate: { projectLabel: { id: "paused-id" } } };
      else if (query.includes("projectAddLabel")) { marks.paused = true; data = { projectAddLabel: { success: true } }; }
      else if (query.includes("projectRemoveLabel")) { marks.paused = false; data = { projectRemoveLabel: { success: true } }; }
      else if (query.includes("commentCreate")) {
        comments.push(variables.i.body);
        data = { commentCreate: { success: true, comment: { id: "c1", body: variables.i.body, createdAt: "t", user: { name: "C", displayName: "C" }, botActor: null, parent: null } } };
      } else if (query.includes("issue(id:$id){ team{key}")) data = { issue: { team: { key: "CD" }, project: { id: "p1" }, description: "", labels: { nodes: [] }, comments: { nodes: [] } } };
      // The check of all projects at once: each project always changed, so each check loads the graph again.
      else if (query.includes("project:{id:{in:$ids}}")) data = { issues: { ...none, nodes: (variables.ids as string[]).map((id) => ({ updatedAt: "2999-01-01T00:00:00Z", project: { id } })) },
        comments: none, ...Object.fromEntries((variables.ids as string[]).map((_, at) => [`d${at}`, { documents: { nodes: [] } }])) };
      else if (query.includes("updatedAt:{gt:$t}")) data = { issues: { nodes: [{ id: "i1" }] }, comments: { nodes: [] }, project: { documents: { nodes: [] } } };
      else if (query.includes("viewer{")) data = { viewer: { id: "me" }, project: { id: variables.id, name: "Effort A", url: "u", projectMilestones: { nodes: [] } } };
      else if (query.includes("issues(first:25")) data = { project: { issues: { nodes: variables.id === "p1" ? [{
        id: "i1", identifier: `${team}-1`, title: "t", description: null, priority: 0, url: "u", sortOrder: 0, updatedAt,
        team: { id: "team", key: team }, state: { id: "s", name: "Needs Human", type: "started", color: "" }, assignee: null,
        labels: { nodes: [] }, projectMilestone: null,
        relations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        inverseRelations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        comments: { nodes: card ? [{ id: "card", body: card }] : [] }, attachments: { nodes: [] }, project: { id: "p1" },
      }] : [], pageInfo: { hasNextPage: false, endCursor: null } } } };
      else if (query.includes("members(first")) data = { teams: { nodes: [] } };
      else data = { issueLabels: { nodes: [], pageInfo: { hasNextPage: false } } };
      return { ok: true, json: async () => ({ data }) };
    }));
    return { comments, marks, touch: (at: string) => { updatedAt = at; }, writeCard: (body: string) => { card = body; } };
  }

  async function start(clock = { at: Date.now() }) {
    const rules: Rules = { port: 0, tailnet: null };
    const app = createApp(rules, { team: "CD", dist: "/nonexistent/", workspaces: [{ id: "work", name: "Work", team: "CD", key: process.env.LINEAR_API_KEY ?? "", teamLabels: true }], watchMs: 0, now: () => clock.at });
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    app.injectWebSocket(server as never);
    await new Promise<void>((ok) => server.once("listening", () => ok()));
    const port = (server.address() as AddressInfo).port;
    rules.port = port;
    closers.push(() => { app.link.stop(); server.close(); });
    return { app, port };
  }

  /** A coordinator socket. `next(type)` resolves with the next message of that type. */
  async function coordinator(port: number, project: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/link?role=coordinator&workspace=work&project=${encodeURIComponent(project)}`);
    const inbox: Envelope[] = [];
    const waiting: { type: string; ok: (m: Envelope) => void }[] = [];
    ws.on("message", (data) => {
      const m = JSON.parse(String(data)) as Envelope;
      const at = waiting.findIndex((w) => w.type === m.type);
      if (at >= 0) waiting.splice(at, 1)[0].ok(m); else inbox.push(m);
    });
    await new Promise((ok, fail) => { ws.once("open", ok); ws.once("error", fail); });
    closers.push(() => ws.close());
    ws.send(JSON.stringify({ v: 1, type: "hello", id: "h", project: { workspace: "work", id: "" }, at: "", payload: { plan: project, session: project, host: "test", wg: "1" } }));
    return {
      ws, inbox,
      next: (type: string) => new Promise<Envelope>((ok) => {
        const at = inbox.findIndex((m) => m.type === type);
        if (at >= 0) ok(inbox.splice(at, 1)[0]); else waiting.push({ type, ok });
      }),
    };
  }

  it("tells only the coordinator of the project about a comment written in the page", async () => {
    const linear = fakeLinear();
    const { app, port } = await start();
    const a = await coordinator(port, "Effort A"); // by name
    const b = await coordinator(port, "p2"); // by id
    await vi.waitFor(() => expect(app.link.hub.active()).toHaveLength(2));
    const response = await app.request("/api/issues/i1/comments", {
      method: "POST", body: JSON.stringify({ body: "Use the v2 API." }),
      headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "content-type": "application/json", "x-workspace": "work", "x-project": "p1" },
    });
    expect(response.status).toBe(200);
    expect(linear.comments).toEqual(["Use the v2 API."]);
    expect((await a.next("changed")).payload).toEqual({ by: "page", what: "comment", issues: ["CD-1"] });
    // CD-1 is Needs Human, so the comment is their answer.
    expect((await a.next("answer")).payload).toEqual({ issue: "CD-1", key: null, body: "Use the v2 API." });
    expect(linear.marks.answered).toEqual(["i1"]); // the record in Linear: wg next finds it after a restart
    await new Promise((ok) => setTimeout(ok, 50));
    expect(b.inbox.filter((m) => m.type === "changed")).toEqual([]);
  });

  it("records a reply to a worker question in Linear and passes it to the coordinator", async () => {
    const linear = fakeLinear();
    const { app, port } = await start();
    const a = await coordinator(port, "Effort A");
    a.ws.send(JSON.stringify({ v: 1, type: "asks", id: "x", project: {}, at: "", payload: { asks: [{ id: "msg_q", key: "a", issue: "CD-1", from: "ctx_1", body: "Which API?", at: "t" }] } }));
    await vi.waitFor(() => expect(app.link.hub.ask({ workspace: "work", id: "p1" }, "msg_q")).not.toBeNull());
    const headers = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "content-type": "application/json", "x-workspace": "work" };
    const response = await app.request("/api/projects/p1/asks/msg_q/reply", { method: "POST", headers, body: JSON.stringify({ body: "Use v2." }) });
    expect(await response.json()).toEqual({ ok: true, recorded: true });
    expect(linear.comments).toEqual(["**Reply to a worker question** (from the page)\n\n> Which API?\n\nUse v2."]);
    expect((await a.next("reply")).payload).toEqual({ ask: "msg_q", issue: "CD-1", key: "a", body: "Use v2." });
    expect(app.link.hub.ask({ workspace: "work", id: "p1" }, "msg_q")).toBeNull();
    const again = await app.request("/api/projects/p1/asks/msg_q/reply", { method: "POST", headers, body: JSON.stringify({ body: "Again" }) });
    expect(again.status).toBe(404);
  });

  it("passes commands to the coordinator; a dispatch is also a comment on its issue", async () => {
    const linear = fakeLinear();
    const { app, port } = await start();
    const a = await coordinator(port, "Effort A");
    await vi.waitFor(() => expect(app.link.hub.active()).toHaveLength(1));
    const headers = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "content-type": "application/json", "x-workspace": "work" };
    const post = (body: unknown) => app.request("/api/projects/p1/commands", { method: "POST", headers, body: JSON.stringify(body) });
    expect((await post({ name: "dispatch", key: "a", issue: "CD-1" })).status).toBe(200);
    expect(linear.comments).toEqual(["**Dispatch requested** on the page. The coordinator dispatches it at its next `wg next`."]);
    expect((await a.next("command")).payload).toEqual({ name: "dispatch", key: "a", issue: "CD-1" });
    expect((await post({ name: "pause" })).status).toBe(200);
    expect((await a.next("command")).payload).toEqual({ name: "pause", key: null, issue: null });
    expect(linear.marks.paused).toBe(true); // the project label is the record
    expect(linear.comments).toHaveLength(1); // pause writes no comment
    expect((await post({ name: "resume" })).status).toBe(200);
    expect((await a.next("command")).payload).toEqual({ name: "resume", key: null, issue: null });
    expect(linear.marks.paused).toBe(false);
    expect((await post({ name: "delete-everything" })).status).toBe(400);
    expect((await post({ name: "dispatch", key: "a", issue: "CD-404" })).status).toBe(404);
  });

  it("finds a Linear edit that did not come through the page", async () => {
    const linear = fakeLinear();
    const clock = { at: Date.now() };
    const { app, port } = await start(clock);
    const a = await coordinator(port, "Effort A");
    await vi.waitFor(() => expect(app.link.hub.active()).toHaveLength(1));
    await app.link.check(); // the first look records the state
    await app.link.check(); // no change: nothing to tell
    expect(a.inbox.filter((m) => m.type === "changed")).toEqual([]);
    linear.touch("2026-11-20T01:00:00Z");
    clock.at += 11_000; // past the 10 s in which the graph cache answers from memory
    await app.link.check();
    expect((await a.next("changed")).payload).toEqual({ by: "linear", what: "issue", issues: ["CD-1"] });
  });

  it("finds a changed node card of the same length, with no change of the issue", async () => {
    const linear = fakeLinear("TM"); // a fictional team
    const clock = { at: Date.now() };
    const { app, port } = await start(clock);
    const a = await coordinator(port, "Effort A");
    await vi.waitFor(() => expect(app.link.hub.active()).toHaveLength(1));
    linear.writeCard("**work-graph node card** `a`\n\n```json\n{\"wg\":1}\n```");
    await app.link.check(); // the first look records the state
    linear.writeCard("**work-graph node card** `a`\n\n```json\n{\"wg\":2}\n```");
    clock.at += 11_000;
    await app.link.check();
    expect((await a.next("changed")).payload).toEqual({ by: "linear", what: "issue", issues: ["TM-1"] });
  });

  it("after wrote, the page hears of it and the next graph load skips the cache", async () => {
    const linear = fakeLinear();
    const { app, port } = await start();
    const headers = { host: `127.0.0.1:${port}`, "x-workspace": "work" };
    const graph = async () => (await (await app.request("/api/projects/p1/graph", { headers })).json()).issues[0].updatedAt;
    expect(await graph()).toBe("2026-11-20T00:00:00Z");
    const page = new WebSocket(`ws://127.0.0.1:${port}/api/link?role=page&workspace=work&project=p1`, { headers: { origin: `http://127.0.0.1:${port}` } });
    const changed = new Promise<Envelope>((ok) => page.on("message", (d) => { const m = JSON.parse(String(d)); if (m.type === "changed") ok(m); }));
    await new Promise((ok) => page.once("open", ok));
    closers.push(() => page.close());
    linear.touch("2026-11-20T02:00:00Z");
    expect(await graph()).toBe("2026-11-20T00:00:00Z"); // the cache answers within 10 s
    const wg = new WebSocket(`ws://127.0.0.1:${port}/api/link?role=coordinator&workspace=work&project=p1`);
    await new Promise((ok) => wg.once("open", ok));
    closers.push(() => wg.close());
    wg.send(JSON.stringify({ v: 1, type: "wrote", id: "w", project: { workspace: "", id: "p1" }, at: "", payload: { issues: ["CD-1"] } }));
    expect((await changed).payload).toEqual({ by: "coordinator", what: "issue", issues: ["CD-1"] });
    expect(await graph()).toBe("2026-11-20T02:00:00Z");
  });

  it("reports the messages that wait for a coordinator, for wg wake", async () => {
    fakeLinear();
    const { app, port } = await start();
    const headers = { host: `127.0.0.1:${port}`, "x-workspace": "work" };
    const presence = async () => (await app.request("/api/projects/p1/presence", { headers })).json();
    expect(await presence()).toEqual({ coordinators: [], queued: 0, waiting: 0 });
    app.link.hub.publish({ workspace: "work", id: "p1" }, "changed", { by: "page", what: "status", issues: ["CD-1"] });
    app.link.hub.publish({ workspace: "work", id: "p1" }, "command", { name: "dispatch", key: "a", issue: "CD-1" });
    expect(await presence()).toEqual({ coordinators: [], queued: 2, waiting: 1 });
  });

  it("refuses a page socket from another origin, and an unknown project", async () => {
    fakeLinear();
    const { port } = await start();
    const refused = (url: string, headers: Record<string, string> = {}) => new Promise<number>((ok) => {
      const ws = new WebSocket(url, { headers });
      ws.on("unexpected-response", (_req, res) => ok(res.statusCode ?? 0));
      ws.on("open", () => { ws.close(); ok(101); });
    });
    expect(await refused(`ws://127.0.0.1:${port}/api/link?role=page`, { origin: "https://evil.example" })).toBe(403);
    expect(await refused(`ws://127.0.0.1:${port}/api/link?role=coordinator&project=Nope`)).toBe(404);
    expect(await refused(`ws://127.0.0.1:${port}/api/link?role=page`, { origin: `http://127.0.0.1:${port}` })).toBe(101);
  });
});
