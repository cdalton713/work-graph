import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, vi, expect, it } from "vitest";
import { redisLinkBus } from "./linkbus-redis.ts";
import { redisLinkState } from "./linkstate-redis.ts";
import { linkStateContract } from "./testing/linkstate-contract.ts";
import { connectRedis, type RedisLink } from "./redis.ts";
import { startTestRedis, testRedis } from "./testing/redis.ts";

describe.skipIf(!testRedis)("Redis link state", () => {
  let server: Awaited<ReturnType<typeof startTestRedis>>;
  let first: RedisLink, second: RedisLink;
  beforeAll(async () => {
    server = await startTestRedis();
    first = connectRedis(server.url);
    second = connectRedis(server.url);
    await vi.waitFor(() => expect(first.ready && second.ready).toBe(true));
  });
  afterAll(async () => { first?.close(); second?.close(); await server?.close(); });

  linkStateContract(() => {
    const prefix = `test:${randomUUID()}:`;
    return {
      a: redisLinkState(first, prefix), b: redisLinkState(second, prefix), cleanup: () => {},
    };
  });

  it("uses the config Redis room and event formats from main", async () => {
    const prefix = `test:${randomUUID()}:`;
    const redis = connectRedis(server.url, prefix);
    const ref = { workspace: "work", id: "p1" };
    const message = { v: 1 as const, type: "command", id: "next", project: ref, at: "", payload: { name: "next", key: null, issue: null } };
    const room = prefix + 'room:["work","p1"]';
    try {
      await redis.waitReady();
      const state = redisLinkState(redis, prefix);
      await state.append(ref, message);
      const keys = await redis.run((client) => client.keys(prefix + "*"));
      expect(keys.filter((key) => !key.startsWith(prefix + "write-check:")).sort()).toEqual([room, prefix + "sequence"]);
      const saved = await redis.run((client) => client.get(room));
      expect(saved).toBe('1\n{"ref":{"workspace":"work","id":"p1"},"queue":[{"v":1,"type":"command","id":"next","project":{"workspace":"work","id":"p1"},"at":"","payload":{"name":"next","key":null,"issue":null}}],"asks":[],"coordinators":[],"sockets":[],"progress":[],"agents":null}');
      const received = new Promise<string>((resolve) => redis.onMessage(resolve));
      await redisLinkBus(redis, prefix).publish([{ kind: "wrote", ref }]);
      expect(await received).toBe('[{"kind":"wrote","ref":{"workspace":"work","id":"p1"}}]');
    } finally {
      redis.close();
    }
  });

  it("loads and rewrites the legacy service room without adding account fields", async () => {
    const prefix = `test:${randomUUID()}:`;
    const ref = { workspace: "work", id: "p1", tenant: "owner" };
    const key = prefix + 'room:["work","p1","owner"]';
    const before = '1\n{"ref":{"workspace":"work","id":"p1","tenant":"owner"},"queue":[],"asks":[],"coordinators":[],"sockets":[],"progress":[],"agents":null}';
    const state = redisLinkState(first, prefix);
    await first.run((client) => client.set(key, before));
    await first.run((client) => client.set(prefix + "sequence", "1"));
    expect(await state.read(ref)).toMatchObject({ ref, queue: [], asks: [], coordinators: new Map() });
    const ask = { id: "ask", key: null, issue: null, from: "worker", body: "Question", at: "" };
    await state.setAsks(ref, [ask]);
    expect(await first.run((client) => client.get(key))).toBe(
      before.replace(/^1/, "2").replace('"asks":[]', '"asks":' + JSON.stringify([ask]))
        .replace('"coordinators":[],"sockets":[],"progress":[],"agents":null', '"progress":[],"agents":null,"sockets":[],"coordinators":[]'),
    );
  });

  it("updates last seen at a heartbeat and marks a coordinator lost after its instance dies", async () => {
    const prefix = `test:${randomUUID()}:`;
    const a = redisLinkState(first, prefix, 300);
    const b = redisLinkState(second, prefix, 300);
    const ref = { workspace: "work", id: "project" };
    const socket = "socket";
    const seen = "2026-11-25T00:00:01.000Z";
    await a.edit(ref, (room) => {
      room.sockets.set(socket, "coordinator");
      room.coordinators.set("session", {
        socket, hello: { host: "example.com", plan: "project", session: "session", wg: "1" },
        since: "2026-11-25T00:00:00.000Z", lastSeen: "2026-11-25T00:00:00.000Z", state: null,
      });
    });
    await a.refresh!(ref, socket, seen);
    expect((await b.read(ref))?.coordinators.get("session")).toMatchObject({ socket, lastSeen: seen });
    await vi.waitFor(async () => {
      expect((await b.read(ref))?.coordinators.get("session")).toMatchObject({ socket: null, lost: true, lastSeen: seen });
    });
    await a.edit(ref, (room) => { room.agents = { at: seen, agents: [] }; });
    expect(await b.prune(0)).toEqual([expect.objectContaining({
      coordinators: new Map([["session", expect.objectContaining({ socket: null, lost: true })]]),
    })]);
    expect(await a.prune(0)).toEqual([]);
  });

  it("keeps the connection ready when Redis rejects a command", async () => {
    const prefix = `test:${randomUUID()}:`;
    const key = prefix + "wrong-type";
    await first.run((client) => client.set(key, "private value"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(first.run((client) => client.lpop(key))).rejects.toThrow("Redis command failed");
      expect(first.ready).toBe(true);
      expect(warn.mock.calls).toEqual([["Redis command failed", "WRONGTYPE"]]);
      expect(await first.run((client) => client.get(key))).toBe("private value");
    } finally { warn.mockRestore(); }
  });

  it("queues a caller's ID only once even when two instances append it", async () => {
    const prefix = `test:${randomUUID()}:`;
    const a = redisLinkState(first, prefix), b = redisLinkState(second, prefix);
    const ref = { workspace: "work", id: "project" };
    const message = { v: 1 as const, id: "same", type: "command", project: ref, at: "", payload: {} };
    await Promise.all([a.append(ref, message), b.append(ref, message)]);
    expect((await a.read(ref))?.queue).toEqual([message]);
  });

  it("skips a malformed room without logging its contents", async () => {
    const prefix = `test:${randomUUID()}:`;
    const state = redisLinkState(first, prefix);
    const key = prefix + 'room:["work","broken"]';
    await first.run((client) => client.set(key, "private malformed value"));
    await state.edit({ workspace: "work", id: "good" }, () => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await state.rooms()).map(({ ref }) => ref.id)).toEqual(["good"]);
      expect(warn.mock.calls.flat().join(" ")).toContain(key);
      expect(warn.mock.calls.flat().join(" ")).not.toContain("private malformed value");
      await state.edit({ workspace: "work", id: "broken" }, () => {});
      const archives = await first.run((client) => client.keys(prefix + "corrupt:*"));
      expect(archives).toHaveLength(1);
      expect(await first.run((client) => client.get(archives[0]))).toBe("private malformed value");
      expect(await first.run((client) => client.pttl(archives[0]))).toBeGreaterThan(0);
      expect((await state.read({ workspace: "work", id: "broken" }))?.queue).toEqual([]);
      expect(warn).toHaveBeenCalledOnce();
    } finally { warn.mockRestore(); }
  });

  it("removes only the named messages when instances acknowledge concurrently", async () => {
    const prefix = `test:${randomUUID()}:`;
    const a = redisLinkState(first, prefix, 60_000);
    const b = redisLinkState(second, prefix, 60_000);
    const ref = { workspace: "work", id: "project" };
    for (const id of ["one", "two", "three", "four"]) {
      await a.append(ref, { v: 1, id, type: "command", project: ref, at: "", payload: {} });
    }
    await Promise.all([a.ack(ref, ["one", "two"]), b.ack(ref, ["two", "four"])]);
    expect((await b.read(ref))?.queue.map(({ id }) => id)).toEqual(["three"]);
  });
});
