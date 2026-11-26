import { afterEach, describe, expect, it } from "vitest";
import { NO_INITIATIVE, countProjectStates, filterProjectStates, readProjectStates, rankMoves, initiativeNames, initiativeSections, movesWithAgents, movesWithAsks, overviewRows, overviewMoveReason, summarize, type OverviewData, type ProjectSummary } from "./overview";
import { DEFAULT_HUMAN, configureSite, createSite } from "./site";
import type { Agents } from "./link";
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
  it("offers an answer only for an issue that waits on the human for a reply", () => {
    const waiting = state("Needs Ada", "started");
    const card = (kind: string, next: string) => ({
      id: "c", body: "**work-graph node card** `k`\n\n```json\n" + JSON.stringify({ wg: 1, kind, next }) + "\n```",
    });
    const summary = summarize(graph([
      issue("1", { state: waiting, card: nextCard("wait human: Which table?") }),
      issue("2", { state: waiting, card: card("ops", "do ask: Check the release") }),
      issue("3", { state: waiting, card: nextCard("do ask-merge: #7") }),
      issue("4", { card: nextCard("wait human: Mark the PR ready") }),
      issue("5", { state: waiting, external: true }),
      issue("6", { state: waiting, labels: [{ id: "l", name: "answered", color: "", group: null }] }),
    ]), "work", 0, createSite("Ada", "work"));
    expect(summary.you.filter((move) => move.answer).map((move) => move.answer)).toEqual([
      { issueId: "1", sent: false }, { issueId: "6", sent: true },
    ]);
  });

  it("keeps the live job and the wait and action lines for a paused effort", () => {
    const started_at = "2026-11-25T11:00:00Z";
    const card = { id: "c", body: `**work-graph node card** \`page\`\n\n\`\`\`json\n${JSON.stringify({ wg: 1, job: "dispatch", state: "running", started_at })}\n\`\`\`` };
    const lines = [{ level: "note", text: "wave 1" }, { level: "wait", text: "paused @effort -" }, { level: "do", text: "dispatch docs WG-2" }];
    const status = { content: `\`\`\`json\n${JSON.stringify({ wg: 1, status: "wave 1", lines })}\n\`\`\``, updatedAt: started_at };
    const node = { ...issue("1", { card }), identifier: "WG-1", teamKey: "WG" };
    expect(summarize(graph([node, { ...issue("2", { card, external: true }), identifier: "WG-2", teamKey: "WG" }], status), "work"))
      .toMatchObject({ paused: true, liveJobs: [{ identifier: "WG-1", title: "t1", state: "running", startedAt: started_at }], nextLines: lines.slice(1) });
  });

  it("reports only unresolved outside blockers of open project issues", () => {
    const open = issue("1");
    const closed = issue("2", { state: state("Done", "completed") });
    const activeBlocker = { ...issue("3"), identifier: "WG-3", inProject: false };
    open.blockedBy = [{ ...closed, inProject: false }, { ...issue("4"), inProject: true }, activeBlocker];
    expect(summarize(graph([open, closed]), "work").externalBlocker).toBe("WG-3");
    expect(summarize(graph([{ ...open, state: closed.state }]), "work").externalBlocker).toBeUndefined();
  });

  it("counts open dependents through a chain and fork, and only clears the last blocker", () => {
    const nodes = [
      issue("1", { state: state("Needs Ada", "started") }),
      issue("2"), issue("3"), issue("4"), issue("5"),
      issue("6", { state: state("Done", "completed") }),
      issue("7", { state: state("Canceled", "canceled") }),
      issue("8"),
    ];
    for (const [from, to] of [[1, 2], [2, 3], [1, 4], [1, 5], [1, 6], [1, 7], [8, 5], [6, 4]]) {
      const parent = nodes[from - 1];
      parent.blocks.push({ ...nodes[to - 1], inProject: true });
    }
    const summary = summarize(graph(nodes), "work", 0, createSite("Ada", "work"));
    expect(summary.you).toMatchObject([{ blocks: 4, unblocks: 2 }]);
  });

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

  it("includes the impact of an issue added to the inbox by a live question", () => {
    const worker = issue("1", { state: state("In Progress", "started") });
    const dependent = issue("2");
    worker.blocks.push({ ...dependent, inProject: true });
    const summary = summarize(graph([worker, dependent]), "work");
    const ask = { id: "q1", key: null, issue: worker.identifier, from: "w", body: "Which table?", at: worker.updatedAt };
    expect(summary.you).toEqual([]);
    expect(movesWithAsks(summary.you, [ask], summary.moveImpacts)).toMatchObject([{ idle: true, blocks: 1, unblocks: 1 }]);
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
      { identifier: "CD-3", title: "t3", why: "Needs Human", pullRequests: [], answer: { issueId: "3", sent: false }, updatedAt: "2026-11-03T00:00:00Z", blocks: 0, unblocks: 0 },
      { identifier: "CD-4", title: "t4", why: "Merge #7", pullRequests: [], updatedAt: "2026-11-04T00:00:00Z", blocks: 0, unblocks: 0 },
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
    overviewRows(list, { text: "", workspace: null, closed: false, ...filter }).map((r) => r.project.id);

  it("puts the projects that wait on Human first, then the ones with running work", () => {
    expect(ids({})).toEqual(["e", "b", "c", "a"]);
  });
  it("filters by workspace and by words, and shows closed projects only on request", () => {
    expect(ids({ workspace: "work" })).toEqual(["b", "c", "a"]);
    expect(ids({ text: "gam" })).toEqual(["c"]);
    expect(ids({ text: "home" })).toEqual(["e"]);
    expect(ids({ closed: true })).toEqual(["e", "b", "c", "a", "d"]);
  });
  it("orders by state, counts each state, and filters by any selected state from the URL", () => {
    const liveJobs = [{ identifier: "WG-1", title: "Work", state: "running", startedAt: new Date(-900_000).toISOString() }];
    const rows = overviewRows({
      ...list, summaries: list.summaries.map((s) => s.id === "a"
        ? { ...s, ready: 1, freshness: { state: "stale", ran: new Date(-900_000).toISOString() } }
        : s.id === "c" ? { ...s, liveJobs, nextLines: [{ level: "wait", text: "worker page WG-1" }] } : s),
    }, { text: "", workspace: null, closed: true }, {
      now: 0,
      presence: new Map([
        ["work:a", { coordinators: [], queued: 0 }],
        ["work:c", { coordinators: [{
          session: "coordinator", host: "", plan: "", connected: true, mode: "waiting", head: null,
          since: "", lastSeen: "", paused: false,
        }], queued: 0 }],
      ]),
      agents: new Map([["work:c", { at: new Date(0).toISOString(), agents: [{
        id: "worker", role: "worker", issue: "WG-1", key: "page", state: "working",
        agent: "agent", title: "", said: "", at: new Date(0).toISOString(),
      }] }]]),
    });
    expect(rows.map((r) => r.project.id)).toEqual(["a", "e", "b", "c", "d"]);
    expect(countProjectStates(rows)).toEqual({ stalled: 1, waits: 2, moving: 1, idle: 1 });
    const selected = readProjectStates(new URLSearchParams("state=idle,stalled,idle,unknown"));
    expect(selected).toEqual(["stalled", "idle"]);
    expect(filterProjectStates(rows, selected).map((r) => r.project.id)).toEqual(["a", "d"]);
    expect(filterProjectStates(rows, [])).toEqual(rows);
  });

  it("keeps the question in the summary when a separate dispatch stalls", () => {
    const agents: Agents = { at: new Date(0).toISOString(), agents: [{
      id: "worker", role: "worker", key: "question", issue: "WG-2", state: "blocked",
      agent: "agent", title: "Question", said: "Which option?", at: new Date(0).toISOString(),
    }] };
    const [row] = overviewRows({
      projects: [project("a", "Alpha")], workspaces: list.workspaces,
      summaries: [{
        ...summary("a", 0), you: movesWithAgents([], agents, 0),
        nextLines: [{ level: "do", text: "dispatch task WG-1" }],
        updatedAt: new Date(-900_000).toISOString(),
      }],
    }, { text: "", workspace: null, closed: false }, { now: 0, agents: new Map([["work:a", agents]]) });
    expect(row.attention.state).toBe("stalled");
    expect(row.summary?.you).toMatchObject([{ identifier: "WG-2", title: "Which option?" }]);
  });

  it.each(["viewer", "collaborator"] as const)("omits stalled states in shared %s workspaces", (role) => {
    const liveJobs = [{ identifier: "WG-1", title: "Work", state: "running", startedAt: null }];
    const rows = overviewRows({
      ...list, workspaces: list.workspaces.map((w) => ({ ...w, role })),
      summaries: list.summaries.map((s) => s.id === "a"
        ? { ...s, liveJobs, ready: 1, freshness: { state: "stale", ran: new Date(-900_000).toISOString() } } : s),
    }, { text: "", workspace: null, closed: false }, {
      now: 0, presence: new Map([["work:a", { coordinators: [], queued: 0 }]]),
    });
    expect(rows.find(({ project }) => project.id === "a")).toMatchObject({
      attention: { state: "idle", reason: "No agent report for WG-1" }, stalls: [],
    });
  });

  it("omits queue stalls when the project is paused, completed, or canceled", () => {
    const statuses = ["started", "paused", "completed", "canceled"];
    const rows = overviewRows({
      projects: statuses.map((status) => project(status, status, status)),
      workspaces: list.workspaces,
      summaries: statuses.map((status) => ({
        ...summary(status, 0), nextLines: [{ level: "wait", text: "coordinator ops WG-1" }],
        updatedAt: new Date(-900_000).toISOString(),
      })),
    }, { text: "", workspace: null, closed: true }, {
      now: 0, presence: new Map(statuses.map((status) => [`work:${status}`, { coordinators: [], queued: 0 }])),
    });
    expect(rows.map(({ project, attention, stalls }) => [project.id, attention.state, stalls.length])).toEqual([
      ["started", "stalled", 1], ["paused", "idle", 0], ["canceled", "idle", 0], ["completed", "idle", 0],
    ]);
  });

  it("keeps the reason accurate for viewers with started issues and no wg next lines", () => {
    const rows = overviewRows({
      ...list, workspaces: list.workspaces.map((w) => ({ ...w, role: "viewer" })),
    }, { text: "", workspace: "work", closed: false });
    expect(rows.find(({ project }) => project.id === "c")?.attention).toEqual({ state: "idle", reason: "No live job reported" });
  });

  it("works with the project list alone, before the first summaries", () => {
    const { summaries: _, ...plain } = list;
    expect(overviewRows(plain, { text: "", workspace: null, closed: false }).map((r) => r.summary)).toEqual([null, null, null, null]);
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
  const all = { text: "", workspace: null, closed: false };

  it("groups the rows by workspace and initiative, by roll-up state, with sums", () => {
    const ranked = { ...list, summaries: list.summaries.map((s) => s.id === "c"
      ? { ...s, you: [], nextLines: [{ level: "do", text: "dispatch page WG-1" }], updatedAt: new Date(-900_000).toISOString() } : s) };
    const sections = initiativeSections(overviewRows(ranked, all, {
      now: 0, presence: new Map([["work:c", { coordinators: [], queued: 0 }]]),
    }), list.workspaces);
    expect(sections.map((s) => [s.workspace, s.name, s.rows.map((r) => r.project.id)])).toEqual([
      ["work", null, ["c"]],
      ["work", "Tooling", ["d", "a"]],
      ["work", "Billing", ["b"]],
      ["home", "Home", ["e"]],
    ]);
    expect(sections[0].state).toBe("stalled");
    expect(sections[1]).toMatchObject({ state: "waits", projects: 2, planned: 8, done: 2, you: 2, running: 1 });
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
      { identifier: "coordinator", title: "Allow the push?", why: "Agent waits at a prompt in Orca:", idle: true, pullRequests: [], updatedAt: "2026-11-20T11:50:00Z", agentWait: agent("c", "blocked") },
      { identifier: "CD-2", title: "Allow the push?", why: "Agent waits at a prompt in Orca:", idle: true, pullRequests: [], updatedAt: "2026-11-20T11:50:00Z", agentWait: agent("w2", "blocked", "CD-2") },
      { ...move, idle: true, why: "Agent waits for your input · Merge #7", agentWait: agent("w1", "waiting", "CD-1") },
    ]);
  });
  it("keeps the moves as they are with no report, or with a report that is older than 3 minutes", () => {
    expect(movesWithAgents([move], undefined, at)).toEqual([move]);
    expect(movesWithAgents([move], report([agent("c", "blocked")], "2026-11-20T11:56:00Z"), at)).toEqual([move]);
  });
});

describe("movesWithAsks", () => {
  const move = { identifier: "WG-1", title: "Pick a table", why: "Which table?", pullRequests: [], updatedAt: "2026-11-01T00:00:00Z", answer: { issueId: "i1", sent: false } };
  const ask = (id: string, issue: string | null, body = "Which table?\nMore text") => ({ id, key: null, issue, from: "w", body, at: "2026-11-02T00:00:00Z" });
  it("adds a worker question as a move and combines it with a waiting issue that can take an answer", () => {
    expect(movesWithAsks([move], [ask("q1", "WG-2"), ask("q2", "WG-1")])).toEqual([
      { identifier: "WG-2", title: "Which table?", why: "Worker asks:", idle: true, pullRequests: [], updatedAt: "2026-11-02T00:00:00Z", workerAsk: ask("q1", "WG-2") },
      { ...move, idle: true, why: "Worker asks · Which table?", workerAsk: ask("q2", "WG-1") },
    ]);
  });

  it("keeps a merge row and a worker question on that issue as separate actions", () => {
    const merge = { ...move, answer: undefined, why: "Merge #7" };
    const question = ask("q1", "WG-1");
    expect(movesWithAsks([merge], [question])).toMatchObject([{ workerAsk: question }, merge]);
    expect(movesWithAsks([merge], [question])[1].workerAsk).toBeUndefined();
  });
  it("keeps questions without an account name and omits questions for another person", () => {
    expect(movesWithAsks([], [ask("q1", "CD-1"), { ...ask("q2", "CD-2"), accountName: "Grace" }])
      .map(({ identifier }) => identifier)).toEqual(["CD-1"]);
  });
  it("names an escalation that no coordinator read", () => {
    expect(movesWithAsks([move], [{ ...ask("e1", "CD-2", "Base differs"), kind: "escalation" as const }, { ...ask("e2", "WG-1"), kind: "escalation" as const }]).map((m) => m.why))
      .toEqual(["Worker escalates:", "Worker escalates · Which table?"]);
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

describe("rankMoves", () => {
  const items = [
    { updatedAt: "2026-11-02", blocks: 1 },
    { updatedAt: "2026-11-04", blocks: 4 },
    { updatedAt: "2026-11-03", blocks: 4 },
    { updatedAt: "2026-11-05", idle: true },
  ].map((move) => ({ move }));
  it("sorts by idle agent, dependents, then age", () => {
    expect(rankMoves(items)).toEqual([items[3], items[2], items[1], items[0]]);
  });
  it("sorts legacy responses by age even when a live agent waits", () => {
    const legacy = items.map(({ move: { updatedAt, idle } }) => ({ move: { updatedAt, idle } }));
    expect(rankMoves(legacy)).toEqual([legacy[0], legacy[2], legacy[1], legacy[3]]);
  });
});
