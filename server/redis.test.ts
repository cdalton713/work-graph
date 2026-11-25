import { once } from "node:events";
import { createServer, connect, type AddressInfo, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { connectRedis } from "./redis.ts";
import { localRedis, startLocalRedis } from "./testing/redis.ts";

it.skipIf(!localRedis).each([false, true])("reconnects a silent subscriber (process paused: %s)", async (paused) => {
  const server = await startLocalRedis();
  const target = new URL(server.url);
  const sockets = new Set<Socket>();
  let block = false, subscriptions = 0, blockedPings = 0;
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
      if (subscriber && block && command.includes("ping")) blockedPings++;
      else outgoing.write(chunk);
    });
    outgoing.pipe(incoming);
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const transitions: boolean[] = [];
  const redis = connectRedis(`redis://127.0.0.1:${(proxy.address() as AddressInfo).port}`, undefined,
    (ready) => transitions.push(ready), false, 25);
  const now = performance.now.bind(performance);
  const clock = vi.spyOn(performance, "now");
  try {
    await redis.waitReady();
    expect(redis.ready).toBe(true);
    block = true;
    if (paused) {
      await vi.waitFor(() => expect(blockedPings).toBe(1));
      clock.mockImplementation(() => now() + 5000);
      // The periodic probe has timed out. The second ping is the fresh pause check.
      await vi.waitFor(() => expect(blockedPings).toBe(2), { timeout: 3000 });
      expect(redis.ready).toBe(true);
    }
    const waiting = paused ? redis.checkWrites().then(
      () => ({ ready: redis.ready, subscriptions }),
      (error: unknown) => error,
    ) : undefined;
    // The failed fresh ping drops the connection before the next regular probe can time out.
    await vi.waitFor(() => expect(transitions).toContain(false), { timeout: paused ? 1500 : 3500 });
    block = false;
    if (waiting) expect(await waiting).toEqual({ ready: true, subscriptions: 2 });
    await vi.waitFor(() => expect(redis.ready && subscriptions >= 2).toBe(true));
    expect(transitions).toEqual([true, false, true]);
  } finally {
    clock.mockRestore();
    redis.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await server.close();
  }
});

it.skipIf(!localRedis)("keeps the link unavailable without reconnecting when Redis denies SUBSCRIBE", async () => {
  const server = await startLocalRedis();
  const admin = connectRedis(server.url, undefined, undefined, true);
  const countConnections = async () => {
    const stats = await admin.run((client) => client.info("stats"));
    return Number(/^total_connections_received:(\d+)/m.exec(stats)?.[1]);
  };
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  let redis: ReturnType<typeof connectRedis> | undefined;
  try {
    await admin.run((client) => client.acl("SETUSER", "link", "on", ">test-password", "~*", "+@all", "resetchannels"));
    const before = await countConnections();
    const url = new URL(server.url);
    url.username = "link";
    url.password = "test-password";
    redis = connectRedis(url.href);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("Redis command failed", "NOPERM"));
    await delay(2000);
    expect(redis.ready).toBe(false);
    expect(await countConnections() - before).toBe(2);
    expect(warn.mock.calls).toEqual([["Redis command failed", "NOPERM"]]);
  } finally {
    redis?.close();
    admin.close();
    warn.mockRestore();
    await server.close();
  }
});
