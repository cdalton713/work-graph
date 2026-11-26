import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_HUMAN } from "../src/lib/site.ts";
import type { Auth } from "./auth.ts";

export interface Workspace {
  id: string;
  name: string;
  team: string;
  key: string;
  connectionId?: string;
  organizationId?: string;
  kind?: "api_key" | "oauth";
  oauthKey?: (rejected?: string) => Promise<string>;
  needsKey?: boolean;
  rejectApiKey?: () => Promise<void>;
  /** Project labels are per team (Linear's Business plan). False: workspace labels. */
  teamLabels: boolean;
  /** The address of the read-only viewer of this workspace (`share_url`), with no `/` at its end. None: no viewer. */
  shareUrl?: string;
}

/** The part of the work-graph config (README "Config") that the server uses. wg.py reads the same file. */
export interface Config {
  human: string;
  workspaces: Workspace[];
  /** The sign-in of a hosted viewer (config `auth`). None: the page has no sign-in. */
  auth?: Auth;
}

interface WorkspaceEntry { id: string; name?: string; team?: string | null; key_env?: string[]; team_labels?: boolean; share_url?: string }

export const linearWorkspace = new AsyncLocalStorage<Workspace>();

const readText = (path: string) => {
  try { return readFileSync(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
};

/** A DNS name, as the `hd` claim of a Google Workspace account gives it. */
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/**
 * The sign-in of the config: `auth.domains` names who may sign in, and the environment gives the secrets
 * (`WG_AUTH_CLIENT_ID`, `WG_AUTH_CLIENT_SECRET`, `WG_SESSION_SECRET`). It throws when a part is missing: a config
 * that asks for a sign-in must not give a page without one.
 */
function readAuth(auth: { domains?: unknown; owners?: unknown }, env: NodeJS.ProcessEnv): Auth {
  const domains = Array.isArray(auth.domains) ? auth.domains.map((d) => String(d).trim().toLowerCase()) : [];
  if (!domains.length || !domains.every((d) => DOMAIN.test(d))) throw new Error("auth.domains must name one domain or more, for example [\"example.com\"]");
  const ownerAddresses = auth.owners ?? [];
  if (!Array.isArray(ownerAddresses) || !ownerAddresses.every((email) =>
    typeof email === "string" && /^[^@\s]+@[^@\s]+$/.test(email.trim()) && domains.includes(email.trim().toLowerCase().split("@")[1]))) {
    throw new Error("auth.owners must list email addresses in auth.domains");
  }
  const owners = ownerAddresses.map((email: string) => email.trim().toLowerCase());
  const need = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`the sign-in needs ${name} in the environment`);
    return value;
  };
  const secret = need("WG_SESSION_SECRET");
  if (secret.length < 32) throw new Error("WG_SESSION_SECRET must have 32 characters or more");
  return { domains, ...(owners.length ? { owners } : {}), clientId: need("WG_AUTH_CLIENT_ID"), clientSecret: need("WG_AUTH_CLIENT_SECRET"), secret };
}

/**
 * The config from `WG_CONFIG_JSON` (its text, for a container), the file `WG_CONFIG`, or
 * ~/.config/work-graph/config.json. No config: one workspace "default" with `LINEAR_API_KEY` and `team` (--team).
 * A workspace's key is LINEAR_<ID>_API_KEY, one of its `key_env` names, or ~/.config/work-graph/<id>-linear-api-key.
 * A workspace without a key is left out, except the first one.
 */
export function readConfig(team: string | undefined, env: NodeJS.ProcessEnv = process.env, home = homedir()): Config {
  const dir = join(home, ".config/work-graph");
  const text = env.WG_CONFIG_JSON ?? readText(env.WG_CONFIG ?? join(dir, "config.json"));
  const data = (text ? JSON.parse(text) : {}) as { human?: string; workspaces?: WorkspaceEntry[]; auth?: { domains?: unknown; owners?: unknown } };
  const entries: WorkspaceEntry[] = data.workspaces?.length ? data.workspaces
    : [{ id: "default", name: "Linear", team: null, key_env: ["LINEAR_API_KEY"], team_labels: true }];
  const workspaces = entries.map((w, at) => {
    const names = [`LINEAR_${w.id.toUpperCase().replaceAll("-", "_")}_API_KEY`, ...(w.key_env ?? ["LINEAR_API_KEY"])];
    const fromEnv = names.map((name) => env[name]?.trim()).find(Boolean);
    const key = fromEnv ?? readText(join(dir, `${w.id}-linear-api-key`))?.trim() ?? "";
    const teamKey = w.team ?? team;
    if (!teamKey) throw new Error(`workspace ${w.id} has no team: set "team" in the work-graph config, or pass --team`);
    return { at, workspace: { id: w.id, name: w.name ?? w.id, team: teamKey, key, teamLabels: w.team_labels ?? true, ...(w.share_url ? { shareUrl: w.share_url.replace(/\/+$/, "") } : {}) } };
  });
  return {
    human: data.human ?? DEFAULT_HUMAN,
    workspaces: workspaces.filter(({ at, workspace }) => at === 0 || workspace.key).map(({ workspace }) => workspace),
    ...(data.auth ? { auth: readAuth(data.auth, env) } : {}),
  };
}
