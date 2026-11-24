import { describe, expect, it } from "vitest";
import contract from "../../skills/work-graph/contract.json";
import { ANSWERED_LABEL, AUTONOMY_DEFAULT, AUTONOMY_GROUP, AUTONOMY_LEVELS, autonomyOf, PAUSED_LABEL, pausedOf } from "./autonomy";
import { REVIEW_DEFAULT, REVIEW_GROUP, REVIEW_LEVELS, REVIEW_PREFIX, reviewOf } from "./review";
import { type CoordinatorPresence, LINK_COMMANDS, LINK_FROM_COORDINATOR, LINK_TO_COORDINATOR, LINK_VERSION, agentState, agentsShown, liveJob, presenceText } from "./link";

const now = Date.parse("2026-11-20T12:00:00Z");
const coordinator = (over: Partial<CoordinatorPresence>): CoordinatorPresence => ({
  session: "s", host: "mac", plan: "/plans/a", connected: true, mode: "waiting", head: "phase 1", since: "2026-11-20T11:00:00Z", lastSeen: "2026-11-20T11:54:00Z", paused: false, ...over,
});

describe("presenceText", () => {
  it("says whether the coordinator listens, works, or is gone", () => {
    expect(presenceText(undefined, now)).toBeNull();
    expect(presenceText({ coordinators: [], queued: 0 }, now)).toBeNull();
    expect(presenceText({ coordinators: [coordinator({})], queued: 0 }, now)).toMatchObject({ state: "listening", text: "coordinator listening" });
    expect(presenceText({ coordinators: [coordinator({ connected: false, mode: "working" })], queued: 0 }, now))
      .toMatchObject({ state: "working", text: "coordinator working · 6 min ago" });
    expect(presenceText({ coordinators: [coordinator({ connected: false, mode: "waiting" })], queued: 2 }, now))
      .toMatchObject({ state: "gone", text: "coordinator not listening · 6 min ago" });
  });
  it("says not listening for a coordinator that the heartbeat lost, also when it was working", () => {
    expect(presenceText({ coordinators: [coordinator({ connected: false, mode: "working", lost: true })], queued: 0 }, now))
      .toMatchObject({ state: "gone", text: "coordinator not listening · 6 min ago" });
    // A normal close after a completed wait keeps the working display.
    expect(presenceText({ coordinators: [coordinator({ connected: false, mode: "working", lost: false })], queued: 0 }, now))
      .toMatchObject({ state: "working", text: "coordinator working · 6 min ago" });
  });
});

describe("the agents of wg agents", () => {
  const row = (state: string, at = "2026-11-20T11:50:00Z") => ({ id: state + at, role: "coordinator" as const, key: null, issue: null, agent: "claude", state, title: "Run", said: "Allow the push?", at });
  const fresh = (state: string) => ({ at: "2026-11-20T11:59:30Z", agents: [row(state)] });
  it("a coordinator agent at a prompt shows in place of the presence, while the report is fresh", () => {
    const presence = { coordinators: [coordinator({ connected: false, mode: "working" })], queued: 0 };
    expect(presenceText(presence, now, fresh("blocked"))).toMatchObject({ state: "needs", text: "coordinator waits at a prompt · 10 min ago" });
    expect(presenceText(undefined, now, fresh("waiting"))).toMatchObject({ state: "needs", text: "coordinator waits for your input · 10 min ago" });
    expect(presenceText(presence, now, fresh("working"))).toMatchObject({ state: "working" });
    expect(presenceText(presence, now, { ...fresh("blocked"), at: "2026-11-20T11:56:00Z" })).toMatchObject({ state: "working" });
    expect(presenceText(undefined, now, fresh("done"))).toBeNull();
  });
  it("shows an agent that ended for one hour, and gives each state a lamp", () => {
    const agents = [row("working"), row("done"), row("done", "2026-11-20T10:59:00Z")];
    expect(agentsShown({ at: "", agents }, now).map((a) => a.id)).toEqual([agents[0].id, agents[1].id]);
    expect(agentsShown(undefined, now)).toEqual([]);
    expect(["working", "blocked", "waiting", "done", ""].map((s) => agentState(row(s)))).toEqual([
      { signal: "running", text: "working" }, { signal: "stop", text: "waits at a prompt" }, { signal: "stop", text: "waits for your input" },
      { signal: "idle", text: "stopped" }, { signal: "idle", text: "unknown" }]);
  });
});

describe("liveJob", () => {
  it("names the job only while it runs", () => {
    const p = { key: "a", issue: "CD-1", job: "review", state: "running", ci: null, evidence: null, at: null };
    expect(liveJob(p)).toBe("review running");
    expect(liveJob({ ...p, state: "failed" })).toBeNull();
    expect(liveJob(undefined)).toBeNull();
  });
});

describe("the link agrees with wg (contract.json)", () => {
  it("has the same version, path, message types, and commands", () => {
    expect(contract.link).toEqual({
      version: LINK_VERSION, path: "/api/link", to_coordinator: [...LINK_TO_COORDINATOR],
      from_coordinator: [...LINK_FROM_COORDINATOR], commands: [...LINK_COMMANDS],
    });
  });
});

describe("the review effort label agrees with wg (contract.json)", () => {
  it("has the same group, prefix, levels, and default", () => {
    expect(contract.project_labels).toMatchObject({ review_group: REVIEW_GROUP, review_prefix: REVIEW_PREFIX, review_levels: [...REVIEW_LEVELS], review_default: REVIEW_DEFAULT });
  });
  it("reads the level from the label group, with the prefix or as an old label without it", () => {
    expect(reviewOf([{ name: "standard", parent: { name: "autonomy" } }, { name: "review:standard", parent: { name: "Review" } }])).toBe("standard");
    expect(reviewOf([{ name: "light", parent: { name: "review" } }])).toBe("light");
    expect(reviewOf([{ name: "review:light", parent: null }, { name: "review:other", parent: { name: "review" } }])).toBeNull();
    expect(reviewOf(undefined)).toBeNull();
  });
});

describe("the autonomy label agrees with wg (contract.json)", () => {
  it("has the same group, levels, and default", () => {
    expect(contract.project_labels).toMatchObject({ autonomy_group: AUTONOMY_GROUP, autonomy_levels: [...AUTONOMY_LEVELS], autonomy_default: AUTONOMY_DEFAULT });
  });
  it("has the same pause and answer labels, and reads the pause only from a plain label", () => {
    expect(contract.project_labels).toMatchObject({ paused: PAUSED_LABEL });
    expect(contract.labels).toMatchObject({ answered: ANSWERED_LABEL });
    expect(pausedOf([{ name: "paused", parent: null }])).toBe(true);
    expect(pausedOf([{ name: "paused", parent: { name: "autonomy" } }])).toBe(false);
    expect(pausedOf(undefined)).toBe(false);
  });
  it("reads the level from the label group, in any case of the group name", () => {
    expect(autonomyOf([{ name: "Tooling", parent: { name: "initiative" } }, { name: "full", parent: { name: "Autonomy" } }])).toBe("full");
    expect(autonomyOf([{ name: "full", parent: null }, { name: "other", parent: { name: "autonomy" } }])).toBeNull();
    expect(autonomyOf(undefined)).toBeNull();
  });
});
