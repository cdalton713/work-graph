import { createHash, timingSafeEqual } from "node:crypto";
import type { Auth, Session } from "./auth.ts";
import type { Workspace } from "./workspaces.ts";

export interface Tenant {
  id: string;
  human: string;
  workspaces: Workspace[];
}

export type TenantRole = "owner" | "viewer";
type Lookup<T> = T | null | Promise<T | null>;

export interface Tenants {
  fromSession(session: Session | null): Lookup<{ tenant: Tenant; role: TenantRole }>;
  fromToken(authorization: string | undefined): Lookup<Tenant>;
  byId(id: string): Lookup<Tenant>;
  onChange(listener: (id: string) => void): () => void;
}

export const CONFIG_TENANT_ID = "config";
export const TENANT_IDLE_MS = 30 * 60_000;

export async function openDatabaseTenants(
  env: NodeJS.ProcessEnv = process.env,
  options?: import("./db/tenants.ts").DatabaseTenantOptions,
) {
  if (!env.DATABASE_URL) return null;
  const { openTenants } = await import("./db/tenants.ts");
  return openTenants(env.DATABASE_URL, env, options);
}

export function configTenants({ human, workspaces, auth, linkToken, readOnly }: {
  human: string; workspaces: Workspace[]; auth: Auth | null; linkToken?: string; readOnly: boolean;
}) {
  const tenant = { id: CONFIG_TENANT_ID, human, workspaces };
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const credential = linkToken ? digest(`Bearer ${linkToken}`) : null;
  return {
    fromSession(session: Session | null): { tenant: Tenant; role: TenantRole } | null {
      if (auth && !session) return null;
      const role = readOnly || (session && !auth?.owners?.includes(session.email)) ? "viewer" : "owner";
      return { tenant, role };
    },
    fromToken(authorization: string | undefined) {
      return credential && authorization !== undefined && timingSafeEqual(digest(authorization), credential) ? tenant : null;
    },
    byId(id: string) { return id === tenant.id ? tenant : null; },
    onChange(_listener: (id: string) => void) { return () => {}; },
  } satisfies Tenants;
}
