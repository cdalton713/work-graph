import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";

export const LINK_PREFIX = "wg:link:";

export class RedisUnavailable extends Error {
  constructor() { super("Redis link unavailable"); }
}

export class RedisCommandFailed extends Error {
  constructor() { super("Redis command failed"); }
}

export function connectRedis(url: string, prefix = LINK_PREFIX, changed: (ready: boolean) => void = () => {}, sessionsOnly = false, probeMs = 20_000) {
  try {
    const parsed = new URL(url);
    if (!["redis:", "rediss:"].includes(parsed.protocol) || !parsed.hostname) throw new Error();
    decodeURIComponent(parsed.username);
    decodeURIComponent(parsed.password);
  } catch { throw new Error("invalid Redis link configuration"); }
  const options = {
    lazyConnect: true,
    enableOfflineQueue: false,
    autoResubscribe: false,
    autoResendUnfulfilledCommands: false,
    connectTimeout: 2_000,
    commandTimeout: 2_000,
    maxRetriesPerRequest: 0,
    retryStrategy: (attempt: number) => Math.min(100 * 2 ** (attempt - 1), 3_000),
  };
  const channel = prefix + "events";
  let commands: Redis | undefined, subscriber: Redis | undefined;
  let subscribed = false, stopped = false, probing = false;
  type State = "ready" | "lost" | "refuses writes";
  let state: State | null = null;
  let refusesWrites = false;
  const probeKey = prefix + "write-check:" + randomUUID();
  let initial: Promise<void> | undefined;
  let finishInitial = () => {};
  const readyListeners = new Set<() => void>();
  let finishCommands = () => {};
  const commandsInitialized = new Promise<void>((resolve) => { finishCommands = resolve; });
  const listeners = new Set<(text: string) => void>();
  const update = (next: State, code?: string) => {
    if (stopped || state === next) return;
    const before = state;
    state = next;
    finishInitial();
    if (next === "refuses writes") console.warn("Redis refuses writes", code);
    else if (next === "lost") console.warn("Redis link lost");
    else if (before !== null) console.log("Redis link back");
    if (next === "ready" || before === "ready") changed(next === "ready");
  };
  const check = () => {
    if (commands?.status === "ready" && (sessionsOnly || subscribed)) update(refusesWrites ? "refuses writes" : "ready");
  };
  const lost = () => update("lost");
  const failure = (client: Redis, error: unknown, write = false) => {
    if (error instanceof Error && error.name === "ReplyError") {
      const code = /^(?:OOM|READONLY|MOVED|ASK|CROSSSLOT|NOAUTH|NOPERM|WRONGTYPE|LOADING|BUSY)\b/.exec(error.message)?.[0] ?? "ReplyError";
      if (write) {
        refusesWrites = true;
        update("refuses writes", code);
      } else if (!refusesWrites) console.warn("Redis command failed", code);
      return new RedisCommandFailed();
    }
    lost();
    if (!stopped && client.status === "ready") client.disconnect(true);
    return new RedisUnavailable();
  };
  const start = () => {
    if (initial) return initial;
    initial = new Promise<void>((resolve) => { finishInitial = resolve; });
    if (stopped) finishInitial();
    else void import("ioredis").then(({ Redis }) => {
      if (stopped) return;
      commands = new Redis(url, options);
      commands.on("ready", () => {
        finishCommands();
        for (const ready of readyListeners) ready();
        check();
      });
      commands.on("error", finishCommands);
      commands.on("close", finishCommands);
      if (!sessionsOnly) {
        subscriber = new Redis(url, options);
        const sub = subscriber;
        sub.on("ready", () => {
          void sub.subscribe(channel).then(() => {
            subscribed = true;
            check();
          }, (error) => { failure(sub, error); lost(); });
        });
        sub.on("close", () => { subscribed = false; });
        sub.on("message", (name: string, text: string) => {
          if (name === channel) for (const receive of listeners) receive(text);
        });
      }
      for (const client of subscriber ? [commands, subscriber] : [commands]) {
        client.on("error", lost);
        client.on("close", lost);
        void client.connect().catch(lost);
      }
    }).catch(() => { finishCommands(); lost(); });
    return initial;
  };
  const timer = sessionsOnly ? undefined : setInterval(() => {
    const sub = subscriber;
    if (!subscribed || !sub || probing) return;
    probing = true;
    void sub.ping().catch((error) => { failure(sub, error); }).finally(() => { probing = false; });
  }, probeMs);
  timer?.unref();

  if (!sessionsOnly) void start();
  async function run<T>(call: (connection: Redis) => Promise<T>, requireBus = true, write = false): Promise<T> {
    const startup = start();
    await (requireBus ? startup : commandsInitialized);
    const client = commands;
    if (!client || client.status !== "ready" || (requireBus && state !== "ready") || (write && refusesWrites)) {
      throw new RedisUnavailable();
    }
    try { return await call(client); }
    catch (error) { throw failure(client, error, write); }
  }
  let checking: Promise<void> | undefined;
  const checkWrites = (recover = false): Promise<void> => {
    if (refusesWrites && !recover) return Promise.reject(new RedisUnavailable());
    if (checking) return checking;
    const task = async () => {
      await start();
      const client = commands;
      if (!client || client.status !== "ready" || (!sessionsOnly && !subscribed)) throw new RedisUnavailable();
      try {
        await client.eval('return redis.call("SET", KEYS[1], "1", "PX", 1000)', 1, probeKey);
      } catch (error) { throw failure(client, error, true); }
      refusesWrites = false;
      check();
    };
    checking = task().finally(() => { checking = undefined; });
    return checking;
  };
  return {
    get initialized() { return start(); },
    get ready() { return state === "ready"; },
    get refusesWrites() { return refusesWrites; },
    waitForCommands(ms: number): Promise<void> {
      if (commands?.status === "ready" || stopped || ms <= 0) return Promise.resolve();
      return new Promise((resolve) => {
        const done = () => { clearTimeout(timer); readyListeners.delete(done); resolve(); };
        const timer = setTimeout(done, ms);
        readyListeners.add(done);
      });
    },
    run,
    write<T>(call: (connection: Redis) => Promise<T>, requireBus = true) { return run(call, requireBus, true); },
    checkWrites,
    onMessage(receive: (text: string) => void) {
      listeners.add(receive);
      return () => { listeners.delete(receive); };
    },
    close() {
      stopped = true;
      finishInitial();
      finishCommands();
      for (const ready of readyListeners) ready();
      state = "lost";
      if (timer) clearInterval(timer);
      commands?.disconnect();
      subscriber?.disconnect();
    },
  };
}

export type RedisLink = ReturnType<typeof connectRedis>;
