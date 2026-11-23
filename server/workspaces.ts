import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_HUMAN } from "../src/lib/site.ts";

export interface Workspace {
  id: string;
  name: string;
  team: string;
  key: string;
  /** Project labels are per team (Linear's Business plan). False: workspace labels. */
  teamLabels: boolean;
}

/** The part of the work-graph config (README "Config") that the server uses. wg.py reads the same file. */
export interface Config {
  human: string;
  workspaces: Workspace[];
}

interface WorkspaceEntry { id: string; name?: string; team?: string | null; key_env?: string[]; team_labels?: boolean }

export const linearWorkspace = new AsyncLocalStorage<Workspace>();

const readText = (path: string) => {
  try { return readFileSync(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
};

/**
 * The config from `WG_CONFIG_JSON` (its text, for a container), the file `WG_CONFIG`, or
 * ~/.config/work-graph/config.json. No config: one workspace "default" with `LINEAR_API_KEY` and `team` (--team).
 * A workspace's key is LINEAR_<ID>_API_KEY, one of its `key_env` names, or ~/.config/work-graph/<id>-linear-api-key.
 * A workspace without a key is left out, except the first one.
 */
export function readConfig(team: string | undefined, env: NodeJS.ProcessEnv = process.env, home = homedir()): Config {
  const dir = join(home, ".config/work-graph");
  const text = env.WG_CONFIG_JSON ?? readText(env.WG_CONFIG ?? join(dir, "config.json"));
  const data = (text ? JSON.parse(text) : {}) as { human?: string; workspaces?: WorkspaceEntry[] };
  const entries: WorkspaceEntry[] = data.workspaces?.length ? data.workspaces
    : [{ id: "default", name: "Linear", team: null, key_env: ["LINEAR_API_KEY"], team_labels: true }];
  const workspaces = entries.map((w, at) => {
    const names = [`LINEAR_${w.id.toUpperCase().replaceAll("-", "_")}_API_KEY`, ...(w.key_env ?? ["LINEAR_API_KEY"])];
    const fromEnv = names.map((name) => env[name]?.trim()).find(Boolean);
    const key = fromEnv ?? readText(join(dir, `${w.id}-linear-api-key`))?.trim() ?? "";
    const teamKey = w.team ?? team;
    if (!teamKey) throw new Error(`workspace ${w.id} has no team: set "team" in the work-graph config, or pass --team`);
    return { at, workspace: { id: w.id, name: w.name ?? w.id, team: teamKey, key, teamLabels: w.team_labels ?? true } };
  });
  return {
    human: data.human ?? DEFAULT_HUMAN,
    workspaces: workspaces.filter(({ at, workspace }) => at === 0 || workspace.key).map(({ workspace }) => workspace),
  };
}
