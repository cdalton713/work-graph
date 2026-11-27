// A hold: the human puts an effort on hold while it waits on an outside party. The plain project label
// `on-hold` is the record that the effort is held; the hold also sets `paused`, so the coordinator holds each
// action. A Linear project update holds the details, and `wg tick` replies on it with each changed check result.

/** The plain project label of a held effort (contract.json `project_labels`). */
export const HOLD_LABEL = "on-hold";
/** The check interval of a hold that names none. */
export const HOLD_EVERY_DEFAULT = 24;

export interface HoldCheck { at: string; met: boolean; evidence: string }
export interface Hold {
  /** The outside party or event that the effort waits for. */
  waitingFor: string;
  /** The date (YYYY-MM-DD) on which the hold ends, or null. */
  until: string | null;
  /** The question that an agent answers on each check, or null: no agent check. */
  check: string | null;
  /** Hours between two checks. */
  everyHours: number;
  /** The project update that holds the details, and when it was made. */
  updateId: string; at: string;
  /** The newest check result, or null: no check ran. */
  lastCheck: HoldCheck | null;
}
export type HoldInput = Pick<Hold, "waitingFor" | "until" | "check" | "everyHours">;

/** Does the project have the hold label? A child of a label group with that name does not count. */
export const holdOf = (labels: { name: string; parent: { name: string } | null }[] | undefined): boolean =>
  !!labels?.some((l) => !l.parent && l.name === HOLD_LABEL);

const line = (text: string) => text.replace(/\s+/g, " ").trim();
const FIRST = /^On hold\. Waiting for: (.+)$/;
const UNTIL = /^Until: (\d{4}-\d{2}-\d{2})$/;
const CHECK = /^Check every (\d+) h: (.+)$/;
const RESULT = /^Check (met|not met): ?(.*)$/;

/** The body of the project update for a hold. One line for each field, so Linear's Markdown keeps them. */
export function holdBody(hold: HoldInput): string {
  return [
    `On hold. Waiting for: ${line(hold.waitingFor)}`,
    hold.until && `Until: ${hold.until}`,
    hold.check && `Check every ${hold.everyHours} h: ${line(hold.check)}`,
  ].filter(Boolean).join("\n\n");
}

/** The hold fields of a project update body, or null when the update is not a hold. */
export function parseHold(body: string): HoldInput | null {
  const lines = body.split("\n").map((l) => l.replace(/\\/g, "").trim()).filter(Boolean);
  const first = lines[0]?.match(FIRST);
  if (!first) return null;
  let until: string | null = null, check: string | null = null, everyHours = HOLD_EVERY_DEFAULT;
  for (const l of lines.slice(1)) {
    const u = l.match(UNTIL);
    if (u) until = u[1];
    const c = l.match(CHECK);
    if (c) { everyHours = Math.max(1, Number(c[1])); check = c[2]; }
  }
  return { waitingFor: first[1], until, check, everyHours };
}

/** The result of one check, from the body of a reply on the hold update, or null when it is not a result. */
export function parseCheck(body: string, at: string): HoldCheck | null {
  const m = body.trim().match(RESULT);
  return m ? { at, met: m[1] === "met", evidence: line(m[2]) } : null;
}

/** The body of a reply with a check result. */
export const checkBody = (met: boolean, evidence: string) => `Check ${met ? "met" : "not met"}: ${line(evidence)}`;

/** The hold of a project from its updates and their replies: the newest hold update, and its newest result. */
export function holdFromUpdates(updates: { id: string; body: string; createdAt: string; comments?: { body: string; createdAt: string }[] }[]): Hold | null {
  const update = [...updates].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).find((u) => parseHold(u.body));
  if (!update) return null;
  const lastCheck = (update.comments ?? []).map((c) => parseCheck(c.body, c.createdAt))
    .filter((c): c is HoldCheck => !!c).sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
  return { ...parseHold(update.body)!, updateId: update.id, at: update.createdAt, lastCheck };
}

/** The start of the until date in local time, in ms. */
export function untilTime(until: string): number {
  const [y, m, d] = until.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}

/** Why the hold ended, or null while it holds. A met check or the until date ends it. */
export function holdEnded(hold: Hold, now: number): string | null {
  if (hold.lastCheck?.met) return `check met${hold.lastCheck.evidence ? `: ${hold.lastCheck.evidence}` : ""}`;
  if (hold.until && now >= untilTime(hold.until)) return `${hold.until} came`;
  return null;
}

const DAY = 86_400_000;
const shortDate = (until: string) => new Date(untilTime(until)).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** One line for a held project row: what it waits for, until when, and the last check. */
export function holdText(hold: Hold, now: number): string {
  const check = hold.lastCheck;
  const age = check && Math.max(0, now - Date.parse(check.at));
  const ago = age === null ? "" : age < 3_600_000 ? `${Math.max(1, Math.round(age / 60_000))}m ago`
    : age < DAY ? `${Math.round(age / 3_600_000)}h ago` : `${Math.round(age / DAY)}d ago`;
  return [
    `Waiting for ${hold.waitingFor}`,
    hold.until && `until ${shortDate(hold.until)}`,
    hold.check && (check ? `last check ${ago}: ${check.met ? "met" : "not yet"}` : "no check yet"),
  ].filter(Boolean).join(" · ");
}
