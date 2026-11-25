import { describe, expect, it, vi } from "vitest";
import { memoryLinkBus, type LinkBus, type LinkEvent } from "./linkbus.ts";

export function linkBusContract(factory: () => LinkBus | Promise<LinkBus>) {
  it("delivers events in publication order to every current subscriber", async () => {
    const bus = await factory();
    const first: LinkEvent[] = [], second: LinkEvent[] = [];
    const offFirst = await bus.subscribe((event) => { first.push(event); });
    const offSecond = await bus.subscribe((event) => { second.push(event); });
    try {
      const ref = { workspace: "work", id: "project" };
      const wrote: LinkEvent = { kind: "wrote", ref };
      const ended: LinkEvent = { kind: "ended", session: "s" };
      await bus.publish([wrote, ended]);
      await vi.waitFor(() => {
        expect(first).toEqual([wrote, ended]);
        expect(second).toEqual(first);
      });
      await offFirst();
      await bus.publish([ended]);
      await vi.waitFor(() => expect(second).toEqual([wrote, ended, ended]));
      expect(first).toEqual([wrote, ended]);
    } finally {
      await offFirst();
      await offSecond();
    }
  });

  it("finishes a batch before a subscriber's next publication", async () => {
    const bus = await factory();
    const first: LinkEvent = { kind: "ended", session: "first" };
    const second: LinkEvent = { kind: "ended", session: "second" };
    const nested: LinkEvent = { kind: "ended", session: "nested" };
    const seen: LinkEvent[] = [];
    const offPublisher = await bus.subscribe((event) => {
      if (event.kind === "ended" && event.session === "first") void bus.publish([nested]);
    });
    const offListener = await bus.subscribe((event) => { seen.push(event); });
    try {
      await bus.publish([first, second]);
      await vi.waitFor(() => expect(seen).toEqual([first, second, nested]), { timeout: 200 });
    } finally {
      await offPublisher();
      await offListener();
    }
  });
}

describe("memory link bus", () => linkBusContract(memoryLinkBus));
