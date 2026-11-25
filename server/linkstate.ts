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
}

export interface LinkRoom {
  ref: ProjectRef;
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
  /** Atomically edit a room, creating it if needed. The callback can be retried and must have no external effects. */
  edit<T>(ref: ProjectRef, change: (room: LinkRoom) => T): Promise<T>;
  append(ref: ProjectRef, message: Envelope): Promise<LinkRoom>;
  ack(ref: ProjectRef, ids: string[]): Promise<LinkRoom>;
  setAsks(ref: ProjectRef, asks: Ask[]): Promise<LinkRoom>;
  removeAsk(ref: ProjectRef, id: string): Promise<LinkRoom | null>;
  prune(cutoff: number): Promise<void>;
  endSession(id: string, expiresAt: number, now: number): Promise<void>;
  sessionEnded(id: string, now: number): Promise<boolean>;
  flush(): Promise<boolean>;
}

const emptyRoom = (ref: ProjectRef): LinkRoom => ({
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
    async append(ref, message) {
      const room = roomOf(ref) ?? emptyRoom(structuredClone(ref));
      room.queue.push(structuredClone(message));
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
    async prune(cutoff) {
      for (const [key, room] of rooms) {
        for (const [session, coordinator] of room.coordinators) {
          if (!coordinator.socket && Date.parse(coordinator.lastSeen) < cutoff) room.coordinators.delete(session);
        }
        if (room.agents && Date.parse(room.agents.at) < cutoff) room.agents = null;
        if (!room.sockets.size && !room.coordinators.size && !room.queue.length && !room.asks.length && !room.agents) rooms.delete(key);
      }
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
