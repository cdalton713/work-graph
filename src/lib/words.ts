import { site, type Site } from "./site.ts";

export function ownerWords({ human, readOnly }: Pick<Site, "human" | "readOnly"> = site) {
  const owner = readOnly ? human : "you";
  const subject = readOnly ? human : "You";
  const onOwner = `on ${owner}`;
  return {
    owner,
    move: readOnly ? `${human}'s move` : "Your move",
    step: readOnly ? `${human}'s step:` : "Your step:",
    forOwner: `for ${owner}`,
    onOwner,
    waitsFilter: `Waits on ${readOnly ? human : "me"}`,
    clear: `Nothing waits ${onOwner}.`,
    waitReason: `It waits ${onOwner}.`,
    reviewCredit: `${subject} marked this PR reviewed. It counts as the wave review and the merge review.`,
  };
}
