import { afterEach, describe, expect, it } from "vitest";
import { NO_INITIATIVE, initiativeNames, initiativeSections, movesWithAgents, movesWithAsks, overviewRows, overviewMoveReason, summarize, type OverviewData, type ProjectSummary } from "./overview";
import { DEFAULT_HUMAN, configureSite, createSite } from "./site";
import type { GraphData, Issue, State } from "./types";

const state = (name: string, type: State["type"] = "unstarted"): State => ({ id: name, name, type, color: "#000" });
const nextCard = (next: string) => ({ id: "c", body: `**work-graph node card** \`k\`\n\n\`\`\`json\n${JSON.stringify({ wg: 1, next })}\n\`\`\`` });
function issue(id: string, over: Partial<Issue> = {}): Issue {
  return {
    id, identifier: `CD-${id}`, title: `t${id}`, description: "", priority: 0, url: "", sortOrder: Number(id), updatedAt: `2026-11-0${id}T00:00:00Z`,
    teamId: "t", teamKey: "CD", state: state("Todo"), assignee: null, labels: [], milestoneId: null,
    blocks: [], blockedBy: [], card: null, external: false, pullRequests: [], ...over,
  };
}
const graph = (issues: Issue[], status: GraphData["status"] = null): GraphData =>
  ({ project: { id: "p", name: "P", url: "" }, milestones: [], issues, teams: {}, labels: [], viewerId: "me", status });

describe("summarize", () => {
  it("counts both wait statuses but gives the viewer only their own moves", () => {
    const data = graph([
      issue("1", { state: state("Needs Ada", "started") }),
      issue("2", { state: state("Needs Grace", "started"), card: nextCard("wait human: answer") }),
    ]);
    const summary = summarize({ ...data, waitNames: ["Ada", "Grace"] }, "work", 0, createSite("Ada", "work"));
    expect(summary.you.map(({ identifier }) => identifier)).toEqual(["CD-1"]);
    expect(summary.counts).toEqual([
      { status: "Needs Ada", n: 1, signal: "stop" },
      { status: "Needs Grace", n: 1, signal: "stop" },
    ]);
    expect(summarize(data, "work", 0, createSite("Ada", "work")).you).toHaveLength(2);
  });

  it("reports the freshness of a published work-graph project", () => {
    const ran = "2026-11-20T10:00:00Z";
    const status = { content: '```json\n{"wg":1,"status":"wave 2","ran":"2026-11-20T10:00:00Z","wait_interval":30}\n```', updatedAt: ran };
    const now = Date.parse(ran);
    const cards = [issue("1", { card: nextCard("wait worker") })];
    expect(summarize(graph(cards, status), "work", now).freshness).toMatchObject({ state: "listening", ran });
    expect(summarize(graph(cards, status), "work", now + 60_000).freshness).toMatchObject({ state: "fresh", ran });
    expect(summarize(graph(cards, status), "work", now + 16 * 60_000).freshness).toMatchObject({ state: "stale", ran });
    expect(summarize(graph(cards, { ...status, content: status.content.replace(ran, "invalid") }), "work", now).freshness?.state).toBe("unknown");
    expect(summarize(graph(cards), "work", now).freshness).toMatchObject({ state: "never", ran: null });
    expect(summarize(graph([issue("1")], status), "work", now).freshness).toBeNull();
  });

  it("counts the Board groups, the progress, and what waits on Human", () => {
    const s = summarize(graph([
      issue("1", { state: state("Done", "completed") }),
      issue("2", { state: state("Canceled", "canceled") }),
      issue("3", { state: state("Needs Human", "started") }),
      issue("4", { state: state("In Review", "started"), card: nextCard("do ask-merge: #7") }),
      issue("5", { state: state("In Progress", "started") }),
      issue("6"),
    ], { content: '```json\n{"wg":1,"status":"wave 2: 1 running","at":"2026-11-20T10:00:00Z"}\n```', updatedAt: "x" }), "work");
    expect(s).toMatchObject({ workspace: "work", id: "p", planned: 5, done: 1, running: 1, review: 0, ready: 1, updatedAt: "2026-11-06T00:00:00Z" });
    expect(s.you).toEqual([
      { identifier: "CD-3", title: "t3", why: "Needs Human", pullRequests: [], updatedAt: "2026-11-03T00:00:00Z" },
      { identifier: "CD-4", title: "t4", why: "Merge #7", pullRequests: [], updatedAt: "2026-11-04T00:00:00Z" },
    ]);
    expect(s.effort).toEqual({ status: "wave 2: 1 running", at: "2026-11-20T10:00:00Z" });
    expect(s.counts.map((c) => c.status)).toEqual(["Todo", "In Progress", "Needs Human", "In Review", "Done", "Canceled"]);
  });
});

describe("overviewRows", () => {
  const project = (id: string, name: string, statusType = "started", workspace = "work") =>
    ({ id, name, url: "", status: statusType, statusType, workspace, workspaceName: workspace === "home" ? "Home" : "Work" });
  const summary = (id: string, you: number, running = 0, workspace = "work"): ProjectSummary => ({
    workspace, id, planned: 1, done: 0, counts: [], running, review: 0, ready: 0, effort: null, freshness: null, updatedAt: null,
    you: Array.from({ length: you }, (_, at) => ({ identifier: `CD-${at}`, title: "", why: "", pullRequests: [], updatedAt: "" })),
  });
  const list: OverviewData = {
    workspaces: [{ id: "work", name: "Work" }, { id: "home", name: "Home" }],
    projects: [project("a", "Alpha"), project("b", "Beta"), project("c", "Gamma"), project("d", "Delta", "completed"), project("e", "Echo", "started", "home")],
    summaries: [summary("a", 0), summary("b", 1), summary("c", 0, 2), summary("e", 3, 0, "home")],
  };
  const ids = (filter: Partial<Parameters<typeof overviewRows>[1]>) =>
    overviewRows(list, { text: "", workspace: null, mine: false, closed: false, ...filter }).map((r) => r.project.id);

  it("puts the projects that wait on Human first, then the ones with running work", () => {
    expect(ids({})).toEqual(["e", "b", "c", "a"]);
  });
  it("filters by workspace, by waiting, by words, and shows closed projects only on request", () => {
    expect(ids({ workspace: "work" })).toEqual(["b", "c", "a"]);
    expect(ids({ mine: true })).toEqual(["e", "b"]);
    expect(ids({ text: "gam" })).toEqual(["c"]);
    expect(ids({ text: "home" })).toEqual(["e"]);
    expect(ids({ closed: true })).toEqual(["e", "b", "c", "a", "d"]);
  });
  it("works with the project list alone, before the first summaries", () => {
    const { summaries: _, ...plain } = list;
    expect(overviewRows(plain, { text: "", workspace: null, mine: false, closed: false }).map((r) => r.summary)).toEqual([null, null, null, null]);
  });
});

describe("initiatives", () => {
  const project = (id: string, initiative: string | null, workspace = "work") =>
    ({ id, name: id, url: "", status: "Started", statusType: "started", workspace, workspaceName: workspace === "home" ? "Home" : "Work", initiative });
  const summary = (id: string, you: number, running = 0, workspace = "work"): ProjectSummary => ({
    workspace, id, planned: 4, done: 1, counts: [], running, review: 0, ready: 0, effort: null, freshness: null, updatedAt: null,
    you: Array.from({ length: you }, (_, at) => ({ identifier: `CD-${at}`, title: "", why: "", pullRequests: [], updatedAt: "" })),
  });
  const list: OverviewData = {
    workspaces: [{ id: "work", name: "Work" }, { id: "home", name: "Home" }],
    projects: [project("a", "Tooling"), project("b", "Billing"), project("c", null), project("d", "Tooling"), project("e", "Home", "home")],
    summaries: [summary("a", 0, 1), summary("b", 0), summary("c", 5), summary("d", 2), summary("e", 0, 0, "home")],
  };
  const all = { text: "", workspace: null, mine: false, closed: false };

  it("groups the rows by workspace and initiative, waiting first, no initiative last, with sums", () => {
    const sections = initiativeSections(overviewRows(list, all), list.workspaces);
    expect(sections.map((s) => [s.workspace, s.name, s.rows.map((r) => r.project.id)])).toEqual([
      ["work", "Tooling", ["d", "a"]],
      ["work", "Billing", ["b"]],
      ["work", null, ["c"]],
      ["home", "Home", ["e"]],
    ]);
    expect(sections[0]).toMatchObject({ projects: 2, planned: 8, done: 2, you: 2, running: 1 });
  });
  it("filters by initiative name, by no initiative, and finds a project by its initiative", () => {
    const ids = (filter: object) => overviewRows(list, { ...all, ...filter }).map((r) => r.project.id);
    expect(ids({ initiative: "tooling" })).toEqual(["d", "a"]);
    expect(ids({ initiative: NO_INITIATIVE })).toEqual(["c"]);
    expect(ids({ text: "billing" })).toEqual(["b"]);
  });
  it("lists each initiative name once", () => {
    expect(initiativeNames(list.projects)).toEqual(["Billing", "Home", "Tooling"]);
  });
});

describe("movesWithAgents", () => {
  const at = Date.parse("2026-11-20T12:00:00Z");
  const move = { identifier: "CD-1", title: "Merge it", why: "Merge #7", pullRequests: [], updatedAt: "2026-11-01T00:00:00Z" };
  const agent = (id: string, state: string, issue: string | null = null) => ({
    id, role: issue ? "worker" as const : "coordinator" as const, key: issue && "a", issue, agent: "claude", state, title: "Run", said: "Allow the push?", at: "2026-11-20T11:50:00Z",
  });
  const report = (agents: ReturnType<typeof agent>[], sent = "2026-11-20T11:59:30Z") => ({ at: sent, agents });
  it("adds each agent that waits at a prompt as a move first, and marks the move of its issue", () => {
    expect(movesWithAgents([move], report([agent("c", "blocked"), agent("w1", "waiting", "CD-1"), agent("w2", "blocked", "CD-2"), agent("w3", "working", "CD-3"), agent("w4", "done", "CD-4")]), at)).toEqual([
      { identifier: "coordinator", title: "Allow the push?", why: "Agent waits at a prompt in Orca:", pullRequests: [], updatedAt: "2026-11-20T11:50:00Z" },
      { identifier: "CD-2", title: "Allow the push?", why: "Agent waits at a prompt in Orca:", pullRequests: [], updatedAt: "2026-11-20T11:50:00Z" },
      { ...move, why: "Agent waits for your input · Merge #7" },
    ]);
  });
  it("keeps the moves as they are with no report, or with a report that is older than 3 minutes", () => {
    expect(movesWithAgents([move], undefined, at)).toEqual([move]);
    expect(movesWithAgents([move], report([agent("c", "blocked")], "2026-11-20T11:56:00Z"), at)).toEqual([move]);
  });
});

describe("movesWithAsks", () => {
  const move = { identifier: "CD-1", title: "Merge it", why: "Merge #7", pullRequests: [], updatedAt: "2026-11-01T00:00:00Z" };
  const ask = (id: string, issue: string | null, body = "Which table?\nMore text") => ({ id, key: null, issue, from: "w", body, at: "2026-11-02T00:00:00Z" });
  it("adds each worker question as a move first, and marks a move that also has one", () => {
    expect(movesWithAsks([move], [ask("q1", "CD-2"), ask("q2", "CD-1")])).toEqual([
      { identifier: "CD-2", title: "Which table?", why: "Worker asks:", pullRequests: [], updatedAt: "2026-11-02T00:00:00Z" },
      { ...move, why: "Worker asks · Merge #7" },
    ]);
  });
  it("names an escalation that no coordinator read", () => {
    expect(movesWithAsks([move], [{ ...ask("e1", "CD-2", "Base differs"), kind: "escalation" as const }, { ...ask("e2", "CD-1"), kind: "escalation" as const }]).map((m) => m.why))
      .toEqual(["Worker escalates:", "Worker escalates · Merge #7"]);
  });
  it("keeps the moves as they are when no worker asks", () => {
    expect(movesWithAsks([move], [])).toEqual([move]);
    expect(movesWithAsks([move], undefined)).toEqual([move]);
  });
  it("counts a question of an issue once, and a question with no issue", () => {
    expect(movesWithAsks([], [ask("q1", "CD-2"), ask("q2", "CD-2"), ask("q3", null)]).map((m) => m.identifier)).toEqual(["CD-2", "worker"]);
  });
});

describe("overview move wording", () => {
  afterEach(() => configureSite({ human: DEFAULT_HUMAN, readOnly: false }));

  it("keeps wire reasons and names the owner when displaying them in the viewer", () => {
    const input = graph([issue("1", { card: nextCard("wait human\ndo ask: Verify the release.") })]);
    const reason = "It waits on you. Your step: Verify the release.";
    expect(overviewMoveReason(reason)).toBe(reason);
    configureSite({ human: "Ada", readOnly: true });
    expect(summarize(input, "work").you[0].why).toBe(reason);
    expect(overviewMoveReason(reason)).toBe("It waits on Ada. Ada's step: Verify the release.");
    expect(overviewMoveReason("Do you approve the release?")).toBe("Do you approve the release?");
  });
});
