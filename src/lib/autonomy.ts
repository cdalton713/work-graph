// The autonomy level of an effort (work-graph SKILL.md "Autonomy level"): one child label of the single-select
// project label group `autonomy`. contract.json `project_labels` must hold the same names.

export const AUTONOMY_GROUP = "autonomy";
export const AUTONOMY_LEVELS = ["full", "standard", "supervised"] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];
/** The level of a project with no autonomy label. */
export const AUTONOMY_DEFAULT: AutonomyLevel = "standard";

/** What each level leaves to the human, for the menu. */
export const AUTONOMY_HINTS: Record<AutonomyLevel, string> = {
  full: "agent decides, merges own repos",
  standard: "you merge, decide, run ops",
  supervised: "you also approve graph, waves, PRs",
};

export const isAutonomy = (value: unknown): value is AutonomyLevel =>
  typeof value === "string" && (AUTONOMY_LEVELS as readonly string[]).includes(value);

/** The level label of a project, or null when it has none. */
export function autonomyOf(labels: { name: string; parent: { name: string } | null }[] | undefined): AutonomyLevel | null {
  const label = labels?.find((l) => l.parent?.name.toLowerCase() === AUTONOMY_GROUP && isAutonomy(l.name));
  return label ? (label.name as AutonomyLevel) : null;
}

/** The plain project label that pauses an effort (contract.json `project_labels.paused`). Present: paused. */
export const PAUSED_LABEL = "paused";
/** The issue label that marks the human's answer from the page on a Needs <human> issue (contract.json `labels.answered`). */
export const ANSWERED_LABEL = "answered";

/** Does the project have the pause label? */
export const pausedOf = (labels: { name: string; parent: { name: string } | null }[] | undefined): boolean =>
  !!labels?.some((l) => !l.parent && l.name === PAUSED_LABEL);

/** The plain project label that shares a project with the viewer (README "Host a read-only viewer"). */
export const SHARED_LABEL = "shared";
/** True when the project has the plain label `shared`. A child of a label group with that name does not count. */
export const sharedOf = (labels: { name: string; parent: { name: string } | null }[] | undefined): boolean =>
  !!labels?.some((l) => !l.parent && l.name === SHARED_LABEL);
