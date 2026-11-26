import { randomUUID } from "node:crypto";
import { test, expect } from "vitest";
import { databaseSuites } from "../testing/sql.ts";
import { migrate } from "./migrations.ts";
import { credentialCrypto } from "./crypto.ts";
import { dbPushStore } from "./push.ts";
import { deviceId } from "../pushstore.ts";

databaseSuites(open => {
  test("encrypts subscriptions, scopes deletion, and stores account preferences", async () => {
    const sql = await open();
    try {
      await migrate(sql);
      const id = randomUUID();
      await sql.query("INSERT INTO users VALUES ($1, 'user', 'org', 'ada@example.com', 'Ada')", [id]);
      await sql.query("INSERT INTO tenants (id, owner_user_id, human) VALUES ($1, $1, 'Ada')", [id]);
      const store = dbPushStore(sql, credentialCrypto({ WG_DATA_KEY: Buffer.alloc(32).toString("base64") }));
      const device = { label: "Phone", endpoint: "https://example.com/phone", keys: { auth: "auth-secret", p256dh: "device-key" }, time: 5 };
      await store.save(id, device);
      await store.save(id, { ...device, time: 6 });
      const rows = JSON.stringify(await sql.query("SELECT * FROM push_devices"));
      for (const secret of [device.label, device.endpoint, ...Object.values(device.keys)]) expect(rows).not.toContain(secret);
      await store.remove(randomUUID(), deviceId(device.endpoint));
      expect(await store.list(id)).toEqual([{ ...device, time: 6 }]);
      expect(await store.settings(id)).toEqual({ enabled: true, kinds: ["decision", "merge", "question", "wait"] });
      await store.setSettings(id, { enabled: false, kinds: ["merge"] });
      expect(await store.settings(id)).toEqual({ enabled: false, kinds: ["merge"] });
      await store.remove(id, deviceId(device.endpoint));
      expect(await store.list(id)).toEqual([]);
    } finally { await sql.close(); }
  });
});
