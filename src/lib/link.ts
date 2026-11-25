import type { SiteConfig } from "./types";
// The protocol `wg-link/1` between the wg-ui server, each coordinator (`wg next` of the work-graph
// skill), and each open page. Design: CD-192. Linear stays the source of truth: a message here only
// makes a change known sooner, or shows what a coordinator does now.

import { type Signal, ageText } from "./graph.ts";

export const LINK_VERSION = 1;
export const RESTART_CODE = 1012;
export const RECYCLE_CODE = 4001;

export function reconnectImmediately(code: number): boolean {
  return code === RESTART_CODE || code === RECYCLE_CODE;
}
/** The message types of each direction, and the commands. contract.json `link` must hold the same lists. */
export const LINK_TO_COORDINATOR = ["changed", "answer", "reply", "command"] as const;
export const LINK_FROM_COORDINATOR = ["hello", "state", "asks", "progress", "ack", "wrote", "agents"] as const;
export const LINK_COMMANDS = ["next", "dispatch", "pause", "resume", "autonomy"] as const;
export type Role = "coordinator" | "page";

export interface ProjectRef { workspace: string; id: string }
export interface Envelope<T extends string = string, P = unknown> {
  v: typeof LINK_VERSION; type: T; id: string; project: ProjectRef; at: string; payload: P;
}

// Server → coordinator. Each one waits in the queue of the project until a coordinator sends `ack`.
export interface Changed { by: "page" | "linear" | "coordinator"; what: "status" | "comment" | "label" | "issue"; issues: string[] }
export interface Answer { issue: string; key: string | null; body: string }
export interface Reply { ask: string; issue: string | null; key: string | null; body: string }
export type CommandName = (typeof LINK_COMMANDS)[number];
/** `autonomy` has `level`: the server set the project label to it before it sent the command. */
export interface Command { name: CommandName; key: string | null; issue: string | null; level?: string }
export interface ToCoordinator { changed: Changed; answer: Answer; reply: Reply; command: Command }

// Coordinator → server.
export interface Hello { plan: string; session: string; host: string; wg: string }
export interface CoordinatorState { mode: "waiting" | "working"; head: string; lines: { level: string; text: string }[] }
/** `kind`: an `escalation` is a worker that stopped and that no coordinator read yet. None: a question. */
export interface Ask { id: string; key: string | null; issue: string | null; from: string; body: string; at: string; kind?: "question" | "escalation" }
export interface Progress { key: string; issue: string | null; job: string | null; state: string | null; ci: string | null; evidence: string | null; at: string | null }
/** `wrote`: wg changed these issues in Linear. It may come without `hello`, on a short connection of any wg command. */
export interface Wrote { issues: string[] }
/**
 * One agent of an effort, as Orca reports it (`wg agents`): in the plan directory (coordinator) or in the worktree
 * of a node (worker). `said`: its last message, as one line. `at`: when Orca last heard from it.
 */
export interface AgentRow {
  id: string; role: "coordinator" | "worker"; key: string | null; issue: string | null;
  agent: string; state: string; title: string; said: string; at: string | null;
}
export interface FromCoordinator {
  hello: Hello; state: CoordinatorState; asks: { asks: Ask[] }; progress: { nodes: Progress[] }; ack: { ids: string[] }; wrote: Wrote;
  /** Like `wrote`, it may come without `hello`: `wg agents` is no coordinator. */
  agents: { agents: AgentRow[] };
}

// Server → page.
export interface CoordinatorPresence {
  session: string; host: string; plan: string; connected: boolean;
  mode: CoordinatorState["mode"] | null; head: string | null; since: string; lastSeen: string;
  /** `wg next` said `wait paused`: The human paused the effort on the page. */
  paused: boolean;
  /** The heartbeat found the socket dead: the coordinator stopped answering. Not a normal close. */
  lost?: boolean;
}
export interface Presence { coordinators: CoordinatorPresence[]; queued: number }
/** The agents of a project. `at`: when the server last got them from `wg agents`. */
export interface Agents { at: string; agents: AgentRow[] }
export interface ToPage {
  presence: Presence; changed: Changed; asks: { asks: Ask[] }; progress: { nodes: Progress[] }; agents: Agents;
}

export const projectKey = (p: ProjectRef) => `${p.workspace}:${p.id}`;

const LIVE = new Set(["creating", "starting", "running"]);
/** The live job of a node, as the coordinator last reported it: `review running`. Null when no job runs. */
export function liveJob(progress: Progress | undefined): string | null {
  return progress?.job && progress.state && LIVE.has(progress.state) ? `${progress.job} ${progress.state}` : null;
}

/** `wg agents` sends the rows at least each minute. Rows that are older than this: it does not run. */
export const AGENTS_STALE_MS = 3 * 60_000;
export const agentsFresh = (agents: Agents | undefined, now: number): agents is Agents => !!agents && now - Date.parse(agents.at) < AGENTS_STALE_MS;

/** The Orca states in which an agent waits on the human. `WATCH_NEEDS` of wg.py has the same rule. */
const AGENT_NEEDS: Record<string, string> = { blocked: "waits at a prompt", waiting: "waits for your input" };
/** Why this agent waits on the human, or null. */
export const agentNeeds = (row: AgentRow): string | null => AGENT_NEEDS[row.state] ?? null;
/** Who an agent is: `coordinator`, or the issue of its node. */
export const agentName = (row: AgentRow): string => (row.role === "coordinator" ? "coordinator" : row.issue ?? row.key ?? "worker");

/** How long the page still shows an agent that ended. */
export const AGENT_DONE_MS = 60 * 60_000;
/** The agents that the page shows: each one that has not ended, and each one that ended in the last hour. */
export function agentsShown(agents: Agents | undefined, now: number): AgentRow[] {
  return (agents?.agents ?? []).filter((a) => a.state !== "done" || now - Date.parse(a.at ?? "") < AGENT_DONE_MS);
}
/** The lamp and the state text of one agent row. */
export function agentState(row: AgentRow): { signal: Signal; text: string } {
  const needs = agentNeeds(row);
  if (needs) return { signal: "stop", text: needs };
  if (row.state === "working") return { signal: "running", text: "working" };
  return { signal: "idle", text: row.state === "done" ? "stopped" : row.state || "unknown" };
}

/** The agents that wait on the human, when the rows are fresh. */
export function agentsWaiting(agents: Agents | undefined, now: number): AgentRow[] {
  return agentsFresh(agents, now) ? agents.agents.filter((a) => agentNeeds(a)) : [];
}

/**
 * What the page says about the coordinators of a project, or null when none ever connected. With fresh rows
 * of `wg agents`, a coordinator agent that waits on the human says so: the link cannot see a prompt.
 */
export function presenceText(presence: Presence | undefined, now: number, agents?: Agents, viewer = false):
  { state: "listening" | "working" | "gone" | "needs"; text: string; title: string } | null {
  const waits = agentsWaiting(viewer ? undefined : agents, now).find((a) => a.role === "coordinator");
  if (waits) {
    const age = ageText(now - Date.parse(waits.at ?? "")) ?? "";
    return { state: "needs", text: `coordinator ${agentNeeds(waits)}${age ? ` · ${age}` : ""}`, title: `Orca: the coordinator agent (${waits.agent}) is ${waits.state}. Open its terminal in Orca. Last message: ${waits.said || "none"}` };
  }
  const c = presence?.coordinators[0];
  if (!c) return null;
  const seen = ageText(now - Date.parse(c.lastSeen)) ?? "";
  const where = `${c.host}: ${c.plan}`;
  if (c.connected && c.mode === "waiting") return { state: "listening", text: "coordinator listening", title: viewer ? "The coordinator is listening." : `wg next --wait is connected (${where}). Your change wakes it at once.` };
  if (c.mode === "working" && !(c.lost && !c.connected)) return { state: "working", text: `coordinator working · ${seen}`, title: viewer ? "The coordinator is working." : `wg next ended ${seen}; the coordinator acts on it (${where}). It gets your changes at its next wg next.` };
  return { state: "gone", text: `coordinator not listening · ${seen}`, title: viewer ? "The coordinator is not listening." : `No wg next --wait runs (${where}). Your change waits in the queue; send the coordinator a message to wake it.` };
}

export const canCommandCoordinator = (viewer: boolean, coordinator: ReturnType<typeof presenceText>) =>
  !viewer && coordinator !== null;

export function pageLinkPath(config: Partial<Pick<SiteConfig, "link" | "readOnly">>): string | null {
  return config.link === undefined ? (config.readOnly ? null : "/api/link") : config.link;
}
