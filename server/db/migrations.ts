import type { Sql } from "./sql.ts";

export const NEWER_SCHEMA_ERROR = "Database schema is newer than this server";

const migrations = [
  [
    `CREATE TABLE users (
      id uuid PRIMARY KEY,
      linear_user_id text NOT NULL,
      linear_org_id text NOT NULL,
      email text NOT NULL,
      name text NOT NULL,
      UNIQUE (linear_user_id, linear_org_id)
    )`,
    `CREATE TABLE tenants (
      id uuid PRIMARY KEY,
      owner_user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      human text NOT NULL
    )`,
    `CREATE TABLE linear_connections (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      workspace_id text NOT NULL,
      linear_org_id text NOT NULL,
      name text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('oauth', 'api_key')),
      credential text NOT NULL,
      refresh_token text,
      expires_at timestamptz,
      team text NOT NULL,
      team_labels boolean NOT NULL,
      position integer NOT NULL,
      status text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'needs_key')),
      UNIQUE (tenant_id, workspace_id),
      UNIQUE (tenant_id, linear_org_id),
      CHECK ((kind = 'oauth' AND refresh_token IS NOT NULL AND expires_at IS NOT NULL)
        OR (kind = 'api_key' AND refresh_token IS NULL AND expires_at IS NULL))
    )`,
    `CREATE TABLE coordinator_tokens (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name text NOT NULL,
      token_hash text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_used_at timestamptz,
      revoked_at timestamptz
    )`,
    "CREATE INDEX coordinator_tokens_tenant_id ON coordinator_tokens (tenant_id)",
  ],
  [
    "ALTER TABLE linear_connections DROP CONSTRAINT linear_connections_check, ALTER COLUMN credential DROP NOT NULL",
    `ALTER TABLE linear_connections ADD CHECK (
      (status = 'needs_key' AND credential IS NULL AND refresh_token IS NULL AND expires_at IS NULL)
      OR (credential IS NOT NULL AND (
        (kind = 'oauth' AND refresh_token IS NOT NULL AND expires_at IS NOT NULL)
        OR (kind = 'api_key' AND refresh_token IS NULL AND expires_at IS NULL)
      ))
    )`,
  ],
  [
    "ALTER TABLE linear_connections ADD COLUMN owner_name text, ADD COLUMN created_at timestamptz NOT NULL DEFAULT now()",
    `UPDATE linear_connections c SET owner_name = u.name FROM tenants t JOIN users u ON u.id = t.owner_user_id
      WHERE c.tenant_id = t.id AND c.kind = 'oauth'`,
  ],
  [
    `ALTER TABLE tenants ADD COLUMN name_confirmed boolean NOT NULL DEFAULT false,
      ADD COLUMN onboarding_skipped boolean NOT NULL DEFAULT false`,
  ],
  [
    `ALTER TABLE tenants ADD COLUMN send_usage_data boolean NOT NULL DEFAULT true,
      ADD COLUMN first_usage_connection boolean NOT NULL DEFAULT false,
      ADD COLUMN usage_onboarding_complete boolean NOT NULL DEFAULT false`,
    `UPDATE tenants t SET first_usage_connection = true WHERE EXISTS
      (SELECT 1 FROM coordinator_tokens c WHERE c.tenant_id = t.id AND c.last_used_at IS NOT NULL)`,
  ],
];

export async function migrate(sql: Sql): Promise<void> {
  for (;;) {
    const applied = await sql.transaction(async ({ query }) => {
      await query("SET LOCAL statement_timeout = 0");
      await query("SELECT pg_advisory_xact_lock(1970310516, 1)");
      await query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version integer PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      const versions = new Set((await query<{ version: number }>("SELECT version FROM schema_migrations"))
        .map(({ version }) => version));
      if ([...versions].some((version) => version > migrations.length)) {
        throw new Error(NEWER_SCHEMA_ERROR);
      }
      const index = migrations.findIndex((_, i) => !versions.has(i + 1));
      if (index === -1) return false;
      for (const statement of migrations[index]) await query(statement);
      await query("INSERT INTO schema_migrations (version) VALUES ($1)", [index + 1]);
      return true;
    });
    if (!applied) return;
  }
}
