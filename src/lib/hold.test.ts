import { expect, it } from "vitest";
import { checkBody, holdBody, holdEnded, holdFromUpdates, holdText, parseCheck, parseHold, untilTime } from "./hold";
import { projectState } from "./attention";

const input = { waitingFor: "Shopify  app\nreview", until: "2026-12-04", check: "Has Shopify replied?", everyHours: 24 };

it("writes one line for each field and reads them back", () => {
  const body = holdBody(input);
  expect(body).toBe("On hold. Waiting for: Shopify app review\n\nUntil: 2026-12-04\n\nCheck every 24 h: Has Shopify replied?");
  expect(parseHold(body)).toEqual({ ...input, waitingFor: "Shopify app review" });
  expect(parseHold(holdBody({ waitingFor: "Legal", until: null, check: null, everyHours: 24 }))).toEqual({ waitingFor: "Legal", until: null, check: null, everyHours: 24 });
  expect(parseHold("Weekly update: all good")).toBeNull();
});

it("takes the newest hold update and its newest check result", () => {
  const hold = holdFromUpdates([
    { id: "old", body: holdBody({ ...input, waitingFor: "Old" }), createdAt: "2026-11-01T00:00:00Z" },
    { id: "other", body: "Status: on track", createdAt: "2026-11-28T00:00:00Z" },
    { id: "new", body: holdBody(input), createdAt: "2026-11-27T00:00:00Z", comments: [
      { body: checkBody(false, "No reply yet"), createdAt: "2026-11-28T09:00:00Z" },
      { body: "A note from a person", createdAt: "2026-11-29T09:00:00Z" },
      { body: checkBody(true, "Shopify approved the app"), createdAt: "2026-11-29T08:00:00Z" },
    ] },
  ]);
  expect(hold).toMatchObject({ updateId: "new", waitingFor: "Shopify app review", lastCheck: { met: true, evidence: "Shopify approved the app" } });
  expect(holdFromUpdates([{ id: "x", body: "Nothing", createdAt: "2026-11-01T00:00:00Z" }])).toBeNull();
  expect(parseCheck("Check not met: still waiting", "t")).toEqual({ at: "t", met: false, evidence: "still waiting" });
});

const hold = { ...input, waitingFor: "Shopify app review", updateId: "u", at: "2026-11-27T00:00:00Z", lastCheck: null };

it("ends on the until date or on a met check", () => {
  expect(holdEnded(hold, untilTime("2026-12-04") - 1)).toBeNull();
  expect(holdEnded(hold, untilTime("2026-12-04"))).toBe("2026-12-04 came");
  expect(holdEnded({ ...hold, until: null, lastCheck: { at: "t", met: true, evidence: "approved" } }, 0)).toBe("check met: approved");
  expect(holdEnded({ ...hold, until: null, lastCheck: { at: "t", met: false, evidence: "no" } }, Date.now())).toBeNull();
});

it("puts a held project in the held state, and a project whose hold ended in waits", () => {
  const before = untilTime("2026-12-04") - 60_000;
  const project = { statusType: "started", paused: true, hold: { ...hold, lastCheck: { at: new Date(before - 9 * 3_600_000).toISOString(), met: false, evidence: "" } } };
  expect(projectState(null, { now: before, project })).toEqual({ state: "held", reason: `Waiting for Shopify app review · until ${new Date(untilTime("2026-12-04")).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · last check 9h ago: not yet` });
  expect(projectState(null, { now: before, project: { statusType: "started", paused: true, hold: null } })).toEqual({ state: "held", reason: "On hold" });
  expect(projectState(null, { now: untilTime("2026-12-04"), project })).toMatchObject({ state: "waits", reason: "Hold ended · 2026-12-04 came · Resume to let the coordinator act" });
  expect(projectState(null, { now: before, project: { statusType: "completed", hold: null } }).state).toBe("idle");
  expect(holdText({ ...hold, until: null, check: null }, 0)).toBe("Waiting for Shopify app review");
});
