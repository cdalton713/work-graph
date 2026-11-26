import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Session } from "./auth.ts";
import { accountUsage } from "./account.ts";
import type { createAccounts } from "./db/accounts.ts";
import { SHARE_KINDS, type MemberRole, type ShareKind } from "./db/shares.ts";
import { LinearError } from "./linear.ts";
import { addLinearAccess, missingAccess, type InWorkspace } from "./linearaccess.ts";
import type { Telemetry } from "./telemetry.ts";
import type { Tenant } from "./tenants.ts";
import type { Workspace } from "./workspaces.ts";

export type ShareAccess = { accounts: ReturnType<typeof createAccounts>; tenant: Tenant; session: Session };
type Options = {
  runLinear: (tenant: Tenant, workspace: Workspace) => InWorkspace;
  access: (c: Context) => Promise<ShareAccess | Response>;
  project: (tenant: Tenant, workspace: Workspace, id: string) => Promise<string | null>;
  limit: (session: string) => Promise<number>;
  pageUrl: string;
  telemetry?: Telemetry | null;
  notice: (account: ShareAccess, workspace: string, project: [string, string, string], nodes: string[]) => Promise<void>;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unavailable = () => new LinearError("Project share not found", 404);
const invalidLink = () => new LinearError("Share link not found", 404);

function shareKind(kind: string | undefined): ShareKind {
  if (kind === "view" || kind === "collab") return kind;
  throw unavailable();
}

export function shareRoutes({ access, project, limit, pageUrl, telemetry, runLinear, notice }: Options) {
  const routes = new Hono();
  const url = (token: string) => ({ url: `${pageUrl}/join/${token}` });
  const smallBody = bodyLimit({ maxSize: 1024 });

  async function owner(c: Context, run: (target: {
    account: ShareAccess;
    workspace: Workspace;
    projectId: string;
    key: [string, string, string];
    resolve: () => Promise<ReturnType<typeof accountUsage>>;
  }) => Promise<Response>) {
    const account = await access(c);
    if (account instanceof Response) return account;
    const { accounts, tenant } = account;
    const workspaceId = c.req.header("x-workspace") || tenant.workspaces[0]?.id;
    const workspace = tenant.workspaces.find(({ id }) => id === workspaceId);
    const row = (await accounts.readTenant(tenant.id))?.connections.find(({ workspaceId: id }) => id === workspaceId);
    if (!row) throw unavailable();
    if (row.kind === "api_key") throw new LinearError("Projects in an API key workspace cannot be shared", 400);
    if (!workspace) throw unavailable();
    const projectId = c.req.param("id")!;
    return run({ account, workspace, projectId, key: [tenant.id, row.id, projectId], resolve: async () => {
      const current = await accounts.readTenant(tenant.id);
      return current ? accountUsage(current, row) : null;
    } });
  }

  const base = "/projects/:id/share";
  routes.get(base, (c) => owner(c, async ({ account, key }) => {
    const result = await account.accounts.shares.list(key);
    if (!result) throw unavailable();
    const link = (kind: ShareKind) => {
      const live = result.links.find((link) => link.kind === kind);
      return live ? { exists: true, createdAt: live.createdAt } : { exists: false };
    };
    return c.json({ view: link("view"), collab: link("collab"), members: result.members });
  }));

  routes.post(base, (c) => owner(c, async ({ account, workspace, projectId, key, resolve }) => {
    const name = await project(account.tenant, workspace, projectId);
    if (!name) throw unavailable();
    const result = await account.accounts.shares.make(key, name);
    if (!result) throw unavailable();
    const response = Object.fromEntries(SHARE_KINDS.map((kind) => {
      const token = result.created[kind];
      if (token) telemetry?.emit("share_made", {}, resolve, key[0]);
      return [kind, token ? url(token) : { exists: true }];
    }));
    return c.json(response);
  }));

  routes.post(base + "/:kind/rotate", (c) => owner(c, async ({ account, workspace, projectId, key, resolve }) => {
    const kind = shareKind(c.req.param("kind"));
    if (!await account.accounts.shares.list(key)) throw unavailable();
    const name = await project(account.tenant, workspace, projectId);
    if (!name) throw unavailable();
    const result = await account.accounts.shares.make(key, name, kind);
    const token = result?.created[kind];
    if (!token) throw unavailable();
    if (result.revoked) telemetry?.emit("share_revoked", {}, resolve, key[0]);
    telemetry?.emit("share_made", {}, resolve, key[0]);
    return c.json(url(token));
  }));

  routes.delete(base + "/:kind", (c) => owner(c, async ({ account, key, resolve }) => {
    if (!await account.accounts.shares.revoke(key, shareKind(c.req.param("kind")))) throw unavailable();
    telemetry?.emit("share_revoked", {}, resolve, key[0]);
    return c.body(null, 204);
  }));

  const members = "/projects/:id/members/:member";
  routes.post(members + "/access", smallBody, (c) => owner(c, async ({ account, key, workspace, projectId, resolve }) => {
    const id = c.req.param("member")!;
    const member = uuid.test(id) ? await account.accounts.shares.accessMember(key, id) : null;
    if (!member) throw missingAccess();
    if (member.role !== "collaborator") throw new LinearError("Only collaborators need Linear access", 403);
    const { shares } = account.accounts;
    return addLinearAccess(c, {
      run: runLinear(account.tenant, workspace),
      workspace,
      project: projectId,
      identity: member,
      reserve: () => shares.reserveAccessInvite(key, id),
      release: (attempt) => shares.releaseAccessInvite(key, id, attempt),
      record(status) {
        if (status === "refused") telemetry?.emit("access_refused", {}, resolve, key[0]);
        else telemetry?.emit("access_added", { method: status }, resolve, key[0]);
      },
    });
  }));
  async function changeMember(c: Context, edit = false) {
    return owner(c, async ({ account, workspace, key, resolve }) => {
      const member = c.req.param("member")!;
      let role: MemberRole | undefined;
      if (edit) {
        const input = await c.req.json<{ role?: unknown }>().catch(() => null);
        if (input?.role !== "viewer" && input?.role !== "collaborator") throw new LinearError("Invalid member role", 400);
        role = input.role;
      }
      if (!uuid.test(member)) throw unavailable();
      const released = await account.accounts.shares.changeMemberWithClaims(key, member, role);
      if (!released) throw unavailable();
      await notice(account, workspace.id, key, released);
      if (!role) telemetry?.emit("member_removed", {}, resolve, key[0]);
      return c.body(null, 204);
    });
  }
  routes.patch(members, smallBody, (c) => changeMember(c, true));
  routes.delete(members, (c) => changeMember(c));

  routes.post("/join", smallBody, async (c) => {
    const account = await access(c);
    if (account instanceof Response) return account;
    const retry = await limit(account.session.id);
    if (retry > 0) {
      c.header("Retry-After", String(Math.ceil(retry / 1000)));
      return c.json({ error: "Too many join attempts" }, 429);
    }
    const input = await c.req.json<{ token?: unknown; confirm?: unknown }>().catch(() => null);
    if (typeof input?.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.token)) throw invalidLink();
    if (input.confirm !== true) {
      const preview = await account.accounts.shares.preview(input.token);
      if (!preview) throw invalidLink();
      return c.json(preview);
    }
    const result = await account.accounts.shares.join(account.tenant.id, input.token);
    if (!result) throw invalidLink();
    if (result === "full") return c.json({ error: "This project has reached its member limit" }, 409);
    const { share, project, role, changed } = result;
    if (changed) telemetry?.emit("member_joined", { role }, async () => {
      const current = await account.accounts.readTenant(share.tenant);
      const connection = current?.connections.find(({ id }) => id === share.connection);
      return current && connection ? accountUsage(current, connection) : null;
    }, share.tenant);
    return c.json({ project, role });
  });

  return routes;
}
