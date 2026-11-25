import { useEffect, useRef, useState } from "react";
import { type Agents, type Ask, type Envelope, type Presence, type Progress, type ProjectRef, projectKey } from "./lib/link";
import { pageLink } from "./lib/site";

export interface LinkState {
  /** The presence of each project, by `workspace:id`. The overview gets every project, a project page its own. */
  presence: Map<string, Presence>;
  asks: Ask[]; progress: Progress[];
  /** The open asks of each project, by `workspace:id`. The overview gets every project, a project page its own. */
  asksBy: Map<string, Ask[]>;
  /** The agents of each project (`wg agents`), by `workspace:id`. */
  agentsBy: Map<string, Agents>;
  connected: boolean;
}

/**
 * The page side of `wg-link/1`: one socket for the open project, or for the overview (`ref` null). It
 * reconnects after a drop. `onChanged` runs when the server says that an issue of the project changed.
 */
export function useLink(ref: ProjectRef | null, onChanged: () => void): LinkState {
  const [state, setState] = useState<LinkState>({ presence: new Map(), asks: [], progress: [], asksBy: new Map(), agentsBy: new Map(), connected: false });
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const key = ref ? projectKey(ref) : "";
  useEffect(() => {
    let socket: WebSocket | null = null, timer = 0, stopped = false, delay = 1000;
    setState({ presence: new Map(), asks: [], progress: [], asksBy: new Map(), agentsBy: new Map(), connected: false });
    if (!pageLink.path) return;
    const open = () => {
      const query = new URLSearchParams({ role: "page", ...(ref ? { workspace: ref.workspace, project: ref.id } : {}) });
      socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${pageLink.path}?${query}`);
      socket.onopen = () => { delay = 1000; setState((s) => ({ ...s, connected: true })); };
      socket.onmessage = (event) => {
        let m: Envelope;
        try { m = JSON.parse(event.data); } catch { return; }
        if (m.type === "presence") setState((s) => ({ ...s, presence: new Map(s.presence).set(projectKey(m.project), m.payload as Presence) }));
        else if (m.type === "asks") {
          const asks = (m.payload as { asks: Ask[] }).asks;
          setState((s) => ({ ...s, asks: ref ? asks : s.asks, asksBy: new Map(s.asksBy).set(projectKey(m.project), asks) }));
        }
        else if (m.type === "progress") setState((s) => ({ ...s, progress: (m.payload as { nodes: Progress[] }).nodes }));
        else if (m.type === "agents") setState((s) => ({ ...s, agentsBy: new Map(s.agentsBy).set(projectKey(m.project), m.payload as Agents) }));
        else if (m.type === "changed") changed.current();
      };
      socket.onclose = () => {
        setState((s) => ({ ...s, connected: false }));
        if (!stopped) timer = window.setTimeout(open, delay);
        delay = Math.min(delay * 2, 30_000);
      };
    };
    open();
    return () => { stopped = true; clearTimeout(timer); socket?.close(); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}
