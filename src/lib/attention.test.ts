import { expect, it } from "vitest";
import { stalls, nextStep, overviewTitle } from "./attention";
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

it("omits stalls for paused and completed efforts and for read-only viewers", () => {
  expect(stalls({ ...summary, paused: true }, undefined, undefined, now)).toEqual([]);
  const paused = presence(ago(0));
  paused.coordinators[0].paused = true;
  expect(stalls(summary, paused, undefined, now)).toEqual([]);
  expect(stalls({ ...summary, effort: { status: "every ship point is Done or Canceled", at: ago(20) } }, undefined, undefined, now)).toEqual([]);
  expect(stalls(summary, undefined, undefined, now, true)).toEqual([]);
});

it("describes the first wait or action that belongs to the agents", () => {
  const nextLines = [{ level: "wait", text: "human merge WG-13" }, { level: "wait", text: "worker page WG-12: job=dispatch" }];
  expect(nextStep({ ...summary, nextLines }, now)).toBe("worker on WG-12 · 25 min");
  expect(nextStep({ ...summary, nextLines: [{ level: "do", text: "dispatch page WG-12" }] }, now)).toBe("coordinator: dispatch WG-12");
  expect(nextStep({ ...summary, nextLines: [{ level: "wait", text: "soak ship WG-13: until 14:00" }] }, now)).toBe("soak until 14:00");
});

it("includes the inbox count in the tab title only when it has entries", () => {
  expect(overviewTitle(3)).toBe("(3) Overview");
  expect(overviewTitle(0)).toBe("Overview");
});
