import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { noticeKinds, type NoticeSettings } from "../src/lib/types.ts";

export interface PushDevice {
  endpoint: string;
  keys: { auth: string; p256dh: string };
  label: string;
  time: number;
}

export interface PushStore {
  save(account: string, device: PushDevice): Promise<void>;
  list(account: string): Promise<PushDevice[]>;
  remove(account: string, id: string): Promise<void>;
  settings(account: string): Promise<NoticeSettings>;
  setSettings(account: string, settings: NoticeSettings): Promise<void>;
}

export const defaultSettings = (): NoticeSettings => ({ enabled: true, kinds: [...noticeKinds] });
export const deviceId = (endpoint: string) => createHash("sha256").update(endpoint).digest("hex");

async function optional<T>(read: Promise<T>, fallback: T): Promise<T> {
  try { return await read; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

export function filePushStore(root: string): PushStore {
  const directory = (account: string) => join(root, "push", deviceId(account));
  async function save(file: string, value: unknown) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temp = file + "." + randomUUID();
    try {
      await writeFile(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
      await rename(temp, file);
    } finally { await rm(temp, { force: true }); }
  }
  return {
    save: (account, device) => save(join(directory(account), deviceId(device.endpoint)), device),
    async list(account) {
      const dir = directory(account);
      const names = await optional(readdir(dir), []);
      const devices = await Promise.all(names.filter(name => /^[0-9a-f]{64}$/.test(name))
        .map(name => optional(readFile(join(dir, name), "utf8"), "")));
      return devices.filter(Boolean).map(text => JSON.parse(text) as PushDevice);
    },
    async remove(account, id) {
      if (/^[0-9a-f]{64}$/.test(id)) await rm(join(directory(account), id), { force: true });
    },
    async settings(account) {
      const text = await optional(readFile(join(directory(account), "settings"), "utf8"), "");
      return text ? JSON.parse(text) : defaultSettings();
    },
    setSettings: (account, settings) => save(join(directory(account), "settings"), settings),
  };
}
