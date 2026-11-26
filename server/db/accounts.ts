import { randomUUID } from "node:crypto";
import type { Tenant } from "../tenants.ts";
import type { Workspace } from "../workspaces.ts";
import { LinearSignInRequired, type OAuthCredential } from "../linearauth.ts";
import { coordinatorToken, tokenHash, type CredentialCrypto } from "./crypto.ts";
import type { Query, Sql } from "./sql.ts";
import { createPlans } from "./plans.ts";
import { createClaims } from "./claims.ts";
import { createShares } from "./shares.ts";

export const MAX_CONNECTIONS = 10;
export const MAX_LIVE_TOKENS = 10;

type User = { linearUserId: string; linearOrgId: string; name: string; email: string };
export type ConnectionCredential =
  | { kind: "api_key"; key: string }
  | OAuthCredential;
type Settings = { name: string; team: string; teamLabels: boolean };
export type NewConnection = Settings & { workspaceId: string; linearOrgId: string; credential: ConnectionCredential; ownerName?: string };
type Connection = Settings & {
  id: string; workspaceId: string; linearOrgId: string; position: number;
  kind: ConnectionCredential["kind"]; status: "ok" | "needs_key"; expiresAt: Date | null;
  ownerName: string | null; createdAt: Date;
};
type EncryptedConnection = Connection & { tenantId: string; credential: string | null; refreshToken: string | null };
type Token = { id: string; name: string; createdAt: Date; lastUsedAt: Date | null; revokedAt: Date | null };

const connectionFields = `id, workspace_id AS "workspaceId", linear_org_id AS "linearOrgId",
  name, team, team_labels AS "teamLabels", position, kind, status, expires_at AS "expiresAt",
  owner_name AS "ownerName", created_at AS "createdAt"`;
const encryptedFields = `${connectionFields}, tenant_id AS "tenantId", credential, refresh_token AS "refreshToken"`;
const tokenFields = `id, name, created_at AS "createdAt", last_used_at AS "lastUsedAt", revoked_at AS "revokedAt"`;

function requireUuid(id: string) {
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error("Invalid database UUID");
  }
}

export function createAccounts(sql: Sql, crypto: CredentialCrypto, changed: (tenant: string, membersOnly?: boolean) => void | Promise<void> = () => {}) {
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

  function decrypt(row: EncryptedConnection): ConnectionCredential {
    const tenant = row.tenantId;
    if (row.credential === null) throw new Error("Incomplete database credential");
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
       kind, credential, refresh_token, expires_at, owner_name)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`, [
      id, tenant, input.workspaceId, input.linearOrgId, input.name, input.team, input.teamLabels,
      position, ...encrypt(tenant, id, input.credential), input.ownerName ?? null,
    ]);
    return id;
  }

  async function change<T>(tenant: string, run: (query: Query, account: { id: string; owner: string }) => Promise<T>): Promise<T> {
    requireUuid(tenant);
    const { id, result } = await sql.transaction(async ({ query }) => {
      // All writes for this tenant take the same lock before checking limits or positions.
      const [row] = await query<{ id: string; owner: string }>(
        "SELECT id, owner_user_id AS owner FROM tenants WHERE id = $1 FOR UPDATE", [tenant]);
      if (!row) throw new Error("Account not found");
      return { id: row.id, result: await run(query, row) };
    });
    await notify(id);
    return result;
  }

  async function notify(tenant: string, membersOnly?: boolean) {
    try {
      if (membersOnly) await changed(tenant, true);
      else await changed(tenant);
    } catch { console.error("Account change notice could not be delivered"); }
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

  async function rejectApiKey(row: EncryptedConnection) {
    // A late response for an old key must leave the replacement in place.
    const changed = await sql.query(`UPDATE linear_connections SET status = 'needs_key', credential = NULL
      WHERE tenant_id = $1 AND id = $2 AND kind = 'api_key' AND status = 'ok' AND credential = $3
      RETURNING id`, [row.tenantId, row.id, row.credential]);
    if (changed.length) await notify(row.tenantId);
  }

  return {
    shares: createShares(sql, notify),
    claims: createClaims(sql),
    plans: createPlans(sql),
    async signIn(user: User, first: NewConnection, observed?: (id: string, created: boolean, enabled: boolean) => void) {
      const tenant = await sql.transaction(async ({ query }) => {
        // A concurrent first callback waits on the unique identity. For an existing
        // account, take the tenant lock before updating the user, as account deletion does.
        const [created] = await query<{ id: string }>(`INSERT INTO users (id, linear_user_id, linear_org_id, email, name)
          VALUES ($1, $2, $3, $4, $5) ON CONFLICT (linear_user_id, linear_org_id)
          DO NOTHING RETURNING id`,
        [randomUUID(), user.linearUserId, user.linearOrgId, user.email, user.name]);
        if (created) {
          const [{ id }] = await query<{ id: string }>(
            "INSERT INTO tenants (id, owner_user_id, human) VALUES ($1, $2, $3) RETURNING id",
            [randomUUID(), created.id, user.name]);
          await insertConnection(query, id, { ...first, ownerName: user.name }, 0);
          return { id, created: true, enabled: true };
        }
        const [account] = await query<{ id: string; owner: string; enabled: boolean }>(`SELECT t.id, u.id AS owner, t.send_usage_data AS enabled
          FROM tenants t JOIN users u ON u.id = t.owner_user_id
          WHERE u.linear_user_id = $1 AND u.linear_org_id = $2 FOR UPDATE OF t`, [user.linearUserId, user.linearOrgId]);
        if (!account) throw new Error("Account not found");
        const { id, owner } = account;
        await query("UPDATE users SET email = $2, name = $3 WHERE id = $1", [owner, user.email, user.name]);
        const [connection] = await query<{ id: string }>(`SELECT id FROM linear_connections
          WHERE tenant_id = $1 AND linear_org_id = $2`, [id, first.linearOrgId]);
        if (connection) {
          await query(`UPDATE linear_connections SET kind = $3, credential = $4, refresh_token = $5,
            expires_at = $6, status = 'ok', owner_name = $7 WHERE tenant_id = $1 AND id = $2`,
          [id, connection.id, ...encrypt(id, connection.id, first.credential), user.name]);
        } else {
          const rows = await orderedIds(query, id);
          if (rows.length >= MAX_CONNECTIONS) throw new Error("Connection limit reached");
          await insertConnection(query, id, { ...first, ownerName: user.name }, rows.length);
        }
        return { id, created: false, enabled: account.enabled };
      });
      await notify(tenant.id);
      observed?.(tenant.id, tenant.created, tenant.enabled);
      return tenant.id;
    },

    async refreshCredential(tenant: string, connection: string, rejected: string | undefined, now: () => number,
      refresh: (token: string) => Promise<OAuthCredential | null>): Promise<OAuthCredential> {
      requireUuid(tenant);
      requireUuid(connection);
      const result = await sql.transaction(async ({ query }) => {
        const [row] = await query<EncryptedConnection>(`SELECT ${encryptedFields} FROM linear_connections
          WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tenant, connection]);
        if (!row || row.status !== "ok" || row.kind !== "oauth") return { credential: null };
        const current = decrypt(row) as OAuthCredential;
        if (current.key !== rejected && current.expiresAt.getTime() - now() >= 300_000) {
          return { credential: current };
        }
        const credential = await refresh(current.refreshToken);
        if (!credential) {
          await query(`UPDATE linear_connections SET status = 'needs_key', credential = NULL, refresh_token = NULL,
            expires_at = NULL WHERE tenant_id = $1 AND id = $2`, [row.tenantId, row.id]);
          return { credential, changedTenant: row.tenantId };
        }
        await query(`UPDATE linear_connections SET kind = $3, credential = $4, refresh_token = $5,
          expires_at = $6 WHERE tenant_id = $1 AND id = $2`,
        [row.tenantId, row.id, ...encrypt(row.tenantId, row.id, credential)]);
        return { credential };
      });
      if (result.changedTenant) await notify(result.changedTenant);
      if (!result.credential) throw new LinearSignInRequired();
      return result.credential;
    },

    async createAccount(user: User, human: string, first: NewConnection): Promise<string> {
      const tenant = randomUUID(), owner = randomUUID();
      await sql.transaction(async ({ query }) => {
        await query("INSERT INTO users (id, linear_user_id, linear_org_id, email, name) VALUES ($1, $2, $3, $4, $5)",
          [owner, user.linearUserId, user.linearOrgId, user.email, user.name]);
        await query("INSERT INTO tenants (id, owner_user_id, human) VALUES ($1, $2, $3)", [tenant, owner, human]);
        await insertConnection(query, tenant, { ...first, ownerName: first.ownerName ?? user.name }, 0);
      });
      await notify(tenant);
      return tenant;
    },

    async readTenant(tenant: string) {
      requireUuid(tenant);
      return sql.transaction(async ({ query }) => {
        const [account] = await query<{ id: string; human: string; nameConfirmed: boolean; onboardingSkipped: boolean; sendUsageData: boolean; user: User }>(`
          SELECT t.id, t.human, t.name_confirmed AS "nameConfirmed", t.onboarding_skipped AS "onboardingSkipped", t.send_usage_data AS "sendUsageData",
            json_build_object('linearUserId', u.linear_user_id,
            'linearOrgId', u.linear_org_id, 'email', u.email, 'name', u.name) AS "user"
          FROM tenants t JOIN users u ON u.id = t.owner_user_id WHERE t.id = $1 FOR SHARE OF t`, [tenant]);
        if (!account) return null;
        const connections = await query<Connection>(`SELECT ${connectionFields} FROM linear_connections
          WHERE tenant_id = $1 ORDER BY position, id`, [tenant]);
        return { ...account, connections };
      });
    },

    setHuman(tenant: string, human: string) {
      return change(tenant, async (query) => {
        await query("UPDATE tenants SET human = $2 WHERE id = $1", [tenant, human]);
      });
    },

    setAccountSettings(tenant: string, human: string | null, sendUsageData: boolean) {
      return change(tenant, async (query) => {
        await query("UPDATE tenants SET human = coalesce($2, human), send_usage_data = $3 WHERE id = $1",
          [tenant, human, sendUsageData]);
      });
    },

    async usageConsent(tenant: string) {
      requireUuid(tenant);
      const [account] = await sql.query<{ enabled: boolean }>(
        'SELECT send_usage_data AS enabled FROM tenants WHERE id = $1', [tenant]);
      return account?.enabled === true;
    },

    async claimFirstConnection(tenant: string) {
      requireUuid(tenant);
      const rows = await sql.query(`UPDATE tenants SET first_usage_connection = true
        WHERE id = $1 AND send_usage_data AND NOT first_usage_connection RETURNING id`, [tenant]);
      return rows.length > 0;
    },

    async claimOnboardingComplete(tenant: string) {
      requireUuid(tenant);
      const rows = await sql.query(`UPDATE tenants SET usage_onboarding_complete = true
        WHERE id = $1 AND send_usage_data AND NOT usage_onboarding_complete RETURNING id`, [tenant]);
      return rows.length > 0;
    },

    setOnboarding(tenant: string, name: true | undefined, skipped: boolean | undefined) {
      return change(tenant, async (query) => {
        await query(`UPDATE tenants SET name_confirmed = coalesce($2, name_confirmed),
          onboarding_skipped = coalesce($3, onboarding_skipped) WHERE id = $1`, [tenant, name ?? null, skipped ?? null]);
      });
    },

    async tokenSummary(tenant: string) {
      requireUuid(tenant);
      const rows = await sql.query<(Token | { id: null }) & { connected: boolean }>(`
        SELECT ${tokenFields}, EXISTS (
          SELECT 1 FROM coordinator_tokens WHERE tenant_id = $1 AND last_used_at IS NOT NULL
        ) AS connected FROM (SELECT 1) account
        LEFT JOIN coordinator_tokens ON tenant_id = $1 AND revoked_at IS NULL
        ORDER BY created_at, id`, [tenant]);
      return {
        connected: rows[0]?.connected ?? false,
        tokens: rows.filter((row): row is Token & { connected: boolean } => row.id !== null)
          .map(({ id, name, createdAt, lastUsedAt }) =>
          ({ id, name, createdAt, lastUsedAt })),
      };
    },

    async readCredential(tenant: string, connection: string): Promise<ConnectionCredential | null> {
      requireUuid(tenant);
      requireUuid(connection);
      const [row] = await sql.query<EncryptedConnection>(`SELECT ${encryptedFields} FROM linear_connections
        WHERE tenant_id = $1 AND id = $2`, [tenant, connection]);
      return row?.credential != null ? decrypt(row) : null;
    },

    async resolveTenant(tenant: string, oauthKey?: (id: string, initial: OAuthCredential) => (rejected?: string) => Promise<string>): Promise<Tenant | null> {
      requireUuid(tenant);
      return sql.transaction(async ({ query }) => {
        const [account] = await query<{ id: string; human: string }>(
          "SELECT id, human FROM tenants WHERE id = $1 FOR SHARE", [tenant]);
        if (!account) return null;
        const connections = await query<EncryptedConnection>(`SELECT ${encryptedFields} FROM linear_connections
          WHERE tenant_id = $1 AND (status = 'ok' OR ($2 AND kind = 'oauth')) ORDER BY position, id`, [tenant, !!oauthKey]);
        return {
          ...account,
          workspaces: connections.flatMap<Workspace>((row) => {
            const workspace = { connectionId: row.id, organizationId: row.linearOrgId, id: row.workspaceId, name: row.name, team: row.team, teamLabels: row.teamLabels };
            if (row.status === "needs_key") return [{ ...workspace, kind: row.kind, key: "", needsKey: true }];
            let credential: ConnectionCredential;
            try {
              credential = decrypt(row);
            } catch {
              console.error(`Cannot decrypt database credential for connection ${row.id}`);
              return [];
            }
            if (credential.kind === "api_key") {
              return [{ ...workspace, kind: credential.kind, key: credential.key, rejectApiKey: () => rejectApiKey(row) }];
            }
            return [{ ...workspace, kind: credential.kind, key: credential.key, oauthKey: oauthKey?.(row.id, credential) }];
          }),
        };
      });
    },

    addConnection(tenant: string, input: NewConnection) {
      return change(tenant, async (query, account) => {
        const rows = await orderedIds(query, account.id);
        if (rows.length >= MAX_CONNECTIONS) throw new Error("Connection limit reached");
        return insertConnection(query, account.id, input, rows.length);
      });
    },

    async replaceCredential(tenant: string, connection: string, credential: ConnectionCredential,
      verified?: { ownerName: string; organization: string; teams: string[] }) {
      requireUuid(connection);
      return change(tenant, async (query, account) => {
        const [row] = await query<Connection>(`SELECT ${connectionFields}
          FROM linear_connections WHERE tenant_id = $1 AND id = $2`, [account.id, connection]);
        if (!row) throw new Error("Connection not found");
        if (verified && (row.kind !== "api_key" || row.linearOrgId !== verified.organization)) {
          throw new Error("The replacement key must belong to the same Linear organization");
        }
        const team = !verified || verified.teams.includes(row.team) ? row.team
          : verified.teams.length === 1 ? verified.teams[0] : "";
        await query(`UPDATE linear_connections SET kind = $3, credential = $4,
          refresh_token = $5, expires_at = $6, status = 'ok', owner_name = $7, team = $8
          WHERE tenant_id = $1 AND id = $2`, [account.id, row.id, ...encrypt(account.id, row.id, credential), verified?.ownerName ?? row.ownerName, team]);
      });
    },

    async updateConnectionSettings(tenant: string, connection: string, settings: Partial<Settings> & { position?: number }, checkedKey?: string) {
      requireUuid(connection);
      return change(tenant, async (query) => {
        if (checkedKey !== undefined) {
          const [row] = await query<EncryptedConnection>(`SELECT ${encryptedFields} FROM linear_connections
            WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tenant, connection]);
          if (!row) throw new Error("Connection not found");
          if (row.status !== "ok" || decrypt(row).key !== checkedKey) throw new Error("The workspace credential changed. Try again.");
        }
        const [updated] = await query<{ id: string }>(`UPDATE linear_connections SET
          name = coalesce($3, name), team = coalesce($4, team), team_labels = coalesce($5, team_labels)
          WHERE tenant_id = $1 AND id = $2 RETURNING id`, [tenant, connection, settings.name ?? null, settings.team ?? null, settings.teamLabels ?? null]);
        if (!updated) throw new Error("Connection not found");
        const { position } = settings;
        if (position === undefined) return;
        const rows = await orderedIds(query, tenant);
        if (!Number.isInteger(position) || position < 0 || position >= rows.length) {
          throw new Error("Invalid connection position");
        }
        const [row] = rows.splice(rows.findIndex(({ id }) => id === updated.id), 1);
        rows.splice(position, 0, row);
        await updatePositions(query, tenant, rows);
      });
    },

    async removeConnection(tenant: string, connection: string, apiKeyOnly = false) {
      requireUuid(connection);
      return change(tenant, async (query) => {
        requireConnection(await query(`DELETE FROM linear_connections WHERE tenant_id = $1 AND id = $2
          AND (NOT $3 OR kind = 'api_key') RETURNING id`, [tenant, connection, apiKeyOnly]));
        await updatePositions(query, tenant, await orderedIds(query, tenant));
      });
    },

    async setNeedsKey(tenant: string, connection: string) {
      requireUuid(connection);
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

    async listTokens(tenant: string) {
      requireUuid(tenant);
      return sql.query<Token>(`SELECT ${tokenFields} FROM coordinator_tokens WHERE tenant_id = $1 ORDER BY created_at, id`, [tenant]);
    },

    async revokeToken(tenant: string, id: string) {
      requireUuid(id);
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

    async deleteAccount(tenant: string, revocation?: { id: string; refreshToken: string }) {
      const { revoked, affected } = await change(tenant, async (query, { owner }) => {
        let revoked = false;
        if (revocation) {
          // A sign-in or refresh can rotate the credential while revocation is in flight.
          const [row] = await query<EncryptedConnection>(`SELECT ${encryptedFields} FROM linear_connections
            WHERE tenant_id = $1 AND id = $2 AND kind = 'oauth' FOR UPDATE`, [tenant, revocation.id]);
          if (row?.credential) {
            try {
              const current = decrypt(row);
              revoked = current.kind === "oauth" && current.refreshToken === revocation.refreshToken;
            } catch { /* Delete even if the credential cannot be read. */ }
          }
        }
        // A join holds a key share lock on this user until its membership is saved.
        await query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [owner]);
        const affected = await query<{ tenant: string }>(
          "SELECT DISTINCT tenant_id AS tenant FROM project_members WHERE user_id = $1", [owner]);
        await query("DELETE FROM users WHERE id = $1", [owner]);
        return { revoked, affected };
      });
      await Promise.all(affected.map(({ tenant }) => notify(tenant, true)));
      return revoked;
    },
  };
}
