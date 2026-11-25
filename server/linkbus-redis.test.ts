import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, vi } from "vitest";
import { redisLinkBus } from "./linkbus-redis.ts";
import { linkBusContract } from "./testing/linkbus-contract.ts";
import { connectRedis } from "./redis.ts";
import { startTestRedis, testRedis } from "./testing/redis.ts";

describe.skipIf(!testRedis)("Redis link bus", () => {
  let server: Awaited<ReturnType<typeof startTestRedis>>;
  beforeAll(async () => { server = await startTestRedis(); });
  afterAll(async () => { await server?.close(); });
  linkBusContract(async () => {
    const prefix = `test:${randomUUID()}:`;
    const a = connectRedis(server.url, prefix), b = connectRedis(server.url, prefix);
    const cleanup = () => { a.close(); b.close(); };
    try {
      await vi.waitFor(() => { if (!a.ready || !b.ready) throw new Error("Redis is starting"); });
      return { a: redisLinkBus(a, prefix), b: redisLinkBus(b, prefix), cleanup };
    } catch (error) {
      cleanup();
      throw error;
    }
  });
});
