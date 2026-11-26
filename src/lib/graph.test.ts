import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CARD_PREFIX, agentStep, ageText, boardGroups, boardOrder, startNode, buildGraph, cardText, isClaim, moveWarnings, parseCard, parseStatus, projectGroups, reach, reduceEdges, reviewMark, reviewOf, runTime, satisfied, shapeKey, soakLeft, statusName, statusTiming, toggleReviewed, trace, yourMove } from "./graph";
import type { GraphData, Issue, IssueRef, State } from "./types";
import { DEFAULT_HUMAN, configureSite, createSite, site } from "./site";

const state = (name: string, type: State["type"] = "unstarted"): State => ({ id: name, name, type, color: "#000" });
const DONE = state("Done", "completed");
const card = (data: object) => ({
  id: "c", body: `**work-graph node card** \`k\` · kind \`task\` · phase \`1\`\n\n**Acceptance**\n\nPass.\n\n\`\`\`json\n${JSON.stringify({ wg: 1, ...data })}\n\`\`\`\n\nGenerated from plan.json by \`wg load\`. Change plan.json, not this comment.`,
});

function issue(id: string, over: Partial<Issue> = {}): Issue {
  return {
    id, identifier: `CD-${id}`, title: id, description: "", priority: 0, url: "", sortOrder: 0, updatedAt: "",
    teamId: "t", teamKey: "CD", state: state("Todo"), assignee: null, labels: [], milestoneId: "m1",
    blocks: [], blockedBy: [], card: null, external: false, pullRequests: [], ...over,
  };
}
const ref = (i: Issue): IssueRef => ({ id: i.id, identifier: i.identifier, title: i.title, url: "", teamKey: i.teamKey, state: i.state, inProject: true });
function data(issues: Issue[], blocks: [string, string][]): GraphData {
  const byId = new Map(issues.map((i) => [i.id, i]));
  for (const [from, to] of blocks) byId.get(from)!.blocks.push(ref(byId.get(to)!));
  return { project: { id: "p", name: "P", url: "" }, milestones: [], issues, teams: {}, labels: [], viewerId: "me", status: null };
}

describe("parseCard", () => {
  it("reads the data block and ignores fields it does not know", () => {
    expect(parseCard(card({ key: "a", kind: "task", lane: "write", pr: "7", extra: 1 }).body)).toEqual({ key: "a", kind: "task", lane: "write", pr: "7" });
  });
  it("reads the header of a card that has no data block", () => {
    const old = "**work-graph node card** `mp1` · kind `merge-point` · phase `1a` · role `sync`\n\nNo acceptance or files in plan.json.";
    expect(parseCard(old)).toEqual({ key: "mp1", kind: "merge-point", phase: "1a", lane: undefined, role: "sync" });
    expect(cardText(old)).toBe("");
  });
  it("returns null for a comment that is not a card", () => {
    expect(parseCard("Design approved by Human")).toBeNull();
  });
  it("keeps only the acceptance and files as the readable text", () => {
    expect(cardText(card({ key: "a" }).body)).toBe("**Acceptance**\n\nPass.");
  });
});

describe("buildGraph", () => {
  it("groups the viewer's wait status under Your move and another person's under Waiting", () => {
    const graph = buildGraph({ ...data([
      issue("a", { state: state("Needs Ada", "started") }),
      issue("b", { labels: [{ id: "wait", name: "needs-grace", color: "", group: null }], card: card({ next: "wait human" }) }),
    ], []), waitNames: ["Ada", "Grace"] }, { site: createSite("Ada", "work") });
    expect(graph.byId.get("b")).toMatchObject({ status: "Needs Grace", signal: "stop", waitsOnOther: "Grace" });
    const groups = boardGroups(graph);
    expect(groups.find(({ id }) => id === "you")?.nodes.map(({ id }) => id)).toEqual(["a"]);
    expect(groups.find(({ id }) => id === "waiting")?.nodes.map(({ id }) => id)).toEqual(["b"]);
  });
  it("makes one edge for a relation that both issues report", () => {
    const a = issue("a"), b = issue("b");
    const d = data([a, b], [["a", "b"]]);
    b.blockedBy.push(ref(a));
    const g = buildGraph(d);
    expect(g.edges).toEqual([{ id: "a>b", from: "a", to: "b" }]);
    expect(g.blockers.get("b")).toEqual(["a"]);
    expect(g.dependents.get("a")).toEqual(["b"]);
  });
  it("takes kind from the card, then from a kind label, then task", () => {
    const g = buildGraph(data([
      issue("a", { card: card({ kind: "ops" }), labels: [{ id: "l", name: "spike", color: "", group: null }] }),
      issue("b", { labels: [{ id: "l", name: "merge-point", color: "", group: null }] }), issue("c"),
    ], []));
    expect(g.nodes.map((n) => n.kind)).toEqual(["ops", "merge-point", "task"]);
  });
  it("puts an outside node in the phase its card names", () => {
    const g = buildGraph(data([
      issue("a", { card: card({ phase: "2" }), milestoneId: "m2" }),
      issue("eng", { card: card({ phase: "2", lane: "x" }), milestoneId: null, external: true }),
      issue("other", { milestoneId: null, external: true }),
    ], []));
    expect(g.byId.get("eng")!.phaseId).toBe("m2");
    expect(g.byId.get("other")!.phaseId).toBeNull();
  });
  it("drops closed nodes and their edges when only open nodes are shown", () => {
    const g = buildGraph(data([issue("a", { state: DONE }), issue("b")], [["a", "b"]]), { openOnly: true });
    expect(g.nodes.map((n) => n.id)).toEqual(["b"]);
    expect(g.edges).toEqual([]);
  });
  it("shows the wait label and the agent claim", () => {
    const g = buildGraph(data([issue("a", { labels: [
      { id: "1", name: "needs-human", color: "", group: null }, { id: "2", name: "agent:codex", color: "", group: "agent" },
    ] })], []));
    expect(g.nodes[0]).toMatchObject({ status: "Needs Human", signal: "stop", claim: "agent:codex" });
  });
});

describe("reach", () => {
  it("follows links to every level and stops on a loop", () => {
    const g = buildGraph(data([issue("a"), issue("b"), issue("c"), issue("d")], [["a", "b"], ["b", "c"], ["c", "a"]]));
    expect([...reach("a", g.dependents)].sort()).toEqual(["a", "b", "c"]);
    expect([...reach("d", g.blockers)]).toEqual([]);
  });
});

describe("trace", () => {
  // a > b > c > d, and x > c.
  const g = buildGraph(data([issue("a"), issue("b"), issue("c"), issue("d"), issue("x")], [["a", "b"], ["b", "c"], ["c", "d"], ["x", "c"]]));
  const sorted = (set: Set<string>) => [...set].sort();
  it("lights only the edges of a selected node and dims nothing", () => {
    const t = trace(g, g.edges, { selected: "c" })!;
    expect(sorted(t.edges)).toEqual(["b>c", "c>d", "x>c"]);
    expect(t.dim).toBe(false);
  });
  it("lights the full chain above and below a node under the pointer and dims the rest", () => {
    const t = trace(g, g.edges, { hover: "b", selected: "d" })!;
    expect(sorted(t.edges)).toEqual(["a>b", "b>c", "c>d"]);
    expect(sorted(t.nodes)).toEqual(["a", "b", "c", "d"]);
    expect(t.dim).toBe(true);
  });
  it("lights one edge and its two nodes for an edge under the pointer", () => {
    const t = trace(g, g.edges, { edge: "x>c", hover: "a", selected: "d" })!;
    expect(sorted(t.edges)).toEqual(["x>c"]);
    expect(sorted(t.nodes)).toEqual(["c", "x"]);
    expect(t.dim).toBe(true);
  });
  it("lights only edges that are shown", () => {
    const shown = g.edges.filter((e) => e.id !== "x>c");
    expect(sorted(trace(g, shown, { selected: "c" })!.edges)).toEqual(["b>c", "c>d"]);
    expect(sorted(trace(g, shown, { hover: "c" })!.edges)).toEqual(["a>b", "b>c", "c>d"]);
  });
  it("gives nothing when no node or edge is in the graph", () => {
    expect(trace(g, g.edges, {})).toBeNull();
    expect(trace(g, g.edges, { edge: "gone", hover: "gone", selected: "gone" })).toBeNull();
    expect(trace(g, g.edges, { hover: "gone", selected: "a" })!.dim).toBe(false);
  });
});

describe("reduceEdges", () => {
  const ids = (g: ReturnType<typeof buildGraph>) => reduceEdges(g).map((e) => e.id).sort();
  it("leaves out an edge that a longer path already implies", () => {
    const g = buildGraph(data([issue("a"), issue("b"), issue("c"), issue("mp")], [["a", "b"], ["b", "c"], ["a", "mp"], ["b", "mp"], ["c", "mp"], ["a", "c"]]));
    expect(ids(g)).toEqual(["a>b", "b>c", "c>mp"]);
    expect(g.edges).toHaveLength(6);
  });
  it("keeps both edges of a diamond and every edge of separate lanes", () => {
    const g = buildGraph(data([issue("a"), issue("b"), issue("c"), issue("d")], [["a", "b"], ["a", "c"], ["b", "d"], ["c", "d"]]));
    expect(ids(g)).toEqual(["a>b", "a>c", "b>d", "c>d"]);
  });
});

describe("moveWarnings", () => {
  const started = state("In Progress", "started");
  it("warns when work starts before a blocker is done", () => {
    const g = buildGraph(data([issue("a"), issue("b")], [["a", "b"]]));
    expect(moveWarnings(g, "b", started)).toEqual(["A blocker is still open: CD-a (Todo)."]);
    expect(moveWarnings(g, "b", state("Backlog", "backlog"))).toEqual([]);
    expect(moveWarnings(g, "a", started)).toEqual([]);
  });
  it("lets a lane node start when its blocker is in review with code done in the same lane", () => {
    const review = state("In Review", "started");
    const g = buildGraph(data([
      issue("a", { state: review, card: card({ lane: "x", code_done: "yes" }) }), issue("b", { card: card({ lane: "x" }) }),
      issue("c", { card: card({ lane: "y" }) }),
    ], [["a", "b"], ["a", "c"]]));
    expect(moveWarnings(g, "b", started)).toEqual([]);
    expect(moveWarnings(g, "c", started)).toHaveLength(1);
  });
  it("warns when a done node goes back and a dependent already started", () => {
    const g = buildGraph(data([issue("a", { state: DONE }), issue("b", { state: started })], [["a", "b"]]));
    expect(moveWarnings(g, "a", state("Todo"))).toEqual(["Work that depends on this already started: CD-b (In Progress)."]);
  });
  it("warns that a cancel releases open dependents", () => {
    const g = buildGraph(data([issue("a"), issue("b")], [["a", "b"]]));
    expect(moveWarnings(g, "a", state("Canceled", "canceled"))[0]).toContain("CD-b (Todo)");
  });
});

// skills/work-graph/contract.json is the file that `wg contract --write` makes from wg.py. It holds
// what wg.py does. A test fails here when the page does not agree: change the page, never the contract.
interface Contract {
  kinds: string[]; status_aliases: Record<string, string>; statuses: string[];
  labels: { needs_human: string; ready_to_merge: string; reviewed: string; claim_prefix: string };
  card: { prefix: string; footers: string[]; fields: string[]; samples: { data: Record<string, unknown>; body: string }[] };
  satisfied: { name: string; blocker: Record<string, string>; node: Record<string, string>; clear: string[]; clear_without_code_done: string[] }[];
}
const contract = JSON.parse(readFileSync(new URL("../../skills/work-graph/contract.json", import.meta.url), "utf8")) as Contract;
const TYPES: Record<string, State["type"]> = { Todo: "unstarted", Ready: "unstarted", Done: "completed", Canceled: "canceled" };

describe("the contract with wg", () => {
  it("reads each status alias and each marker label as wg does", () => {
    for (const [name, cd] of Object.entries(contract.status_aliases)) expect(statusName(state(name, "started"))).toBe(cd);
    const mark = (name: string) => ({ id: name, name, color: "", group: null });
    expect(statusName(state("In Review", "started"), [mark(contract.labels.ready_to_merge)])).toBe("Ready to Merge");
    expect(statusName(state("Todo"), [mark(contract.labels.needs_human)])).toBe("Needs Human");
    expect(isClaim(mark(`${contract.labels.claim_prefix}codex`))).toBe(true);
  });
  it("reads every field of each sample card, and shows no footer", () => {
    expect(contract.card.prefix).toBe(CARD_PREFIX);
    for (const sample of contract.card.samples) {
      const { wg, ...fields } = sample.data;
      expect(wg).toBe(1);
      expect(Object.keys(fields).every((f) => contract.card.fields.includes(f))).toBe(true);
      expect(parseCard(sample.body)).toEqual(fields);
      expect(contract.kinds).toContain(parseCard(sample.body)!.kind);
      for (const footer of contract.card.footers) expect(cardText(sample.body)).not.toContain(footer);
    }
  });
  for (const edge of contract.satisfied) {
    it(`${edge.name} follows the contract with and without code done`, () => {
      const side = (id: string, { phase, ...data }: Record<string, string>, over: Partial<Issue> = {}) => issue(id, { milestoneId: `m${phase}`, card: card(data), ...over });
      const cleared = (blocker: Record<string, string>) => contract.statuses.filter((status) => {
        const g = buildGraph(data([side("a", blocker, { state: state(status, TYPES[status] ?? "started") }), side("b", edge.node)], [["a", "b"]]));
        return satisfied(g.byId.get("a")!, g.byId.get("b")!);
      });
      expect(cleared({ ...edge.blocker, code_done: "yes" })).toEqual(edge.clear);
      expect(cleared(edge.blocker)).toEqual(edge.clear_without_code_done);
    });
  }
});

describe("what wg next published", () => {
  const ids = (g: ReturnType<typeof boardGroups>) => Object.fromEntries(g.map((x) => [x.id, x.nodes.map((n) => n.issue.identifier)]));
  it("reads the status document, and nothing from a text that is not one", () => {
    const text = 'phase 1: 2 tasks\n\n- `do` review a CD-1\n\n```json\n{"wg": 1, "status": "phase 1: 2 tasks", "wave": ["a"], "lines": [{"level": "do", "text": "review a CD-1"}, {"bad": 1}], "at": "2026-11-20T10:00:00Z"}\n```\n\nWritten by `wg next`.';
    expect(parseStatus(text)).toEqual({ status: "phase 1: 2 tasks", wave: ["a"], lines: [{ level: "do", text: "review a CD-1" }], at: "2026-11-20T10:00:00Z", ran: null, waitInterval: null, contract: null });
    expect(parseStatus("notes of a meeting")).toBeNull();
    expect(parseStatus('```json\n{"status": "x"}\n```')).toBeNull();
    expect(parseStatus(null)).toBeNull();
  });
  it("uses the last run and the wait interval to tell how fresh the result is", () => {
    const status = parseStatus('```json\n{"wg":1,"status":"ready","ran":"2026-11-20T10:00:00Z","wait_interval":600,"contract":"012345abcdef"}\n```');
    expect(status).toMatchObject({ ran: "2026-11-20T10:00:00Z", waitInterval: 600, contract: "012345abcdef" });
    const timing = (minutes: number, wait = true) => statusTiming(wait ? status : { ...status!, waitInterval: null }, false, null,
      Date.parse("2026-11-20T10:00:00Z") + minutes * 60_000);
    expect(timing(19)).toEqual({ state: "listening", age: "19 min ago" });
    expect(timing(20)).toEqual({ state: "stale", age: "20 min ago" });
    expect(timing(15, false)).toEqual({ state: "fresh", age: "15 min ago" });
    expect(timing(16, false)).toEqual({ state: "stale", age: "16 min ago" });
  });

  it("uses the change time on old documents and reports efforts that never published", () => {
    const now = Date.parse("2026-11-20T10:30:00Z");
    const status = parseStatus('```json\n{"wg":1,"status":"ready","at":"2026-11-20T10:00:00Z"}\n```');
    expect(statusTiming(status, true, "2026-11-20T10:20:00Z", now)).toEqual({ state: "unknown", age: "30 min ago" });
    expect(statusTiming({ ...status!, at: null }, true, "2026-11-20T10:20:00Z", now)).toEqual({ state: "unknown", age: "10 min ago" });
    expect(statusTiming(null, true, null, now)).toEqual({ state: "never", age: null });
    expect(statusTiming(null, false, null, now)).toBeNull();
  });

  it("shows the run time only for a running worker and warns after two hours", () => {
    const started_at = "2026-11-20T08:00:00Z";
    const now = Date.parse("2026-11-20T10:00:00Z");
    expect(runTime({ state: "running", started_at }, now)).toEqual({ text: "2h 0m", warning: false });
    expect(runTime({ state: "running", started_at }, now + 60_000)).toEqual({ text: "2h 1m", warning: true });
    expect(runTime({ state: "starting", started_at }, now)).toBeNull();
    expect(runTime({ state: "running" }, now)).toBeNull();
  });

  it("says what the human must do only for a line that waits on them", () => {
    expect(yourMove("wait human: 2 review rounds; accept or ask for a fix")).toBe("2 review rounds; accept or ask for a fix");
    expect(yourMove("do ask-merge: #7")).toBe("Merge #7");
    expect(yourMove("do ask")).toBe("Your step");
    expect(yourMove("do review: #7\ndo ask-merge: #7\nwait human: accept; or fix")).toBe("Merge #7 accept; or fix");
    // The sample card of the contract has two lines about one node.
    const sample = contract.card.samples.find((c) => typeof c.data.next === "string")!;
    expect(yourMove(parseCard(sample.body)!.next)).toBe("Merge #7 2 review rounds; accept or ask for a fix");
    expect(yourMove("do review: #7 round 1")).toBeNull();
    expect(yourMove("wait worker")).toBeNull();
    expect(yourMove(undefined)).toBeNull();
  });
  it("puts an issue in Your move when wg next waits on Human for it, whatever its status", () => {
    const review = state("In Review", "started");
    const waits = issue("a", { state: review, card: card({ next: "wait human: 2 review rounds" }) });
    const runs = issue("b", { state: review, card: card({ next: "wait review" }) });
    expect(ids(boardGroups(buildGraph(data([waits, runs], []))))).toMatchObject({ you: ["CD-a"], review: ["CD-b"] });
  });
  it("puts a Ready to Merge PR in Your move only when wg next asks for its merge", () => {
    const rtm = state("Ready to Merge", "started");
    const ask = issue("a", { state: rtm, card: card({ next: "do ask-merge: #7" }) });
    const verify = issue("b", { state: rtm, card: card({ next: "do verify: #8 head abc is not code done" }) });
    const quiet = issue("c", { state: rtm, card: card({ key: "c" }) });
    expect(ids(boardGroups(buildGraph(data([ask, verify, quiet], []))))).toMatchObject({ you: ["CD-a", "CD-c"], review: ["CD-b"] });
  });
  it("keeps a merge that the coordinator does itself (do merge, autonomy full) out of Your move", () => {
    const merges = issue("a", { state: state("Ready to Merge", "started"), card: card({ next: "do merge: #7" }) });
    const inReview = issue("b", { state: state("In Review", "started"), card: card({ next: "do merge: #8" }) });
    expect(yourMove("do merge: #7")).toBeNull();
    expect(agentStep("do merge: #7")).toBe("merge");
    expect(ids(boardGroups(buildGraph(data([merges, inReview], []))))).toMatchObject({ you: [], review: ["CD-a", "CD-b"] });
  });
  it("names the action of the coordinator from what wg next said", () => {
    expect(agentStep("do verify: #8 head abc is not code done")).toBe("verify");
    expect(agentStep("wait review")).toBe("review");
    expect(agentStep("do ask-merge: #7")).toBeNull();
    expect(agentStep(undefined)).toBeNull();
  });
  it("keeps the status rule for a project with no published result", () => {
    const g = boardGroups(buildGraph(data([issue("a", { state: state("Ready to Merge", "started") }), issue("b", { state: state("In Review", "started") })], [])));
    expect(ids(g)).toMatchObject({ you: ["CD-a"], review: ["CD-b"] });
  });
  it("gives the time left of a soak", () => {
    const now = Date.parse("2026-11-20T10:00:00Z");
    expect(soakLeft("2026-11-20T13:12:00Z", now)).toBe("3h 12m");
    expect(soakLeft("2026-11-22T12:00:00Z", now)).toBe("2d 2h");
    expect(soakLeft("2026-11-20T10:20:00Z", now)).toBe("20m");
    expect(soakLeft("2026-11-20T09:00:00Z", now)).toBeNull();
    expect(soakLeft(undefined, now)).toBeNull();
  });
  it("lists the projects in progress first, and the closed ones apart", () => {
    const p = (name: string, statusType: string) => ({ id: name, name, url: "", status: statusType, statusType });
    const { open, closed } = projectGroups([p("Z done", "completed"), p("B plan", "planned"), p("C run", "started"), p("A run", "started"), p("X odd", ""), p("Y gone", "canceled")]);
    expect(open.map((x) => x.name)).toEqual(["A run", "C run", "B plan", "X odd"]);
    expect(closed.map((x) => x.name)).toEqual(["Y gone", "Z done"]);
  });
});

describe("review states", () => {
  const reviewed = { id: "r", name: "reviewed", color: "", group: null };
  const other = { id: "o", name: "bug", color: "", group: null };
  it("shows the wave review, then the merge review, then Human's own mark", () => {
    const mark = (data: object, labels = [other]) => { const i = issue("a", { labels, card: card(data) }); return reviewMark(i, parseCard(i.card!.body))?.text ?? null; };
    expect(mark({ pr: "7" })).toBeNull();
    expect(mark({ pr: "7", review: "requested" })).toBeNull();
    expect(mark({ pr: "7", review: "clean" })).toBe("✓");
    expect(mark({ pr: "7", review: "clean", merge_review: "requested" })).toBe("✓");
    expect(mark({ pr: "7", review: "clean", merge_review: "accepted" })).toBe("✓✓");
    expect(mark({ pr: "7" }, [other, reviewed])).toBe("✓ you");
    const i = issue("a", { labels: [reviewed], card: card({ review: "clean" }) });
    expect(reviewOf(i, parseCard(i.card!.body))).toEqual({ wave: true, merge: false, marked: true });
  });
  it("adds or removes only the reviewed label", () => {
    expect(toggleReviewed([other], reviewed)).toEqual([other, reviewed]);
    expect(toggleReviewed([reviewed, other], reviewed)).toEqual([other]);
  });
});

describe("statusName and shapeKey", () => {
  it("maps ENG status names to the CD names", () => {
    expect(statusName(state("Ready for Deploy", "started"))).toBe("Merged");
    expect(statusName(state("Shipped", "completed"))).toBe("Done");
  });
  it("reads the ready-to-merge label on an In Review ticket as Ready to Merge", () => {
    const merge = { id: "3", name: "ready-to-merge", color: "", group: null };
    expect(statusName(state("In Review", "started"), [merge])).toBe("Ready to Merge");
    expect(statusName(state("In Dev", "started"), [merge])).toBe("In Progress");
    expect(statusName(state("In Review", "started"), [merge, { ...merge, name: "needs-human" }])).toBe("Needs Human");
  });
  it("keeps the shape key when only a status changes", () => {
    const before = shapeKey(buildGraph(data([issue("a"), issue("b")], [["a", "b"]])));
    const after = shapeKey(buildGraph(data([issue("a", { state: DONE }), issue("b")], [["a", "b"]])));
    expect(after).toBe(before);
    expect(shapeKey(buildGraph(data([issue("a"), issue("b")], [])))).not.toBe(before);
  });
});

describe("boardGroups", () => {
  const ids = (g: ReturnType<typeof boardGroups>) => Object.fromEntries(g.map((x) => [x.id, x.nodes.map((n) => n.issue.identifier)]));
  it("puts Triage in Your move and Backlog in Waiting even with no blockers", () => {
    const triage = issue("t", { state: state("Triage") });
    const backlog = issue("b", { state: state("Backlog") });
    const groups = ids(boardGroups(buildGraph(data([triage, backlog], []))));
    expect(groups.you).toEqual(["CD-t"]);
    expect(groups.waiting).toEqual(["CD-b"]);
  });
  it("puts each open issue in the group of the action it needs, in run order", () => {
    const needs = issue("n", { state: state("Needs Human"), sortOrder: 5 });
    const merge = issue("r", { state: state("Ready to Merge", "started"), sortOrder: 4 });
    const run = issue("p", { state: state("In Progress", "started"), sortOrder: 3 });
    const review = issue("v", { state: state("In Review", "started"), sortOrder: 2 });
    const free = issue("f", { state: state("Todo"), sortOrder: 1 });
    const held = issue("h", { state: state("Todo"), sortOrder: 0 });
    const shut = issue("d", { state: DONE });
    const landed = issue("m", { state: state("Merged", "started") });
    const g = boardGroups(buildGraph(data([needs, merge, run, review, free, held, shut, landed], [["p", "h"]])));
    // A merged task waits for the ship point. The action is the ops node, so it is not in "Your move".
    expect(ids(g)).toEqual({ you: ["CD-r", "CD-n"], running: ["CD-p"], review: ["CD-v"], next: ["CD-f"], waiting: ["CD-h"], merged: ["CD-m"], closed: ["CD-d"] });
  });
  it("keeps the next phase waiting while the ship point is in Verifying", () => {
    const ship = issue("s", { state: state("Verifying", "started"), card: card({ kind: "ship-point" }) });
    const first = issue("t", { milestoneId: "m2", card: card({ kind: "task", lane: "x" }) });
    expect(ids(boardGroups(buildGraph(data([ship, first], [["s", "t"]])))).waiting).toEqual(["CD-t"]);
  });
  it("lets an issue start when its only blocker is done", () => {
    const a = issue("a", { state: DONE }), b = issue("b");
    expect(ids(boardGroups(buildGraph(data([a, b], [["a", "b"]])))).next).toEqual(["CD-b"]);
  });
  it("orders a group by depth in the graph before the manual sort order", () => {
    const a = issue("a", { state: state("In Review", "started"), sortOrder: 9 });
    const b = issue("b", { state: state("In Review", "started"), sortOrder: 1 });
    expect(ids(boardGroups(buildGraph(data([a, b], [["a", "b"]])))).review).toEqual(["CD-a", "CD-b"]);
  });
  it("puts an issue whose worker asks a question in Your move", () => {
    const run = issue("a", { state: state("In Progress", "started") });
    expect(ids(boardGroups(buildGraph(data([run], [])), new Set(["CD-a"])))).toMatchObject({ you: ["CD-a"], running: [] });
  });
  it("counts an issue with a worker claim as running, whatever its status", () => {
    const a = issue("a", { labels: [{ id: "l", name: "agent:codex", color: "", group: "agent" }] });
    expect(ids(boardGroups(buildGraph(data([a], [])))).running).toEqual(["CD-a"]);
  });
});

describe("boardOrder and startNode", () => {
  const ids = (nodes: { issue: { identifier: string } }[]) => nodes.map((n) => n.issue.identifier);
  it("steps through the groups top to bottom", () => {
    const run = issue("p", { state: state("In Progress", "started") });
    const merge = issue("r", { state: state("Ready to Merge", "started") });
    const shut = issue("d", { state: DONE });
    const free = issue("f");
    expect(ids(boardOrder(buildGraph(data([shut, free, run, merge], []))))).toEqual(["CD-r", "CD-p", "CD-f", "CD-d"]);
  });
  it("starts on Your move, else on running work, else on an issue that can start", () => {
    const run = issue("p", { state: state("In Progress", "started") });
    const merge = issue("r", { state: state("Ready to Merge", "started") });
    const free = issue("f");
    expect(startNode(buildGraph(data([run, merge, free], [])))?.issue.identifier).toBe("CD-r");
    expect(startNode(buildGraph(data([free, run], [])))?.issue.identifier).toBe("CD-p");
    expect(startNode(buildGraph(data([free], [])))?.issue.identifier).toBe("CD-f");
    expect(startNode(buildGraph(data([issue("d", { state: DONE })], [])))).toBeNull();
  });
});

describe("ageText", () => {
  it("formats elapsed time and leaves invalid times blank", () => {
    expect(ageText(-10_000)).toBe("now");
    expect(ageText(10_000)).toBe("now");
    expect(ageText(12 * 60_000)).toBe("12 min ago");
    expect(ageText(3 * 3_600_000)).toBe("3 h ago");
    expect(ageText(2 * 86_400_000)).toBe("2 d ago");
    expect(ageText(NaN)).toBeNull();
  });
});

describe("another human name (config `human`)", () => {
  afterEach(() => configureSite({ human: DEFAULT_HUMAN }));

  it("names the wait status and its label after the configured human; `wait human` still means a move of theirs", () => {
    const mark = (name: string) => ({ id: name, name, color: "", group: null });
    configureSite({ human: "Ada Lovelace" });
    expect(site.waitStatus).toBe("Needs Ada Lovelace");
    expect(statusName(state("In Review", "started"), [mark("needs-ada-lovelace")])).toBe("Needs Ada Lovelace");
    expect(statusName(state("In Review", "started"), [mark("needs-human")])).toBe("In Review");
    expect(yourMove("wait human: merge PR #7")).toBe("merge PR #7");
  });
});

describe("viewer wording", () => {
  afterEach(() => configureSite({ human: DEFAULT_HUMAN, readOnly: false }));

  it("names the owner in the board group and generated reasons", () => {
    configureSite({ human: "Ada", readOnly: true });
    const [group] = boardGroups(buildGraph(data([], [])));
    expect(group.title).toBe("Ada's move");
    expect(group.hint).toBe("Triage, a status that waits on Ada, a PR that wg next asks Ada to merge, or an issue where wg next waits on Ada.");
    expect(yourMove("wait human\ndo ask: Decide.")).toBe("It waits on Ada. Ada's step: Decide.");
  });

  it("credits the owner on a reviewed PR", () => {
    configureSite({ human: "Ada", readOnly: true });
    const reviewed = { id: "r", name: "reviewed", color: "", group: null };
    expect(reviewMark(issue("a", { labels: [reviewed] }), null)).toMatchObject({
      text: "✓ Ada", title: "Ada marked this PR reviewed. It counts as the wave review and the merge review.",
    });
  });
});
