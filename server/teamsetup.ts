import contract from "../skills/work-graph/contract.json" with { type: "json" };
import type { SetupItem, SetupTeam, SetupTeamInput, TeamSetupResult, TeamSetupState } from "../src/lib/types.ts";
import { gql, LinearAccessRefused, LinearError, pages } from "./linear.ts";

interface LinearTeam {
  id: string;
  name: string;
  key: string;
  visibility: string;
  parent: SetupTeam["parent"];
  triageEnabled: boolean;
}

const setupQuery = (query: string, variables: Record<string, unknown> = {}) => gql(query, variables, { teamSetup: true });

export class PrivateTeamFailed extends Error {
  readonly team: SetupTeam;
  constructor(message: string, team: LinearTeam) {
    super(message);
    this.team = summary(team);
  }
}

async function findTeam(key: string): Promise<LinearTeam | undefined> {
  const data = await setupQuery(`query($key:String!){teams(filter:{key:{eq:$key}}){
    nodes{id key name visibility parent{key name} triageEnabled}}}`, { key });
  return data.teams.nodes[0];
}

function summary(team: LinearTeam): SetupTeam {
  return { key: team.key, name: team.name, private: team.visibility === "private", parent: team.parent ?? null };
}

async function updateTeam(id: string, i: object) {
  const result = await setupQuery("mutation($id:String!,$i:TeamUpdateInput!){teamUpdate(id:$id,input:$i){success}}", { id, i });
  if (!result.teamUpdate.success) throw new LinearError("Team update failed");
}

export async function createSetupTeam(input: SetupTeamInput) {
  let team = await findTeam(input.key);
  if (team) {
    if (team.name !== input.name || (team.parent?.key ?? null) !== (input.parent ?? null)) {
      throw new LinearError("A team with this key has a different name or parent", 409);
    }
    if (input.private && team.visibility !== "private") {
      const { team: contents } = await setupQuery(`query($id:String!){team(id:$id){
        issues(first:1,includeArchived:true){nodes{id}} projects(first:1,includeArchived:true){nodes{id}}}}`, { id: team.id });
      if (contents.issues.nodes.length || contents.projects.nodes.length) {
        throw new LinearError("This team already contains issues or projects. Check its visibility in Linear.", 409);
      }
    }
  } else {
    const parent = input.parent ? await findTeam(input.parent) : undefined;
    if (input.parent && !parent) throw new LinearError("Parent team not found", 404);
    const { teamCreate } = await setupQuery(`mutation($i:TeamCreateInput!){teamCreate(input:$i){
      success team{id key name visibility parent{key name} triageEnabled}}}`, {
      i: { key: input.key, name: input.name, ...(parent && { parentId: parent.id }) },
    });
    if (!teamCreate.success || !teamCreate.team?.id) throw new Error("Team creation failed");
    team = teamCreate.team as LinearTeam;
  }
  const setPrivate = input.private && team.visibility !== "private";
  let saved: LinearTeam | undefined;
  try {
    if (setPrivate) await updateTeam(team.id, { private: true });
    saved = await findTeam(input.key);
  } catch (error) {
    if (setPrivate && (error instanceof LinearAccessRefused || (error instanceof LinearError && error.status === 502))) {
      throw new PrivateTeamFailed("The team exists. Linear did not confirm private visibility: " + error.message, team);
    }
    throw error;
  }
  if (setPrivate && (saved?.id !== team.id || saved.visibility !== "private")) {
    throw new PrivateTeamFailed("Linear did not confirm private visibility for the team.", saved?.id === team.id ? saved : team);
  }
  if (!saved || saved.id !== team.id || summary(saved).private !== input.private ||
      saved.name !== input.name || (saved.parent?.key ?? null) !== (input.parent ?? null)) {
    throw new Error("Could not verify the requested team");
  }
  return summary(saved);
}

type LabelKind = "issueLabel" | "projectLabel";
interface LabelRow {
  id: string; name: string; isGroup: boolean; groupType: string | null; retiredAt: string | null;
  parent: { id: string } | null; team: { id: string } | null;
}

async function labels(kind: LabelKind, teamId: string | null) {
  const field = kind + "s";
  const filter = kind === "issueLabel" ? "IssueLabelFilter" : "ProjectLabelFilter";
  return pages<LabelRow>(`query($f:${filter}!,$after:String){${field}(filter:$f,first:100,after:$after){
    nodes{id name isGroup groupType retiredAt parent{id} team{id}} pageInfo{hasNextPage endCursor}}}`,
    { f: { team: teamId ? { id: { eq: teamId } } : { null: true } } }, data => data[field], { teamSetup: true });
}

async function createItem(kind: LabelKind | "workflowState", i: object): Promise<string> {
  const input = kind[0].toUpperCase() + kind.slice(1) + "CreateInput";
  const field = kind + "Create";
  const data = await setupQuery(`mutation($i:${input}!){${field}(input:$i){success ${kind}{id}}}`, { i });
  if (!data[field]?.success || !data[field][kind]?.id) throw new Error("Item creation failed");
  return data[field][kind].id;
}

export function setupCommand(workspace: string, key: string, team: SetupTeamInput | null) {
  const quote = (value: string) => /^[a-z0-9_-]+$/i.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'";
  return `wg setup --workspace ${quote(workspace)} --team ${quote(key)} --name=${quote(team?.name ?? key)}` +
    (team?.private ? " --private" : "") + (team?.parent ? " --parent " + quote(team.parent) : "") + " --apply";
}

export async function teamSetup(key: string, human: string, teamLabels: boolean, apply: boolean, workspace: string): Promise<TeamSetupResult> {
  const team = await findTeam(key);
  if (apply && !team) throw new LinearError("Team not found", 404);
  const { organization } = await setupQuery("query { organization { subscription { type } } }");
  const business = /^(business|enterprise)(?:[_-]|$)/i.test(organization.subscription?.type ?? "");
  const state: TeamSetupState = { team: team ? summary(team) : null, plan: { privateTeams: business, subTeams: business },
    fallback: setupCommand(workspace, key, team ? { ...summary(team), parent: team.parent?.key } : null), statuses: [], labels: [] };
  const created: string[] = [];
  const readStates = (id: string) => pages<{ name: string; type: string }>(`query($id:String!,$after:String){
    team(id:$id){states(first:100,after:$after){nodes{name type} pageInfo{hasNextPage endCursor}}}}`,
    { id }, data => data.team.states, { teamSetup: true });
  let states = team ? await readStates(team.id) : [];
  for (const { name: template, type } of contract.setup.statuses) {
    const name = template.replace("{name}", () => human);
    if (apply && team && type === "triage" && !team.triageEnabled &&
        !states.some(s => s.type === type || s.name.toLowerCase() === name.toLowerCase())) {
      await updateTeam(team.id, { triageEnabled: true });
      states = await readStates(team.id);
      if (states.some(s => s.name === name && s.type === type)) created.push(name);
    }
    const found = states.find(s => s.name === name) ?? states.find(s => s.name.toLowerCase() === name.toLowerCase());
    let status: SetupItem["state"] = "missing";
    let detail: string | undefined;
    if (found) {
      if (found.name !== name) detail = `Exists as "${found.name}". Rename it in Linear.`;
      else if (found.type !== type) detail = `Type is ${found.type}. Expected ${type}.`;
      status = detail ? "warn" : "exists";
    } else if (team && (type === "triage" || type === "duplicate")) {
      status = "warn";
      detail = "Linear manages this status. Check the team workflow in Linear.";
    } else if (apply && team) {
      await createItem("workflowState", { name, type, teamId: team.id, color: "#5E6AD2" });
      status = "exists";
      created.push(name);
    }
    state.statuses.push({ name, type, state: status, detail });
  }
  for (const kind of ["issueLabel", "projectLabel"] as const) {
    const rows = team ? [...await labels(kind, null), ...await labels(kind, team.id)] : [];
    async function ensure(name: string, scoped: boolean, group: boolean, parentId: string | null, parentName?: string) {
      const scope = kind === "projectLabel" ? "project" : scoped ? "team" : "workspace";
      const item = { name, scope, group: parentName } as const;
      const teamId = scoped ? team?.id : null;
      const located = (r: LabelRow) => (r.team?.id ?? null) === teamId && (r.parent?.id ?? null) === parentId;
      const named = rows.filter(r => r.name.toLowerCase() === name.toLowerCase());
      const found = named.find(r => located(r) && r.name === name) ?? named.find(located) ?? named[0];
      if (found) {
        const ok = located(found) && found.name === name && !found.retiredAt && found.isGroup === group &&
          (!group || found.groupType === "singleSelect");
        state.labels.push({ ...item, state: ok ? "exists" : "warn",
          detail: ok ? undefined : `Check the name, scope, group and availability of "${found.name}" in Linear.` });
        return ok ? found.id : null;
      }
      const id = apply ? await createItem(kind, { name, ...(teamId && { teamId }), ...(parentId && { parentId }),
        ...(group && { isGroup: true, groupType: "singleSelect" }) }) : null;
      if (id) created.push(name);
      state.labels.push({ ...item, state: id ? "exists" : "missing" });
      return id;
    }
    const spec = contract.setup;
    const issue = kind === "issueLabel";
    for (const name of issue ? spec.team_issue_labels : spec.project_labels) {
      await ensure(name, issue || teamLabels, false, null);
    }
    const groups = issue ? spec.workspace_label_groups : spec.project_label_groups;
    for (const [name, children] of Object.entries(groups)) {
      const scoped = !issue && teamLabels;
      const id = await ensure(name, scoped, true, null);
      const parent = state.labels.at(-1)!;
      for (const child of children) {
        if (id) await ensure(child, scoped, false, id, name);
        else state.labels.push({ name: child, scope: parent.scope, group: name, state: parent.state, detail: parent.detail });
      }
    }
  }
  const warned = [...state.statuses, ...state.labels].filter(item => item.state === "warn").map(item => item.name);
  return { created, warned, state };
}
