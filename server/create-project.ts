import { createHash } from "node:crypto";
import { CARD_PREFIX, gql, LinearError } from "./linear.ts";
import type { Workspace } from "./workspaces.ts";

type Input = { name: string; firstTask: string; team: string };
type Team = { id: string; key: string; name: string; viewer: string; ready: string; todo: string };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export function creationInput(value: unknown, workspace: Workspace, key: string | undefined): Input {
  const clean = (s: unknown): s is string => typeof s === "string" && !!s && s === s.trim()
    && s.length <= 120 && !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(s);
  const body = value as Partial<Input> | null;
  if (!clean(body?.name) || !clean(body?.team)) {
    throw new LinearError("Supply a team and project name of 1 to 120 characters", 400);
  }
  const task = body.firstTask;
  if (typeof task !== "string" || task !== task.trim() || task.length > 10000 ||
      !clean(task.split(/\r?\n/, 1)[0].trimEnd()) ||
      /[\u0000-\u0008\u000b-\u001f\u007f\ud800-\udfff]/u.test(task.replaceAll("\r\n", "\n"))) {
    throw new LinearError("Use up to 120 characters for the first task title and 10000 for the full task", 400);
  }
  if (workspace.team !== body.team) throw new LinearError("Team is outside the configured workspace filter", 403);
  if (key !== digest(JSON.stringify([workspace.id, body.team, body.name, task]))) {
    throw new LinearError("Idempotency-Key does not match the creation input", 409);
  }
  return { name: body.name, firstTask: task, team: body.team };
}

export async function starterTeam(workspace: Workspace): Promise<Team | null> {
  if (!/^[A-Z][A-Z0-9]{0,9}$/.test(workspace.team) || !/^[a-z0-9-]+$/.test(workspace.id) || workspace.needsKey || !workspace.key) return null;
  const { organization, viewer } = await gql(`query StarterTeam($key:String!){
    organization{id} viewer{id teams(first:1,filter:{key:{eq:$key}}){nodes{id key name
      states(first:2,filter:{name:{in:["Ready","Todo"]}}){nodes{id name}}}}}}`, { key: workspace.team });
  if (workspace.organizationId && workspace.organizationId !== organization.id) return null;
  const team = viewer.teams.nodes[0];
  if (!team || team.key !== workspace.team) return null;
  const state = (name: string) => team.states.nodes.find((s: { name: string }) => s.name === name)?.id;
  const ready = state("Ready"), todo = state("Todo");
  return ready && todo ? { id: team.id, key: team.key, name: team.name, viewer: viewer.id, ready, todo } : null;
}

// Linear enforces the supplied UUID on every create. If another request won or
// a response was lost, read that exact object back before advancing the graph.
async function ensure(query: typeof gql, entity: string, fields: string, input: Record<string, unknown> & { id: string }) {
  const type = entity[0].toUpperCase() + entity.slice(1);
  try {
    const { result } = await query(`mutation($input:${type}CreateInput!){
      result: ${entity}Create(input:$input){success object:${entity}{${fields}}}}`, { input });
    if (!result?.success || result.object?.id !== input.id) throw new LinearError("Incomplete Linear creation response");
    return result.object;
  } catch (error) {
    const found = await query(`query($id:String!){result: ${entity}(id:$id){${fields}}}`, { id: input.id }).catch(() => null);
    if (found?.result?.id !== input.id) throw error;
    return found.result;
  }
}

export async function createStarter(workspace: Workspace, team: Team, input: Input, actor: string, key: string, query = gql) {
  const id = (part: string) => {
    const hex = digest(JSON.stringify(["work-graph starter v1", actor, team.id, key, part]));
    return [hex.slice(0, 8), hex.slice(8, 12), "4" + hex.slice(13, 16), "8" + hex.slice(17, 20), hex.slice(20, 32)].join("-");
  };
  const project = await ensure(query, "project", "id url teams(first:2){nodes{id}}", { id: id("project"), name: input.name, teamIds: [team.id] });
  if (project.teams.nodes.length !== 1 || project.teams.nodes[0].id !== team.id) {
    throw new LinearError("Project team changed since creation", 409);
  }
  const milestone = await ensure(query, "projectMilestone", "id project{id}", { id: id("phase"), name: "Initial phase",
    projectId: project.id, description: "target main" });
  if (milestone.project.id !== project.id) throw new LinearError("Milestone belongs to a different project", 409);
  const [firstLine, ...detailLines] = input.firstTask.split(/\r?\n/);
  const description = detailLines.join("\n");
  const plan = {
    effort: { name: input.name, slug: "project-" + project.id, workspace: workspace.id, team: team.key },
    phases: [{ key: "1", name: "Initial phase", target: "main" }],
    nodes: [
      { key: "first", kind: "task", phase: "1", lane: "core", title: firstLine.trimEnd(), description: description || undefined },
      { key: "merge", kind: "merge-point", phase: "1", title: "Merge the first task" },
      { key: "ship", kind: "ship-point", phase: "1", title: "Verify the first release" },
    ],
    edges: [{ from: "merge", to: "first" }, { from: "ship", to: "merge" }],
  };
  const nodes: Record<string, { id: string; identifier: string; card: { id: string } }> = {};
  for (const [index, node] of plan.nodes.entries()) {
    const { title, description, ...data } = node;
    const marker = Object.entries(data).map(([field, value]) => (field === "key" ? "" : field + " ") + "`" + value + "`").join(" · ");
    const issue = await ensure(query, "issue", "id identifier project{id} team{id}", { id: id(node.key), title,
      description: [description, "+++ Agent notes\n\nwork-graph node " + marker + "\n\n+++"].filter(Boolean).join("\n\n"),
      teamId: team.id, projectId: project.id, projectMilestoneId: milestone.id, assigneeId: team.viewer,
      preserveSortOrderOnCreate: true, sortOrder: (index + 1) * 100, stateId: index === 0 ? team.ready : team.todo });
    if (issue.project?.id !== project.id || issue.team.id !== team.id) throw new LinearError("Issue moved outside the project", 409);
    const body = [CARD_PREFIX + " " + marker, "```json\n" + JSON.stringify({ wg: 1, ...data }) + "\n```",
      "Generated from plan.json by `wg load`. Change plan.json, not this comment."].join("\n\n");
    const card = await ensure(query, "comment", "id issue{id}", { id: id(node.key + "-card"), issueId: issue.id, body });
    if (card.issue?.id !== issue.id) throw new LinearError("Card belongs to a different issue", 409);
    nodes[node.key] = { id: issue.id, identifier: issue.identifier, card: { id: card.id } };
  }
  for (const edge of plan.edges) {
    const blocker = nodes[edge.to].id, blocked = nodes[edge.from].id;
    const relation = await ensure(query, "issueRelation", "id type issue{id} relatedIssue{id}", {
      id: id(edge.from + "-edge"), issueId: blocker, relatedIssueId: blocked, type: "blocks" });
    if (relation.type !== "blocks" || relation.issue.id !== blocker || relation.relatedIssue.id !== blocked) {
      throw new LinearError("Dependency changed since creation", 409);
    }
  }
  return { plan, keymap: { project: { id: project.id, url: project.url }, milestones: { "1": milestone.id }, nodes } };
}
