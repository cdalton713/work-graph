import { expect, it } from "vitest";
import { canReleaseClaim, claimMarks, matchesClaim, parseClaimFilter, type Claim } from "./claims";

const claim: Claim = {
  node: "build", holder: "Ada Lovelace", job: "dispatch", mine: true, stale: false,
  claimedAt: "2026-11-26T01:00:00Z", renewedAt: "2026-11-26T01:00:00Z", leaseUntil: "2026-11-26T01:01:00Z",
};

it("uses the server's stale flag for the mark and release control", () => {
  const live = { ...claim, mine: false, leaseUntil: "2000-01-01T00:00:00Z" };
  const stale = { ...live, node: "review", holder: " Éva ", stale: true, leaseUntil: "2099-01-01T00:00:00Z" };
  const marks = claimMarks([live, stale]);
  expect(marks.get("build")).toMatchObject({ initials: "AL", mine: false, stale: false });
  expect(marks.get("review")).toMatchObject({ initials: "É", mine: false, stale: true });
  expect(marks.get("missing")).toBeUndefined();
  expect(canReleaseClaim(marks.get("build"), "owner")).toBe(false);
  expect(canReleaseClaim(marks.get("review"), "owner")).toBe(true);
  expect(canReleaseClaim(stale, "collaborator")).toBe(false);
  expect(canReleaseClaim(stale, "viewer")).toBe(false);
  expect(canReleaseClaim({ ...stale, mine: true }, "owner")).toBe(false);
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
