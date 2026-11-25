import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Envelope, ProjectRef } from "../src/lib/link.ts";
import { emptyRoom, expireReconnectGrace, pruneRoom, QUEUE_MAX, type Coordinator, type LinkRoom, type LinkRoomState } from "./linkstate.ts";
import { LINK_PREFIX, type RedisLink } from "./redis.ts";
import { ASKS_MAX } from "./store.ts";

// Compare the snapshot before changing it so concurrent acknowledgments preserve other messages.
const writeRoom = `
local current = redis.call("GET", KEYS[1]) or ""
if current ~= ARGV[1] then return 0 end
if ARGV[4] == "1" then redis.call("SET", KEYS[3], current, "PX", 86400000) end
local sequence = redis.call("INCR", KEYS[2])
if ARGV[2] == "" then redis.call("DEL", KEYS[1])
else redis.call("SET", KEYS[1], tostring(sequence) .. "\\n" .. ARGV[2]) end
for i = 4, #KEYS do redis.call("SET", KEYS[i], "1", "PX", ARGV[3]) end
return sequence
`;
const pageClock = `
local clock = redis.call("TIME")
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
`;
const openPage = pageClock + `
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", now)
redis.call("ZADD", KEYS[1], now + tonumber(ARGV[2]), ARGV[1])
redis.call("PEXPIRE", KEYS[1], ARGV[2])
`;
const renewLeases = pageClock + `
local renewed = {}
for i = 1, #KEYS do
  local page = ARGV[3 + i]
  if page ~= "" then
    local expiry = redis.call("ZSCORE", KEYS[i], page)
    if expiry and tonumber(expiry) > now then
      redis.call("ZADD", KEYS[i], now + tonumber(ARGV[2]), page)
      redis.call("PEXPIRE", KEYS[i], ARGV[2])
      renewed[#renewed + 1] = i
    end
  elseif redis.call("SET", KEYS[i], ARGV[1], "PX", ARGV[2], "XX") then
    redis.call("SET", KEYS[i] .. ":seen", ARGV[1], "PX", ARGV[3])
    renewed[#renewed + 1] = i
  end
end
return renewed
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
  const pagePrefix = prefix + "pages:";
  const refKey = ({ workspace, id }: ProjectRef) => JSON.stringify([workspace, id]);
  const key = (ref: ProjectRef) => roomPrefix + refKey(ref);
  const pageKey = (ref: ProjectRef) => pagePrefix + refKey(ref);
  const leaseKey = (roomKey: string, socket: string) => prefix + "socket:" + JSON.stringify([roomKey, socket]);
  const malformed = new Set<string>();
  const load = async (roomKey: string) => {
    const raw = await redis.run((client) => client.get(roomKey));
    if (raw === null) return { raw: "", json: "", room: null, expired: false };
    const separator = raw.indexOf("\n");
    const sequence = Number(raw.slice(0, separator));
    const json = raw.slice(separator + 1);
    let room: LinkRoom;
    let notifyPresence: boolean | undefined;
    const storedSeen = new Map<string, string>();
    try {
      const { sockets, coordinators, notifyPresence: notify, ...data }: SavedRoom = JSON.parse(json);
      if (!Number.isSafeInteger(sequence) || sequence < 1 || !Array.isArray(sockets) || !Array.isArray(coordinators)
          || !data.ref || key(data.ref) !== roomKey || !Array.isArray(data.queue) || !Array.isArray(data.asks)
          || !Array.isArray(data.progress)) throw new Error();
      room = { ...data, sequence, sockets: new Map(sockets), coordinators: new Map(coordinators) };
      // Validate coordinator rows before a malformed snapshot reaches another room's read or prune.
      for (const row of room.coordinators.values()) if (!row || typeof row.lastSeen !== "string") throw new Error();
      notifyPresence = notify;
      malformed.delete(roomKey);
    } catch {
      if (!malformed.has(roomKey)) console.warn("Redis skipped malformed room", roomKey);
      malformed.add(roomKey);
      return { raw, json, room: null, expired: false, corrupt: true };
    }
    const ids = [...socketIds(room)];
    const active = new Map<string, string>();
    const lastSeen = new Map<string, string>();
    if (ids.length) {
      const leases = await redis.run((client) => client.mget(...ids.flatMap((id) => {
        const lease = leaseKey(roomKey, id);
        return [lease, lease + ":seen"];
      })));
      ids.forEach((id, i) => {
        if (leases[2 * i]) active.set(id, leases[2 * i]!);
        else room.sockets.delete(id);
        if (leases[2 * i + 1]) lastSeen.set(id, leases[2 * i + 1]!);
      });
    }
    let expired = notifyPresence ?? false;
    for (const [session, coordinator] of room.coordinators) {
      storedSeen.set(session, coordinator.lastSeen);
      const socket = coordinator.socket;
      if (!socket) continue;
      const seen = lastSeen.get(socket);
      if (seen && seen > coordinator.lastSeen) coordinator.lastSeen = seen;
      if (!active.has(socket)) {
        Object.assign(coordinator, { socket: null, lost: true });
        expired = true;
      }
    }
    return { raw, json, room, expired, storedSeen };
  };
  const roomKeys = async (keyPrefix = roomPrefix) => {
    const keys = new Set<string>();
    let cursor = "0";
    do {
      const [next, batch] = await redis.run((client) => client.scan(cursor, "MATCH", keyPrefix.replace(/[[\\*?]/g, "\\$&") + "*", "COUNT", 100));
      batch.forEach((item) => keys.add(item));
      cursor = next;
    } while (cursor !== "0");
    return [...keys];
  };
  const update = async <T>(
    roomKey: string, ref: ProjectRef | null, change: (room: LinkRoom, expired: boolean) => T,
    { prune = false }: { prune?: boolean } = {},
  ): Promise<T | null> => {
    const until = performance.now() + 2_000;
    do {
      const { raw, json, room: loaded, expired, storedSeen, corrupt } = await load(roomKey);
      const room = loaded ?? (ref && emptyRoom(ref));
      if (!room) return null;
      const before = socketIds(room);
      const beforeSeen = new Map([...room.coordinators].map(([id, row]) => [id, row.lastSeen]));
      const result = change(room, expired);
      const leases = [...socketIds(room)]
        .filter((id) => !before.has(id)).map((id) => leaseKey(roomKey, id));
      const encoded = prune && result === false ? "" : JSON.stringify({
        ...room, sequence: undefined, sockets: [...room.sockets],
        coordinators: [...room.coordinators].map(([id, row]) => [id, row.socket && beforeSeen.get(id) === row.lastSeen
          ? { ...row, lastSeen: storedSeen?.get(id) ?? row.lastSeen } : row]),
        ...(expired && !prune && { notifyPresence: true }),
      });
      if (!corrupt && encoded === json && !leases.length) return result;
      const archive = corrupt ? prefix + "corrupt:" + roomKey + ":" + randomUUID() : roomKey;
      const sequence = await redis.write((client) => client.eval(
        writeRoom, 3 + leases.length, roomKey, prefix + "sequence", archive, ...leases, raw, encoded, leaseMs, corrupt ? "1" : "0",
      ));
      if (typeof sequence === "number" && sequence > 0) {
        room.sequence = sequence;
        if (corrupt) malformed.delete(roomKey);
        return result;
      }
      await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 20));
    } while (performance.now() < until);
    throw new Error("Redis link room is busy");
  };
  const edit = <T>(ref: ProjectRef, change: (room: LinkRoom) => T) => update(key(ref), ref, change) as Promise<T>;
  const append = (ref: ProjectRef, message: Envelope, answeredAsk?: string) => edit(ref, (room) => {
    if (room.queue.some(({ id }) => id === message.id)) return room;
    room.queue.push(message);
    if (answeredAsk !== undefined) room.asks = room.asks.filter((ask) => ask.id !== answeredAsk);
    if (room.queue.length > QUEUE_MAX) {
      const firstChanged = room.queue.findIndex((item) => item.type === "changed");
      room.queue.splice(firstChanged < 0 ? 0 : firstChanged, 1);
    }
    return room;
  });
  const renew: NonNullable<LinkRoomState["renew"]> = async (sockets, at) => {
    if (!sockets.length) return new Set();
    const keys = sockets.map(({ ref, socket, page }) => page ? pageKey(ref) : leaseKey(key(ref), socket));
    const indices = await redis.write((client) => client.eval(
      renewLeases, keys.length, ...keys, at, leaseMs, 24 * 60 * 60_000,
      ...sockets.map(({ page, socket }) => page ? socket : ""),
    )) as number[];
    return new Set(indices.map((index) => sockets[index - 1].socket));
  };
  const sessionExpiry = async (id: string) => {
    const expiry = await redis.run((client) => client.get(prefix + "ended:" + id), false);
    return expiry === null ? null : Number(expiry);
  };
  const pageCutoff = async () => {
    const [seconds, micros] = await redis.run((client) => client.time());
    return "(" + (Number(seconds) * 1000 + Math.floor(Number(micros) / 1000));
  };
  const withPages = async (ref: ProjectRef, room: LinkRoom | null, cutoff?: string) => {
    const min = cutoff ?? await pageCutoff();
    const pages = await redis.run((client) => client.zrangebyscore(pageKey(ref), min, "+inf"));
    if (!room && !pages.length) return null;
    const snapshot = room ?? { ...emptyRoom(ref), sequence: 0 };
    for (const id of pages) snapshot.sockets.set(id, "page");
    return snapshot;
  };
  return {
    async read(ref) { return withPages(ref, (await load(key(ref))).room); },
    async rooms() {
      const [keys, pageKeys] = await Promise.all([roomKeys(), roomKeys(pagePrefix)]);
      const rooms = new Map<string, LinkRoom>();
      await Promise.all(keys.map(async (roomKey) => {
        const { room } = await load(roomKey);
        if (room) rooms.set(refKey(room.ref), room);
      }));
      const ids = new Set([...rooms.keys(), ...pageKeys.map((page) => page.slice(pagePrefix.length))]);
      const cutoff = ids.size ? await pageCutoff() : undefined;
      const snapshots = await Promise.all([...ids].map(async (id) => {
        const room = rooms.get(id);
        let ref: ProjectRef;
        try {
          const [workspace, project] = JSON.parse(id);
          if (typeof workspace !== "string" || typeof project !== "string") return null;
          ref = { workspace, id: project };
        } catch { return null; }
        return withPages(ref, room ?? null, cutoff);
      }));
      return snapshots.filter((room) => room !== null);
    },
    async openPage(ref, socket) {
      await redis.write((client) => client.eval(openPage, 1, pageKey(ref), socket, leaseMs));
      return (await load(key(ref))).room ?? { ...emptyRoom(ref), sequence: 0 };
    },
    async closePage(ref, socket) {
      await redis.write((client) => client.zrem(pageKey(ref), socket));
    },
    async recoverWrites() {
      if (redis.refusesWrites) await redis.checkWrites(true);
    },
    edit, append,
    renew,
    async refresh(ref, socket, at) {
      return (await renew([{ ref, socket }], at)).has(socket);
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
    async prune(cutoff, now) {
      const changed: LinkRoom[] = [];
      const keys = await roomKeys();
      const min = keys.length ? await pageCutoff() : "+inf";
      for (const roomKey of keys) {
        const pageKey = pagePrefix + roomKey.slice(roomPrefix.length);
        const pages = await redis.run((client) => client.zcount(pageKey, min, "+inf"));
        const result = await update(roomKey, null, (room, expired) => {
          if (!pruneRoom(room, cutoff) && pages === 0) return false;
          const graceExpired = now !== undefined && expireReconnectGrace(room, now);
          return expired || graceExpired ? room : true;
        }, { prune: true });
        if (result && result !== true) changed.push(result);
      }
      return changed;
    },
    async endSession(id, expiresAt, now) {
      if (expiresAt > now) await redis.write((client) => client.eval(endSession, 1, prefix + "ended:" + id, expiresAt, expiresAt - now), false);
    },
    sessionExpiry,
    async sessionEnded(id, now) { return (await sessionExpiry(id) ?? 0) > now; },
    async flush() { return true; },
  };
}
