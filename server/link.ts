// The hub of `wg-link/1` (src/lib/link.ts): one room for each project, with its coordinators, its open
// pages, and the queue of messages for its coordinators. It holds no Linear key and makes no request:
// app.ts feeds it the changes it sees.
import { randomUUID } from "node:crypto";
import {
  type Ask, type CoordinatorPresence, type CoordinatorState, type Envelope, type FromCoordinator, type Hello, LINK_VERSION,
  type Presence, type Progress, type ProjectRef, type ToCoordinator, type ToPage, projectKey,
} from "../src/lib/link.ts";

/** One open WebSocket, as the hub uses it. */
export interface Peer { send: (text: string) => void; close: (code?: number, reason?: string) => void }
/** What the transport calls for each connection. */
export interface Connection { receive: (text: string) => void; closed: () => void }

/** The longest queue of a project. The oldest `changed` goes first: a newer `changed` covers it. */
export const QUEUE_MAX = 100;
/** How long the page still shows a coordinator that went away. */
export const GONE_MS = 24 * 60 * 60_000;

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
  constructor(now: () => Date = () => new Date(), onWrote: (ref: ProjectRef) => void = () => {}) {
    this.now = now;
    this.onWrote = onWrote;
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
    if (!ref) {
      this.watchers.add(peer);
      // The overview counts each worker question as a move of the human's, so it gets the asks of every project too.
      for (const room of this.rooms.values()) {
        peer.send(JSON.stringify(this.envelope(room.ref, "presence", this.presence(room.ref))));
        if (room.asks.length) peer.send(JSON.stringify(this.envelope(room.ref, "asks", { asks: room.asks })));
      }
      return { receive: () => {}, closed: () => { this.watchers.delete(peer); } };
    }
    const room = this.room(ref);
    room.pages.add(peer);
    peer.send(JSON.stringify(this.envelope(ref, "presence", this.presence(ref))));
    peer.send(JSON.stringify(this.envelope(ref, "asks", { asks: room.asks })));
    peer.send(JSON.stringify(this.envelope(ref, "progress", { nodes: room.progress })));
    // A page only listens. It changes things through the HTTP API, which checks the origin and writes Linear.
    return { receive: () => {}, closed: () => { room.pages.delete(peer); } };
  }

  /**
   * A coordinator of one project. Its first message must be `hello`; then it gets the queue. Only `wrote` may
   * come before it: a wg command that changed Linear sends it on a short connection that is no coordinator.
   */
  joinCoordinator(peer: Peer, ref: ProjectRef): Connection {
    const room = this.room(ref);
    let me: Coordinator | null = null;
    const fail = (reason: string) => peer.close(1008, reason);
    return {
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
          fail(`unknown message type ${message.type}`);
        }
      },
      closed: () => {
        if (me?.peer === peer) {
          me.peer = null;
          me.lastSeen = this.now().toISOString();
          this.announce(room);
        }
      },
    };
  }
}
