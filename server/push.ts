import { createECDH } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { noticeKinds, type NoticeSettings } from "../src/lib/types.ts";
import { deviceId, type PushStore } from "./pushstore.ts";

function encoded(value: unknown, size: number): value is string {
  if (typeof value !== "string" || value.length !== Math.ceil(size * 4 / 3)) return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === size && bytes.toString("base64url") === value;
}

class InvalidSubject extends Error {}

function contactSubject(subject: unknown): string {
  if (typeof subject === "string" && !/\s/.test(subject)) {
    if (/^mailto:[^@/?#]+@[^@/?#]+$/i.test(subject)) return subject;
    const url = URL.parse(subject);
    if (/^https:\/\//i.test(subject) && url?.protocol === "https:" && !url.username && !url.password) return subject;
  }
  throw new InvalidSubject();
}

export function readVapid(env: NodeJS.ProcessEnv) {
  let subject = env.WG_VAPID_SUBJECT;
  let publicKey = env.WG_VAPID_PUBLIC_KEY;
  let privateKey = env.WG_VAPID_PRIVATE_KEY;
  if (!publicKey && !privateKey && env.WG_VAPID_FILE) {
    const fd = openSync(env.WG_VAPID_FILE, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 4096) throw new Error();
      const file = JSON.parse(readFileSync(fd, "utf8"));
      ({ publicKey, privateKey } = file);
      subject ??= file.subject;
    } catch { throw new Error("WG_VAPID_FILE must be a mode-600 file with a VAPID key pair"); }
    finally { closeSync(fd); }
  } else if (!publicKey && !privateKey) return null;

  try {
    if (!encoded(privateKey, 32) || !encoded(publicKey, 65)) throw new Error();
    const pair = createECDH("prime256v1");
    pair.setPrivateKey(Buffer.from(privateKey, "base64url"));
    if (pair.getPublicKey().toString("base64url") !== publicKey) throw new Error();
  } catch { throw new Error("Invalid VAPID key pair"); }
  return { publicKey, privateKey, subject: contactSubject(subject) };
}

export function configuredVapid(env: NodeJS.ProcessEnv) {
  try {
    return readVapid(env);
  } catch (error) {
    const setting = !env.WG_VAPID_PUBLIC_KEY && !env.WG_VAPID_PRIVATE_KEY && env.WG_VAPID_FILE
      ? "WG_VAPID_FILE" : error instanceof InvalidSubject ? "WG_VAPID_SUBJECT" : "WG_VAPID_PUBLIC_KEY and WG_VAPID_PRIVATE_KEY";
    console.warn("Push is off. Check " + setting + ".");
    return null;
  }
}

function validEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch { return false; }
}

export function pushRoutes(publicKey: string | undefined, store: (() => Promise<PushStore> | PushStore) | undefined,
  authorize: (c: Context) => Promise<string | Response>, now: () => number,
  testDevice?: (c: Context, account: string, storage: PushStore, id: string) => Promise<Response>) {
  const routes = new Hono<{ Variables: { account: string; storage: PushStore } }>();
  routes.use(async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!publicKey || !store) return c.json({ error: "Push is not set up" }, 503);
    const account = await authorize(c);
    if (typeof account !== "string") return account;
    c.set("account", account);
    c.set("storage", await store());
    return next();
  });
  routes.use(bodyLimit({ maxSize: 8192 }));
  routes.post("/devices/:id/test", async c => {
    const id = c.req.param("id");
    if (!/^[a-f0-9]{64}$/.test(id)) return c.json({ error: "Invalid device" }, 400);
    if (!testDevice) return c.json({ error: "Push is not set up" }, 503);
    return testDevice(c, c.var.account, c.var.storage, id);
  });
  routes.get("/key", c => c.json({ publicKey }));
  routes.get("/devices", async c => {
    const devices = await c.var.storage.list(c.var.account);
    return c.json({ devices: devices.map(({ endpoint, time, label }) => ({ id: deviceId(endpoint), time, label })) });
  });
  routes.post("/devices", async c => {
    const input = await c.req.json().catch(() => null);
    if (!validEndpoint(input?.endpoint) || !encoded(input.keys?.auth, 16) || !encoded(input.keys?.p256dh, 65)
      || typeof input.label !== "string" || !input.label.trim() || input.label.length > 100) {
      return c.json({ error: "Invalid push subscription" }, 400);
    }
    const { auth, p256dh } = input.keys;
    await c.var.storage.save(c.var.account, { endpoint: input.endpoint, keys: { auth, p256dh }, label: input.label.trim(), time: now() });
    return c.json({ ok: true });
  });
  routes.delete("/devices/:id", async c => {
    const id = c.req.param("id");
    if (!/^[a-f0-9]{64}$/.test(id)) return c.json({ error: "Invalid device" }, 400);
    await c.var.storage.remove(c.var.account, id);
    return c.json({ ok: true });
  });
  routes.get("/settings", async c => c.json(await c.var.storage.settings(c.var.account)));
  routes.put("/settings", async c => {
    const input = await c.req.json().catch(() => null);
    if (typeof input?.enabled !== "boolean" || !Array.isArray(input.kinds)
      || !input.kinds.every((kind: NoticeSettings["kinds"][number]) => noticeKinds.includes(kind))
      || new Set(input.kinds).size !== input.kinds.length) return c.json({ error: "Invalid notice settings" }, 400);
    const settings = { enabled: input.enabled, kinds: input.kinds };
    await c.var.storage.setSettings(c.var.account, settings);
    return c.json(settings);
  });
  return routes;
}
