// The overview of all projects: one summary for each open project, made from its graph by the
// same rules as the Board. The server makes the summaries, so the page does not load each graph.
import { type Signal, boardGroups, buildGraph, parseStatus, projectGroups, statusTiming, yourMove } from "./graph.ts";
import { type Agents, type Ask, agentName, agentNeeds, agentsWaiting } from "./link.ts";
import type { GraphData, Project, ProjectList, PullRequest } from "./types.ts";

import { site, statusOrder } from "./site.ts";

/** The lamp of a project: its Linear status type. */
export const PROJECT_LAMP: Record<string, Signal> = { started: "running", paused: "stop", planned: "ready", backlog: "idle", completed: "done", canceled: "off" };

/** `updatedAt`: the last change of the issue, so the page can show how long the move waits. */
export interface YourMove { identifier: string; title: string; why: string; pullRequests: PullRequest[]; updatedAt: string }
export interface ProjectSummary {
  workspace: string; id: string;
  /** The issues that are not canceled, and how many of them are done. */
  planned: number; done: number;
  /** The number of issues of each status, in workflow order. */
  counts: { status: string; n: number; signal: Signal }[];
  /** The issues of the Board group "Your move", in run order. */
  you: YourMove[];
  running: number; review: number;
  /** Not started, and no blocker holds it back. */
  ready: number;
  /** What `wg next` last said about the effort, and when. */
  effort: { status: string; at: string | null } | null;
  freshness: { state: NonNullable<ReturnType<typeof statusTiming>>["state"]; ran: string | null } | null;
  /** The last change of an issue of the project. */
  updatedAt: string | null;
  /** The graph did not load. The other fields are empty. */
  error?: string;
}
export interface OverviewData extends ProjectList { summaries: ProjectSummary[] }

export function summarize(data: GraphData, workspace: string, now = Date.now()): ProjectSummary {
  const graph = buildGraph(data);
  const groups = new Map(boardGroups(graph).map((g) => [g.id, g.nodes]));
  const tally = new Map<string, { n: number; signal: Signal }>();
  for (const n of graph.nodes) tally.set(n.status, { n: (tally.get(n.status)?.n ?? 0) + 1, signal: n.signal });
  const counts = [...tally].map(([status, c]) => ({ status, ...c }))
    .sort((a, b) => statusOrder().indexOf(a.status) - statusOrder().indexOf(b.status));
  const effort = parseStatus(data.status?.content);
  const hasCards = graph.nodes.some((n) => n.card && !n.issue.external);
  const timing = hasCards ? statusTiming(effort, true, data.status?.updatedAt ?? null, now) : null;
  const updated = data.issues.map((i) => i.updatedAt).sort().at(-1) ?? null;
  return {
    workspace, id: data.project.id,
    planned: graph.nodes.filter((n) => n.status !== "Canceled").length,
    done: graph.nodes.filter((n) => n.status === "Done").length,
    counts,
    you: (groups.get("you") ?? []).map((n) => ({ identifier: n.issue.identifier, title: n.issue.title, why: yourMove(n.card?.next) ?? n.status, pullRequests: n.issue.pullRequests, updatedAt: n.issue.updatedAt })),
    running: groups.get("running")?.length ?? 0,
    review: groups.get("review")?.length ?? 0,
    ready: groups.get("next")?.length ?? 0,
    effort: effort ? { status: effort.status, at: effort.at ?? data.status?.updatedAt ?? null } : null,
    freshness: timing ? { state: timing.state, ran: effort?.ran ?? null } : null,
    updatedAt: updated,
  };
}

/** `initiative`: null shows every project; NO_INITIATIVE shows the projects with no initiative; a name shows that initiative. */
export interface OverviewFilter { text: string; workspace: string | null; mine: boolean; closed: boolean; initiative?: string | null }
export const NO_INITIATIVE = "";
export interface OverviewRow { project: Project & { workspace: string; workspaceName: string }; summary: ProjectSummary | null }

export const summaryKey = (p: { workspace?: string; id: string }) => `${p.workspace ?? site.defaultWorkspace}:${p.id}`;

/**
 * The rows of the overview: the projects that pass the filter. Projects that wait on the human come
 * first (more waiting issues first), then projects with work that runs, then the order of `projectGroups`.
 */
export function overviewRows(list: OverviewData | ProjectList, filter: OverviewFilter): OverviewRow[] {
  const summaries = new Map(("summaries" in list ? list.summaries : []).map((s) => [summaryKey(s), s]));
  const { open, closed } = projectGroups(list.projects);
  const words = filter.text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const order = new Map([...open, ...closed].map((p, at) => [summaryKey(p), at]));
  return [...open, ...(filter.closed ? closed : [])]
    .map((p) => ({ project: p as OverviewRow["project"], summary: summaries.get(summaryKey(p)) ?? null }))
    .filter(({ project, summary }) => (!filter.workspace || project.workspace === filter.workspace)
      && (!filter.mine || (summary?.you.length ?? 0) > 0)
      && (filter.initiative == null || (project.initiative ?? NO_INITIATIVE).toLowerCase() === filter.initiative.toLowerCase())
      && words.every((w) => `${project.name} ${project.workspaceName} ${project.initiative ?? ""}`.toLowerCase().includes(w)))
    .sort((a, b) => (b.summary?.you.length ?? 0) - (a.summary?.you.length ?? 0)
      || Number((b.summary?.running ?? 0) > 0) - Number((a.summary?.running ?? 0) > 0)
      || order.get(summaryKey(a.project))! - order.get(summaryKey(b.project))!);
}

/**
 * The moves of a project with the open questions of its workers (from the link) added. A question is a
 * move of the human's: the worker waits on the reply. Questions come first; a move whose worker also
 * asks says so. Each issue counts once.
 */
/** What an open ask of a worker is: a question, or an escalation that no coordinator read. */
const askVerb = (a: Ask) => (a.kind === "escalation" ? "Worker escalates" : "Worker asks");

export function movesWithAsks(you: YourMove[], asks: Ask[] | undefined): YourMove[] {
  if (!asks?.length) return you;
  const asked = new Set(asks.map((a) => a.issue ?? "worker"));
  const extra: YourMove[] = [];
  for (const a of asks) {
    const id = a.issue ?? "worker";
    if (you.some((m) => m.identifier === id) || extra.some((m) => m.identifier === id)) continue;
    extra.push({ identifier: id, title: a.body.split("\n")[0].trim(), why: `${askVerb(a)}:`, pullRequests: [], updatedAt: a.at });
  }
  const verb = (id: string) => askVerb(asks.find((a) => (a.issue ?? "worker") === id)!);
  return [...extra, ...you.map((m) => (asked.has(m.identifier) ? { ...m, why: `${verb(m.identifier)} · ${m.why}` } : m))];
}

/**
 * The moves of a project with its agents that wait on the human added (`wg agents`): an agent at a prompt
 * stops until the human answers it in Orca. They come first. A worker's move names its issue, so an issue
 * that is in the list keeps one entry and says that its worker waits.
 */
export function movesWithAgents(you: YourMove[], agents: Agents | undefined, now: number): YourMove[] {
  const waiting = agentsWaiting(agents, now);
  if (!waiting.length) return you;
  const byIssue = new Map(waiting.flatMap((a) => (a.issue ? [[a.issue, a] as const] : [])));
  const extra: YourMove[] = waiting.filter((a) => !a.issue || !you.some((m) => m.identifier === a.issue))
    .map((a) => ({ identifier: agentName(a), title: a.said || a.title, why: `Agent ${agentNeeds(a)} in Orca:`, pullRequests: [], updatedAt: a.at ?? agents!.at }));
  return [...extra, ...you.map((m) => (byIssue.has(m.identifier) ? { ...m, why: `Agent ${agentNeeds(byIssue.get(m.identifier)!)} · ${m.why}` } : m))];
}

/** The projects of one initiative in one workspace, and the sums of their summaries. `name` null: no initiative. */
export interface InitiativeSection {
  key: string; workspace: string; workspaceName: string; name: string | null; rows: OverviewRow[];
  projects: number; planned: number; done: number; you: number; running: number;
}

/**
 * The overview rows in one section for each initiative of each workspace. Workspaces keep the order of
 * `workspaces`. Inside a workspace, initiatives that wait on the human come first, then those with work
 * that runs, then by name; the projects with no initiative come last. Rows keep their order.
 */
export function initiativeSections(rows: OverviewRow[], workspaces: { id: string }[]): InitiativeSection[] {
  const sections = new Map<string, InitiativeSection>();
  for (const row of rows) {
    const { workspace, workspaceName } = row.project;
    const name = row.project.initiative ?? null;
    const key = `${workspace}:${name ?? ""}`;
    let section = sections.get(key);
    if (!section) sections.set(key, section = { key, workspace, workspaceName, name, rows: [], projects: 0, planned: 0, done: 0, you: 0, running: 0 });
    section.rows.push(row);
    section.projects++;
    section.planned += row.summary?.planned ?? 0;
    section.done += row.summary?.done ?? 0;
    section.you += row.summary?.you.length ?? 0;
    section.running += row.summary?.running ?? 0;
  }
  const rank = new Map(workspaces.map((w, at) => [w.id, at]));
  return [...sections.values()].sort((a, b) => (rank.get(a.workspace) ?? 99) - (rank.get(b.workspace) ?? 99)
    || Number(a.name === null) - Number(b.name === null)
    || b.you - a.you
    || Number(b.running > 0) - Number(a.running > 0)
    || (a.name ?? "").localeCompare(b.name ?? ""));
}

/** The initiatives of the listed projects, by name, each once. */
export function initiativeNames(projects: Project[]): string[] {
  return [...new Set(projects.map((p) => p.initiative).filter((n): n is string => !!n))].sort((a, b) => a.localeCompare(b));
}
