import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { databaseSuites } from "../testing/sql.ts";
import { createAccounts, MAX_CONNECTIONS, MAX_LIVE_TOKENS } from "./accounts.ts";
import { credentialCrypto, tokenHash } from "./crypto.ts";
import { migrate } from "./migrations.ts";
import type { Database } from "./sql.ts";

const key = randomBytes(32).toString("base64");
const user = { linearUserId: "user", linearOrgId: "org", email: "ada@example.com", name: "Ada" };
const apiKey = "example-api-key";
const refreshToken = "example-refresh-token";
const connection = {
  workspaceId: "first", linearOrgId: "org", name: "First", team: "WG", teamLabels: false,
  credential: { kind: "api_key", key: apiKey } as const,
};

databaseSuites((open) => {
  let sql: Database;
  let store: ReturnType<typeof createAccounts>;
  const changed = vi.fn();

  beforeEach(async () => {
    sql = await open();
    await migrate(sql);
    changed.mockClear();
    store = createAccounts(sql, credentialCrypto({ WG_DATA_KEY: key }), changed);
  });
  afterEach(async () => { await sql?.close(); });

  test("creates an account, changes connections in order, and deletes its rows", async () => {
    const tenant = await store.createAccount(user, "Ada", connection);
    const account = await store.readTenant(tenant);
    expect(account).toMatchObject({ id: tenant, human: "Ada", user, connections: [{ workspaceId: "first", position: 0 }] });
    const first = account!.connections[0].id;
    const second = await store.addConnection(tenant, {
      ...connection, workspaceId: "second", linearOrgId: "other",
    });
    const expiresAt = new Date("2030-01-01T00:00:00Z");
    const credential = { kind: "oauth", key: "example-access-token", refreshToken, expiresAt } as const;
    await store.replaceCredential(tenant, first, credential);
    expect(await store.readCredential(tenant, first)).toEqual(credential);
    await store.updateConnectionSettings(tenant, second, { name: "Next", team: "NEW", teamLabels: true, position: 0 });
    await store.setNeedsKey(tenant, first);
    const listed = await store.readTenant(tenant);
    expect(listed?.connections).toMatchObject([
      { workspaceId: "second", name: "Next", team: "NEW", teamLabels: true, position: 0 },
      { workspaceId: "first", kind: "oauth", status: "needs_key", position: 1 },
    ]);
    expect(JSON.stringify(listed)).not.toMatch(/example-(api-key|access-token|refresh-token)/);
    await store.removeConnection(tenant, second);
    expect(await store.readCredential(tenant, second)).toBeNull();
    expect((await store.readTenant(tenant))?.connections).toMatchObject([{ id: first, position: 0 }]);
    await store.createToken(tenant, "coordinator");
    await store.deleteAccount(tenant);
    expect(await store.readTenant(tenant)).toBeNull();
    for (const table of ["users", "tenants", "linear_connections", "coordinator_tokens"]) {
      expect(await sql.query(`SELECT id FROM ${table}`)).toEqual([]);
    }
    expect(changed.mock.calls).toEqual(Array.from({ length: 8 }, () => [tenant]));
  });

  test("applies uniqueness and limits with concurrent writes", async () => {
    const tenant = await store.createAccount(user, "Ada", connection);
    await expect(store.createAccount(user, "Ada", connection)).rejects.toThrow("Database record already exists");
    const other = await store.createAccount({ ...user, linearOrgId: "other" }, "Other", connection);
    await expect(store.addConnection(tenant, { ...connection, linearOrgId: "unique" })).rejects.toThrow("already exists");
    await expect(store.addConnection(tenant, { ...connection, workspaceId: "unique" })).rejects.toThrow("already exists");
    const adds = await Promise.allSettled(Array.from({ length: MAX_CONNECTIONS }, (_, i) =>
      store.addConnection(tenant, { ...connection, workspaceId: `space-${i}`, linearOrgId: `org-${i}` })));
    expect(adds.filter(({ status }) => status === "fulfilled")).toHaveLength(MAX_CONNECTIONS - 1);
    expect(adds.find(({ status }) => status === "rejected")).toMatchObject({ reason: new Error("Connection limit reached") });
    const first = (await store.readTenant(tenant))!.connections[0].id;
    await expect(store.setNeedsKey(other, first)).rejects.toThrow("Connection not found");
    const tokens = await Promise.allSettled(Array.from({ length: MAX_LIVE_TOKENS + 1 }, () =>
      store.createToken(tenant, "coordinator")));
    expect(tokens.filter(({ status }) => status === "fulfilled")).toHaveLength(MAX_LIVE_TOKENS);
    expect(tokens.find(({ status }) => status === "rejected")).toMatchObject({ reason: new Error("Coordinator token limit reached") });
    const available = await store.listTokens(tenant);
    await store.revokeToken(tenant, available[0].id);
    await expect(store.createToken(tenant, "replacement")).resolves.toHaveProperty("token");
    expect(await store.listTokens(other)).toEqual([]);
  });

  test("stores only the hash and throttles last-used writes", async () => {
    const tenant = await store.createAccount(user, "Ada", connection);
    const { id, token } = await store.createToken(tenant, "coordinator");
    const hash = tokenHash(token);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(await sql.query("SELECT token_hash FROM coordinator_tokens")).toEqual([{ token_hash: hash }]);
    expect(await store.useToken(token)).toBe(tenant);
    const [first] = await store.listTokens(tenant);
    expect(first).toMatchObject({ id, name: "coordinator", lastUsedAt: expect.any(Date), revokedAt: null });
    expect(JSON.stringify(first)).not.toContain(hash);
    expect(JSON.stringify(first)).not.toContain(token);
    await sql.query("UPDATE coordinator_tokens SET last_used_at = now() - interval '30 seconds' WHERE id = $1", [id]);
    const [before] = await store.listTokens(tenant);
    expect(await store.useToken(token)).toBe(tenant);
    expect((await store.listTokens(tenant))[0].lastUsedAt).toEqual(before.lastUsedAt);
    await sql.query("UPDATE coordinator_tokens SET last_used_at = now() - interval '61 seconds' WHERE id = $1", [id]);
    expect(await store.useToken(token)).toBe(tenant);
    expect((await store.listTokens(tenant))[0].lastUsedAt!.getTime()).toBeGreaterThan(before.lastUsedAt!.getTime());
    await store.revokeToken(tenant, id);
    expect(await store.useToken(token)).toBeNull();
    expect(await store.useToken("unknown")).toBeNull();
  });

  test("keeps secrets out of database errors and captured log output", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const output: string[] = [];
    try {
      const tenant = await store.createAccount(user, "Ada", connection);
      const { token } = await store.createToken(tenant, "coordinator");
      const [first] = (await store.readTenant(tenant))!.connections;
      await store.replaceCredential(tenant, first.id, {
        kind: "oauth", key: apiKey, refreshToken, expiresAt: new Date("2030-01-01"),
      });
      const { token_hash: hash } = (await sql.query("SELECT token_hash FROM coordinator_tokens"))[0];
      const wrongKey = randomBytes(32).toString("base64");
      for (const operation of [
        () => createAccounts(sql, credentialCrypto({ WG_DATA_KEY: wrongKey })).readCredential(tenant, first.id),
        () => store.addConnection(tenant, { ...connection, workspaceId: apiKey, linearOrgId: refreshToken, team: null! }),
        () => sql.query("INSERT INTO coordinator_tokens (id, tenant_id, name, token_hash) VALUES (gen_random_uuid(), $1, $2, $3)", [tenant, token, hash]),
      ]) {
        await expect(operation().catch((error: Error) => {
          output.push(error.stack ?? error.message);
          throw error;
        })).rejects.toThrow();
      }
      const captured = JSON.stringify([output, log.mock.calls]);
      for (const secret of [key, wrongKey, apiKey, refreshToken, token, String(hash)]) {
        expect(captured.includes(secret)).toBe(false);
      }
    } finally {
      log.mockRestore();
    }
  });
});
