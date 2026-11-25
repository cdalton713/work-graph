import { once } from "node:events";
import { createServer, connect, type AddressInfo, type Socket } from "node:net";
import { expect, it, vi } from "vitest";
import { connectRedis } from "./redis.ts";
import { localRedis, startLocalRedis } from "./testing/redis.ts";

it.skipIf(!localRedis)("reconnects when a subscriber stops replying without closing TCP", async () => {
  const server = await startLocalRedis();
  const target = new URL(server.url);
  const sockets = new Set<Socket>();
  let block = false, subscriptions = 0;
  const proxy = createServer((incoming) => {
    const outgoing = connect(Number(target.port), target.hostname);
    sockets.add(incoming).add(outgoing);
    incoming.on("error", () => outgoing.destroy());
    outgoing.on("error", () => incoming.destroy());
    incoming.on("close", () => { sockets.delete(incoming); outgoing.destroy(); });
    outgoing.on("close", () => { sockets.delete(outgoing); incoming.destroy(); });
    let subscriber = false;
    incoming.on("data", (chunk) => {
      const command = chunk.toString().toLowerCase();
      if (command.includes("subscribe")) { subscriber = true; subscriptions++; }
      if (!(subscriber && block && command.includes("ping"))) outgoing.write(chunk);
    });
    outgoing.pipe(incoming);
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const transitions: boolean[] = [];
  const redis = connectRedis(`redis://127.0.0.1:${(proxy.address() as AddressInfo).port}`, undefined,
    (ready) => transitions.push(ready), false, 25);
  try {
    await redis.waitReady();
    expect(redis.ready).toBe(true);
    block = true;
    await vi.waitFor(() => expect(transitions).toContain(false), { timeout: 3500 });
    block = false;
    await vi.waitFor(() => expect(redis.ready && subscriptions >= 2).toBe(true));
    expect(transitions).toEqual([true, false, true]);
  } finally {
    redis.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await server.close();
  }
});
