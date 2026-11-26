import type { NoticeSettings } from "../../src/lib/types.ts";
import { defaultSettings, deviceId, type PushDevice, type PushStore } from "../pushstore.ts";
import type { CredentialCrypto } from "./crypto.ts";
import type { Sql } from "./sql.ts";

export function dbPushStore(sql: Sql, crypto: CredentialCrypto): PushStore {
  const binding = (tenant: string, id: string) => ({ tenant, connection: "push:" + id, field: "credential" as const });
  return {
    async save(account, device) {
      const id = deviceId(device.endpoint);
      const value = crypto.encrypt(JSON.stringify(device), binding(account, id));
      await sql.query(`INSERT INTO push_devices (tenant_id, id, subscription) VALUES ($1,$2,$3)
        ON CONFLICT (tenant_id, id) DO UPDATE SET subscription = EXCLUDED.subscription`, [account, id, value]);
    },
    async list(account) {
      const rows = await sql.query<{ id: string; subscription: string }>(
        "SELECT id, subscription FROM push_devices WHERE tenant_id = $1", [account]);
      return rows.map(row => JSON.parse(crypto.decrypt(row.subscription, binding(account, row.id))) as PushDevice);
    },
    async remove(account, id) {
      await sql.query("DELETE FROM push_devices WHERE tenant_id = $1 AND id = $2", [account, id]);
    },
    async settings(account) {
      const [row] = await sql.query<{ settings: NoticeSettings }>("SELECT settings FROM push_settings WHERE tenant_id = $1", [account]);
      return row?.settings ?? defaultSettings();
    },
    async setSettings(account, settings) {
      await sql.query(`INSERT INTO push_settings (tenant_id, settings) VALUES ($1,$2)
        ON CONFLICT (tenant_id) DO UPDATE SET settings = EXCLUDED.settings`, [account, JSON.stringify(settings)]);
    },
  };
}
