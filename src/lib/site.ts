// The settings of this installation that the page and the server share: the name of the human who answers,
// merges and deploys, and the default Linear workspace. The server reads them from the work-graph config
// (README "Config") and gives them to the page at /api/config. The defaults are those of contract.json.

/** contract.json `human.default`: the name when no config sets one. */
export const DEFAULT_HUMAN = "Human";

/** contract.json `human.slug`: lowercase; each run of other characters than a-z and 0-9 is one `-`. */
export const humanSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export interface Site {
  /** The human's name, for example "Human". */
  human: string;
  waitNames?: readonly string[];
  /** The status of an issue that waits on the human (contract.json `human.status`): "Needs Human". */
  waitStatus: string;
  /** The workspace label that marks that status on an issue of another team (`human.label`): "needs-human". */
  waitLabel: string;
  /** The workspace of a link or a request that names none: the first configured workspace. */
  defaultWorkspace: string;
  /** The viewer: the page shows no edit control and no command, and opens no link. */
  readOnly: boolean;
  /** The email of the session, on a page with a sign-in. */
  user: string | null;
}

export function createSite(human: string, defaultWorkspace: string, readOnly = false, user: string | null = null): Site {
  return { human, waitStatus: `Needs ${human}`, waitLabel: `needs-${humanSlug(human)}`, defaultWorkspace, readOnly, user };
}

/** The page settings. Change them only with `configureSite`, before the first render. */
export const site: Site = createSite(DEFAULT_HUMAN, "default");

export function configureSite({ human, defaultWorkspace, readOnly, user }: { human?: string; defaultWorkspace?: string; readOnly?: boolean; user?: string | null }) {
  Object.assign(site, createSite(human ?? site.human, defaultWorkspace ?? site.defaultWorkspace, readOnly ?? site.readOnly, user === undefined ? site.user : user));
}

let siteSource: (() => Site | undefined) | undefined;

export const currentSite = (): Site => siteSource?.() ?? site;

/** Let the server supply the site of the current async context. */
export function setSiteSource(source: () => Site | undefined): void {
  siteSource = source;
}

/** The statuses in the order of a project's flow, for the counts. */
export const waitStatuses = (settings = currentSite()) => (settings.waitNames ?? [settings.human])
  .map((name) => ({ name, status: `Needs ${name}`, label: `needs-${humanSlug(name)}` }));

export const statusOrder = (settings = currentSite()) => ["Triage", "Backlog", "Todo", "Ready", "In Progress",
  ...waitStatuses(settings).map(({ status }) => status), "In Review",
  "Ready to Merge", "Merged", "Verifying", "Done", "Canceled"];

// The server gives the link path with the signed-in role. Older servers use the default path for the full page.
export const pageLink = { path: "/api/link" as string | null };

export const signInSettings: { provider?: "linear" } = {};
