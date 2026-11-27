// Who may call the API. The API changes Linear with the user's key, so only this page may call it.
// Tailscale decides which devices can connect at all; this check makes sure that the caller is the
// page itself and not another site in the same browser.

/** The names under which this server answers besides 127.0.0.1 and localhost. */
export interface Rules {
  port: number;
  /** The tailnet name of this machine, while Tailscale Serve sends requests to this server. */
  tailnet: { host: string } | null;
  /** The name of the hosted page (see deploy/). Then this server answers only under that name. */
  hosted?: { host: string } | null;
}

/**
 * The reason to refuse an API request, or null when the request may pass.
 *
 * The host says which page made the request. A page of another site cannot send one of these
 * hosts, so this check stops DNS rebinding. A request that changes data must also come from the
 * page of that same host, as JSON: a form on another site can send neither.
 *
 * `header` gives a request header by its lowercase name, or undefined.
 */
export function refusal(method: string, header: (name: string) => string | undefined, rules: Rules): string | null {
  const get = (name: string) => header(name) ?? "";
  const page = pageOf(get, rules);
  if (page.refused) return page.refused;
  // HEAD reads, as GET does: the server answers it from the GET route, with no body.
  if (method !== "GET" && method !== "HEAD" && (get("origin") !== page.origin || !get("content-type").startsWith("application/json"))) return "bad origin";
  return null;
}

/** The origin of the page that the host names, or why the host is refused. */
function pageOf(get: (name: string) => string, rules: Rules): { origin: string; refused?: string } {
  const host = get("host").toLowerCase();
  if (rules.hosted) return host === rules.hosted.host ? { origin: `https://${host}` } : { origin: "", refused: "bad host" };
  if (host === `127.0.0.1:${rules.port}` || host === `localhost:${rules.port}`) return { origin: `http://${host}` };
  if (rules.tailnet && host === rules.tailnet.host) {
    // Tailscale Serve sets this header for a request that came from the internet through Funnel.
    if (get("tailscale-funnel-request")) return { origin: "", refused: "a request from the internet may not use this page" };
    return { origin: `https://${host}` };
  }
  return { origin: "", refused: "bad host" };
}

/**
 * The reason to refuse a link connection (`/api/link`), or null. A WebSocket is not subject to the
 * browser's same-origin rules, so the origin decides the role: a browser always sends an Origin, so a
 * page must send the exact origin of this page, and a coordinator (`wg next`) must send none.
 */
export function linkRefusal(role: string, header: (name: string) => string | undefined, rules: Rules): string | null {
  const get = (name: string) => header(name) ?? "";
  const page = pageOf(get, rules);
  if (page.refused) return page.refused;
  if (role === "page") return get("origin") === page.origin ? null : "bad origin";
  if (role === "coordinator") return get("origin") ? "a coordinator sends no Origin" : null;
  return "role must be page or coordinator";
}

export const sharedRoutes: Readonly<Record<string, "list" | "project" | "issue" | "owner" | "denied">> = {
  "GET /api/push/status": "denied",
  "POST /api/push/notices": "denied",
  "POST /api/push/devices/:id/test": "denied",
  "GET /api/push/key": "denied",
  "GET /api/push/devices": "denied",
  "POST /api/push/devices": "denied",
  "DELETE /api/push/devices/:id": "denied",
  "GET /api/push/settings": "denied",
  "PUT /api/push/settings": "denied",
  "GET /api/status": "list",
  "GET /api/project-creation/teams": "denied",
  "POST /api/projects": "denied",
  "GET /api/projects": "list",
  "GET /api/overview": "list",
  "GET /api/projects/:id/claims": "project",
  "POST /api/projects/:id/claims/:node": "project",
  "PUT /api/projects/:id/claims/:node": "project",
  "DELETE /api/projects/:id/claims/:node": "project",
  "GET /api/projects/:id/plan": "project",
  "PUT /api/projects/:id/plan": "project",
  "GET /api/projects/:id/plan/versions": "project",
  "GET /api/projects/:id/plan/versions/:version": "project",
  "GET /api/projects/:id/graph": "project",
  "GET /api/projects/:id/presence": "project",
  "POST /api/projects/:id/commands": "project",
  "POST /api/projects/:id/asks/:ask/reply": "project",
  "PATCH /api/issues/:id": "issue",
  "GET /api/issues/:id/comments": "issue",
  "POST /api/issues/:id/comments": "issue",
  "POST /api/projects/:id/agents/:agent/reply": "owner",
  "POST /api/projects/:id/close": "owner",
  "POST /api/projects/:id/autonomy": "owner",
  "POST /api/projects/:id/review-effort": "owner",
  "POST /api/projects/:id/hold": "owner",
  "GET /api/projects/:id/access": "project",
  "POST /api/projects/:id/access/request": "project",
  "POST /api/projects/:id/members/:member/access": "owner",
  "GET /api/projects/:id/share": "owner",
  "POST /api/projects/:id/share": "owner",
  "POST /api/projects/:id/share/:kind": "owner",
  "POST /api/projects/:id/share/:kind/rotate": "owner",
  "DELETE /api/projects/:id/share/:kind": "owner",
  "PATCH /api/projects/:id/members/:member": "owner",
  "DELETE /api/projects/:id/members/:member": "owner",
  "GET /api/link": "denied",
  "POST /api/events": "denied",
  "POST /api/join": "denied",
  "GET /api/account": "denied",
  "PATCH /api/account": "denied",
  "DELETE /api/account": "denied",
  "POST /api/account/tokens": "denied",
  "DELETE /api/account/tokens/:id": "denied",
  "POST /api/account/onboarding": "denied",
  "POST /api/account/workspaces": "denied",
  "PUT /api/account/workspaces/:id/key": "denied",
  "PATCH /api/account/workspaces/:id": "denied",
  "GET /api/account/workspaces/:id/teams": "denied",
  "POST /api/account/workspaces/:id/teams": "denied",
  "GET /api/account/workspaces/:id/teams/:key/setup": "denied",
  "POST /api/account/workspaces/:id/teams/:key/setup": "denied",
  "DELETE /api/account/workspaces/:id": "denied",
};
