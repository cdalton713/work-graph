import { afterEach, beforeEach, expect, it } from "vitest";
import type { Envelope } from "../../src/lib/link.ts";
import { QUEUE_MAX, type LinkRoomState } from "../linkstate.ts";
import { ASKS_MAX } from "../store.ts";

const ref = { workspace: "work", id: "project" };
const message = (id: string, type = "command"): Envelope => ({
  v: 1, id, type, project: ref, at: "", payload: {},
});
const coordinator = (session: string, socket: string | null, lastSeen: string) => ({
  socket, hello: { session, host: "host", plan: "plan", wg: "1" }, state: null, since: lastSeen, lastSeen,
});

interface StatePair {
  a: LinkRoomState;
  b: LinkRoomState;
  cleanup(): void | Promise<void>;
}

export function linkStateContract(factory: () => StatePair | Promise<StatePair>) {
  let pair: StatePair;
  beforeEach(async () => { pair = await factory(); });
  afterEach(async () => { await pair?.cleanup(); });

  it("shares room edits and isolates returned snapshots", async () => {
    const { a, b } = pair;
    expect(await b.read(ref)).toBeNull();
    const row = { ...coordinator("s", "connection", ""), state: { mode: "working" as const, head: "head", lines: [] }, lost: false };
    const room = await a.edit(ref, (room) => {
      room.progress = [{ key: "a", issue: null, job: null, state: null, ci: null, evidence: null, at: null }];
      room.agents = { at: "", agents: [] };
      room.coordinators.set("s", row);
      return room;
    });
    expect(room.coordinators.get("s")).toEqual(row);
    room.coordinators.clear();
    expect(await b.read(ref)).toMatchObject({
      progress: [{ key: "a" }], agents: { agents: [] }, coordinators: new Map([["s", row]]),
    });
    expect(await b.read({ ...ref, workspace: "other" })).toBeNull();
    expect((await b.rooms()).map((room) => room.ref)).toEqual([ref]);
  });

  it("returns queue snapshots, drops changed first, and removes only acknowledged IDs", async () => {
    const { a, b } = pair;
    expect((await a.append(ref, message("first"))).queue).toEqual([message("first")]);
    await b.append(ref, message("changed", "changed"));
    const more = Array.from({ length: QUEUE_MAX - 1 }, (_, i) => message(String(i)));
    for (const item of more.slice(0, -1)) await a.append(ref, item);
    const full = await b.append(ref, more.at(-1)!);
    expect(full.queue).toEqual([message("first"), ...more]);
    expect((await a.read(ref))?.queue).toEqual(full.queue);
    expect((await a.ack(ref, ["first", "missing"])).queue).toEqual(more);
    expect((await b.read(ref))?.queue).toEqual(more);
  });

  it("drops the oldest message when a full queue contains no changed notice", async () => {
    const { a, b } = pair;
    const items = Array.from({ length: QUEUE_MAX + 1 }, (_, i) => message(String(i)));
    for (const item of items.slice(0, -1)) await a.append(ref, item);
    expect((await b.append(ref, items.at(-1)!)).queue).toEqual(items.slice(1));
  });

  it("returns ask snapshots, applies the ask limit, and removes a reply by ID", async () => {
    const { a, b } = pair;
    expect(await a.removeAsk(ref, "missing")).toBeNull();
    expect(await b.read(ref)).toBeNull();
    const asks = Array.from({ length: ASKS_MAX + 1 }, (_, i) => ({
      id: String(i), key: null, issue: null, from: "worker", body: "Question", at: "",
    }));
    expect((await b.setAsks(ref, asks)).asks).toEqual(asks.slice(0, ASKS_MAX));
    expect((await a.removeAsk(ref, "0"))?.asks).toEqual(asks.slice(1, ASKS_MAX));
    expect((await b.read(ref))?.asks).toEqual(asks.slice(1, ASKS_MAX));
  });

  it("prunes expired entries and empty rooms while keeping a room with an open socket", async () => {
    const { a, b } = pair;
    const empty = { ...ref, id: "empty" }, expired = { ...ref, id: "expired" };
    const cutoff = Date.now() - 60_000;
    const old = new Date(cutoff - 10_000).toISOString(), recent = new Date(cutoff + 10_000).toISOString();
    await a.edit(empty, () => {});
    await a.edit(expired, (room) => { room.agents = { at: old, agents: [] }; });
    await b.edit(ref, (room) => {
      room.sockets.set("waiting", "coordinator");
      room.coordinators.set("gone", coordinator("gone", null, old));
      room.coordinators.set("recent", coordinator("recent", null, recent));
      room.agents = { at: old, agents: [] };
    });
    await a.prune(cutoff);
    expect(await b.read(empty)).toBeNull();
    expect(await b.read(expired)).toBeNull();
    expect(await b.read(ref)).toMatchObject({
      agents: null, sockets: new Map([["waiting", "coordinator"]]),
      coordinators: new Map([["recent", coordinator("recent", null, recent)]]),
    });
    await b.edit(ref, (room) => { room.coordinators.clear(); });
    await a.prune(cutoff);
    expect(await b.read(ref)).toMatchObject({ sockets: new Map([["waiting", "coordinator"]]) });
  });

  it("flushes successfully and leaves the queued messages available", async () => {
    const { a, b } = pair;
    expect(await a.flush()).toBe(true);
    await a.append(ref, message("queued"));
    expect(await a.flush()).toBe(true);
    expect((await b.read(ref))?.queue).toEqual([message("queued")]);
  });

  it("shares ended sessions and keeps the later expiry", async () => {
    const { a, b } = pair;
    const now = Date.now();
    expect(await b.sessionEnded("s", now)).toBe(false);
    await a.endSession("s", now + 60_000, now);
    await b.endSession("s", now + 120_000, now);
    await a.endSession("s", now + 30_000, now);
    expect(await b.sessionEnded("s", now + 60_000)).toBe(true);
    expect(await a.sessionEnded("s", now + 120_000)).toBe(false);
    expect(await b.sessionEnded("other", now)).toBe(false);
  });
}
