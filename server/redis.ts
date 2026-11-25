import type { Redis } from "ioredis";

export const LINK_PREFIX = "wg:link:";

export class RedisUnavailable extends Error {
  constructor() { super("Redis link unavailable"); }
}

export class RedisCommandFailed extends Error {
  constructor() { super("Redis command failed"); }
}

export function connectRedis(url: string, prefix = LINK_PREFIX, changed: (ready: boolean) => void = () => {}, sessionsOnly = false, probeMs = 20_000) {
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
  let state: boolean | null = null;
  let initial: Promise<void> | undefined;
  let finishInitial = () => {};
  const readyListeners = new Set<() => void>();
  let finishCommands = () => {};
  const commandsInitialized = new Promise<void>((resolve) => { finishCommands = resolve; });
  const listeners = new Set<(text: string) => void>();
  const update = (ready: boolean) => {
    if (stopped || state === ready) return;
    const before = state;
    state = ready;
    finishInitial();
    if (!ready) console.warn("Redis link lost");
    else if (before === false) console.log("Redis link back");
    changed(ready);
  };
  const check = () => {
    if (commands?.status === "ready" && (sessionsOnly || subscribed)) update(true);
  };
  const lost = () => update(false);
  const failure = (client: Redis, error: unknown) => {
    if (error instanceof Error && error.name === "ReplyError") {
      const code = /^(?:OOM|READONLY|MOVED|ASK|CROSSSLOT|NOAUTH|NOPERM|WRONGTYPE|LOADING|BUSY)\b/.exec(error.message)?.[0];
      console.warn("Redis command failed", code ?? "ReplyError");
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
      if (!["redis:", "rediss:"].includes(new URL(url).protocol)) throw new Error();
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
  return {
    get initialized() { return start(); },
    get ready() { return state === true; },
    waitForCommands(ms: number): Promise<void> {
      if (commands?.status === "ready" || stopped || ms <= 0) return Promise.resolve();
      return new Promise((resolve) => {
        const done = () => { clearTimeout(timer); readyListeners.delete(done); resolve(); };
        const timer = setTimeout(done, ms);
        readyListeners.add(done);
      });
    },
    async run<T>(call: (connection: Redis) => Promise<T>, requireBus = true): Promise<T> {
      const startup = start();
      await (requireBus ? startup : commandsInitialized);
      const client = commands;
      if (!client || client.status !== "ready" || (requireBus && state !== true)) throw new RedisUnavailable();
      try {
        return await call(client);
      } catch (error) {
        throw failure(client, error);
      }
    },
    onMessage(receive: (text: string) => void) {
      listeners.add(receive);
      return () => { listeners.delete(receive); };
    },
    close() {
      stopped = true;
      finishInitial();
      finishCommands();
      for (const ready of readyListeners) ready();
      state = false;
      if (timer) clearInterval(timer);
      commands?.disconnect();
      subscriber?.disconnect();
    },
  };
}

export type RedisLink = ReturnType<typeof connectRedis>;
