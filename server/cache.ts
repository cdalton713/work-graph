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

export interface Loaders {
  /** The full graph of a project: several requests to Linear. */
  load: (projectId: string) => Promise<GraphData>;
  /** Did an issue or a comment of the project change after `since` (ISO time)? One request. */
  changed: (projectId: string, since: string) => Promise<boolean>;
  now?: () => number;
}
export interface Versioned { data: GraphData; version: string }
interface Entry extends Versioned { loadedAt: number; checkedAt: number }

export interface GraphCache {
  /** The graph of the project, at most `FRESH_MS` old. Callers at the same time share one load. */
  get: (projectId: string) => Promise<Versioned>;
  /** Forget everything: a write of this server changed Linear. */
  clear: () => void;
}

export function createGraphCache({ load, changed, now = Date.now }: Loaders): GraphCache {
  const entries = new Map<string, Entry>();
  const running = new Map<string, Promise<Entry>>();
  let generation = 0;

  async function refresh(projectId: string): Promise<Entry> {
    const at = now(), mine = generation;
    const old = entries.get(projectId);
    if (old && at - old.loadedAt < FULL_MS) {
      const since = new Date(old.checkedAt - SKEW_MS).toISOString();
      if (!(await changed(projectId, since))) {
        old.checkedAt = at;
        return old;
      }
    }
    const data = await load(projectId);
    const entry: Entry = { data, version: createHash("sha1").update(JSON.stringify(data)).digest("hex"), loadedAt: at, checkedAt: at };
    // A write that came while this load ran can be missing from it. Do not keep such a load.
    if (mine === generation) entries.set(projectId, entry);
    return entry;
  }

  return {
    get(projectId) {
      const entry = entries.get(projectId);
      if (entry && now() - entry.checkedAt < FRESH_MS) return Promise.resolve(entry);
      let job = running.get(projectId);
      if (!job) {
        job = refresh(projectId).finally(() => running.delete(projectId));
        running.set(projectId, job);
      }
      return job;
    },
    clear() {
      generation++;
      entries.clear();
    },
  };
}
