import { ownerWords } from "./words.ts";
import { currentSite, waitStatuses, type Site } from "./site.ts";
import type { Card, GraphData, Issue, Kind, Label, Project, State } from "./types";

export const CARD_PREFIX = "**work-graph node card**";
const CARD_FOOTERS = [
  "Generated from plan.json by `wg load`. Change plan.json, not this comment.",
  "No acceptance or files in plan.json.",
];
const KINDS: Kind[] = ["task", "spike", "decision", "ops", "merge-point", "ship-point"];
const CARD_FIELDS = ["key", "kind", "phase", "lane", "role", "branch", "pr", "review", "merge_review", "state", "job", "started_at", "soak_until", "code_done", "wave", "next"] as const;

/** Reads the wg data block. A card written before the block existed still gives its header fields. */
export function parseCard(body: string | null | undefined): Card | null {
  if (!body?.startsWith(CARD_PREFIX)) return null;
  const block = body.match(/```json\s*\n([\s\S]*?)\n```/);
  if (block) {
    try {
      const data = JSON.parse(block[1]) as Record<string, unknown>;
      if (data.wg === 1) {
        const card: Card = {};
        for (const f of CARD_FIELDS) if (typeof data[f] === "string") (card as Record<string, string>)[f] = data[f];
        return card;
      }
    } catch {
      // A hand-edited block: use the header.
    }
  }
  const header = body.split("\n", 1)[0];
  const field = (name: string) => header.match(new RegExp(`${name} \`([^\`]+)\``))?.[1];
  return {
    key: header.match(/\*\* `([^`]+)`/)?.[1], kind: field("kind") as Kind | undefined,
    phase: field("phase"), lane: field("lane"), role: field("role"),
  };
}

/** The part of the card a person reads: acceptance and files, without header, data block, and footer. */
export function cardText(body: string): string {
  let text = body.split("\n").slice(1).join("\n").replace(/```json\s*\n[\s\S]*?\n```/, "");
  for (const footer of CARD_FOOTERS) text = text.replace(footer, "");
  return text.trim();
}

export const isClaim = (l: Label) => l.group === "agent" || l.name.startsWith("agent:");
export const isKindLabel = (l: Label) => (KINDS as string[]).includes(l.name);
export const isProtectedLabel = (l: Label) => isClaim(l) || isKindLabel(l);

export function kindOf(issue: Issue, card: Card | null): Kind {
  if (card?.kind && KINDS.includes(card.kind)) return card.kind;
  return (issue.labels.find(isKindLabel)?.name as Kind | undefined) ?? "task";
}

/** One name for each status across teams, the same table as wg.py `norm`. */
const ALIAS: Record<string, string> = { "Ready for Deploy": "Merged", "External QA": "In Review", "In Dev": "In Progress", "Ready for Eng": "Todo" };
export function statusName(state: State, labels: Label[] = [], settings = currentSite()): string {
  const waits = waitStatuses(settings);
  const explicit = settings.waitNames && waits.find(({ status }) => status === state.name);
  const wait = explicit || waits.find(({ label }) => labels.some((l) => l.name === label));
  if (wait) return wait.status;
  if (state.type === "completed") return "Done";
  if (state.type === "canceled" || state.type === "duplicate") return "Canceled";
  const name = ALIAS[state.name] ?? state.name;
  // An ENG workflow has no Ready to Merge status: wg marks it with a label on an In Review ticket.
  return name === "In Review" && labels.some((l) => l.name === "ready-to-merge") ? "Ready to Merge" : name;
}

/** The label with which the human accepts a PR as reviewed. wg never sets it. */
export const REVIEWED = "reviewed";
const REVIEW_OK = ["clean", "accepted"];

/** The three review states of a node: the wave review, the merge review, and the human's own mark. */
export function reviewOf(issue: Issue, card: Card | null): { wave: boolean; merge: boolean; marked: boolean } {
  return {
    wave: REVIEW_OK.includes(card?.review ?? ""), merge: REVIEW_OK.includes(card?.merge_review ?? ""),
    marked: issue.labels.some((l) => l.name === REVIEWED),
  };
}

/** The mark beside the PR number of a node, with what it means. The human's mark stands for both reviews. */
export function reviewMark(issue: Issue, card: Card | null): { text: string; title: string } | null {
  const { wave, merge, marked } = reviewOf(issue, card);
  if (marked) {
    const words = ownerWords();
    return { text: `✓ ${words.owner}`, title: words.reviewCredit };
  }
  if (merge) return { text: "✓✓", title: `Merge review: ${card!.merge_review}. The PR can go to its merge request.` };
  if (wave) return { text: "✓", title: `Wave review: ${card!.review}. The merge review is still to come.` };
  return null;
}

/** The labels of the issue with the `reviewed` label added, or removed when the issue has it. No other label changes. */
export function toggleReviewed(labels: Label[], reviewed: Label): Label[] {
  return labels.some((l) => l.id === reviewed.id) ? labels.filter((l) => l.id !== reviewed.id) : [...labels, reviewed];
}

export type Signal = "idle" | "ready" | "running" | "review" | "merged" | "done" | "stop" | "off";
export function signalOf(status: string, type: State["type"], settings = currentSite()): Signal {
  if (waitStatuses(settings).some((wait) => wait.status === status)) return "stop";
  switch (status) {
    case "Ready": return "ready";
    case "In Progress": return "running";
    case "In Review": case "Ready to Merge": return "review";
    case "Merged": case "Verifying": return "merged";
    case "Done": return "done";
    case "Canceled": return "off";
  }
  return type === "started" ? "running" : "idle";
}

export interface GNode {
  id: string; issue: Issue; card: Card | null; kind: Kind; status: string; signal: Signal;
  waitsOnOther?: string;
  claim: string | null; phaseId: string | null; lane: string | null;
}
export interface GEdge { id: string; from: string; to: string }
export interface Graph {
  nodes: GNode[]; byId: Map<string, GNode>; edges: GEdge[];
  blockers: Map<string, string[]>; dependents: Map<string, string[]>;
}

export const isClosed = (n: GNode) => n.status === "Done" || n.status === "Canceled";

/** `from` blocks `to`: the edge points the way the work flows. */
export function buildGraph(data: GraphData, opts: { openOnly?: boolean; include?: (node: GNode) => boolean; site?: Site } = {}): Graph {
  const base = opts.site ?? currentSite();
  const settings = { ...base, waitNames: data.waitNames ?? base.waitNames };
  const waits = waitStatuses(settings);
  let nodes: GNode[] = data.issues.map((issue) => {
    const card = parseCard(issue.card?.body);
    const status = statusName(issue.state, issue.labels, settings);
    const waitsOnOther = waits.find((wait) => wait.status === status && wait.name !== settings.human)?.name;
    return {
      id: issue.id, issue, card, kind: kindOf(issue, card), status, signal: signalOf(status, issue.state.type, settings), waitsOnOther,
      claim: issue.labels.find(isClaim)?.name ?? null, phaseId: issue.milestoneId, lane: card?.lane ?? null,
    };
  });
  // wg does not set the milestone of an ENG node. Its card names the phase; a project node of the
  // same phase gives the milestone.
  const phaseOfKey = new Map<string, string>();
  for (const n of nodes) if (n.phaseId && n.card?.phase) phaseOfKey.set(n.card.phase, n.phaseId);
  for (const n of nodes) if (!n.phaseId && n.card?.phase) n.phaseId = phaseOfKey.get(n.card.phase) ?? null;

  if (opts.include) nodes = nodes.filter(opts.include);
  if (opts.openOnly) nodes = nodes.filter((n) => !isClosed(n));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = new Map<string, GEdge>();
  for (const n of nodes) {
    for (const r of n.issue.blocks) if (byId.has(r.id)) edges.set(`${n.id}>${r.id}`, { id: `${n.id}>${r.id}`, from: n.id, to: r.id });
    for (const r of n.issue.blockedBy) if (byId.has(r.id)) edges.set(`${r.id}>${n.id}`, { id: `${r.id}>${n.id}`, from: r.id, to: n.id });
  }
  const blockers = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  const dependents = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges.values()) {
    blockers.get(e.to)!.push(e.from);
    dependents.get(e.from)!.push(e.to);
  }
  return { nodes, byId, edges: [...edges.values()], blockers, dependents };
}

/** Every node reachable from `id` through `links` (not `id` itself). */
export function reach(id: string, links: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const stack = [...(links.get(id) ?? [])];
  while (stack.length) {
    const next = stack.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(links.get(next) ?? []));
  }
  return seen;
}

export interface Trace { nodes: Set<string>; edges: Set<string>; dim: boolean }

/**
 * What the canvas lights, from the first of these that is in the graph:
 * - an edge under the pointer: that edge and its two nodes;
 * - a node under the pointer: each blocker above it and each dependent below it, to every level;
 * - the selected node: only its own edges, the same relations as the lists in the panel.
 * The pointer also dims all that is not lit. The selection dims nothing, because it stays while
 * the user reads the rest of the graph. `edges` are the edges on the canvas.
 */
export function trace(graph: Graph, edges: GEdge[], at: { edge?: string | null; hover?: string | null; selected?: string | null }): Trace | null {
  const edge = at.edge ? edges.find((e) => e.id === at.edge) : undefined;
  if (edge) return { nodes: new Set([edge.from, edge.to]), edges: new Set([edge.id]), dim: true };
  if (at.hover && graph.byId.has(at.hover)) {
    const up = reach(at.hover, graph.blockers).add(at.hover), down = reach(at.hover, graph.dependents).add(at.hover);
    const lit = edges.filter((e) => (up.has(e.from) && up.has(e.to)) || (down.has(e.from) && down.has(e.to)));
    return { nodes: new Set([...up, ...down]), edges: new Set(lit.map((e) => e.id)), dim: true };
  }
  if (at.selected && graph.byId.has(at.selected)) {
    const own = edges.filter((e) => e.from === at.selected || e.to === at.selected);
    return { nodes: new Set(own.flatMap((e) => [e.from, e.to]).concat(at.selected)), edges: new Set(own.map((e) => e.id)), dim: false };
  }
  return null;
}

/**
 * The edges to draw: an edge is left out when a longer path joins the same two nodes, because
 * that path already shows the order. A merge point that depends on each task of a lane chain then
 * has one edge, from the last task, and not one from each task.
 */
export function reduceEdges(graph: Graph): GEdge[] {
  return graph.edges.filter((e) => {
    const stack = (graph.dependents.get(e.from) ?? []).filter((next) => next !== e.to);
    const seen = new Set(stack);
    while (stack.length) {
      const at = stack.pop()!;
      for (const next of graph.dependents.get(at) ?? []) {
        if (next === e.to) return false;
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    return true;
  });
}

const STARTED = new Set(["In Progress", "In Review", "Ready to Merge", "Merged", "Verifying", "Done"]);
const CODE_DONE = new Set(["In Review", "Ready to Merge"]);

const MERGED = new Set(["Merged", "Done"]);
/** A SYNC or integration task: it runs after the merge point, and the ship point waits for it. */
const postMerge = (n: GNode) => n.card?.role === "sync" || n.card?.role === "integration";

/**
 * A blocker no longer holds `node` back. The same rule as wg.py `satisfied`:
 * - a canceled blocker holds nothing;
 * - a task of the same lane and phase: merged, or code done (wg moves a task to In Review only at code done);
 * - a task before a merge point, or a post-merge task before a ship point: merged;
 * - every other edge needs Done. A ship point in Verifying still holds the next phase.
 */
export function satisfied(blocker: GNode, node: GNode): boolean {
  const status = blocker.status;
  if (status === "Canceled") return true;
  if (blocker.kind === "task" && node.kind === "task" && blocker.lane === node.lane && blocker.phaseId === node.phaseId) {
    return MERGED.has(status) || (CODE_DONE.has(status) && blocker.card?.code_done === "yes");
  }
  if (blocker.kind === "task" && (node.kind === "merge-point" || (node.kind === "ship-point" && postMerge(blocker)))) return MERGED.has(status);
  return status === "Done";
}

export function moveImpact(graph: Graph, node: GNode): { blocks: number; unblocks: number } {
  const downstream = reach(node.id, graph.dependents);
  downstream.delete(node.id);
  let blocks = 0, unblocks = 0;
  for (const id of downstream) {
    const dependent = graph.byId.get(id)!;
    if (isClosed(dependent)) continue;
    blocks++;
    const blockers = graph.blockers.get(id) ?? [];
    if (blockers.includes(node.id) && !satisfied(node, dependent)
      && blockers.every((b) => b === node.id || satisfied(graph.byId.get(b)!, dependent))) unblocks++;
  }
  return { blocks, unblocks };
}

export interface MoveRank { updatedAt: string; blocks?: number; idle?: boolean }

export function compareMoves(a: MoveRank, b: MoveRank, ranked = true): number {
  const priority = ranked ? Number(!!b.idle) - Number(!!a.idle) || (b.blocks ?? 0) - (a.blocks ?? 0) : 0;
  return priority || (a.updatedAt || "~").localeCompare(b.updatedAt || "~");
}

/** Reasons a move of `id` to `target` breaks the graph order. Empty when the move is in order. */
export function moveWarnings(graph: Graph, id: string, target: State): string[] {
  const node = graph.byId.get(id);
  if (!node) return [];
  const next = statusName(target);
  const show = (ids: string[]) => ids.map((i) => graph.byId.get(i)!).map((n) => `${n.issue.identifier} (${n.status})`).join(", ");
  const warnings: string[] = [];
  if (STARTED.has(next) || next === "Ready") {
    const open = (graph.blockers.get(id) ?? []).filter((b) => !satisfied(graph.byId.get(b)!, node));
    if (open.length) warnings.push(`${open.length === 1 ? "A blocker is" : "Blockers are"} still open: ${show(open)}.`);
  }
  if (!["Merged", "Verifying", "Done"].includes(next) && ["Merged", "Verifying", "Done"].includes(node.status)) {
    const started = (graph.dependents.get(id) ?? []).filter((d) => STARTED.has(graph.byId.get(d)!.status));
    if (started.length) warnings.push(`Work that depends on this already started: ${show(started)}.`);
  }
  if (next === "Canceled") {
    const waiting = (graph.dependents.get(id) ?? []).filter((d) => !isClosed(graph.byId.get(d)!));
    if (waiting.length) warnings.push(`Linear treats a canceled blocker as resolved. These then lose this blocker: ${show(waiting)}.`);
  }
  return warnings;
}

const TYPE_ORDER = ["triage", "backlog", "unstarted", "started", "completed", "canceled", "duplicate"];
export function sortStates(states: State[]): State[] {
  return [...states].sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || (a.position ?? 0) - (b.position ?? 0));
}

/** Changes only when nodes, edges, or grouping change, so a status poll does not move the canvas. */
export function shapeKey(graph: Graph, edges: GEdge[] = graph.edges): string {
  return graph.nodes.map((n) => `${n.id}:${n.phaseId ?? ""}:${n.lane ?? ""}`).sort().join("|") + "#" + edges.map((e) => e.id).sort().join("|");
}

/** The record of the effort that `wg next` writes in a document of the project (contract.json `status_doc`). */
export interface EffortStatus {
  status: string;
  wave: string[];
  lines: { level: string; text: string }[];
  at: string | null;
  ran: string | null;
  waitInterval: number | null;
  contract: string | null;
}

export function parseStatus(content: string | null | undefined): EffortStatus | null {
  const block = content?.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!block) return null;
  try {
    const data = JSON.parse(block[1]) as Record<string, unknown>;
    if (data.wg !== 1 || typeof data.status !== "string") return null;
    const lines = Array.isArray(data.lines) ? (data.lines as { level?: unknown; text?: unknown }[]).filter((l) => typeof l.level === "string" && typeof l.text === "string") : [];
    return {
      status: data.status, wave: Array.isArray(data.wave) ? (data.wave as unknown[]).filter((k): k is string => typeof k === "string") : [],
      lines: lines as EffortStatus["lines"], at: typeof data.at === "string" ? data.at : null,
      ran: typeof data.ran === "string" ? data.ran : null,
      waitInterval: typeof data.wait_interval === "number" && data.wait_interval > 0 && Number.isFinite(data.wait_interval) ? data.wait_interval : null,
      contract: typeof data.contract === "string" ? data.contract : null,
    };
  } catch {
    return null;
  }
}

/**
 * What the human must do for a node, from what `wg next` last said about it (the card field `next`),
 * or null when the node does not wait on them. `wg next` says `wait human: <why>` and
 * `do ask…: <what>`; it names a merge only for the PR that can merge now, the lowest open one of its lane.
 */
export function yourMove(next: string | undefined, words = ownerWords()): string | null {
  const ask: Record<string, string> = { "ask-merge": "Merge", "ask-ready": "Mark the PR ready:", ask: words.step };
  // One line for each thing that wg next said about the node.
  const parts = (next ?? "").split("\n").flatMap((part) => {
    const m = part.match(/^(do|wait) (\S+?)(?:: ([\s\S]*))?$/);
    if (!m) return [];
    if (m[1] === "wait" && m[2] === "human") return [m[3] || words.waitReason];
    if (m[1] === "do" && m[2] in ask) return [`${ask[m[2]]}${m[3] ? ` ${m[3]}` : ""}`.replace(/:$/, "")];
    return [];
  });
  return parts.length ? parts.join(" ") : null;
}

/**
 * The step that the coordinator takes for a node, from what `wg next` last said (`do verify: …` gives
 * `verify`, `wait review` gives `review`), or null when it said nothing or asks the human.
 */
export function agentStep(next: string | undefined): string | null {
  if (!next || yourMove(next)) return null;
  const m = next.split("\n")[0].match(/^(?:do|wait) (\S+?)(?::|$)/);
  return m && m[1] !== "human" ? m[1] : null;
}

/** The age of a timestamp from its elapsed time in milliseconds. */
export function ageText(elapsed: number): string | null {
  if (!Number.isFinite(elapsed)) return null;
  const minutes = Math.max(0, Math.round(elapsed / 60_000));
  return minutes < 1 ? "now" : minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} d ago`;
}

export function statusTiming(status: EffortStatus | null, hasCards: boolean, updatedAt: string | null, now: number):
  { state: "listening" | "fresh" | "stale" | "unknown" | "never"; age: string | null } | null {
  if (!status) return hasCards && !updatedAt ? { state: "never", age: null } : null;
  const elapsed = now - Date.parse(status.ran ?? "");
  if (!Number.isFinite(elapsed)) {
    return { state: "unknown", age: ageText(now - Date.parse(status.at ?? updatedAt ?? "")) };
  }
  const listening = status.waitInterval !== null && elapsed < 2_000 * status.waitInterval;
  const state = listening ? "listening" : elapsed > 15 * 60_000 ? "stale" : "fresh";
  return { state, age: ageText(elapsed) };
}

export function runTime(card: Pick<Card, "state" | "started_at"> | null | undefined, now: number) {
  if (card?.state !== "running") return null;
  const elapsed = now - Date.parse(card.started_at ?? "");
  if (!Number.isFinite(elapsed)) return null;
  return { text: durationText(Math.max(0, Math.floor(elapsed / 60_000))), warning: elapsed > 2 * 60 * 60_000 };
}

export function soakLeft(until: string | undefined, now: number): string | null {
  const left = until ? Date.parse(until) - now : NaN;
  if (!(left > 0)) return null;
  return durationText(Math.ceil(left / 60_000));
}

function durationText(minutes: number): string {
  const days = Math.floor(minutes / 1440), hours = Math.floor((minutes % 1440) / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

const PROJECT_ORDER = ["started", "paused", "planned", "backlog"];
/** The projects to work on, those in progress first, and apart from them the completed and canceled ones. */
export function projectGroups(projects: Project[]): { open: Project[]; closed: Project[] } {
  const isClosed = (p: Project) => p.statusType === "completed" || p.statusType === "canceled";
  const rank = (p: Project) => (PROJECT_ORDER.indexOf(p.statusType) + PROJECT_ORDER.length + 1) % (PROJECT_ORDER.length + 1);
  const byName = (a: Project, b: Project) => a.name.localeCompare(b.name);
  return { open: projects.filter((p) => !isClosed(p)).sort((a, b) => rank(a) - rank(b) || byName(a, b)), closed: projects.filter(isClosed).sort(byName) };
}

export type BoardGroupId = "you" | "running" | "review" | "next" | "waiting" | "merged" | "closed";
export interface BoardGroup { id: BoardGroupId; title: string; hint: string; nodes: GNode[] }
const BOARD: [BoardGroupId, string, string][] = [
  ["you", "", ""],
  ["running", "Running", "A worker runs on it, or it is In Progress."],
  ["review", "In review", "In Review, Verifying, or Ready to Merge while the coordinator acts first."],
  ["next", "Can start", "Ready to start with no open blockers."],
  ["waiting", "Waiting", "Backlog, or an issue with an open blocker."],
  ["merged", "Merged", "Merged. It waits for the ship point of its phase."],
  ["closed", "Closed", "Done or Canceled."],
];

/** The departure board: each issue in the group of the action it needs, human moves by impact and the other groups in run order. */
export function boardGroups(graph: Graph, asked?: Set<string>, atPrompt?: Set<string>): BoardGroup[] {
  const groupOf = (n: GNode): BoardGroupId => {
    if (isClosed(n)) return "closed";
    if (n.waitsOnOther) return "waiting";
    if (n.signal === "stop") return "you";
    // A worker that asks a question waits on the human's reply (from the link).
    if (asked?.has(n.issue.identifier) || atPrompt?.has(n.issue.identifier)) return "you";
    if (n.status === "Triage") return "you";
    if (n.status === "Backlog") return "waiting";
    // wg next can flag a PR that waits on the human while its status is still In Review.
    if (yourMove(n.card?.next)) return "you";
    // wg next asks for a merge only for the PR that can merge now (`do ask-merge`). A Ready to Merge PR
    // for which it names another step (`do verify`) waits on the coordinator, not on the human.
    if (n.status === "Ready to Merge" && !agentStep(n.card?.next)) return "you";
    if (n.status === "Ready to Merge") return "review";
    if (n.claim || n.status === "In Progress") return "running";
    // The action after a merge is the ops node of the phase, and that node has its own row.
    if (n.status === "Merged") return "merged";
    if (n.status === "In Review" || n.status === "Verifying") return "review";
    const open = (graph.blockers.get(n.id) ?? []).some((b) => !satisfied(graph.byId.get(b)!, n));
    return open ? "waiting" : "next";
  };
  // Run order: the depth of the issue in the graph (the longest chain of blockers above it), then the
  // manual sort order. The sort order alone is not run order for an issue of another team.
  const depth = new Map<string, number>();
  const depthOf = (id: string, seen = new Set<string>()): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0; // a cycle: Linear allows one, the graph has no order there
    seen.add(id);
    const d = Math.max(-1, ...(graph.blockers.get(id) ?? []).map((b) => depthOf(b, seen))) + 1;
    depth.set(id, d);
    return d;
  };
  const groups = new Map<BoardGroupId, GNode[]>(BOARD.map(([id]) => [id, []]));
  for (const n of graph.nodes) groups.get(groupOf(n))!.push(n);
  const order = (a: GNode, b: GNode) => depthOf(a.id) - depthOf(b.id) || a.issue.sortOrder - b.issue.sortOrder;
  const words = ownerWords();
  const humanMoves = groups.get("you")!.map((node) => ({
    node,
    updatedAt: node.issue.updatedAt,
    blocks: moveImpact(graph, node).blocks,
    idle: asked?.has(node.issue.identifier) || atPrompt?.has(node.issue.identifier),
  })).sort((a, b) => compareMoves(a, b) || order(a.node, b.node));
  return BOARD.map(([id, title, hint]) => ({
    id,
    title: id === "you" ? words.move : title,
    hint: id === "you"
      ? `Triage, a status that waits ${words.onOwner}, a PR that wg next asks ${words.owner} to merge, or an issue where wg next waits ${words.onOwner}.`
      : hint,
    nodes: id === "you" ? humanMoves.map(({ node }) => node) : groups.get(id)!.sort(order),
  }));
}

/** The issues in board order: the groups top to bottom, in display order. `j` and `k` step through it. */
export function boardOrder(graph: Graph, asked?: Set<string>, atPrompt?: Set<string>): GNode[] {
  return boardGroups(graph, asked, atPrompt).flatMap((g) => g.nodes);
}

/** Where the first view of a project starts: the first issue in Your move, else the first that runs, is in review, or can start. */
export function startNode(graph: Graph, asked?: Set<string>): GNode | null {
  const groups = new Map(boardGroups(graph, asked).map((g) => [g.id, g.nodes]));
  for (const id of ["you", "running", "review", "next"] as BoardGroupId[]) {
    const first = groups.get(id)?.find((n) => !n.issue.external) ?? groups.get(id)?.[0];
    if (first) return first;
  }
  return null;
}
