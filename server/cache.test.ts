import { describe, expect, it } from "vitest";
import type { GraphData } from "../src/lib/types.ts";
import { FRESH_MS, FULL_MS, createGraphCache } from "./cache.ts";

const graph = (n: number) => ({ project: { id: "p", name: `v${n}`, url: "" }, milestones: [], issues: [], teams: {}, labels: [], viewerId: "me", status: null }) as GraphData;

/** A cache over a counted fake of Linear. `moved` says what the cheap check answers. */
function setup() {
  const count = { load: 0, changed: 0 }, clock = { at: 1_000_000 }, state = { moved: false, since: "" };
  const cache = createGraphCache({
    load: async () => graph(++count.load),
    changed: async (_id, since) => { count.changed++; state.since = since; return state.moved; },
    now: () => clock.at,
  });
  return { cache, count, clock, state };
}

describe("graph cache", () => {
  it("gives every tab the same graph from one load", async () => {
    const { cache, count } = setup();
    const answers = await Promise.all([cache.get("p"), cache.get("p"), cache.get("p")]);
    expect(count).toEqual({ load: 1, changed: 0 });
    expect(new Set(answers.map((a) => a.version)).size).toBe(1);
    await cache.get("p"); // a poll of another tab, a moment later
    expect(count).toEqual({ load: 1, changed: 0 });
  });
  it("costs one request for each poll interval while the project is idle, for any number of tabs", async () => {
    const { cache, count, clock } = setup();
    const first = await cache.get("p");
    for (let poll = 1; poll <= 10; poll++) {
      clock.at += FRESH_MS + 5_000; // the page polls each 15 s
      const tabs = await Promise.all([cache.get("p"), cache.get("p"), cache.get("p"), cache.get("p")]);
      expect(tabs.every((t) => t.version === first.version)).toBe(true);
      expect(count).toEqual({ load: 1, changed: poll });
    }
  });
  it("loads the graph again when the check finds a change, and the version changes", async () => {
    const { cache, count, clock, state } = setup();
    const first = await cache.get("p");
    clock.at += FRESH_MS + 1;
    state.moved = true;
    const second = await cache.get("p");
    expect(count).toEqual({ load: 2, changed: 1 });
    expect(second.version).not.toBe(first.version);
    expect(Date.parse(state.since)).toBeLessThan(1_000_000); // the check looks back past the clock skew
  });
  it("gives the next poll a new version when only the status document changes", async () => {
    let now = 1_000_000;
    const before = { ...graph(1), status: { content: "first run", updatedAt: new Date(now).toISOString() } };
    let source = before;
    const cache = createGraphCache({
      load: async () => source,
      changed: async (_id, since) => source.status.updatedAt > since,
      now: () => now,
    });

    const first = await cache.get("p");
    now += FRESH_MS + 5_000;
    source = { ...before, status: { content: "second run", updatedAt: new Date(now).toISOString() } };
    const next = await cache.get("p");
    expect(next.data.status?.content).toBe("second run");
    expect(next.version).not.toBe(first.version);
  });
  it("makes a full load after the longest time, with no check", async () => {
    const { cache, count, clock } = setup();
    await cache.get("p");
    clock.at += FULL_MS;
    await cache.get("p");
    expect(count).toEqual({ load: 2, changed: 0 });
  });
  it("forgets the graph after a write, and does not keep a load that the write overtook", async () => {
    const { cache, count } = setup();
    await cache.get("p");
    cache.clear();
    const slow = cache.get("p"); // this load starts before the write below
    cache.clear();
    await slow;
    await cache.get("p");
    expect(count.load).toBe(3);
  });
});
