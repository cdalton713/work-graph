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
  expect(stalls({ ...summary, liveJobs: [{ ...job, startedAt: ago(3) }] }, undefined, report(coordinator), now)).toMatchObject([{ kind: "worker-gone", since: ago(3) }]);
  expect(stalls(summary, undefined, report(coordinator, { ...worker, state: "done", at: ago(3, 1) }), now)).toEqual([]);
  expect(stalls(summary, undefined, report(coordinator, { ...worker, state: "done", at: ago(3) }), now)).toMatchObject([{ kind: "worker-gone", since: ago(3) }]);
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

it("reports one missing agent view at three minutes and suppresses worker stalls", () => {
  const effort = { ...summary, liveJobs: [job, { ...job, identifier: "WG-13" }] };
  const seen = presence(ago(0), true);
  expect(stalls(effort, seen, { at: ago(3, 1), agents: [worker] }, now)).toMatchObject([{ kind: "worker-silent" }, { kind: "worker-gone" }]);
  expect(stalls(effort, seen, { at: ago(3), agents: [worker] }, now)).toMatchObject([{ kind: "no-agent-view", since: ago(3), reason: expect.stringContaining("wg agents --install") }]);
  expect(stalls(effort, seen, undefined, now)).toMatchObject([{ kind: "no-agent-view" }]);
});

it("omits stalls for a shared collaborator with a live job and no link data", () => {
  expect(stalls(summary, undefined, undefined, now)).toEqual([]);
});

it("waits for the first project link message on the owner's Overview", () => {
  const beforeMessages = stalls(summary, undefined, undefined, now);
  const afterPresence = stalls(summary, { coordinators: [], queued: 0 }, undefined, now);
  expect(overviewTitle(beforeMessages.length)).toBe("Overview");
  expect(afterPresence.map(({ kind }) => kind)).toEqual(["no-agent-view", "no-coordinator"]);
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

it("puts a stall above inbox, moving work, and an idle reason", () => {
  for (const s of [withInbox, idle, { ...idle, externalBlocker: "WG-19" }]) {
    expect(selectedState({ ...s, liveJobs: [job] }, presence(ago(0), true))).toMatchObject({ state: "stalled", reason: expect.stringContaining("No agent view") });
  }
});

it("shows moving work until link data confirms a stall", () => {
  expect(selectedState(summary)).toEqual({ state: "moving", reason: "Worker on WG-12" });
  expect(selectedState(summary, presence(ago(0), true)).state).toBe("stalled");
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
  [{ paused: true, liveJobs: [job] }, "Paused"],
  [{ nextLines: [{ level: "wait", text: "soak ship WG-13: until 14:00" }] }, "soak until 14:00"],
  [{ externalBlocker: "WG-19" }, "Waits for WG-19 outside the project"],
  [{ nextLines: [{ level: "wait", text: "collaborator Ada page: job=dispatch" }] }, "Waits for Ada"],
  [{ nextLines: [{ level: "wait", text: "owner ship" }] }, "Waits for the owner"],
  [{ nextLines: [{ level: "wait", text: "collaborator Ada Example page: job=dispatch" }] }, "Waits for Ada Example"],
  [{ collaborator: "Ada" }, "Waits for Ada"],
  [{}, "Not started"],
  [{ done: 1 }, "Each node is done"],
] satisfies [Partial<ProjectSummary>, string][])("explains why a project is idle (%o)", (change, reason) => {
  expect(selectedState({ ...idle, ...change })).toEqual({ state: "idle", reason });
});
