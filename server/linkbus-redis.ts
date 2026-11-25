import type { LinkBus, LinkEvent } from "./linkbus.ts";
import { LINK_PREFIX, type RedisLink } from "./redis.ts";

export function redisLinkBus(redis: RedisLink, prefix = LINK_PREFIX): LinkBus {
  return {
    async publish(events) {
      if (events.length) await redis.run((client) => client.publish(prefix + "events", JSON.stringify(events)));
    },
    async subscribe(receive) {
      return redis.onMessage((text) => {
        let events: LinkEvent[];
        try {
          events = JSON.parse(text);
          if (!Array.isArray(events)) return;
        } catch {
          return;
        }
        for (const event of events) {
          try { receive(event); } catch { console.error("Redis link event could not be delivered"); }
        }
      });
    },
  };
}
