// The protocol `wg-link/1` between the wg-ui server, each coordinator (`wg next` of the work-graph
// skill), and each open page. Design: CD-192. Linear stays the source of truth: a message here only
// makes a change known sooner, or shows what a coordinator does now.

import { ageText } from "./graph.ts";

export const LINK_VERSION = 1;
/** The message types of each direction, and the commands. contract.json `link` must hold the same lists. */
export const LINK_TO_COORDINATOR = ["changed", "answer", "reply", "command"] as const;
export const LINK_FROM_COORDINATOR = ["hello", "state", "asks", "progress", "ack", "wrote"] as const;
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
export interface Ask { id: string; key: string | null; issue: string | null; from: string; body: string; at: string }
export interface Progress { key: string; issue: string | null; job: string | null; state: string | null; ci: string | null; evidence: string | null; at: string | null }
/** `wrote`: wg changed these issues in Linear. It may come without `hello`, on a short connection of any wg command. */
export interface Wrote { issues: string[] }
export interface FromCoordinator {
  hello: Hello; state: CoordinatorState; asks: { asks: Ask[] }; progress: { nodes: Progress[] }; ack: { ids: string[] }; wrote: Wrote;
}

// Server → page.
export interface CoordinatorPresence {
  session: string; host: string; plan: string; connected: boolean;
  mode: CoordinatorState["mode"] | null; head: string | null; since: string; lastSeen: string;
  /** `wg next` said `wait paused`: The human paused the effort on the page. */
  paused: boolean;
}
export interface Presence { coordinators: CoordinatorPresence[]; queued: number }
export interface ToPage {
  presence: Presence; changed: Changed; asks: { asks: Ask[] }; progress: { nodes: Progress[] };
}

export const projectKey = (p: ProjectRef) => `${p.workspace}:${p.id}`;

const LIVE = new Set(["creating", "starting", "running"]);
/** The live job of a node, as the coordinator last reported it: `review running`. Null when no job runs. */
export function liveJob(progress: Progress | undefined): string | null {
  return progress?.job && progress.state && LIVE.has(progress.state) ? `${progress.job} ${progress.state}` : null;
}

/** What the page says about the coordinators of a project, or null when none ever connected. */
export function presenceText(presence: Presence | undefined, now: number):
  { state: "listening" | "working" | "gone"; text: string; title: string } | null {
  const c = presence?.coordinators[0];
  if (!c) return null;
  const seen = ageText(now - Date.parse(c.lastSeen)) ?? "";
  const where = `${c.host}: ${c.plan}`;
  if (c.connected && c.mode === "waiting") return { state: "listening", text: "coordinator listening", title: `wg next --wait is connected (${where}). Your change wakes it at once.` };
  if (c.mode === "working") return { state: "working", text: `coordinator working · ${seen}`, title: `wg next ended ${seen}; the coordinator acts on it (${where}). It gets your changes at its next wg next.` };
  return { state: "gone", text: `coordinator not listening · ${seen}`, title: `No wg next --wait runs (${where}). Your change waits in the queue; send the coordinator a message to wake it.` };
}
