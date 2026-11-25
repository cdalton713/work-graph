import type { Tenant, Tenants } from "../tenants.ts";

export function testTenants(team: string) {
  const rows = new Map<string, Tenant>();
  for (const human of ["Ada", "Grace"]) {
    const id = human.toLowerCase();
    rows.set(id, { id, human, workspaces: [{ id: "default", name: human, team, key: id + "-key", teamLabels: true }] });
  }
  const grace = rows.get("grace")!;
  grace.workspaces.push({ ...grace.workspaces[0], id: "extra" });
  const listeners = new Set<(id: string) => void>();
  const tenants: Tenants = {
    async fromSession(session) {
      const name = session?.email.split("@")[0] ?? "";
      const viewer = name.endsWith("-viewer");
      const tenant = rows.get(viewer ? name.slice(0, -"-viewer".length) : name);
      return tenant ? { tenant, role: viewer ? "viewer" : "owner" } : null;
    },
    async fromToken(value) { return rows.get(value?.replace(/^Bearer /, "") ?? "") ?? null; },
    async byId(id) { return rows.get(id) ?? null; },
    onChange(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  return {
    tenants,
    change(tenant: Tenant) {
      rows.set(tenant.id, tenant);
      for (const listener of listeners) listener(tenant.id);
    },
  };
}
