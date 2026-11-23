import { describe, expect, it } from "vitest";
import contract from "../../skills/work-graph/contract.json";
import { ANSWERED_LABEL, AUTONOMY_DEFAULT, AUTONOMY_GROUP, AUTONOMY_LEVELS, autonomyOf, PAUSED_LABEL, pausedOf } from "./autonomy";
import { type CoordinatorPresence, LINK_COMMANDS, LINK_FROM_COORDINATOR, LINK_TO_COORDINATOR, LINK_VERSION, liveJob, presenceText } from "./link";

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
