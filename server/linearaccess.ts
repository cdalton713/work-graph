import { Hono, type Context } from "hono";
import { gql, LinearAccessRefused, LinearError, LinearKeyRequired } from "./linear.ts";
import { LinearSignInRequired } from "./linearauth.ts";
import type { createAccounts } from "./db/accounts.ts";
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

async function workspaceMember(email: string) {
  const data = await gql(`query AccessWorkspaceMember($email:String!) {
    users(first:2, includeDisabled:true, filter:{email:{eqIgnoreCase:$email}}) { nodes { id active } }
  }`, { email });
  const users = data.users.nodes as { id: string; active: boolean }[];
  if (users.length > 1) throw new LinearError("Linear returned more than one user with this email", 409);
  return users[0];
}

type MemberAccess = {
  shares: ReturnType<typeof createAccounts>["shares"];
  project: [string, string, string];
  membership: string;
  email: string;
  workspace: Workspace;
  ownRun?: InWorkspace;
  ownerRun: InWorkspace;
  usage: () => Promise<UsageScope | null>;
};

export function memberAccessRoutes(access: (c: Context) => Promise<MemberAccess | Response>, telemetry?: Telemetry | null) {
  const routes = new Hono();
  const base = "/projects/:id/access";
  routes.get(base, async (c) => {
    const target = await access(c);
    if (target instanceof Response) return target;
    const { shares, project, membership, email, workspace, ownerRun, ownRun } = target;
    const { team, organization } = await projectTeam(ownerRun, workspace, project[2]);
    const answer = (status: "ok" | "no_connection" | "no_team" | "not_member") =>
      c.json({ status, workspace: organization.name, team: team.key });
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
    const member = await ownerRun(() => workspaceMember(email));
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

export async function addLinearAccess(c: Context, run: InWorkspace, workspace: Workspace, project: string,
  email: string, record: (status: "added" | "invited" | "refused") => void) {
  const { team, organization } = await projectTeam(run, workspace, project);
  const input = await c.req.json<{ invite?: unknown }>().catch(() => null);
  try {
    const member = await run(() => workspaceMember(email));
    if (member && !member.active) throw new LinearAccessRefused("This Linear workspace member is inactive");
    if (!member && input?.invite !== true) {
      return c.json({ error: "Confirm the workspace invitation", status: "invite_required" }, 409);
    }
    const method = member ? "added" : "invited";
    const success = await run(async () => {
      if (member) {
        const data = await gql(`mutation AddTeamAccess($input:TeamMembershipCreateInput!) {
          teamMembershipCreate(input:$input) { success }
        }`, { input: { userId: member.id, teamId: team.id } }, { accessMutation: true });
        return data.teamMembershipCreate?.success === true;
      }
      const data = await gql(`mutation InviteProjectMember($input:OrganizationInviteCreateInput!) {
        organizationInviteCreate(input:$input) { success }
      }`, { input: { email, teamIds: [team.id], role: "user" } }, { accessMutation: true });
      return data.organizationInviteCreate?.success === true;
    });
    if (!success) throw new LinearAccessRefused("Linear refused the access change");
    record(method);
    return c.json({ status: method });
  } catch (error) {
    if (!(error instanceof LinearAccessRefused)) throw error;
    record("refused");
    return c.json({ error: error.message,
      settingsUrl: `https://linear.app/${encodeURIComponent(organization.urlKey)}/settings/teams/${encodeURIComponent(team.key)}/members` }, 403);
  }
}
