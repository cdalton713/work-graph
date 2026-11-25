import { randomUUID } from "node:crypto";
import type { Tenant } from "../tenants.ts";
import { coordinatorToken, tokenHash, type CredentialCrypto } from "./crypto.ts";
import type { Query, Sql } from "./sql.ts";

export const MAX_CONNECTIONS = 10;
export const MAX_LIVE_TOKENS = 10;

type User = { linearUserId: string; linearOrgId: string; name: string; email: string };
export type ConnectionCredential =
  | { kind: "api_key"; key: string }
  | { kind: "oauth"; key: string; refreshToken: string; expiresAt: Date };
type Settings = { name: string; team: string; teamLabels: boolean };
export type NewConnection = Settings & { workspaceId: string; linearOrgId: string; credential: ConnectionCredential };
type Connection = Settings & {
  id: string; workspaceId: string; linearOrgId: string; position: number;
  kind: ConnectionCredential["kind"]; status: "ok" | "needs_key"; expiresAt: Date | null;
};
type EncryptedConnection = Connection & { credential: string; refreshToken: string | null };
type Token = { id: string; name: string; createdAt: Date; lastUsedAt: Date | null; revokedAt: Date | null };

const connectionFields = `id, workspace_id AS "workspaceId", linear_org_id AS "linearOrgId",
  name, team, team_labels AS "teamLabels", position, kind, status, expires_at AS "expiresAt"`;
const encryptedFields = `${connectionFields}, credential, refresh_token AS "refreshToken"`;
const tokenFields = `id, name, created_at AS "createdAt", last_used_at AS "lastUsedAt", revoked_at AS "revokedAt"`;

export function createAccounts(sql: Sql, crypto: CredentialCrypto, changed: (tenant: string) => void | Promise<void> = () => {}) {
  function encrypt(tenant: string, connection: string, credential: ConnectionCredential) {
    return [
      credential.kind,
      crypto.encrypt(credential.key, { tenant, connection, field: "credential" }),
      credential.kind === "oauth"
        ? crypto.encrypt(credential.refreshToken, { tenant, connection, field: "refresh_token" })
        : null,
      credential.kind === "oauth" ? credential.expiresAt : null,
    ];
  }

  function decrypt(tenant: string, row: EncryptedConnection): ConnectionCredential {
    const key = crypto.decrypt(row.credential, { tenant, connection: row.id, field: "credential" });
    if (row.kind === "api_key") return { kind: row.kind, key };
    if (!row.refreshToken || !row.expiresAt) throw new Error("Incomplete database credential");
    const refreshToken = crypto.decrypt(row.refreshToken, { tenant, connection: row.id, field: "refresh_token" });
    return { kind: row.kind, key, refreshToken, expiresAt: row.expiresAt };
  }

  async function insertConnection(query: Query, tenant: string, input: NewConnection, position: number) {
    const id = randomUUID();
    await query(`INSERT INTO linear_connections
      (id, tenant_id, workspace_id, linear_org_id, name, team, team_labels, position,
       kind, credential, refresh_token, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`, [
      id, tenant, input.workspaceId, input.linearOrgId, input.name, input.team, input.teamLabels,
      position, ...encrypt(tenant, id, input.credential),
    ]);
    return id;
  }

  async function change<T>(tenant: string, run: (query: Query, owner: string) => Promise<T>): Promise<T> {
    const result = await sql.transaction(async ({ query }) => {
      // All writes for this tenant take the same lock before checking limits or positions.
      const [row] = await query<{ owner: string }>("SELECT owner_user_id AS owner FROM tenants WHERE id = $1 FOR UPDATE", [tenant]);
      if (!row) throw new Error("Account not found");
      return run(query, row.owner);
    });
    await notify(tenant);
    return result;
  }

  async function notify(tenant: string) {
    try { await changed(tenant); } catch { console.error("Account change notice could not be delivered"); }
  }

  function orderedIds(query: Query, tenant: string) {
    return query<{ id: string }>("SELECT id FROM linear_connections WHERE tenant_id = $1 ORDER BY position, id", [tenant]);
  }

  async function updatePositions(query: Query, tenant: string, rows: { id: string }[]) {
    for (const [position, { id }] of rows.entries()) {
      await query(`UPDATE linear_connections SET position = $3
        WHERE tenant_id = $1 AND id = $2 AND position <> $3`, [tenant, id, position]);
    }
  }

  function requireConnection(rows: unknown[]) {
    if (!rows.length) throw new Error("Connection not found");
  }

  return {
    async createAccount(user: User, human: string, first: NewConnection): Promise<string> {
      const tenant = randomUUID(), owner = randomUUID();
      await sql.transaction(async ({ query }) => {
        await query("INSERT INTO users (id, linear_user_id, linear_org_id, email, name) VALUES ($1, $2, $3, $4, $5)",
          [owner, user.linearUserId, user.linearOrgId, user.email, user.name]);
        await query("INSERT INTO tenants (id, owner_user_id, human) VALUES ($1, $2, $3)", [tenant, owner, human]);
        await insertConnection(query, tenant, first, 0);
      });
      await notify(tenant);
      return tenant;
    },

    readTenant(tenant: string) {
      return sql.transaction(async ({ query }) => {
        const [account] = await query<{ id: string; human: string; user: User }>(`
          SELECT t.id, t.human, json_build_object('linearUserId', u.linear_user_id,
            'linearOrgId', u.linear_org_id, 'email', u.email, 'name', u.name) AS "user"
          FROM tenants t JOIN users u ON u.id = t.owner_user_id WHERE t.id = $1 FOR SHARE OF t`, [tenant]);
        if (!account) return null;
        const connections = await query<Connection>(`SELECT ${connectionFields} FROM linear_connections
          WHERE tenant_id = $1 ORDER BY position, id`, [tenant]);
        return { ...account, connections };
      });
    },

    async readCredential(tenant: string, connection: string): Promise<ConnectionCredential | null> {
      const [row] = await sql.query<EncryptedConnection>(`SELECT ${encryptedFields} FROM linear_connections
        WHERE tenant_id = $1 AND id = $2`, [tenant, connection]);
      return row ? decrypt(tenant, row) : null;
    },

    resolveTenant(tenant: string): Promise<Tenant | null> {
      return sql.transaction(async ({ query }) => {
        const [account] = await query<{ id: string; human: string }>(
          "SELECT id, human FROM tenants WHERE id = $1 FOR SHARE", [tenant]);
        if (!account) return null;
        const connections = await query<EncryptedConnection>(`SELECT ${encryptedFields} FROM linear_connections
          WHERE tenant_id = $1 AND status = 'ok' ORDER BY position, id`, [tenant]);
        return {
          ...account,
          workspaces: connections.map((row) => ({
            id: row.workspaceId, name: row.name, team: row.team, teamLabels: row.teamLabels,
            key: crypto.decrypt(row.credential, { tenant, connection: row.id, field: "credential" }),
          })),
        };
      });
    },

    addConnection(tenant: string, input: NewConnection) {
      return change(tenant, async (query) => {
        const rows = await orderedIds(query, tenant);
        if (rows.length >= MAX_CONNECTIONS) throw new Error("Connection limit reached");
        return insertConnection(query, tenant, input, rows.length);
      });
    },

    replaceCredential(tenant: string, connection: string, credential: ConnectionCredential) {
      return change(tenant, async (query) => {
        requireConnection(await query(`UPDATE linear_connections SET kind = $3, credential = $4,
          refresh_token = $5, expires_at = $6, status = 'ok'
          WHERE tenant_id = $1 AND id = $2 RETURNING id`, [tenant, connection, ...encrypt(tenant, connection, credential)]));
      });
    },

    updateConnectionSettings(tenant: string, connection: string, settings: Settings & { position?: number }) {
      return change(tenant, async (query) => {
        requireConnection(await query(`UPDATE linear_connections SET name = $3, team = $4, team_labels = $5
          WHERE tenant_id = $1 AND id = $2 RETURNING id`, [tenant, connection, settings.name, settings.team, settings.teamLabels]));
        const { position } = settings;
        if (position === undefined) return;
        const rows = await orderedIds(query, tenant);
        if (!Number.isInteger(position) || position < 0 || position >= rows.length) {
          throw new Error("Invalid connection position");
        }
        const [row] = rows.splice(rows.findIndex(({ id }) => id === connection), 1);
        rows.splice(position, 0, row);
        await updatePositions(query, tenant, rows);
      });
    },

    removeConnection(tenant: string, connection: string) {
      return change(tenant, async (query) => {
        requireConnection(await query("DELETE FROM linear_connections WHERE tenant_id = $1 AND id = $2 RETURNING id", [tenant, connection]));
        await updatePositions(query, tenant, await orderedIds(query, tenant));
      });
    },

    setNeedsKey(tenant: string, connection: string) {
      return change(tenant, async (query) => {
        requireConnection(await query(`UPDATE linear_connections SET status = 'needs_key'
          WHERE tenant_id = $1 AND id = $2 RETURNING id`, [tenant, connection]));
      });
    },

    createToken(tenant: string, name: string) {
      return change(tenant, async (query) => {
        const [{ count }] = await query<{ count: number }>(`SELECT count(*)::integer AS count
          FROM coordinator_tokens WHERE tenant_id = $1 AND revoked_at IS NULL`, [tenant]);
        if (count >= MAX_LIVE_TOKENS) throw new Error("Coordinator token limit reached");
        const token = coordinatorToken();
        const [record] = await query<Token>(`INSERT INTO coordinator_tokens (id, tenant_id, name, token_hash)
          VALUES ($1, $2, $3, $4) RETURNING ${tokenFields}`, [randomUUID(), tenant, name, tokenHash(token)]);
        return { ...record, token };
      });
    },

    listTokens(tenant: string) {
      return sql.query<Token>(`SELECT ${tokenFields} FROM coordinator_tokens WHERE tenant_id = $1 ORDER BY created_at, id`, [tenant]);
    },

    revokeToken(tenant: string, id: string) {
      return change(tenant, async (query) => {
        const rows = await query(`UPDATE coordinator_tokens SET revoked_at = coalesce(revoked_at, now())
          WHERE tenant_id = $1 AND id = $2 RETURNING id`, [tenant, id]);
        if (!rows.length) throw new Error("Coordinator token not found");
      });
    },

    useToken(token: string) {
      return sql.transaction(async ({ query }) => {
        const params = [tokenHash(token)];
        const [used] = await query<{ tenant: string }>(`UPDATE coordinator_tokens SET last_used_at = now()
          WHERE token_hash = $1 AND revoked_at IS NULL
          AND (last_used_at IS NULL OR last_used_at <= now() - interval '1 minute')
          RETURNING tenant_id AS tenant`, params);
        if (used) return used.tenant;
        const [live] = await query<{ tenant: string }>(`SELECT tenant_id AS tenant
          FROM coordinator_tokens WHERE token_hash = $1 AND revoked_at IS NULL`, params);
        return live?.tenant ?? null;
      });
    },

    deleteAccount(tenant: string) {
      return change(tenant, async (query, owner) => {
        await query("DELETE FROM users WHERE id = $1", [owner]);
      });
    },
  };
}
