// The hub of `wg-link/1` (src/lib/link.ts): one room for each project, with its coordinators, its open
// pages, and the queue of messages for its coordinators. It holds no Linear key and makes no request:
// app.ts feeds it the changes it sees.
import { createHash, randomUUID } from "node:crypto";
import {
  type AgentRow, type CoordinatorPresence, type Envelope, type FromCoordinator, type Hello, LINK_VERSION,
  type Presence, type ProjectRef, type ToCoordinator, type ToPage, projectKey, RECYCLE_CODE, RECONNECT_GRACE_MS, RESTART_CODE,
} from "../src/lib/link.ts";
import type { Site } from "../src/lib/site.ts";
import type { RoomCounts } from "../src/lib/types.ts";
import { memoryLinkBus, type LinkBus, type LinkEvent } from "./linkbus.ts";
import {
  addRoomAccount, appendMessage, checkLinkTenant, expireReconnectGrace, memoryLinkState, roomAccount, roomAccounts,
  roomKey, type LinkRoom, type LinkRoomState, type RoomRef,
} from "./linkstate.ts";
import { RedisCommandFailed, RedisUnavailable } from "./redis.ts";
import { requestSite } from "./site.ts";
import { ASKS_MAX, type LinkState as SavedState, type Store } from "./store.ts";

export { QUEUE_MAX } from "./linkstate.ts";
export { RECYCLE_CODE, RECONNECT_GRACE_MS, RESTART_CODE } from "../src/lib/link.ts";

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
/** How long `shutdown` waits for the sockets to close. */
export const SHUTDOWN_MS = 3_000;

export function linkSettings(env: NodeJS.ProcessEnv) {
  const duration = (name: string, min: number, max: number) => {
    const raw = env[name]?.trim();
    if (!raw) return undefined;
    const value = Number(raw);
    if (value === 0 || (value >= min && value <= max)) return value;
    throw new Error(`${name} must be 0 or a number from ${min} to ${max}`);
  };
  const ageSeconds = duration("WG_LINK_MAX_AGE", 60, 2_147_483);
  return {
    linkMaxAgeMs: ageSeconds === undefined ? undefined : ageSeconds * 1000,
    linkPongMs: duration("WG_LINK_PONG_MS", PING_MS + 5000, 300_000),
  };
}

/** The timers of the hub (tests give fake ones). */
export interface Timers { every: (fn: () => void, ms: number) => () => void; after: (fn: () => void, ms: number) => () => void }
export const realTimers: Timers = {
  every: (fn, ms) => { const t = setInterval(fn, ms); t.unref(); return () => clearInterval(t); },
  after: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return () => clearTimeout(t); },
};
export class LinkRoomFull extends Error {
  constructor() { super("This room already has eight collaborator accounts."); }
}

const ASK_ID_MAX = 200;

/** Bind a page ask ID to its account without exposing the account ID. */
function pageAskId(ref: RoomRef, account: string | undefined, id: string): string {
  if (account === undefined) return id;
  const digest = createHash("sha256").update(JSON.stringify([roomKey(ref), account, id])).digest("hex");
  // Keep member aliases outside the range an owner coordinator can use for an unchanged ask ID.
  return ("member-" + digest).padEnd(ASK_ID_MAX + 1, "-");
}

export interface LinkMember { account: string; name: string; workspace: string; ownerName?: string }

interface Socket {
  member?: LinkMember;
  id: string;
  peer: Peer;
  room: string | null;
  ref: RoomRef | null;
  tenant?: string;
  site?: Site;
  revoked?: boolean;
  lastSent: Map<string, number>;
  queuedMessages: Map<string, Envelope>;
  renewedAt: number;
  leaseReady: boolean;
  audience: "coordinator" | "page" | "viewer" | null;
  allows?: (project: ProjectRef) => boolean;
  deadline: (() => void) | null;
  recycleAt: number;
  recycling: boolean;
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

export const reportLinkError = (error: unknown) => {
  if (!(error instanceof RedisUnavailable || error instanceof RedisCommandFailed)) console.error("link:", error);
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 20_000) => (typeof v === "string" ? v.slice(0, max) : "");

export class LinkHub {
  /** Each open page or coordinator socket, with its pong deadline. */
  private sockets = new Map<string, Socket>();
  private releases = 0;
  private stopBeat: (() => void) | null = null;
  /** Set at shutdown. The hub takes no new socket and drains when its last socket closes. */
  private stopping: { drained: () => void; done: Promise<boolean> } | null = null;
  private readonly unsubscribe: Promise<() => void | Promise<void>>;
  private readonly now: () => Date;
  /** A coordinator's wrote notice clears the graph cache before the pages reload it. */
  private readonly onWrote: (ref: RoomRef) => void;
  private readonly timers: Timers;
  private readonly shared: LinkRoomState;
  private readonly bus: LinkBus;
  private readonly onEnded: (id: string, expiresAt: number) => void;
  private readonly maxAgeMs: number;
  private readonly pongMs: number;
  private readonly site: (tenant?: string) => Site | undefined;

  constructor(
    now: () => Date = () => new Date(),
    onWrote: (ref: RoomRef) => void = () => {},
    timers: Timers = realTimers,
    // The default state uses the file store to keep queued messages and asks across restarts.
    store: Store | null = null,
    shared: LinkRoomState = memoryLinkState(store),
    bus: LinkBus = memoryLinkBus(),
    { maxAgeMs = 0, pongMs = DEAD_MS, site, tenantSite }: { maxAgeMs?: number; pongMs?: number; site?: Site; tenantSite?: (tenant: string) => Site | undefined } = {},
    onEnded: (id: string, expiresAt: number) => void = () => {},
  ) {
    this.now = now;
    this.onWrote = onWrote;
    this.timers = timers;
    this.shared = shared;
    this.bus = bus;
    this.onEnded = onEnded;
    this.maxAgeMs = Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? maxAgeMs : 0;
    this.pongMs = Number.isFinite(pongMs) && pongMs >= 0 ? pongMs : DEAD_MS;
    this.site = (tenant) => tenant === undefined ? site : tenantSite?.(tenant);
    this.unsubscribe = bus.subscribe((event) => this.inSite(event.tenant, () => this.deliver(event)));
  }

  private editWhilePresent<T>(ref: RoomRef, change: (room: LinkRoom) => T): Promise<T | null> {
    return ref.tenant === undefined ? this.shared.edit(ref, change) : this.shared.editExisting(ref, change);
  }

  private inSite<T>(tenant: string | undefined, handle: () => T, site = this.site(tenant)): T {
    return site ? requestSite.run(site, handle) : handle();
  }

  private forSocket<T>(socket: Socket, handle: () => T): T {
    return this.inSite(socket.tenant, handle, socket.site);
  }

  /** The queue and asks that the file store keeps. */
  async state(): Promise<SavedState> {
    return { rooms: (await this.shared.rooms()).map(({ ref, queue, asks }) => ({ ref, queue, asks })) };
  }

  async sessionEnded(id: string, now: number): Promise<boolean> {
    return this.shared.sessionEnded(id, now);
  }

  async endSession(id: string, expiresAt: number, now: number): Promise<void> {
    const event = { kind: "ended", session: id, expiresAt } as const;
    try {
      await this.shared.endSession(id, expiresAt, now);
    } catch (error) {
      this.deliver(event);
      throw error;
    }
    await this.send([event]).catch((error) => {
      this.deliver(event);
      reportLinkError(error);
    });
  }

  private async send(events: LinkEvent[], tenant?: string): Promise<void> {
    await this.unsubscribe;
    await this.bus.publish(tenant === undefined ? events : events.map((event) => ({ ...event, tenant })));
  }

  private deliver(event: LinkEvent) {
    switch (event.kind) {
      case "wrote":
        this.onWrote(event.ref);
        break;
      case "ended":
        if (event.expiresAt !== undefined) this.onEnded(event.session, event.expiresAt);
        for (const socket of this.sockets.values()) {
          if (socket.peer.session === event.session) this.forSocket(socket, () => socket.peer.close(1008, "session ended"));
        }
        break;
      case "members-revoked":
        for (const id of event.sockets) {
          const socket = this.sockets.get(id);
          if (socket?.member && socket.tenant === event.tenant) void this.restart(socket, true).catch(reportLinkError);
        }
        break;
      case "replaced": {
        const socket = this.sockets.get(event.socket);
        if (socket && socket.tenant === event.tenant) this.forSocket(socket, () =>
          socket.peer.close(1000, "replaced by a new connection of the same session"));
        break;
      }
      case "sockets":
        for (const id of event.sockets) {
          const socket = this.sockets.get(id);
          if (!socket || socket.revoked || socket.tenant !== event.tenant || (socket.audience === "viewer" && this.closing)) continue;
          if (event.queue && event.sequence !== undefined) {
            this.sendQueue(socket, event.messages, event.sequence, event.replay);
            continue;
          }
          for (const message of event.messages) {
            if (socket.audience !== "viewer" || socket.allows?.(message.project)) this.sendTo(socket, message, event.sequence);
          }
        }
        break;
      case "pages": {
        const key = roomKey({ ...event.message.project, tenant: event.tenant });
        for (const socket of this.sockets.values()) {
          if (socket.revoked || socket.tenant !== event.tenant) continue;
          const ownAgents = event.message.type !== "agents" || socket.member?.account === event.account;
          if (socket.audience === "page" && ownAgents && (socket.room === key || (!socket.room && event.overview))) {
            const message = event.message.type === "presence" && socket.member ? {
              ...event.message,
              payload: { ...(event.message.payload as Presence),
                queued: event.queuedByAccount?.find(([account]) => account === socket.member?.account)?.[1] ?? 0 },
            } : event.message;
            this.sendTo(socket, message, event.sequence);
          } else if (socket.audience === "viewer" && event.viewer && (!socket.room || socket.room === key)
            && !this.closing && socket.allows?.(event.message.project)) {
            this.sendTo(socket, event.viewer, event.sequence);
          }
        }
        break;
      }
    }
  }

  private sendTo(socket: Socket, message: Envelope, sequence?: number) {
    if (this.recycleIfDue(socket)) return;
    if (sequence !== undefined) {
      const key = JSON.stringify([projectKey(message.project), message.type]);
      if (sequence <= (socket.lastSent.get(key) ?? -1)) return;
      socket.lastSent.set(key, sequence);
    }
    this.sendFrame(socket, message);
  }

  private sendFrame(socket: Socket, message: Envelope) {
    socket.peer.send(JSON.stringify(socket.member ? {
      ...message, project: { ...message.project, workspace: socket.member.workspace },
    } : message));
  }

  private sendQueue(socket: Socket, messages: Envelope[], sequence: number, replay = false) {
    if (this.recycleIfDue(socket)) return;
    const last = socket.lastSent.get("queue") ?? -1;
    const previous = socket.queuedMessages;
    if (sequence <= last) {
      if (replay) for (const item of previous.values()) this.sendFrame(socket, item);
      return;
    }
    socket.lastSent.set("queue", sequence);
    socket.queuedMessages = new Map(messages.map((item) => [item.id, item]));
    for (const item of messages) if (replay || !previous.has(item.id)) this.sendFrame(socket, item);
  }

  private queueEvent(room: LinkRoom, sockets: string[], message?: Envelope, replay = false, account?: string): LinkEvent {
    return {
      kind: "sockets", sockets, messages: room.sequence !== undefined || !message ? roomAccount(room, account)?.queue ?? [] : [message],
      sequence: room.sequence, queue: room.sequence !== undefined, replay,
    };
  }

  private async renewDue(sockets: Socket[], heartbeat = false) {
    const at = this.now();
    const due = heartbeat ? sockets : sockets.filter((socket) => at.getTime() - socket.renewedAt >= PING_MS);
    for (const socket of due) socket.renewedAt = at.getTime();
    if (!due.length) return new Set<string>();
    const renewed = await this.shared.renew!(due.map((socket) => ({ ref: socket.ref!, socket: socket.id, page: socket.audience !== "coordinator" && !socket.member && !!this.shared.openPage })), at.toISOString());
    for (const socket of due) {
      if (!renewed.has(socket.id) && this.sockets.has(socket.id)) this.forSocket(socket, () => socket.peer.close(RESTART_CODE, "server restart"));
    }
    return new Set(due.filter((socket) => !renewed.has(socket.id)).map((socket) => socket.id));
  }

  private async renewSockets() {
    const sockets = [...this.sockets.values()].filter((socket) => socket.ref !== null && socket.leaseReady && !socket.recycling);
    const tenants = new Map<string | undefined, Socket[]>();
    for (const socket of sockets) {
      const group = tenants.get(socket.tenant) ?? [];
      group.push(socket);
      tenants.set(socket.tenant, group);
    }
    const expired = new Set((await Promise.all([...tenants.values()].map(
      (group) => this.forSocket(group[0], () => this.renewDue(group, true)),
    ))).flatMap((ids) => [...ids]));
    const coordinators = new Map<string, Socket[]>();
    for (const socket of sockets) {
      if (!this.sockets.has(socket.id)) continue;
      if (!expired.has(socket.id) && socket.audience === "coordinator" && socket.room) {
        const peers = coordinators.get(socket.room) ?? [];
        peers.push(socket);
        coordinators.set(socket.room, peers);
      }
    }
    await Promise.all([...coordinators.values()].map((peers) => this.forSocket(peers[0], async () => {
      const room = await this.shared.read(peers[0].ref!);
      if (room?.sequence === undefined) return;
      for (const socket of peers) {
        const account = roomAccount(room, socket.member?.account);
        if (account && this.sockets.has(socket.id) && !socket.revoked
          && [...account.coordinators.values()].some((row) => row.socket === socket.id)) {
          this.sendQueue(socket, account.queue, room.sequence);
        }
      }
    })));
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
    for (const socket of this.sockets.values()) this.forSocket(socket, () => {
      if (!this.recycleIfDue(socket)) socket.peer.ping?.();
    });
    try {
      if (this.shared.recoverWrites) await this.shared.recoverWrites();
      if (this.shared.renew) await this.renewSockets();
    } finally {
      const now = this.now().getTime();
      // If the instance that armed the grace timer stops, another instance can announce expiry
      // at its next heartbeat, up to one heartbeat later.
      const changed = await this.shared.prune(now - GONE_MS, now);
      if (changed?.length) await this.send(changed.map((room) => ({
        ...this.inSite(room.ref.tenant, () => this.announce(room)),
        ...(room.ref.tenant !== undefined && { tenant: room.ref.tenant }),
      })));
    }
  }

  get hasSockets(): boolean { return this.sockets.size > 0; }

  hasTenantSockets(tenant?: string) {
    return [...this.sockets.values()].some((socket) => socket.tenant === tenant);
  }

  /** An unavailable link must reconnect to receive the messages it missed. */
  restartSockets(tenant?: string) {
    for (const socket of this.sockets.values()) {
      if (tenant === undefined || socket.tenant === tenant) void this.restart(socket, tenant !== undefined).catch(reportLinkError);
    }
  }

  private restart(socket: Socket, revoke: boolean) {
    return this.forSocket(socket, () => {
      socket.revoked = revoke;
      socket.peer.close(RESTART_CODE, "server restart");
      return socket.closed(true);
    });
  }

  async recheckMembers(tenant: string, roleOf: (ref: RoomRef, account: string) => Promise<"viewer" | "collaborator" | null>) {
    for (const snapshot of await this.shared.rooms()) {
      const { ref } = snapshot;
      const accounts = new Set([
        ...snapshot.accounts?.keys() ?? [],
        ...[...snapshot.memberSockets?.values() ?? []].map(({ account }) => account),
      ]);
      if (!accounts.size) continue;
      const roles = new Map(await Promise.all([...accounts]
        .filter((account) => account === tenant || ref.tenant === tenant)
        .map(async (account) => [account, await roleOf(ref, account)] as const)));
      if (!roles.size) continue;
      const changed = await this.shared.editExisting(ref, (room) => {
        const sockets: string[] = [];
        let removed = false;
        for (const [account, role] of roles) {
          if (role !== "collaborator") removed = room.accounts?.delete(account) || removed;
        }
        for (const [id, { account, viewer }] of room.memberSockets ?? []) {
          if (!roles.has(account) || roles.get(account) === (viewer ? "viewer" : "collaborator")) continue;
          sockets.push(id);
          room.memberSockets!.delete(id);
          room.sockets.delete(id);
        }
        if (!room.accounts?.size) { delete room.accounts; delete room.ownerName; }
        if (!room.memberSockets?.size) delete room.memberSockets;
        return { room, sockets, removed };
      });
      if (!changed) continue;
      const { room, sockets, removed } = changed;
      const events: LinkEvent[] = [];
      if (sockets.length) events.push({ kind: "members-revoked", sockets });
      if (removed) events.push(this.announce(room), this.pages(room, "asks", { asks: this.roomAsks(room) }, true),
        this.pages(room, "progress", { nodes: this.roomProgress(room) }));
      if (events.length) await this.send(events, ref.tenant);
    }
  }

  async drop(ref: RoomRef) {
    await Promise.all([...this.sockets.values()].filter((socket) => socket.room === roomKey(ref)).map((socket) => this.restart(socket, true)));
    await this.shared.drop(ref);
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
        void this.inSite(undefined, () => this.shared.flush()).then(ok, () => ok(false));
        void this.unsubscribe.then((off) => off()).catch(reportLinkError);
      };
    });
    const cancel = this.timers.after(() => finish(), SHUTDOWN_MS);
    this.stopping = { drained: () => { cancel(); finish(); }, done };
    if (!this.sockets.size && !this.releases) this.stopping.drained();
    for (const socket of [...this.sockets.values()]) this.forSocket(socket, () => socket.peer.close(RESTART_CODE, "server restart"));
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
    const cancelRecycle = Number.isFinite(socket.recycleAt)
      ? this.timers.after(() => this.forSocket(socket, () => this.recycle(socket)), socket.recycleAt - this.now().getTime())
      : undefined;
    socket.arm = () => {
      socket.deadline?.();
      socket.deadline = null;
      if (done || socket.recycling || !peer.ping || !this.stopBeat || this.stopping || this.pongMs === 0) return;
      socket.deadline = this.timers.after(() => this.forSocket(socket, () => {
        socket.deadline = null;
        if (peer.terminate) peer.terminate();
        else peer.close();
        // The transport calls closed too, possibly much later.
        void socket.closed(true).catch(reportLinkError);
      }), this.pongMs);
    };
    socket.closed = (lost = false) => this.forSocket(socket, async () => {
      if (done) return;
      done = true;
      cancelRecycle?.();
      socket.deadline?.();
      socket.deadline = null;
      this.sockets.delete(socket.id);
      this.releases++;
      try {
        await closed(lost);
      } finally {
        this.releases--;
        if (this.stopping && !this.sockets.size && !this.releases) this.stopping.drained();
      }
    });
    this.sockets.set(socket.id, socket);
    socket.arm();
    return {
      receive: async () => this.forSocket(socket, () => { this.recycleIfDue(socket); }),
      closed: () => socket.closed(),
      pong: () => this.forSocket(socket, () => {
        if (!this.sockets.has(socket.id) || this.recycleIfDue(socket)) return;
        socket.arm();
        if (this.shared.renew && socket.ref && socket.leaseReady) void this.renewDue([socket]).catch(reportLinkError);
      }),
    };
  }

  private recycleIfDue(socket: Socket): boolean {
    if (this.now().getTime() >= socket.recycleAt) this.recycle(socket);
    return socket.recycling;
  }

  private recycle(socket: Socket) {
    if (this.closing || socket.recycling || !this.sockets.has(socket.id)) return;
    socket.recycling = true;
    socket.deadline?.();
    socket.deadline = null;
    // The transport can still receive frames until it reports the close.
    socket.peer.close(RECYCLE_CODE, "reconnect");
  }

  private socket(peer: Peer, ref: RoomRef | null, audience: Socket["audience"], allows?: Socket["allows"], tenant = ref?.tenant): Socket {
    checkLinkTenant(tenant);
    if (ref && ref.tenant !== tenant) throw new Error("link room must match socket tenant");
    const recycleAt = this.maxAgeMs > 0 ? this.now().getTime() + Math.floor(this.maxAgeMs * (1 - Math.random() / 10)) : Infinity;
    return { id: randomUUID(), peer, ref, lastSent: new Map(), queuedMessages: new Map(), renewedAt: -Infinity, leaseReady: false, room: ref && roomKey(ref), tenant, site: this.site(tenant), audience, allows, deadline: null, recycleAt, recycling: false, arm: () => {}, closed: async () => {} };
  }

  /** An upgrade that the transport admitted while the hub stops also gets a restart close. */
  private refuse(peer: Peer): Connection {
    const connection = this.track(this.socket(peer, null, null), async () => {});
    peer.close(RESTART_CODE, "server restart");
    return connection;
  }

  private envelope<T extends string, P>(ref: RoomRef, type: T, payload: P): Envelope<T, P> {
    return { v: LINK_VERSION, type, id: randomUUID(), project: ref.tenant === undefined ? ref : { workspace: ref.workspace, id: ref.id }, at: this.now().toISOString(), payload };
  }

  private pages<T extends keyof ToPage>(room: LinkRoom, type: T, payload: ToPage[T], overview = false, account?: string): LinkEvent {
    const message = this.envelope(room.ref, type, payload);
    const reduced = type === "presence" ? this.redactPresence(payload as Presence)
      : type === "changed" ? { ...(payload as ToPage["changed"]), issues: [] } : null;
    return {
      kind: "pages", message, overview, sequence: room.sequence,
      ...(account !== undefined && { account }),
      ...(reduced && { viewer: this.envelope(room.ref, type, reduced) }),
    };
  }

  private announce(room: LinkRoom): LinkEvent {
    return {
      ...this.pages(room, "presence", this.roomPresence(room), true),
      ...(room.accounts?.size && { queuedByAccount: [...room.accounts].map(([id, account]): [string, number] => [id, account.queue.length]) }),
    };
  }

  /** The coordinators of a project, connected first, and the size of its queue. */
  async presence(ref: RoomRef, account?: string): Promise<Presence> {
    const room = await this.shared.read(ref);
    return room ? this.roomPresence(room, account) : { coordinators: [], queued: 0 };
  }

  private roomPresence(room: LinkRoom, account?: string): Presence {
    const now = this.now().getTime();
    const cutoff = now - GONE_MS;
    const coordinators: CoordinatorPresence[] = roomAccounts(room).flatMap(([account, state]) => [...state.coordinators.values()]
      .filter((c) => c.socket || Date.parse(c.lastSeen) >= cutoff)
      .map((c) => ({
        session: c.hello.session, host: c.hello.host, plan: c.hello.plan, connected: !!c.socket || (c.reconnectUntil ?? 0) > now,
        mode: c.state?.mode ?? null, head: c.state?.head ?? null, since: c.since, lastSeen: c.lastSeen, lost: !!c.lost,
        paused: !!c.state?.lines.some((l) => l.level === "wait" && l.text.startsWith("paused ")),
        ...(room.accounts?.size && { accountName: account ? room.accounts.get(account)?.name : room.ownerName }),
      })))
      .sort((a, b) => Number(b.connected) - Number(a.connected) || b.lastSeen.localeCompare(a.lastSeen));
    return { coordinators, queued: roomAccount(room, account)?.queue.length ?? 0 };
  }

  /** Presence without coordinator identity, paths, work details, or queue counts. */
  async viewerPresence(ref: RoomRef): Promise<Presence> {
    return this.redactPresence(await this.presence(ref));
  }

  private redactPresence(presence: Presence): Presence {
    return {
      queued: 0,
      coordinators: presence.coordinators.map(({ accountName: _, ...c }, index) => ({
        ...c, session: String(index), host: "", plan: "", head: null,
      })),
    };
  }

  /** A viewer receives notices only while the server confirms the project is shared. */
  joinViewer(peer: Peer, ref: RoomRef | null, allows: (project: ProjectRef) => boolean, resume = false, tenant = ref?.tenant, member?: LinkMember): Promise<Connection> {
    return this.joinPageSocket(peer, ref, allows, resume, tenant, member);
  }

  /** For each room: the counts of connected coordinators, pages, queued messages, and asks. */
  async roomRefs(): Promise<RoomRef[]> {
    const refs = new Map((await this.shared.rooms()).map(({ ref }) => [roomKey(ref), ref]));
    // Another instance can delete a room before this instance checks its local sockets.
    for (const { room, ref } of this.sockets.values()) if (room && ref) refs.set(room, ref);
    return [...refs.values()];
  }

  async counts(tenant?: string): Promise<RoomCounts[]> {
    return (await this.shared.rooms()).filter((room) => room.ref.tenant === tenant).map((r) => ({
      workspace: r.ref.workspace, project: r.ref.id,
      coordinators: roomAccounts(r).reduce((count, [, account]) => count + [...account.coordinators.values()].filter((c) => c.socket).length, 0),
      pages: [...r.sockets.values()].filter((role) => role === "page").length,
      queued: r.queue.length, asks: this.roomAsks(r).length,
    }));
  }

  /** The queued messages that a coordinator can act on. */
  async waiting(ref: RoomRef, account?: string): Promise<number> {
    const room = await this.shared.read(ref);
    return (room && roomAccount(room, account))?.queue.filter((m) => m.type !== "changed").length ?? 0;
  }

  private roomAsks(room: LinkRoom) {
    if (!room.accounts?.size) return room.asks;
    return roomAccounts(room).flatMap(([id, account]) => {
      const accountName = id ? room.accounts?.get(id)?.name : room.ownerName;
      return account.asks.map((ask) => ({ ...ask, id: pageAskId(room.ref, id, ask.id), ...(accountName && { accountName }) }));
    });
  }

  async asks(ref: RoomRef) {
    const room = await this.shared.read(ref);
    return room ? this.roomAsks(room) : [];
  }

  private roomProgress(room: LinkRoom) {
    if (!room.accounts?.size) return room.progress;
    const nodes = new Map<string, LinkRoom["progress"][number]>();
    for (const [, account] of roomAccounts(room)) for (const node of account.progress) {
      const old = nodes.get(node.key);
      if (!old || (Date.parse(node.at ?? "") || 0) >= (Date.parse(old.at ?? "") || 0)) nodes.set(node.key, node);
    }
    return [...nodes.values()];
  }

  /** One open ask of a worker, as the coordinator last reported it. */
  async ask(ref: RoomRef, id: string) {
    return (await this.asks(ref)).find((a) => a.id === id) ?? null;
  }

  /** The human replied to an ask. The pages stop showing it before the coordinator reports again. */
  async answered(ref: RoomRef, id: string) {
    const room = await this.shared.removeAsk(ref, id);
    if (room) await this.send([this.pages(room, "asks", { asks: this.roomAsks(room) }, true)], ref.tenant);
  }

  /** The projects that have a connected coordinator. Its first connected socket owns the Linear check. */
  async active({ forCheck = false, includeGrace = !forCheck }: { forCheck?: boolean; includeGrace?: boolean } = {}): Promise<RoomRef[]> {
    const now = this.now().getTime();
    return (await this.shared.rooms()).flatMap((room) => {
      const coordinators = roomAccounts(room).flatMap(([, account]) => [...account.coordinators.values()]);
      const first = coordinators.find(({ socket }) => socket)?.socket;
      if (first) return !forCheck || this.sockets.has(first) ? [room.ref] : [];
      const reconnecting = includeGrace && coordinators.some((c) => (c.reconnectUntil ?? 0) > now);
      return reconnecting ? [room.ref] : [];
    });
  }

  /**
   * Send a message to each connected coordinator and keep it in the queue until acknowledgment,
   * so a busy coordinator can pick it up at its next wg next. Send changed notices to project pages too.
   */
  async publish<T extends keyof ToCoordinator>(ref: RoomRef, type: T, payload: ToCoordinator[T]): Promise<Envelope<T, ToCoordinator[T]>> {
    return (await this.enqueue(ref, type, payload)).message;
  }

  async projectChanged(ref: RoomRef, issues: string[], writer?: string) {
    const payload: ToPage["changed"] = { by: "coordinator", what: "issue", issues };
    // A page must hear each change even when the coordinator queues stay the same.
    const pages = (room: LinkRoom) => ({ ...this.pages(room, "changed", payload), sequence: undefined });
    const message = this.envelope(ref, "changed", payload);
    const updated = await this.shared.editExisting(ref, (room) => {
      const recipients = roomAccounts(room).filter(([account]) => account !== writer);
      for (const [, account] of recipients) appendMessage(account, message);
      return { room, recipients };
    });
    if (!updated) {
      // Redis can track page sockets without storing a coordinator room.
      const room = await this.shared.read(ref);
      if (room) await this.send([pages(room)], ref.tenant);
      return;
    }
    const { room, recipients } = updated;
    const events = recipients.map(([account, state]) => this.queueEvent(room,
      [...state.coordinators.values()].flatMap(({ socket }) => socket ? [socket] : []), message, false, account));
    await this.send([...events, pages(room), this.announce(room)], ref.tenant);
  }

  async enqueue<T extends keyof ToCoordinator>(ref: RoomRef, type: T, payload: ToCoordinator[T], answeredAsk?: string, id?: string, member?: LinkMember, writer?: { account?: string }) {
    const envelope = this.envelope(ref, type, payload);
    if (id !== undefined) envelope.id = id;
    const legacy = ref.tenant === undefined;
    const ownCommand = type === "command" && ["next", "dispatch"].includes((payload as ToCoordinator["command"]).name);
    const route = (room: LinkRoom) => {
      const accounts = roomAccounts(room);
      if (writer) return accounts.filter(([account]) => account !== writer.account);
      if (type === "answer") {
        // Answers identify an issue. Wake every account asking about it, or the whole room
        // if no ask identifies who runs the node.
        const matches = accounts.filter(([, state]) => state.asks.some((ask) => ask.issue === (payload as ToCoordinator["answer"]).issue));
        return matches.length ? matches : accounts;
      }
      if (ownCommand) {
        const target = roomAccount(room, member?.account);
        return target ? [[member?.account, target] as const] : [];
      }
      return accounts;
    };
    const { room, recipients, message } = legacy
      ? { room: await this.shared.append(ref, envelope, answeredAsk), recipients: [undefined], message: envelope }
      : await this.shared.edit(ref, (room) => {
        if (member && ownCommand) {
          if (!addRoomAccount(room, member.account, member.name)) throw new LinkRoomFull();
          if (member.ownerName) room.ownerName = member.ownerName;
        }
        if (type === "reply") {
          const candidates = answeredAsk && answeredAsk.length > ASK_ID_MAX
            ? room.accounts ?? [] : [[undefined, room]] as const;
          for (const [account, state] of candidates) {
            const original = state.asks.find((ask) => pageAskId(room.ref, account, ask.id) === answeredAsk);
            if (!original) continue;
            const message = { ...envelope, payload: { ...payload, ask: original.id } };
            appendMessage(state, message, original.id);
            return { room, recipients: [account], message };
          }
          throw new Error("the coordinator's question is no longer open");
        }
        const recipients = route(room);
        for (const [, account] of recipients) appendMessage(account, envelope, answeredAsk);
        return { room, recipients: recipients.map(([id]) => id), message: envelope };
      });
    const events = recipients.map((account) => this.queueEvent(room,
      [...roomAccount(room, account)!.coordinators.values()].flatMap(({ socket }) => socket ? [socket] : []), message, false, account));
    if (answeredAsk !== undefined) events.push(this.pages(room, "asks", { asks: this.roomAsks(room) }, true));
    if (type === "changed") events.push(this.pages(room, "changed", payload as ToPage["changed"]));
    events.push(this.announce(room));
    // The queue is committed. A delivery failure cannot turn the request into a retry.
    await this.send(events, ref.tenant).catch(reportLinkError);
    const target = roomAccount(room, member?.account);
    const waiting = (member || room.accounts?.size) && ownCommand
      && ![...target?.coordinators.values() ?? []].some(({ socket }) => socket);
    return { message, queued: target?.queue.length ?? 0, ...(waiting && { waiting: true }) };
  }

  async invalidate(ref: RoomRef) {
    await this.send([{ kind: "wrote", ref }], ref.tenant).catch(reportLinkError);
  }

  /** A page of one project, or the overview (no project). It gets the current state at once. */
  joinPage(peer: Peer, ref: RoomRef | null, resume = false, tenant = ref?.tenant, member?: LinkMember): Promise<Connection> {
    // A page only listens. It changes things through the HTTP API, which checks the origin and writes Linear.
    return this.joinPageSocket(peer, ref, undefined, resume, tenant, member);
  }

  private async joinPageSocket(peer: Peer, ref: RoomRef | null, allows?: (project: ProjectRef) => boolean, resume = false, tenant = ref?.tenant, member?: LinkMember): Promise<Connection> {
    if (this.closing) return this.refuse(peer);
    const socket = this.socket(peer, ref, allows ? "viewer" : "page", allows, tenant);
    socket.member = member;
    const connection = this.track(socket, async () => {
      if (ref && this.shared.closePage && !member) await this.shared.closePage(ref, socket.id);
      else if (ref) await this.editWhilePresent(ref, (room) => {
        room.sockets.delete(socket.id);
        room.memberSockets?.delete(socket.id);
        if (!room.memberSockets?.size) delete room.memberSockets;
      });
    });
    try {
      const rooms = !ref ? (await this.shared.rooms()).filter((room) => room.ref.tenant === tenant) : this.shared.openPage && !member ? [await this.shared.openPage(ref, socket.id)] : await this.shared.edit(ref, (room) => {
        room.sockets.set(socket.id, "page");
        if (member) (room.memberSockets ??= new Map()).set(socket.id, { account: member.account, viewer: !!allows });
        return [room];
      });
      socket.leaseReady = true;
      const events: LinkEvent[] = [];
      for (const room of rooms) {
        const presence = this.roomPresence(room, member?.account);
        const messages: Envelope[] = [this.envelope(room.ref, "presence", allows ? this.redactPresence(presence) : presence)];
        if (!allows) {
          // The overview counts worker questions as moves for the human.
          const asks = this.roomAsks(room);
          if (ref || asks.length) messages.push(this.envelope(room.ref, "asks", { asks }));
          if (ref) messages.push(this.envelope(room.ref, "progress", { nodes: this.roomProgress(room) }));
          const agents = roomAccount(room, member?.account)?.agents;
          if (agents) messages.push(this.envelope(room.ref, "agents", agents));
        }
        if (ref && resume) messages.push(this.envelope(room.ref, "changed", { by: "page", what: "issue", issues: [] }));
        events.push({ kind: "sockets", sockets: [socket.id], messages, sequence: room.sequence });
      }
      if (events.length) await this.send(events, tenant);
    } catch (error) {
      await connection.closed().catch(reportLinkError);
      throw error;
    }
    return connection;
  }

  /**
   * A coordinator of one project. Its first message must be `hello`; then it gets the queue. Only `wrote` and
   * `agents` may come before it: a wg command that changed Linear, or `wg agents`, sends them on a short
   * connection that is no coordinator.
   */
  async joinCoordinator(peer: Peer, ref: RoomRef, member?: LinkMember): Promise<Connection> {
    if (this.closing) return this.refuse(peer);
    const socket = this.socket(peer, ref, "coordinator");
    socket.member = member;
    const stateOf = (room: LinkRoom) => roomAccount(room, member?.account);
    const edit = <T>(change: (room: LinkRoom) => T) => this.editWhilePresent(ref, (room) =>
      !room.sockets.has(socket.id) && member ? null : change(room));
    let session: string | null = null;
    const fail = (reason: string) => peer.close(1008, reason);
    const release = (room: LinkRoom, at: string, lost = false, reconnectUntil?: number) => {
      const current = [...stateOf(room)?.coordinators.values() ?? []].find((coordinator) => coordinator.socket === socket.id);
      if (!current) return false;
      Object.assign(current, { socket: null, lost, lastSeen: at });
      if (reconnectUntil !== undefined) current.reconnectUntil = reconnectUntil;
      return true;
    };
    const connection = this.track(socket, async (lost) => {
      const at = this.now().toISOString();
      const grace = !socket.revoked && this.maxAgeMs > 0;
      const reconnectUntil = grace ? Date.parse(at) + RECONNECT_GRACE_MS : undefined;
      const room = await this.editWhilePresent(ref, (room) => {
        room.sockets.delete(socket.id);
        room.memberSockets?.delete(socket.id);
        if (!room.memberSockets?.size) delete room.memberSockets;
        return release(room, at, lost, reconnectUntil) ? room : null;
      });
      if (!room) return;
      if (reconnectUntil === undefined) {
        await this.send([this.announce(room)], ref.tenant);
      } else {
        this.timers.after(() => this.forSocket(socket, () => {
          void this.editWhilePresent(ref, (room) => expireReconnectGrace(room, reconnectUntil) ? room : null)
            .then((expired) => expired && this.send([this.announce(expired)], ref.tenant)).catch(reportLinkError);
        }), Math.max(0, reconnectUntil - this.now().getTime()));
      }
    });
    try {
      const accepted = await this.shared.edit(ref, (room) => {
        if (member) {
          if (!addRoomAccount(room, member.account, member.name)) return false;
          if (member.ownerName) room.ownerName = member.ownerName;
          (room.memberSockets ??= new Map()).set(socket.id, { account: member.account, viewer: false });
        }
        room.sockets.set(socket.id, "coordinator");
        return true;
      });
      if (!accepted) {
        fail(new LinkRoomFull().message);
        await connection.closed();
        return connection;
      }
      socket.leaseReady = true;
    } catch (error) {
      await connection.closed().catch(reportLinkError);
      throw error;
    }
    const receive: Connection["receive"] = async (raw) => {
      let message: unknown;
      try { message = JSON.parse(raw); } catch { return fail("message is not JSON"); }
      if (!isObject(message) || message.v !== LINK_VERSION || typeof message.type !== "string") return fail(`not a wg-link/${LINK_VERSION} message`);
      const payload = isObject(message.payload) ? message.payload : {};
      const at = this.now().toISOString();
      if (message.type === "wrote") {
        if (session && !this.shared.renew) await edit((room) => {
          const current = stateOf(room)?.coordinators.get(session!);
          if (current?.socket === socket.id) current.lastSeen = at;
        });
        const issues = (Array.isArray(payload.issues) ? payload.issues : []).filter((i): i is string => typeof i === "string").slice(0, 500).map((i) => i.slice(0, 50));
        const changed = this.envelope<"changed", ToPage["changed"]>(ref, "changed", { by: "coordinator", what: "issue", issues });
        if (ref.tenant !== undefined && (member || (await this.shared.read(ref))?.accounts?.size)) {
          await this.invalidate(ref);
          await this.enqueue(ref, "changed", changed.payload, undefined, undefined, undefined, { account: member?.account });
          return;
        }
        // Clear each cache before its pages reload the graph. The coordinator needs no queued copy.
        return this.send([{ kind: "wrote", ref }, {
          kind: "pages", message: changed, overview: false,
          viewer: this.envelope(ref, "changed", { ...changed.payload, issues: [] }),
        }], ref.tenant);
      }
      if (message.type === "agents") {
        const rows: AgentRow[] = (Array.isArray(payload.agents) ? payload.agents.filter(isObject) : []).slice(0, AGENTS_MAX).map((a) => ({
          id: text(a.id, 200), role: a.role === "coordinator" ? "coordinator" as const : "worker" as const, key: text(a.key, 200) || null,
          issue: text(a.issue, 50) || null, agent: text(a.agent, 50), state: text(a.state, 50), title: text(a.title, 200),
          said: text(a.said, SAID_MAX), at: text(a.at, 50) || null,
        })).filter((a) => a.id);
        const agents = { at, agents: rows };
        const room = await edit((room) => { stateOf(room)!.agents = agents; return room; });
        if (room) return this.send([this.pages(room, "agents", agents, true, member?.account)], ref.tenant);
      }
      if (message.type === "hello") {
        const hello: Hello = { plan: text(payload.plan, 200), session: text(payload.session, 200) || randomUUID(), host: text(payload.host, 200), wg: text(payload.wg, 50) };
        // A reconnect replaces the socket of the same session, including on another hub.
        // A socket that sends hello for a different session releases its previous session.
        const joined = await edit((room) => {
          if (!room.sockets.has(socket.id)) return null;
          if (session !== hello.session) release(room, at);
          const old = stateOf(room)?.coordinators.get(hello.session);
          stateOf(room)!.coordinators.set(hello.session, {
            socket: socket.id, hello, state: old?.state ?? null,
            since: old && (old.socket || (old.reconnectUntil ?? 0) > Date.parse(at)) ? old.since : at, lastSeen: at,
          });
          return { room, replaced: old?.socket };
        });
        if (!joined) return;
        const replay = session !== null;
        session = hello.session;
        const { room, replaced } = joined;
        const events: LinkEvent[] = [];
        if (replaced && replaced !== socket.id) events.push({ kind: "replaced", socket: replaced });
        events.push(this.queueEvent(room, [socket.id], undefined, replay, member?.account), this.announce(room));
        return this.send(events, ref.tenant);
      }
      if (!KNOWN.has(message.type)) {
        // A newer wg can send a type that this server does not know yet, also as its first message: ignore it,
        // and keep the connection.
        console.log(`link: ignored a message of unknown type ${logField(text(message.type, 100))} from ${logField(session ?? "(no hello yet)")}`);
        return;
      }
      if (!session) return fail("send hello first");
      const sessionId = session;
      if (!this.shared.renew) await edit((room) => {
        const current = stateOf(room)?.coordinators.get(sessionId);
        if (current?.socket === socket.id) current.lastSeen = at;
      });
      // A replaced socket can still have room updates in flight before the transport closes it.
      const type = message.type as keyof FromCoordinator;
      if (type === "state") {
        const lines = Array.isArray(payload.lines) ? payload.lines.filter(isObject).slice(0, 200).map((l) => ({ level: text(l.level, 20), text: text(l.text, 2000) })) : [];
        const room = await edit((room) => {
          const current = stateOf(room)?.coordinators.get(sessionId);
          if (current?.socket === socket.id) {
            current.state = { mode: payload.mode === "waiting" ? "waiting" : "working", head: text(payload.head, 500), lines };
          }
          return room;
        });
        if (room) await this.send([this.announce(room)], ref.tenant);
      } else if (type === "ack") {
        const ids = Array.isArray(payload.ids) ? payload.ids.filter((id): id is string => typeof id === "string") : [];
        const room = member ? await edit((room) => {
          const account = stateOf(room)!;
          if (account.coordinators.get(sessionId)?.socket !== socket.id) return null;
          account.queue = account.queue.filter((item) => !ids.includes(item.id));
          return room;
        }) : await this.shared.ack(ref, ids);
        if (room) await this.send([this.announce(room)], ref.tenant);
      } else if (type === "asks") {
        const asks = (Array.isArray(payload.asks) ? payload.asks.filter(isObject) : []).slice(0, ASKS_MAX).map((a) => ({
          id: text(a.id, ASK_ID_MAX), key: text(a.key, 200) || null, issue: text(a.issue, 50) || null, from: text(a.from, 200), body: text(a.body), at: text(a.at, 50),
          ...(a.kind === "escalation" ? { kind: "escalation" as const } : {}),
        })).filter((a) => a.id);
        const room = member ? await edit((room) => {
          const account = stateOf(room)!;
          if (account.coordinators.get(sessionId)?.socket !== socket.id) return null;
          account.asks = asks;
          return room;
        }) : await this.shared.setAsks(ref, asks);
        if (room) await this.send([this.pages(room, "asks", { asks: this.roomAsks(room) }, true)], ref.tenant);
      } else if (type === "progress") {
        const progress = (Array.isArray(payload.nodes) ? payload.nodes.filter(isObject) : []).slice(0, 500).map((n) => ({
          key: text(n.key, 200), issue: text(n.issue, 50) || null, job: text(n.job, 50) || null, state: text(n.state, 50) || null,
          ci: text(n.ci, 200) || null, evidence: text(n.evidence, 500) || null, at: text(n.at, 50) || null,
        })).filter((n) => n.key);
        const room = await edit((room) => { stateOf(room)!.progress = progress; return room; });
        if (room) await this.send([this.pages(room, "progress", { nodes: this.roomProgress(room) })], ref.tenant);
      }
    };
    let transportClosed = false;
    return {
      pong: connection.pong,
      closed: () => { transportClosed = true; return connection.closed(); },
      receive: (raw) => this.forSocket(socket, async () => {
        if (transportClosed || socket.revoked) return;
        try {
          await receive(raw);
        } finally {
          this.recycleIfDue(socket);
        }
      }),
    };
  }
}
