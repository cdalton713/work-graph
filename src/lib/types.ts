import type { AutonomyLevel } from "./autonomy";

export type StateType = "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled" | "duplicate";
export interface State { id: string; name: string; type: StateType; color: string; position?: number }
export interface Person { id: string; name: string; avatarUrl: string | null }
export interface Label { id: string; name: string; color: string; group: string | null; teamId?: string | null }
export interface IssueRef { id: string; identifier: string; title: string; url: string; teamKey: string; state: State; inProject: boolean }
export interface Issue {
  id: string; identifier: string; title: string; description: string; priority: number; url: string;
  sortOrder: number; updatedAt: string; teamId: string; teamKey: string; state: State;
  assignee: Person | null; labels: Label[]; milestoneId: string | null;
  blocks: IssueRef[]; blockedBy: IssueRef[]; card: { id: string; body: string } | null;
  /** Not in the project; shown because a project issue has a blocks relation with it. Read-only. */
  external: boolean;
  pullRequests: PullRequest[];
}
/** A GitHub pull request linked to the issue. `reviewUrl` is its page in Linear's code review, when Linear has it. */
export interface PullRequest { number: number; url: string; title: string; status: string; reviewUrl: string | null }
export interface Milestone { id: string; name: string; sortOrder: number; description: string | null }
export interface Team { key: string; states: State[]; members: Person[] }
export interface GraphData {
  workspace?: string;
  project: { id: string; name: string; url: string };
  milestones: Milestone[]; issues: Issue[]; teams: Record<string, Team>; labels: Label[]; viewerId: string;
  /** The project document that `wg next` writes: its text, and when it was written. Null when the project has none. */
  status: { content: string; updatedAt: string } | null;
  /** The server could not refresh the graph from Linear: this is its last graph, at most 15 minutes old. */
  stale?: boolean;
  /** Why the refresh failed. Set only with `stale`. */
  error?: string;
  /** When the stale graph loaded from Linear (epoch ms). Set only with `stale`. */
  loadedAt?: number;
}
export interface Project {
  id: string; name: string; url: string; status: string; statusType: string; workspace?: string; workspaceName?: string;
  /** The child of the team's project label group `initiative` on the project (contract.json `project_labels`). */
  initiative?: string | null;
  /** The child of the project label group `autonomy` on the project; null: none, so the level is `standard`. */
  autonomy?: AutonomyLevel | null;
  /** The project has the plain label `paused`: the coordinator holds each action until Resume. */
  paused?: boolean;
}
export interface WorkspaceSummary { id: string; name: string; error?: string }
export interface ProjectList {
  workspaces: WorkspaceSummary[];
  projects: (Project & { workspace: string; workspaceName: string })[];
}
export interface Comment {
  id: string; body: string; createdAt: string; author: string; parentId: string | null;
  /** Only in the answer to a new comment on an issue that waits on the human: false when the `answered` label failed. */
  answered?: boolean;
}
export interface IssuePatch {
  title?: string; description?: string; stateId?: string; priority?: number; assigneeId?: string | null; labelIds?: string[];
  /** With `description`: the text that the edit started from. The server refuses the save when Linear has another text now. */
  baseDescription?: string;
  /**
   * With `stateId`, for an `ops` or `decision` node that goes to a completed status: the evidence or
   * the answer. The server writes it as a comment before it moves the issue, and refuses the move without it.
   */
  note?: string;
}

export type Kind = "task" | "spike" | "decision" | "ops" | "merge-point" | "ship-point";
/** The data block that `wg load` and `wg run set` write in the node card comment. */
export interface Card {
  key?: string; kind?: Kind; phase?: string; lane?: string; role?: string;
  branch?: string; pr?: string; review?: string; state?: string; soak_until?: string;
  /** The gate at the merge point: `requested`, `clean`, or `accepted`. */
  merge_review?: string;
  /** The kind of the worker job that runs now: `dispatch`, `review`, `ci`, `threads`, or `restack`. */
  job?: string;
  /** The UTC start time of the current worker job. */
  started_at?: string;
  /** `yes` when `wg done` passed on the PR's current head. */
  code_done?: string;
  /** `yes` when the node is in the current wave. */
  wave?: string;
  /** What `wg next` last said about the node, for example `do ask-merge: #7` or `wait human: …`: one line for each thing said. */
  next?: string;
}

/** `GET /api/config`: what the page needs before its first render, and what a deploy check compares. */
export interface SiteConfig {
  human: string; defaultWorkspace: string;
  /** The first 12 hex characters of the SHA-256 of `skills/work-graph/contract.json`, as `wg` computes it. Null: the file is missing. */
  contract: string | null;
  /** The commit of the build (`WG_VERSION`), or `dev`. */
  version: string;
}
/** The counts of one link room. No message text. */
export interface RoomCounts { workspace: string; project: string; coordinators: number; pages: number; queued: number; asks: number }
/** `GET /api/status`: the state of the server. It holds no key, no issue text, and no message body. */
export interface ServerStatus {
  version: string; contract: string | null;
  /** Seconds since the server started. */
  uptime: number;
  /** For each workspace, the values of its last Linear response; null before the first response. Times are epoch ms. */
  workspaces: { id: string; name: string; requestsRemaining: number | null; requestsLimit: number | null; requestsReset: number | null;
    complexityRemaining: number | null; complexityReset: number | null; at: number | null }[];
  /** How many project graphs the caches hold. */
  cache: number;
  rooms: RoomCounts[];
}
