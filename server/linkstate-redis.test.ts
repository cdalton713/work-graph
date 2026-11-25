import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, vi, expect, it } from "vitest";
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
