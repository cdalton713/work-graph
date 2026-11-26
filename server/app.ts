// The Hono app of the work-graph UI: static files from dist/ and a small JSON API over Linear.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import type { Server } from "node:http";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono, type Context } from "hono";
import { matchedRoutes } from "hono/route";
import { bodyLimit } from "hono/body-limit";
import { compress } from "hono/compress";
import { parseAccept } from "hono/utils/accept";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { type OverviewData, type ProjectSummary, summarize } from "../src/lib/overview.ts";
import { parseCard, statusName } from "../src/lib/graph.ts";
import { type Changed, type ProjectRef, projectKey, type ToCoordinator } from "../src/lib/link.ts";
import type { GraphData, IssuePatch, Project, ProjectList, ServerStatus, SiteConfig } from "../src/lib/types.ts";
import { type Rules, linkRefusal, refusal, sharedRoutes } from "./access.ts";
import { accountRoutes, attemptLimit, accountUsage } from "./account.ts";
import { isLinearIdentifier, planRoutes } from "./plans.ts";
import { createStarter, creationInput, starterTeam } from "./create-project.ts";
import { claimRoutes } from "./claims.ts";
import type { ClaimScope } from "./db/claims.ts";
import { shareRoutes, type ShareAccess } from "./shares.ts";
import { memberAccessRoutes, missingAccess, type InWorkspace } from "./linearaccess.ts";
import { type Auth, type Session, LOGIN_PATH, authRoutes, clearSessionCookie, sessionOf } from "./auth.ts";
import { LinearSignInRequired, linearAuthRoutes, linearSessionOf, type LinearAuth } from "./linearauth.ts";
import { createGraphCache } from "./cache.ts";
import { isAutonomy } from "../src/lib/autonomy.ts";
import { isReviewEffort } from "../src/lib/review.ts";
import { NeedsLinearAccess, sharedLinear, LinearError, LinearKeyRequired, addComment, gql, linearBudget, linearCache, createLinearCache, changedProjects, changedSince, closeProject, listComments, listProjects, loadGraph, markAnswered, readLinearTeams, setAutonomy, setPaused, setReviewEffort, setShared, updateIssue } from "./linear.ts";
import { type Connection, type LinkMember, LinkHub, LinkRoomFull, QUEUE_MAX, RECONNECT_GRACE_MS, RESTART_CODE, realTimers as realLinkTimers, reportLinkError, type Timers } from "./link.ts";
import type { LinkBus } from "./linkbus.ts";
import { redisLinkBus } from "./linkbus-redis.ts";
import { redisLinkState } from "./linkstate-redis.ts";
import { connectRedis, LINK_PREFIX, RedisCommandFailed, RedisUnavailable } from "./redis.ts";
import { checkLinkTenant, memoryLinkState, roomAccount, roomAccounts, roomKey, type LinkRoomState, type RoomRef } from "./linkstate.ts";
import { fileStore, isInside, type Store } from "./store.ts";
import { linearWorkspace, type Workspace } from "./workspaces.ts";
import { createSite, DEFAULT_HUMAN } from "../src/lib/site.ts";
import { requestSite, serverSite } from "./site.ts";
import { manifestResponse } from "./manifest.ts";
import { createTelemetry, type UsageScope, type UsageWorkspace } from "./telemetry.ts";
import { pageEvents, type PageEvent } from "../src/lib/telemetry.ts";
import { CONFIG_TENANT_ID, configTenants, TENANT_IDLE_MS, type SharedWorkspace, type Tenant, type Tenants } from "./tenants.ts";

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
  ".woff2": "font/woff2",
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
  appName?: string;
  tenants?: Tenants;
  linearAuth?: LinearAuth;
  telemetryEnv?: NodeJS.ProcessEnv;
  waitUntil?: (job: Promise<void>) => void;
  serviceReady?: () => Promise<boolean | string>;
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
  linkMaxAgeMs?: number;
  linkPongMs?: number;
  linkState?: LinkRoomState;
  linkBus?: LinkBus;
  redisUrl?: string;
  redisPrefix?: string;
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
   * Hosted sign-in (`server/auth.ts`). The API needs a session except for config and coordinator reads.
   * Without sign-in, the API uses the host and origin checks.
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
export function createApp(rules: Rules, { team, dist, watchMs = 30_000, now, linkTimers, linkMaxAgeMs, linkPongMs, human, stateDir = process.env.WG_STATE_DIR || undefined,
  appName,
  version = process.env.WG_VERSION || "dev", contractFile, readOnly = !!process.env.WG_READ_ONLY && process.env.WG_READ_ONLY !== "0", auth = null, linearAuth, serviceReady, telemetryEnv = process.env, waitUntil, linkToken, linkState, linkBus, redisUrl, redisPrefix, tenants, workspaces = [{ id: "default", name: "Linear", team, key: process.env.LINEAR_API_KEY ?? "", teamLabels: true }] }: AppOptions): App {
  if (linkToken && [...linkToken].length < 32) {
    throw new Error("WG_LINK_TOKEN must have at least 32 characters");
  }
  const digest = (value: string) => createHash("sha256").update(value).digest();
  // A sign-in gives each account of the domain the same rights, so it is only for a page that changes nothing.
  // Google sends the browser back to the HTTPS name of the page, which only a hosted page has.
  if (auth && !rules.hosted) throw new Error("the sign-in needs a hosted page (WG_HOSTED)");
  if (linearAuth && (!rules.hosted || !tenants?.signIn)) throw new Error("Linear sign-in needs a hosted page and a database");
  if (!tenants && auth && !readOnly && !auth.owners?.length) throw new Error("the sign-in needs auth.owners on a full page");
  if (!tenants && auth && !readOnly && !linkToken) throw new Error("the sign-in needs WG_LINK_TOKEN on a full page");
  const configured = configTenants({ human: human ?? DEFAULT_HUMAN, workspaces, auth, linkToken, readOnly });
  const directory: Tenants = tenants ?? configured;
  const accountStore = tenants?.accountStore;
  const requiresLinkToken = !!tenants || !!linkToken;
  const linkEnabled = !readOnly;
  const roomRef = (ref: ProjectRef, tenant: Tenant): RoomRef => tenants ? { ...ref, tenant: tenant.id } : ref;
  const siteOf = (tenant: Tenant) => createSite(tenant.human, tenant.workspaces[0]?.id ?? "default");
  const installationSite = createSite(human ?? DEFAULT_HUMAN, workspaces[0]?.id ?? "default");
  const clock = now ?? Date.now;
  const telemetry = createTelemetry(telemetryEnv, tenants ? "service" : "config", waitUntil, undefined, clock);
  const configIdentities = new WeakMap<Workspace, Promise<UsageWorkspace | null>>();
  async function usageScope(tenant: Tenant, workspace?: Workspace): Promise<UsageScope | null> {
    if (tenants) {
      const account = await (await accountStore?.())?.readTenant(tenant.id);
      const selected = workspace && account?.connections.find((entry) => entry.workspaceId === workspace.id);
      return account ? accountUsage(account, workspace ? selected ?? null : undefined) : null;
    }
    if (!workspace?.key) return null;
    let pending = configIdentities.get(workspace);
    if (!pending) {
      pending = readLinearTeams(workspace.key, "api_key", true)
        .then(({ identity }) => ({ id: identity.workspaceId, organization: identity.organization }))
        .catch(() => { configIdentities.delete(workspace); return null; });
      configIdentities.set(workspace, pending);
    }
    const identity = await pending;
    return identity ? {
      tenant: tenant.id, workspace: { ...identity, configId: workspace.id },
    } : null;
  }

  const firstConnectionAttempts = new Map<string, number>();
  function firstConnection(tenant: Tenant) {
    if (!accountStore || !telemetry) return;
    const { id } = tenant;
    const time = clock();
    if ((firstConnectionAttempts.get(id) ?? -Infinity) > time) return;
    firstConnectionAttempts.delete(id);
    if (firstConnectionAttempts.size >= 4096) {
      firstConnectionAttempts.delete(firstConnectionAttempts.keys().next().value!);
    }
    firstConnectionAttempts.set(id, time + 5 * 60_000);
    telemetry.emit("first_connection", {}, () => usageScope(tenant), id, async () => {
      const claimed = await (await accountStore())?.claimFirstConnection(id) ?? false;
      if (claimed && firstConnectionAttempts.has(id)) firstConnectionAttempts.set(id, Infinity);
      return claimed;
    });
  }
  const readSession = (c: Parameters<typeof sessionOf>[0]) =>
    linearAuth ? linearSessionOf(c, linearAuth, clock) : auth ? sessionOf(c, auth, clock) : null;
  const started = clock();
  const contract = contractHash(contractFile);
  const app = new Hono();
  app.use("/join/*", async (c, next) => {
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", "no-store");
    await next();
  });
  if (serviceReady) app.use(async (c, next) => {
    const ready = await serviceReady();
    if (ready === "schema-too-new") return c.text("The database schema is newer than this server.", 500);
    if (ready === false) return c.text("The database did not answer.", 503);
    if (typeof ready === "string") return c.text(`Vercel full page requires ${ready}`, 500);
    await next();
  });
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  type CachedList = { at: number; list: ProjectList | null };
  const newList = (): CachedList => ({ at: 0, list: null });
  const newState = (tenant: Tenant) => ({
    site: siteOf(tenant),
    graphs: new Map<string, ReturnType<typeof createGraphCache>>(),
    linear: createLinearCache(),
    names: newList(), sharedNames: newList(),
    lists: { started: 0, stored: 0 },
    sharedRefresh: undefined as Promise<ProjectList> | undefined,
    seen: new Map<string, Map<string, string>>(),
    lastUsed: clock(), active: 0,
  });
  const states = new Map<string, ReturnType<typeof newState>>();
  const tenantScope = new AsyncLocalStorage<{ tenant: Tenant; state: ReturnType<typeof newState> }>();
  const scope = () => {
    const current = tenantScope.getStore();
    if (!current) throw new Error("server operation needs a tenant");
    serverSite();
    return current;
  };
  let revision = 0;
  const revisions = new Map<string, number>();
  const tenantChangedSince = (id: string, lookupRevision: number) => (revisions.get(id) ?? 0) > lookupRevision;
  const runInTenant = async <T>(tenant: Tenant, run: () => Promise<T>, lookupRevision = revision): Promise<T> => {
    // The lookup can return an old tenant after a notice. Keep that request's cache private.
    // One revision also covers lookups that have not yet identified a tenant.
    const canShare = lookupRevision === revision;
    const state = (canShare ? states.get(tenant.id) : undefined) ?? newState(tenant);
    if (canShare) states.set(tenant.id, state);
    state.active++;
    try {
      return await tenantScope.run({ tenant, state }, () => requestSite.run(state.site, () => linearCache.run(state.linear, run)));
    } finally {
      state.active--;
      state.lastUsed = clock();
    }
  };
  const graphCache = (id: string) => {
    const { graphs } = scope().state;
    let cache = graphs.get(id);
    if (!cache) graphs.set(id, cache = createGraphCache({ load: loadGraph, changed: changedSince, changedMany: changedProjects, now }));
    return cache;
  };
  // `wrote` from wg: forget the cached graph of that project, so the pages that load again see the change.
  const ended = new Map<string, number>();
  const pendingLogout = new Map<string, number>();
  const rememberEnded = (id: string, expiresAt: number) => {
    for (const [session, expiry] of ended) if (expiry <= clock()) ended.delete(session);
    if (expiresAt > clock()) ended.set(id, Math.max(expiresAt, ended.get(id) ?? 0));
  };
  // A config server on the same Redis can keep using the original channel and room keys.
  const linkPrefix = tenants ? (redisPrefix ?? LINK_PREFIX) + "tenants:" : redisPrefix;
  const redis = redisUrl ? connectRedis(redisUrl, linkPrefix, (ready) => {
    if (ready) {
      for (const state of states.values()) requestSite.run(state.site, () => {
        for (const cache of state.graphs.values()) cache.clear();
      });
      void requestSite.run(installationSite, flushLogouts);
    } else if (hub.hasSockets) hub.restartSockets();
  }, readOnly, undefined, () => hub.hasSockets) : null;
  const eventLimit = attemptLimit({ redis: redis ?? undefined, prefix: linkPrefix ?? LINK_PREFIX, now: clock }, "usage-events:", 60_000, 60);
  const projectDays = new Set<string>();
  let lastProjectDay = -1;
  async function firstToday(organization: string, project: string) {
    const day = Math.floor(clock() / 86_400_000);
    const key = digest(JSON.stringify([day, organization, project])).toString("hex");
    if (redis) {
      return (await redis.run((client) => client.set((linkPrefix ?? LINK_PREFIX) + "usage-project:" + key, "1", "EX", 86_400, "NX"))) === "OK";
    }
    if (lastProjectDay !== day) { projectDays.clear(); lastProjectDay = day; }
    if (projectDays.has(key)) return false;
    projectDays.add(key);
    return true;
  }
  const redisState = redis ? redisLinkState(redis, linkPrefix, undefined, linkMaxAgeMs ? RECONNECT_GRACE_MS : 0) : null;
  if (redis && stateDir) console.log("Redis link store ignores WG_STATE_DIR");
  const store = tenants || redis || linkState ? null : linkStore(stateDir, dist, workspaces, (linkTimers ?? realLinkTimers).after);
  const roomState = redisState ?? linkState ?? memoryLinkState(store);
  const hub = new LinkHub(
    now ? () => new Date(now()) : undefined, (ref) => {
      states.get(ref.tenant ?? CONFIG_TENANT_ID)?.graphs.get(ref.workspace)?.clear(ref.id || undefined);
    }, linkTimers,
    store, roomState, redis && !readOnly ? redisLinkBus(redis, linkPrefix) : linkBus,
    { maxAgeMs: linkMaxAgeMs, pongMs: linkPongMs, site: installationSite, tenantSite: (id) => states.get(id)?.site }, rememberEnded,
  );
  const stopWatching = directory.onChange((id, membersOnly) => {
    revision++;
    if (!membersOnly) {
      revisions.set(id, revision);
      hub.restartSockets(id);
      states.delete(id);
    }
    if (linkEnabled && directory.sharedWorkspaces) {
      void hub.recheckMembers(id, async (ref, account) =>
        (await directory.sharedWorkspaces!(account)).find((entry) => entry.owner.id === ref.tenant
          && entry.workspace.id === ref.workspace && entry.projectId === ref.id)?.role ?? null).catch(reportLinkError);
    }
  });
  const currentRoom = (ref: ProjectRef) => roomRef(ref, scope().tenant);
  const dropIdle = async (id: string) => {
    const state = states.get(id);
    if (!state) return;
    const idle = () => !state.active && clock() - state.lastUsed >= TENANT_IDLE_MS;
    if (!idle()) return;
    if (linkEnabled && ((tenants && hub.hasTenantSockets(id))
      || (await linkRead(() => hub.active({ includeGrace: false }), [])).some((ref) => ref.tenant === (tenants ? id : undefined)))) return;
    if (states.get(id) === state && idle()) states.delete(id);
  };
  const idleTimer = setInterval(() => {
    void Promise.all([...states.keys()].map(dropIdle)).catch(reportLinkError);
  }, TENANT_IDLE_MS);
  idleTimer.unref();
  let logoutTimer: ReturnType<typeof setInterval> | undefined;
  let flushing: Promise<void> | undefined;
  function flushLogouts(): Promise<void> {
    if (!redis?.ready || !pendingLogout.size) return Promise.resolve();
    if (flushing) return flushing;
    flushing = flush().finally(() => {
      flushing = undefined;
      if (!pendingLogout.size && logoutTimer) {
        clearInterval(logoutTimer);
        logoutTimer = undefined;
      }
    });
    return flushing;
  }
  async function flush() {
    try {
      for (const [id, expiry] of pendingLogout) {
        if (expiry > clock()) await hub.endSession(id, expiry, clock());
        if (pendingLogout.get(id) === expiry) pendingLogout.delete(id);
      }
    } catch (error) {
      reportLinkError(error);
    }
  }
  const linkAvailable = () => !hub.closing && (redis?.ready ?? true);
  const linkRead = async <T>(read: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await read(); }
    catch (error) {
      if (error instanceof RedisUnavailable || error instanceof RedisCommandFailed) return fallback;
      throw error;
    }
  };
  const lookupSession = async (session: Session) => {
    if (!redisState) return hub.sessionEnded(session.id, clock());
    const expiry = await redisState.sessionExpiry!(session.id);
    if (expiry !== null) rememberEnded(session.id, expiry);
    void flushLogouts();
    return (ended.get(session.id) ?? 0) > clock();
  };
  const sessionActive = async (session: Session, allowOffline = false) => {
    if (clock() >= session.expiresAt || (ended.get(session.id) ?? 0) > clock()) return false;
    if (!redis || !allowOffline) return !await lookupSession(session);
    const unavailable = Symbol();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof unavailable>((resolve) => { timer = setTimeout(() => resolve(unavailable), 500); });
    try {
      const result = await Promise.race([linkRead<boolean | typeof unavailable>(() => lookupSession(session), unavailable), deadline]);
      return result === unavailable ? (ended.get(session.id) ?? 0) <= clock() : !result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const signOut = async (session: Session) => {
    rememberEnded(session.id, session.expiresAt);
    try {
      await hub.endSession(session.id, session.expiresAt, clock());
    } catch (error) {
      if (redis) {
        pendingLogout.set(session.id, session.expiresAt);
        logoutTimer ??= setInterval(() => {
          for (const [id, expiry] of pendingLogout) if (expiry <= clock()) pendingLogout.delete(id);
          if (!pendingLogout.size && logoutTimer) {
            clearInterval(logoutTimer);
            logoutTimer = undefined;
            return;
          }
          const recover = redis.refusesWrites ? redis.checkWrites(true) : Promise.resolve();
          void recover.then(flushLogouts).catch(reportLinkError);
        }, 20_000);
        logoutTimer.unref();
        void flushLogouts();
      }
      reportLinkError(error);
    }
  };
  if (linkEnabled) hub.start();
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
  // A slow API or join request or a server error writes one log line. The line has no body and no query. The path is
  // the encoded path of the URL: `c.req.path` is decoded, so `%0A` in it would start a second line.
  app.use(async (c, next) => {
    const joining = c.req.path.startsWith("/join/");
    if (!joining && !c.req.path.startsWith("/api/")) return next();
    const start = clock();
    await next();
    const ms = clock() - start;
    const path = joining ? "/join/[link]" :
      /^\/api\/account(?:\/|$)/.test(c.req.path) ? "/api/account" :
      /^\/api\/projects\/[^/]+\/claims(?:\/|$)/.test(c.req.path) ? "/api/projects/[project]/claims" :
      /^\/api\/projects\/[^/]+\/plan(?:\/|$)/.test(c.req.path) ? "/api/projects/[project]/plan" : new URL(c.req.url).pathname;
    if (!(c.error instanceof RedisUnavailable || c.error instanceof RedisCommandFailed)
        && (ms > SLOW_MS || c.res.status >= 500)) console.warn(`wg api: ${c.req.method} ${path} ${c.res.status} ${Math.round(ms)}ms`);
  });
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/manifest.json", () => manifestResponse(appName));

  const graphs = () => graphCache(linearWorkspace.getStore()!.id);
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
  const wrote = async <T>(result: T, projectId: string | null | undefined): Promise<T> => {
    const workspace = linearWorkspace.getStore()!.id;
    const { tenant, state } = scope();
    state.graphs.get(workspace)?.clear(projectId ?? undefined);
    const shared = states.get(tenant.id);
    if (shared !== state) shared?.graphs.get(workspace)?.clear(projectId ?? undefined);
    if (linkEnabled) await hub.invalidate(roomRef({ workspace, id: projectId ?? "" }, tenant));
    return result;
  };
  /** Records the project of the issue that a write changes, for `wrote`. */
  const projectOfWrite = () => {
    const seen: { id: string | null | undefined; hear: (id: string | null) => void } = { id: undefined, hear: (id) => { seen.id = id; } };
    return seen;
  };
  /** One request for each workspace: which of these projects changed. Then each `get` of an unchanged project is free. */
  const checkAll = (refs: { workspace?: string; id: string }[]) => Promise.all(scope().tenant.workspaces.map((workspace) => {
    const ids = refs.filter((r) => r.workspace === workspace.id).map((r) => r.id);
    return ids.length ? linearWorkspace.run(workspace, () => graphCache(workspace.id).check(ids)) : null;
  }));
  /** The project of a page request (`x-project`), for the link. A request with no project tells no coordinator. */
  const pageProject = (header: (name: string) => string | undefined): ProjectRef | null => {
    const id = sharedScope.getStore()?.projectId ?? header("x-project");
    return id ? { workspace: linearWorkspace.getStore()!.id, id } : null;
  };
  /** The identifier, status, and wg node key of an issue, from the cached graph (never a stale one: the status decides a write). */
  const issueInfo = async (ref: ProjectRef, issueId: string) => {
    const issue = (await graphs().get(ref.id, { fresh: true }).catch(() => null))?.data.issues.find((i) => i.id === issueId);
    return issue
      ? { identifier: issue.identifier, status: statusName(issue.state, issue.labels), key: parseCard(issue.card?.body)?.key ?? null }
      : { identifier: issueId, status: null, key: null };
  };
  const notify = async <T, F>(send: () => Promise<T>, fallback: F): Promise<T | F> => {
    try { return await send(); }
    catch (error) {
      if (error instanceof LinkRoomFull) throw error;
      console.warn("Linear write saved, but the link notice was lost");
      return fallback;
    }
  };
  const noticeId = (key: string | undefined, route: string) =>
    key && key.length <= 256 ? digest(JSON.stringify([route, key])).toString("hex") : undefined;
  const enqueueLink = <T extends keyof ToCoordinator>(ref: ProjectRef, type: T, payload: ToCoordinator[T], answeredAsk?: string, id?: string, member?: LinkMember): Promise<{ queued: number; waiting?: boolean }> =>
    linkEnabled ? hub.enqueue(currentRoom(ref), type, payload, answeredAsk, id, member) : Promise.resolve({ queued: 0, waiting: false });
  const pageChanged = async (ref: ProjectRef | null, what: Changed["what"], issues: string[], id?: string) => {
    if (ref) await notify(() => enqueueLink(ref, "changed", { by: "page", what, issues }, undefined, id), undefined);
  };
  const projectChanged = async (
    ref: RoomRef, accounts: ShareAccess["accounts"],
    scope: ClaimScope, nodes?: string[],
  ) => {
    if (!linkEnabled || nodes?.length === 0) return;
    const controller = new AbortController();
    const { signal } = controller;
    const send = async () => {
      let keymap: Record<string, unknown> | undefined;
      if (nodes) {
        const result = await accounts.plans({ project: scope.project, account: scope.project[0] }, { kind: "get" });
        keymap = result.plan?.keymap;
      }
      let delivered = true;
      const entries = keymap?.nodes;
      for (const node of nodes ?? [undefined]) {
        signal.throwIfAborted();
        const entry = node && entries && typeof entries === "object" && Object.hasOwn(entries, node)
          ? (entries as Record<string, unknown>)[node] : undefined;
        const id = entry && typeof entry === "object" && "identifier" in entry
          ? entry.identifier : node && keymap?.[node];
        try {
          await hub.projectChanged(ref, isLinearIdentifier(id) ? [id] : [], scope.membership ? scope.account : undefined, signal);
        } catch {
          delivered = false;
        }
      }
      return delivered;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<false>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(false);
      }, 2_000);
    });
    try {
      const delivered = await Promise.race([send().catch(() => false), deadline]);
      if (!delivered) console.warn("Project change saved, but the link notice was lost");
    } finally {
      clearTimeout(timer);
    }
  };
  async function shareProject(tenant: Tenant, workspace: Workspace, id: string) {
    try {
      const data = await runInTenant(tenant, () => linearWorkspace.run(workspace,
        () => gql("query($id:String!){project(id:$id){id name}}", { id })));
      return data.project?.id === id && typeof data.project.name === "string" ? data.project.name : null;
    } catch (error) {
      if (error instanceof LinearError && (error.status === 403 || error.status === 404)) return null;
      throw error;
    }
  }

  const projectWriteAccess = accountStore && (async (c: Context, plan = false) => {
    const header = (name: string) => c.req.header(name);
    const authorization = header("authorization");
    const method = c.req.method;
    const read = method === "GET" || method === "HEAD";
    const reason = authorization && !header("origin")
      ? linkRefusal("coordinator", header, rules) : refusal(method, header, rules);
    if (reason) return c.json({ error: reason }, 403);
    const signed = authorization ? null : await readSession(c);
    const session = signed && await sessionActive(signed, read) ? signed : null;
    const membership = session ? await directory.fromSession(session) : null;
    const account = authorization ? await directory.fromToken(authorization) : membership?.tenant;
    if (!account) return c.json({ error: "sign in", login: LOGIN_PATH }, 401);
    if (!read && (readOnly || membership?.role === "viewer" || (!authorization && (plan || method !== "DELETE")))) {
      return c.json({ error: plan ? "A coordinator token is required to write plans" : "A coordinator token is required to claim nodes" }, 403);
    }

    const id = c.req.param("id")!;
    const selected = header("x-workspace");
    const sharedPrefix = "shared:";
    const isShared = selected?.startsWith(sharedPrefix);
    const shared = isShared
      ? (await directory.sharedWorkspaces?.(account.id))?.find((entry) => entry.id === selected && entry.projectId === id)
      : undefined;
    const owner = shared?.owner ?? account;
    const workspace = isShared ? shared?.workspace
      : account.workspaces.find((entry) => entry.id === (selected || account.workspaces[0]?.id));
    const connection = workspace?.connectionId;
    if (!workspace || !connection || workspace.needsKey || (header("x-project") && header("x-project") !== id)) {
      return c.json({ error: "Project not found" }, 404);
    }
    const name = shared && (!plan || read) ? shared.name : await shareProject(owner, workspace, id);
    if (name === null) {
      return c.json({ error: "Project not found" }, 404);
    }
    const accounts = await accountStore();
    if (!accounts) return c.json({ error: "Account service unavailable" }, 503);
    const claimScope = { project: [owner.id, connection, id], account: account.id,
      membership: shared?.id.slice(sharedPrefix.length) } satisfies ClaimScope;
    return {
      claims: accounts.claims,
      plans: accounts.plans,
      name,
      scope: claimScope,
      notice: (nodes?: string[]) => projectChanged(roomRef({ workspace: workspace.id, id }, owner), accounts, claimScope, nodes),
      usage: () => usageScope(owner, workspace),
    };
  });
  app.route("/api", claimRoutes(projectWriteAccess, telemetry));
  app.route("/api", planRoutes(projectWriteAccess && ((c) => projectWriteAccess(c, true)), telemetry));
  // wg doctor uses status. wg wake uses project presence.
  const coordinatorReads = [/^\/api\/status$/, /^\/api\/projects\/[^/]+\/presence$/];
  const linkMember = (entry: SharedWorkspace, account: Tenant): LinkMember => ({
    account: account.id, name: account.human, workspace: entry.id, ownerName: entry.owner.human,
  });
  const sharedScope = new AsyncLocalStorage<SharedWorkspace & { member: LinkMember; coordinator?: boolean }>();
  const sharedEntry = (entry: SharedWorkspace) => ({
    id: entry.id, name: entry.name, owner: entry.owner.human, role: entry.role, projectId: entry.projectId,
  });
  const sharedFor = (tenant: Tenant) => {
    const selected = sharedScope.getStore();
    return selected ? Promise.resolve([selected]) : directory.sharedWorkspaces?.(tenant.id) ?? Promise.resolve([]);
  };
  const unknownWorkspace = (id: string) => ({ error: `workspace ${id} is not configured` });
  const isAgentReply = (path: string) => /^\/api\/projects\/[^/]+\/agents\/[^/]+\/reply\/?$/.test(path);
  app.use(async (c, next) => {
    const id = c.req.header("x-workspace");
    if (!directory.sharedWorkspaces || !id?.startsWith("shared:")) return next();
    const header = (name: string) => c.req.header(name);
    const host = refusal("GET", header, rules);
    if (host) return c.json({ error: host }, 403);
    const lookupRevision = revision;
    const read = c.req.method === "GET" || c.req.method === "HEAD";
    const authorization = header("authorization");
    const coordinator = !!authorization && c.req.method === "GET"
      && (c.req.path === "/api/status" || /^\/api\/projects\/[^/]+\/presence$/.test(c.req.path));
    const session = authorization ? null : await readSession(c);
    const account = coordinator ? await directory.fromToken(authorization)
      : session && await sessionActive(session, read) ? (await directory.fromSession(session))?.tenant : null;
    const entry = account && (await directory.sharedWorkspaces(account.id)).find((workspace) => workspace.id === id);
    if (!account || !entry || lookupRevision !== revision) return c.json(unknownWorkspace(id), 400);
    if (coordinator && entry.role !== "collaborator") return c.json({ error: "Only collaborators can connect a coordinator." }, 403);
    if (c.req.method === "POST" && isAgentReply(c.req.path)) return c.json({ error: "Only the project owner can reply to agents" }, 403);
    if (!read && (readOnly || entry.role === "viewer")) return c.json({ error: "this page is read-only" }, 405);
    const reason = refusal(c.req.method, header, rules);
    if (reason) return c.json({ error: reason }, 403);
    const method = read ? "GET" : c.req.method;
    const route = matchedRoutes(c).find((route) => route.method === method && sharedRoutes[`${method} ${route.path}`]);
    const access = route && sharedRoutes[`${method} ${route.path}`];
    const missing = () => c.json({ error: "Route not found in the shared project" }, 404);
    if (!route || !access || access === "denied") return missing();
    const project = c.req.path.split("/")[3];
    if (route.path.startsWith("/api/projects/:id") && project !== entry.projectId) return missing();
    if (header("x-project") && header("x-project") !== entry.projectId) return missing();
    if (access === "owner") return c.json({ error: "Only the project owner can change project settings or manage members." }, 403);
    if (redis && !read) {
      await redis.checkWrites();
      await flushLogouts();
    }
    const writer = account.workspaces.find((w) => w.organizationId === entry.workspace.organizationId && !w.needsKey);
    await dropIdle(entry.owner.id);
    await runInTenant(entry.owner, () => linearWorkspace.run(entry.workspace, () =>
      sharedScope.run({ ...entry, member: linkMember(entry, account), coordinator }, () => sharedLinear.run({ projectId: entry.projectId, writer }, next))), lookupRevision);
  });
  if (!accountStore) {
    const missing = (c: Context) => c.json({ error: "Project access not found" }, 404);
    app.get("/api/projects/:id/access", missing);
    app.post("/api/projects/:id/access/request", missing);
    app.post("/api/projects/:id/members/:member/access", missing);
  }
  const creationEnabled = process.env.WG_CREATE_PROJECTS === "1";
  const api = new Hono<{ Variables: { viewer: boolean; creationActor?: string } }>();
  // The API can change Linear with the user's key. Accept only this page as the caller.
  api.use(async (c, next) => {
    const shared = sharedScope.getStore();
    if (shared) {
      c.set("viewer", readOnly || shared.role === "viewer");
      return next();
    }
    const header = (name: string) => c.req.header(name);
    const host = refusal("GET", header, rules);
    if (host) return c.json({ error: host }, 403);
    const method = c.req.method;
    const read = method === "GET" || method === "HEAD";
    const signed = await readSession(c);
    const session = signed && await sessionActive(signed, read) ? signed : null;
    if (redis && !read && !readOnly) {
      await redis.checkWrites();
      await flushLogouts();
    }
    const lookupRevision = revision;
    const membership = await directory.fromSession(session);
    if (tenants && membership) checkLinkTenant(membership.tenant.id);
    const role = membership?.role ?? null;
    const viewer = readOnly || role === "viewer";
    if (creationEnabled && !viewer && membership?.role === "owner" && session) {
      c.set("creationActor", JSON.stringify([membership.tenant.id, session.accountId ?? session.email]));
    }
    if (viewer && method === "POST" && isAgentReply(c.req.path)) return c.json({ error: "Only the project owner can reply to agents" }, 403);
    if (viewer && method !== "GET" && method !== "HEAD") return c.json({ error: "this page is read-only" }, 405);
    const reason = refusal(method, header, rules);
    if (reason) return c.json({ error: reason }, 403);
    if (c.req.path === "/api/config" && (method === "GET" || method === "HEAD")) {
      const tenant = membership?.tenant ?? (!tenants ? await directory.byId(CONFIG_TENANT_ID) : null);
      const site = tenant ? siteOf(tenant) : createSite(DEFAULT_HUMAN, "default");
      const disconnected = !!linearAuth && !!tenant?.workspaces.find((w) => w.kind === "oauth")?.needsKey;
      if (membership) {
        await dropIdle(membership.tenant.id);
        const state = states.get(membership.tenant.id);
        if (state) state.lastUsed = clock();
      }
      return c.json<SiteConfig & { createProjects?: boolean; linkStore?: ServerStatus["linkStore"] }>({
        ...(c.var.creationActor && !disconnected && tenant?.workspaces.some(w => w.key && w.team && !w.needsKey)
          ? { createProjects: true } : {}),
        human: site.human, defaultWorkspace: site.defaultWorkspace, contract, version, telemetry: !!telemetry,
        readOnly: viewer, auth: !!(auth || linearAuth), user: membership && !disconnected ? session?.email ?? null : null,
        role: disconnected ? null : role, ...(linearAuth ? { signIn: "linear" as const } : {}),
        linkStore: readOnly ? undefined : redis ? "redis" : "memory",
        link: linkEnabled && role && !disconnected ? "/api/link" : null,
      });
    }
    const tokenTenant = method === "GET" && (readOnly || coordinatorReads.some((route) => route.test(c.req.path)))
      ? await directory.fromToken(header("authorization")) : null;
    const tenant = tokenTenant ?? membership?.tenant;
    if (!tenant) return c.json({ error: "sign in", login: LOGIN_PATH }, 401);
    if (tenants && tokenTenant) { checkLinkTenant(tokenTenant.id); firstConnection(tokenTenant); }
    const listsWorkspaces = read && /^\/api\/(status|projects|overview)$/.test(c.req.path);
    const selected = listsWorkspaces ? undefined : header("x-workspace");
    const id = selected || tenant.workspaces[0]?.id;
    const workspace = tenant.workspaces.find((w) => w.id === id);
    if (viewer && !tokenTenant && !listsWorkspaces && workspace?.rejectApiKey) return c.json({ error: "Workspace not found" }, 404);
    if (workspace?.needsKey) throw new LinearSignInRequired();
    if (!workspace && (selected || !listsWorkspaces)) {
      return c.json({ error: `workspace ${id ?? "default"} is not configured` }, 400);
    }
    c.set("viewer", tenants && tokenTenant ? readOnly : viewer);
    await dropIdle(tenant.id);
    await runInTenant(tenant, () => workspace ? linearWorkspace.run(workspace, next) : next(), lookupRevision);
  });
  // The state of the server for a check: counts and the Linear budget only, never a key, issue text, or message body.
  api.get("/status", async (c) => {
    const { tenant, state } = scope();
    const shared = sharedScope.getStore();
    if (shared) {
      const ref = currentRoom({ workspace: shared.workspace.id, id: shared.projectId });
      const room = await linkRead(() => roomState.read(ref), null);
      const own = room && !c.var.viewer ? roomAccount(room, shared.member.account) : undefined;
      return c.json({
        version, contract, human: shared.member.name, readOnly: c.var.viewer, link: null,
        workspaces: [sharedEntry(shared)],
        rooms: room ? [{
          workspace: shared.id, project: shared.projectId,
          coordinators: roomAccounts(room).flatMap(([, account]) => [...account.coordinators.values()]).filter((entry) => entry.socket).length,
          pages: [...room.sockets.values()].filter((role) => role === "page").length,
          queued: own?.queue.length ?? 0,
          asks: own?.asks.length ?? 0,
        }] : [],
      });
    }
    const entries = await sharedFor(tenant);
    const rooms = (redis && (readOnly || !redis.ready)) || (!readOnly && c.var.viewer)
      ? [] : await linkRead(() => hub.counts(tenants ? tenant.id : undefined), []);
    return c.json<ServerStatus & Pick<SiteConfig, "readOnly" | "link">>({
      version, contract, human: tenant.human, uptime: Math.floor((clock() - started) / 1000),
      readOnly: c.var.viewer, link: linkEnabled ? "/api/link" : null,
      workspaces: [
        ...tenant.workspaces.map(({ id, name }) => ({ id, name, workspaceId: id })),
        ...entries.map((entry) => ({ ...sharedEntry(entry), workspaceId: entry.id })),
      ].map(({ workspaceId, ...entry }) => {
        const budget = linearBudget(workspaceId);
        return { ...entry, requestsRemaining: budget?.requestsRemaining ?? null, requestsLimit: budget?.requestsLimit ?? null,
          requestsReset: budget?.requestsReset ?? null, complexityRemaining: budget?.complexityRemaining ?? null,
          complexityReset: budget?.complexityReset ?? null, at: budget?.at ?? null };
      }),
      cache: !readOnly && c.var.viewer ? 0 : [...state.graphs.values()].reduce((sum, cache) => sum + cache.size(), 0),
      rooms, linkStore: redis ? "redis" : "memory", redisReady: redis?.ready ?? null,
    });
  });
  api.use(bodyLimit({ maxSize: 2_000_000, onError: (c) => c.json({ error: "request body too large" }, 413) }));
  const projectList = async (viewer = false): Promise<ProjectList> => {
    const { tenant, state: { lists, sharedNames } } = scope();
    const workspaces = viewer ? tenant.workspaces.filter((workspace) => !workspace.rejectApiKey) : tenant.workspaces;
    const order = ++lists.started;
    const results = await Promise.allSettled(workspaces.map((workspace) =>
      linearWorkspace.run(workspace, () => workspace.kind && !workspace.team ? Promise.resolve([]) : listProjects(workspace.team)),
    ));
    const refused = results.find((result) => result.status === "rejected" && result.reason instanceof LinearSignInRequired);
    if (refused?.status === "rejected") throw refused.reason;
    const list: ProjectList = {
      workspaces: workspaces.flatMap(({ id, name, shareUrl }, at) => {
        const result = results[at];
        if (result.status === "rejected" && result.reason instanceof LinearKeyRequired) return [];
        const address = shareUrl ?? (auth && !readOnly ? `https://${rules.hosted!.host}` : undefined);
        return [{
          id, name, ...(address ? { shareUrl: address } : {}),
          ...(result.status === "fulfilled" ? {} : { error: `${name} is unavailable. Reload to try again.` }),
        }];
      }),
      // The viewer has only the projects that their owner shared (the project label `shared`).
      projects: results.flatMap((result, at) => result.status === "fulfilled"
        ? result.value.map((p) => ({ ...p, workspace: workspaces[at].id, workspaceName: workspaces[at].name }))
        : []),
    };
    const privateIds = new Set(workspaces.filter((workspace) => workspace.rejectApiKey).map(({ id }) => id));
    const shared = { ...list, workspaces: list.workspaces.filter(({ id }) => !privateIds.has(id)),
      projects: list.projects.filter((p) => p.shared && !privateIds.has(p.workspace)) };
    // A slower list that started earlier cannot restore a share removed from the newer list.
    if ((tenants || auth || readOnly) && order > lists.stored) {
      lists.stored = order;
      sharedNames.list = shared;
      sharedNames.at = Date.now();
    }
    return viewer ? shared : list;
  };
  const listedProjects = async (viewer: boolean): Promise<ProjectList> => {
    const { tenant } = scope();
    const scoped = sharedScope.getStore();
    const list = scoped ? { workspaces: [], projects: [] } : await projectList(viewer);
    const shared = await sharedFor(tenant);
    const projects = await Promise.all(shared.map(async (entry) => {
      const read = () => gql("query($id:String!){project(id:$id){id name url status{name type}}}", { id: entry.projectId });
      const data = scoped ? await read() : await runInTenant(entry.owner, () => linearWorkspace.run(entry.workspace, read)).catch(() => null);
      const project = data?.project;
      return project?.id === entry.projectId && typeof project.name === "string" ? {
        id: entry.projectId, name: project.name, url: project.url ?? "", status: project.status?.name ?? "",
        statusType: project.status?.type ?? "", workspace: entry.id, workspaceName: entry.name,
      } : null;
    }));
    return { workspaces: [...list.workspaces, ...shared.map(sharedEntry)],
      projects: [...list.projects, ...projects.filter((project) => project !== null)] };
  };
  api.get("/project-creation/teams", async (c) => {
    if (!c.var.creationActor) return c.json({ error: "Project creation requires an enabled owner session" }, 403);
    const workspace = linearWorkspace.getStore()!;
    if (c.req.header("x-workspace") !== workspace.id) return c.json({ error: "Select a workspace" }, 400);
    const team = await starterTeam(workspace);
    return c.json({ teams: team ? [{ key: team.key, name: team.name }] : [] });
  });
  api.post("/projects", async (c) => {
    const actor = c.var.creationActor;
    if (!actor) return c.json({ error: "Project creation requires an enabled owner session" }, 403);
    const workspace = linearWorkspace.getStore()!;
    if (c.req.header("x-workspace") !== workspace.id) return c.json({ error: "Select a workspace" }, 400);
    const key = c.req.header("idempotency-key");
    const input = creationInput(await c.req.json().catch(() => null), workspace, key);
    const team = await starterTeam(workspace);
    if (!team) return c.json({ error: "Team is unavailable for creation" }, 403);
    const accounts = await accountStore?.();
    if (accountStore && (!accounts || !workspace.connectionId)) return c.json({ error: "Plan storage unavailable" }, 503);
    const data = await createStarter(workspace, team, input, actor, key!);
    const project = data.keymap.project;
    if (accounts && workspace.connectionId) {
      const tenant = scope().tenant.id;
      const result = await accounts.plans({ account: tenant, project: [tenant, workspace.connectionId, project.id] },
        { kind: "put", initialize: true, data });
      if (result.status !== 200 && result.status !== 412) throw new LinearError("Could not save the project plan", 503);
      const collab = { page: `https://${rules.hosted!.host}`, workspace: workspace.id, project: project.id, name: input.name };
      return c.json({ workspace: workspace.id, project, handoff: { plan: data.plan,
        keymap: { ...data.keymap, collab }, command: "wg pull . --force && wg next ." } });
    }
    return c.json({ workspace: workspace.id, project, handoff: { ...data, command: "wg next ." } }, 200);
  });
  api.get("/projects", async (c) => c.json<ProjectList>(await listedProjects(c.var.viewer)));
  const waitNamesFor = async (owner: Tenant, workspace: Workspace, id: string) => {
    const connection = workspace.connectionId;
    if (connection) return (await accountStore?.())?.shares.waitNames([owner.id, connection, id]);
  };

  // The projects with a summary of each open one. The graphs come from the same cache as the graph
  // route, a few at a time, so a poll of the overview costs about one cheap check for each project.
  api.get("/overview", async (c) => {
    const { workspaces } = scope().tenant;
    const viewer = c.var.viewer;
    const list = await listedProjects(viewer);
    const shared = await sharedFor(scope().tenant);
    const open = list.projects.filter((p) => p.statusType !== "completed" && p.statusType !== "canceled");
    await checkAll(open);
    const summaries: ProjectSummary[] = [];
    const human = sharedScope.getStore()?.member.name ?? serverSite().human;
    let next = 0;
    const worker = async () => {
      while (next < open.length) {
        const p = open[next++];
        const entry = shared.find((candidate) => candidate.id === p.workspace);
        const workspace = entry?.workspace ?? workspaces.find((w) => w.id === p.workspace)!;
        try {
          // The viewer takes no older graph when Linear fails (see the graph route).
          const read = () => linearWorkspace.run(workspace, () => graphs().get(p.id, { fresh: viewer || !!entry }));
          const { data } = entry ? await runInTenant(entry.owner, read) : await read();
          const waitNames = await waitNamesFor(entry?.owner ?? scope().tenant, workspace, p.id);
          const summarizeProject = () => summarize(shown(data, viewer || !!entry), p.workspace);
          summaries.push(waitNames ? requestSite.run({ ...serverSite(), human, waitNames }, summarizeProject) : summarizeProject());
        } catch (error) {
          summaries.push({ workspace: p.workspace, id: p.id, planned: 0, done: 0, counts: [], you: [], running: 0, review: 0, ready: 0,
            effort: null, freshness: null, updatedAt: null, error: (error as Error).message });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(OVERVIEW_LOADS, open.length) }, worker));
    return c.json<OverviewData>({ ...list, summaries });
  });
  /**
   * The viewer: the request may read this project only when its owner shared it. The list is at most 60 s old, so a
   * project that lost the label goes away in that time. A project that is not in the list makes the server read the
   * list again, at most each 5 s: a new share works in that time, and a wrong id cannot use up the Linear budget.
   * When Linear does not give the list, the answer is 503 and no older list counts: the server gives a project only
   * while it knows that the project is shared. Each server process has its own list.
   */
  const sharedProject = async (id: string | undefined, workspace = linearWorkspace.getStore()!.id): Promise<string> => {
    const { state } = scope();
    const { sharedNames } = state;
    const find = () => sharedNames.list?.projects.find((p) => p.workspace === workspace && p.id === id);
    if (id && Date.now() - sharedNames.at > (find() ? 60_000 : 5_000)) {
      state.sharedRefresh ??= projectList().finally(() => { state.sharedRefresh = undefined; });
      await state.sharedRefresh;
    }
    if (sharedNames.list?.workspaces.find((w) => w.id === workspace)?.error) throw new LinearError("Linear did not confirm that this project is shared. Try again.", 503);
    if (!id || !find()) throw new LinearError("no shared project with this id", 404);
    return id;
  };
  // `?have=<version>`: the page has this version already. Then the answer has no body, except while the graph is stale.
  api.get("/projects/:id/graph", async (c) => {
    const viewer = c.var.viewer;
    const shared = sharedScope.getStore();
    if (viewer && !shared) await sharedProject(c.req.param("id"));
    // A stale graph (the refresh failed) also carries `stale`, the error, and its load time, so the page can show them.
    // The viewer gets the error of the refresh in its place: an issue of the older graph can be in another project
    // now. A graph in memory can still have an issue that left the project, until its full reload (`FULL_MS`):
    // the check for changes does not see an issue that is in the project no more.
    const { data, version: graphVersion, stale, error, loadedAt } = await graphs().get(c.req.param("id"), { fresh: viewer || !!shared });
    const waitNames = await waitNamesFor(scope().tenant, linearWorkspace.getStore()!, c.req.param("id"));
    const version = waitNames ? `${graphVersion}:${createHash("sha256").update(JSON.stringify(waitNames)).digest("hex")}` : graphVersion;
    if (!stale && c.req.query("have") === version) return c.body(null, 204);
    return c.json({ ...shown(data, viewer || !!shared), ...(waitNames && { waitNames }), version, workspace: shared?.id ?? linearWorkspace.getStore()!.id, ...(stale ? { stale, error, loadedAt } : {}) });
  });
  api.post("/projects/:id/agents/:agent/reply", async (c) => {
    const input = await json(c.req.json<{ body?: unknown } | null>());
    const body = input?.body;
    if (typeof body !== "string" || !body.trim() || [...body].length > 4000) {
      return c.json({ error: "Reply text must contain 1 to 4000 characters" }, 400);
    }
    const ref = currentRoom({ workspace: linearWorkspace.getStore()!.id, id: c.req.param("id") });
    const reply = await hub.queueAgentReply(ref, c.req.param("agent"), body);
    return reply.status === 202 ? c.json({ id: reply.id }, 202) : c.json({ error: reply.error }, reply.status);
  });
  api.post("/projects/:id/close", async (c) => {
    const { confirm } = await json(c.req.json<{ confirm?: unknown }>());
    try {
      return c.json(await closeProject(c.req.param("id"), confirm, linearWorkspace.getStore()!.team));
    } finally {
      // A failed closeout can still have completed some issues.
      await wrote(null, c.req.param("id"));
    }
  });
  // A command for the coordinator: run `wg next` now, dispatch a node, pause or resume the effort. A
  // dispatch is also a comment on the node's issue; a pause or resume sets the project label `paused` first,
  // so it holds when this server restarts. `next` changes nothing in Linear.
  api.post("/projects/:id/commands", async (c) => {
    const { name, key, issue } = await json(c.req.json<{ name?: unknown; key?: unknown; issue?: unknown }>());
    if (name !== "next" && name !== "dispatch" && name !== "pause" && name !== "resume") throw new LinearError("name must be next, dispatch, pause, or resume", 400);
    if (sharedScope.getStore() && (name === "pause" || name === "resume")) {
      throw new LinearError("Only the project owner can pause or resume this project.", 403);
    }
    const ref = { workspace: linearWorkspace.getStore()!.id, id: c.req.param("id") };
    let identifier: string | null = null;
    if (name === "dispatch") {
      if (typeof key !== "string" || typeof issue !== "string") throw new LinearError("dispatch names the node key and its issue", 400);
      // Which issues are in the project decides the write: a stale graph is not enough.
      const found = (await graphs().get(ref.id, { fresh: true })).data.issues.find((i) => i.identifier === issue);
      if (!found || (sharedScope.getStore() && (found.external || parseCard(found.card?.body)?.key !== key))) throw new LinearError(`no issue ${issue} in this project`, 404);
      const written = projectOfWrite();
      await addComment(found.id, "**Dispatch requested** on the page. The coordinator dispatches it at its next `wg next`.", linearWorkspace.getStore()!.team, written.hear);
      await wrote(null, written.id);
      identifier = found.identifier;
    }
    if (name === "pause" || name === "resume") {
      const workspace = linearWorkspace.getStore()!;
      await setPaused(ref.id, name === "pause", workspace.team, workspace.teamLabels);
      scope().state.names.at = 0;
      await wrote(null, ref.id);
    }
    const enqueue = () => enqueueLink(ref, "command", { name, key: typeof key === "string" ? key : null, issue: identifier },
      undefined, noticeId(c.req.header("Idempotency-Key"), name), sharedScope.getStore()?.member);
    const result = name === "next" ? await enqueue() : await notify(enqueue, { queued: 0, waiting: false });
    return c.json({ ok: true, queued: result.queued, ...(result.waiting ? { waiting: true } : {}) });
  });
  // The link state of a project, for `wg wake` on the human's machine: is a coordinator connected, and do messages
  // wait that only a coordinator can act on. A GET, so the host check above is the only gate; it changes nothing.
  api.get("/projects/:id/presence", async (c) => {
    const ref = { workspace: linearWorkspace.getStore()!.id, id: c.req.param("id") };
    const shared = sharedScope.getStore();
    if (c.var.viewer && (!readOnly || shared)) {
      if (!shared) await sharedProject(ref.id, ref.workspace);
      return c.json({ ...await linkRead(() => hub.viewerPresence(currentRoom(ref)), { coordinators: [], queued: 0 }), waiting: 0 });
    }
    const presence = await linkRead(async () => ({ ...await hub.presence(currentRoom(ref), shared?.member.account), waiting: await hub.waiting(currentRoom(ref), shared?.member.account) }), {
      coordinators: [], queued: 0, waiting: 0,
    });
    if (!shared || shared.coordinator) return c.json(presence);
    const asks = await linkRead(async () => await hub.asks(currentRoom(ref)), []);
    if (!asks.length) return c.json({ ...presence, asks });
    const { data } = await graphs().get(ref.id, { fresh: true });
    const issues = new Set(data.issues.filter((issue) => !issue.external).map((issue) => issue.identifier));
    return c.json({ ...presence, asks: asks.filter((ask) => !ask.issue || issues.has(ask.issue)) });
  });
  // The autonomy level of the effort (work-graph SKILL.md "Autonomy level"). The project label is the record;
  // the command wakes the coordinator, whose `wg next` reads the label and prints `do autonomy`.
  api.post("/projects/:id/autonomy", async (c) => {
    const { level } = await json(c.req.json<{ level?: unknown }>());
    if (!isAutonomy(level)) throw new LinearError("level must be full, standard, or supervised", 400);
    const workspace = linearWorkspace.getStore()!;
    const ref = { workspace: workspace.id, id: c.req.param("id") };
    await setAutonomy(ref.id, level, workspace.team, workspace.teamLabels);
    scope().state.names.at = 0;
    await wrote(null, ref.id);
    const { queued } = await notify(() => enqueueLink(ref, "command", { name: "autonomy", key: null, issue: null, level },
      undefined, noticeId(c.req.header("Idempotency-Key"), "autonomy")), { queued: 0 });
    return c.json({ ok: true, level, queued });
  });
  // The review effort of the effort (work-graph review-and-merge.md "Review effort"). The project label is the
  // record; the command `next` wakes the coordinator, whose `wg next` reads the label and prints `do review`.
  api.post("/projects/:id/review-effort", async (c) => {
    const { level } = await json(c.req.json<{ level?: unknown }>());
    if (!isReviewEffort(level)) throw new LinearError("level must be thorough, standard, or light", 400);
    const workspace = linearWorkspace.getStore()!;
    const ref = { workspace: workspace.id, id: c.req.param("id") };
    await setReviewEffort(ref.id, level, workspace.team, workspace.teamLabels);
    scope().state.names.at = 0;
    await wrote(null, ref.id);
    const { queued } = await notify(() => enqueueLink(ref, "command", { name: "next", key: null, issue: null },
      undefined, noticeId(c.req.header("Idempotency-Key"), "review-effort")), { queued: 0 });
    return c.json({ ok: true, level, queued });
  });
  // Share a project with the read-only viewer, or stop that. The project label `shared` is the record: the viewer
  // reads it from Linear. No coordinator acts on it.
  api.post("/projects/:id/share", async (c) => {
    const { shared } = await json(c.req.json<{ shared?: unknown }>());
    if (typeof shared !== "boolean") throw new LinearError("shared must be true or false", 400);
    const workspace = linearWorkspace.getStore()!;
    if (workspace.rejectApiKey) throw new LinearError("Projects in an attached workspace are private", 403);
    await setShared(c.req.param("id"), shared, workspace.team, workspace.teamLabels);
    const { names, sharedNames, lists } = scope().state;
    names.at = 0;
    // A viewer can get 404 while the list is empty, until the next list confirms the share.
    sharedNames.at = 0;
    sharedNames.list = null;
    lists.stored = lists.started;
    await wrote(null, c.req.param("id"));
    return c.json({ ok: true, shared });
  });
  // The human's reply to a worker's question (an Orca ask that the coordinator reported). The reply is a
  // comment on the worker's issue at once; the coordinator sends it to the worker at its next `wg next`.
  api.post("/projects/:id/asks/:ask/reply", async (c) => {
    const { body } = await json(c.req.json<{ body?: unknown }>());
    if (typeof body !== "string" || !body.trim()) throw new LinearError("reply body is empty", 400);
    const ref = { workspace: linearWorkspace.getStore()!.id, id: c.req.param("id") };
    const ask = linkEnabled ? await hub.ask(currentRoom(ref), c.req.param("ask")) : null;
    if (!ask) throw new LinearError(tenants
      ? "No open question with this id. It may have been answered, or its coordinator may have left the project."
      : "no open question with this id: it was answered, or the coordinator has not reported it", 404);
    // Which issues are in the project decides whether the reply is saved in Linear: a stale graph is not enough.
    // A failed refresh stops the route here, and the question stays open.
    const issue = ask.issue ? (await graphs().get(ref.id, { fresh: true })).data.issues.find((i) => i.identifier === ask.issue) : undefined;
    if (sharedScope.getStore() && ask.issue && (!issue || issue.external)) {
      throw new LinearError("no issue with this id in the shared project", 404);
    }
    if (issue) {
      const quote = ask.body.split("\n").map((line) => `> ${line}`).join("\n");
      const written = projectOfWrite();
      await addComment(issue.id, `**Reply to a worker question** (from the page)\n\n${quote}\n\n${body.trim()}`, linearWorkspace.getStore()!.team, written.hear);
      await wrote(null, written.id);
    }
    const enqueue = () => hub.enqueue(currentRoom(ref), "reply", { ask: ask.id, issue: ask.issue, key: ask.key, body: body.trim() }, ask.id,
      noticeId(c.req.header("Idempotency-Key"), "ask:" + ask.id));
    if (issue) await notify(enqueue, undefined);
    else await enqueue();
    return c.json({ ok: true, recorded: !!issue });
  });
  api.patch("/issues/:id", async (c) => {
    const patch = await json(c.req.json<IssuePatch>());
    if (sharedScope.getStore() && (!patch || typeof patch !== "object" || Object.keys(patch).some((key) => !["stateId", "labelIds", "note"].includes(key)))) {
      throw new LinearError("Members can change issue status and labels.", 403);
    }
    const ref = pageProject((name) => c.req.header(name));
    const written = projectOfWrite();
    const issue = await wrote(await updateIssue(c.req.param("id"), patch, linearWorkspace.getStore()!.team, written.hear), written.id);
    const what: Changed["what"] = patch.stateId ? "status" : patch.labelIds ? "label" : "issue";
    await pageChanged(ref, what, [issue.identifier], noticeId(c.req.header("Idempotency-Key"), "issue:" + c.req.param("id")));
    return c.json(issue);
  });
  api.get("/issues/:id/comments", async (c) => {
    // The viewer reads the comments of an issue only through its shared project (`x-project`). Linear says in the
    // same answer which project the issue is in now: an issue that moved to another project gives 404.
    const shared = sharedScope.getStore();
    if (shared) return c.json(await listComments(c.req.param("id"), shared.projectId));
    if (c.var.viewer) return c.json(await listComments(c.req.param("id"), await sharedProject(c.req.header("x-project"))));
    return c.json(await listComments(c.req.param("id")));
  });
  api.post("/issues/:id/comments", async (c) => {
    const { body } = await json(c.req.json<{ body?: unknown }>());
    const ref = pageProject((name) => c.req.header(name));
    const info = ref ? await issueInfo(ref, c.req.param("id")) : null;
    const written = projectOfWrite();
    const comment = await wrote(await addComment(c.req.param("id"), body, linearWorkspace.getStore()!.team, written.hear), written.id);
    await pageChanged(ref, "comment", [info?.identifier ?? c.req.param("id")], noticeId(c.req.header("Idempotency-Key"), "comment:" + c.req.param("id")));
    // A comment in the page on an issue that waits on the human is their answer: the label `answered` marks it
    // in Linear (wg next finds it there after a restart), and the message wakes the coordinator at once.
    // The comment is saved before the label: when the label fails, the answer is still 200. A retry from
    // the page would write a second comment, so the coordinator gets the message, and `answered: false`
    // tells the page that the label is missing.
    if (ref && info?.status === serverSite().waitStatus) {
      let answered = true;
      try {
        await markAnswered(c.req.param("id"));
      } catch (error) {
        answered = false;
        console.warn(`wg ui: comment saved, but the answered label failed: ${(error as Error).message}`);
      }
      await wrote(null, written.id);
      await notify(() => enqueueLink(ref, "answer", { issue: info.identifier, key: info.key, body: comment.body },
        undefined, noticeId(c.req.header("Idempotency-Key"), "answer:" + c.req.param("id"))), undefined);
      return c.json({ ...comment, answered });
    }
    return c.json(comment);
  });
  api.all("*", (c) => c.json({ error: `no route ${c.req.method} ${c.req.path}` }, 404));
  // The link (src/lib/link.ts): `?role=page|coordinator&workspace=<id>&project=<id or name>`. A page
  // with no project is the overview. Each coordinator of each project has its own connection.
  const resolve = async (workspace: string, wanted: string): Promise<Project | null> => {
    const { names } = scope().state;
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
    if (!linkEnabled) return c.json({ error: "this page has no link" }, 404);
    const role = c.req.query("role") ?? "";
    const reason = linkRefusal(role, (name) => c.req.header(name), rules);
    if (reason) return c.json({ error: reason }, 403);
    const lookupRevision = revision;
    const tokenTenant = role === "coordinator" && requiresLinkToken ? await directory.fromToken(c.req.header("authorization")) : null;
    if (role === "coordinator" && requiresLinkToken && !tokenTenant) {
      return c.json({ error: "coordinator token required" }, 401);
    }
    const restarting = () => c.json({ error: "the server restarts" }, 503);
    if (hub.closing) return restarting();
    if (redis) { await redis.checkWrites(); await flushLogouts(); }
    const session = role === "page" ? await readSession(c) : null;
    if ((auth || linearAuth || tenants) && role === "page" && (!session || !await sessionActive(session))) return c.json({ error: "sign in", login: LOGIN_PATH }, 401);
    const membership = role === "page" ? await directory.fromSession(session) : null;
    const account = tokenTenant ?? membership?.tenant ?? (!tenants ? await directory.byId(CONFIG_TENANT_ID) : null);
    if (!account) return c.json({ error: "sign in", login: LOGIN_PATH }, 401);
    const requested = c.req.query("workspace") || siteOf(account).defaultWorkspace;
    const shared = directory.sharedWorkspaces && requested.startsWith("shared:")
      ? (await directory.sharedWorkspaces(account.id)).find((entry) => entry.id === requested) : undefined;
    if (directory.sharedWorkspaces && requested.startsWith("shared:") && !shared) return c.json(unknownWorkspace(requested), 400);
    if (shared?.role === "viewer" && role === "coordinator") return c.json({ error: "Only collaborators can connect a coordinator." }, 403);
    const tenant = shared?.owner ?? account;
    if (tenants) checkLinkTenant(tenant.id);
    const viewer = shared ? shared.role === "viewer" : membership?.role === "viewer";
    const workspace = shared?.workspace.id ?? requested;
    const selected = shared?.workspace ?? tenant.workspaces.find((w) => w.id === workspace);
    if (viewer && selected?.rejectApiKey) return c.json({ error: "Workspace not found" }, 404);
    if (selected?.needsKey) throw new LinearSignInRequired();
    if (!selected) return c.json({ error: `workspace ${workspace} is not configured` }, 400);
    const wanted = c.req.query("project");
    if (!wanted && (role === "coordinator" || shared)) return c.json({ error: role === "coordinator" ? "a coordinator names its project" : "this link names its project" }, 400);
    await dropIdle(tenant.id);
    const id = shared ? (wanted === shared.projectId || wanted?.toLowerCase() === shared.name.toLowerCase() ? shared.projectId : null)
      : await runInTenant(tenant, () => linearWorkspace.run(selected, async () =>
        wanted ? viewer ? await sharedProject(wanted, workspace) : (await resolve(workspace, wanted))?.id : null), lookupRevision);
    if (wanted && !id) return c.json({ error: `no project "${wanted}" in ${requested}` }, 404);
    c.set("linkMember" as never, (shared ? linkMember(shared, account) : undefined) as never);
    if (redis) await redis.waitReady();
    if (hub.closing || lookupRevision !== revision) return restarting();
    c.set("linkRef" as never, (id ? roomRef({ workspace, id }, tenant) : null) as never);
    c.set("linkTenant" as never, tenant as never);
    c.set("linkRevision" as never, lookupRevision as never);
    c.set("linkViewer" as never, viewer as never);
    c.set("linkSession" as never, session as never);
    return next();
  }, upgradeWebSocket((c) => {
    const ref = c.get("linkRef" as never) as RoomRef | null;
    const tenant = c.get("linkTenant" as never) as Tenant;
    const lookupRevision = c.get("linkRevision" as never) as number;
    const tenantId = tenants ? tenant.id : undefined;
    const inSocket = <T>(run: () => T) => requestSite.run(siteOf(tenant), run);
    const member = c.get("linkMember" as never) as LinkMember | undefined;
    const account = member?.account ?? tenant.id;
    const current = () => !tenantChangedSince(tenant.id, lookupRevision) && !tenantChangedSince(account, lookupRevision);
    const currentToken = async () => !tenants || (await directory.fromToken(c.req.header("authorization")))?.id === account;
    const role = c.req.query("role");
    const resume = c.req.query("resume") === "1";
    const viewer = c.get("linkViewer" as never) as boolean;
    const session = c.get("linkSession" as never) as Session | null;
    const currentMember = async () => {
      if (!member) return true;
      const entry = (await directory.sharedWorkspaces!(account)).find((entry) => entry.id === member.workspace);
      return entry?.owner.id === tenant.id && entry.workspace.id === ref?.workspace
        && entry.projectId === ref.id && entry.role === (viewer ? "viewer" : "collaborator");
    };
    let connection: Connection | null = null;
    let pending: Promise<void> = Promise.resolve();
    const afterOpen = (action: () => Promise<void> | undefined) => {
      pending = pending.then(() => inSocket(action)).catch(reportLinkError);
    };
    return {
      onOpen: (_event, ws) => inSocket(() => {
        if (!current() || !linkAvailable()) return ws.close(RESTART_CODE, "server restart");
        // The raw socket of `ws` has the ping frames of the heartbeat, which WSContext does not have.
        const raw = ws.raw as import("ws").WebSocket;
        let permitted = true;
        const valid = () => permitted && (!session || clock() < session.expiresAt);
        const end = () => {
          permitted = false;
          ws.close(1008, "session ended");
        };
        const verify = async () => {
          if (!current()) {
            ws.close(RESTART_CODE, "server restart");
            return false;
          }
          if (valid() && (!session || await sessionActive(session))) {
            const membership = await directory.fromSession(session);
            if (membership?.tenant.id === account) {
              if (!member && membership.role === (viewer ? "viewer" : "owner")) return true;
              if (member) {
                if (await currentMember()) return true;
                ws.close(RESTART_CODE, "server restart");
                return false;
              }
            }
          }
          end();
          return false;
        };
        const unavailable = (error: unknown) => {
          permitted = false;
          reportLinkError(error);
          ws.close(error instanceof RedisUnavailable ? RESTART_CODE : 1011, "link unavailable");
        };
        const peer = {
          session: session?.id,
          send: (text: string) => { if (current() && valid()) ws.send(text); else if (current()) end(); },
          close: (code?: number, reason?: string) => ws.close(code, reason),
          ping: () => {
            if (session) void verify().then((active) => { if (active) raw.ping(); }).catch(unavailable);
            else if (member) void currentMember().then((active) => {
              if (active) raw.ping();
              else ws.close(RESTART_CODE, "server restart");
            }).catch(unavailable);
            else raw.ping();
          },
          terminate: () => raw.terminate(),
        };
        pending = runInTenant(tenant, async () => {
          if (role === "coordinator" && (!await currentToken() || !await currentMember())) return ws.close(RESTART_CODE, "server restart");
          if (session && !await verify()) return;
          if (!current() || !linkAvailable()) return ws.close(RESTART_CODE, "server restart");
          connection = role === "coordinator" ? await hub.joinCoordinator(peer, ref!, member)
            : viewer ? await hub.joinViewer(peer, ref, (project) => {
              if (member) return project.id === ref?.id && project.workspace === ref.workspace;
              const sharedNames = states.get(tenant.id)?.sharedNames;
              return !!sharedNames && Date.now() - sharedNames.at <= 60_000 && !!sharedNames.list?.projects.some(
                (p) => p.workspace === project.workspace && p.id === project.id);
            }, resume, tenantId, member)
            : await hub.joinPage(peer, ref, resume, tenantId, member);
          if (role === "coordinator" && current() && telemetry) {
            const selected = tenant.workspaces.find((workspace) => workspace.id === ref!.workspace);
            if (selected) telemetry.emit("coordinator_connected", {}, () => usageScope(tenant, selected), tenant.id,
              ({ workspace }) => firstToday(workspace.organization, ref!.id));
            firstConnection(tenant);
          }
          if (!current() || (member && lookupRevision !== revision && !await currentMember())) {
            ws.close(RESTART_CODE, "server restart");
            await connection.closed();
          }
        }, lookupRevision).catch(unavailable);
        raw.on("pong", () => inSocket(() => connection?.pong()));
        if (redis) raw.on("ping", () => inSocket(() => connection?.pong()));

      }),
      onMessage: (event, ws) => afterOpen(async () => {
        if (!current()) return;
        if (member && !await currentMember()) return ws.close(RESTART_CODE, "server restart");
        await connection?.receive(typeof event.data === "string" ? event.data : String(event.data));
      }),
      onClose: () => afterOpen(() => connection?.closed()),
    };
  }));
  if (accountStore) {
    const pageUrl = rules.hosted ? `https://${rules.hosted.host}` : `http://localhost:${rules.port}`;
    async function access(c: Context): Promise<ShareAccess | Response> {
      const reason = refusal(c.req.method, (name) => c.req.header(name), rules);
      if (reason) return c.json({ error: reason }, 403);
      const signed = await readSession(c);
      const read = c.req.method === "GET" || c.req.method === "HEAD";
      const session = signed && await sessionActive(signed, read) ? signed : null;
      const membership = session ? await directory.fromSession(session) : null;
      if (!session || !membership) return c.json({ error: "sign in", login: LOGIN_PATH }, 401);
      if (readOnly || membership.role !== "owner") return c.json({ error: "Account access requires the owner" }, 403);
      const accounts = await accountStore?.();
      if (!accounts) return c.json({ error: "Account service unavailable" }, 503);
      return { accounts, tenant: membership.tenant, session };
    }
    app.route("/api/account", accountRoutes({
      now: clock, redis: redis ?? undefined, prefix: linkPrefix ?? LINK_PREFIX,
      telemetry, pageUrl, access,
      async endSession(c, session) {
        await signOut(session);
        clearSessionCookie(c);
      },
    }));
    const runLinear = (tenant: Tenant, workspace: Workspace): InWorkspace => (run) =>
      runInTenant(tenant, () => sharedLinear.exit(() => linearWorkspace.run(workspace, run)));

    app.route("/api", memberAccessRoutes(async (c) => {
      const shared = sharedScope.getStore();
      if (!shared || shared.coordinator || shared.projectId !== c.req.param("id")) throw missingAccess();
      if (shared.role !== "collaborator") return c.json({ error: "Only collaborators need Linear access" }, 403);
      const accounts = await accountStore();
      if (!accounts) return c.json({ error: "Account service unavailable" }, 503);
      const tenant = await directory.byId(shared.member.account);
      const account = tenant && await accounts.readTenant(tenant.id);
      const connection = shared.workspace.connectionId;
      if (!tenant || !account || !connection) throw missingAccess();
      const writer = sharedLinear.getStore()?.writer;
      return {
        shares: accounts.shares,
        project: [shared.owner.id, connection, shared.projectId],
        membership: shared.id.slice("shared:".length),
        identity: account.user,
        workspace: shared.workspace,
        ownerRun: runLinear(shared.owner, shared.workspace),
        ownRun: writer && runLinear(tenant, writer),
        usage: () => usageScope(shared.owner, shared.workspace),
      };
    }, telemetry, clock));

    app.route("/api", shareRoutes({
      runLinear,
      access, pageUrl, telemetry,
      notice: (account, workspace, project, nodes) => projectChanged(
        roomRef({ workspace, id: project[2] }, account.tenant), account.accounts, { project, account: account.tenant.id }, nodes),
      limit: attemptLimit({ now: clock, redis: redis ?? undefined, prefix: linkPrefix ?? LINK_PREFIX }, "join-attempts:"),
      project: shareProject,
    }));
  } else {
    const missing = (c: Context) => c.json({ error: "Share route not found" }, 404);
    app.post("/api/join", missing);
    app.get("/api/projects/:id/share", missing);
    app.post("/api/projects/:id/share/:kind/rotate", missing);
    app.delete("/api/projects/:id/share/:kind", missing);
    app.patch("/api/projects/:id/members/:member", missing);
    app.delete("/api/projects/:id/members/:member", missing);
  }
  app.all("/api/account/*", (c) => c.json({ error: "Account route not found" }, 404));
  app.post("/api/events", bodyLimit({ maxSize: 1024 }), async (c) => {
    const reason = refusal(c.req.method, (name) => c.req.header(name), rules);
    if (reason) return c.json({ error: reason }, 403);
    const session = await readSession(c);
    const membership = session && await sessionActive(session) ? await directory.fromSession(session) : null;
    if (!session || !membership) return c.json({ error: "sign in", login: LOGIN_PATH }, 401);
    const body = await c.req.json<{ event?: unknown; workspace?: unknown }>().catch(() => null);
    if (typeof body?.event !== "string" || !Object.hasOwn(pageEvents, body.event) || typeof body.workspace !== "string") {
      return c.json({ error: "Invalid usage event" }, 400);
    }
    if (!telemetry) return c.body(null, 204);
    const retry = await eventLimit(session.id);
    if (retry > 0) {
      c.header("Retry-After", String(Math.ceil(retry / 1000)));
      return c.json({ error: "Too many usage events" }, 429);
    }
    const shared = body.workspace.startsWith("shared:") ?
      (await sharedFor(membership.tenant)).find(({ id }) => id === body.workspace) : undefined;
    const tenant = shared?.owner ?? membership.tenant;
    const workspace = shared?.workspace ?? tenant.workspaces.find(({ id }) => id === body.workspace);
    if (workspace && !(membership.role === "viewer" && workspace.rejectApiKey)) {
      const role = readOnly ? "viewer" : shared?.role ?? membership.role;
      const event = pageEvents[body.event as PageEvent];
      telemetry.emit(event.event, { ...event.fields, role }, () => usageScope(tenant, workspace), tenant.id);
    }
    return c.body(null, 204);
  });
  app.route("/api", api);
  if (auth || linearAuth) {
    // The sign-in answers only under the name of the page, as the API does.
    app.use("/auth/*", async (c, next) => {
      const reason = refusal("GET", (name) => c.req.header(name), rules);
      if (reason) return c.json({ error: reason }, 403);
      await next();
    });
    const origin = () => `https://${rules.hosted!.host}`;
    app.route("/auth", linearAuth ? linearAuthRoutes(linearAuth, origin, clock, tenants!.signIn!, signOut, telemetry ? (id, workspace, created) => {
      const resolve = () => ({ tenant: id, workspace });
      if (created) telemetry.emit("sign_up", {}, resolve, id);
      telemetry.emit("sign_in", {}, resolve, id);
    } : undefined) : authRoutes(auth!, origin, clock, signOut));
  }

  app.get("/join/*", async (c) => {
    if (!accountStore) return c.text("not found", 404);
    const reason = refusal("GET", (name) => c.req.header(name), rules);
    if (reason) return c.text(reason, 403);
    const body = await readFile(join(dist, "index.html")).catch(() => null);
    if (!body) return c.text("not found (run `pnpm build`)", 404);
    return c.body(body, 200, { "Content-Type": TYPES[".html"] });
  });

  app.get("*", async (c) => {
    const file = normalize(join(dist, c.req.path === "/" ? "index.html" : c.req.path));
    if (!file.startsWith(dist)) return c.text("forbidden", 403);
    const type = TYPES[extname(file)];
    if (process.env.WG_PRECOMPRESSED_ASSETS === "1" && c.req.path.startsWith("/assets/")
      && (type === TYPES[".js"] || type === TYPES[".css"])) {
      const encodings = parseAccept(c.req.header("Accept-Encoding") ?? "");
      const gzip = encodings.find(({ type }) => type.toLowerCase() === "gzip");
      const wildcard = encodings.find(({ type }) => type === "*");
      if ((gzip?.q ?? wildcard?.q ?? 0) > 0) {
        const compressed = await readFile(`${file}.gz`).catch(() => null);
        if (compressed) return c.body(compressed, 200, {
          "Content-Type": type, "Content-Encoding": "gzip", Vary: "Accept-Encoding",
        });
      }
    }
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
    if (error instanceof LinkRoomFull) return c.json({ error: error.message }, 409);
    if (error instanceof NeedsLinearAccess) return c.json({ error: error.message, code: "needs_linear_access" }, 403);
    if (error instanceof LinearSignInRequired) return c.json({ error: error.message, login: LOGIN_PATH }, 401);
    const status = ((error instanceof RedisUnavailable || error instanceof RedisCommandFailed) ? 503 : error instanceof LinearError ? error.status : 500) as ContentfulStatusCode;
    // An API request writes its one log line in the request log above. Another route writes the error here.
    if (status === 500 && !c.req.path.startsWith("/api/") && !c.req.path.startsWith("/join/")) console.error(error);
    if (error instanceof RedisUnavailable || error instanceof RedisCommandFailed) c.header("Retry-After", "1");
    return c.json({ error: error.message }, status);
  });
  // Linear edits that did not come through this page: for each project with a connected coordinator,
  // the cached graph (its cheap check) shows which issues changed since the last look.
  // A hash of the node card: two card texts of the same length are still a change.
  const cardHash = (body: string | undefined) => (body === undefined ? "" : createHash("sha1").update(body).digest("hex"));
  const fingerprint = (data: GraphData) => new Map(data.issues.map((i) => [i.id, `${i.updatedAt}|${i.state.id}|${cardHash(i.card?.body)}`]));
  const check = async () => {
    if (!linkEnabled || !linkAvailable()) return;
    const active = await hub.active({ forCheck: true });
    const present = linkMaxAgeMs ? await hub.active({ forCheck: true, includeGrace: true }) : active;
    const rooms = tenants ? (await hub.roomRefs()).filter((ref) => ref.tenant !== undefined) : [];
    const ids = new Set([...(tenants ? states.keys() : [CONFIG_TENANT_ID]), ...rooms.map((ref) => ref.tenant!)]);
    await Promise.all([...ids].map(async (id) => {
      const lookupRevision = revision;
      const current = () => !tenantChangedSince(id, lookupRevision);
      const tenant = await directory.byId(id);
      if (!current()) return;
      const belongs = (ref: RoomRef) => ref.tenant === (tenants ? id : undefined);
      const refs = active.filter(belongs);
      const keys = new Set(present.filter(belongs).map(roomKey));
      const seen = states.get(id)?.seen;
      for (const key of seen?.keys() ?? []) if (!keys.has(key)) seen?.delete(key);
      const allowed = (ref: RoomRef) => tenant?.workspaces.some((w) => w.id === ref.workspace);
      const removed = rooms.filter((ref) => belongs(ref) && !allowed(ref));
      const drop = () => Promise.all(removed.map((ref) => hub.drop(ref)));
      if (removed.length) {
        if (tenant) await runInTenant(tenant, drop, lookupRevision);
        else await drop();
      }
      const scoped = refs.filter(allowed);
      if (!tenant || !scoped.length) return;
      await runInTenant(tenant, async () => {
        const { seen } = scope().state;
        await checkAll(scoped);
        for (const ref of scoped) {
          if (!current()) return;
          const workspace = tenant.workspaces.find((w) => w.id === ref.workspace);
          if (!workspace) continue;
          // The coordinator can go away while the check of all projects waits for Linear: then no load for it.
          if (!(await hub.active({ forCheck: true })).some((r) => roomKey(r) === roomKey(ref))) {
            continue;
          }
          try {
            const { data } = await linearWorkspace.run(workspace, () => graphs().get(ref.id));
            if (!current()) return;
            const now = fingerprint(data), before = seen.get(roomKey(ref));
            seen.set(roomKey(ref), now);
            if (!before) continue;
            const changed = data.issues.filter((i) => before.get(i.id) !== now.get(i.id)).map((i) => i.identifier);
            if (changed.length) await hub.publish(ref, "changed", { by: "linear", what: "issue", issues: changed });
          } catch (error) {
            console.error(`link: Linear check of ${projectKey(ref)} failed: ${(error as Error).message}`);
          }
        }
      }, lookupRevision);
    }));
  };
  let checking = false;
  const timer = linkEnabled && watchMs > 0 ? setInterval(() => {
    if (checking) return;
    checking = true;
    void check().catch(reportLinkError).finally(() => { checking = false; });
  }, watchMs) : null;
  timer?.unref();
  const stopTimers = () => {
    if (logoutTimer) clearInterval(logoutTimer);
    if (timer) clearInterval(timer);
    clearInterval(idleTimer);
    stopWatching();
  };

  return Object.assign(app, {
    injectWebSocket: (server: Server) => injectWebSocket(server),
    link: {
      hub, check,
      stop: () => { stopTimers(); hub.stop(); redis?.close(); },
      shutdown: () => { stopTimers(); return hub.shutdown().finally(() => redis?.close()); },
    },
  });
}
