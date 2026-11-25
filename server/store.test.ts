import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Envelope } from "../src/lib/link.ts";
import { createApp } from "./app.ts";
import { LinkHub, type Peer, QUEUE_MAX, stopOnSignals } from "./link.ts";
import { fileStore, SAVE_MS, STATE_FILE, STATE_VERSION } from "./store.ts";

const A = { workspace: "work", id: "p1" };
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), "wg-state-")); dirs.push(d); return d; };

/** A debounce timer that runs only when the test says so. */
function fakeAfter() {
  const jobs: { fn: () => void; ms: number; off: boolean }[] = [];
  const after = (fn: () => void, ms: number) => { const job = { fn, ms, off: false }; jobs.push(job); return () => { job.off = true; }; };
  const run = () => { for (const j of jobs.splice(0)) if (!j.off) j.fn(); };
  return { after, run, waiting: () => jobs.filter((j) => !j.off).map((j) => j.ms) };
}
function peer() {
  const sent: Envelope[] = [];
  const p: Peer & { sent: Envelope[]; of: (type: string) => Envelope[] } = { send: (t) => sent.push(JSON.parse(t)), close: () => {}, sent, of: (type) => sent.filter((m) => m.type === type) };
  return p;
}
const msg = (type: string, payload: unknown = {}) => JSON.stringify({ v: 1, type, id: "x", project: A, at: "", payload });
const hello = (session: string) => msg("hello", { plan: "/plans/a", session, host: "mac", wg: "1" });
const ask = { id: "ask-1", key: "a", issue: "CD-1", from: "worker", body: "Which base?", at: "2026-11-20T00:00:00Z" };

describe("fileStore", () => {
  it("loads a config link-state file from main", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, STATE_FILE), '{"version":1,"rooms":[{"ref":{"workspace":"work","id":"p1"},"queue":[{"v":1,"type":"command","id":"next","project":{"workspace":"work","id":"p1"},"at":"","payload":{"name":"next","key":null,"issue":null}}],"asks":[{"id":"ask-1","key":"a","issue":"CD-1","from":"worker","body":"Which base?","at":"2026-11-20T00:00:00Z"}]}]}', { mode: 0o600 });
    const hub = new LinkHub(undefined, undefined, undefined, fileStore(dir, { queueMax: QUEUE_MAX, after: fakeAfter().after, log: () => {} }));
    const coordinator = peer();
    await (await hub.joinCoordinator(coordinator, A)).receive(hello("legacy"));
    expect(coordinator.of("command").map(({ id }) => id)).toEqual(["next"]);
    expect(await hub.ask(A, "ask-1")).toEqual(ask);
  });

  it("restarts a hub over the same directory with the queued reply and command, and the asks", async () => {
    const dir = tempDir(), timer = fakeAfter(), logs: string[] = [];
    const store = () => fileStore(dir, { queueMax: QUEUE_MAX, after: timer.after, log: (l) => logs.push(l) });
    const first = new LinkHub(undefined, undefined, undefined, store());
    const coordinator = peer(), c = await first.joinCoordinator(coordinator, A);
    await c.receive(hello("s1"));
    await c.receive(msg("asks", { asks: [ask] }));
    const reply = await first.publish(A, "reply", { ask: "ask-0", issue: "CD-1", key: "a", body: "main" });
    const command = await first.publish(A, "command", { name: "dispatch", key: "b", issue: "CD-2" });
    const done = await first.publish(A, "command", { name: "next", key: null, issue: null });
    // One write for all the changes, at most SAVE_MS after the first.
    expect(timer.waiting()).toEqual([SAVE_MS]);
    timer.run();
    await c.receive(msg("ack", { ids: [done.id] })); // written at once
    expect(timer.waiting()).toEqual([]);
    expect(statSync(join(dir, STATE_FILE)).mode & 0o777).toBe(0o600);

    const second = new LinkHub(undefined, undefined, undefined, store());
    const again = peer(), c2 = await second.joinCoordinator(again, A);
    await c2.receive(hello("s2"));
    expect(again.sent.map((m) => m.id)).toEqual([reply.id, command.id]); // not the acknowledged one
    expect(again.of("reply")[0].payload).toEqual({ ask: "ask-0", issue: "CD-1", key: "a", body: "main" });
    expect((await second.presence(A)).queued).toBe(2);
    expect(await second.ask(A, "ask-1")).toEqual(ask);
    const page = peer();
    await second.joinPage(page, A);
    expect(page.of("asks")[0].payload).toEqual({ asks: [ask] });
    expect(logs).toEqual(["link state: no " + join(dir, STATE_FILE) + "; the link starts empty"]);
  });

  it("writes an acknowledgment that waits when the server stops", async () => {
    const dir = tempDir(), timer = fakeAfter();
    const store = () => fileStore(dir, { queueMax: QUEUE_MAX, after: timer.after, log: () => {} });
    const hub = new LinkHub(undefined, undefined, undefined, store());
    const sent = await hub.publish(A, "answer", { issue: "CD-1", key: "a", body: "yes" });
    timer.run();
    const c = await hub.joinCoordinator(peer(), A);
    await c.receive(hello("s1"));
    await c.receive(msg("ack", { ids: [sent.id] }));
    await hub.shutdown(); // before the debounce timer runs
    const again = peer(), c2 = await new LinkHub(undefined, undefined, undefined, store()).joinCoordinator(again, A);
    await c2.receive(hello("s2"));
    expect(again.sent).toEqual([]);
  });

  it("writes an acknowledgment at once, so a hub that starts before the debounce timer does not send the message again", async () => {
    const dir = tempDir(), timer = fakeAfter();
    const store = () => fileStore(dir, { queueMax: QUEUE_MAX, after: timer.after, log: () => {} });
    const hub = new LinkHub(undefined, undefined, undefined, store());
    const sent = await hub.publish(A, "command", { name: "dispatch", key: "a", issue: "CD-1" });
    timer.run();
    const c = await hub.joinCoordinator(peer(), A);
    await c.receive(hello("s1"));
    await c.receive(msg("ack", { ids: [sent.id] }));
    // No timer runs and no shutdown: the process stops here.
    const again = peer(), c2 = await new LinkHub(undefined, undefined, undefined, store()).joinCoordinator(again, A);
    await c2.receive(hello("s2"));
    expect(again.sent).toEqual([]);
  });

  it("writes the state after the sockets closed, with an acknowledgment that came while they closed", async () => {
    const dir = tempDir(), timer = fakeAfter();
    const store = () => fileStore(dir, { queueMax: QUEUE_MAX, after: timer.after, log: () => {} });
    const hub = new LinkHub(undefined, undefined, undefined, store());
    const sent = await hub.publish(A, "reply", { ask: "ask-1", issue: "CD-1", key: "a", body: "main" });
    timer.run();
    const c = await hub.joinCoordinator(peer(), A);
    await c.receive(hello("s1"));
    const stopped = hub.shutdown();
    await c.receive(msg("ack", { ids: [sent.id] }));
    await hub.publish(A, "command", { name: "next", key: null, issue: null }); // an HTTP request while the sockets close
    await c.closed();
    await stopped;
    const again = peer(), c2 = await new LinkHub(undefined, undefined, undefined, store()).joinCoordinator(again, A);
    await c2.receive(hello("s2"));
    expect(again.sent.map((m) => m.type)).toEqual(["command"]);
  });

  it("keeps a change after a failed write, and writes it at the next try", async () => {
    const parent = tempDir(), dir = join(parent, "state"), timer = fakeAfter(), logs: string[] = [];
    writeFileSync(dir, "a file where the directory must be");
    const store = fileStore(dir, { queueMax: QUEUE_MAX, after: timer.after, log: (l) => logs.push(l) });
    const hub = new LinkHub(undefined, undefined, undefined, store);
    const sent = await hub.publish(A, "command", { name: "dispatch", key: "a", issue: "CD-1" });
    timer.run();
    expect(logs.filter((l) => l.includes("cannot write"))).toHaveLength(1);
    expect(timer.waiting()).toEqual([SAVE_MS]); // the next try
    rmSync(dir);
    store.flush();
    const saved = JSON.parse(readFileSync(join(dir, STATE_FILE), "utf8"));
    expect(saved.rooms[0].queue.map((m: Envelope) => m.id)).toEqual([sent.id]);
    expect(timer.waiting()).toEqual([]);
  });

  it("removes an answered ask from the file, and keeps at most 100 asks of a room", async () => {
    const dir = tempDir(), timer = fakeAfter();
    const store = () => fileStore(dir, { queueMax: QUEUE_MAX, after: timer.after, log: () => {} });
    const asks = Array.from({ length: 150 }, (_, i) => ({ ...ask, id: `ask-${i}` }));
    const many = store();
    many.save(() => ({ rooms: [{ ref: A, queue: [], asks }] }));
    many.flush();
    const saved = JSON.parse(readFileSync(join(dir, STATE_FILE), "utf8"));
    expect(saved.rooms[0].asks.map((a: { id: string }) => a.id)).toEqual(asks.slice(0, 100).map((a) => a.id));

    const hub = new LinkHub(undefined, undefined, undefined, store());
    expect(await hub.ask(A, "ask-0")).toEqual(asks[0]);
    await hub.answered(A, "ask-0");
    timer.run();
    const after = new LinkHub(undefined, undefined, undefined, store());
    expect(await after.ask(A, "ask-0")).toBeNull();
    expect(await after.ask(A, "ask-1")).toEqual(asks[1]);
  });

  it("writes at an acknowledgment of a message that a full queue dropped, so a restart does not send it again", async () => {
    const dir = tempDir(), timer = fakeAfter();
    const store = () => fileStore(dir, { queueMax: QUEUE_MAX, after: timer.after, log: () => {} });
    const hub = new LinkHub(undefined, undefined, undefined, store());
    const oldest = await hub.publish(A, "command", { name: "dispatch", key: "a", issue: "CD-1" });
    timer.run(); // the file holds the oldest message
    for (let i = 0; i < QUEUE_MAX; i++) await hub.publish(A, "command", { name: "next", key: null, issue: null });
    expect((await hub.presence(A)).queued).toBe(QUEUE_MAX); // the queue dropped the oldest; the write waits
    const c = await hub.joinCoordinator(peer(), A);
    await c.receive(hello("s1"));
    await c.receive(msg("ack", { ids: [oldest.id] }));
    // No timer runs: the process stops here.
    const again = peer(), c2 = await new LinkHub(undefined, undefined, undefined, store()).joinCoordinator(again, A);
    await c2.receive(hello("s2"));
    expect(again.sent).toHaveLength(QUEUE_MAX);
    expect(again.sent.map((m) => m.id)).not.toContain(oldest.id);
  });

  it("gives false from shutdown when the last write failed, and true when the next try at the stop succeeds", async () => {
    if (process.getuid?.() === 0) return; // a read-only directory does not stop root
    const dir = tempDir(), timer = fakeAfter(), logs: string[] = [];
    const store = () => fileStore(dir, { queueMax: QUEUE_MAX, after: timer.after, log: (l) => logs.push(l) });
    const hub = new LinkHub(undefined, undefined, undefined, store());
    const sent = await hub.publish(A, "command", { name: "dispatch", key: "a", issue: "CD-1" });
    timer.run();
    const c = await hub.joinCoordinator(peer(), A);
    await c.receive(hello("s1"));
    chmodSync(dir, 0o500); // the temporary file cannot be made
    try {
      await c.receive(msg("ack", { ids: [sent.id] }));
      expect(logs.filter((l) => l.includes("cannot write"))).toHaveLength(1);
      await c.closed();
      expect(await hub.shutdown()).toBe(false);
      // A restart now sends the acknowledged message again: the stop knows it.
      const lost = peer(), c2 = await new LinkHub(undefined, undefined, undefined, store()).joinCoordinator(lost, A);
      await c2.receive(hello("s2"));
      expect(lost.sent.map((m) => m.id)).toEqual([sent.id]);
    } finally {
      chmodSync(dir, 0o700);
    }

    const second = new LinkHub(undefined, undefined, undefined, store());
    const d = await second.joinCoordinator(peer(), A);
    await d.receive(hello("s3"));
    chmodSync(dir, 0o500);
    try {
      await d.receive(msg("ack", { ids: [sent.id] })); // fails
    } finally {
      chmodSync(dir, 0o700);
    }
    await d.closed();
    expect(await second.shutdown()).toBe(true); // the try at the stop succeeds
    const again = peer(), c3 = await new LinkHub(undefined, undefined, undefined, store()).joinCoordinator(again, A);
    await c3.receive(hello("s4"));
    expect(again.sent).toEqual([]);
  });

  it("exits with 1 when the stop did not write the link state", async () => {
    const exits: number[] = [];
    for (const saved of [false, true]) {
      const handlers = new Map<string, () => void>();
      stopOnSignals(() => Promise.resolve(saved), (signal, fn) => handlers.set(signal, fn), (code) => exits.push(code));
      handlers.get("SIGTERM")!();
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(exits).toEqual([1, 0]);
  });

  it("writes the file with mode 600 also when an old temporary file of mode 644 is in the directory", () => {
    const dir = tempDir();
    for (const name of [`${STATE_FILE}.${process.pid}.tmp`, STATE_FILE]) {
      writeFileSync(join(dir, name), "old", { mode: 0o644 });
      chmodSync(join(dir, name), 0o644);
    }
    const store = fileStore(dir, { queueMax: QUEUE_MAX, after: fakeAfter().after, log: () => {} });
    store.save(() => ({ rooms: [{ ref: A, queue: [], asks: [ask] }] }));
    expect(store.flush()).toBe(true);
    expect(statSync(join(dir, STATE_FILE)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(dir, STATE_FILE), "utf8")).rooms[0].asks).toEqual([ask]);
    // Only the old temporary file stays: each write makes and renames its own.
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([`${STATE_FILE}.${process.pid}.tmp`]);
  });

  it("starts empty with one log line when the file is unreadable or of another version", async () => {
    for (const text of ["not json", JSON.stringify({ version: STATE_VERSION + 1, rooms: [{ ref: A, queue: [], asks: [ask] }] })]) {
      const dir = tempDir(), logs: string[] = [];
      writeFileSync(join(dir, STATE_FILE), text);
      const hub = new LinkHub(undefined, undefined, undefined, fileStore(dir, { queueMax: QUEUE_MAX, after: fakeAfter().after, log: (l) => logs.push(l) }));
      expect(await hub.state()).toEqual({ rooms: [] });
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatch(/cannot use .*; the link starts empty$/);
    }
  });

  it("keeps only valid entries, and at most QUEUE_MAX messages of a room", () => {
    const dir = tempDir();
    const envelope = (i: number) => ({ v: 1, type: "command", id: `m${i}`, project: A, at: "", payload: { name: "next", key: null, issue: null } });
    const queue = [...Array.from({ length: QUEUE_MAX + 5 }, (_, i) => envelope(i)), { id: 7 }, null];
    writeFileSync(join(dir, STATE_FILE), JSON.stringify({ version: STATE_VERSION, rooms: [{ ref: A, queue, asks: [ask, { id: "" }] }, { ref: "bad" }] }));
    const { rooms } = fileStore(dir, { queueMax: QUEUE_MAX, after: fakeAfter().after, log: () => {} }).load();
    expect(rooms).toHaveLength(1);
    expect(rooms[0].queue.map((m) => m.id)).toEqual(Array.from({ length: QUEUE_MAX }, (_, i) => `m${i + 5}`));
    expect(rooms[0].asks).toEqual([ask]);
  });

  it("drops a saved message of another link version, of a type that is not for the queue, with no payload, or of another room", () => {
    const dir = tempDir();
    const good = { v: 1, type: "reply", id: "good", project: A, at: "", payload: { ask: "a", issue: null, key: null, body: "yes" } };
    const queue = [
      good, { ...good, id: "v2", v: 2 }, { ...good, id: "hello", type: "hello" }, { ...good, id: "bad-type", type: "toString" },
      { ...good, id: "no-payload", payload: undefined }, { ...good, id: "other-room", project: { workspace: "work", id: "p2" } },
    ];
    writeFileSync(join(dir, STATE_FILE), JSON.stringify({ version: STATE_VERSION, rooms: [{ ref: A, queue, asks: [] }] }));
    const { rooms } = fileStore(dir, { queueMax: QUEUE_MAX, after: fakeAfter().after, log: () => {} }).load();
    expect(rooms[0].queue.map((m) => m.id)).toEqual(["good"]);
  });

  it("starts empty with one log line when the file cannot be read", async () => {
    const dir = tempDir(), logs: string[] = [];
    mkdirSync(join(dir, STATE_FILE)); // a read gives EISDIR
    const hub = new LinkHub(undefined, undefined, undefined, fileStore(dir, { queueMax: QUEUE_MAX, after: fakeAfter().after, log: (l) => logs.push(l) }));
    expect(await hub.state()).toEqual({ rooms: [] });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^link state: cannot read .*EISDIR.*; the link starts empty$/);
    const page = peer();
    await hub.joinPage(page, A); // the hub works
    expect(page.of("asks")[0].payload).toEqual({ asks: [] });
  });

  it("refuses a state directory in the page directory, with one log line, and keeps the state in memory only", async () => {
    const dist = tempDir(), stateDir = join(dist, "state");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const app = createApp({ port: 4747, tailnet: null, hosted: null }, { team: "T", dist: `${dist}/`, watchMs: 0, stateDir });
      await app.link.hub.publish(A, "reply", { ask: "a", issue: null, key: null, body: "secret" });
      expect(await app.link.shutdown()).toBe(true);
      expect(existsSync(stateDir)).toBe(false);
      const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("link state:"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/is in the page directory/);
      const res = await app.request("/state/link-state.json");
      expect(await res.text()).not.toContain("secret");
    } finally {
      log.mockRestore();
    }
  });

  it("loads only the rooms of the configured workspaces, so the overview gets no ask of a removed workspace", async () => {
    const dir = tempDir();
    const gone = { workspace: "gone", id: "p9" };
    writeFileSync(join(dir, STATE_FILE), JSON.stringify({
      version: STATE_VERSION,
      rooms: [{ ref: A, queue: [], asks: [ask] }, { ref: gone, queue: [], asks: [{ ...ask, id: "ask-gone" }] }],
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const app = createApp({ port: 4747, tailnet: null, hosted: null }, {
        team: "T", dist: `${tempDir()}/`, watchMs: 0, stateDir: dir,
        workspaces: [{ id: "work", name: "Work", team: "T", key: "", teamLabels: true }],
      });
      const overview = peer();
      await app.link.hub.joinPage(overview, null);
      expect(overview.of("asks").map((m) => m.project)).toEqual([A]);
      expect(await app.link.hub.ask(gone, "ask-gone")).toBeNull();
      expect(log.mock.calls.map((c) => String(c[0]))).toContain("link state: ignored 1 rooms of workspaces that the config does not name");
      app.link.stop();
    } finally {
      log.mockRestore();
    }
  });

  it("writes nothing without a state directory", async () => {
    const dir = tempDir();
    delete process.env.WG_STATE_DIR;
    const app = createApp({ port: 4747, tailnet: null, hosted: null }, { team: "T", dist: dir, watchMs: 0 });
    await app.link.hub.publish(A, "command", { name: "next", key: null, issue: null });
    app.link.stop();
    expect(() => readFileSync(join(dir, STATE_FILE))).toThrow();
  });

  it("builds the store from WG_STATE_DIR when the app gets no state directory", async () => {
    const dir = tempDir();
    process.env.WG_STATE_DIR = dir;
    try {
      const app = createApp({ port: 4747, tailnet: null, hosted: null }, { team: "T", dist: `${tempDir()}/`, watchMs: 0 });
      const sent = await app.link.hub.publish(A, "command", { name: "next", key: null, issue: null });
      await app.link.shutdown();
      const saved = JSON.parse(readFileSync(join(dir, STATE_FILE), "utf8"));
      expect(saved.rooms[0].queue.map((m: Envelope) => m.id)).toEqual([sent.id]);
    } finally {
      delete process.env.WG_STATE_DIR;
    }
  });

  it("builds the store from the state directory of the app", async () => {
    const dir = tempDir();
    const app = createApp({ port: 4747, tailnet: null, hosted: null }, { team: "T", dist: `${tempDir()}/`, watchMs: 0, stateDir: dir });
    const sent = await app.link.hub.publish(A, "command", { name: "next", key: null, issue: null });
    await app.link.shutdown();
    const saved = JSON.parse(readFileSync(join(dir, STATE_FILE), "utf8"));
    expect(saved.rooms[0].queue.map((m: Envelope) => m.id)).toEqual([sent.id]);
  });
});
