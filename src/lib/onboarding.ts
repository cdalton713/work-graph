import type { Account, OnboardingState } from "./types";

export const steps = [
  { id: "name", label: "Your name" },
  { id: "workspaces", label: "Linear workspaces" },
  { id: "teams", label: "Teams" },
  { id: "setup", label: "Set up wg" },
  { id: "connect", label: "Connect" },
] as const;

export type Step = (typeof steps)[number]["id"];
export type NewTeam = { key: string; name: string };
export type NewTeams = Record<string, NewTeam>;
type SetupAccount = Pick<Account, "human" | "pageUrl" | "connections">;

export function doneSteps({ name, workspaces, teams, token, connected }: OnboardingState): Record<Step, boolean> {
  return { name, workspaces, teams, setup: token, connect: connected };
}

export function firstStep(state: OnboardingState): Step | null {
  if (state.skipped) return null;
  const done = doneSteps(state);
  return steps.find(({ id }) => !done[id])?.id ?? null;
}

export function configBlock({ human, connections, pageUrl }: SetupAccount, drafts: NewTeams): string {
  return JSON.stringify({
    human,
    page_url: pageUrl,
    workspaces: connections.map((workspace) => ({
      id: workspace.workspace_id,
      team: drafts[workspace.id]?.key ?? workspace.team,
      page_url: pageUrl,
      team_labels: workspace.team_labels,
      key_env: [],
    })),
  }, null, 2);
}

function shellArg(value: string): string {
  return /^[a-zA-Z0-9_./:-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'";
}

export function setupCommands({ connections, pageUrl }: SetupAccount, drafts: NewTeams): string[] {
  return [
    `wg login ${shellArg(pageUrl)}`,
    ...connections.map(({ id, workspace_id }) => {
      const draft = drafts[id];
      return `wg setup --workspace ${shellArg(workspace_id)} --apply${draft ? ` --name ${shellArg(draft.name)}` : ""}`;
    }),
    "wg doctor",
  ];
}

export function validateNewTeam(key: string, name: string): NewTeam | null {
  if (/\p{Cc}|\p{Cs}/u.test(key + name)) return null;
  key = key.trim().toUpperCase();
  name = name.trim();
  return /^[A-Z][A-Z0-9]{0,6}$/.test(key) && name && [...name].length <= 80 ? { key, name } : null;
}

export function workspaceKeyLocation(id: string) {
  return {
    env: `LINEAR_${id.toUpperCase().replaceAll("-", "_")}_API_KEY`,
    file: `~/.config/work-graph/${id}-linear-api-key`,
  };
}

export function pollWhileVisible(
  page: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">,
  poll: () => void,
): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  const tick = () => {
    if (page.visibilityState === "visible") poll();
  };
  const sync = () => {
    clearInterval(timer);
    if (page.visibilityState === "visible") {
      tick();
      timer = setInterval(tick, 5000);
    }
  };
  page.addEventListener("visibilitychange", sync);
  sync();
  return () => {
    page.removeEventListener("visibilitychange", sync);
    clearInterval(timer);
  };
}
