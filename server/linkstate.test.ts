import { describe, expect, it } from "vitest";
import type { Envelope } from "../src/lib/link.ts";
import { ASKS_MAX } from "./store.ts";
import { memoryLinkState, QUEUE_MAX, type LinkRoomState } from "./linkstate.ts";

const ref = { workspace: "work", id: "project" };
const message = (id: string, type = "command"): Envelope => ({
  v: 1, id, type, project: ref, at: "", payload: {},
});

export function linkStateContract(factory: () => LinkRoomState | Promise<LinkRoomState>) {
  it("creates rooms on write and isolates rooms and returned snapshots", async () => {
    const state = await factory();
    expect(await state.read(ref)).toBeNull();
    const room = await state.edit(ref, (room) => {
      room.progress = [{ key: "a", issue: null, job: null, state: null, ci: null, evidence: null, at: null }];
      room.agents = { at: "", agents: [] };
      room.coordinators.set("s", {
        socket: "connection", hello: { session: "s", host: "host", plan: "plan", wg: "1" },
        state: { mode: "working", head: "head", lines: [] }, since: "", lastSeen: "", lost: false,
      });
      return room;
    });
    room.coordinators.clear();
    expect(await state.read(ref)).toMatchObject({
      progress: [{ key: "a" }], agents: { agents: [] },
      coordinators: new Map([["s", expect.objectContaining({ socket: "connection", lost: false })]]),
    });
    expect(await state.read({ ...ref, workspace: "other" })).toBeNull();
    expect((await state.rooms()).map((room) => room.ref)).toEqual([ref]);
  });

  it("keeps queue order, drops changed first, and removes only acknowledged ids", async () => {
    const state = await factory();
    await state.append(ref, message("first"));
    await state.append(ref, message("changed", "changed"));
    for (let i = 0; i < QUEUE_MAX - 1; i++) await state.append(ref, message(String(i)));
    expect((await state.read(ref))?.queue.map(({ id }) => id)).toEqual([
      "first", ...Array.from({ length: QUEUE_MAX - 1 }, (_, i) => String(i)),
    ]);
    await state.ack(ref, ["first", "missing"]);
    expect((await state.read(ref))?.queue.map(({ id }) => id)).toEqual(
      Array.from({ length: QUEUE_MAX - 1 }, (_, i) => String(i)),
    );
  });

  it("keeps at most ASKS_MAX open asks and removes a reply by id", async () => {
    const state = await factory();
    const asks = Array.from({ length: ASKS_MAX + 1 }, (_, i) => ({
      id: String(i), key: null, issue: null, from: "worker", body: "Question", at: "",
    }));
    await state.setAsks(ref, asks);
    await state.removeAsk(ref, "0");
    expect((await state.read(ref))?.asks).toEqual(asks.slice(1, ASKS_MAX));
  });

  it("shares an ended session until its expiry", async () => {
    const state = await factory();
    expect(await state.sessionEnded("s", 9)).toBe(false);
    await state.endSession("s", 10, 9);
    expect(await state.sessionEnded("s", 9)).toBe(true);
    expect(await state.sessionEnded("s", 10)).toBe(false);
    expect(await state.sessionEnded("other", 9)).toBe(false);
  });
}

describe("memory link state", () => linkStateContract(memoryLinkState));
