import { expect, it } from "vitest";
import { claimMarks, matchesClaim, parseClaimFilter, type Claim } from "./claims";

const claim: Claim = {
  node: "build", holder: "Ada Lovelace", job: "dispatch", mine: true, stale: false,
  claimedAt: "2026-11-26T01:00:00Z", renewedAt: "2026-11-26T01:00:00Z", leaseUntil: "2026-11-26T01:01:00Z",
};

it("looks up the runner by node key and marks an elapsed lease", () => {
  const marks = claimMarks([claim, { ...claim, node: "review", holder: " Éva ", mine: false }], Date.parse(claim.leaseUntil));
  expect(marks.get("build")).toMatchObject({ initials: "AL", mine: true, stale: true });
  expect(marks.get("review")).toMatchObject({ initials: "É", mine: false });
  expect(marks.get("missing")).toBeUndefined();
  expect(claimMarks([claim], Date.parse(claim.claimedAt)).get("build")?.stale).toBe(false);
});

it("filters only when the claim identifies the caller as its holder or another person", () => {
  expect(matchesClaim(claim, "mine")).toBe(true);
  expect(matchesClaim(claim, "theirs")).toBe(false);
  expect(matchesClaim({ ...claim, mine: false }, "theirs")).toBe(true);
  expect(matchesClaim({ ...claim, mine: undefined }, "theirs")).toBe(false);
  expect(matchesClaim(undefined, "all")).toBe(true);
  expect(matchesClaim(undefined, "mine")).toBe(false);
  expect(parseClaimFilter("theirs")).toBe("theirs");
  expect(parseClaimFilter("unknown")).toBe("all");
});
