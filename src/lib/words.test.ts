import { describe, expect, it } from "vitest";
import { ownerWords } from "./words";

describe("owner wording", () => {
  it("keeps the full page wording", () => {
    expect(ownerWords({ human: "Ada", readOnly: false })).toMatchObject({
      move: "Your move", step: "Your step:", forOwner: "for you",
      onOwner: "on you", waitsFilter: "Waits on you",
    });
  });

  it("names the configured owner in the viewer", () => {
    expect(ownerWords({ human: "Ada", readOnly: true })).toMatchObject({
      move: "Ada's move", step: "Ada's step:", forOwner: "for Ada",
      onOwner: "on Ada", waitsFilter: "Waits on Ada",
    });
  });
});
