import type { Account, OnboardingState } from "./types";

export const steps = [
  { id: "welcome", label: "Welcome" },
  { id: "name", label: "Your name" },
  { id: "workspaces", label: "Linear workspaces" },
  { id: "teams", label: "Team" },
  { id: "statuses", label: "Statuses and labels" },
  { id: "setup", label: "Install wg" },
  { id: "connect", label: "Connect" },
] as const;

export type Step = (typeof steps)[number]["id"];
export type NewTeam = { key: string; name: string };
export type NewTeams = Record<string, NewTeam>;
type SetupAccount = Pick<Account, "human" | "pageUrl" | "connections">;

export function doneSteps({ name, workspaces, teams, token, connected }: OnboardingState, statuses = false): Record<Step, boolean> {
  return { welcome: name || token || connected, name, workspaces, teams, statuses, setup: token, connect: connected };
}

export function firstStep(state: OnboardingState, statuses?: boolean): Step | null {
  if (state.skipped) return null;
  // Account-only callers can route before the team setup check returns.
  const done = doneSteps(state, statuses ?? true);
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

export function setupCommands({ connections, pageUrl }: SetupAccount, drafts: NewTeams): [string, ...string[], string] {
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

/** First and last initials ("CD" for Christian Dalton), else a variant that no team in `taken` uses. */
export function defaultTeamKey(human: string, taken: string[]): string {
  const initials = human.toUpperCase().match(/\b[A-Z]/g) ?? [];
  const short = initials.length > 1 ? initials[0]! + initials.at(-1)! : initials[0] ?? "";
  return [short, short + "WG", "WG", "WG" + short].find(k => k && validateNewTeam(k, "x") && !taken.includes(k)) ?? "";
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

export const statusMeanings: Record<string, [string, string]> = {
  Triage: ["New work needs a decision.", "Worker"],
  Backlog: ["Work is deferred.", "You"],
  Todo: ["The issue needs a specification or has open blockers.", "Coordinator"],
  Ready: ["All blockers are closed. Work can start.", "Coordinator"],
  "In Progress": ["A worker has started the issue.", "Coordinator"],
  "Needs {name}": ["Work waits for your answer or action.", "Worker"],
  "In Review": ["The pull request is open for review.", "Worker"],
  "Ready to Merge": ["Checks passed and review is complete.", "Worker"],
  Merged: ["The change is merged and waits for deployment.", "Worker"],
  Verifying: ["Checks are running after deployment.", "Coordinator"],
  Done: ["The change meets its acceptance criteria.", "Coordinator"],
  Canceled: ["Work stopped on this issue.", "You"],
  Duplicate: ["Another issue tracks the same work.", "Linear"],
};

export function installBlock(commands: ReturnType<typeof setupCommands>): string {
  const setup = commands.slice(1, -1);
  // Login reads the token from the terminal. Leave no pasted command after its line.
  const loginAndDoctor = commands[0] + " && " + commands.at(-1);
  return [...setup, loginAndDoctor].join("\n");
}
