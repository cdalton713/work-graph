// The Hono app of the work-graph UI: static files from dist/ and a small JSON API over Linear.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import type { Server } from "node:http";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { type OverviewData, type ProjectSummary, summarize } from "../src/lib/overview.ts";
import { parseCard, statusName } from "../src/lib/graph.ts";
import { type Changed, type ProjectRef, projectKey } from "../src/lib/link.ts";
import type { GraphData, IssuePatch, Project, ProjectList } from "../src/lib/types.ts";
import { type Rules, linkRefusal, refusal } from "./access.ts";
import { createGraphCache } from "./cache.ts";
import { isAutonomy } from "../src/lib/autonomy.ts";
import { LinearError, addComment, changedProjects, changedSince, closeProject, listComments, listProjects, loadGraph, markAnswered, setAutonomy, setPaused, updateIssue } from "./linear.ts";
import { type Connection, LinkHub, QUEUE_MAX, realTimers as realLinkTimers, type Timers } from "./link.ts";
import { fileStore, isInside, type Store } from "./store.ts";
import { linearWorkspace, type Workspace } from "./workspaces.ts";
import { configureSite, site } from "../src/lib/site.ts";

/** How many project graphs the overview loads at the same time. */
const OVERVIEW_LOADS = 4;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".map": "application/json",
};

async function json<T>(body: Promise<T>): Promise<T> {
  try {
    return await body;
  } catch {
    throw new LinearError("request body is not JSON", 400);
  }
}

export interface AppOptions {
  /** The configured workspaces; the first is the default. */
  workspaces?: Workspace[];
  /** The human's name (config `human`). */
  human?: string;
  /** The Linear team whose projects the page lists. */
  team: string;
  /** The built page: an absolute path that ends with a separator. */
  dist: string;
  /** How often the server checks Linear for each project that has a connected coordinator. 0: never (tests). */
  watchMs?: number;
  /** The clock of the graph caches and of the link (tests). */
  now?: () => number;
  /** The timers of the link heartbeat (tests). */
  linkTimers?: Timers;
  /**
   * The directory where the link keeps its queue and the open asks over a restart. Default: `WG_STATE_DIR`.
   * None: the link keeps them in memory only.
   */
  stateDir?: string;
}

/** The app, and what the server process needs besides `fetch`. */
export type App = Hono & {
  /** Lets the HTTP server take WebSocket upgrades (`/api/link`). */
  injectWebSocket: (server: Server) => void;
  link: {
    hub: LinkHub; check: () => Promise<void>; stop: () => void;
    /** The server stops: stop the timers and close each link socket (`LinkHub.shutdown`). False: the link state was not written. */
    shutdown: () => Promise<boolean>;
  };
};

/**
 * The store of the link in `stateDir`, or none. The static route serves each file under `dist`, so a state directory
 * there is refused. The store loads only the rooms of the configured workspaces: the overview shows the asks of each room.
 */
function linkStore(stateDir: string | undefined, dist: string, workspaces: Workspace[], after: Timers["after"]): Store | null {
  if (!stateDir) return null;
  if (isInside(stateDir, dist)) {
    console.log(`link state: ${stateDir} is in the page directory ${dist}, which the server serves; the link keeps its state in memory only`);
    return null;
  }
  const store = fileStore(stateDir, { queueMax: QUEUE_MAX, after });
  const ids = new Set(workspaces.map((w) => w.id));
  return {
    ...store,
    load: () => {
      const { rooms } = store.load();
      const kept = rooms.filter((r) => ids.has(r.ref.workspace));
      if (kept.length < rooms.length) console.log(`link state: ignored ${rooms.length - kept.length} rooms of workspaces that the config does not name`);
      return { rooms: kept };
    },
  };
}

/**
 * The app for `rules`. `rules` is read on each request, so a change of `rules.tailnet` takes
 * effect at once. Only the API is guarded: the page itself holds no data.
 */
export function createApp(rules: Rules, { team, dist, watchMs = 30_000, now, linkTimers, human, stateDir = process.env.WG_STATE_DIR || undefined, workspaces = [{ id: "default", name: "Linear", team, key: process.env.LINEAR_API_KEY ?? "", teamLabels: true }] }: AppOptions): App {
  // The overview and the graph rules on the server use the same names as the page.
  configureSite({ human, defaultWorkspace: workspaces[0].id });
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  // `wrote` from wg: forget the cached graph of that project, so the pages that load again see the change.
  const store = linkStore(stateDir, dist, workspaces, (linkTimers ?? realLinkTimers).after);
  const hub = new LinkHub(now ? () => new Date(now()) : undefined, (ref) => caches.get(ref.workspace)?.clear(ref.id || undefined), linkTimers, store);
  hub.start();
  app.use(async (c, next) => {
    await next();
    // Vite puts a hash of the content in each name under assets/, so such a file never changes.
    const fixed = c.req.path.startsWith("/assets/") && c.res.status === 200;
    c.header("Cache-Control", fixed ? "public, max-age=31536000, immutable" : "no-store");
  });
  app.get("/healthz", (c) => c.json({ ok: true }));

  const caches = new Map(workspaces.map((w) => [w.id, createGraphCache({ load: loadGraph, changed: changedSince, changedMany: changedProjects, now })]));
  const graphs = () => caches.get(linearWorkspace.getStore()!.id)!;
  /**
   * A write changed Linear: the next poll of each tab must see it. It forgets only the graph of the project
   * of the written issue (from Linear, not from the request); a write with no known project forgets all
   * graphs of the workspace.
   */
  const wrote = <T>(result: T, projectId: string | null | undefined): T => {
    graphs().clear(projectId ?? undefined);
    return result;
  };
  /** Records the project of the issue that a write changes, for `wrote`. */
  const projectOfWrite = () => {
    const seen: { id: string | null | undefined; hear: (id: string | null) => void } = { id: undefined, hear: (id) => { seen.id = id; } };
    return seen;
  };
  /** One request for each workspace: which of these projects changed. Then each `get` of an unchanged project is free. */
  const checkAll = (refs: { workspace?: string; id: string }[]) => Promise.all(workspaces.map((workspace) => {
    const ids = refs.filter((r) => r.workspace === workspace.id).map((r) => r.id);
    return ids.length ? linearWorkspace.run(workspace, () => caches.get(workspace.id)!.check(ids)) : null;
  }));
  /** The project of a page request (`x-project`), for the link. A request with no project tells no coordinator. */
  const pageProject = (header: (name: string) => string | undefined): ProjectRef | null => {
    const id = header("x-project");
    return id ? { workspace: linearWorkspace.getStore()!.id, id } : null;
  };
  /** The identifier, status, and wg node key of an issue, from the cached graph (never a stale one: the status decides a write). */
  const issueInfo = async (ref: ProjectRef, issueId: string) => {
    const issue = (await graphs().get(ref.id, { fresh: true }).catch(() => null))?.data.issues.find((i) => i.id === issueId);
    return issue
      ? { identifier: issue.identifier, status: statusName(issue.state, issue.labels), key: parseCard(issue.card?.body)?.key ?? null }
      : { identifier: issueId, status: null, key: null };
  };
  const pageChanged = (ref: ProjectRef | null, what: Changed["what"], issues: string[]) => {
    if (ref) hub.publish(ref, "changed", { by: "page", what, issues });
  };
  const api = new Hono();
  // The API can change Linear with the user's key. Accept only this page as the caller.
  api.use(async (c, next) => {
    const reason = refusal(c.req.method, (name) => c.req.header(name), rules);
    if (reason) return c.json({ error: reason }, 403);
    await next();
  });
  // The human's name and the default workspace, for the page before its first render (src/main.tsx).
  api.get("/config", (c) => c.json({ human: site.human, defaultWorkspace: site.defaultWorkspace }));
  api.use(bodyLimit({ maxSize: 2_000_000, onError: (c) => c.json({ error: "request body too large" }, 413) }));
  const projectList = async (): Promise<ProjectList> => {
    const results = await Promise.allSettled(workspaces.map((workspace) =>
      linearWorkspace.run(workspace, () => listProjects(workspace.team)),
    ));
    return {
      workspaces: workspaces.map(({ id, name }, at) => results[at].status === "fulfilled"
        ? { id, name }
        : { id, name, error: `${name} is unavailable. Reload to try again.` }),
      projects: results.flatMap((result, at) => result.status === "fulfilled"
        ? result.value.map((p) => ({ ...p, workspace: workspaces[at].id, workspaceName: workspaces[at].name }))
        : []),
    };
  };
  api.get("/projects", async (c) => c.json<ProjectList>(await projectList()));
  // The projects with a summary of each open one. The graphs come from the same cache as the graph
  // route, a few at a time, so a poll of the overview costs about one cheap check for each project.
  api.get("/overview", async (c) => {
    const list = await projectList();
    const open = list.projects.filter((p) => p.statusType !== "completed" && p.statusType !== "canceled");
    await checkAll(open);
    const summaries: ProjectSummary[] = [];
    let next = 0;
    const worker = async () => {
      while (next < open.length) {
        const p = open[next++];
        const workspace = workspaces.find((w) => w.id === p.workspace)!;
        try {
          const { data } = await linearWorkspace.run(workspace, () => caches.get(workspace.id)!.get(p.id));
          summaries.push(summarize(data, p.workspace));
        } catch (error) {
          summaries.push({ workspace: p.workspace, id: p.id, planned: 0, done: 0, counts: [], you: [], running: 0, review: 0, ready: 0,
            effort: null, freshness: null, updatedAt: null, error: (error as Error).message });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(OVERVIEW_LOADS, open.length) }, worker));
    return c.json<OverviewData>({ ...list, summaries });
  });
  api.use(async (c, next) => {
    const id = c.req.header("x-workspace") || site.defaultWorkspace;
    const workspace = workspaces.find((w) => w.id === id);
    if (!workspace) return c.json({ error: `workspace ${id} is not configured` }, 400);
    return linearWorkspace.run(workspace, next);
  });
  // `?have=<version>`: the page has this version already. Then the answer has no body.
  api.get("/projects/:id/graph", async (c) => {
    // A stale graph (the refresh failed) also carries `stale` and the error, so the page can show both.
    const { data, version, stale, error } = await graphs().get(c.req.param("id"));
    if (c.req.query("have") === version) return c.body(null, 204);
    return c.json({ ...data, version, workspace: linearWorkspace.getStore()!.id, ...(stale ? { stale, error } : {}) });
  });
  api.post("/projects/:id/close", async (c) => {
    const { confirm } = await json(c.req.json<{ confirm?: unknown }>());
    try {
      return c.json(await closeProject(c.req.param("id"), confirm, linearWorkspace.getStore()!.team));
    } finally {
      // A failed closeout can still have completed some issues.
      graphs().clear(c.req.param("id"));
    }
  });
  // A command for the coordinator: run `wg next` now, dispatch a node, pause or resume the effort. A
  // dispatch is also a comment on the node's issue; a pause or resume sets the project label `paused` first,
  // so it holds when this server restarts. `next` changes nothing in Linear.
  api.post("/projects/:id/commands", async (c) => {
    const { name, key, issue } = await json(c.req.json<{ name?: unknown; key?: unknown; issue?: unknown }>());
    if (name !== "next" && name !== "dispatch" && name !== "pause" && name !== "resume") throw new LinearError("name must be next, dispatch, pause, or resume", 400);
    const ref = { workspace: linearWorkspace.getStore()!.id, id: c.req.param("id") };
    let identifier: string | null = null;
    if (name === "dispatch") {
      if (typeof key !== "string" || typeof issue !== "string") throw new LinearError("dispatch names the node key and its issue", 400);
      // Which issues are in the project decides the write: a stale graph is not enough.
      const found = (await graphs().get(ref.id, { fresh: true })).data.issues.find((i) => i.identifier === issue);
      if (!found) throw new LinearError(`no issue ${issue} in this project`, 404);
      const written = projectOfWrite();
      await addComment(found.id, "**Dispatch requested** on the page. The coordinator dispatches it at its next `wg next`.", linearWorkspace.getStore()!.team, written.hear);
      wrote(null, written.id);
      identifier = found.identifier;
    }
    if (name === "pause" || name === "resume") {
      const workspace = linearWorkspace.getStore()!;
      await setPaused(ref.id, name === "pause", workspace.team, workspace.teamLabels);
      names.at = 0;
      wrote(null, ref.id);
    }
    hub.publish(ref, "command", { name, key: typeof key === "string" ? key : null, issue: identifier });
    return c.json({ ok: true, queued: hub.presence(ref).queued });
  });
  // The link state of a project, for `wg wake` on the human's machine: is a coordinator connected, and do messages
  // wait that only a coordinator can act on. A GET, so the host check above is the only gate; it changes nothing.
  api.get("/projects/:id/presence", (c) => {
    const ref = { workspace: linearWorkspace.getStore()!.id, id: c.req.param("id") };
    return c.json({ ...hub.presence(ref), waiting: hub.waiting(ref) });
  });
  // The autonomy level of the effort (work-graph SKILL.md "Autonomy level"). The project label is the record;
  // the command wakes the coordinator, whose `wg next` reads the label and prints `do autonomy`.
  api.post("/projects/:id/autonomy", async (c) => {
    const { level } = await json(c.req.json<{ level?: unknown }>());
    if (!isAutonomy(level)) throw new LinearError("level must be full, standard, or supervised", 400);
    const workspace = linearWorkspace.getStore()!;
    const ref = { workspace: workspace.id, id: c.req.param("id") };
    await setAutonomy(ref.id, level, workspace.team, workspace.teamLabels);
    names.at = 0;
    wrote(null, ref.id);
    hub.publish(ref, "command", { name: "autonomy", key: null, issue: null, level });
    return c.json({ ok: true, level, queued: hub.presence(ref).queued });
  });
  // The human's reply to a worker's question (an Orca ask that the coordinator reported). The reply is a
  // comment on the worker's issue at once; the coordinator sends it to the worker at its next `wg next`.
  api.post("/projects/:id/asks/:ask/reply", async (c) => {
    const { body } = await json(c.req.json<{ body?: unknown }>());
    if (typeof body !== "string" || !body.trim()) throw new LinearError("reply body is empty", 400);
    const ref = { workspace: linearWorkspace.getStore()!.id, id: c.req.param("id") };
    const ask = hub.ask(ref, c.req.param("ask"));
    if (!ask) throw new LinearError("no open question with this id: it was answered, or the coordinator has not reported it", 404);
    // Which issues are in the project decides whether the reply is saved in Linear: a stale graph is not enough.
    // A failed refresh stops the route here, and the question stays open.
    const issue = ask.issue ? (await graphs().get(ref.id, { fresh: true })).data.issues.find((i) => i.identifier === ask.issue) : undefined;
    if (issue) {
      const quote = ask.body.split("\n").map((line) => `> ${line}`).join("\n");
      const written = projectOfWrite();
      await addComment(issue.id, `**Reply to a worker question** (from the page)\n\n${quote}\n\n${body.trim()}`, linearWorkspace.getStore()!.team, written.hear);
      wrote(null, written.id);
    }
    hub.publish(ref, "reply", { ask: ask.id, issue: ask.issue, key: ask.key, body: body.trim() });
    hub.answered(ref, ask.id);
    return c.json({ ok: true, recorded: !!issue });
  });
  api.patch("/issues/:id", async (c) => {
    const patch = await json(c.req.json<IssuePatch>());
    const ref = pageProject((name) => c.req.header(name));
    const written = projectOfWrite();
    const issue = wrote(await updateIssue(c.req.param("id"), patch, linearWorkspace.getStore()!.team, written.hear), written.id);
    const what: Changed["what"] = patch.stateId ? "status" : patch.labelIds ? "label" : "issue";
    pageChanged(ref, what, [issue.identifier]);
    return c.json(issue);
  });
  api.get("/issues/:id/comments", async (c) => c.json(await listComments(c.req.param("id"))));
  api.post("/issues/:id/comments", async (c) => {
    const { body } = await json(c.req.json<{ body?: unknown }>());
    const ref = pageProject((name) => c.req.header(name));
    const info = ref ? await issueInfo(ref, c.req.param("id")) : null;
    const written = projectOfWrite();
    const comment = wrote(await addComment(c.req.param("id"), body, linearWorkspace.getStore()!.team, written.hear), written.id);
    pageChanged(ref, "comment", [info?.identifier ?? c.req.param("id")]);
    // A comment in the page on an issue that waits on the human is their answer: the label `answered` marks it
    // in Linear (wg next finds it there after a restart), and the message wakes the coordinator at once.
    // The comment is saved before the label: when the label fails, the answer is still 200. A retry from
    // the page would write a second comment, so the coordinator gets the message, and `answered: false`
    // tells the page that the label is missing.
    if (ref && info?.status === site.waitStatus) {
      let answered = true;
      try {
        await markAnswered(c.req.param("id"));
      } catch (error) {
        answered = false;
        console.warn(`wg ui: comment saved, but the answered label failed: ${(error as Error).message}`);
      }
      wrote(null, written.id);
      hub.publish(ref, "answer", { issue: info.identifier, key: info.key, body: comment.body });
      return c.json({ ...comment, answered });
    }
    return c.json(comment);
  });
  api.all("*", (c) => c.json({ error: `no route ${c.req.method} ${c.req.path}` }, 404));
  // The link (src/lib/link.ts): `?role=page|coordinator&workspace=<id>&project=<id or name>`. A page
  // with no project is the overview. Each coordinator of each project has its own connection.
  const names = { at: 0, list: null as ProjectList | null };
  const resolve = async (workspace: string, wanted: string): Promise<Project | null> => {
    const find = (list: ProjectList | null) => list?.projects.find((p) => p.workspace === workspace
      && (p.id === wanted || p.name.toLowerCase() === wanted.toLowerCase())) ?? null;
    let found = Date.now() - names.at < 60_000 ? find(names.list) : null;
    if (!found) {
      names.list = await projectList();
      names.at = Date.now();
      found = find(names.list);
    }
    return found;
  };
  app.get("/api/link", async (c, next) => {
    const role = c.req.query("role") ?? "";
    const reason = linkRefusal(role, (name) => c.req.header(name), rules);
    if (reason) return c.json({ error: reason }, 403);
    // The server stops: it takes no new link socket (also below, for an upgrade that waited for the project).
    const restarting = () => c.json({ error: "the server restarts" }, 503);
    if (hub.closing) return restarting();
    const workspace = c.req.query("workspace") || site.defaultWorkspace;
    if (!workspaces.some((w) => w.id === workspace)) return c.json({ error: `workspace ${workspace} is not configured` }, 400);
    const wanted = c.req.query("project");
    if (!wanted && role === "coordinator") return c.json({ error: "a coordinator names its project" }, 400);
    const project = wanted ? await resolve(workspace, wanted) : null;
    if (wanted && !project) return c.json({ error: `no project "${wanted}" in ${workspace}` }, 404);
    if (hub.closing) return restarting();
    c.set("linkRef" as never, (project ? { workspace, id: project.id } : null) as never);
    return next();
  }, upgradeWebSocket((c) => {
    const ref = c.get("linkRef" as never) as ProjectRef | null;
    const role = c.req.query("role");
    let connection: Connection | null = null;
    return {
      onOpen: (_event, ws) => {
        // The raw socket of `ws` has the ping frames of the heartbeat, which WSContext does not have.
        const raw = ws.raw as import("ws").WebSocket;
        const peer = {
          send: (text: string) => ws.send(text), close: (code?: number, reason?: string) => ws.close(code, reason),
          ping: () => raw.ping(), terminate: () => raw.terminate(),
        };
        connection = role === "coordinator" ? hub.joinCoordinator(peer, ref!) : hub.joinPage(peer, ref);
        raw.on("pong", () => connection?.pong());
      },
      onMessage: (event) => connection?.receive(typeof event.data === "string" ? event.data : String(event.data)),
      onClose: () => connection?.closed(),
    };
  }));
  app.route("/api", api);

  app.get("*", async (c) => {
    const file = normalize(join(dist, c.req.path === "/" ? "index.html" : c.req.path));
    if (!file.startsWith(dist)) return c.text("forbidden", 403);
    const type = TYPES[extname(file)];
    // Unknown paths get the app, so a reloaded deep link works.
    const body = await readFile(type ? file : join(dist, "index.html")).catch(() => null);
    if (!body) return c.text("not found (run `pnpm build`)", 404);
    return c.body(body, 200, { "Content-Type": type ?? TYPES[".html"] });
  });

  app.onError((error, c) => {
    const status = (error instanceof LinearError ? error.status : 500) as ContentfulStatusCode;
    if (status === 500) console.error(error);
    return c.json({ error: error.message }, status);
  });
  // Linear edits that did not come through this page: for each project with a connected coordinator,
  // the cached graph (its cheap check) shows which issues changed since the last look.
  const seen = new Map<string, Map<string, string>>();
  // A hash of the node card: two card texts of the same length are still a change.
  const cardHash = (body: string | undefined) => (body === undefined ? "" : createHash("sha1").update(body).digest("hex"));
  const fingerprint = (data: GraphData) => new Map(data.issues.map((i) => [i.id, `${i.updatedAt}|${i.state.id}|${cardHash(i.card?.body)}`]));
  const check = async () => {
    const active = hub.active();
    for (const key of [...seen.keys()]) if (!active.some((r) => projectKey(r) === key)) seen.delete(key);
    await checkAll(active);
    for (const ref of active) {
      const workspace = workspaces.find((w) => w.id === ref.workspace);
      if (!workspace) continue;
      // The coordinator can go away while the check of all projects waits for Linear: then no load for it.
      if (!hub.active().some((r) => projectKey(r) === projectKey(ref))) {
        seen.delete(projectKey(ref));
        continue;
      }
      try {
        const { data } = await linearWorkspace.run(workspace, () => caches.get(workspace.id)!.get(ref.id));
        const now = fingerprint(data), before = seen.get(projectKey(ref));
        seen.set(projectKey(ref), now);
        if (!before) continue;
        const changed = data.issues.filter((i) => before.get(i.id) !== now.get(i.id)).map((i) => i.identifier);
        if (changed.length) hub.publish(ref, "changed", { by: "linear", what: "issue", issues: changed });
      } catch (error) {
        console.error(`link: Linear check of ${projectKey(ref)} failed: ${(error as Error).message}`);
      }
    }
  };
  let checking = false;
  const timer = watchMs > 0 ? setInterval(() => {
    if (checking) return;
    checking = true;
    void check().finally(() => { checking = false; });
  }, watchMs) : null;
  timer?.unref();

  return Object.assign(app, {
    injectWebSocket: (server: Server) => injectWebSocket(server),
    link: {
      hub, check,
      stop: () => { if (timer) clearInterval(timer); hub.stop(); },
      shutdown: () => { if (timer) clearInterval(timer); return hub.shutdown(); },
    },
  });
}
