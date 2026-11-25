import { Redis } from "ioredis";

export const LINK_PREFIX = "wg:link:";

export class RedisUnavailable extends Error {
  constructor() { super("Redis link unavailable"); }
}

export function connectRedis(url: string, prefix = LINK_PREFIX, changed: (ready: boolean) => void = () => {}) {
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
  let commands: Redis, subscriber: Redis;
  try {
    if (!["redis:", "rediss:"].includes(new URL(url).protocol)) throw new Error();
    commands = new Redis(url, options);
    subscriber = new Redis(url, options);
  } catch {
    throw new Error("invalid Redis link configuration");
  }
  const channel = prefix + "events";
  let subscribed = false;
  let state: boolean | null = null;
  let stopped = false;
  let finishInitial = () => {};
  const initialized = new Promise<void>((resolve) => { finishInitial = resolve; });
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
    if (commands.status === "ready" && subscribed) update(true);
  };
  const lost = () => update(false);
  commands.on("ready", check);
  subscriber.on("ready", () => {
    void subscriber.subscribe(channel).then(() => {
      subscribed = true;
      check();
    }, () => {
      lost();
      if (!stopped && subscriber.status === "ready") subscriber.disconnect(true);
    });
  });
  subscriber.on("close", () => { subscribed = false; });
  for (const client of [commands, subscriber]) {
    client.on("error", lost);
    client.on("close", lost);
    void client.connect().catch(lost);
  }

  return {
    initialized,
    get ready() { return state === true; },
    async run<T>(call: (connection: Redis) => Promise<T>): Promise<T> {
      await initialized;
      if (state !== true) throw new RedisUnavailable();
      try {
        return await call(commands);
      } catch {
        lost();
        if (!stopped && commands.status === "ready") commands.disconnect(true);
        throw new RedisUnavailable();
      }
    },
    onMessage(receive: (text: string) => void) {
      const listener = (name: string, text: string) => { if (name === channel) receive(text); };
      subscriber.on("message", listener);
      return () => { subscriber.off("message", listener); };
    },
    close() {
      stopped = true;
      finishInitial();
      state = false;
      commands.disconnect();
      subscriber.disconnect();
    },
  };
}

export type RedisLink = ReturnType<typeof connectRedis>;
