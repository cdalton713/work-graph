import { expect, it } from "vitest";
import { stalls, nextStep, overviewTitle, projectState } from "./attention";
import type { AgentRow, Agents, Presence } from "./link";
import type { ProjectSummary } from "./overview";

const now = Date.parse("2026-11-25T12:00:00Z");
const ago = (minutes: number, milliseconds = 0) => new Date(now - minutes * 60_000 + milliseconds).toISOString();
const job = { identifier: "WG-12", title: "Update the page", state: "running", startedAt: ago(25) };
const summary: ProjectSummary = {
  workspace: "work", id: "p", planned: 1, done: 0, counts: [], you: [], running: 1, review: 0,
  ready: 0, effort: null, freshness: null, updatedAt: ago(25), liveJobs: [job],
};
const worker: AgentRow = { id: "w", role: "worker", key: "page", issue: job.identifier, agent: "agent", state: "working", title: "", said: "", at: ago(20) };
const coordinator = { ...worker, id: "c", role: "coordinator" as const, key: null, issue: null };
const report = (...agents: AgentRow[]): Agents => ({ at: ago(0), agents });
const presence = (lastSeen: string, connected = false): Presence => ({
  queued: 0, coordinators: [{ session: "c", host: "", plan: "", connected, mode: "waiting", head: "", since: ago(60), lastSeen, paused: false }],
});

it("reports a silent worker at twenty minutes after its last report", () => {
  expect(stalls(summary, undefined, report(coordinator, { ...worker, at: ago(20, 1) }), now)).toEqual([]);
  expect(stalls(summary, undefined, report(coordinator, worker), now)).toMatchObject([{ kind: "worker-silent", issue: "WG-12", since: ago(20) }]);
});

it("allows three minutes for a job to get an agent or recover after its agent stops", () => {
  expect(stalls({ ...summary, liveJobs: [{ ...job, startedAt: ago(3, 1) }] }, undefined, report(coordinator), now)).toEqual([]);
  expect(stalls({ ...summary, liveJobs: [{ ...job, startedAt: ago(3) }] }, undefined, report(coordinator), now)).toMatchObject([{ kind: "worker-gone", since: ago(3), reason: "No matching worker in the agent report" }]);
  expect(stalls(summary, undefined, report(coordinator, { ...worker, state: "done", at: ago(3, 1) }), now)).toEqual([]);
  expect(stalls(summary, undefined, report(coordinator, { ...worker, state: "done", at: ago(3) }), now)).toMatchObject([{ kind: "worker-gone", since: ago(3), reason: "No matching worker in the agent report" }]);
  expect(stalls(summary, undefined, report(coordinator, { ...worker, state: "blocked" }), now)).toEqual([]);
});

it("reports a coordinator missing for fifteen minutes when it has work to do", () => {
  const duty = { ...summary, liveJobs: [], nextLines: [{ level: "do", text: "dispatch page WG-12" }], effort: { status: "wave 1", at: ago(20) } };
  expect(stalls(duty, presence(ago(15, 1)), report(), now)).toEqual([]);
  expect(stalls(duty, presence(ago(15)), report(), now)).toMatchObject([{ kind: "no-coordinator", since: ago(15) }]);
  expect(stalls(duty, presence(ago(15), true), report(), now)).toEqual([]);
  expect(stalls(duty, undefined, report(coordinator), now)).toEqual([]);
  expect(stalls(summary, presence(ago(15)), report({ ...worker, at: ago(0) }), now))
    .toMatchObject([{ kind: "no-coordinator", since: ago(15) }]);
  expect(stalls({ ...duty, nextLines: [{ level: "do", text: "ask-merge page WG-12" }] }, undefined, report(), now)).toEqual([]);
});

it("uses the last agent report only while it is fresh", () => {
  const seen = presence(ago(0), true);
  expect(stalls(summary, seen, { at: ago(3, 1), agents: [worker] }, now)).toMatchObject([{ kind: "worker-silent" }]);
  expect(stalls(summary, seen, { at: ago(3), agents: [worker] }, now)).toEqual([]);
  expect(stalls(summary, seen, undefined, now)).toEqual([]);
});

it("omits stalls for paused and completed efforts and for read-only viewers", () => {
  const seen = { coordinators: [], queued: 0 };
  expect(stalls({ ...summary, paused: true }, seen, undefined, now)).toEqual([]);
  const paused = presence(ago(0));
  paused.coordinators[0].paused = true;
  expect(stalls(summary, paused, undefined, now)).toEqual([]);
  expect(stalls({ ...summary, effort: { status: "every ship point is Done or Canceled", at: ago(20) } }, seen, undefined, now)).toEqual([]);
  expect(stalls(summary, seen, undefined, now, true)).toEqual([]);
});

it("describes the first wait or action that belongs to the agents", () => {
  const nextLines = [{ level: "wait", text: "human merge WG-13" }, { level: "wait", text: "worker page WG-12: job=dispatch" }];
  expect(nextStep({ ...summary, nextLines }, now)).toBe("worker on WG-12 · 25 min");
  expect(nextStep({ ...summary, nextLines: [{ level: "do", text: "dispatch page WG-12" }] }, now)).toBe("coordinator: dispatch WG-12");
  const until = "2026-11-25T14:00:00Z";
  const local = new Date(until).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  expect(nextStep({ ...summary, nextLines: [{ level: "wait", text: `soak ship WG-13: until ${until}` }] }, now)).toBe(`soak until ${local}`);
  expect(nextStep({ ...summary, nextLines: [{ level: "do", text: "triage WG-40: Bug" }] }, now)).toBe("coordinator: triage WG-40 · Bug");
});

it("includes the inbox count in the tab title only when it has entries", () => {
  expect(overviewTitle(3)).toBe("(3) Overview");
  expect(overviewTitle(0)).toBe("Overview");
});

const idle = { ...summary, running: 0, liveJobs: [] };
const duty = { level: "do", text: "dispatch page WG-12" };
const waiting = { identifier: "WG-13", title: "Choose a date", why: "Decision", pullRequests: [], updatedAt: ago(8), blocks: 0 };
const withInbox = { ...idle, you: [waiting, { ...waiting, identifier: "WG-14", title: "Approve the plan", why: "Approve the plan", blocks: 2 }] };
const selectedState = (s: ProjectSummary, link?: Presence, agents?: Agents) =>
  projectState(s, { presence: link, agents, now });

it("puts the first ranked inbox reason on the row and counts the remaining entries", () => {
  expect(selectedState(withInbox)).toEqual({ state: "waits", reason: "WG-14 · Approve the plan +1" });
});

it.each([
  { externalBlocker: "WG-19" },
  { collaborator: "Ada" },
  { you: [waiting] },
  ...["human merge WG-13", "owner ship WG-13", "collaborator Ada page: job=dispatch", "soak ship WG-13: until 14:00"]
    .map((text) => ({ nextLines: [duty, { level: "wait", text }] })),
])("does not raise a stall during an expected wait (%o)", (change) => {
  const blocked = { ...summary, nextLines: [duty], effort: { status: "wave 1", at: ago(20) }, ...change };
  expect(stalls(blocked, presence(ago(15)), report(), now)).toEqual([]);
  expect(selectedState(blocked, presence(ago(15)), report()).state).not.toBe("stalled");
});

it("keeps a paused project moving while a fresh agent report confirms work", () => {
  const moving = { state: "moving", reason: "Worker on WG-12" };
  expect(selectedState({ ...summary, paused: true }, undefined, report({ ...worker, at: ago(1) }))).toEqual(moving);
  expect(projectState(summary, { now, project: { statusType: "paused" } })).toEqual({ state: "idle", reason: "Paused" });
});

it.each([{ level: "wait", text: "coordinator ops WG-12" }, null])("shows an unattended queue at fifteen minutes (%o)", (line) => {
  const queued = { ...idle, ready: 1, nextLines: line ? [line] : [],
    freshness: { state: "stale" as const, ran: ago(60) }, updatedAt: ago(15, 1) };
  const seen = { coordinators: [], queued: 0 };
  expect(selectedState(queued, seen).state).toBe("idle");
  expect(selectedState({ ...queued, updatedAt: ago(15) }).state).toBe("idle");
  expect(selectedState({ ...queued, updatedAt: ago(15) }, seen)).toEqual({
    state: "stalled", reason: "Waiting for a coordinator report · 15 min ago",
  });
  expect(selectedState({ ...queued, updatedAt: ago(15) }, presence(ago(15), true)).state).not.toBe("stalled");
});

it("does not treat a disconnected coordinator’s old working state as progress", () => {
  const link = presence(ago(15));
  link.coordinators[0].mode = "working";
  const queued = { ...idle, nextLines: [duty] };
  expect(selectedState(queued, link).state).toBe("stalled");
});

it("gives an unavailable reason when the project graph fails to load", () => {
  expect(selectedState({ ...idle, error: "Could not load issues" })).toEqual({ state: "idle", reason: "Project details unavailable" });
});

it("shows uncertainty when a job has no current agent report", () => {
  expect(selectedState(summary)).toEqual({ state: "idle", reason: "No agent report for WG-12" });
  expect(selectedState(summary, presence(ago(0), true), { at: ago(3), agents: [worker] }))
    .toEqual({ state: "idle", reason: "Agent report for WG-12 is stale" });
});

it("shows a human prompt on a fresh agent report", () => {
  expect(selectedState(summary, undefined, report({ ...worker, state: "blocked" })))
    .toEqual({ state: "waits", reason: "WG-12 waits at a prompt" });
});

it("puts the inbox above moving work and an idle reason", () => {
  expect(selectedState({ ...withInbox, liveJobs: [job] }, undefined, report(coordinator, { ...worker, at: ago(0) }))).toMatchObject({ state: "waits" });
  expect(selectedState({ ...withInbox, paused: true })).toMatchObject({ state: "waits" });
});

it("puts moving ahead of idle when a job runs or a coordinator acts on a do line", () => {
  const nextLines = [{ level: "wait", text: "worker page WG-12" }];
  expect(selectedState({ ...summary, nextLines, externalBlocker: "WG-19" }, undefined, report(coordinator, { ...worker, at: ago(0) })))
    .toEqual({ state: "moving", reason: "worker on WG-12 · 25 min" });
  const listening = presence(ago(0), true);
  const s = { ...idle, nextLines: [duty] };
  expect(selectedState(s, listening)).toEqual({ state: "moving", reason: "coordinator: dispatch WG-12" });
  expect(selectedState(s, undefined, report(coordinator))).toMatchObject({ state: "moving" });
  expect(selectedState(idle, listening)).toMatchObject({ state: "idle" });
});

it.each([
  [{ paused: true }, "Paused"],
  [{ nextLines: [{ level: "wait", text: "soak ship WG-13: until 14:00" }] }, "soak until 14:00"],
  [{ externalBlocker: "WG-19" }, "Waits for WG-19 outside the project"],
  [{ nextLines: [{ level: "wait", text: "collaborator Ada page: job=dispatch" }] }, "Waits for Ada"],
  [{ nextLines: [{ level: "wait", text: "owner ship" }] }, "Waits for the owner"],
  [{ nextLines: [{ level: "wait", text: "collaborator Ada Example page: job=dispatch" }] }, "Waits for Ada Example"],
  [{ collaborator: "Ada" }, "Waits for Ada"],
  [{}, "Not started"],
  [{ planned: 2, done: 1 }, "No work running"],
  [{ running: 1 }, "No live job reported"],
  [{ review: 1 }, "No live job reported"],
  [{ done: 1 }, "Each node is done"],
] satisfies [Partial<ProjectSummary>, string][])("explains why a project is idle (%o)", (change, reason) => {
  expect(selectedState({ ...idle, ...change })).toEqual({ state: "idle", reason });
});
