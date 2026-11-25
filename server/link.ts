// The hub of `wg-link/1` (src/lib/link.ts): one room for each project, with its coordinators, its open
// pages, and the queue of messages for its coordinators. It holds no Linear key and makes no request:
// app.ts feeds it the changes it sees.
import { randomUUID } from "node:crypto";
import {
  type AgentRow, type CoordinatorPresence, type Envelope, type FromCoordinator, type Hello, LINK_VERSION,
  type Presence, type ProjectRef, type ToCoordinator, type ToPage, projectKey,
} from "../src/lib/link.ts";
import type { RoomCounts } from "../src/lib/types.ts";
import { memoryLinkBus, type LinkBus, type LinkEvent } from "./linkbus.ts";
import { memoryLinkState, type LinkRoom, type LinkRoomState } from "./linkstate.ts";
import { ASKS_MAX, type LinkState as SavedState, type Store } from "./store.ts";

export { QUEUE_MAX } from "./linkstate.ts";

/**
 * One open WebSocket, as the hub uses it. A peer with `ping` takes part in the heartbeat: the hub pings it and
 * calls `terminate` when it sent no pong for `DEAD_MS` (from the open until the first pong).
 */
export interface Peer {
  send: (text: string) => void; close: (code?: number, reason?: string) => void;
  ping?: () => void; terminate?: () => void; session?: string;
}
/** The transport waits for each receive to finish before it calls receive again. A pong answers a ping. */
export interface Connection { receive: (text: string) => Promise<void>; closed: () => Promise<void>; pong: () => void }

/** How long the page still shows a coordinator that went away. */
export const GONE_MS = 24 * 60 * 60_000;
/** How often the hub pings each socket, and prunes what is gone. */
export const PING_MS = 20_000;
/** A socket that sent no pong for this long is dead: a machine that sleeps, or a lost network. Messages do not count. */
export const DEAD_MS = 45_000;
/** The WebSocket close code of a server restart. A client connects again. */
export const RESTART_CODE = 1012;
/** How long `shutdown` waits for the sockets to close. */
export const SHUTDOWN_MS = 3_000;

/** The timers of the hub (tests give fake ones). */
export interface Timers { every: (fn: () => void, ms: number) => () => void; after: (fn: () => void, ms: number) => () => void }
export const realTimers: Timers = {
  every: (fn, ms) => { const t = setInterval(fn, ms); t.unref(); return () => clearInterval(t); },
  after: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return () => clearTimeout(t); },
};
interface Socket {
  id: string;
  peer: Peer;
  room: string | null;
  audience: "coordinator" | "page" | "viewer" | null;
  allows?: (project: ProjectRef) => boolean;
  deadline: (() => void) | null;
  arm: () => void;
  closed: (lost?: boolean) => Promise<void>;
}

/** The message types that a coordinator sends. The record makes the compiler check that it names each one. */
const KNOWN_TYPES: Record<keyof FromCoordinator, true> = { hello: true, wrote: true, state: true, ack: true, asks: true, progress: true, agents: true };
/** The most agent rows of a project, and the longest last message of a row. */
export const AGENTS_MAX = 50;
export const SAID_MAX = 500;
const KNOWN = new Set<string>(Object.keys(KNOWN_TYPES));

/** A client text as one log line: JSON escapes each control character, and the two Unicode line separators too. */
const logField = (v: string) => JSON.stringify(v).replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);

/**
 * On each of the signals, run `shutdown` once, then `exit(0)`, or `exit(1)` when `shutdown` gives false (the link
 * state was not written). `on` and `exit` are those of `process` in the server.
 */
export function stopOnSignals(shutdown: () => Promise<boolean | void>, on: (signal: NodeJS.Signals, fn: () => void) => void, exit: (code: number) => void) {
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    on(signal, () => {
      if (stopping) return;
      stopping = true;
      shutdown().then((saved) => {
        if (saved === false) console.log("link state: not written at the stop; a restart can send acknowledged messages again");
        exit(saved === false ? 1 : 0);
      }, () => exit(1));
    });
  }
}

export const reportLinkError = (error: unknown) => console.error("link:", error);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 20_000) => (typeof v === "string" ? v.slice(0, max) : "");

export class LinkHub {
  /** Each open page or coordinator socket, with its pong deadline. */
  private sockets = new Map<string, Socket>();
  private stopBeat: (() => void) | null = null;
  /** Set at shutdown. The hub takes no new socket and drains when its last socket closes. */
  private stopping: { drained: () => void; done: Promise<boolean> } | null = null;
  private readonly unsubscribe: Promise<() => void | Promise<void>>;
  private readonly now: () => Date;
  /** A coordinator's wrote notice clears the graph cache before the pages reload it. */
  private readonly onWrote: (ref: ProjectRef) => void;
  private readonly timers: Timers;
  private readonly shared: LinkRoomState;
  private readonly bus: LinkBus;

  constructor(
    now: () => Date = () => new Date(),
    onWrote: (ref: ProjectRef) => void = () => {},
    timers: Timers = realTimers,
    // The default state uses the file store to keep queued messages and asks across restarts.
    store: Store | null = null,
    shared: LinkRoomState = memoryLinkState(store),
    bus: LinkBus = memoryLinkBus(),
  ) {
    this.now = now;
    this.onWrote = onWrote;
    this.timers = timers;
    this.shared = shared;
    this.bus = bus;
    this.unsubscribe = bus.subscribe((event) => this.deliver(event));
  }

  /** The queue and asks that the file store keeps. */
  async state(): Promise<SavedState> {
    return { rooms: (await this.shared.rooms()).map(({ ref, queue, asks }) => ({ ref, queue, asks })) };
  }

  async sessionEnded(id: string, now: number): Promise<boolean> {
    return this.shared.sessionEnded(id, now);
  }

  async endSession(id: string, expiresAt: number, now: number): Promise<void> {
    await this.shared.endSession(id, expiresAt, now);
    await this.send([{ kind: "ended", session: id }]);
  }

  private async send(events: LinkEvent[]): Promise<void> {
    await this.unsubscribe;
    await this.bus.publish(events);
  }

  private deliver(event: LinkEvent) {
    switch (event.kind) {
      case "wrote":
        this.onWrote(event.ref);
        break;
      case "ended":
        for (const { peer } of this.sockets.values()) {
          if (peer.session === event.session) peer.close(1008, "session ended");
        }
        break;
      case "replaced":
        this.sockets.get(event.socket)?.peer.close(1000, "replaced by a new connection of the same session");
        break;
      case "sockets":
        for (const id of event.sockets) {
          const socket = this.sockets.get(id);
          if (!socket || (socket.audience === "viewer" && this.closing)) continue;
          for (const message of event.messages) {
            if (socket.audience !== "viewer" || socket.allows?.(message.project)) socket.peer.send(JSON.stringify(message));
          }
        }
        break;
      case "pages": {
        const key = projectKey(event.message.project);
        for (const socket of this.sockets.values()) {
          if (socket.audience === "page" && (socket.room === key || (!socket.room && event.overview))) {
            socket.peer.send(JSON.stringify(event.message));
          } else if (socket.audience === "viewer" && event.viewer && (!socket.room || socket.room === key)
            && !this.closing && socket.allows?.(event.message.project)) {
            socket.peer.send(JSON.stringify(event.viewer));
          }
        }
        break;
      }
    }
  }

  /** Start the heartbeat: each `PING_MS`, `beat`. Each open socket gets a new pong deadline of `DEAD_MS`. */
  start() {
    if (this.stopBeat || this.stopping) return;
    this.stopBeat = this.timers.every(() => { void this.beat().catch(reportLinkError); }, PING_MS);
    for (const socket of this.sockets.values()) socket.arm();
  }

  /** True from the start of `shutdown`: the server takes no new link socket. */
  get closing(): boolean {
    return this.stopping !== null;
  }

  /** Stop the heartbeat and the pong deadlines. */
  stop() {
    this.stopBeat?.();
    this.stopBeat = null;
    for (const socket of this.sockets.values()) { socket.deadline?.(); socket.deadline = null; }
  }

  /** Ping local sockets and prune expired shared state. */
  async beat() {
    for (const socket of this.sockets.values()) socket.peer.ping?.();
    await this.shared.prune(this.now().getTime() - GONE_MS);
  }

  /**
   * The server stops: stop the heartbeat and close each socket with `RESTART_CODE`. The promise resolves when
   * all sockets closed, or after `SHUTDOWN_MS`. Then the store writes what still waits: an acknowledgment can
   * arrive while the sockets close. The promise gives false when that write failed.
   */
  shutdown(): Promise<boolean> {
    if (this.stopping) return this.stopping.done;
    this.stop();
    let finish = () => {};
    const done = new Promise<boolean>((ok) => {
      let finished = false;
      finish = () => {
        if (finished) return;
        finished = true;
        void this.shared.flush().then(ok, () => ok(false));
        void this.unsubscribe.then((off) => off()).catch(reportLinkError);
      };
    });
    const cancel = this.timers.after(() => finish(), SHUTDOWN_MS);
    this.stopping = { drained: () => { cancel(); finish(); }, done };
    if (!this.sockets.size) this.stopping.drained();
    for (const socket of [...this.sockets.values()]) socket.peer.close(RESTART_CODE, "server restart");
    return done;
  }

  /**
   * Keep track of an open socket. While the heartbeat runs, a peer with `ping` has a deadline of `DEAD_MS`; each pong
   * sets it again. At the deadline the hub terminates the socket. With the heartbeat stopped, no socket has a deadline.
   * `closed` runs once, from the transport or from the deadline.
   */
  private track(socket: Socket, closed: (lost: boolean) => Promise<void>): Connection {
    const { peer } = socket;
    let done = false;
    socket.arm = () => {
      socket.deadline?.();
      socket.deadline = null;
      if (done || !peer.ping || !this.stopBeat || this.stopping) return;
      socket.deadline = this.timers.after(() => {
        socket.deadline = null;
        if (peer.terminate) peer.terminate();
        else peer.close();
        // The transport calls closed too, possibly much later.
        void socket.closed(true).catch(reportLinkError);
      }, DEAD_MS);
    };
    socket.closed = async (lost = false) => {
      if (done) return;
      done = true;
      socket.deadline?.();
      socket.deadline = null;
      this.sockets.delete(socket.id);
      try {
        await closed(lost);
      } finally {
        if (this.stopping && !this.sockets.size) this.stopping.drained();
      }
    };
    this.sockets.set(socket.id, socket);
    socket.arm();
    return { receive: async () => {}, closed: () => socket.closed(), pong: () => socket.arm() };
  }

  private socket(peer: Peer, ref: ProjectRef | null, audience: Socket["audience"], allows?: Socket["allows"]): Socket {
    return { id: randomUUID(), peer, room: ref && projectKey(ref), audience, allows, deadline: null, arm: () => {}, closed: async () => {} };
  }

  /** An upgrade that the transport admitted while the hub stops also gets a restart close. */
  private refuse(peer: Peer): Connection {
    const connection = this.track(this.socket(peer, null, null), async () => {});
    peer.close(RESTART_CODE, "server restart");
    return connection;
  }

  private envelope<T extends string, P>(ref: ProjectRef, type: T, payload: P): Envelope<T, P> {
    return { v: LINK_VERSION, type, id: randomUUID(), project: ref, at: this.now().toISOString(), payload };
  }

  private pages<T extends keyof ToPage>(room: LinkRoom, type: T, payload: ToPage[T], overview = false): LinkEvent {
    const message = this.envelope(room.ref, type, payload);
    const reduced = type === "presence" ? this.redactPresence(payload as Presence)
      : type === "changed" ? { ...(payload as ToPage["changed"]), issues: [] } : null;
    return {
      kind: "pages", message, overview,
      ...(reduced && { viewer: this.envelope(room.ref, type, reduced) }),
    };
  }

  private announce(room: LinkRoom): LinkEvent {
    return this.pages(room, "presence", this.roomPresence(room), true);
  }

  /** The coordinators of a project, connected first, and the size of its queue. */
  async presence(ref: ProjectRef): Promise<Presence> {
    const room = await this.shared.read(ref);
    return room ? this.roomPresence(room) : { coordinators: [], queued: 0 };
  }

  private roomPresence(room: LinkRoom): Presence {
    const cutoff = this.now().getTime() - GONE_MS;
    const coordinators: CoordinatorPresence[] = [...room.coordinators.values()]
      .filter((c) => c.socket || Date.parse(c.lastSeen) >= cutoff)
      .map((c) => ({
        session: c.hello.session, host: c.hello.host, plan: c.hello.plan, connected: !!c.socket,
        mode: c.state?.mode ?? null, head: c.state?.head ?? null, since: c.since, lastSeen: c.lastSeen, lost: !!c.lost,
        paused: !!c.state?.lines.some((l) => l.level === "wait" && l.text.startsWith("paused ")),
      }))
      .sort((a, b) => Number(b.connected) - Number(a.connected) || b.lastSeen.localeCompare(a.lastSeen));
    return { coordinators, queued: room.queue.length };
  }

  /** Presence without coordinator identity, paths, work details, or queue counts. */
  async viewerPresence(ref: ProjectRef): Promise<Presence> {
    return this.redactPresence(await this.presence(ref));
  }

  private redactPresence(presence: Presence): Presence {
    return {
      queued: 0,
      coordinators: presence.coordinators.map((c, index) => ({
        ...c, session: String(index), host: "", plan: "", head: null,
      })),
    };
  }

  /** A viewer receives notices only while the server confirms the project is shared. */
  joinViewer(peer: Peer, ref: ProjectRef | null, allows: (project: ProjectRef) => boolean): Promise<Connection> {
    return this.joinPageSocket(peer, ref, allows);
  }

  /** For each room: the counts of connected coordinators, pages, queued messages, and asks. */
  async counts(): Promise<RoomCounts[]> {
    return (await this.shared.rooms()).map((r) => ({
      workspace: r.ref.workspace, project: r.ref.id,
      coordinators: [...r.coordinators.values()].filter((c) => c.socket).length,
      pages: [...r.sockets.values()].filter((role) => role === "page").length,
      queued: r.queue.length, asks: r.asks.length,
    }));
  }

  /** The queued messages that a coordinator can act on. */
  async waiting(ref: ProjectRef): Promise<number> {
    return (await this.shared.read(ref))?.queue.filter((m) => m.type !== "changed").length ?? 0;
  }

  /** One open ask of a worker, as the coordinator last reported it. */
  async ask(ref: ProjectRef, id: string) {
    return (await this.shared.read(ref))?.asks.find((a) => a.id === id) ?? null;
  }

  /** The human replied to an ask. The pages stop showing it before the coordinator reports again. */
  async answered(ref: ProjectRef, id: string) {
    const room = await this.shared.removeAsk(ref, id);
    if (room) await this.send([this.pages(room, "asks", { asks: room.asks }, true)]);
  }

  /** The projects that have a connected coordinator. Its first connected socket owns the Linear check. */
  async active({ forCheck = false } = {}): Promise<ProjectRef[]> {
    return (await this.shared.rooms()).flatMap((room) => {
      const first = [...room.coordinators.values()].find(({ socket }) => socket)?.socket;
      return first && (!forCheck || this.sockets.has(first)) ? [room.ref] : [];
    });
  }

  /**
   * Send a message to each connected coordinator and keep it in the queue until acknowledgment,
   * so a busy coordinator can pick it up at its next wg next. Send changed notices to project pages too.
   */
  async publish<T extends keyof ToCoordinator>(ref: ProjectRef, type: T, payload: ToCoordinator[T]): Promise<Envelope<T, ToCoordinator[T]>> {
    const message = this.envelope(ref, type, payload);
    const room = await this.shared.append(ref, message);
    const sockets = [...room.coordinators.values()].flatMap(({ socket }) => socket ? [socket] : []);
    const events: LinkEvent[] = [{ kind: "sockets", sockets, messages: [message] }];
    if (type === "changed") events.push(this.pages(room, "changed", payload as ToPage["changed"]));
    events.push(this.announce(room));
    await this.send(events);
    return message;
  }

  /** A page of one project, or the overview (no project). It gets the current state at once. */
  joinPage(peer: Peer, ref: ProjectRef | null): Promise<Connection> {
    // A page only listens. It changes things through the HTTP API, which checks the origin and writes Linear.
    return this.joinPageSocket(peer, ref);
  }

  private async joinPageSocket(peer: Peer, ref: ProjectRef | null, allows?: (project: ProjectRef) => boolean): Promise<Connection> {
    if (this.closing) return this.refuse(peer);
    const socket = this.socket(peer, ref, allows ? "viewer" : "page", allows);
    const connection = this.track(socket, async () => {
      if (ref) await this.shared.edit(ref, (room) => { room.sockets.delete(socket.id); });
    });
    const rooms = ref ? await this.shared.edit(ref, (room) => {
      room.sockets.set(socket.id, "page");
      return [room];
    }) : await this.shared.rooms();
    const messages: Envelope[] = [];
    for (const room of rooms) {
      const presence = this.roomPresence(room);
      if (allows) {
        messages.push(this.envelope(room.ref, "presence", this.redactPresence(presence)));
        continue;
      }
      messages.push(this.envelope(room.ref, "presence", presence));
      // The overview counts worker questions as moves for the human, so it gets asks from every project.
      if (ref || room.asks.length) messages.push(this.envelope(room.ref, "asks", { asks: room.asks }));
      if (ref) messages.push(this.envelope(room.ref, "progress", { nodes: room.progress }));
      if (room.agents) messages.push(this.envelope(room.ref, "agents", room.agents));
    }
    if (messages.length) await this.send([{ kind: "sockets", sockets: [socket.id], messages }]);
    return connection;
  }

  /**
   * A coordinator of one project. Its first message must be `hello`; then it gets the queue. Only `wrote` and
   * `agents` may come before it: a wg command that changed Linear, or `wg agents`, sends them on a short
   * connection that is no coordinator.
   */
  async joinCoordinator(peer: Peer, ref: ProjectRef): Promise<Connection> {
    if (this.closing) return this.refuse(peer);
    const socket = this.socket(peer, ref, "coordinator");
    let session: string | null = null;
    const fail = (reason: string) => peer.close(1008, reason);
    const release = (room: LinkRoom, at: string, lost = false) => {
      const current = [...room.coordinators.values()].find((coordinator) => coordinator.socket === socket.id);
      if (!current) return false;
      Object.assign(current, { socket: null, lost, lastSeen: at });
      return true;
    };
    const connection = this.track(socket, async (lost) => {
      const at = this.now().toISOString();
      const room = await this.shared.edit(ref, (room) => {
        room.sockets.delete(socket.id);
        return release(room, at, lost) ? room : null;
      });
      if (room) await this.send([this.announce(room)]);
    });
    await this.shared.edit(ref, (room) => { room.sockets.set(socket.id, "coordinator"); });
    return {
      pong: connection.pong,
      closed: connection.closed,
      receive: async (raw) => {
        let message: unknown;
        try { message = JSON.parse(raw); } catch { return fail("message is not JSON"); }
        if (!isObject(message) || message.v !== LINK_VERSION || typeof message.type !== "string") return fail(`not a wg-link/${LINK_VERSION} message`);
        const payload = isObject(message.payload) ? message.payload : {};
        const at = this.now().toISOString();
        if (message.type === "wrote") {
          if (session) await this.shared.edit(ref, (room) => {
            const current = room.coordinators.get(session!);
            if (current?.socket === socket.id) current.lastSeen = at;
          });
          const issues = (Array.isArray(payload.issues) ? payload.issues : []).filter((i): i is string => typeof i === "string").slice(0, 500).map((i) => i.slice(0, 50));
          const changed = this.envelope(ref, "changed", { by: "coordinator", what: "issue", issues });
          // Clear each cache before its pages reload the graph. The coordinator needs no queued copy.
          return this.send([{ kind: "wrote", ref }, {
            kind: "pages", message: changed, overview: false,
            viewer: this.envelope(ref, "changed", { ...changed.payload, issues: [] }),
          }]);
        }
        if (message.type === "agents") {
          const rows: AgentRow[] = (Array.isArray(payload.agents) ? payload.agents.filter(isObject) : []).slice(0, AGENTS_MAX).map((a) => ({
            id: text(a.id, 200), role: a.role === "coordinator" ? "coordinator" as const : "worker" as const, key: text(a.key, 200) || null,
            issue: text(a.issue, 50) || null, agent: text(a.agent, 50), state: text(a.state, 50), title: text(a.title, 200),
            said: text(a.said, SAID_MAX), at: text(a.at, 50) || null,
          })).filter((a) => a.id);
          const agents = { at, agents: rows };
          const room = await this.shared.edit(ref, (room) => { room.agents = agents; return room; });
          return this.send([this.pages(room, "agents", agents, true)]);
        }
        if (message.type === "hello") {
          const hello: Hello = { plan: text(payload.plan, 200), session: text(payload.session, 200) || randomUUID(), host: text(payload.host, 200), wg: text(payload.wg, 50) };
          // A reconnect replaces the socket of the same session, including on another hub.
          // A socket that sends hello for a different session releases its previous session.
          const joined = await this.shared.edit(ref, (room) => {
            if (!room.sockets.has(socket.id)) return null;
            if (session !== hello.session) release(room, at);
            const old = room.coordinators.get(hello.session);
            room.coordinators.set(hello.session, {
              socket: socket.id, hello, state: old?.state ?? null, since: old?.socket ? old.since : at, lastSeen: at,
            });
            return { room, replaced: old?.socket };
          });
          if (!joined) return;
          session = hello.session;
          const { room, replaced } = joined;
          const events: LinkEvent[] = [];
          if (replaced && replaced !== socket.id) events.push({ kind: "replaced", socket: replaced });
          events.push({ kind: "sockets", sockets: [socket.id], messages: room.queue }, this.announce(room));
          return this.send(events);
        }
        if (!KNOWN.has(message.type)) {
          // A newer wg can send a type that this server does not know yet, also as its first message: ignore it,
          // and keep the connection.
          console.log(`link: ignored a message of unknown type ${logField(text(message.type, 100))} from ${logField(session ?? "(no hello yet)")}`);
          return;
        }
        if (!session) return fail("send hello first");
        const sessionId = session;
        await this.shared.edit(ref, (room) => {
          const current = room.coordinators.get(sessionId);
          if (current?.socket === socket.id) current.lastSeen = at;
        });
        // A replaced socket can still have room updates in flight before the transport closes it.
        const type = message.type as keyof FromCoordinator;
        if (type === "state") {
          const lines = Array.isArray(payload.lines) ? payload.lines.filter(isObject).slice(0, 200).map((l) => ({ level: text(l.level, 20), text: text(l.text, 2000) })) : [];
          const room = await this.shared.edit(ref, (room) => {
            const current = room.coordinators.get(sessionId);
            if (current?.socket === socket.id) {
              current.state = { mode: payload.mode === "waiting" ? "waiting" : "working", head: text(payload.head, 500), lines };
            }
            return room;
          });
          await this.send([this.announce(room)]);
        } else if (type === "ack") {
          const ids = Array.isArray(payload.ids) ? payload.ids.filter((id): id is string => typeof id === "string") : [];
          const room = await this.shared.ack(ref, ids);
          await this.send([this.announce(room)]);
        } else if (type === "asks") {
          const asks = (Array.isArray(payload.asks) ? payload.asks.filter(isObject) : []).slice(0, ASKS_MAX).map((a) => ({
            id: text(a.id, 200), key: text(a.key, 200) || null, issue: text(a.issue, 50) || null, from: text(a.from, 200), body: text(a.body), at: text(a.at, 50),
            ...(a.kind === "escalation" ? { kind: "escalation" as const } : {}),
          })).filter((a) => a.id);
          const room = await this.shared.setAsks(ref, asks);
          await this.send([this.pages(room, "asks", { asks: room.asks }, true)]);
        } else if (type === "progress") {
          const progress = (Array.isArray(payload.nodes) ? payload.nodes.filter(isObject) : []).slice(0, 500).map((n) => ({
            key: text(n.key, 200), issue: text(n.issue, 50) || null, job: text(n.job, 50) || null, state: text(n.state, 50) || null,
            ci: text(n.ci, 200) || null, evidence: text(n.evidence, 500) || null, at: text(n.at, 50) || null,
          })).filter((n) => n.key);
          const room = await this.shared.edit(ref, (room) => { room.progress = progress; return room; });
          await this.send([this.pages(room, "progress", { nodes: room.progress })]);
        }
      },
    };
  }
}
