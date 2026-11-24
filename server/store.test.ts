import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Envelope } from "../src/lib/link.ts";
import { createApp } from "./app.ts";
import { LinkHub, type Peer, QUEUE_MAX } from "./link.ts";
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
  it("restarts a hub over the same directory with the queued reply and command, and the asks", () => {
    const dir = tempDir(), timer = fakeAfter(), logs: string[] = [];
    const store = () => fileStore(dir, { queueMax: QUEUE_MAX, after: timer.after, log: (l) => logs.push(l) });
    const first = new LinkHub(undefined, undefined, undefined, store());
    const coordinator = peer(), c = first.joinCoordinator(coordinator, A);
    c.receive(hello("s1"));
    c.receive(msg("asks", { asks: [ask] }));
    const reply = first.publish(A, "reply", { ask: "ask-0", issue: "CD-1", key: "a", body: "main" });
    const command = first.publish(A, "command", { name: "dispatch", key: "b", issue: "CD-2" });
    const done = first.publish(A, "command", { name: "next", key: null, issue: null });
    c.receive(msg("ack", { ids: [done.id] }));
    // One write for all the changes, at most SAVE_MS after the first.
    expect(timer.waiting()).toEqual([SAVE_MS]);
    timer.run();
    expect(statSync(join(dir, STATE_FILE)).mode & 0o777).toBe(0o600);

    const second = new LinkHub(undefined, undefined, undefined, store());
    const again = peer(), c2 = second.joinCoordinator(again, A);
    c2.receive(hello("s2"));
    expect(again.sent.map((m) => m.id)).toEqual([reply.id, command.id]); // not the acknowledged one
    expect(again.of("reply")[0].payload).toEqual({ ask: "ask-0", issue: "CD-1", key: "a", body: "main" });
    expect(second.presence(A).queued).toBe(2);
    expect(second.ask(A, "ask-1")).toEqual(ask);
    const page = peer();
    second.joinPage(page, A);
    expect(page.of("asks")[0].payload).toEqual({ asks: [ask] });
    expect(logs).toEqual(["link state: no " + join(dir, STATE_FILE) + "; the link starts empty"]);
  });

  it("writes an acknowledgment that waits when the server stops", async () => {
    const dir = tempDir(), timer = fakeAfter();
    const store = () => fileStore(dir, { queueMax: QUEUE_MAX, after: timer.after, log: () => {} });
    const hub = new LinkHub(undefined, undefined, undefined, store());
    const sent = hub.publish(A, "answer", { issue: "CD-1", key: "a", body: "yes" });
    timer.run();
    const c = hub.joinCoordinator(peer(), A);
    c.receive(hello("s1"));
    c.receive(msg("ack", { ids: [sent.id] }));
    await hub.shutdown(); // before the debounce timer runs
    const again = peer(), c2 = new LinkHub(undefined, undefined, undefined, store()).joinCoordinator(again, A);
    c2.receive(hello("s2"));
    expect(again.sent).toEqual([]);
  });

  it("starts empty with one log line when the file is unreadable or of another version", () => {
    for (const text of ["not json", JSON.stringify({ version: STATE_VERSION + 1, rooms: [{ ref: A, queue: [], asks: [ask] }] })]) {
      const dir = tempDir(), logs: string[] = [];
      writeFileSync(join(dir, STATE_FILE), text);
      const hub = new LinkHub(undefined, undefined, undefined, fileStore(dir, { queueMax: QUEUE_MAX, after: fakeAfter().after, log: (l) => logs.push(l) }));
      expect(hub.state()).toEqual({ rooms: [] });
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

  it("writes nothing without a state directory", () => {
    const dir = tempDir();
    delete process.env.WG_STATE_DIR;
    const app = createApp({ port: 4747, tailnet: null, hosted: null }, { team: "T", dist: dir, watchMs: 0 });
    app.link.hub.publish(A, "command", { name: "next", key: null, issue: null });
    app.link.stop();
    expect(() => readFileSync(join(dir, STATE_FILE))).toThrow();
  });

  it("builds the store from the state directory of the app", async () => {
    const dir = tempDir();
    const app = createApp({ port: 4747, tailnet: null, hosted: null }, { team: "T", dist: dir, watchMs: 0, stateDir: dir });
    const sent = app.link.hub.publish(A, "command", { name: "next", key: null, issue: null });
    await app.link.shutdown();
    const saved = JSON.parse(readFileSync(join(dir, STATE_FILE), "utf8"));
    expect(saved.rooms[0].queue.map((m: Envelope) => m.id)).toEqual([sent.id]);
  });
});
