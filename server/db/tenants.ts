import { randomUUID } from "node:crypto";
import { LINK_PREFIX, type RedisLink } from "../redis.ts";
import type { Tenant, Tenants } from "../tenants.ts";
import { createAccounts } from "./accounts.ts";
import { credentialCrypto, type CredentialCrypto } from "./crypto.ts";
import { migrate } from "./migrations.ts";
import { postgresSql, type Sql } from "./sql.ts";

const CACHE_MS = 10_000;
const CACHE_LIMIT = 256;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DatabaseTenantOptions {
  redis?: RedisLink;
  /** Use the same prefix as the Redis client. */
  prefix?: string;
}

export async function openTenants(url: string, env: NodeJS.ProcessEnv, options?: DatabaseTenantOptions) {
  const crypto = credentialCrypto(env);
  const sql = await postgresSql(url);
  try {
    await migrate(sql);
    const directory = dbTenants(sql, crypto, options);
    return {
      ...directory,
      async close() {
        directory.close();
        await sql.close();
      },
    };
  } catch (error) {
    await sql.close();
    throw error;
  }
}

export function dbTenants(sql: Sql, crypto: CredentialCrypto, { redis, prefix = LINK_PREFIX }: DatabaseTenantOptions = {}) {
  const cache = new Map<string, { expires: number; tenant: Promise<Tenant | null> }>();
  const listeners = new Set<(id: string) => void>();
  const source = randomUUID();

  function invalidate(id: string) {
    cache.delete(id);
    for (const listener of listeners) {
      try { listener(id); } catch { console.error("Tenant change notice could not be delivered"); }
    }
  }

  const stop = redis?.onMessage((text) => {
    try {
      // The link bus uses arrays on this channel. Account notices use a single object.
      const event = JSON.parse(text) as { kind?: unknown; source?: unknown; tenant?: unknown } | null;
      if (event?.kind === "account-changed" && event.source !== source &&
          typeof event.tenant === "string" && uuid.test(event.tenant)) invalidate(event.tenant.toLowerCase());
    } catch {
      // Ignore malformed notices.
    }
  });

  const accounts = createAccounts(sql, crypto, async (tenant) => {
    invalidate(tenant.toLowerCase());
    if (redis) {
      const message = JSON.stringify({ kind: "account-changed", source, tenant });
      await redis.run((client) => client.publish(prefix + "events", message));
    }
  });

  async function byId(id: string): Promise<Tenant | null> {
    if (!uuid.test(id)) return null;
    const key = id.toLowerCase();
    const now = Date.now();
    const cached = cache.get(key);
    if (cached && cached.expires > now) return cached.tenant;
    cache.delete(key);
    if (cache.size >= CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    const tenant = accounts.resolveTenant(key).catch((error: unknown) => {
      if (cache.get(key)?.tenant === tenant) cache.delete(key);
      throw error;
    });
    cache.set(key, { expires: now + CACHE_MS, tenant });
    return tenant;
  }

  return {
    accounts,
    async fromSession(session) {
      const tenant = session ? await byId(session.id) : null;
      return tenant ? { tenant, role: "owner" } : null;
    },
    async fromToken(authorization) {
      const token = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization ?? "")?.[1];
      const id = token ? await accounts.useToken(token) : null;
      return id ? byId(id) : null;
    },
    byId,
    onChange(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    close() {
      stop?.();
      cache.clear();
      listeners.clear();
    },
  } satisfies Tenants & { accounts: typeof accounts; close(): void };
}
