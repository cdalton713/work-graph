// The review effort of an effort (work-graph review-and-merge.md "Review effort"): one child label of the
// single-select project label group `review`. contract.json `project_labels` must hold the same names.

export const REVIEW_GROUP = "review";
export const REVIEW_LEVELS = ["thorough", "standard", "light"] as const;
export type ReviewEffort = (typeof REVIEW_LEVELS)[number];
/** The review effort of a project with no review label. */
export const REVIEW_DEFAULT: ReviewEffort = "thorough";
/** A workspace has one project label for each name, and the group `autonomy` has `standard`: the child labels are `review:<level>`. */
export const REVIEW_PREFIX = "review:";

/** What each level asks of the reviews, for the menu. */
export const REVIEW_HINTS: Record<ReviewEffort, string> = {
  thorough: "2 agent rounds, then a merge review",
  standard: "1 agent round, coordinator checks the fix",
  light: "the coordinator reads the diff",
};

export const isReviewEffort = (value: unknown): value is ReviewEffort =>
  typeof value === "string" && (REVIEW_LEVELS as readonly string[]).includes(value);

/** The child label of the group `review` for `level`. */
export const reviewLabel = (level: ReviewEffort): string => `${REVIEW_PREFIX}${level}`;

/** The review effort of a child label of the group `review`, or null. An old label without the prefix is still that level. */
export function reviewLabelLevel(name: string): ReviewEffort | null {
  const level = name.startsWith(REVIEW_PREFIX) ? name.slice(REVIEW_PREFIX.length) : name;
  return isReviewEffort(level) ? level : null;
}

/** The review effort label of a project, or null when it has none. */
export function reviewOf(labels: { name: string; parent: { name: string } | null }[] | undefined): ReviewEffort | null {
  for (const label of labels ?? []) {
    const level = label.parent?.name.toLowerCase() === REVIEW_GROUP ? reviewLabelLevel(label.name) : null;
    if (level) return level;
  }
  return null;
}
