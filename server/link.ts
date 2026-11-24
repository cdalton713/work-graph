// The hub of `wg-link/1` (src/lib/link.ts): one room for each project, with its coordinators, its open
// pages, and the queue of messages for its coordinators. It holds no Linear key and makes no request:
// app.ts feeds it the changes it sees.
import { randomUUID } from "node:crypto";
import {
  type Ask, type CoordinatorPresence, type CoordinatorState, type Envelope, type FromCoordinator, type Hello, LINK_VERSION,
  type Presence, type Progress, type ProjectRef, type ToCoordinator, type ToPage, projectKey,
} from "../src/lib/link.ts";

/**
 * One open WebSocket, as the hub uses it. A peer with `ping` takes part in the heartbeat: the hub pings it and
 * calls `terminate` when it sent no pong for `DEAD_MS` (from the open until the first pong).
 */
export interface Peer {
  send: (text: string) => void; close: (code?: number, reason?: string) => void;
  ping?: () => void; terminate?: () => void;
}
/** What the transport calls for each connection. `pong`: the socket answered a ping. */
export interface Connection { receive: (text: string) => void; closed: () => void; pong: () => void }

/** The longest queue of a project. The oldest `changed` goes first: a newer `changed` covers it. */
export const QUEUE_MAX = 100;
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
const realTimers: Timers = {
  every: (fn, ms) => { const t = setInterval(fn, ms); t.unref(); return () => clearInterval(t); },
  after: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return () => clearTimeout(t); },
};
interface Socket { peer: Peer; room: string | null; deadline: (() => void) | null; closed: () => void }

/** A client text as one log line: JSON escapes each control character, and the two Unicode line separators too. */
const logField = (v: string) => JSON.stringify(v).replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);

/**
 * On each of the signals, run `shutdown` once, then `exit(0)`. `on` and `exit` are those of `process` in the server.
 */
export function stopOnSignals(shutdown: () => Promise<void>, on: (signal: NodeJS.Signals, fn: () => void) => void, exit: (code: number) => void) {
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    on(signal, () => {
      if (stopping) return;
      stopping = true;
      void shutdown().finally(() => exit(0));
    });
  }
}

interface Coordinator { peer: Peer | null; hello: Hello; state: CoordinatorState | null; since: string; lastSeen: string }
interface Room {
  ref: ProjectRef; queue: Envelope[]; coordinators: Map<string, Coordinator>; pages: Set<Peer>;
  asks: Ask[]; progress: Progress[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 20_000) => (typeof v === "string" ? v.slice(0, max) : "");

export class LinkHub {
  private rooms = new Map<string, Room>();
  /** Pages with no project: the overview. They get the presence and the asks of every project. */
  private watchers = new Set<Peer>();
  private now: () => Date;
  /** wg changed Linear (`wrote`): the server forgets its cached graph before the pages load it again. */
  private onWrote: (ref: ProjectRef) => void;
  private timers: Timers;
  /** Each open socket, pages and coordinators, with the time it last showed it is alive. */
  private sockets = new Map<Peer, Socket>();
  private stopBeat: (() => void) | null = null;
  /** Set at `shutdown`: the hub takes no new socket, and `drained` runs when the last socket closed. */
  private stopping: { drained: () => void; done: Promise<void> } | null = null;
  constructor(now: () => Date = () => new Date(), onWrote: (ref: ProjectRef) => void = () => {}, timers: Timers = realTimers) {
    this.now = now;
    this.onWrote = onWrote;
    this.timers = timers;
  }

  /** Start the heartbeat: each `PING_MS`, `beat`. */
  start() {
    this.stopBeat ??= this.timers.every(() => this.beat(), PING_MS);
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

  /** Ping each socket, then remove a coordinator that went away more than `GONE_MS` ago, and a room that holds nothing. */
  beat() {
    for (const socket of this.sockets.values()) socket.peer.ping?.();
    const cutoff = this.now().getTime() - GONE_MS;
    // A room that an open socket uses stays, also before the `hello` of its coordinator.
    const used = new Set([...this.sockets.values()].map((s) => s.room));
    for (const [key, room] of this.rooms) {
      for (const [session, c] of room.coordinators) if (!c.peer && Date.parse(c.lastSeen) < cutoff) room.coordinators.delete(session);
      if (!used.has(key) && !room.pages.size && !room.coordinators.size && !room.queue.length && !room.asks.length) this.rooms.delete(key);
    }
  }

  /**
   * The server stops: stop the heartbeat and close each socket with `RESTART_CODE`. The promise resolves when
   * all sockets closed, or after `SHUTDOWN_MS`.
   */
  shutdown(): Promise<void> {
    if (this.stopping) return this.stopping.done;
    this.stop();
    let finish = () => {};
    const done = new Promise<void>((ok) => { finish = ok; });
    const cancel = this.timers.after(() => finish(), SHUTDOWN_MS);
    this.stopping = { drained: () => { cancel(); finish(); }, done };
    if (!this.sockets.size) this.stopping.drained();
    for (const socket of [...this.sockets.values()]) socket.peer.close(RESTART_CODE, "server restart");
    return done;
  }

  /**
   * Keep track of an open socket. A peer with `ping` gets a deadline of `DEAD_MS`; each pong sets it again. At the
   * deadline the hub terminates the socket. `closed` runs once, from the transport or from the deadline.
   */
  private track(peer: Peer, ref: ProjectRef | null, closed: () => void): Connection {
    let done = false;
    const socket: Socket = { peer, room: ref && projectKey(ref), deadline: null, closed: () => {} };
    const arm = () => {
      socket.deadline?.();
      socket.deadline = this.stopping ? null : this.timers.after(() => {
        socket.deadline = null;
        if (peer.terminate) peer.terminate();
        else peer.close();
        // The transport calls `closed` too, maybe much later; the hub does not wait for it.
        socket.closed();
      }, DEAD_MS);
    };
    socket.closed = () => {
      if (done) return;
      done = true;
      socket.deadline?.();
      socket.deadline = null;
      this.sockets.delete(peer);
      closed();
      if (this.stopping && !this.sockets.size) this.stopping.drained();
    };
    this.sockets.set(peer, socket);
    if (peer.ping) arm();
    return { receive: () => {}, closed: () => socket.closed(), pong: () => { if (!done && peer.ping) arm(); } };
  }

  /** A socket that the transport admitted while the hub stops: it gets the close of a restart, and shutdown waits for it. */
  private refuse(peer: Peer): Connection {
    const socket = this.track(peer, null, () => {});
    peer.close(RESTART_CODE, "server restart");
    return socket;
  }

  private room(ref: ProjectRef): Room {
    const key = projectKey(ref);
    let room = this.rooms.get(key);
    if (!room) {
      room = { ref, queue: [], coordinators: new Map(), pages: new Set(), asks: [], progress: [] };
      this.rooms.set(key, room);
    }
    return room;
  }

  private envelope<T extends string, P>(ref: ProjectRef, type: T, payload: P): Envelope<T, P> {
    return { v: LINK_VERSION, type, id: randomUUID(), project: ref, at: this.now().toISOString(), payload };
  }

  private toPages<T extends keyof ToPage>(room: Room, type: T, payload: ToPage[T], overview = false) {
    const message = JSON.stringify(this.envelope(room.ref, type, payload));
    for (const page of room.pages) page.send(message);
    if (overview) for (const page of this.watchers) page.send(message);
  }

  private announce(room: Room) {
    this.toPages(room, "presence", this.presence(room.ref), true);
  }

  /** The coordinators of a project, connected first, and the size of its queue. */
  presence(ref: ProjectRef): Presence {
    const room = this.rooms.get(projectKey(ref));
    if (!room) return { coordinators: [], queued: 0 };
    const cutoff = this.now().getTime() - GONE_MS;
    const coordinators: CoordinatorPresence[] = [...room.coordinators.values()]
      .filter((c) => c.peer || Date.parse(c.lastSeen) >= cutoff)
      .map((c) => ({
        session: c.hello.session, host: c.hello.host, plan: c.hello.plan, connected: !!c.peer,
        mode: c.state?.mode ?? null, head: c.state?.head ?? null, since: c.since, lastSeen: c.lastSeen,
        paused: !!c.state?.lines.some((l) => l.level === "wait" && l.text.startsWith("paused ")),
      }))
      .sort((a, b) => Number(b.connected) - Number(a.connected) || b.lastSeen.localeCompare(a.lastSeen));
    return { coordinators, queued: room.queue.length };
  }

  /** The queued messages that only a coordinator can act on (answer, reply, command): `wg wake` starts one for them. */
  waiting(ref: ProjectRef): number {
    return this.rooms.get(projectKey(ref))?.queue.filter((m) => m.type !== "changed").length ?? 0;
  }

  /** One open ask of a worker, as the coordinator last reported it. */
  ask(ref: ProjectRef, id: string): Ask | null {
    return this.rooms.get(projectKey(ref))?.asks.find((a) => a.id === id) ?? null;
  }

  /** The human replied to an ask: the pages stop showing it before the coordinator reports again. */
  answered(ref: ProjectRef, id: string) {
    const room = this.rooms.get(projectKey(ref));
    if (!room) return;
    room.asks = room.asks.filter((a) => a.id !== id);
    this.toPages(room, "asks", { asks: room.asks }, true);
  }

  /** The projects that have a connected coordinator: the server checks Linear for these. */
  active(): ProjectRef[] {
    return [...this.rooms.values()].filter((r) => [...r.coordinators.values()].some((c) => c.peer)).map((r) => r.ref);
  }

  /**
   * Queue a message for the coordinators of the project and send it to each connected one. It stays
   * in the queue until a coordinator sends `ack`, so a coordinator that is busy gets it at its next
   * `wg next`. A `changed` also goes to the open pages of the project.
   */
  publish<T extends keyof ToCoordinator>(ref: ProjectRef, type: T, payload: ToCoordinator[T]): Envelope<T, ToCoordinator[T]> {
    const room = this.room(ref);
    const message = this.envelope(ref, type, payload);
    room.queue.push(message);
    while (room.queue.length > QUEUE_MAX) {
      const at = room.queue.findIndex((m) => m.type === "changed");
      room.queue.splice(at === -1 ? 0 : at, 1);
    }
    const textMessage = JSON.stringify(message);
    for (const c of room.coordinators.values()) c.peer?.send(textMessage);
    if (type === "changed") this.toPages(room, "changed", payload as ToPage["changed"]);
    this.announce(room);
    return message;
  }

  /** A page of one project, or the overview (`ref` null). It gets the current state at once. */
  joinPage(peer: Peer, ref: ProjectRef | null): Connection {
    if (this.closing) return this.refuse(peer);
    if (!ref) {
      this.watchers.add(peer);
      // The overview counts each worker question as a move of the human's, so it gets the asks of every project too.
      for (const room of this.rooms.values()) {
        peer.send(JSON.stringify(this.envelope(room.ref, "presence", this.presence(room.ref))));
        if (room.asks.length) peer.send(JSON.stringify(this.envelope(room.ref, "asks", { asks: room.asks })));
      }
      return this.track(peer, null, () => { this.watchers.delete(peer); });
    }
    const room = this.room(ref);
    room.pages.add(peer);
    peer.send(JSON.stringify(this.envelope(ref, "presence", this.presence(ref))));
    peer.send(JSON.stringify(this.envelope(ref, "asks", { asks: room.asks })));
    peer.send(JSON.stringify(this.envelope(ref, "progress", { nodes: room.progress })));
    // A page only listens. It changes things through the HTTP API, which checks the origin and writes Linear.
    return this.track(peer, ref, () => { room.pages.delete(peer); });
  }

  /**
   * A coordinator of one project. Its first message must be `hello`; then it gets the queue. Only `wrote` may
   * come before it: a wg command that changed Linear sends it on a short connection that is no coordinator.
   */
  joinCoordinator(peer: Peer, ref: ProjectRef): Connection {
    if (this.closing) return this.refuse(peer);
    const room = this.room(ref);
    let me: Coordinator | null = null;
    const fail = (reason: string) => peer.close(1008, reason);
    /** Each coordinator entry of this socket goes away: the socket is no longer its connection. */
    const release = () => {
      let changed = false;
      for (const c of room.coordinators.values()) {
        if (c.peer !== peer) continue;
        c.peer = null;
        c.lastSeen = this.now().toISOString();
        changed = true;
      }
      return changed;
    };
    const socket = this.track(peer, ref, () => { if (release()) this.announce(room); });
    return {
      pong: socket.pong,
      closed: socket.closed,
      receive: (raw) => {
        let message: unknown;
        try { message = JSON.parse(raw); } catch { return fail("message is not JSON"); }
        if (!isObject(message) || message.v !== LINK_VERSION || typeof message.type !== "string") return fail(`not a wg-link/${LINK_VERSION} message`);
        const payload = isObject(message.payload) ? message.payload : {};
        const at = this.now().toISOString();
        if (message.type === "wrote") {
          if (me) me.lastSeen = at;
          const issues = (Array.isArray(payload.issues) ? payload.issues : []).filter((i): i is string => typeof i === "string").slice(0, 500).map((i) => i.slice(0, 50));
          this.onWrote(room.ref);
          // Only the pages: the coordinator made this change itself, so its queue gets nothing.
          return this.toPages(room, "changed", { by: "coordinator", what: "issue", issues });
        }
        if (message.type === "hello") {
          const hello: Hello = { plan: text(payload.plan, 200), session: text(payload.session, 200) || randomUUID(), host: text(payload.host, 200), wg: text(payload.wg, 50) };
          // The same session again (a reconnect) takes the place of its old connection.
          // One socket is one session: a hello with another session releases the session it had.
          if (me && me.hello.session !== hello.session) release();
          const old = room.coordinators.get(hello.session);
          if (old?.peer && old.peer !== peer) old.peer.close(1000, "replaced by a new connection of the same session");
          me = { peer, hello, state: old?.state ?? null, since: old?.peer ? old.since : at, lastSeen: at };
          room.coordinators.set(hello.session, me);
          for (const queued of room.queue) peer.send(JSON.stringify(queued));
          return this.announce(room);
        }
        if (!me) return fail("send hello first");
        me.lastSeen = at;
        const type = message.type as keyof FromCoordinator;
        if (type === "state") {
          const lines = Array.isArray(payload.lines) ? payload.lines.filter(isObject).slice(0, 200).map((l) => ({ level: text(l.level, 20), text: text(l.text, 2000) })) : [];
          me.state = { mode: payload.mode === "waiting" ? "waiting" : "working", head: text(payload.head, 500), lines };
          this.announce(room);
        } else if (type === "ack") {
          const ids = new Set(Array.isArray(payload.ids) ? payload.ids.filter((id): id is string => typeof id === "string") : []);
          room.queue = room.queue.filter((m) => !ids.has(m.id));
          this.announce(room);
        } else if (type === "asks") {
          room.asks = (Array.isArray(payload.asks) ? payload.asks.filter(isObject) : []).slice(0, 100).map((a) => ({
            id: text(a.id, 200), key: text(a.key, 200) || null, issue: text(a.issue, 50) || null, from: text(a.from, 200), body: text(a.body), at: text(a.at, 50),
          })).filter((a) => a.id);
          this.toPages(room, "asks", { asks: room.asks }, true);
        } else if (type === "progress") {
          room.progress = (Array.isArray(payload.nodes) ? payload.nodes.filter(isObject) : []).slice(0, 500).map((n) => ({
            key: text(n.key, 200), issue: text(n.issue, 50) || null, job: text(n.job, 50) || null, state: text(n.state, 50) || null,
            ci: text(n.ci, 200) || null, evidence: text(n.evidence, 500) || null, at: text(n.at, 50) || null,
          })).filter((n) => n.key);
          this.toPages(room, "progress", { nodes: room.progress });
        } else {
          // A newer wg can send a type that this server does not know yet: ignore it, and keep the connection.
          console.log(`link: ignored a message of unknown type ${logField(text(message.type, 100))} from ${logField(me.hello.session)}`);
        }
      },
    };
  }
}
