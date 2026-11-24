import { describe, expect, it } from "vitest";
import type { GraphData } from "../src/lib/types.ts";
import { FRESH_MS, FULL_MS, STALE_MS, createGraphCache } from "./cache.ts";

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
  it("forgets only the graph of the project that a write names, and all graphs for a write with no project", async () => {
    const loads: string[] = [];
    const cache = createGraphCache({ load: async (id) => { loads.push(id); return graph(loads.length); }, changed: async () => false, now: () => 1_000_000 });
    await Promise.all([cache.get("a"), cache.get("b")]);
    cache.clear("a");
    await Promise.all([cache.get("a"), cache.get("b")]);
    expect(loads).toEqual(["a", "b", "a"]);
    // A write to "a" while a load of "b" runs: the load of "b" is kept.
    cache.clear();
    const slow = cache.get("b");
    cache.clear("a");
    await slow;
    await cache.get("b");
    expect(loads).toEqual(["a", "b", "a", "b"]);
    cache.clear();
    await Promise.all([cache.get("a"), cache.get("b")]);
    expect(loads).toEqual(["a", "b", "a", "b", "a", "b"]);
  });
  it("gives the last graph, marked stale with the error, when a refresh fails, while it is at most 15 minutes old", async () => {
    const clock = { at: 1_000_000 }, linear = { down: false };
    const cache = createGraphCache({
      load: async () => { if (linear.down) throw new Error("Linear: HTTP 500"); return graph(1); },
      changed: async () => { if (linear.down) throw new Error("Linear: HTTP 500"); return false; },
      now: () => clock.at,
    });
    const first = await cache.get("p");
    expect(first.stale).toBeUndefined();
    linear.down = true;
    clock.at += FRESH_MS;
    const stale = await cache.get("p");
    expect(stale).toEqual({ data: first.data, version: first.version, stale: true, error: "Linear: HTTP 500", loadedAt: 1_000_000 });
    // After a write the graph is gone from the cache, but a failed load still gives the last graph.
    cache.clear("p");
    expect((await cache.get("p")).stale).toBe(true);
    clock.at = 1_000_000 + STALE_MS + 1;
    await expect(cache.get("p")).rejects.toThrow("Linear: HTTP 500");
    linear.down = false;
    expect((await cache.get("p")).stale).toBeUndefined();
  });
  it("checks all due projects with one request, and loads again only the changed ones", async () => {
    const clock = { at: 1_000_000 }, loads: string[] = [], many: { ids: string[]; since: string }[] = [];
    let answer: Map<string, string> | null = new Map();
    const cache = createGraphCache({
      load: async (id) => { loads.push(id); return graph(loads.length); },
      changed: async () => { throw new Error("no check for one project"); },
      changedMany: async (ids, since) => { many.push({ ids, since }); return answer; },
      now: () => clock.at,
    });
    await Promise.all(["a", "b", "c"].map((id) => cache.get(id)));
    await cache.check(["a", "b", "c"]); // all fresh: no request
    expect(many).toEqual([]);
    clock.at += FRESH_MS;
    const sinceA = new Date(1_000_000 - 5_000).toISOString();
    // "b" changed after its last check; the time of "c" is older than its last check.
    answer = new Map([["b", new Date(clock.at).toISOString()], ["c", new Date(1_000_000 - 60_000).toISOString()]]);
    await Promise.all([cache.check(["a", "b", "c", "unknown"]), cache.check(["a"])]);
    expect(many).toEqual([{ ids: ["a", "b", "c"], since: sinceA }]);
    await Promise.all(["a", "b", "c"].map((id) => cache.get(id)));
    expect(loads).toEqual(["a", "b", "c", "b"]);
    // Too many changes to list: all of them load again.
    clock.at += FRESH_MS;
    answer = null;
    await cache.check(["a", "b", "c"]);
    await Promise.all(["a", "b", "c"].map((id) => cache.get(id)));
    expect(loads).toEqual(["a", "b", "c", "b", "a", "b", "c"]);
  });
  it("measures the 15 minutes of a stale graph from its load, also after successful checks", async () => {
    const clock = { at: 1_000_000 }, linear = { down: false };
    const cache = createGraphCache({
      load: async () => { if (linear.down) throw new Error("Linear: HTTP 500"); return graph(1); },
      changed: async () => { if (linear.down) throw new Error("Linear: HTTP 500"); return false; },
      now: () => clock.at,
    });
    await cache.get("p");
    clock.at += 4 * 60_000;
    expect((await cache.get("p")).stale).toBeUndefined(); // a successful check at minute four, with no load
    linear.down = true;
    clock.at = 1_000_000 + STALE_MS;
    expect((await cache.get("p")).stale).toBe(true);
    clock.at = 1_000_000 + STALE_MS + 1;
    await expect(cache.get("p")).rejects.toThrow("Linear: HTTP 500");
  });
  it("gives the error of a failed check of all projects to the reads after it, with no check for each project", async () => {
    const clock = { at: 1_000_000 }, count = { load: 0, changed: 0, many: 0 };
    const cache = createGraphCache({
      load: async () => graph(++count.load),
      changed: async () => { count.changed++; return false; },
      changedMany: async () => { count.many++; clock.at += slow; throw new Error("Linear: HTTP 500"); },
      now: () => clock.at,
    });
    let slow = 0;
    const first = await cache.get("a");
    await cache.get("b");
    clock.at += FRESH_MS;
    await cache.check(["a", "b"]);
    const [a, b] = await Promise.all([cache.get("a"), cache.get("b")]);
    expect(a).toEqual({ data: first.data, version: first.version, stale: true, error: "Linear: HTTP 500", loadedAt: 1_000_000 });
    expect(b.stale).toBe(true);
    expect(count).toEqual({ load: 2, changed: 0, many: 1 });
    // A slow check: Linear rejects it after 30 s (its time-out). The reads of the same poll still get its error.
    slow = 30_000;
    clock.at += FRESH_MS;
    await cache.check(["a", "b"]);
    const late = await Promise.all([cache.get("a"), cache.get("b")]);
    expect(late.map((v) => [v.stale, v.error])).toEqual([[true, "Linear: HTTP 500"], [true, "Linear: HTTP 500"]]);
    expect(count).toEqual({ load: 2, changed: 0, many: 2 });
  });
  it("serves the reads of the same poll after a slow successful check of all projects, with no check for each project", async () => {
    const clock = { at: 1_000_000 }, count = { load: 0, changed: 0 }, many: string[] = [];
    const cache = createGraphCache({
      load: async () => graph(++count.load),
      changed: async () => { count.changed++; return false; },
      // Linear answers after 15 s: no change, given with a time of another precision and offset.
      changedMany: async (_ids, since) => {
        many.push(since);
        clock.at += 15_000;
        return new Map([["a", new Date(1_000_000 - 60_000).toISOString().replace("Z", "+00:00")]]);
      },
      now: () => clock.at,
    });
    await cache.get("a");
    await cache.get("b");
    clock.at += FRESH_MS;
    const start = clock.at;
    await cache.check(["a", "b"]);
    const reads = await Promise.all([cache.get("a"), cache.get("b")]);
    expect(reads.every((r) => r.stale === undefined)).toBe(true);
    expect(count).toEqual({ load: 2, changed: 0 });
    // The next check asks for changes from the start of this one, not from its answer.
    clock.at += FRESH_MS;
    await cache.check(["a", "b"]);
    expect(many[1]).toBe(new Date(start - 5_000).toISOString());
  });
  it("does not keep a load that a write overtook as the fallback for a failed refresh", async () => {
    const linear = { down: false };
    let release = () => {};
    const cache = createGraphCache({
      load: async () => {
        if (linear.down) throw new Error("Linear: HTTP 500");
        await new Promise<void>((resolve) => { release = resolve; });
        return graph(1);
      },
      changed: async () => false,
      now: () => 1_000_000,
    });
    const slow = cache.get("p");
    cache.clear("p"); // a write while the first load runs
    release();
    await slow;
    linear.down = true;
    await expect(cache.get("p")).rejects.toThrow("Linear: HTTP 500");
  });
});
