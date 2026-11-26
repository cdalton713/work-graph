import { currentSite, type Site } from "./site.ts";

export function ownerWords({ human, readOnly }: Pick<Site, "human" | "readOnly"> = currentSite()) {
  const owner = readOnly ? human : "you";
  const subject = readOnly ? human : "You";
  const onOwner = `on ${owner}`;
  return {
    owner,
    move: readOnly ? `${human}'s move` : "Your move",
    step: readOnly ? `${human}'s step:` : "Your step:",
    forOwner: `for ${owner}`,
    onOwner,
    waitsFilter: `Waits ${onOwner}`,
    clear: `Nothing waits ${onOwner}.`,
    waitReason: `It waits ${onOwner}.`,
    reviewCredit: `${subject} marked this PR reviewed. It counts as the wave review and the merge review.`,
  };
}

export const summaryWords = ownerWords({ human: "", readOnly: false });

/** Adapt the generated parts of a reason from an overview response for display. */
export function overviewMoveReason(reason: string): string {
  if (!currentSite().readOnly) return reason;
  const words = ownerWords();
  if (reason === summaryWords.step.slice(0, -1)) return words.step.slice(0, -1);
  return reason
    .replaceAll(summaryWords.waitReason, () => words.waitReason)
    .replaceAll(summaryWords.step, () => words.step);
}
