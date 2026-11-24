import type { AutonomyLevel } from "./lib/autonomy";
import type { ReviewEffort } from "./lib/review";
import { site } from "./lib/site";
import type { OverviewData } from "./lib/overview";
import type { Comment, GraphData, Issue, IssuePatch, ProjectList, ServerStatus } from "./lib/types";

/** The open project. A write names it (`x-project`), so the server can tell its coordinator at once. */
let openProject: string | null = null;
export const setOpenProject = (id: string | null) => { openProject = id; };

async function call<T>(path: string, init?: RequestInit, workspace = site.defaultWorkspace): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json", "x-workspace": workspace };
  if (openProject) headers["x-project"] = openProject;
  const response = await fetch(`/api/${path}`, { ...init, headers });
  if (response.status === 204) return null as T; // the graph did not change
  const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body as T;
}

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
  /** The human's reply to a worker's question; the coordinator sends it to the worker. */
  reply: (projectId: string, askId: string, body: string, workspace?: string) => call<{ ok: boolean; recorded: boolean }>(`projects/${projectId}/asks/${encodeURIComponent(askId)}/reply`, { method: "POST", body: JSON.stringify({ body }) }, workspace),
  update: (issueId: string, patch: IssuePatch, workspace?: string) => call<Issue>(`issues/${issueId}`, { method: "PATCH", body: JSON.stringify(patch) }, workspace),
  comments: (issueId: string, workspace?: string) => call<Comment[]>(`issues/${issueId}/comments`, undefined, workspace),
  comment: (issueId: string, body: string, workspace?: string) => call<Comment>(`issues/${issueId}/comments`, { method: "POST", body: JSON.stringify({ body }) }, workspace),
};
