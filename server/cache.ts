// One graph for each project, for all tabs. Without it, each open tab loads the full graph from
// Linear at each poll, with the key that wg and the workers also use (5,000 requests each hour).
import { createHash } from "node:crypto";
import type { GraphData } from "../src/lib/types.ts";

/** How long an answer serves every caller with no question to Linear. */
export const FRESH_MS = 10_000;
/**
 * The longest time between two full loads. The cheap check sees changes to issues,
 * comments (including node cards), and the status document. A full load also sees new relations
 * between old issues and changes to issues outside the project.
 */
export const FULL_MS = 5 * 60_000;
/** The clock of Linear and the clock of this server can differ. The check looks this far back. */
const SKEW_MS = 5_000;

/** A failed refresh gives the last graph of the project, marked stale, while it is at most this old. */
export const STALE_MS = 15 * 60_000;

export interface Loaders {
  /** The full graph of a project: several requests to Linear. */
  load: (projectId: string) => Promise<GraphData>;
  /** Did an issue or a comment of the project change after `since` (ISO time)? One request. */
  changed: (projectId: string, since: string) => Promise<boolean>;
  /**
   * Which of these projects changed after `since`: one request for all. Each changed project maps to
   * the time of its latest change. Null: too many changes to list, so all changed.
   */
  changedMany?: (projectIds: string[], since: string) => Promise<Map<string, string> | null>;
  now?: () => number;
}
export interface Versioned {
  data: GraphData; version: string;
  /** The refresh failed: this is the last graph that loaded, and `error` says why the refresh failed. */
  stale?: boolean; error?: string;
}
interface Entry extends Versioned { loadedAt: number; checkedAt: number; changed?: boolean }

export interface GraphCache {
  /**
   * The graph of the project, at most `FRESH_MS` old. Callers at the same time share one load. When the
   * refresh fails and the last graph of the project is at most `STALE_MS` old, it gives that graph with `stale`.
   */
  get: (projectId: string) => Promise<Versioned>;
  /**
   * Checks the projects that are due for a check in one request (`changedMany`), so the next `get` of each
   * needs no request of its own when it did not change. A failed check changes nothing.
   */
  check: (projectIds: string[]) => Promise<void>;
  /** A write of this server changed Linear: forget the graph of that project, or of all projects. */
  clear: (projectId?: string) => void;
}

export function createGraphCache({ load, changed, changedMany, now = Date.now }: Loaders): GraphCache {
  const entries = new Map<string, Entry>();
  /** The last graph that loaded for each project, also after a write: what a failed refresh gives. */
  const last = new Map<string, Entry>();
  const running = new Map<string, Promise<Versioned>>();
  // A write increments the generation of its project, or the shared one when the project is not known.
  let shared = 0;
  const generations = new Map<string, number>();
  const generation = (projectId: string) => `${shared}:${generations.get(projectId) ?? 0}`;
  let checking: Promise<void> | null = null;

  const since = (entry: Entry) => new Date(entry.checkedAt - SKEW_MS).toISOString();
  const due = (entry: Entry | undefined, at: number): entry is Entry =>
    !!entry && !entry.changed && at - entry.checkedAt >= FRESH_MS && at - entry.loadedAt < FULL_MS;

  async function refresh(projectId: string): Promise<Entry> {
    const at = now(), mine = generation(projectId);
    const old = entries.get(projectId);
    if (old && !old.changed && at - old.loadedAt < FULL_MS) {
      if (!(await changed(projectId, since(old)))) {
        old.checkedAt = at;
        return old;
      }
    }
    const data = await load(projectId);
    const entry: Entry = { data, version: createHash("sha1").update(JSON.stringify(data)).digest("hex"), loadedAt: at, checkedAt: at };
    last.set(projectId, entry);
    // A write that came while this load ran can be missing from it. Do not keep such a load.
    if (mine === generation(projectId)) entries.set(projectId, entry);
    return entry;
  }

  async function guarded(projectId: string): Promise<Versioned> {
    try {
      const { data, version } = await refresh(projectId);
      return { data, version };
    } catch (error) {
      const old = last.get(projectId);
      if (!old || now() - old.checkedAt > STALE_MS) throw error;
      return { data: old.data, version: old.version, stale: true, error: (error as Error).message };
    }
  }

  async function checkDue(projectIds: string[]): Promise<void> {
    const at = now();
    const ids = [...new Set(projectIds)].filter((id) => !running.has(id) && due(entries.get(id), at));
    if (!changedMany || !ids.length) return;
    const checked = ids.map((id) => [id, entries.get(id)!, generation(id)] as const);
    const from = checked.reduce((min, [, entry]) => Math.min(min, entry.checkedAt), Infinity);
    let found: Map<string, string> | null;
    try {
      found = await changedMany(ids, new Date(from - SKEW_MS).toISOString());
    } catch {
      return; // each `get` checks for itself
    }
    for (const [id, entry, mine] of checked) {
      // A write or a new load during the check: that entry is not the one the check saw.
      if (entries.get(id) !== entry || mine !== generation(id)) continue;
      const latest = found === null ? "" : found.get(id);
      if (latest === undefined || (latest && latest <= since(entry))) entry.checkedAt = at;
      else entry.changed = true;
    }
  }

  return {
    get(projectId) {
      const entry = entries.get(projectId);
      if (entry && !entry.changed && now() - entry.checkedAt < FRESH_MS) return Promise.resolve({ data: entry.data, version: entry.version });
      let job = running.get(projectId);
      if (!job) {
        job = guarded(projectId).finally(() => running.delete(projectId));
        running.set(projectId, job);
      }
      return job;
    },
    async check(projectIds) {
      // Two pollers at the same time share the request of the first.
      while (checking) await checking;
      checking = checkDue(projectIds).finally(() => { checking = null; });
      await checking;
    },
    clear(projectId) {
      if (projectId === undefined) {
        shared++;
        entries.clear();
        return;
      }
      generations.set(projectId, (generations.get(projectId) ?? 0) + 1);
      entries.delete(projectId);
    },
  };
}
