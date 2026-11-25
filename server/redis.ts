import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Redis } from "ioredis";

const READY_WAIT_MS = 3000;
const TICK_MS = 1000;
const PING_WAIT_MS = 500;

export const LINK_PREFIX = "wg:link:";

export class RedisUnavailable extends Error {
  constructor() { super("Redis link unavailable"); }
}

export class RedisCommandFailed extends Error {
  constructor() { super("Redis command failed"); }
}

export function connectRedis(url: string, prefix = LINK_PREFIX, changed: (ready: boolean) => void = () => {}, sessionsOnly = false, probeMs = 20_000, hasSockets = () => false) {
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
  let started = false;
  const readyListeners = new Set<() => void>();
  const listeners = new Set<(text: string) => void>();
  const notify = () => { for (const listener of readyListeners) listener(); };
  let lossLog: ReturnType<typeof setTimeout> | undefined;
  let loggedLoss = false;
  const update = (next: State, code?: string) => {
    if (stopped || state === next) return;
    const before = state;
    state = next;
    clearTimeout(lossLog);
    if (next === "refuses writes") console.warn("Redis refuses writes", code);
    else if (next === "lost" && hasSockets()) {
      lossLog = setTimeout(() => {
        loggedLoss = true;
        console.warn("Redis link lost");
      }, READY_WAIT_MS);
      lossLog.unref();
    } else if (next === "ready" && loggedLoss) {
      loggedLoss = false;
      console.log("Redis link back");
    }
    if (next === "ready" || before === "ready") changed(next === "ready");
    notify();
  };
  const check = () => {
    if (commands?.status === "ready" && (sessionsOnly || subscribed)) update(refusesWrites ? "refuses writes" : "ready");
  };
  const lost = () => update("lost");
  let lastTick = performance.now();
  let resumedAt = -Infinity;
  let pauseCheck: Promise<void> | undefined;
  const observePause = (now: number) => {
    if (now - lastTick > 2 * TICK_MS) {
      resumedAt = now;
      lastTick = now;
      pauseCheck = undefined;
    }
  };
  let checkingPause = false;
  const checkAfterPause = () => {
    if (pauseCheck) return pauseCheck;
    checkingPause = true;
    const clients = [commands, subscriber].filter((client): client is Redis => client?.status === "ready");
    pauseCheck = Promise.all(clients.map(async (client) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([client.ping(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new RedisUnavailable()), PING_WAIT_MS);
        })]);
      } catch {
        lost();
        if (!stopped && client.status === "ready") client.disconnect(true);
      } finally { clearTimeout(timer); }
    })).then(() => {
      checkingPause = false;
      notify();
    });
    return pauseCheck;
  };
  const failure = async (client: Redis, error: unknown, sentAt: number, write = false) => {
    if (error instanceof Error && error.name === "ReplyError") {
      const code = /^(?:OOM|READONLY|MOVED|ASK|CROSSSLOT|NOAUTH|NOPERM|WRONGTYPE|LOADING|BUSY)\b/.exec(error.message)?.[0] ?? "ReplyError";
      if (write) {
        refusesWrites = true;
        update("refuses writes", code);
      } else if (!refusesWrites) console.warn("Redis command failed", code);
      return new RedisCommandFailed();
    }
    observePause(performance.now());
    if (sentAt < resumedAt && client.status === "ready" && !stopped) {
      await checkAfterPause();
    } else {
      lost();
      if (!stopped && client.status === "ready") client.disconnect(true);
    }
    return new RedisUnavailable();
  };
  const start = () => {
    if (started || stopped) return;
    started = true;
    void import("ioredis").then(({ Redis }) => {
      if (stopped) return;
      commands = new Redis(url, options);
      commands.on("ready", () => {
        check();
        notify();
      });
      if (!sessionsOnly) {
        subscriber = new Redis(url, options);
        const sub = subscriber;
        sub.on("ready", () => {
          const sentAt = performance.now();
          void sub.subscribe(channel).then(() => {
            subscribed = true;
            check();
          }, async (error) => {
            const failed = await failure(sub, error, sentAt);
            if (failed instanceof RedisCommandFailed) {
              lost();
              return;
            }
            // A successful PING alone cannot establish the subscription.
            if (!stopped && sub.status === "ready") sub.disconnect(true);
          });
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
    }).catch(lost);
  };
  const heartbeat = setInterval(() => {
    const now = performance.now();
    observePause(now);
    lastTick = now;
  }, TICK_MS);
  heartbeat.unref();
  const timer = sessionsOnly ? undefined : setInterval(() => {
    const sub = subscriber;
    if (!subscribed || !sub || probing) return;
    probing = true;
    const sentAt = performance.now();
    void sub.ping().catch((error) => failure(sub, error, sentAt)).finally(() => { probing = false; });
  }, probeMs);
  timer?.unref();

  if (!sessionsOnly) void start();
  async function waitFor(predicate: () => boolean, ms = READY_WAIT_MS) {
    start();
    if (!predicate() && !stopped && ms > 0) {
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); readyListeners.delete(listener); resolve(); };
        const listener = () => { if (stopped || predicate()) done(); };
        const timer = setTimeout(done, ms);
        readyListeners.add(listener);
      });
    }
    if (stopped || !predicate()) throw new RedisUnavailable();
  }
  const available = (requireBus: boolean, write: boolean, recover = false) =>
    !checkingPause && commands?.status === "ready"
    && (!requireBus || state === "ready" || (recover && state === "refuses writes"))
    && (!write || !refusesWrites || recover);
  const waitReady = () => waitFor(() => available(true, true));
  async function run<T>(
    call: (connection: Redis) => Promise<T>,
    { requireBus = true, write = false, retry = false, recover = false } = {},
  ): Promise<T> {
    let remaining = READY_WAIT_MS;
    const wait = async () => {
      const before = performance.now();
      await waitFor(() => available(requireBus, write, recover), remaining);
      remaining -= performance.now() - before;
    };
    const execute = async () => {
      const client = commands!;
      const sentAt = performance.now();
      try { return await call(client); }
      catch (error) { throw await failure(client, error, sentAt, write); }
    };
    await wait();
    try { return await execute(); }
    catch (error) {
      // A transport failure leaves the result of a command unknown. Retry only safe operations.
      if (!retry || !(error instanceof RedisUnavailable)) throw error;
      await wait();
      return execute();
    }
  }
  let checking: Promise<void> | undefined;
  const checkWrites = async (recover = false): Promise<void> => {
    await waitFor(() => available(true, true, recover));
    if (!checking) {
      const task = async () => {
        await run((client) => client.eval('return redis.call("SET", KEYS[1], "1", "PX", 1000)', 1, probeKey),
          { write: true, retry: true, recover });
        refusesWrites = false;
        check();
      };
      checking = task().finally(() => { checking = undefined; });
    }
    try { await checking; }
    catch (error) {
      if (recover || !(error instanceof RedisCommandFailed) || !refusesWrites) throw error;
      await waitReady();
    }
  };
  return {
    get ready() { return state === "ready"; },
    get refusesWrites() { return refusesWrites; },
    waitReady,
    run<T>(call: (connection: Redis) => Promise<T>) { return run(call); },
    readSession<T>(call: (connection: Redis) => Promise<T>) { return run(call, { requireBus: false, retry: true }); },
    write<T>(call: (connection: Redis) => Promise<T>, requireBus = true) { return run(call, { requireBus, write: true }); },
    checkWrites,
    onMessage(receive: (text: string) => void) {
      listeners.add(receive);
      return () => { listeners.delete(receive); };
    },
    close() {
      stopped = true;
      notify();
      state = "lost";
      clearTimeout(lossLog);
      clearInterval(heartbeat);
      if (timer) clearInterval(timer);
      commands?.disconnect();
      subscriber?.disconnect();
    },
  };
}

export type RedisLink = ReturnType<typeof connectRedis>;
