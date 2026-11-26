import type { ProjectClaims } from "./lib/claims";
import type { Ask, Presence } from "./lib/link";
import type { AutonomyLevel } from "./lib/autonomy";
import type { ReviewEffort } from "./lib/review";
import { pageEvent, type PageEvent } from "./lib/telemetry";
import { site } from "./lib/site";
import type { OverviewData } from "./lib/overview";
import type { StarterResult, Account, AccountTeam, Comment, GraphData, Issue, IssuePatch, ProjectJoin, ProjectJoinPreview, ProjectList, ProjectShare, NewShareLink, ShareKind, ShareMember, LinearAccess, AccessGrant, ServerStatus } from "./lib/types";

/** The open project. A write names it (`x-project`), so the server can tell its coordinator at once. */
let openProject: string | null = null;
export const setOpenProject = (id: string | null) => { openProject = id; };

let reloading = false;

export const linearAccessRequired = "wg-linear-access-required";

type ErrorBody = { error?: string; status?: string; settingsUrl?: string };

class ApiError extends Error {
  readonly status: number;
  readonly body: ErrorBody;

  constructor(status: number, body: ErrorBody) {
    super(body.error ?? `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

function projectPath(id: string) {
  return `projects/${encodeURIComponent(id)}`;
}

function shareWrite<T>(path: string, workspace: string, method: string, body?: object) {
  return call<T>(path, { method, body: body && JSON.stringify(body) }, workspace);
}

export const shareApi = {
  async read(id: string, workspace: string, signal?: AbortSignal): Promise<ProjectShare> {
    try {
      return await call<ProjectShare>(`${projectPath(id)}/share`, { signal }, workspace);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        return { view: { exists: false }, collab: { exists: false }, members: [] };
      }
      throw error;
    }
  },
  make: (id: string, workspace: string, kind: ShareKind) =>
    shareWrite<NewShareLink>(`${projectPath(id)}/share/${kind}`, workspace, "POST"),
  rotate: (id: string, workspace: string, kind: ShareKind) =>
    shareWrite<{ url: string }>(`${projectPath(id)}/share/${kind}/rotate`, workspace, "POST"),
  revoke: (id: string, workspace: string, kind: ShareKind) =>
    shareWrite<null>(`${projectPath(id)}/share/${kind}`, workspace, "DELETE"),
  changeRole: (id: string, workspace: string, member: string, role: ShareMember["role"]) =>
    shareWrite<null>(`${projectPath(id)}/members/${member}`, workspace, "PATCH", { role }),
  remove: (id: string, workspace: string, member: string) =>
    shareWrite<null>(`${projectPath(id)}/members/${member}`, workspace, "DELETE"),
  async addAccess(id: string, workspace: string, member: string, invite: boolean) {
    try {
      return await shareWrite<AccessGrant>(`${projectPath(id)}/members/${member}/access`, workspace, "POST", { invite });
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 409 && error.body.status === "invite_required") return { status: "invite_required" } as const;
        if (error.status === 403 && error.body.settingsUrl) {
          return { status: "refused", reason: error.message, settingsUrl: error.body.settingsUrl } as const;
        }
      }
      throw error;
    }
  },
  access: (id: string, workspace: string, signal?: AbortSignal) =>
    call<LinearAccess>(`${projectPath(id)}/access`, { signal }, workspace),
  requestAccess: (id: string, workspace: string) =>
    shareWrite<null>(`${projectPath(id)}/access/request`, workspace, "POST"),
};

async function call<T>(path: string, init?: RequestInit, workspace = site.defaultWorkspace, event?: PageEvent, project = openProject, idempotencyKey?: string): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json", "x-workspace": workspace };
  if (project && !(site.user && workspace.startsWith("shared:"))) headers["x-project"] = project;
  const method = init?.method?.toUpperCase() ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    // Keep the same headers if this request is retried.
    headers["Idempotency-Key"] = idempotencyKey ?? Array.from(crypto.getRandomValues(new Uint8Array(16)),
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
  if (!response.ok) {
    if (response.status === 403 && body.code === "needs_linear_access" && method !== "GET" && method !== "HEAD") {
      window.dispatchEvent(new CustomEvent(linearAccessRequired, { detail: workspace }));
    }
    throw new ApiError(response.status, body);
  }
  if (event) pageEvent(event, workspace);
  return body as T;
}

function accountWrite<T>(path: string, method: string, data?: object) {
  return call<T>(`account${path}`, { method, body: data && JSON.stringify(data) });
}

export function joinProject(token: string): Promise<ProjectJoinPreview | null>;
export function joinProject(token: string, confirm: true): Promise<ProjectJoin | null>;
export async function joinProject(token: string, confirm?: true): Promise<ProjectJoin | null> {
  const response = await fetch("/api/join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, confirm }),
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401 && body.login) return null;
  if (!response.ok) throw new Error(body.error || "Could not join the project");
  return body;
}

export const accountApi = {
  read: (signal?: AbortSignal) => call<Account>("account", { signal }),
  saveName: (human: string) => accountWrite("", "PATCH", { human }),
  onboarding: (state: { name?: true; skipped?: boolean; step?: "workspaces" | "teams" | "setup"; complete?: true }) => accountWrite("/onboarding", "POST", state),
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
  starterTeams: (workspace: string, signal: AbortSignal) =>
    call<{ teams: { key: string; name: string }[] }>("project-creation/teams", { signal }, workspace, undefined, null),
  async createProject(workspace: string, team: string, name: string, firstTask: string) {
    const bytes = new TextEncoder().encode(JSON.stringify([workspace, team, name, firstTask]));
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    const key = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
    return call<StarterResult>("projects", { method: "POST", body: JSON.stringify({ team, name, firstTask }) },
      workspace, undefined, null, key);
  },
  agentReply: (project: string, workspace: string, agent: string, body: string) =>
    call<{ id: string }>(`${projectPath(project)}/agents/${encodeURIComponent(agent)}/reply`,
      { method: "POST", body: JSON.stringify({ body }) }, workspace, undefined, project),
  closeProject: (projectId: string, workspace?: string) => call<{ completedIssues: number }>(`projects/${projectId}/close`, { method: "POST", body: JSON.stringify({ confirm: true }) }, workspace, "status_written"),
  projects: () => call<ProjectList>("projects"),
  /** The state of the server: its build and the Linear budget of each workspace. */
  status: () => call<ServerStatus>("status"),
  /** The projects, with a summary of each open one. */
  overview: () => call<OverviewData>("overview"),
  /** The graph with its version, or null when the page already has version `have`. */
  graph: (projectId: string, have?: string, workspace?: string) => call<(GraphData & { version: string }) | null>(`projects/${projectId}/graph${have ? `?have=${have}` : ""}`, undefined, workspace),
  claims: (id: string, workspace: string, signal: AbortSignal) =>
    call<ProjectClaims>(`${projectPath(id)}/claims`, { signal, cache: "no-store" }, workspace),
  releaseClaim: (id: string, workspace: string, node: string) =>
    shareWrite<null>(`${projectPath(id)}/claims/${encodeURIComponent(node)}?force=1`, workspace, "DELETE"),
  sharedPresence: (id: string, workspace: string) => call<Presence & { asks?: Ask[] }>(`projects/${id}/presence`, undefined, workspace),
  /** A command for the coordinator of the project. */
  command: (projectId: string, command: { name: "next" | "dispatch" | "pause" | "resume"; key?: string; issue?: string }, workspace?: string) =>
    call<{ ok: boolean; queued: number }>(`projects/${projectId}/commands`, { method: "POST", body: JSON.stringify(command) }, workspace, "command_written"),
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
  reply: (projectId: string, askId: string, body: string, workspace?: string) => call<{ ok: boolean; recorded: boolean }>(`projects/${projectId}/asks/${encodeURIComponent(askId)}/reply`, { method: "POST", body: JSON.stringify({ body }) }, workspace, "answer_written"),
  update: (issueId: string, patch: IssuePatch, workspace?: string) => call<Issue>(`issues/${issueId}`, { method: "PATCH", body: JSON.stringify(patch) }, workspace, patch.stateId === undefined ? undefined : "status_written"),
  comments: (issueId: string, workspace?: string, projectId?: string) => call<Comment[]>(`issues/${issueId}/comments`, undefined, workspace, undefined, projectId),
  comment: (issueId: string, body: string, workspace?: string, projectId?: string) => call<Comment>(`issues/${issueId}/comments`, { method: "POST", body: JSON.stringify({ body }) }, workspace, "comment_written", projectId),
};
