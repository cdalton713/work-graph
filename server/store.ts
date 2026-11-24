// The state of the link that must survive a server restart: the queue and the open asks of each room.
// Presence and progress are not here: they come back with the next `hello` and report of a coordinator.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ask, Envelope, ProjectRef } from "../src/lib/link.ts";

/** The version of the state file. A file of another version gives an empty state. */
export const STATE_VERSION = 1;
/** The name of the state file in its directory. */
export const STATE_FILE = "link-state.json";
/** The longest time from a change to its write. */
export const SAVE_MS = 1_000;
/** The most asks that the file keeps for each room. */
export const ASKS_MAX = 100;

export interface RoomState { ref: ProjectRef; queue: Envelope[]; asks: Ask[] }
export interface LinkState { rooms: RoomState[] }

/** Where the hub keeps its state. `save` takes a function, so that the write uses the state at the time of the write. */
export interface Store {
  load: () => LinkState;
  /** A change: write the state at most `SAVE_MS` later. */
  save: (state: () => LinkState) => void;
  /**
   * Write a change that waits now. True: the file holds the current state (also when nothing waited). False: the
   * write failed, and the change still waits for the next try.
   */
  flush: () => boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string";
const isRef = (v: unknown): v is ProjectRef => isObject(v) && isText(v.workspace) && isText(v.id);
const isEnvelope = (v: unknown): v is Envelope =>
  isObject(v) && isText(v.type) && isText(v.id) && !!v.id && isRef(v.project) && isText(v.at) && typeof v.v === "number";
const isAsk = (v: unknown): v is Ask =>
  isObject(v) && isText(v.id) && !!v.id && isText(v.from) && isText(v.body) && isText(v.at)
  && (v.key === null || isText(v.key)) && (v.issue === null || isText(v.issue));

/** The state in a file text. It throws when the text is not a state of `STATE_VERSION`. */
export function parseState(raw: string, queueMax: number): LinkState {
  const data: unknown = JSON.parse(raw);
  if (!isObject(data) || data.version !== STATE_VERSION) throw new Error(`not a state of version ${STATE_VERSION}`);
  const rooms = (Array.isArray(data.rooms) ? data.rooms : []).filter(isObject).flatMap((r): RoomState[] => {
    if (!isRef(r.ref)) return [];
    const queue = (Array.isArray(r.queue) ? r.queue : []).filter(isEnvelope).slice(-queueMax);
    const asks = (Array.isArray(r.asks) ? r.asks : []).filter(isAsk).slice(0, ASKS_MAX);
    return queue.length || asks.length ? [{ ref: { workspace: r.ref.workspace, id: r.ref.id }, queue, asks }] : [];
  });
  return { rooms };
}

/**
 * A store in one JSON file in `dir`, mode 600. A write goes to a temporary file first and then takes the place
 * of the file, so a crash leaves the old file or the new one. `after` is the timer of the debounce (tests give a
 * fake one).
 */
export function fileStore(
  dir: string,
  { queueMax, after, log = console.log }: { queueMax: number; after: (fn: () => void, ms: number) => () => void; log?: (line: string) => void },
): Store {
  const file = join(dir, STATE_FILE);
  let pending: (() => LinkState) | null = null;
  let cancel: (() => void) | null = null;
  // `pending` stays until the rename succeeds, so that a failed write is tried again.
  const write = (): boolean => {
    cancel = null;
    const state = pending;
    if (!state) return true;
    const { rooms } = state();
    const text = JSON.stringify({
      version: STATE_VERSION,
      rooms: rooms.filter((r) => r.queue.length || r.asks.length).map((r) => ({ ref: r.ref, queue: r.queue.slice(-queueMax), asks: r.asks.slice(0, ASKS_MAX) })),
    });
    // A new temporary file for each write (`wx`): the mode 600 applies only to a file that the write creates, so
    // an old file of the same name must not get the state.
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
      renameSync(temp, file);
      if (pending === state) pending = null;
      return true;
    } catch (error) {
      try { rmSync(temp, { force: true }); } catch { /* no directory: no temporary file */ }
      log(`link state: cannot write ${file}: ${(error as Error).message}; the next try is in ${SAVE_MS} ms`);
      cancel ??= after(write, SAVE_MS);
      return false;
    }
  };
  return {
    load: () => {
      let raw: string;
      try {
        raw = readFileSync(file, "utf8");
      } catch (error) {
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        log(missing ? `link state: no ${file}; the link starts empty` : `link state: cannot read ${file}: ${(error as Error).message}; the link starts empty`);
        return { rooms: [] };
      }
      try {
        return parseState(raw, queueMax);
      } catch (error) {
        log(`link state: cannot use ${file}: ${(error as Error).message}; the link starts empty`);
        return { rooms: [] };
      }
    },
    save: (state) => {
      pending = state;
      cancel ??= after(write, SAVE_MS);
    },
    flush: () => {
      cancel?.();
      return write();
    },
  };
}
