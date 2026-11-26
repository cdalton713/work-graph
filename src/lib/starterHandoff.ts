import type { StarterResult } from "./types";

const prefix = (owner: string) => "wg-starter:" + encodeURIComponent(owner) + ":";
const memory = new Map<string, StarterResult>();

export function starterKey(owner: string, connection: string | null, workspace: string, project: string) {
  return prefix(owner) + JSON.stringify([connection, workspace, project]);
}

export function saveStarter(key: string, starter: StarterResult) {
  memory.set(key, starter);
  try { localStorage.setItem(key, JSON.stringify(starter)); } catch { /* Keep this page's copy. */ }
}

export function readStarter(key: string, workspace: string, project: string): StarterResult | null {
  const current = memory.get(key);
  if (current) return current;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const result = JSON.parse(raw);
    const handoff = result?.handoff;
    return result?.workspace === workspace && result?.project?.id === project &&
      handoff?.plan?.effort?.workspace === workspace && typeof handoff.plan.effort.team === "string" &&
      handoff.keymap?.project?.id === project && typeof handoff.command === "string" ? result : null;
  } catch { return null; }
}

export function clearStarterHandoffs(owner: string | null) {
  if (!owner) return;
  const scope = prefix(owner);
  for (const key of memory.keys()) if (key.startsWith(scope)) memory.delete(key);
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(scope)) localStorage.removeItem(key);
  } catch { /* Storage can be unavailable. */ }
}

// A login in another tab changes the session cookie for this page as well.
export function watchStarterSession(owner: string | null, enabled: boolean) {
  try {
    const channel = new BroadcastChannel("wg-starter-session");
    channel.postMessage(owner);
    if (owner && enabled) {
      channel.onmessage = event => { if (event.data !== owner) location.reload(); };
    } else channel.close();
  } catch { /* A restricted browser can disable channels. */ }
  if (!owner || !enabled) return;
  const scope = prefix(owner);
  window.addEventListener("storage", event => {
    if (event.newValue === null && event.key?.startsWith(scope)) location.reload();
  });
  window.addEventListener("pageshow", event => { if (event.persisted) location.reload(); });
}
