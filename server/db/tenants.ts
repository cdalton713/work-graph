import { dbPushStore } from "./push.ts";
import { randomUUID } from "node:crypto";
import { LINK_PREFIX, type RedisLink } from "../redis.ts";
import type { SharedWorkspace, Tenant, Tenants } from "../tenants.ts";
import { LinearSignInRequired, refreshLinearToken, type LinearAuth, type OAuthCredential } from "../linearauth.ts";
import { LinearReconnectRequired } from "../linear.ts";
import { createAccounts } from "./accounts.ts";
import { credentialCrypto, type CredentialCrypto } from "./crypto.ts";
import { migrate } from "./migrations.ts";
import { postgresSql, type Sql } from "./sql.ts";

const CACHE_MS = 10_000;
const CACHE_LIMIT = 256;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DatabaseTenantOptions {
  linearAuth?: LinearAuth;
  now?: () => number;
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

export function dbTenants(sql: Sql, crypto: CredentialCrypto, { redis, prefix = LINK_PREFIX, linearAuth, now = () => Date.now() }: DatabaseTenantOptions = {}) {
  const cache = new Map<string, { expires: number; tenant: Promise<Tenant | null> }>();
  const memberships = new Map<string, {
    expires: number;
    owners?: Set<string>;
    rows: ReturnType<ReturnType<typeof import("./shares.ts").createShares>["memberships"]>;
  }>();
  const listeners = new Set<(id: string, membersOnly?: boolean) => void>();
  const source = randomUUID();
  const refreshing = new Map<string, Promise<OAuthCredential>>();

  function invalidate(id: string, membersOnly?: boolean) {
    if (!membersOnly) cache.delete(id);
    for (const [account, entry] of memberships) {
      if (account === id || !entry.owners || entry.owners.has(id)) memberships.delete(account);
    }
    for (const listener of listeners) {
      try { if (membersOnly) listener(id, true); else listener(id); } catch { console.error("Tenant change notice could not be delivered"); }
    }
  }

  const stop = redis?.onMessage((text) => {
    try {
      // The link bus uses arrays on this channel. Account notices use a single object.
      const event = JSON.parse(text) as { kind?: unknown; source?: unknown; tenant?: unknown; membersOnly?: unknown } | null;
      if (event?.kind === "account-changed" && event.source !== source &&
          typeof event.tenant === "string" && uuid.test(event.tenant)) invalidate(event.tenant.toLowerCase(), event.membersOnly === true);
    } catch {
      // Ignore malformed notices.
    }
  });

  const accounts = createAccounts(sql, crypto, async (tenant, membersOnly) => {
    invalidate(tenant.toLowerCase(), membersOnly);
    if (redis) {
      const message = JSON.stringify({ kind: "account-changed", source, tenant, ...(membersOnly && { membersOnly }) });
      await redis.run((client) => client.publish(prefix + "events", message));
    }
  });

  function oauthKey(auth: LinearAuth, tenant: string, id: string, initial: OAuthCredential, attached: boolean) {
    const key = refreshedKey(auth, tenant, id, initial);
    // A lost attached workspace needs a new connection in Settings, not a new sign-in to the page.
    return attached ? (rejected?: string) => key(rejected).catch((error: unknown) => {
      throw error instanceof LinearSignInRequired ? new LinearReconnectRequired() : error;
    }) : key;
  }

  function refreshedKey(auth: LinearAuth, tenant: string, id: string, initial: OAuthCredential) {
    let current = initial;
    return async (rejected?: string) => {
      if (current.key !== rejected && current.expiresAt.getTime() - now() >= 300_000) return current.key;
      let pending = refreshing.get(id);
      if (pending) {
        current = await pending;
        if (current.key !== rejected) return current.key;
        pending = refreshing.get(id);
      }
      if (!pending) {
        pending = accounts.refreshCredential(tenant, id, rejected, now, (token) => refreshLinearToken(auth, token, now))
          .finally(() => refreshing.delete(id));
        refreshing.set(id, pending);
      }
      current = await pending;
      return current.key;
    };
  }

  async function byId(id: string): Promise<Tenant | null> {
    if (!uuid.test(id)) return null;
    const key = id.toLowerCase();
    const time = now();
    const cached = cache.get(key);
    if (cached && cached.expires > time) return cached.tenant;
    cache.delete(key);
    if (cache.size >= CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    const tenant = accounts.resolveTenant(key, linearAuth ? (id, initial, attached) => oauthKey(linearAuth, key, id, initial, attached) : undefined).catch((error: unknown) => {
      if (cache.get(key)?.tenant === tenant) cache.delete(key);
      throw error;
    });
    cache.set(key, { expires: time + CACHE_MS, tenant });
    return tenant;
  }

  return {
    pushStore: dbPushStore(sql, crypto),
    accounts,
    accountStore: () => accounts,
    signIn: accounts.signIn,
    attach: accounts.attachOAuth,
    async fromSession(session) {
      const tenant = session ? await byId(session.accountId ?? session.id) : null;
      return tenant ? { tenant, role: "owner" } : null;
    },
    async fromToken(authorization) {
      const token = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization ?? "")?.[1];
      const id = token ? await accounts.useToken(token) : null;
      return id ? byId(id) : null;
    },
    byId,
    async sharedWorkspaces(account) {
      if (!uuid.test(account)) return [];
      const time = now();
      let cached = memberships.get(account);
      if (!cached || cached.expires <= time) {
        memberships.delete(account);
        if (memberships.size >= CACHE_LIMIT) memberships.delete(memberships.keys().next().value!);
        const rows = accounts.shares.memberships(account).then((found) => {
          const current = memberships.get(account);
          if (current?.rows === rows) current.owners = new Set(found.map(({ ownerId }) => ownerId));
          return found;
        }).catch((error) => {
          if (memberships.get(account)?.rows === rows) memberships.delete(account);
          throw error;
        });
        cached = { expires: time + CACHE_MS, rows };
        memberships.set(account, cached);
      }
      const resolved = await Promise.all((await cached.rows).map(async (row): Promise<SharedWorkspace | null> => {
        const owner = await byId(row.ownerId);
        const workspace = owner?.workspaces.find((entry) => entry.connectionId === row.connectionId);
        if (!owner || !workspace || workspace.needsKey || workspace.attached) return null;
        return { id: "shared:" + row.id, name: row.name, projectId: row.projectId, role: row.role, owner, workspace };
      }));
      return resolved.filter((entry): entry is SharedWorkspace => entry !== null);
    },
    onChange(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    close() {
      stop?.();
      cache.clear();
      memberships.clear();
      listeners.clear();
    },
  } satisfies Tenants & { accounts: typeof accounts; pushStore: ReturnType<typeof dbPushStore>; close(): void };
}
