// The Hono app of the work-graph UI: static files from dist/ and a small JSON API over Linear.
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import type { Server } from "node:http";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { compress } from "hono/compress";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { type OverviewData, type ProjectSummary, summarize } from "../src/lib/overview.ts";
import { parseCard, statusName } from "../src/lib/graph.ts";
import { type Changed, type ProjectRef, projectKey } from "../src/lib/link.ts";
import type { GraphData, IssuePatch, Project, ProjectList, ServerStatus, SiteConfig } from "../src/lib/types.ts";
import { type Rules, linkRefusal, refusal } from "./access.ts";
import { type Auth, LOGIN_PATH, authRoutes, sessionOf } from "./auth.ts";
import { createGraphCache } from "./cache.ts";
import { isAutonomy } from "../src/lib/autonomy.ts";
import { isReviewEffort } from "../src/lib/review.ts";
import { LinearError, addComment, linearBudget, changedProjects, changedSince, closeProject, listComments, listProjects, loadGraph, markAnswered, setAutonomy, setPaused, setReviewEffort, setShared, updateIssue } from "./linear.ts";
import { type Connection, LinkHub, QUEUE_MAX, realTimers as realLinkTimers, type Timers } from "./link.ts";
import { fileStore, isInside, type Store } from "./store.ts";
import { linearWorkspace, type Workspace } from "./workspaces.ts";
import { configureSite, site } from "../src/lib/site.ts";

/** How many project graphs the overview loads at the same time. */
const OVERVIEW_LOADS = 4;
/** An API request that takes longer than this writes a log line. */
export const SLOW_MS = 5_000;

/**
 * The hash of the page contract, as `wg` computes it: the first 12 hex characters of the SHA-256 of
 * `contract.json`. Null when the file is missing.
 */
export function contractHash(file: URL | string = new URL("../skills/work-graph/contract.json", import.meta.url)): string | null {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 12);
  } catch {
    return null;
  }
}

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
  /** The commit of the build. Default: `WG_VERSION`, else `dev`. */
  version?: string;
  /** The page contract file whose hash `/api/config` gives. Default: the `contract.json` of the skill. */
  contractFile?: URL | string;
  /**
   * The viewer (README "Host a read-only viewer"): the API takes only GET, and there is no link. Default: `WG_READ_ONLY`
   * is set to a value other than `0`.
   */
  readOnly?: boolean;
  /**
   * The sign-in of a hosted viewer (`server/auth.ts`). With it, the API needs a session, except `/api/config`.
   * None: the host check is the only gate.
   */
  auth?: Auth | null;
  /** The shared secret for coordinator sockets and API reads. */
  linkToken?: string;
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
export function createApp(rules: Rules, { team, dist, watchMs = 30_000, now, linkTimers, human, stateDir = process.env.WG_STATE_DIR || undefined,
  version = process.env.WG_VERSION || "dev", contractFile, readOnly = !!process.env.WG_READ_ONLY && process.env.WG_READ_ONLY !== "0", auth = null, linkToken, workspaces = [{ id: "default", name: "Linear", team, key: process.env.LINEAR_API_KEY ?? "", teamLabels: true }] }: AppOptions): App {
  if (linkToken && [...linkToken].length < 32) {
    throw new Error("WG_LINK_TOKEN must have at least 32 characters");
  }
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const linkCredential = linkToken ? digest(`Bearer ${linkToken}`) : null;
  const hasLinkToken = (authorization: string | undefined) =>
    linkCredential !== null && authorization !== undefined && timingSafeEqual(digest(authorization), linkCredential);
  // A sign-in gives each account of the domain the same rights, so it is only for a page that changes nothing.
  // Google sends the browser back to the HTTPS name of the page, which only a hosted page has.
  if (auth && !rules.hosted) throw new Error("the sign-in needs a hosted page (WG_HOSTED)");
  if (auth && !readOnly && !auth.owners?.length) throw new Error("the sign-in needs auth.owners on a full page");
  if (auth && !readOnly && !linkCredential) throw new Error("the sign-in needs WG_LINK_TOKEN on a full page");
  const roleOf = (email: string | undefined): SiteConfig["role"] => {
    if (auth && !email) return null;
    if (readOnly || (email && !auth?.owners?.includes(email))) return "viewer";
    return "owner";
  };
  // The overview and the graph rules on the server use the same names as the page.
  configureSite({ human, defaultWorkspace: workspaces[0].id });
  const clock = now ?? Date.now;
  const started = clock();
  const contract = contractHash(contractFile);
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
  // Static files and JSON answers of any size, when the client accepts gzip. Every client that accepts Brotli
  // or deflate accepts gzip too. The 1 KiB minimum of `compress` applies only to a reply with a Content-Length,
  // and these replies have none.
  app.use(compress({ encoding: "gzip" }));
  // A slow API request or a server error writes one log line. The line has no body and no query. The path is
  // the encoded path of the URL: `c.req.path` is decoded, so `%0A` in it would start a second line.
  app.use("/api/*", async (c, next) => {
    const start = clock();
    await next();
    const ms = clock() - start;
    if (ms > SLOW_MS || c.res.status >= 500) console.warn(`wg api: ${c.req.method} ${new URL(c.req.url).pathname} ${c.res.status} ${Math.round(ms)}ms`);
  });
  app.get("/healthz", (c) => c.json({ ok: true }));

  const caches = new Map(workspaces.map((w) => [w.id, createGraphCache({ load: loadGraph, changed: changedSince, changedMany: changedProjects, now })]));
  const graphs = () => caches.get(linearWorkspace.getStore()!.id)!;
  /**
   * The graph as this page may show it. The full page shows each issue of another project that has a blocks
   * relation with an issue of the project. The viewer shows the project only: such an issue can be in a project
   * that its owner did not share, and its title, text, and node card are in the graph.
   */
  const shown = (data: GraphData, viewer: boolean): GraphData => (viewer ? {
    ...data,
    issues: data.issues.filter((i) => !i.external)
      .map((i) => ({ ...i, blocks: i.blocks.filter((r) => r.inProject), blockedBy: i.blockedBy.filter((r) => r.inProject) })),
    status: statusShown(data),
  } : data);
  /**
   * The status document for the viewer: its data block only. A plan can map an issue of another project as a
   * node, and the document names nodes in three places. `lines` (what `wg next` said about each node) goes, and
   * the text around the block, which repeats the lines. The wave keeps only the keys of the nodes that the viewer
   * shows, in `wave` and in the end of the status text (`; wave a,b`, as `wg next` writes it).
   */
  const statusShown = ({ status, issues }: GraphData): GraphData["status"] => {
    try {
      const block = status?.content.match(/```json\s*\n([\s\S]*?)\n```/);
      if (!status || !block) return null;
      const data = JSON.parse(block[1]) as Record<string, unknown>;
      const keys = new Set(issues.filter((i) => !i.external).map((i) => parseCard(i.card?.body)?.key));
      const wave = (Array.isArray(data.wave) ? data.wave : []).filter((key): key is string => typeof key === "string" && keys.has(key));
      const head = typeof data.status === "string" ? data.status.replace(/; wave [\s\S]*$/, "") + (wave.length ? `; wave ${wave.join(",")}` : "") : data.status;
      return { ...status, content: "```json\n" + JSON.stringify({ ...data, status: head, wave, lines: [] }) + "\n```" };
    } catch {
      return null;
    }
  };
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
  /** The count of the project lists that started, and the number of the list that `names` holds. */
  const lists = { started: 0, stored: 0 };
  const api = new Hono<{ Variables: { viewer: boolean } }>();
  // The API can change Linear with the user's key. Accept only this page as the caller.
  api.use(async (c, next) => {
    const header = (name: string) => c.req.header(name);
    const host = refusal("GET", header, rules);
    if (host) return c.json({ error: host }, 403);
    const session = auth ? await sessionOf(c, auth, clock) : null;
    const role = roleOf(session?.email);
    const viewer = readOnly || role === "viewer";
    const method = c.req.method;
    if (viewer && method !== "GET" && method !== "HEAD") return c.json({ error: "this page is read-only" }, 405);
    const reason = refusal(method, header, rules);
    if (reason) return c.json({ error: reason }, 403);
    if (c.req.path === "/api/config" && (method === "GET" || method === "HEAD")) {
      return c.json<SiteConfig>({
        human: site.human, defaultWorkspace: site.defaultWorkspace, contract, version,
        readOnly: viewer, auth: !!auth, user: session?.email ?? null, role,
        link: !readOnly && role ? "/api/link" : null,
      });
    }
    const tokenRead = method === "GET" && hasLinkToken(header("authorization"));
    if (auth && !session && !tokenRead) return c.json({ error: "sign in", login: LOGIN_PATH }, 401);
    c.set("viewer", viewer);
    await next();
  });
  // The state of the server for a check: counts and the Linear budget only, never a key, issue text, or message body.
  api.get("/status", (c) => c.json<ServerStatus>({
    version, contract, uptime: Math.floor((clock() - started) / 1000),
    workspaces: workspaces.map(({ id, name }) => {
      const budget = linearBudget(id);
      return { id, name, requestsRemaining: budget?.requestsRemaining ?? null, requestsLimit: budget?.requestsLimit ?? null,
        requestsReset: budget?.requestsReset ?? null, complexityRemaining: budget?.complexityRemaining ?? null,
        complexityReset: budget?.complexityReset ?? null, at: budget?.at ?? null };
    }),
    cache: !readOnly && c.var.viewer ? 0 : [...caches.values()].reduce((sum, cache) => sum + cache.size(), 0),
    rooms: !readOnly && c.var.viewer ? [] : hub.counts(),
  }));
  api.use(bodyLimit({ maxSize: 2_000_000, onError: (c) => c.json({ error: "request body too large" }, 413) }));
  const projectList = async (viewer = false): Promise<ProjectList> => {
    const order = ++lists.started;
    const results = await Promise.allSettled(workspaces.map((workspace) =>
      linearWorkspace.run(workspace, () => listProjects(workspace.team)),
    ));
    const list: ProjectList = {
      workspaces: workspaces.map(({ id, name, shareUrl }, at) => {
        const address = shareUrl ?? (auth && !readOnly ? `https://${rules.hosted!.host}` : undefined);
        return {
          id, name, ...(address ? { shareUrl: address } : {}),
          ...(results[at].status === "fulfilled" ? {} : { error: `${name} is unavailable. Reload to try again.` }),
        };
      }),
      // The viewer has only the projects that their owner shared (the project label `shared`).
      projects: results.flatMap((result, at) => result.status === "fulfilled"
        ? result.value.map((p) => ({ ...p, workspace: workspaces[at].id, workspaceName: workspaces[at].name }))
        : []),
    };
    const shared = { ...list, projects: list.projects.filter((p) => p.shared) };
    if ((auth || readOnly) && order > lists.stored) {
      lists.stored = order;
      sharedNames.list = shared;
      sharedNames.at = Date.now();
    }
    return viewer ? shared : list;
  };
  api.get("/projects", async (c) => c.json<ProjectList>(await projectList(c.var.viewer)));
  // The projects with a summary of each open one. The graphs come from the same cache as the graph
  // route, a few at a time, so a poll of the overview costs about one cheap check for each project.
  api.get("/overview", async (c) => {
    const viewer = c.var.viewer;
    const list = await projectList(viewer);
    const open = list.projects.filter((p) => p.statusType !== "completed" && p.statusType !== "canceled");
    await checkAll(open);
    const summaries: ProjectSummary[] = [];
    let next = 0;
    const worker = async () => {
      while (next < open.length) {
        const p = open[next++];
        const workspace = workspaces.find((w) => w.id === p.workspace)!;
        try {
          // The viewer takes no older graph when Linear fails (see the graph route).
          const { data } = await linearWorkspace.run(workspace, () => caches.get(workspace.id)!.get(p.id, { fresh: viewer }));
          summaries.push(summarize(shown(data, viewer), p.workspace));
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
  /**
   * The viewer: the request may read this project only when its owner shared it. The list is at most 60 s old, so a
   * project that lost the label goes away in that time. A project that is not in the list makes the server read the
   * list again, at most each 5 s: a new share works in that time, and a wrong id cannot use up the Linear budget.
   * When Linear does not give the list, the answer is 503 and no older list counts: the server gives a project only
   * while it knows that the project is shared. Each server process has its own list.
   */
  let sharedRefresh: Promise<ProjectList> | undefined;
  const sharedProject = async (id: string | undefined, workspace = linearWorkspace.getStore()!.id): Promise<string> => {
    const find = () => sharedNames.list?.projects.find((p) => p.workspace === workspace && p.id === id);
    if (id && Date.now() - sharedNames.at > (find() ? 60_000 : 5_000)) {
      sharedRefresh ??= projectList().finally(() => { sharedRefresh = undefined; });
      await sharedRefresh;
    }
    if (sharedNames.list?.workspaces.find((w) => w.id === workspace)?.error) throw new LinearError("Linear did not confirm that this project is shared. Try again.", 503);
    if (!id || !find()) throw new LinearError("no shared project with this id", 404);
    return id;
  };
  // `?have=<version>`: the page has this version already. Then the answer has no body, except while the graph is stale.
  api.get("/projects/:id/graph", async (c) => {
    const viewer = c.var.viewer;
    if (viewer) await sharedProject(c.req.param("id"));
    // A stale graph (the refresh failed) also carries `stale`, the error, and its load time, so the page can show them.
    // The viewer gets the error of the refresh in its place: an issue of the older graph can be in another project
    // now. A graph in memory can still have an issue that left the project, until its full reload (`FULL_MS`):
    // the check for changes does not see an issue that is in the project no more.
    const { data, version, stale, error, loadedAt } = await graphs().get(c.req.param("id"), { fresh: viewer });
    if (!stale && c.req.query("have") === version) return c.body(null, 204);
    return c.json({ ...shown(data, viewer), version, workspace: linearWorkspace.getStore()!.id, ...(stale ? { stale, error, loadedAt } : {}) });
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
  api.get("/projects/:id/presence", async (c) => {
    const ref = { workspace: linearWorkspace.getStore()!.id, id: c.req.param("id") };
    if (!readOnly && c.var.viewer) {
      await sharedProject(ref.id, ref.workspace);
      return c.json({ ...hub.viewerPresence(ref), waiting: 0 });
    }
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
  // The review effort of the effort (work-graph review-and-merge.md "Review effort"). The project label is the
  // record; the command `next` wakes the coordinator, whose `wg next` reads the label and prints `do review`.
  api.post("/projects/:id/review-effort", async (c) => {
    const { level } = await json(c.req.json<{ level?: unknown }>());
    if (!isReviewEffort(level)) throw new LinearError("level must be thorough, standard, or light", 400);
    const workspace = linearWorkspace.getStore()!;
    const ref = { workspace: workspace.id, id: c.req.param("id") };
    await setReviewEffort(ref.id, level, workspace.team, workspace.teamLabels);
    names.at = 0;
    wrote(null, ref.id);
    hub.publish(ref, "command", { name: "next", key: null, issue: null });
    return c.json({ ok: true, level, queued: hub.presence(ref).queued });
  });
  // Share a project with the read-only viewer, or stop that. The project label `shared` is the record: the viewer
  // reads it from Linear. No coordinator acts on it.
  api.post("/projects/:id/share", async (c) => {
    const { shared } = await json(c.req.json<{ shared?: unknown }>());
    if (typeof shared !== "boolean") throw new LinearError("shared must be true or false", 400);
    const workspace = linearWorkspace.getStore()!;
    await setShared(c.req.param("id"), shared, workspace.team, workspace.teamLabels);
    names.at = 0;
    sharedNames.at = 0;
    sharedNames.list = null;
    lists.stored = lists.started;
    return c.json({ ok: true, shared });
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
  api.get("/issues/:id/comments", async (c) => {
    // The viewer reads the comments of an issue only through its shared project (`x-project`). Linear says in the
    // same answer which project the issue is in now: an issue that moved to another project gives 404.
    if (c.var.viewer) return c.json(await listComments(c.req.param("id"), await sharedProject(c.req.header("x-project"))));
    return c.json(await listComments(c.req.param("id")));
  });
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
  const sharedNames = { at: 0, list: null as ProjectList | null };
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
    // The viewer has no link: a coordinator connects to the full page only.
    if (readOnly) return c.json({ error: "this page has no link" }, 404);
    const role = c.req.query("role") ?? "";
    const reason = linkRefusal(role, (name) => c.req.header(name), rules);
    if (reason) return c.json({ error: reason }, 403);
    if (role === "coordinator" && linkCredential !== null && !hasLinkToken(c.req.header("authorization"))) {
      return c.json({ error: "coordinator token required" }, 401);
    }
    const session = auth && role === "page" ? await sessionOf(c, auth, clock) : null;
    if (auth && role === "page" && !session) return c.json({ error: "sign in", login: LOGIN_PATH }, 401);
    const viewer = role === "page" && roleOf(session?.email) === "viewer";
    // The server stops: it takes no new link socket (also below, for an upgrade that waited for the project).
    const restarting = () => c.json({ error: "the server restarts" }, 503);
    if (hub.closing) return restarting();
    const workspace = c.req.query("workspace") || site.defaultWorkspace;
    if (!workspaces.some((w) => w.id === workspace)) return c.json({ error: `workspace ${workspace} is not configured` }, 400);
    const wanted = c.req.query("project");
    if (!wanted && role === "coordinator") return c.json({ error: "a coordinator names its project" }, 400);
    const id = wanted ? viewer ? await sharedProject(wanted, workspace) : (await resolve(workspace, wanted))?.id : null;
    if (wanted && !id) return c.json({ error: `no project "${wanted}" in ${workspace}` }, 404);
    if (hub.closing) return restarting();
    c.set("linkRef" as never, (id ? { workspace, id } : null) as never);
    c.set("linkViewer" as never, viewer as never);
    return next();
  }, upgradeWebSocket((c) => {
    const ref = c.get("linkRef" as never) as ProjectRef | null;
    const role = c.req.query("role");
    const viewer = c.get("linkViewer" as never) as boolean;
    let connection: Connection | null = null;
    return {
      onOpen: (_event, ws) => {
        // The raw socket of `ws` has the ping frames of the heartbeat, which WSContext does not have.
        const raw = ws.raw as import("ws").WebSocket;
        const peer = {
          send: (text: string) => ws.send(text), close: (code?: number, reason?: string) => ws.close(code, reason),
          ping: () => raw.ping(), terminate: () => raw.terminate(),
        };
        if (role === "coordinator") connection = hub.joinCoordinator(peer, ref!);
        else if (viewer) connection = hub.joinViewer(peer, ref, async (project) =>
          !!(await sessionOf(c, auth!, clock)) && await sharedProject(project.id, project.workspace).then(() => true, () => false));
        else connection = hub.joinPage(peer, ref);
        raw.on("pong", () => connection?.pong());
      },
      onMessage: (event) => connection?.receive(typeof event.data === "string" ? event.data : String(event.data)),
      onClose: () => connection?.closed(),
    };
  }));
  app.route("/api", api);
  if (auth) {
    // The sign-in answers only under the name of the page, as the API does.
    app.use("/auth/*", async (c, next) => {
      const reason = refusal("GET", (name) => c.req.header(name), rules);
      if (reason) return c.json({ error: reason }, 403);
      await next();
    });
    app.route("/auth", authRoutes(auth, () => `https://${rules.hosted!.host}`, clock));
  }

  app.get("*", async (c) => {
    const file = normalize(join(dist, c.req.path === "/" ? "index.html" : c.req.path));
    if (!file.startsWith(dist)) return c.text("forbidden", 403);
    const type = TYPES[extname(file)];
    // Unknown paths get the app, so a reloaded deep link works.
    const body = await readFile(type ? file : join(dist, "index.html")).catch(() => null);
    if (!body) return c.text("not found (run `pnpm build`)", 404);
    const contentType = type ?? TYPES[".html"];
    if (contentType !== TYPES[".html"]) return c.body(body, 200, { "Content-Type": contentType });
    // The page has `no-store`; the ETag lets a client that has it skip the body. The tag is weak, so that the
    // gzip and the plain reply have the same validator, and the 304 has the same ETag and Vary as the 200.
    const tag = `W/"${createHash("sha1").update(body).digest("hex")}"`;
    const vary = { ETag: tag, Vary: "Accept-Encoding" };
    const have = c.req.header("if-none-match")?.split(",").map((t) => t.trim().replace(/^W\//, ""));
    if (have?.includes(tag.slice(2)) || have?.includes("*")) return c.body(null, 304, vary);
    return c.body(body, 200, { "Content-Type": contentType, ...vary });
  });

  app.onError((error, c) => {
    const status = (error instanceof LinearError ? error.status : 500) as ContentfulStatusCode;
    // An API request writes its one log line in the request log above. Another route writes the error here.
    if (status === 500 && !c.req.path.startsWith("/api/")) console.error(error);
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
