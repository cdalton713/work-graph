import { type Agents, type Ask, type CoordinatorState, type Envelope, type Hello, type Progress, type ProjectRef, projectKey } from "../src/lib/link.ts";
import { ASKS_MAX, type LinkState as SavedState, type Store } from "./store.ts";

/** The longest queue of a project. The oldest changed notice goes first. */
export const QUEUE_MAX = 100;

export interface Coordinator {
  socket: string | null;
  hello: Hello;
  state: CoordinatorState | null;
  since: string;
  lastSeen: string;
  lost?: boolean;
  reconnectUntil?: number;
}

export interface LinkRoom {
  ref: ProjectRef;
  sequence?: number;
  queue: Envelope[];
  asks: Ask[];
  coordinators: Map<string, Coordinator>;
  /** IDs of project sockets, including coordinators that have sent no hello yet. */
  sockets: Map<string, "coordinator" | "page">;
  progress: Progress[];
  agents: Agents | null;
}

export interface LinkRoomState {
  read(ref: ProjectRef): Promise<LinkRoom | null>;
  rooms(): Promise<LinkRoom[]>;
  /**
   * Atomically edit a room, creating it if needed. The callback can be retried and must have no external effects.
   * An edit does not schedule a save of the queue or asks. Use the methods below to change those fields.
   */
  edit<T>(ref: ProjectRef, change: (room: LinkRoom) => T): Promise<T>;
  append(ref: ProjectRef, message: Envelope, answeredAsk?: string): Promise<LinkRoom>;
  ack(ref: ProjectRef, ids: string[]): Promise<LinkRoom>;
  setAsks(ref: ProjectRef, asks: Ask[]): Promise<LinkRoom>;
  removeAsk(ref: ProjectRef, id: string): Promise<LinkRoom | null>;
  prune(cutoff: number, now?: number): Promise<void | LinkRoom[]>;
  endSession(id: string, expiresAt: number, now: number): Promise<void>;
  sessionEnded(id: string, now: number): Promise<boolean>;
  flush(): Promise<boolean>;
  renew?(sockets: { ref: ProjectRef; socket: string; page?: boolean }[], at: string): Promise<Set<string>>;
  openPage?(ref: ProjectRef, socket: string): Promise<LinkRoom>;
  closePage?(ref: ProjectRef, socket: string): Promise<void>;
  recoverWrites?(): Promise<void>;
  sessionExpiry?(id: string): Promise<number | null>;
  refresh?(ref: ProjectRef, socket: string, at: string): Promise<boolean>;
}

export const emptyRoom = (ref: ProjectRef): LinkRoom => ({
  ref, queue: [], asks: [], coordinators: new Map(), sockets: new Map(), progress: [], agents: null,
});

export function memoryLinkState(store: Store | null = null): LinkRoomState {
  const rooms = new Map<string, LinkRoom>();
  const ended = new Map<string, number>();
  for (const { ref, queue, asks } of store?.load().rooms ?? []) {
    rooms.set(projectKey(ref), { ...emptyRoom(ref), queue: queue.slice(-QUEUE_MAX), asks: asks.slice(0, ASKS_MAX) });
  }
  const roomOf = (ref: ProjectRef) => rooms.get(projectKey(ref));
  const write = (room: LinkRoom) => rooms.set(projectKey(room.ref), room);
  const saved = (): SavedState => ({ rooms: [...rooms.values()].map(({ ref, queue, asks }) => ({ ref, queue, asks })) });
  const save = () => store?.save(saved);

  return {
    async read(ref) {
      return structuredClone(roomOf(ref) ?? null);
    },
    async rooms() {
      return structuredClone([...rooms.values()]);
    },
    async edit(ref, change) {
      const draft = structuredClone(roomOf(ref) ?? emptyRoom(ref));
      const result = change(draft);
      write(structuredClone(draft));
      return result;
    },
    async append(ref, message, answeredAsk) {
      const room = roomOf(ref) ?? emptyRoom(structuredClone(ref));
      if (room.queue.some(({ id }) => id === message.id)) return structuredClone(room);
      room.queue.push(structuredClone(message));
      if (answeredAsk !== undefined) room.asks = room.asks.filter((ask) => ask.id !== answeredAsk);
      if (room.queue.length > QUEUE_MAX) {
        const firstChanged = room.queue.findIndex((item) => item.type === "changed");
        room.queue.splice(firstChanged < 0 ? 0 : firstChanged, 1);
      }
      write(room);
      save();
      return structuredClone(room);
    },
    async ack(ref, ids) {
      const room = roomOf(ref) ?? emptyRoom(structuredClone(ref));
      const received = new Set(ids);
      const before = room.queue.length;
      room.queue = room.queue.filter((message) => !received.has(message.id));
      if (room.queue.length !== before) save();
      // Flush at once so a restart does not replay an acknowledged message.
      // A full queue can drop a message that the file still holds.
      store?.flush();
      return structuredClone(room);
    },
    async setAsks(ref, asks) {
      const room = roomOf(ref) ?? emptyRoom(structuredClone(ref));
      room.asks = structuredClone(asks.slice(0, ASKS_MAX));
      write(room);
      save();
      return structuredClone(room);
    },
    async removeAsk(ref, id) {
      const room = roomOf(ref);
      if (!room) return null;
      room.asks = room.asks.filter((ask) => ask.id !== id);
      save();
      return structuredClone(room);
    },
    async prune(cutoff, now) {
      const changed: LinkRoom[] = [];
      for (const [key, room] of rooms) {
        if (!pruneRoom(room, cutoff)) rooms.delete(key);
        else if (now !== undefined && expireReconnectGrace(room, now)) changed.push(structuredClone(room));
      }
      return changed;
    },
    async endSession(id, expiresAt, now) {
      for (const [session, expiry] of ended) if (expiry <= now) ended.delete(session);
      if (expiresAt > now) ended.set(id, Math.max(expiresAt, ended.get(id) ?? 0));
    },
    async sessionEnded(id, now) {
      return (ended.get(id) ?? -Infinity) > now;
    },
    async flush() {
      return store?.flush() ?? true;
    },
  };
}

export function expireReconnectGrace(room: LinkRoom, now: number): boolean {
  let expired = false;
  for (const coordinator of room.coordinators.values()) {
    if (coordinator.reconnectUntil !== undefined && coordinator.reconnectUntil <= now) {
      delete coordinator.reconnectUntil;
      expired = true;
    }
  }
  return expired;
}

export function pruneRoom(room: LinkRoom, cutoff: number): boolean {
  for (const [session, coordinator] of room.coordinators) {
    if (!coordinator.socket && Date.parse(coordinator.lastSeen) < cutoff) room.coordinators.delete(session);
  }
  if (room.agents && Date.parse(room.agents.at) < cutoff) room.agents = null;
  return !!(room.sockets.size || room.coordinators.size || room.queue.length || room.asks.length || room.agents);
}
