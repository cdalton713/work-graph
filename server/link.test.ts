import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { Envelope } from "../src/lib/link.ts";
import { linkRefusal, type Rules } from "./access.ts";
import { createApp, type AppOptions } from "./app.ts";
import { memoryLinkState } from "./linkstate.ts";
import { memoryLinkBus, type LinkBus } from "./linkbus.ts";
import { redisLinkBus } from "./linkbus-redis.ts";
import { redisLinkState } from "./linkstate-redis.ts";
import { connectRedis } from "./redis.ts";
import { startLocalRedis, startTestRedis, localRedis, testRedis } from "./testing/redis.ts";
import { AGENTS_MAX, DEAD_MS, GONE_MS, LinkHub, PING_MS, QUEUE_MAX, RESTART_CODE, SHUTDOWN_MS, type Peer, stopOnSignals, type Timers } from "./link.ts";

const A = { workspace: "work", id: "p1" }, B = { workspace: "work", id: "p2" };

/** A peer that records what the hub sends, its pings, and a terminate. */
function peer() {
  const sent: Envelope[] = [];
  const closed: { code?: number; reason?: string }[] = [];
  const p: Peer & { sent: Envelope[]; closed: typeof closed; of: (type: string) => Envelope[]; pings: number; terminated: boolean } = {
    send: (text) => sent.push(JSON.parse(text)), close: (code, reason) => closed.push({ code, reason }),
    ping: () => { p.pings++; }, terminate: () => { p.terminated = true; },
    sent, closed, of: (type) => sent.filter((m) => m.type === type), pings: 0, terminated: false,
  };
  return p;
}
/** A clock and timers that move only when the test says so. */
function fakeTime() {
  const clock = { at: Date.parse("2026-11-20T00:00:00Z") };
  const jobs: { fn: () => void; at: number; every: number | null; off: boolean }[] = [];
  const add = (fn: () => void, ms: number, every: boolean) => {
    const job = { fn, at: clock.at + ms, every: every ? ms : null, off: false };
    jobs.push(job);
    return () => { job.off = true; };
  };
  const timers: Timers = { every: (fn, ms) => add(fn, ms, true), after: (fn, ms) => add(fn, ms, false) };
  /** Move the clock by `ms` and run each timer that falls due, in time order. */
  const advance = (ms: number) => {
    const end = clock.at + ms;
    for (;;) {
      const due = jobs.filter((j) => !j.off && j.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      clock.at = due.at;
      if (due.every) due.at += due.every; else due.off = true;
      due.fn();
    }
    clock.at = end;
  };
  return { clock, now: () => new Date(clock.at), timers, advance, running: () => jobs.filter((j) => !j.off).length };
}
const msg = (type: string, payload: unknown = {}) => JSON.stringify({ v: 1, type, id: "x", project: A, at: "", payload });
const hello = (session: string) => msg("hello", { plan: "/plans/a", session, host: "mac", wg: "1" });

describe("LinkHub", () => {
  it("applies room updates in flight from a replaced coordinator", async () => {
    const hub = new LinkHub();
    const page = peer(), old = peer();
    await hub.joinPage(page, A);
    const first = await hub.joinCoordinator(old, A);
    await first.receive(hello("s"));
    const pending = await hub.publish(A, "command", { name: "next", key: null, issue: null });
    const replacement = await hub.joinCoordinator(peer(), A);
    await replacement.receive(hello("s"));
    expect(old.closed).toHaveLength(1);

    await first.receive(msg("ack", { ids: [pending.id] }));
    expect((await hub.presence(A)).queued).toBe(0);
    await first.receive(msg("asks", { asks: [{ id: "q", body: "Which branch?" }] }));
    expect(await hub.ask(A, "q")).toMatchObject({ body: "Which branch?" });
    await first.receive(msg("progress", { nodes: [{ key: "work" }] }));
    expect(page.of("progress").at(-1)?.payload).toMatchObject({ nodes: [{ key: "work" }] });
    await first.receive(msg("state", { mode: "working", head: "old head" }));
    expect((await hub.presence(A)).coordinators[0]).toMatchObject({ head: null, connected: true });
  });

  it("sends viewers only reduced presence and change notices for shared rooms", async () => {
    const hub = new LinkHub();
    const viewer = peer(), overview = peer(), owner = peer();
    const a = await hub.joinCoordinator(peer(), A);
    const b = await hub.joinCoordinator(peer(), B);
    await a.receive(hello("private-session"));
    await b.receive(hello("another-session"));
    await hub.joinPage(owner, A);
    const shared = (ref: typeof A) => ref.id === A.id;
    await hub.joinViewer(viewer, A, shared);
    await hub.joinViewer(overview, null, shared);
    await a.receive(msg("asks", { asks: [{ id: "q", body: "private question" }] }));
    await a.receive(msg("agents", { agents: [{ id: "a", said: "private reply" }] }));
    await a.receive(msg("progress", { nodes: [{ key: "a", evidence: "private evidence" }] }));
    await hub.publish(A, "changed", { by: "page", what: "issue", issues: ["WG-1"] });
    await hub.publish(B, "changed", { by: "page", what: "issue", issues: ["WG-2"] });
    await vi.waitFor(() => expect(overview.of("changed")).toHaveLength(1));
    for (const page of [viewer, overview]) {
      expect(page.sent.every(({ type, project }) => ["presence", "changed"].includes(type) && project.id === A.id)).toBe(true);
      expect(page.of("presence")[0].payload).toMatchObject({
        queued: 0, coordinators: [{ session: "0", host: "", plan: "", head: null, connected: true }],
      });
      expect(page.of("changed")[0].payload).toMatchObject({ issues: [] });
    }
    expect(owner.of("changed")[0].payload).toMatchObject({ issues: ["WG-1"] });
    expect(owner.of("progress")).toHaveLength(2);
  });

  it("keeps a message for a coordinator until one acknowledges it, and sends the queue on hello", async () => {
    const hub = new LinkHub();
    const sent = await hub.publish(A, "answer", { issue: "CD-1", key: "a", body: "yes" });
    const first = peer(), c1 = await hub.joinCoordinator(first, A);
    expect(first.sent).toEqual([]); // nothing before hello
    await c1.receive(hello("s1"));
    expect(first.of("answer").map((m) => m.id)).toEqual([sent.id]);
    await c1.closed();
    const second = peer(), c2 = await hub.joinCoordinator(second, A);
    await c2.receive(hello("s2"));
    expect(second.of("answer").map((m) => m.id)).toEqual([sent.id]); // not acknowledged yet
    await c2.receive(msg("ack", { ids: [sent.id] }));
    expect((await hub.presence(A)).queued).toBe(0);
  });

  it("takes wrote before hello: it clears the cache and tells only the pages of the project", async () => {
    const cleared: string[] = [];
    const hub = new LinkHub(undefined, (ref) => cleared.push(ref.id));
    const waiting = peer(), pageA = peer(), pageB = peer(), short = peer();
    await (await hub.joinCoordinator(waiting, A)).receive(hello("next"));
    await hub.joinPage(pageA, A);
    await hub.joinPage(pageB, B);
    await (await hub.joinCoordinator(short, A)).receive(msg("wrote", { issues: ["CD-1", 7] }));
    expect(short.closed).toEqual([]);
    expect(cleared).toEqual(["p1"]);
    expect(pageA.of("changed").map((m) => m.payload)).toEqual([{ by: "coordinator", what: "issue", issues: ["CD-1"] }]);
    expect(pageB.of("changed")).toEqual([]);
    expect(waiting.of("changed")).toEqual([]); // wg made the change itself
    expect(await hub.presence(A)).toMatchObject({ queued: 0 });
    expect((await hub.presence(A)).coordinators.map((c) => c.session)).toEqual(["next"]); // the short connection is no coordinator
  });

  it("sends each message only to the coordinators and pages of its own project", async () => {
    const hub = new LinkHub();
    const a = peer(), b = peer(), pageA = peer(), overview = peer();
    await (await hub.joinCoordinator(a, A)).receive(hello("a"));
    await (await hub.joinCoordinator(b, B)).receive(hello("b"));
    await hub.joinPage(pageA, A);
    await hub.joinPage(overview, null);
    await hub.publish(B, "changed", { by: "page", what: "status", issues: ["CD-9"] });
    expect(a.of("changed")).toEqual([]);
    expect(b.of("changed")).toHaveLength(1);
    expect(pageA.of("changed")).toEqual([]);
    // The overview gets the presence of every project, and no changes.
    expect(overview.of("presence").some((m) => m.project.id === "p2")).toBe(true);
    expect(overview.of("changed")).toEqual([]);
    expect((await hub.active()).map((r) => r.id).sort()).toEqual(["p1", "p2"]);
  });

  it("sends the asks of every project to the overview, at once and when they change", async () => {
    const hub = new LinkHub();
    const c = await hub.joinCoordinator(peer(), A);
    await c.receive(hello("a"));
    await c.receive(msg("asks", { asks: [{ id: "q1", issue: "CD-1", from: "w", body: "Which table?", at: "" }, { id: "e1", issue: "CD-2", from: "w", body: "Stopped", at: "", kind: "escalation" }, { id: "x1", from: "w", body: "", at: "", kind: "other" }] }));
    const overview = peer();
    await hub.joinPage(overview, null);
    expect(overview.of("asks").at(-1)).toMatchObject({ project: A, payload: { asks: [{ id: "q1", issue: "CD-1" }, { id: "e1", kind: "escalation" }, { id: "x1" }] } });
    expect((overview.of("asks").at(-1)!.payload as { asks: Record<string, unknown>[] }).asks.map((a) => a.kind)).toEqual([undefined, "escalation", undefined]);
    await hub.answered(A, "q1");
    expect((overview.of("asks").at(-1)!.payload as { asks: { id: string }[] }).asks.map((x) => x.id)).toEqual(["e1", "x1"]);
  });

  it("takes agents before hello: the pages of the project and the overview get the cleaned rows, also a page that opens later", async () => {
    const { now, timers, advance } = fakeTime();
    const hub = new LinkHub(now, undefined, timers);
    hub.start();
    const pageA = peer(), pageB = peer(), overview = peer(), short = peer();
    await hub.joinPage(pageA, A);
    await hub.joinPage(pageB, B);
    await hub.joinPage(overview, null);
    const row = { id: "s1", role: "coordinator", key: null, issue: null, agent: "claude", state: "blocked", title: "Run", said: "x".repeat(900), at: "2026-11-20T00:00:00Z" };
    await (await hub.joinCoordinator(short, A)).receive(msg("agents", { agents: [row, { ...row, id: "", said: "no id" }, { ...row, id: "s2", role: "root", key: "a", issue: "CD-1" }, 7] }));
    expect(short.closed).toEqual([]);
    const got = pageA.of("agents").at(-1)!.payload as { at: string; agents: Record<string, unknown>[] };
    expect(got.at).toBe("2026-11-20T00:00:00.000Z");
    expect(got.agents.map((a) => [a.id, a.role, a.issue, (a.said as string).length])).toEqual([["s1", "coordinator", null, 500], ["s2", "worker", "CD-1", 500]]);
    expect(overview.of("agents").at(-1)).toMatchObject({ project: A, payload: got });
    expect(pageB.of("agents")).toEqual([]);
    expect((await hub.presence(A)).coordinators).toEqual([]); // wg agents is no coordinator
    const late = peer(), lateOverview = peer();
    await hub.joinPage(late, A);
    await hub.joinPage(lateOverview, null);
    expect(late.of("agents")).toHaveLength(1);
    expect(lateOverview.of("agents")).toHaveLength(1);
    await (await hub.joinCoordinator(peer(), A)).receive(msg("agents", { agents: Array.from({ length: AGENTS_MAX + 9 }, (_, n) => ({ ...row, id: `s${n}` })) }));
    expect((pageA.of("agents").at(-1)!.payload as { agents: unknown[] }).agents).toHaveLength(AGENTS_MAX);
    // After a day with no report, the hub forgets the rows.
    advance(GONE_MS + PING_MS);
    const next = peer();
    await hub.joinPage(next, A);
    expect(next.of("agents")).toEqual([]);
    hub.stop();
  });

  it("refuses a message before hello, and anything that is not wg-link/1", async () => {
    const hub = new LinkHub();
    const p = peer(), c = await hub.joinCoordinator(p, A);
    await c.receive(msg("state", { mode: "waiting" }));
    await c.receive("{");
    await c.receive(JSON.stringify({ v: 2, type: "hello" }));
    expect(p.closed.map((x) => x.reason)).toEqual(["send hello first", "message is not JSON", "not a wg-link/1 message"]);
  });

  it("shows presence: mode, head, and a coordinator that went away", async () => {
    let now = new Date("2026-11-20T10:00:00Z");
    const hub = new LinkHub(() => now);
    const page = peer();
    await hub.joinPage(page, A);
    const p = peer(), c = await hub.joinCoordinator(p, A);
    await c.receive(hello("s1"));
    await c.receive(msg("state", { mode: "waiting", head: "phase 1: 2 tasks", lines: [{ level: "wait", text: "human a" }] }));
    expect(page.of("presence").at(-1)!.payload).toMatchObject({ coordinators: [{ session: "s1", connected: true, mode: "waiting", head: "phase 1: 2 tasks" }] });
    now = new Date("2026-11-20T10:05:00Z");
    await c.closed();
    expect((await hub.presence(A)).coordinators).toEqual([expect.objectContaining({ connected: false, lastSeen: "2026-11-20T10:05:00.000Z" })]);
    now = new Date("2026-11-22T10:05:00Z");
    expect((await hub.presence(A)).coordinators).toEqual([]);
  });

  it("gives a reconnect of the same session the place of its old connection", async () => {
    const hub = new LinkHub();
    const old = peer(), fresh = peer();
    await (await hub.joinCoordinator(old, A)).receive(hello("s1"));
    await (await hub.joinCoordinator(fresh, A)).receive(hello("s1"));
    expect(old.closed).toHaveLength(1);
    expect((await hub.presence(A)).coordinators).toHaveLength(1);
  });

  it("passes asks and progress to the pages, and a new page gets them at once", async () => {
    const hub = new LinkHub();
    const c = await hub.joinCoordinator(peer(), A);
    await c.receive(hello("s1"));
    await c.receive(msg("asks", { asks: [{ id: "m1", key: "a", issue: "CD-1", from: "worker", body: "Which API?", at: "t" }] }));
    await c.receive(msg("progress", { nodes: [{ key: "a", issue: "CD-1", job: "dispatch", state: "running" }] }));
    const page = peer();
    await hub.joinPage(page, A);
    expect(page.of("asks")[0].payload).toEqual({ asks: [{ id: "m1", key: "a", issue: "CD-1", from: "worker", body: "Which API?", at: "t" }] });
    expect(page.of("progress")[0].payload).toEqual({ nodes: [{ key: "a", issue: "CD-1", job: "dispatch", state: "running", ci: null, evidence: null, at: null }] });
  });

  it("drops the oldest changed message first when the queue is full", async () => {
    const hub = new LinkHub();
    const answer = await hub.publish(A, "answer", { issue: "CD-1", key: null, body: "keep me" });
    for (let i = 0; i < QUEUE_MAX + 5; i++) await hub.publish(A, "changed", { by: "linear", what: "issue", issues: [`CD-${i}`] });
    const p = peer();
    await (await hub.joinCoordinator(p, A)).receive(hello("s"));
    expect(p.sent.filter((m) => m.type !== "presence")).toHaveLength(QUEUE_MAX);
    expect(p.of("answer").map((m) => m.id)).toEqual([answer.id]);
  });
});

describe("LinkHub heartbeat, prune, and shutdown", () => {
  afterEach(() => vi.restoreAllMocks());
  const started = () => {
    const time = fakeTime();
    const hub = new LinkHub(time.now, undefined, time.timers);
    hub.start();
    return { time, hub };
  };

  it("terminates a socket DEAD_MS after it opened with no pong, also one that joins just after a ping", async () => {
    const { time, hub } = started();
    time.advance(PING_MS + 1);
    const late = peer(), page = peer();
    await (await hub.joinCoordinator(late, A)).receive(hello("late"));
    await hub.joinPage(page, A);
    time.advance(DEAD_MS - 1);
    expect([late.terminated, page.terminated]).toEqual([false, false]);
    expect(await hub.active()).toHaveLength(1);
    time.advance(1);
    expect([late.terminated, page.terminated]).toEqual([true, true]);
    expect((await hub.presence(A)).coordinators.map((c) => [c.session, c.connected])).toEqual([["late", false]]);
    // The Linear check stops for a project with no live coordinator.
    expect(await hub.active()).toEqual([]);
  });

  it("marks a coordinator that the deadline terminated as lost, also in working mode, and a normal close as not lost", async () => {
    const { time, hub } = started();
    const silent = peer(), done = peer();
    const s = await hub.joinCoordinator(silent, A), d = await hub.joinCoordinator(done, A);
    await s.receive(hello("silent"));
    await s.receive(msg("state", { mode: "working", head: "", lines: [] }));
    await d.receive(hello("done"));
    await d.receive(msg("state", { mode: "working", head: "", lines: [] }));
    await d.closed(); // wg next ended its wait and closed the socket
    time.advance(DEAD_MS);
    expect(silent.terminated).toBe(true);
    const lost = Object.fromEntries((await hub.presence(A)).coordinators.map((c) => [c.session, [c.connected, c.mode, c.lost]]));
    expect(lost).toEqual({ silent: [false, "working", true], done: [false, "working", false] });
    // A new hello of the same session is not lost.
    await (await hub.joinCoordinator(peer(), A)).receive(hello("silent"));
    expect((await hub.presence(A)).coordinators.find((c) => c.session === "silent")?.lost).toBe(false);
  });

  it("sets the deadline again at each pong, and counts no message as a pong", async () => {
    const { time, hub } = started();
    const live = peer(), talker = peer();
    const a = await hub.joinCoordinator(live, A), b = await hub.joinCoordinator(talker, A);
    await a.receive(hello("live"));
    await b.receive(hello("talker"));
    for (let t = 0; t < 4 * DEAD_MS; t += 10_000) {
      if (!talker.terminated) await b.receive(msg("state", { mode: "working", head: "", lines: [] }));
      if (t % PING_MS === 0) a.pong();
      time.advance(10_000);
      if (t + 10_000 < DEAD_MS) expect(talker.terminated).toBe(false);
    }
    expect(talker.terminated).toBe(true);
    expect(live.terminated).toBe(false);
    expect(live.pings).toBe(4 * DEAD_MS / PING_MS);
    expect((await hub.presence(A)).coordinators.map((c) => [c.session, c.connected])).toEqual([["live", true], ["talker", false]]);
    await b.closed(); // the transport reports the close later: nothing changes again
    expect(await hub.active()).toHaveLength(1);
  });

  it("keeps no pong deadline while the heartbeat is stopped: not after a late pong, not for a new socket", async () => {
    const { time, hub } = started();
    const old = peer(), c = await hub.joinCoordinator(old, A);
    await c.receive(hello("old"));
    hub.stop();
    expect(time.running()).toBe(0);
    c.pong(); // a pong that arrives after the stop
    const late = peer();
    await hub.joinPage(late, A); // a socket that opens after the stop
    expect(time.running()).toBe(0);
    time.advance(5 * DEAD_MS);
    expect([old.terminated, late.terminated, old.pings, late.pings]).toEqual([false, false, 0, 0]);
    expect(await hub.active()).toHaveLength(1);
  });

  it("at a restart of the heartbeat gives each open socket a new deadline, so a silent socket does not survive", async () => {
    const { time, hub } = started();
    const silent = peer(), answering = peer();
    await (await hub.joinCoordinator(silent, A)).receive(hello("silent"));
    const a = await hub.joinCoordinator(answering, B);
    await a.receive(hello("answering"));
    time.advance(DEAD_MS - 1);
    hub.stop();
    time.advance(10 * DEAD_MS);
    hub.start();
    expect(time.running()).toBe(3); // the heartbeat and one deadline for each socket
    time.advance(PING_MS);
    a.pong();
    time.advance(DEAD_MS - PING_MS - 1);
    expect(silent.terminated).toBe(false);
    time.advance(1);
    expect(silent.terminated).toBe(true); // DEAD_MS after the restart
    expect(answering.terminated).toBe(false);
    expect((await hub.active()).map((r) => r.id)).toEqual(["p2"]);
    hub.start(); // a second start changes nothing
    expect(time.running()).toBe(2);
  });

  it("pings no peer that cannot ping, and never terminates it", async () => {
    const { time, hub } = started();
    const plain: Peer = { send: () => {}, close: vi.fn() };
    await (await hub.joinCoordinator(plain, B)).receive(hello("p"));
    time.advance(5 * DEAD_MS);
    expect(plain.close).not.toHaveBeenCalled();
    expect(await hub.active()).toHaveLength(1);
  });

  it("binds one session to a socket: a dead socket that sent two hellos leaves no session connected", async () => {
    const { time, hub } = started();
    const p = peer(), c = await hub.joinCoordinator(p, A);
    await c.receive(hello("first"));
    await c.receive(hello("second"));
    expect((await hub.presence(A)).coordinators.map((x) => [x.session, x.connected])).toEqual([["second", true], ["first", false]]);
    time.advance(DEAD_MS);
    expect(p.terminated).toBe(true);
    expect((await hub.presence(A)).coordinators.every((x) => !x.connected)).toBe(true);
    expect(await hub.active()).toEqual([]);
    time.advance(GONE_MS + PING_MS);
    expect((await hub.presence(A)).coordinators).toEqual([]);
  });

  it("ignores a message of an unknown type with one log line, and keeps the connection", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const hub = new LinkHub();
    const p = peer(), c = await hub.joinCoordinator(p, A);
    await c.receive(hello("s1\nlink: forged\u2028line"));
    await c.receive(msg("notice\r\nlink: forged\u2029x", { text: "from a newer wg" }));
    expect(p.closed).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0][0]);
    expect(line).toMatch(/^link: ignored a message of unknown type "notice/);
    expect(line).not.toMatch(/[\r\n\u2028\u2029]/);
    await c.receive(msg("state", { mode: "waiting", head: "h", lines: [] }));
    expect((await hub.presence(A)).coordinators[0]).toMatchObject({ connected: true, mode: "waiting" });
  });

  it("ignores a first message of an unknown type, before hello, and keeps the connection", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const hub = new LinkHub();
    const p = peer(), c = await hub.joinCoordinator(p, A);
    await c.receive(msg("notice", { text: "from a newer wg" }));
    expect(p.closed).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toBe('link: ignored a message of unknown type "notice" from "(no hello yet)"');
    await c.receive(msg("state", { mode: "working", head: "", lines: [] })); // a known type still needs hello
    expect(p.closed.map((x) => x.reason)).toEqual(["send hello first"]);
  });

  it("removes a coordinator gone for GONE_MS, and a room with no page, coordinator, queue, ask, or socket", async () => {
    const { time, hub } = started();
    const P3 = { workspace: "work", id: "p3" }, P4 = { workspace: "work", id: "p4" };
    const c = await hub.joinCoordinator(peer(), A);
    await c.receive(hello("old"));
    await c.closed();
    const queued = await hub.joinCoordinator(peer(), B);
    await queued.receive(hello("b"));
    await queued.closed();
    await hub.publish(B, "answer", { issue: "CD-1", key: null, body: "wait for a coordinator" });
    const asking = await hub.joinCoordinator(peer(), P4);
    await asking.receive(hello("d"));
    await asking.receive(msg("asks", { asks: [{ id: "q1", issue: "CD-4", from: "w", body: "Which?", at: "" }] }));
    await asking.closed();
    // A socket with no hello yet, of a transport with no ping: the heartbeat leaves it open.
    const waiting = await hub.joinCoordinator({ send: () => {}, close: () => {} }, P3);
    time.advance(GONE_MS + PING_MS);
    expect((await hub.presence(A)).coordinators).toEqual([]);
    expect((await hub.presence(P4)).coordinators).toEqual([]);
    const overview = peer();
    await hub.joinPage(overview, null);
    // Room A held nothing more; B holds a queue, p4 an ask, p3 an open socket.
    expect(overview.of("presence").map((m) => m.project.id).sort()).toEqual(["p2", "p3", "p4"]);
    expect(await hub.ask(P4, "q1")).toMatchObject({ issue: "CD-4" });
    await waiting.receive(hello("late"));
    expect((await hub.active()).map((r) => r.id)).toEqual(["p3"]);
  });

  it("at shutdown closes each socket with 1012, closes a socket that joins later too, and resolves at the last close", async () => {
    const { time, hub } = started();
    const coordinator = peer(), page = peer(), late = peer();
    const c = await hub.joinCoordinator(coordinator, A);
    await c.receive(hello("s"));
    const p = await hub.joinPage(page, A);
    let done = false;
    const stopped = hub.shutdown().then(() => { done = true; });
    expect(hub.closing).toBe(true);
    expect(hub.shutdown()).toBe(hub.shutdown()); // one shutdown
    expect(coordinator.closed).toEqual([{ code: RESTART_CODE, reason: "server restart" }]);
    expect(page.closed).toEqual([{ code: RESTART_CODE, reason: "server restart" }]);
    const l = await hub.joinPage(late, null); // the transport admitted it before it heard of the shutdown
    expect(late.closed).toEqual([{ code: RESTART_CODE, reason: "server restart" }]);
    await c.closed();
    await p.closed();
    await Promise.resolve();
    expect(done).toBe(false); // the late socket is still open
    await l.closed();
    await stopped;
    expect(time.running()).toBe(0); // no heartbeat, no deadline, no wait timer
  });

  it("waits for all in-flight release writes before flushing at shutdown", async () => {
    const memory = memoryLinkState();
    const gates: (() => void)[] = [];
    let closing = false;
    const hub = new LinkHub(undefined, undefined, fakeTime().timers, null, {
      ...memory,
      async edit(ref, change) {
        if (closing) await new Promise<void>((resolve) => gates.push(resolve));
        return memory.edit(ref, change);
      },
    });
    const first = await hub.joinPage(peer(), A);
    const second = await hub.joinPage(peer(), A);
    closing = true;
    let stopped = false;
    const shutdown = hub.shutdown().then(() => { stopped = true; });
    const a = first.closed();
    const b = second.closed();
    gates[0]();
    await a;
    await Promise.resolve();
    expect(stopped).toBe(false);
    gates[1]();
    await Promise.all([b, shutdown]);
    expect(stopped).toBe(true);
  });

  it("removes a socket when its initial snapshot cannot be delivered", async () => {
    const memory = memoryLinkState();
    const bus = memoryLinkBus();
    const hub = new LinkHub(undefined, undefined, fakeTime().timers, null, memory, {
      ...bus,
      async publish() { throw new Error("bus unavailable"); },
    });
    await expect(hub.joinPage(peer(), A)).rejects.toThrow("bus unavailable");
    expect((await memory.read(A))?.sockets.size).toBe(0);
    expect(await hub.shutdown()).toBe(true);
  });

  it("at shutdown resolves after SHUTDOWN_MS when a socket does not close", async () => {
    const time = fakeTime();
    const hub = new LinkHub(time.now, undefined, time.timers);
    await (await hub.joinCoordinator(peer(), A)).receive(hello("stuck"));
    let done = false;
    const stopped = hub.shutdown().then(() => { done = true; });
    time.advance(SHUTDOWN_MS - 1);
    await Promise.resolve();
    expect(done).toBe(false);
    time.advance(1);
    await stopped;
    expect(await new LinkHub().shutdown()).toBe(true); // no socket: at once; no store: nothing to write
  });

  it("on a signal runs shutdown once, then exits with 0", async () => {
    const handlers = new Map<string, () => void>();
    const exit = vi.fn();
    let finish = () => {};
    const shutdown = vi.fn(() => new Promise<void>((ok) => { finish = ok; }));
    stopOnSignals(shutdown, (signal, fn) => handlers.set(signal, fn), exit);
    expect([...handlers.keys()].sort()).toEqual(["SIGHUP", "SIGINT", "SIGTERM"]);
    handlers.get("SIGTERM")!();
    handlers.get("SIGINT")!();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled(); // not before the sockets closed
    finish();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

describe("linkRefusal", () => {
  const rules: Rules = { port: 4747, tailnet: null, hosted: { host: "wg.example.com" } };
  const headers = (h: Record<string, string>) => (name: string) => h[name];
  it("takes a page only from its own origin, and a coordinator only with no origin", () => {
    expect(linkRefusal("page", headers({ host: "wg.example.com", origin: "https://wg.example.com" }), rules)).toBeNull();
    expect(linkRefusal("page", headers({ host: "wg.example.com", origin: "https://evil.example" }), rules)).toBe("bad origin");
    expect(linkRefusal("page", headers({ host: "wg.example.com" }), rules)).toBe("bad origin");
    expect(linkRefusal("coordinator", headers({ host: "wg.example.com" }), rules)).toBeNull();
    expect(linkRefusal("coordinator", headers({ host: "wg.example.com", origin: "https://wg.example.com" }), rules)).toBe("a coordinator sends no Origin");
    expect(linkRefusal("coordinator", headers({ host: "evil.example" }), rules)).toBe("bad host");
    expect(linkRefusal("admin", headers({ host: "wg.example.com" }), rules)).toBe("role must be page or coordinator");
  });
});

describe("/api/link over a real socket", () => {
  const closers: (() => void | Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  /** Linear with two projects; issue i1 (CD-1) is in p1. Each comment create is recorded. */
  /** `team`: the team key of the issue of p1 in its graph. */
  function fakeLinear(team = "CD") {
    const comments: string[] = [];
    const marks = { answered: [] as string[], paused: false };
    let updatedAt = "2026-11-20T00:00:00Z", card = "";
    const none = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
    vi.stubEnv("LINEAR_API_KEY", "k");
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const { query, variables } = JSON.parse(init.body as string);
      let data: unknown;
      if (query.includes("projects(first:50")) data = { teams: { nodes: [{ projects: { nodes: [
        { id: "p1", name: "Effort A", url: "u", status: { name: "Started", type: "started" } },
        { id: "p2", name: "Effort B", url: "u", status: { name: "Started", type: "started" } },
      ], pageInfo: { hasNextPage: false, endCursor: null } } }] } };
      else if (query.includes("issueLabelCreate")) data = { issueLabelCreate: { issueLabel: { id: "answered-id" } } };
      else if (query.includes("issueLabels(first:10")) data = { issueLabels: { nodes: [] } };
      else if (query.includes("addedLabelIds")) { marks.answered.push(variables.id); data = { issueUpdate: { success: true } }; }
      else if (query.includes("teams(first:10)")) data = { project: { id: variables.id, teams: { nodes: [{ key: "CD" }] },
        labels: { nodes: marks.paused ? [{ id: "paused-id", name: "paused", parent: null }] : [] } }, teams: { nodes: [{ id: "team" }] } };
      else if (query.includes("projectLabels(first:250")) data = { projectLabels: { nodes: [] } };
      else if (query.includes("projectLabelCreate")) data = { projectLabelCreate: { projectLabel: { id: "paused-id" } } };
      else if (query.includes("projectAddLabel")) { marks.paused = true; data = { projectAddLabel: { success: true } }; }
      else if (query.includes("projectRemoveLabel")) { marks.paused = false; data = { projectRemoveLabel: { success: true } }; }
      else if (query.includes("commentCreate")) {
        comments.push(variables.i.body);
        data = { commentCreate: { success: true, comment: { id: "c1", body: variables.i.body, createdAt: "t", user: { name: "C", displayName: "C" }, botActor: null, parent: null } } };
      } else if (query.includes("issue(id:$id){ team{key}")) data = { issue: { team: { key: "CD" }, project: { id: "p1" }, description: "", labels: { nodes: [] }, comments: { nodes: [] } } };
      // The check of all projects at once: each project always changed, so each check loads the graph again.
      else if (query.includes("project:{id:{in:$ids}}")) data = { issues: { ...none, nodes: (variables.ids as string[]).map((id) => ({ updatedAt: "2999-01-01T00:00:00Z", project: { id } })) },
        comments: none, ...Object.fromEntries((variables.ids as string[]).map((_, at) => [`d${at}`, { documents: { nodes: [] } }])) };
      else if (query.includes("updatedAt:{gt:$t}")) data = { issues: { nodes: [{ id: "i1" }] }, comments: { nodes: [] }, project: { documents: { nodes: [] } } };
      else if (query.includes("viewer{")) data = { viewer: { id: "me" }, project: { id: variables.id, name: "Effort A", url: "u", projectMilestones: { nodes: [] } } };
      else if (query.includes("issues(first:25")) data = { project: { issues: { nodes: variables.id === "p1" ? [{
        id: "i1", identifier: `${team}-1`, title: "t", description: null, priority: 0, url: "u", sortOrder: 0, updatedAt,
        team: { id: "team", key: team }, state: { id: "s", name: "Needs Human", type: "started", color: "" }, assignee: null,
        labels: { nodes: [] }, projectMilestone: null,
        relations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        inverseRelations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        comments: { nodes: card ? [{ id: "card", body: card }] : [] }, attachments: { nodes: [] }, project: { id: "p1" },
      }] : [], pageInfo: { hasNextPage: false, endCursor: null } } } };
      else if (query.includes("members(first")) data = { teams: { nodes: [] } };
      else data = { issueLabels: { nodes: [], pageInfo: { hasNextPage: false } } };
      return { ok: true, json: async () => ({ data }) };
    }));
    return { comments, marks, touch: (at: string) => { updatedAt = at; }, writeCard: (body: string) => { card = body; } };
  }

  async function start(clock = { at: Date.now() }, linkTimers?: Timers, shared?: Pick<AppOptions, "linkState" | "linkBus" | "redisUrl" | "redisPrefix">) {
    const rules: Rules = { port: 0, tailnet: null };
    const app = createApp(rules, { team: "CD", dist: "/nonexistent/", workspaces: [{ id: "work", name: "Work", team: "CD", key: process.env.LINEAR_API_KEY ?? "", teamLabels: true }], watchMs: 0, now: () => clock.at, linkTimers, ...shared });
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    app.injectWebSocket(server as never);
    await new Promise<void>((ok) => server.once("listening", () => ok()));
    const port = (server.address() as AddressInfo).port;
    rules.port = port;
    closers.push(() => { app.link.stop(); server.close(); });
    return { app, port };
  }

  /** A coordinator socket. `next(type)` resolves with the next message of that type. */
  async function coordinator(port: number, project: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/link?role=coordinator&workspace=work&project=${encodeURIComponent(project)}`);
    const inbox: Envelope[] = [];
    const waiting: { type: string; ok: (m: Envelope) => void }[] = [];
    ws.on("message", (data) => {
      const m = JSON.parse(String(data)) as Envelope;
      const at = waiting.findIndex((w) => w.type === m.type);
      if (at >= 0) waiting.splice(at, 1)[0].ok(m); else inbox.push(m);
    });
    await new Promise((ok, fail) => { ws.once("open", ok); ws.once("error", fail); });
    closers.push(() => ws.close());
    ws.send(JSON.stringify({ v: 1, type: "hello", id: "h", project: { workspace: "work", id: "" }, at: "", payload: { plan: project, session: project, host: "test", wg: "1" } }));
    return {
      ws, inbox,
      next: (type: string) => new Promise<Envelope>((ok) => {
        const at = inbox.findIndex((m) => m.type === type);
        if (at >= 0) ok(inbox.splice(at, 1)[0]); else waiting.push({ type, ok });
      }),
    };
  }

  async function sharedLink(shared: Pick<AppOptions, "linkState" | "linkBus" | "redisUrl" | "redisPrefix">) {
    const linear = fakeLinear("WG");
    const clock = { at: Date.now() };
    const a = await start(clock, undefined, shared);
    const b = await start(clock, undefined, shared);
    const origin = `http://127.0.0.1:${b.port}`;
    const headers = { host: `127.0.0.1:${b.port}`, "x-workspace": "work", origin };
    if (shared.redisUrl) await vi.waitFor(async () => {
      for (const { app, port } of [a, b]) {
        const response = await app.request("/api/status", { headers: { host: `127.0.0.1:${port}` } });
        expect((await response.json()).redisReady).toBe(true);
      }
    });
    const page = new WebSocket(`ws://127.0.0.1:${b.port}/api/link?role=page&workspace=work&project=p1`, { headers: { origin } });
    const notices: Envelope[] = [];
    page.on("message", (data) => notices.push(JSON.parse(String(data))));
    await new Promise((ok, fail) => { page.once("open", ok); page.once("error", fail); });
    closers.push(() => page.close());
    const graph = async () => (await (await b.app.request("/api/projects/p1/graph", { headers })).json()).issues[0].updatedAt;
    expect(await graph()).toBe("2026-11-20T00:00:00Z");
    const wg = await coordinator(a.port, "p1");
    await vi.waitFor(() => expect(notices).toContainEqual(expect.objectContaining({
      type: "presence", payload: { queued: 0, coordinators: [expect.objectContaining({ session: "p1", connected: true })] },
    })));
    const response = await b.app.request("/api/projects/p1/commands", {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ name: "next" }),
    });
    expect(await response.json()).toEqual({ ok: true, queued: 1 });
    const command = await wg.next("command");
    expect(command.payload).toMatchObject({ name: "next" });
    await vi.waitFor(() => expect(notices.at(-1)).toMatchObject({ type: "presence", payload: { queued: 1 } }));
    const beforeAck = notices.length;
    wg.ws.send(msg("ack", { ids: [command.id] }));
    await vi.waitFor(() => expect(notices.slice(beforeAck)).toContainEqual(expect.objectContaining({
      type: "presence", payload: expect.objectContaining({ queued: 0 }),
    })));
    await vi.waitFor(async () => {
      const presence = await b.app.request("/api/projects/p1/presence", { headers });
      expect(await presence.json()).toMatchObject({ queued: 0, waiting: 0 });
    });
    linear.touch("2026-11-20T02:00:00Z");
    expect(await graph()).toBe("2026-11-20T00:00:00Z");
    wg.ws.send(msg("wrote", { issues: ["WG-1"] }));
    await vi.waitFor(() => expect(notices).toContainEqual(expect.objectContaining({
      type: "changed", payload: { by: "coordinator", what: "issue", issues: ["WG-1"] },
    })));
    expect(await graph()).toBe("2026-11-20T02:00:00Z");

    await Promise.all([a.app.link.check(), b.app.link.check()]);
    linear.touch("2026-11-20T03:00:00Z");
    clock.at += 11_000;
    await Promise.all([a.app.link.check(), b.app.link.check()]);
    const presence = await b.app.request("/api/projects/p1/presence", { headers });
    expect(await presence.json()).toMatchObject({ queued: 1, waiting: 0 });

    linear.touch("2026-11-20T04:00:00Z");
    const ownerOrigin = `http://127.0.0.1:${a.port}`;
    const result = await a.app.request("/api/issues/i1/comments", {
      method: "POST", body: JSON.stringify({ body: "Page write" }),
      headers: { host: `127.0.0.1:${a.port}`, origin: ownerOrigin, "content-type": "application/json", "x-workspace": "work", "x-project": "p1" },
    });
    expect(result.status).toBe(200);
    await vi.waitFor(() => expect(notices).toContainEqual(expect.objectContaining({
      type: "changed", payload: expect.objectContaining({ by: "page" }),
    })));
    expect(await graph()).toBe("2026-11-20T04:00:00Z");

    const signed = peer();
    signed.session = "signed-session";
    await b.app.link.hub.joinPage(signed, A);
    await a.app.link.hub.endSession(signed.session, clock.at + 10_000, clock.at);
    await vi.waitFor(() => expect(signed.closed).toEqual([{ code: 1008, reason: "session ended" }]));
    expect(await b.app.link.hub.sessionEnded(signed.session, clock.at)).toBe(true);
  }

  it("shares commands, presence, acknowledgments and graph changes through memory", () =>
    sharedLink({ linkState: memoryLinkState(), linkBus: memoryLinkBus() }));

  it.skipIf(!testRedis)("shares commands, presence, acknowledgments and graph changes through Redis", async () => {
    const redis = await startTestRedis();
    closers.push(redis.close);
    await sharedLink({ redisUrl: redis.url, redisPrefix: `test:${randomUUID()}:` });
  });

  it.skipIf(!testRedis)("passes the Linear check to a live socket after the first hub misses shutdown", async () => {
    const server = await startTestRedis();
    closers.push(server.close);
    const prefix = `test:${randomUUID()}:`;
    const redis = connectRedis(server.url, prefix);
    closers.push(redis.close);
    const bus = redisLinkBus(redis, prefix);
    const firstTime = fakeTime();
    const first = new LinkHub(firstTime.now, undefined, firstTime.timers, null, redisLinkState(redis, prefix, 400), bus);
    const second = new LinkHub(firstTime.now, undefined, undefined, null, redisLinkState(redis, prefix), bus);
    const dead = peer();
    await (await first.joinCoordinator(dead, A)).receive(hello("first"));
    await (await second.joinCoordinator(peer(), A)).receive(hello("second"));
    expect(await first.active({ forCheck: true })).toEqual([A]);
    expect(await second.active({ forCheck: true })).toEqual([]);
    const shutdown = first.shutdown();
    firstTime.advance(SHUTDOWN_MS);
    expect(await shutdown).toBe(true);
    expect(dead.closed).toEqual([{ code: RESTART_CODE, reason: "server restart" }]);
    await vi.waitFor(async () => {
      expect(await second.active({ forCheck: true })).toEqual([A]);
      expect((await second.presence(A)).coordinators).toMatchObject([
        { session: "second", connected: true }, { session: "first", connected: false, lost: true },
      ]);
    });
  });

  it.skipIf(!testRedis)("delivers Redis commands in queue order and suppresses older room snapshots", async () => {
    const server = await startTestRedis();
    closers.push(server.close);
    const prefix = `test:${randomUUID()}:`;
    const redis = connectRedis(server.url, prefix);
    closers.push(redis.close);
    const bus = redisLinkBus(redis, prefix);
    const state = redisLinkState(redis, prefix);
    let release = () => {};
    let delayed = false;
    const delay: LinkBus = {
      ...bus,
      async publish(events) {
        if (!delayed) {
          delayed = true;
          await new Promise<void>((resolve) => { release = resolve; });
        }
        await bus.publish(events);
      },
    };
    const receiver = new LinkHub(undefined, undefined, undefined, null, state, bus);
    const first = new LinkHub(undefined, undefined, undefined, null, state, delay);
    const second = new LinkHub(undefined, undefined, undefined, null, state, bus);
    const wg = peer(), page = peer();
    await (await receiver.joinCoordinator(wg, A)).receive(hello("coordinator"));
    await receiver.joinPage(page, A);
    await vi.waitFor(() => expect(page.of("asks")).toHaveLength(1));
    page.sent.length = 0;

    const a = first.publish(A, "command", { name: "next", key: "first", issue: null });
    await vi.waitFor(() => expect(delayed).toBe(true));
    await second.publish(A, "command", { name: "next", key: "second", issue: null });
    await vi.waitFor(() => expect(page.of("presence").map(({ payload }) => payload)).toMatchObject([{ queued: 2 }]));
    release();
    await a;
    // Wait for an event after both publications, so late delivery cannot hide a failure.
    await second.publish(A, "command", { name: "next", key: "third", issue: null });
    await vi.waitFor(() => expect(wg.of("command")).toHaveLength(3));
    expect(wg.of("command").map((message) => message.payload)).toMatchObject([
      { key: "first" }, { key: "second" }, { key: "third" },
    ]);
    expect(page.of("presence").map((message) => message.payload)).toMatchObject([
      { queued: 2 }, { queued: 3 },
    ]);

    delayed = false;
    const late = peer();
    const joined = first.joinPage(late, A);
    await vi.waitFor(() => expect(delayed).toBe(true));
    await second.publish(A, "command", { name: "next", key: "fourth", issue: null });
    await vi.waitFor(() => expect(late.of("presence").map(({ payload }) => payload)).toMatchObject([{ queued: 4 }]));
    release();
    await joined;
    await vi.waitFor(() => expect(late.of("asks")).toHaveLength(1));
    expect(late.of("presence")).toHaveLength(1);

    const offline = new LinkHub(undefined, undefined, undefined, null, state, {
      ...bus, async publish() { throw new Error("dropped event"); },
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await offline.publish(A, "command", { name: "next", key: "fifth", issue: null });
      expect(wg.of("command")).toHaveLength(4);
      await receiver.beat();
      expect(wg.of("command").at(-1)?.payload).toMatchObject({ key: "fifth" });
    } finally {
      log.mockRestore();
    }
  });

  it("accepts a queued command when its delivery fails and the coordinator reads the queue again", async () => {
    const state = memoryLinkState();
    const bus = memoryLinkBus();
    let failure = false;
    const shared = {
      linkState: { ...state, async read(ref: typeof A) {
        if (failure) throw new Error("room read unavailable");
        return state.read(ref);
      } }, linkBus: {
        ...bus, async publish(events: Parameters<LinkBus["publish"]>[0]) {
          if (failure) throw new Error("bus unavailable");
          await bus.publish(events);
        },
      },
    };
    fakeLinear("WG");
    const { app, port } = await start(undefined, undefined, shared);
    const host = `127.0.0.1:${port}`;
    const headers = { host, origin: `http://${host}`, "x-workspace": "work", "content-type": "application/json" };
    failure = true;
    const response = await app.request("/api/projects/p1/commands", {
      method: "POST", headers, body: JSON.stringify({ name: "next" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, queued: 1 });
    failure = false;
    const wg = await coordinator(port, "p1");
    expect((await wg.next("command")).payload).toMatchObject({ name: "next" });
  });

  it.skipIf(!localRedis)("closes sockets after Redis stops and delivers the queued command after recovery", async () => {
    fakeLinear("WG");
    const redis = await startLocalRedis();
    closers.push(redis.close);
    const { app, port } = await start(undefined, undefined, { redisUrl: redis.url });
    const host = `127.0.0.1:${port}`;
    const headers = { host, origin: `http://${host}`, "x-workspace": "work" };
    const status = async () => (await app.request("/api/status", { headers })).json();
    await vi.waitFor(async () => expect(await status()).toMatchObject({ linkStore: "redis", redisReady: true }));
    const wg = await coordinator(port, "p1");
    const request = await app.request("/api/projects/p1/commands", {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ name: "next" }),
    });
    expect(request.status).toBe(200);
    const command = await wg.next("command");
    const closed = new Promise<number>((resolve) => wg.ws.once("close", resolve));
    await redis.stop();
    expect(await closed).toBe(RESTART_CODE);
    expect(await status()).toMatchObject({ linkStore: "redis", redisReady: false });
    expect((await app.request("/api/projects/p1/graph", { headers })).status).toBe(200);
    expect((await app.request("/api/link?role=coordinator&workspace=work&project=p1", { headers: { host } })).status).toBe(503);
    await redis.start();
    await vi.waitFor(async () => expect(await status()).toMatchObject({ redisReady: true }), { timeout: 4_000 });
    const reconnected = await coordinator(port, "p1");
    expect(await reconnected.next("command")).toEqual(command);
  });

  it("tells only the coordinator of the project about a comment written in the page", async () => {
    const linear = fakeLinear();
    const { app, port } = await start();
    const a = await coordinator(port, "Effort A"); // by name
    const b = await coordinator(port, "p2"); // by id
    await vi.waitFor(async () => expect(await app.link.hub.active()).toHaveLength(2));
    const response = await app.request("/api/issues/i1/comments", {
      method: "POST", body: JSON.stringify({ body: "Use the v2 API." }),
      headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "content-type": "application/json", "x-workspace": "work", "x-project": "p1" },
    });
    expect(response.status).toBe(200);
    expect(linear.comments).toEqual(["Use the v2 API."]);
    expect((await a.next("changed")).payload).toEqual({ by: "page", what: "comment", issues: ["CD-1"] });
    // CD-1 is Needs Human, so the comment is their answer.
    expect((await a.next("answer")).payload).toEqual({ issue: "CD-1", key: null, body: "Use the v2 API." });
    expect(linear.marks.answered).toEqual(["i1"]); // the record in Linear: wg next finds it after a restart
    await new Promise((ok) => setTimeout(ok, 50));
    expect(b.inbox.filter((m) => m.type === "changed")).toEqual([]);
  });

  it("records a reply to a worker question in Linear and passes it to the coordinator", async () => {
    const linear = fakeLinear();
    const { app, port } = await start();
    const a = await coordinator(port, "Effort A");
    a.ws.send(JSON.stringify({ v: 1, type: "asks", id: "x", project: {}, at: "", payload: { asks: [{ id: "msg_q", key: "a", issue: "CD-1", from: "ctx_1", body: "Which API?", at: "t" }] } }));
    await vi.waitFor(async () => expect(await app.link.hub.ask({ workspace: "work", id: "p1" }, "msg_q")).not.toBeNull());
    const headers = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "content-type": "application/json", "x-workspace": "work" };
    const response = await app.request("/api/projects/p1/asks/msg_q/reply", { method: "POST", headers, body: JSON.stringify({ body: "Use v2." }) });
    expect(await response.json()).toEqual({ ok: true, recorded: true });
    expect(linear.comments).toEqual(["**Reply to a worker question** (from the page)\n\n> Which API?\n\nUse v2."]);
    expect((await a.next("reply")).payload).toEqual({ ask: "msg_q", issue: "CD-1", key: "a", body: "Use v2." });
    expect(await app.link.hub.ask({ workspace: "work", id: "p1" }, "msg_q")).toBeNull();
    const again = await app.request("/api/projects/p1/asks/msg_q/reply", { method: "POST", headers, body: JSON.stringify({ body: "Again" }) });
    expect(again.status).toBe(404);
  });

  it("passes commands to the coordinator; a dispatch is also a comment on its issue", async () => {
    const linear = fakeLinear();
    const { app, port } = await start();
    const a = await coordinator(port, "Effort A");
    await vi.waitFor(async () => expect(await app.link.hub.active()).toHaveLength(1));
    const headers = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "content-type": "application/json", "x-workspace": "work" };
    const post = (body: unknown) => app.request("/api/projects/p1/commands", { method: "POST", headers, body: JSON.stringify(body) });
    expect((await post({ name: "dispatch", key: "a", issue: "CD-1" })).status).toBe(200);
    expect(linear.comments).toEqual(["**Dispatch requested** on the page. The coordinator dispatches it at its next `wg next`."]);
    expect((await a.next("command")).payload).toEqual({ name: "dispatch", key: "a", issue: "CD-1" });
    expect((await post({ name: "pause" })).status).toBe(200);
    expect((await a.next("command")).payload).toEqual({ name: "pause", key: null, issue: null });
    expect(linear.marks.paused).toBe(true); // the project label is the record
    expect(linear.comments).toHaveLength(1); // pause writes no comment
    expect((await post({ name: "resume" })).status).toBe(200);
    expect((await a.next("command")).payload).toEqual({ name: "resume", key: null, issue: null });
    expect(linear.marks.paused).toBe(false);
    expect((await post({ name: "delete-everything" })).status).toBe(400);
    expect((await post({ name: "dispatch", key: "a", issue: "CD-404" })).status).toBe(404);
  });

  it("stops calling Linear for a project whose coordinator sent no pong for 45 s", async () => {
    fakeLinear();
    const time = fakeTime();
    const { app, port } = await start(time.clock, time.timers);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/link?role=coordinator&workspace=work&project=p1`, { autoPong: false });
    const closed = new Promise<number>((ok) => ws.once("close", (code) => ok(code)));
    await new Promise((ok) => ws.once("open", ok));
    closers.push(() => ws.terminate());
    ws.send(JSON.stringify({ v: 1, type: "hello", id: "h", project: { workspace: "work", id: "" }, at: "", payload: { plan: "p", session: "sleeping", host: "test", wg: "1" } }));
    await vi.waitFor(async () => expect(await app.link.hub.active()).toHaveLength(1));
    const calls = () => (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    let before = calls();
    await app.link.check();
    expect(calls()).toBeGreaterThan(before); // a live coordinator: the server checks Linear
    time.advance(DEAD_MS);
    expect(await closed).toBe(1006);
    before = calls();
    await app.link.check();
    expect(calls()).toBe(before); // no live coordinator: no Linear request
  });

  it("loads no graph for a project whose last coordinator timed out while the check of all projects waited", async () => {
    fakeLinear();
    const time = fakeTime();
    const { app, port } = await start(time.clock, time.timers);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/link?role=coordinator&workspace=work&project=p1`, { autoPong: false });
    const closed = new Promise<number>((ok) => ws.once("close", (code) => ok(code)));
    await new Promise((ok) => ws.once("open", ok));
    closers.push(() => ws.terminate());
    ws.send(JSON.stringify({ v: 1, type: "hello", id: "h", project: { workspace: "work", id: "" }, at: "", payload: { plan: "p", session: "sleeping", host: "test", wg: "1" } }));
    await vi.waitFor(async () => expect(await app.link.hub.active()).toHaveLength(1));
    await app.link.check(); // the graph of p1 is now in the cache
    time.clock.at += 60_000; // past the time in which the cache answers from memory
    // The next check of all projects waits for Linear; the coordinator times out meanwhile.
    const inner = globalThis.fetch;
    const queries: string[] = [];
    let release = () => {}, asked = () => {};
    const gate = new Promise<void>((ok) => { release = ok; });
    const waiting = new Promise<void>((ok) => { asked = ok; });
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
      const { query } = JSON.parse((args[1] as RequestInit).body as string);
      queries.push(query);
      if (query.includes("project:{id:{in:$ids}}")) { asked(); await gate; }
      return inner(...args);
    });
    const checked = app.link.check();
    await waiting;
    time.advance(DEAD_MS);
    expect(await closed).toBe(1006);
    expect(await app.link.hub.active()).toEqual([]);
    release();
    await checked;
    expect(queries.filter((q) => q.includes("issues(first:25"))).toEqual([]); // no load of the graph
  });

  it("refuses with 503 an upgrade that waited for its project while the server began to stop", async () => {
    fakeLinear();
    const inner = globalThis.fetch;
    let release = () => {}, asked = () => {};
    const gate = new Promise<void>((ok) => { release = ok; });
    const lookup = new Promise<void>((ok) => { asked = ok; });
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => { asked(); await gate; return inner(...args); });
    const { app, port } = await start();
    const status = new Promise<number>((ok) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/link?role=coordinator&workspace=work&project=Effort%20A`);
      ws.on("unexpected-response", (_req, res) => ok(res.statusCode ?? 0));
      ws.on("open", () => { ws.close(); ok(101); });
    });
    await lookup; // the upgrade now waits for the project list
    const stopped = app.link.shutdown();
    release();
    expect(await status).toBe(503);
    await stopped;
  });

  it("finds a Linear edit that did not come through the page", async () => {
    const linear = fakeLinear();
    const clock = { at: Date.now() };
    const { app, port } = await start(clock);
    const a = await coordinator(port, "Effort A");
    await vi.waitFor(async () => expect(await app.link.hub.active()).toHaveLength(1));
    await app.link.check(); // the first look records the state
    await app.link.check(); // no change: nothing to tell
    expect(a.inbox.filter((m) => m.type === "changed")).toEqual([]);
    linear.touch("2026-11-20T01:00:00Z");
    clock.at += 11_000; // past the 10 s in which the graph cache answers from memory
    await app.link.check();
    expect((await a.next("changed")).payload).toEqual({ by: "linear", what: "issue", issues: ["CD-1"] });
  });

  it("finds a changed node card of the same length, with no change of the issue", async () => {
    const linear = fakeLinear("TM"); // a fictional team
    const clock = { at: Date.now() };
    const { app, port } = await start(clock);
    const a = await coordinator(port, "Effort A");
    await vi.waitFor(async () => expect(await app.link.hub.active()).toHaveLength(1));
    linear.writeCard("**work-graph node card** `a`\n\n```json\n{\"wg\":1}\n```");
    await app.link.check(); // the first look records the state
    linear.writeCard("**work-graph node card** `a`\n\n```json\n{\"wg\":2}\n```");
    clock.at += 11_000;
    await app.link.check();
    expect((await a.next("changed")).payload).toEqual({ by: "linear", what: "issue", issues: ["TM-1"] });
  });

  it("after wrote, the page hears of it and the next graph load skips the cache", async () => {
    const linear = fakeLinear();
    const { app, port } = await start();
    const headers = { host: `127.0.0.1:${port}`, "x-workspace": "work" };
    const graph = async () => (await (await app.request("/api/projects/p1/graph", { headers })).json()).issues[0].updatedAt;
    expect(await graph()).toBe("2026-11-20T00:00:00Z");
    const page = new WebSocket(`ws://127.0.0.1:${port}/api/link?role=page&workspace=work&project=p1`, { headers: { origin: `http://127.0.0.1:${port}` } });
    const changed = new Promise<Envelope>((ok) => page.on("message", (d) => { const m = JSON.parse(String(d)); if (m.type === "changed") ok(m); }));
    await new Promise((ok) => page.once("open", ok));
    closers.push(() => page.close());
    linear.touch("2026-11-20T02:00:00Z");
    expect(await graph()).toBe("2026-11-20T00:00:00Z"); // the cache answers within 10 s
    const wg = new WebSocket(`ws://127.0.0.1:${port}/api/link?role=coordinator&workspace=work&project=p1`);
    await new Promise((ok) => wg.once("open", ok));
    closers.push(() => wg.close());
    wg.send(JSON.stringify({ v: 1, type: "wrote", id: "w", project: { workspace: "", id: "p1" }, at: "", payload: { issues: ["CD-1"] } }));
    expect((await changed).payload).toEqual({ by: "coordinator", what: "issue", issues: ["CD-1"] });
    expect(await graph()).toBe("2026-11-20T02:00:00Z");
  });

  it("reports the messages that wait for a coordinator, for wg wake", async () => {
    fakeLinear();
    const { app, port } = await start();
    const headers = { host: `127.0.0.1:${port}`, "x-workspace": "work" };
    const presence = async () => (await app.request("/api/projects/p1/presence", { headers })).json();
    expect(await presence()).toEqual({ coordinators: [], queued: 0, waiting: 0 });
    await app.link.hub.publish({ workspace: "work", id: "p1" }, "changed", { by: "page", what: "status", issues: ["CD-1"] });
    await app.link.hub.publish({ workspace: "work", id: "p1" }, "command", { name: "dispatch", key: "a", issue: "CD-1" });
    expect(await presence()).toEqual({ coordinators: [], queued: 2, waiting: 1 });
  });

  it("refuses a page socket from another origin, and an unknown project", async () => {
    fakeLinear();
    const { port } = await start();
    const refused = (url: string, headers: Record<string, string> = {}) => new Promise<number>((ok) => {
      const ws = new WebSocket(url, { headers });
      ws.on("unexpected-response", (_req, res) => ok(res.statusCode ?? 0));
      ws.on("open", () => { ws.close(); ok(101); });
    });
    expect(await refused(`ws://127.0.0.1:${port}/api/link?role=page`, { origin: "https://evil.example" })).toBe(403);
    expect(await refused(`ws://127.0.0.1:${port}/api/link?role=coordinator&project=Nope`)).toBe(404);
    expect(await refused(`ws://127.0.0.1:${port}/api/link?role=page`, { origin: `http://127.0.0.1:${port}` })).toBe(101);
  });
});
