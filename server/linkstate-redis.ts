import type { Envelope, ProjectRef } from "../src/lib/link.ts";
import { emptyRoom, pruneRoom, QUEUE_MAX, type Coordinator, type LinkRoom, type LinkRoomState } from "./linkstate.ts";
import { LINK_PREFIX, type RedisLink } from "./redis.ts";
import { ASKS_MAX } from "./store.ts";

// Compare the snapshot before changing it so concurrent acknowledgments preserve other messages.
const writeRoom = `
local current = redis.call("GET", KEYS[1]) or ""
if current ~= ARGV[1] then return 0 end
local sequence = redis.call("INCR", KEYS[2])
if ARGV[2] == "" then redis.call("DEL", KEYS[1])
else redis.call("SET", KEYS[1], tostring(sequence) .. "\\n" .. ARGV[2]) end
for i = 3, #KEYS do redis.call("SET", KEYS[i], "1", "PX", ARGV[3]) end
return sequence
`;
const endSession = `
local expiry = redis.call("GET", KEYS[1])
if not expiry or tonumber(expiry) < tonumber(ARGV[1]) then
  redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[2])
end
`;

type SavedRoom = Omit<LinkRoom, "coordinators" | "sockets"> & {
  coordinators: [string, Coordinator][];
  sockets: [string, "coordinator" | "page"][];
  notifyPresence?: boolean;
};

function socketIds(room: LinkRoom): Set<string> {
  const ids = new Set(room.sockets.keys());
  for (const { socket } of room.coordinators.values()) if (socket) ids.add(socket);
  return ids;
}

export function redisLinkState(redis: RedisLink, prefix = LINK_PREFIX, leaseMs = 60_000): LinkRoomState {
  const roomPrefix = prefix + "room:";
  const key = ({ workspace, id }: ProjectRef) => roomPrefix + JSON.stringify([workspace, id]);
  const leaseKey = (roomKey: string, socket: string) => prefix + "socket:" + JSON.stringify([roomKey, socket]);
  const load = async (roomKey: string) => {
    const raw = await redis.run((client) => client.get(roomKey));
    if (!raw) return { raw: "", json: "", room: null, expired: false };
    const separator = raw.indexOf("\n");
    const sequence = Number(raw.slice(0, separator));
    const json = raw.slice(separator + 1);
    const { sockets, coordinators, notifyPresence, ...data }: SavedRoom = JSON.parse(json);
    const room: LinkRoom = { ...data, sequence, sockets: new Map(sockets), coordinators: new Map(coordinators) };
    const ids = [...socketIds(room)];
    const active = new Set<string>();
    if (ids.length) {
      const leases = await redis.run((client) => client.mget(...ids.map((id) => leaseKey(roomKey, id))));
      ids.forEach((id, i) => {
        if (leases[i]) active.add(id);
        else room.sockets.delete(id);
      });
    }
    let expired = notifyPresence ?? false;
    for (const coordinator of room.coordinators.values()) {
      if (coordinator.socket && !active.has(coordinator.socket)) {
        Object.assign(coordinator, { socket: null, lost: true });
        expired = true;
      }
    }
    return { raw, json, room, expired };
  };
  const roomKeys = async () => {
    const keys = new Set<string>();
    let cursor = "0";
    do {
      const [next, batch] = await redis.run((client) => client.scan(cursor, "MATCH", roomPrefix.replace(/[[\\*?]/g, "\\$&") + "*", "COUNT", 100));
      batch.forEach((item) => keys.add(item));
      cursor = next;
    } while (cursor !== "0");
    return [...keys];
  };
  const update = async <T>(
    roomKey: string, ref: ProjectRef | null, change: (room: LinkRoom, expired: boolean) => T,
    { prune = false, refresh }: { prune?: boolean; refresh?: string } = {},
  ): Promise<T | null> => {
    for (let attempt = 0; attempt < 32; attempt++) {
      const { raw, json, room: loaded, expired } = await load(roomKey);
      const room = loaded ?? (ref && emptyRoom(ref));
      if (!room) return null;
      const before = socketIds(room);
      const result = change(room, expired);
      const leases = [...socketIds(room)]
        .filter((id) => !before.has(id) || id === refresh).map((id) => leaseKey(roomKey, id));
      const encoded = prune && result === false ? "" : JSON.stringify({
        ...room, sequence: undefined, coordinators: [...room.coordinators], sockets: [...room.sockets],
        ...(expired && !prune && { notifyPresence: true }),
      });
      if (encoded === json && !leases.length) return result;
      const sequence = await redis.run((client) => client.eval(
        writeRoom, 2 + leases.length, roomKey, prefix + "sequence", ...leases, raw, encoded, leaseMs,
      ));
      if (typeof sequence === "number" && sequence > 0) {
        room.sequence = sequence;
        return result;
      }
    }
    throw new Error("Redis link room is busy");
  };
  const edit = <T>(ref: ProjectRef, change: (room: LinkRoom) => T) => update(key(ref), ref, change) as Promise<T>;
  const append = (ref: ProjectRef, message: Envelope, answeredAsk?: string) => edit(ref, (room) => {
    room.queue.push(message);
    if (answeredAsk !== undefined) room.asks = room.asks.filter((ask) => ask.id !== answeredAsk);
    if (room.queue.length > QUEUE_MAX) {
      const firstChanged = room.queue.findIndex((item) => item.type === "changed");
      room.queue.splice(firstChanged < 0 ? 0 : firstChanged, 1);
    }
    return room;
  });
  return {
    async read(ref) { return (await load(key(ref))).room; },
    async rooms() {
      const rooms = await Promise.all((await roomKeys()).map(async (roomKey) => (await load(roomKey)).room));
      return rooms.filter((room) => room !== null);
    },
    edit, append,
    async refresh(ref, socket, at) {
      return Boolean(await update(key(ref), null, (room) => {
        if (!room.sockets.has(socket)) return false;
        for (const coordinator of room.coordinators.values()) {
          if (coordinator.socket === socket && coordinator.lastSeen < at) coordinator.lastSeen = at;
        }
        return true;
      }, { refresh: socket }));
    },
    ack(ref, ids) {
      const received = new Set(ids);
      return edit(ref, (room) => {
        room.queue = room.queue.filter((item) => !received.has(item.id));
        return room;
      });
    },
    setAsks(ref, asks) {
      return edit(ref, (room) => { room.asks = asks.slice(0, ASKS_MAX); return room; });
    },
    removeAsk(ref, id) {
      return update(key(ref), null, (room) => {
        room.asks = room.asks.filter((ask) => ask.id !== id);
        return room;
      });
    },
    async prune(cutoff) {
      const changed: LinkRoom[] = [];
      for (const roomKey of await roomKeys()) {
        const result = await update(roomKey, null, (room, expired) => {
          if (!pruneRoom(room, cutoff)) return false;
          return expired ? room : true;
        }, { prune: true });
        if (result && result !== true) changed.push(result);
      }
      return changed;
    },
    async endSession(id, expiresAt, now) {
      if (expiresAt > now) await redis.run((client) => client.eval(endSession, 1, prefix + "ended:" + id, expiresAt, expiresAt - now));
    },
    async sessionEnded(id, now) {
      const expiry = await redis.run((client) => client.get(prefix + "ended:" + id));
      return expiry !== null && Number(expiry) > now;
    },
    async flush() { return true; },
  };
}
