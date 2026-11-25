import type { AutonomyLevel } from "./lib/autonomy";
import type { ReviewEffort } from "./lib/review";
import { site } from "./lib/site";
import type { OverviewData } from "./lib/overview";
import type { Account, AccountTeam, Comment, GraphData, Issue, IssuePatch, ProjectList, ServerStatus } from "./lib/types";

/** The open project. A write names it (`x-project`), so the server can tell its coordinator at once. */
let openProject: string | null = null;
export const setOpenProject = (id: string | null) => { openProject = id; };

let reloading = false;

async function call<T>(path: string, init?: RequestInit, workspace = site.defaultWorkspace): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json", "x-workspace": workspace };
  if (openProject) headers["x-project"] = openProject;
  const method = init?.method?.toUpperCase() ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    // Keep the same headers if this request is retried.
    headers["Idempotency-Key"] = Array.from(crypto.getRandomValues(new Uint8Array(16)),
      (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  const response = await fetch(`/api/${path}`, { ...init, headers });
  if (response.status === 204) return null as T; // the graph did not change
  const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  // The session ended: load the page again, which shows the sign-in screen. One time, so a server fault makes no loop.
  if (response.status === 401 && body.login && !reloading) {
    reloading = true;
    location.reload();
  }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body as T;
}

function accountWrite<T>(path: string, method: string, data?: object) {
  return call<T>(`account${path}`, { method, body: data && JSON.stringify(data) });
}

export const accountApi = {
  read: (signal?: AbortSignal) => call<Account>("account", { signal }),
  saveName: (human: string) => accountWrite("", "PATCH", { human }),
  onboarding: (state: { name?: true; skipped?: boolean }) => accountWrite("/onboarding", "POST", state),
  attach: (key: string) => accountWrite("/workspaces", "POST", { key }),
  replace: (id: string, key: string) => accountWrite(`/workspaces/${id}/key`, "PUT", { key }),
  teams: async (id: string, signal?: AbortSignal) =>
    (await call<{ teams: AccountTeam[] }>(`account/workspaces/${id}/teams`, { signal })).teams,
  updateWorkspace: (id: string, settings: { team?: string; team_labels?: boolean; position?: number }) =>
    accountWrite(`/workspaces/${id}`, "PATCH", settings),
  removeWorkspace: (id: string) => accountWrite(`/workspaces/${id}`, "DELETE"),
  makeToken: (name: string) => accountWrite<{ token: string }>("/tokens", "POST", { name }),
  revokeToken: (id: string) => accountWrite(`/tokens/${id}`, "DELETE"),
  delete: () => accountWrite<{ message?: string }>("", "DELETE", { confirm: "delete" }),
};

export const api = {
  closeProject: (projectId: string, workspace?: string) => call<{ completedIssues: number }>(`projects/${projectId}/close`, { method: "POST", body: JSON.stringify({ confirm: true }) }, workspace),
  projects: () => call<ProjectList>("projects"),
  /** The state of the server: its build and the Linear budget of each workspace. */
  status: () => call<ServerStatus>("status"),
  /** The projects, with a summary of each open one. */
  overview: () => call<OverviewData>("overview"),
  /** The graph with its version, or null when the page already has version `have`. */
  graph: (projectId: string, have?: string, workspace?: string) => call<(GraphData & { version: string }) | null>(`projects/${projectId}/graph${have ? `?have=${have}` : ""}`, undefined, workspace),
  /** A command for the coordinator of the project. */
  command: (projectId: string, command: { name: "next" | "dispatch" | "pause" | "resume"; key?: string; issue?: string }, workspace?: string) =>
    call<{ ok: boolean; queued: number }>(`projects/${projectId}/commands`, { method: "POST", body: JSON.stringify(command) }, workspace),
  /** Set the autonomy level of the project; the coordinator gets it at once. */
  autonomy: (projectId: string, level: AutonomyLevel, workspace?: string) =>
    call<{ ok: boolean; level: AutonomyLevel; queued: number }>(`projects/${projectId}/autonomy`, { method: "POST", body: JSON.stringify({ level }) }, workspace),
  /** Set the review effort of the project; the coordinator gets it at once. */
  reviewEffort: (projectId: string, level: ReviewEffort, workspace?: string) =>
    call<{ ok: boolean; level: ReviewEffort; queued: number }>(`projects/${projectId}/review-effort`, { method: "POST", body: JSON.stringify({ level }) }, workspace),
  /** Share the project with the read-only viewer, or stop that (the project label `shared`). */
  share: (projectId: string, shared: boolean, workspace?: string) =>
    call<{ ok: boolean; shared: boolean }>(`projects/${projectId}/share`, { method: "POST", body: JSON.stringify({ shared }) }, workspace),
  /** The human's reply to a worker's question; the coordinator sends it to the worker. */
  reply: (projectId: string, askId: string, body: string, workspace?: string) => call<{ ok: boolean; recorded: boolean }>(`projects/${projectId}/asks/${encodeURIComponent(askId)}/reply`, { method: "POST", body: JSON.stringify({ body }) }, workspace),
  update: (issueId: string, patch: IssuePatch, workspace?: string) => call<Issue>(`issues/${issueId}`, { method: "PATCH", body: JSON.stringify(patch) }, workspace),
  comments: (issueId: string, workspace?: string) => call<Comment[]>(`issues/${issueId}/comments`, undefined, workspace),
  comment: (issueId: string, body: string, workspace?: string) => call<Comment>(`issues/${issueId}/comments`, { method: "POST", body: JSON.stringify({ body }) }, workspace),
};
