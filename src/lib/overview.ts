// The overview of all projects: one summary for each open project, made from its graph by the
// same rules as the Board. The server makes the summaries, so the page does not load each graph.
import { summaryWords } from "./words.ts";
import { type MoveRank, type Signal, boardGroups, buildGraph, isClosed, moveImpact, parseStatus, projectGroups, statusName, statusTiming, yourMove } from "./graph.ts";
import { type Agents, type Ask, type Presence, agentName, agentNeeds, agentsWaiting } from "./link.ts";
import type { GraphData, Project, ProjectList, PullRequest } from "./types.ts";

import { currentSite, statusOrder } from "./site.ts";
import { PROJECT_STATES, type ProjectState, type ProjectStateName, type Stall, projectState, stalls } from "./attention.ts";

export { rankMoves } from "./graph.ts";
export { overviewMoveReason } from "./words.ts";

/** The lamp of a project: its Linear status type. */
export const PROJECT_LAMP: Record<string, Signal> = { started: "running", paused: "stop", planned: "ready", backlog: "idle", completed: "done", canceled: "off" };

/** `updatedAt`: the last change of the issue, so the page can show how long the move waits. */
export interface YourMove extends MoveRank { identifier: string; title: string; why: string; pullRequests: PullRequest[]; unblocks?: number }
type MoveImpacts = Record<string, ReturnType<typeof moveImpact>>;

export interface ProjectSummary {
  workspace: string; id: string;
  /** The issues that are not canceled, and how many of them are done. */
  planned: number; done: number;
  /** The number of issues of each status, in workflow order. */
  counts: { status: string; n: number; signal: Signal }[];
  /** The issues of the Board group "Your move", by impact. */
  you: YourMove[];
  /** Impact for other issues that can enter the inbox through live questions or prompts. */
  moveImpacts?: MoveImpacts;
  running: number; review: number;
  /** Not started, and no blocker holds it back. */
  ready: number;
  paused?: boolean;
  externalBlocker?: string;
  collaborator?: string;
  liveJobs?: { identifier: string; title: string; state: string; startedAt: string | null }[];
  nextLines?: NonNullable<ReturnType<typeof parseStatus>>["lines"];
  /** What `wg next` last said about the effort, and when. */
  effort: { status: string; at: string | null } | null;
  freshness: { state: NonNullable<ReturnType<typeof statusTiming>>["state"]; ran: string | null } | null;
  /** The last change of an issue of the project. */
  updatedAt: string | null;
  /** The graph did not load. The other fields are empty. */
  error?: string;
}
export interface OverviewData extends ProjectList { summaries: ProjectSummary[] }

export function summarize(data: GraphData, workspace: string, now = Date.now(), settings = currentSite()): ProjectSummary {
  const graph = buildGraph(data, { site: settings });
  const groups = new Map(boardGroups(graph).map((g) => [g.id, g.nodes]));
  const humanMoves = groups.get("you") ?? [];
  const humanIds = new Set(humanMoves.map((n) => n.id));
  const moveImpacts: MoveImpacts = Object.fromEntries(graph.nodes
    .filter((n) => !humanIds.has(n.id) && !isClosed(n) && graph.dependents.get(n.id)?.length)
    .map((n) => [n.issue.identifier, moveImpact(graph, n)] as const)
    .filter(([, impact]) => impact.blocks > 0));
  const tally = new Map<string, { n: number; signal: Signal }>();
  for (const n of graph.nodes) tally.set(n.status, { n: (tally.get(n.status)?.n ?? 0) + 1, signal: n.signal });
  const order = statusOrder({ ...settings, waitNames: data.waitNames ?? settings.waitNames });
  const counts = [...tally].map(([status, c]) => ({ status, ...c }))
    .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  const effort = parseStatus(data.status?.content);
  const nextLines = effort?.lines.filter(({ level }) => level === "wait" || level === "do") ?? [];
  const liveJobs = graph.nodes.flatMap(({ card, issue }) =>
    !issue.external && card?.job && card.state && ["creating", "starting", "running"].includes(card.state)
      ? [{ identifier: issue.identifier, title: issue.title, state: card.state, startedAt: card.started_at ?? null }]
      : []);
  const projectNodes = graph.nodes.filter((node) => !node.issue.external && !isClosed(node));
  const externalBlocker = projectNodes.flatMap(({ issue }) => issue.blockedBy)
    .find((ref) => !ref.inProject && !["Done", "Canceled"].includes(statusName(ref.state, [], settings)))?.identifier;
  const collaborator = effort?.lines.flatMap(({ level, text }) => {
    const name = level === "note" ? text.match(/^human \S+: waits on (.+)/)?.[1] : undefined;
    return name ? [name] : [];
  })[0];
  const hasCards = graph.nodes.some((n) => n.card && !n.issue.external);
  const timing = hasCards ? statusTiming(effort, true, data.status?.updatedAt ?? null, now) : null;
  const updated = data.issues.map((i) => i.updatedAt).sort().at(-1) ?? null;
  return {
    workspace, id: data.project.id,
    planned: graph.nodes.filter((n) => n.status !== "Canceled").length,
    done: graph.nodes.filter((n) => n.status === "Done").length,
    counts,
    moveImpacts,
    you: humanMoves.map((n) => ({ identifier: n.issue.identifier, title: n.issue.title, why: yourMove(n.card?.next, summaryWords) ?? n.status, pullRequests: n.issue.pullRequests, updatedAt: n.issue.updatedAt, ...moveImpact(graph, n) })),
    running: groups.get("running")?.length ?? 0,
    review: groups.get("review")?.length ?? 0,
    ready: groups.get("next")?.length ?? 0,
    paused: nextLines.some(({ level, text }) => level === "wait" && text.split(" ", 1)[0] === "paused"),
    externalBlocker,
    collaborator,
    liveJobs,
    nextLines,
    effort: effort ? { status: effort.status, at: effort.at ?? data.status?.updatedAt ?? null } : null,
    freshness: timing ? { state: timing.state, ran: effort?.ran ?? null } : null,
    updatedAt: updated,
  };
}

/** `initiative`: null shows every project; NO_INITIATIVE shows the projects with no initiative; a name shows that initiative. */
export interface OverviewFilter { text: string; workspace: string | null; closed: boolean; initiative?: string | null }
export const NO_INITIATIVE = "";
export interface OverviewRow {
  project: Project & { workspace: string; workspaceName: string };
  summary: ProjectSummary | null;
  attention: ProjectState;
  stalls: Stall[];
}

export function readProjectStates(query: URLSearchParams): ProjectStateName[] {
  const selected = query.get("state")?.split(",") ?? [];
  return PROJECT_STATES.filter((state) => selected.includes(state));
}

export function countProjectStates(rows: OverviewRow[]): Record<ProjectStateName, number> {
  const counts = { stalled: 0, waits: 0, moving: 0, idle: 0 };
  for (const { attention } of rows) counts[attention.state]++;
  return counts;
}

export function filterProjectStates(rows: OverviewRow[], selected: ProjectStateName[]): OverviewRow[] {
  return selected.length ? rows.filter(({ attention }) => selected.includes(attention.state)) : rows;
}

interface OverviewActivity {
  now: number;
  presence?: Map<string, Presence>;
  agents?: Map<string, Agents>;
}

const stateOrder = (state: ProjectStateName) => PROJECT_STATES.indexOf(state);

export const summaryKey = (p: { workspace?: string; id: string }) => `${p.workspace ?? currentSite().defaultWorkspace}:${p.id}`;

/** The project rows by state, with the project order as the tie-breaker within each state. */
export function overviewRows(list: OverviewData | ProjectList, filter: OverviewFilter, activity: OverviewActivity = { now: Date.now() }): OverviewRow[] {
  const summaries = new Map(("summaries" in list ? list.summaries : []).map((s) => [summaryKey(s), s]));
  const { open, closed } = projectGroups(list.projects);
  const words = filter.text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shared = new Set(list.workspaces.filter(({ role }) => role).map(({ id }) => id));
  return [...open, ...(filter.closed ? closed : [])]
    .map((project) => {
      const key = summaryKey(project);
      const summary = summaries.get(key) ?? null;
      const { now } = activity;
      const presence = activity.presence?.get(key);
      const agents = activity.agents?.get(key);
      const readOnly = currentSite().readOnly || shared.has(project.workspace);
      const open = !project.paused && !["paused", "completed", "canceled"].includes(project.statusType);
      const found = summary && open ? stalls(summary, presence, agents, now, readOnly) : [];
      const attention = projectState(summary, { now, presence, agents, project, stalls: found });
      return { project, summary, attention, stalls: found };
    })
    .filter(({ project }) => (!filter.workspace || project.workspace === filter.workspace)
      && (filter.initiative == null || (project.initiative ?? NO_INITIATIVE).toLowerCase() === filter.initiative.toLowerCase())
      && words.every((w) => `${project.name} ${project.workspaceName} ${project.initiative ?? ""}`.toLowerCase().includes(w)))
    .sort((a, b) => stateOrder(a.attention.state) - stateOrder(b.attention.state)
      || (b.summary?.you.length ?? 0) - (a.summary?.you.length ?? 0)
      || Number((b.summary?.running ?? 0) > 0) - Number((a.summary?.running ?? 0) > 0));
}

/**
 * The moves of a project with the open questions of its workers (from the link) added. A question is a
 * move of the human's: the worker waits on the reply. Questions come first; a move whose worker also
 * asks says so. Each issue counts once.
 */
/** What an open ask of a worker is: a question, or an escalation that no coordinator read. */
const askVerb = (a: Ask) => (a.kind === "escalation" ? "Worker escalates" : "Worker asks");

function liveMoveImpact(impacts: MoveImpacts | undefined, id: string | null | undefined) {
  if (!impacts) return {};
  return id && Object.hasOwn(impacts, id) ? impacts[id] : { blocks: 0, unblocks: 0 };
}

export function movesWithAsks(you: YourMove[], asks: Ask[] | undefined, impacts?: MoveImpacts): YourMove[] {
  asks = asks?.filter((ask) => !ask.accountName || ask.accountName === currentSite().human);
  if (!asks?.length) return you;
  const asked = new Set(asks.map((a) => a.issue ?? "worker"));
  const extra: YourMove[] = [];
  for (const a of asks) {
    const id = a.issue ?? "worker";
    if (you.some((m) => m.identifier === id) || extra.some((m) => m.identifier === id)) continue;
    extra.push({ identifier: id, title: a.body.split("\n")[0].trim(), why: `${askVerb(a)}:`, pullRequests: [], updatedAt: a.at, idle: true, ...liveMoveImpact(impacts, a.issue) });
  }
  const verb = (id: string) => askVerb(asks.find((a) => (a.issue ?? "worker") === id)!);
  return [...extra, ...you.map((m) => (asked.has(m.identifier) ? { ...m, idle: true, why: `${verb(m.identifier)} · ${m.why}` } : m))];
}

/**
 * The moves of a project with its agents that wait on the human added (`wg agents`): an agent at a prompt
 * stops until the human answers it in Orca. They come first. A worker's move names its issue, so an issue
 * that is in the list keeps one entry and says that its worker waits.
 */
export function movesWithAgents(you: YourMove[], agents: Agents | undefined, now: number, impacts?: MoveImpacts): YourMove[] {
  const waiting = agentsWaiting(agents, now);
  if (!waiting.length) return you;
  const byIssue = new Map(waiting.flatMap((a) => (a.issue ? [[a.issue, a] as const] : [])));
  const extra: YourMove[] = waiting.filter((a) => !a.issue || !you.some((m) => m.identifier === a.issue))
    .map((a) => ({ identifier: agentName(a), title: a.said || a.title, why: `Agent ${agentNeeds(a)} in Orca:`, pullRequests: [], updatedAt: a.at ?? agents!.at, idle: true, ...liveMoveImpact(impacts, a.issue) }));
  return [...extra, ...you.map((m) => (byIssue.has(m.identifier) ? { ...m, idle: true, why: `Agent ${agentNeeds(byIssue.get(m.identifier)!)} · ${m.why}` } : m))];
}

/** The projects of one initiative in one workspace, and the sums of their summaries. `name` null: no initiative. */
export interface InitiativeSection {
  key: string; workspace: string; workspaceName: string; name: string | null; rows: OverviewRow[];
  state: ProjectStateName; projects: number; planned: number; done: number; you: number; running: number;
}

/**
 * The overview rows in one section for each initiative of each workspace. Workspaces keep the order of
 * `workspaces`. Inside each workspace, the section takes the highest-priority state of its rows.
 * Sections in the same state keep their previous order. Rows keep their order.
 */
export function initiativeSections(rows: OverviewRow[], workspaces: { id: string }[]): InitiativeSection[] {
  const sections = new Map<string, InitiativeSection>();
  for (const row of rows) {
    const { workspace, workspaceName } = row.project;
    const name = row.project.initiative ?? null;
    const key = `${workspace}:${name ?? ""}`;
    let section = sections.get(key);
    if (!section) sections.set(key, section = { key, workspace, workspaceName, name, rows: [], state: row.attention.state, projects: 0, planned: 0, done: 0, you: 0, running: 0 });
    if (stateOrder(row.attention.state) < stateOrder(section.state)) section.state = row.attention.state;
    section.rows.push(row);
    section.projects++;
    section.planned += row.summary?.planned ?? 0;
    section.done += row.summary?.done ?? 0;
    section.you += row.summary?.you.length ?? 0;
    section.running += row.summary?.running ?? 0;
  }
  const rank = new Map(workspaces.map((w, at) => [w.id, at]));
  return [...sections.values()].sort((a, b) => (rank.get(a.workspace) ?? 99) - (rank.get(b.workspace) ?? 99)
    || stateOrder(a.state) - stateOrder(b.state)
    || Number(a.name === null) - Number(b.name === null)
    || b.you - a.you
    || Number(b.running > 0) - Number(a.running > 0)
    || (a.name ?? "").localeCompare(b.name ?? ""));
}

/** The initiatives of the listed projects, by name, each once. */
export function initiativeNames(projects: Project[]): string[] {
  return [...new Set(projects.map((p) => p.initiative).filter((n): n is string => !!n))].sort((a, b) => a.localeCompare(b));
}
