import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { connectRedis } from "../redis.ts";
import { openDatabaseTenants } from "../tenants.ts";
import { startTestRedis, testRedis } from "../testing/redis.ts";
import { databaseSuites } from "../testing/sql.ts";
import type { NewConnection } from "./accounts.ts";
import { credentialCrypto } from "./crypto.ts";
import { migrate } from "./migrations.ts";
import type { Database } from "./sql.ts";
import { dbTenants } from "./tenants.ts";

const env = { WG_DATA_KEY: randomBytes(32).toString("base64") };
const user = { linearUserId: "user", linearOrgId: "org", email: "ada@example.com", name: "Ada" };
const connection: NewConnection = {
  workspaceId: "first", linearOrgId: "org", name: "First", team: "WG", teamLabels: false,
  credential: { kind: "api_key", key: "only-first" },
};

test("only requires a key when a database is configured", async () => {
  await expect(openDatabaseTenants({ WG_DATA_KEY: "short" })).resolves.toBeNull();
  await expect(openDatabaseTenants({ DATABASE_URL: "unused" })).rejects.toThrow("WG_DATA_KEY");
});

databaseSuites((open) => {
  let sql: Database;
  const crypto = credentialCrypto(env);

  beforeEach(async () => {
    sql = await open();
    await migrate(sql);
  });
  afterEach(async () => { await sql?.close(); });

  test("resolves only the tenant and credentials of the session or token", async () => {
    const directory = dbTenants(sql, crypto);
    const first = await directory.accounts.createAccount(user, "Ada", connection);
    const second = await directory.accounts.createAccount({ ...user, linearOrgId: "other" }, "Other", {
      ...connection, credential: { kind: "api_key", key: "only-second" },
    });
    const session = { id: first, email: user.email, expiresAt: Date.now() + 60_000 };
    expect(await directory.fromSession(session)).toMatchObject({
      role: "owner", tenant: { id: first, human: "Ada", workspaces: [{ id: "first", key: "only-first" }] },
    });
    expect(await directory.fromSession(null)).toBeNull();
    expect(await directory.fromSession({ ...session, id: "legacy-session" })).toBeNull();
    expect(await directory.byId(randomUUID())).toBeNull();
    const { id, token } = await directory.accounts.createToken(second, "coordinator");
    expect(await directory.fromToken(`Bearer ${token}`)).toMatchObject({
      id: second, human: "Other", workspaces: [{ id: "first", key: "only-second" }],
    });
    expect(await directory.fromToken(token)).toBeNull();
    await directory.accounts.revokeToken(second, id);
    expect(await directory.fromToken(`Bearer ${token}`)).toBeNull();
    await directory.accounts.deleteAccount(first);
    expect(await directory.byId(first)).toBeNull();
    directory.close();
  });

  test.each(["credential", "refresh_token"])("keeps healthy workspaces when one connection has a damaged %s", async (field) => {
    const directory = dbTenants(sql, crypto);
    const tenant = await directory.accounts.createAccount(user, "Ada", connection);
    const bad = await directory.accounts.addConnection(tenant, {
      ...connection, workspaceId: "second", linearOrgId: "other",
      credential: { kind: "oauth", key: "second-access", refreshToken: "second-refresh", expiresAt: new Date("2030-01-01") },
    });
    const { token } = await directory.accounts.createToken(tenant, "coordinator");
    await sql.query(`UPDATE linear_connections SET ${field} = $1 WHERE id = $2`, ["damaged-value", bad]);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const account = await directory.byId(tenant);
      expect(account?.workspaces).toMatchObject([{ id: "first", key: "only-first" }]);
      const session = { id: tenant, email: user.email, expiresAt: Date.now() + 60_000 };
      expect(await directory.fromSession(session)).toEqual({ tenant: account, role: "owner" });
      expect(await directory.fromToken(`Bearer ${token}`)).toEqual(account);
      await expect(directory.accounts.readCredential(tenant, bad)).rejects.toThrow(/^Cannot decrypt database credential$/);
      expect(log.mock.calls).toEqual([[`Cannot decrypt database credential for connection ${bad}`]]);
    } finally {
      log.mockRestore();
      directory.close();
    }
  });

  test("clears a cached tenant immediately on change and expires it after ten seconds", async () => {
    const directory = dbTenants(sql, crypto);
    const id = await directory.accounts.createAccount(user, "Ada", connection);
    const [workspace] = (await directory.accounts.readTenant(id))!.connections;
    const listener = vi.fn();
    const off = directory.onChange(listener);
    const start = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    try {
      expect(await directory.byId(id)).toMatchObject({ workspaces: [{ key: "only-first" }] });
      await directory.accounts.setNeedsKey(id, workspace.id);
      expect(listener).toHaveBeenCalledExactlyOnceWith(id);
      expect(await directory.byId(id)).toMatchObject({ workspaces: [] });
      // Simulate a missed notice from a different process.
      await sql.query("UPDATE linear_connections SET status = 'ok' WHERE id = $1", [workspace.id]);
      now.mockReturnValue(start + 9_999);
      expect(await directory.byId(id)).toMatchObject({ workspaces: [] });
      now.mockReturnValue(start + 10_000);
      expect(await directory.byId(id)).toMatchObject({ workspaces: [{ key: "only-first" }] });
      off();
      await directory.accounts.removeConnection(id, workspace.id);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
      directory.close();
    }
  });

  test.skipIf(!testRedis)("publishes account change notices to another instance through Redis", async () => {
    const redis = await startTestRedis();
    const prefix = `test:${randomUUID()}:`;
    const firstBus = connectRedis(redis.url, prefix);
    const secondBus = connectRedis(redis.url, prefix);
    const first = dbTenants(sql, crypto, { redis: firstBus, prefix });
    const second = dbTenants(sql, crypto, { redis: secondBus, prefix });
    try {
      await Promise.all([firstBus.waitReady(), secondBus.waitReady()]);
      const id = await first.accounts.createAccount(user, "Ada", connection);
      const [workspace] = (await first.accounts.readTenant(id))!.connections;
      expect(await second.byId(id)).toMatchObject({ workspaces: [{ key: "only-first" }] });
      const firstChange = vi.fn(), secondChange = vi.fn();
      first.onChange(firstChange);
      second.onChange(secondChange);
      await first.accounts.replaceCredential(id, workspace.id, { kind: "api_key", key: "replacement" });
      await vi.waitFor(() => expect(secondChange).toHaveBeenCalledWith(id));
      expect(firstChange).toHaveBeenCalledExactlyOnceWith(id);
      expect(await second.byId(id)).toMatchObject({ workspaces: [{ key: "replacement" }] });
    } finally {
      first.close();
      second.close();
      firstBus.close();
      secondBus.close();
      await redis.close();
    }
  });
});
