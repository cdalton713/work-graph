import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { deviceId, filePushStore } from "./pushstore.ts";

test("persists devices and preferences separately for each account", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wg-push-"));
  try {
    const store = filePushStore(dir);
    const phone = { endpoint: "https://example.com/device", keys: { auth: "a", p256dh: "b" }, label: "Phone", time: 1 };
    const tablet = { ...phone, endpoint: phone.endpoint + "2", label: "Tablet" };
    await Promise.all([store.save("one", phone), store.save("one", tablet)]);
    await store.setSettings("one", { enabled: false, kinds: [] });
    const reopened = filePushStore(dir);
    expect(await reopened.list("one")).toHaveLength(2);
    expect(await reopened.settings("one")).toEqual({ enabled: false, kinds: [] });
    expect(await reopened.settings("two")).toEqual({ enabled: true, kinds: ["decision", "merge", "question", "wait"] });
    expect(await reopened.list("two")).toEqual([]);
    await reopened.remove("two", deviceId(phone.endpoint));
    await reopened.remove("one", deviceId(phone.endpoint));
    expect(await store.list("one")).toEqual([tablet]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
