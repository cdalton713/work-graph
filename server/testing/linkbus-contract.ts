import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Envelope } from "../../src/lib/link.ts";
import type { LinkBus, LinkEvent } from "../linkbus.ts";

interface BusPair {
  a: LinkBus;
  b: LinkBus;
  cleanup(): void | Promise<void>;
}

export function linkBusContract(factory: () => BusPair | Promise<BusPair>) {
  let pair: BusPair;
  beforeEach(async () => { pair = await factory(); });
  afterEach(async () => { await pair?.cleanup(); });

  it("delivers every event kind in order on both instances", async () => {
    const { a, b } = pair;
    const ref = { workspace: "work", id: "project" };
    const envelope = (type: string, payload: unknown): Envelope => ({
      v: 1, id: type, type, at: new Date(0).toISOString(), project: ref, payload,
    });
    const events: LinkEvent[] = [
      { kind: "pages", overview: true, message: envelope("asks", { asks: [] }) },
      {
        kind: "pages", overview: false, message: envelope("changed", { by: "page", what: "issue", issues: ["WG-1"] }),
        viewer: envelope("changed", { by: "page", what: "issue", issues: [] }),
      },
      { kind: "sockets", sockets: ["socket"], messages: [envelope("command", { name: "next", key: null, issue: null })] },
      { kind: "replaced", socket: "socket" },
      { kind: "wrote", ref },
      { kind: "ended", session: "s" },
    ];
    const receivedA: LinkEvent[] = [], receivedB: LinkEvent[] = [];
    const offA = await a.subscribe((event) => { receivedA.push(event); });
    try {
      const offB = await b.subscribe((event) => { receivedB.push(event); });
      try {
        const wire = JSON.stringify(events);
        const decoded: LinkEvent[] = JSON.parse(wire);
        expect(decoded).toEqual(events);
        await a.publish(decoded);
        await vi.waitFor(() => {
          expect(receivedA).toEqual(events);
          expect(receivedB).toEqual(events);
        });
      } finally {
        await offB();
      }
      const reply: LinkEvent = { kind: "ended", session: "other" };
      await b.publish([reply]);
      await vi.waitFor(() => expect(receivedA).toEqual([...events, reply]));
      expect(receivedB).toEqual(events);
    } finally {
      await offA();
    }
  });

  it("finishes a batch before a subscriber's next publication", async () => {
    const { a, b } = pair;
    const first: LinkEvent = { kind: "ended", session: "first" };
    const second: LinkEvent = { kind: "ended", session: "second" };
    const nested: LinkEvent = { kind: "ended", session: "nested" };
    const seen: LinkEvent[] = [];
    const offPublisher = await a.subscribe((event) => {
      if (event.kind === "ended" && event.session === "first") void a.publish([nested]);
    });
    try {
      const offListener = await b.subscribe((event) => { seen.push(event); });
      try {
        await a.publish([first, second]);
        await vi.waitFor(() => expect(seen).toEqual([first, second, nested]));
      } finally {
        await offListener();
      }
    } finally {
      await offPublisher();
    }
  });
}
