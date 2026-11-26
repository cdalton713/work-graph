import { Hono, type Context } from "hono";
import { gql, LinearAccessRefused, LinearError, LinearKeyRequired } from "./linear.ts";
import { LinearSignInRequired } from "./linearauth.ts";
import type { createAccounts } from "./db/accounts.ts";
import type { LinearIdentity } from "./db/shares.ts";
import type { Telemetry, UsageScope } from "./telemetry.ts";
import type { Workspace } from "./workspaces.ts";

export type InWorkspace = <T>(run: () => Promise<T>) => Promise<T>;

export const missingAccess = () => new LinearError("Project access not found", 404);

async function projectTeam(run: InWorkspace, workspace: Workspace, id: string) {
  const data = await run(() => gql(`query ProjectAccessTeam($id:String!, $key:String!) {
    organization { id name urlKey }
    project(id:$id) { id teams(first:1, filter:{key:{eq:$key}}) { nodes { id key } } }
  }`, { id, key: workspace.team }));
  const team = data.project?.teams?.nodes[0] as { id: string; key: string } | undefined;
  const organization = data.organization as { id: string; name: string; urlKey: string } | undefined;
  if (data.project?.id !== id || !team || team.key !== workspace.team || !organization || organization.id !== workspace.organizationId) {
    throw missingAccess();
  }
  return { team, organization };
}

async function workspaceMember(identity: LinearIdentity, organization: string) {
  const data = identity.linearOrgId === organization
    ? await gql(`query AccessWorkspaceUser($id:ID!) {
        users(first:1, includeDisabled:true, filter:{id:{eq:$id}}) { nodes { id active } }
      }`, { id: identity.linearUserId })
    : await gql(`query AccessWorkspaceMember($email:String!) {
        users(first:2, includeDisabled:true, filter:{email:{eqIgnoreCase:$email}}) { nodes { id active } }
      }`, { email: identity.email });
  const users = data.users.nodes as { id: string; active: boolean }[];
  if (users.length > 1) throw new LinearError("Linear returned more than one user with this email", 409);
  return users[0];
}

async function onTeam(user: string, team: string) {
  const data = await gql(`query AccessTeamMember($team:String!, $user:ID!) {
    team(id:$team) { members(first:1, filter:{id:{eq:$user}}) { nodes { id } } }
  }`, { team, user }, { manageAccess: true });
  return data.team.members.nodes[0]?.id === user;
}

async function pendingInvite(email: string) {
  type Invite = { email: string; createdAt?: string; expiresAt: string | null; acceptedAt: string | null };
  let after: string | null = null;
  do {
    const data = await gql(`query AccessPendingInvites($after:String) {
      organizationInvites(first:100, after:$after) {
        nodes { email createdAt expiresAt acceptedAt }
        pageInfo { hasNextPage endCursor }
      }
    }`, { after }, { manageAccess: true });
    const { nodes, pageInfo } = data.organizationInvites as {
      nodes: Invite[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
    const invite = nodes.find((invite) => !invite.acceptedAt &&
      (!invite.expiresAt || Date.parse(invite.expiresAt) > Date.now()) &&
      invite.email.toLowerCase() === email.toLowerCase());
    if (invite) return invite;
    after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
  } while (after);
}

type MemberAccess = {
  shares: ReturnType<typeof createAccounts>["shares"];
  project: [string, string, string];
  membership: string;
  identity: LinearIdentity;
  workspace: Workspace;
  ownRun?: InWorkspace;
  ownerRun: InWorkspace;
  usage: () => Promise<UsageScope | null>;
};

export function memberAccessRoutes(access: (c: Context) => Promise<MemberAccess | Response>,
  telemetry?: Telemetry | null, now = Date.now) {
  const routes = new Hono();
  const base = "/projects/:id/access";
  const ownerReads = new Map<string, { expires: number; read: Promise<unknown> }>();

  function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const entry = ownerReads.get(key);
    if (entry && entry.expires > now()) return entry.read as Promise<T>;
    ownerReads.delete(key);
    if (ownerReads.size >= 256) ownerReads.delete(ownerReads.keys().next().value!);
    const read = load().catch((error) => {
      if (ownerReads.get(key)?.read === read) ownerReads.delete(key);
      throw error;
    });
    ownerReads.set(key, { expires: now() + 60_000, read });
    return read;
  }

  routes.get(base, async (c) => {
    const target = await access(c);
    if (target instanceof Response) return target;
    const { shares, project, membership, identity, workspace, ownerRun, ownRun } = target;
    const key = JSON.stringify([membership, workspace.team, identity.linearOrgId, identity.linearUserId, identity.email]);
    const { team, organization } = await cached("team:" + key, () => projectTeam(ownerRun, workspace, project[2]));
    const answer = async (status: "ok" | "no_connection" | "no_team" | "not_member") =>
      c.json({
        status, workspace: organization.name, team: team.key,
        accessRequestedAt: status === "ok" ? null : await shares.accessRequestedAt(project, membership),
      });
    if (ownRun) {
      try {
        const data = await ownRun(() => gql(`query CheckProjectAccess($team:ID!, $project:ID!) {
          organization { id }
          teams(first:1, filter:{id:{eq:$team}}) { nodes { id } }
          projects(first:1, filter:{id:{eq:$project}}) { nodes { id } }
        }`, { team: team.id, project: project[2] }));
        if (data.organization?.id === organization.id) {
          if (data.teams.nodes[0]?.id !== team.id || data.projects.nodes[0]?.id !== project[2]) return answer("no_team");
          await shares.clearAccessRequest(project, membership);
          return answer("ok");
        }
      } catch (error) {
        if (!(error instanceof LinearSignInRequired || error instanceof LinearKeyRequired)) throw error;
      }
    }
    const member = await cached("member:" + key, () => ownerRun(() => workspaceMember(identity, organization.id)));
    return answer(member?.active ? "no_connection" : "not_member");
  });

  routes.post(base + "/request", async (c) => {
    const target = await access(c);
    if (target instanceof Response) return target;
    const { shares, project, membership, usage } = target;
    const result = await shares.requestAccess(project, membership);
    if (result === "missing") throw missingAccess();
    if (result === "limited") {
      c.header("Retry-After", "600");
      return c.json({ error: "Wait ten minutes between access requests" }, 429);
    }
    telemetry?.emit("access_requested", {}, usage, project[0]);
    return c.body(null, 204);
  });

  return routes;
}

type AddAccess = {
  run: InWorkspace;
  workspace: Workspace;
  project: string;
  identity: LinearIdentity;
  reserve: () => Promise<string | undefined>;
  release: (attempt: string) => Promise<void>;
  record: (status: "added" | "invited" | "refused") => void;
};

export async function addLinearAccess(c: Context, { run, workspace, project, identity, reserve, release, record }: AddAccess) {
  const input = await c.req.json<{ invite?: unknown }>().catch(() => null);
  const confirmed = input?.invite === true;
  const attempt = confirmed ? await reserve() : undefined;
  if (confirmed && !attempt) {
    c.header("Retry-After", "600");
    return c.json({ error: "Wait ten minutes between invitations", team: workspace.team }, 429);
  }
  let invited = false;
  try {
    const { team, organization } = await projectTeam(run, workspace, project);
    return await grantAccess(c, { run, identity, confirmed, team, organization }, (status) => {
      invited = status === "invited";
      record(status);
    });
  } catch (error) {
    if (error instanceof LinearError && error.status === 502) throw new LinearError("Linear request failed");
    throw error;
  } finally {
    if (attempt && !invited) await release(attempt);
  }
}

type ProjectTeam = Awaited<ReturnType<typeof projectTeam>>;

async function grantAccess(c: Context, { run, identity, confirmed, team, organization }: ProjectTeam & {
  run: InWorkspace;
  identity: LinearIdentity;
  confirmed: boolean;
}, record: AddAccess["record"]) {
  try {
    const member = await run(() => workspaceMember(identity, organization.id));
    if (member && !member.active) return c.json({ error: "This Linear workspace member is inactive", team: team.key }, 409);
    if (member) {
      if (await run(() => onTeam(member.id, team.id))) return c.json({ status: "already_member", team: team.key });
    } else {
      if (identity.linearOrgId === organization.id) throw missingAccess();
      const pending = await run(() => pendingInvite(identity.email));
      if (pending) return c.json({ status: "invite_pending", team: team.key, invitedAt: pending.createdAt });
      if (!confirmed) return c.json({ error: "Confirm the workspace invitation", status: "invite_required", team: team.key }, 409);
    }
    const method = member ? "added" : "invited";
    const success = await run(async () => {
      if (member) {
        const data = await gql(`mutation AddTeamAccess($input:TeamMembershipCreateInput!) {
          teamMembershipCreate(input:$input) { success }
        }`, { input: { userId: member.id, teamId: team.id } }, { manageAccess: true });
        return data.teamMembershipCreate?.success === true;
      }
      const data = await gql(`mutation InviteProjectMember($input:OrganizationInviteCreateInput!) {
        organizationInviteCreate(input:$input) { success }
      }`, { input: { email: identity.email, teamIds: [team.id], role: "user" } }, { manageAccess: true });
      return data.organizationInviteCreate?.success === true;
    });
    if (!success) throw new LinearError("Linear request failed");
    record(method);
    return c.json({ status: method, team: team.key });
  } catch (error) {
    if (!(error instanceof LinearAccessRefused)) throw error;
    record("refused");
    return c.json({ error: error.message, team: team.key,
      settingsUrl: `https://linear.app/${encodeURIComponent(organization.urlKey)}/settings/teams/${encodeURIComponent(team.key)}/members` }, 403);
  }
}
