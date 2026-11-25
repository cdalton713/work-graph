import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

export const localRedis = spawnSync("redis-server", ["--version"]).status === 0;
export const testRedis = localRedis || !!process.env.WG_TEST_REDIS_URL;

export async function startTestRedis() {
  const url = process.env.WG_TEST_REDIS_URL;
  return url ? { url, close: async () => {} } : startLocalRedis();
}

export async function startLocalRedis() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("no Redis test port");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const dir = await mkdtemp(join(tmpdir(), "wg-redis-"));
  let running: ReturnType<typeof spawn> | null = null;
  const stop = async () => {
    if (!running?.pid || running.exitCode !== null) return;
    const exit = once(running, "exit");
    running.kill("SIGTERM");
    await exit;
  };
  const start = async () => {
    const child = spawn("redis-server", [
      "--bind", "127.0.0.1", "--port", String(address.port), "--dir", dir,
      "--appendonly", "yes", "--appendfsync", "always",
    ], { stdio: ["ignore", "pipe", "ignore"] });
    running = child;
    let output = "";
    child.stdout.on("data", (data) => { output += data.toString(); });
    await once(child, "spawn");
    await vi.waitFor(() => {
      if (child.exitCode !== null) throw new Error("test Redis exited");
      if (!/ready to accept connections/i.test(output)) throw new Error("test Redis is starting");
    });
  };
  const close = async () => { await stop(); await rm(dir, { recursive: true, force: true }); };
  try { await start(); } catch (error) { await close(); throw error; }
  return { url: `redis://127.0.0.1:${address.port}`, start, stop, close };
}
