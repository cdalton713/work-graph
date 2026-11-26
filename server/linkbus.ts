import type { Envelope, ProjectRef } from "../src/lib/link.ts";

export type LinkEvent = { tenant?: string } & (
  | { kind: "pages"; message: Envelope; overview: boolean; account?: string; queuedByAccount?: [string, number][]; viewer?: Envelope; sequence?: number }
  | { kind: "sockets"; sockets: string[]; messages: Envelope[]; sequence?: number; queue?: boolean; replay?: boolean }
  | { kind: "members-revoked"; sockets: string[] }
  | { kind: "replaced"; socket: string }
  | { kind: "wrote"; ref: ProjectRef }
  | { kind: "ended"; session: string; expiresAt?: number });

export interface LinkBus {
  /**
   * Publish this batch in order to every subscriber, including the publisher's own instance.
   * Resolution confirms publication. A subscriber can receive the batch later.
   */
  publish(events: readonly LinkEvent[]): Promise<void>;
  subscribe(receive: (event: LinkEvent) => void): Promise<() => void | Promise<void>>;
}

export function memoryLinkBus(): LinkBus {
  const subscribers = new Set<(event: LinkEvent) => void>();
  let pending = Promise.resolve();
  return {
    publish(events) {
      const batch = structuredClone(events);
      const delivery = pending.then(() => {
        for (const event of batch) {
          for (const receive of [...subscribers]) {
            try {
              receive(structuredClone(event));
            } catch (error) {
              console.error("link bus subscriber:", error);
            }
          }
        }
      });
      pending = delivery.catch(() => {});
      return delivery;
    },
    async subscribe(receive) {
      const listener = (event: LinkEvent) => receive(event);
      subscribers.add(listener);
      return () => { subscribers.delete(listener); };
    },
  };
}
