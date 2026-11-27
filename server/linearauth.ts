import type { UsageWorkspace } from "./telemetry.ts";
import { createHash, randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { clearSessionCookie, cookie, localUrl, pack, SESSION_COOKIE, SESSION_S, STATE_COOKIE, STATE_S, unpack, type Session } from "./auth.ts";
import type { createAccounts, NewConnection } from "./db/accounts.ts";

export interface LinearAuth {
  clientId: string;
  clientSecret: string;
  secret: string;
  allowedOrgs?: string[];
}

export type OAuthCredential = { kind: "oauth"; key: string; refreshToken: string; expiresAt: Date };
type Identity = {
  viewer: { id: string; name: string; email: string };
  organization: { id: string; name: string; urlKey: string };
  teams: { nodes: { key: string }[] };
};

/** The result of a workspace connection, as the `connect` query value of the page it returns to. */
export type ConnectResult = "connected" | "reconnected" | "signin-workspace" | "limit" | "denied" | "failed" | "expired";

/** Connects more Linear workspaces to the signed-in account with Linear OAuth. */
export interface LinearAttach {
  /** The account of the signed-in owner of this request, or null. */
  owner: (c: Context) => Promise<string | null>;
  /** `displaced`: the refresh token of the credential that a reconnection replaced, to revoke. */
  save: (account: string, workspace: NewConnection & { credential: OAuthCredential }) =>
    Promise<{ id: string; created: boolean; displaced?: string }>;
}

export class LinearSignInRequired extends Error {
  constructor() { super("sign in to Linear again"); }
}

export function serviceSetting(env: NodeJS.ProcessEnv, functionHost = false): string | undefined {
  const names = ["WG_DATA_KEY", "WG_SESSION_SECRET", "WG_HOSTED", "WG_LINEAR_CLIENT_ID", "WG_LINEAR_CLIENT_SECRET"];
  if (functionHost) names.push("WG_REDIS_URL");
  return names.find((name) => {
    const value = env[name]?.trim();
    if (!value) return true;
    if (name === "WG_SESSION_SECRET") return value.length < 32;
    if (name === "WG_HOSTED") return URL.parse(`https://${value}`)?.hostname !== value.toLowerCase();
    return false;
  });
}

export function readLinearAuth(env: NodeJS.ProcessEnv): LinearAuth {
  return {
    clientId: env.WG_LINEAR_CLIENT_ID!.trim(),
    clientSecret: env.WG_LINEAR_CLIENT_SECRET!.trim(),
    secret: env.WG_SESSION_SECRET!.trim(),
    allowedOrgs: env.WG_ALLOWED_ORGS?.toLowerCase().split(/[,\s]+/).filter(Boolean),
  };
}

async function requestToken(auth: LinearAuth, params: Record<string, string>, now: () => number): Promise<OAuthCredential | null> {
  const message = "Linear did not complete the token request";
  try {
    const response = await fetch("https://api.linear.app/oauth/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: auth.clientId, client_secret: auth.clientSecret, ...params }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status >= 500 || response.status === 429) throw new Error(message);
    const body = await response.json();
    if (!response.ok) {
      if (body?.error === "invalid_grant") return null;
      throw new Error(message);
    }
    if (typeof body?.access_token !== "string" || !body.access_token || typeof body.refresh_token !== "string" ||
        !body.refresh_token || typeof body.expires_in !== "number" || !Number.isFinite(body.expires_in) || body.expires_in <= 0) {
      throw new Error(message);
    }
    return { kind: "oauth", key: body.access_token, refreshToken: body.refresh_token, expiresAt: new Date(now() + body.expires_in * 1000) };
  } catch {
    throw new Error(message);
  }
}

export const refreshLinearToken = (auth: LinearAuth, token: string, now: () => number) =>
  requestToken(auth, { grant_type: "refresh_token", refresh_token: token }, now);

export async function revokeLinearToken(refreshToken: string): Promise<boolean> {
  try {
    const response = await fetch("https://api.linear.app/oauth/revoke", {
      method: "POST",
      body: new URLSearchParams({ token: refreshToken, token_type_hint: "refresh_token" }),
      signal: AbortSignal.timeout(2_000),
      redirect: "error",
    });
    void response.body?.cancel().catch(() => {});
    return response.ok;
  } catch {
    return false;
  }
}

export function usesTeamProjectLabels(plan?: string): boolean {
  return /^(business|enterprise)(?:[_-]|$)/i.test(plan ?? "");
}

export async function defaultTeamLabels(authorization: string): Promise<boolean> {
  try {
    const response = await fetch("https://api.linear.app/graphql", {
      method: "POST", headers: { Authorization: authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "query { organization { subscription { type } } }" }),
      signal: AbortSignal.timeout(2_000), redirect: "error",
    });
    if (!response.ok) return false;
    const { data, errors } = await response.json();
    return !errors && usesTeamProjectLabels(data?.organization?.subscription?.type);
  } catch {
    return false;
  }
}

async function identity(key: string): Promise<Identity | null> {
  try {
    const response = await fetch("https://api.linear.app/graphql", {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "query { viewer { id name email } organization { id name urlKey } teams(first: 2) { nodes { key } } }" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const { data, errors } = await response.json();
    const { viewer, organization } = data ?? {};
    return !errors && viewer && organization && [viewer.id, viewer.name, viewer.email, organization.id, organization.name, organization.urlKey]
      .every((value) => typeof value === "string" && value) ? data : null;
  } catch {
    return null;
  }
}

export async function linearSessionOf(c: Context, auth: LinearAuth, now: () => number): Promise<Session | null> {
  const value = unpack(await getSignedCookie(c, auth.secret, SESSION_COOKIE, "host"));
  if (typeof value?.accountId !== "string" || typeof value.id !== "string" || typeof value.email !== "string" ||
      typeof value.exp !== "number" || value.exp * 1000 <= now()) return null;
  return { accountId: value.accountId, id: value.id, email: value.email, expiresAt: value.exp * 1000 };
}

export function linearAuthRoutes(auth: LinearAuth, origin: () => string, now: () => number,
  save: ReturnType<typeof createAccounts>["signIn"], onLogout: (session: Session) => void | Promise<void>,
  observe?: (id: string, workspace: UsageWorkspace, created: boolean) => void, attach?: LinearAttach) {
  const routes = new Hono();
  const redirectUri = () => `${origin()}/auth/callback`;
  async function authorize(c: Context, account?: string) {
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const flow = { state, verifier, next: localUrl(c.req.query("next"), origin()), expiresAt: now() + STATE_S * 1000,
      ...(account ? { attach: account } : {}) };
    await setSignedCookie(c, STATE_COOKIE, pack(flow), auth.secret, cookie(STATE_S));
    const query = new URLSearchParams({
      client_id: auth.clientId, redirect_uri: redirectUri(), response_type: "code", scope: "read,write", actor: "user", state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
      // Linear shows its workspace picker on each consent, so the owner can choose another workspace.
      ...(account ? { prompt: "consent" } : {}),
    });
    return c.redirect(`https://linear.app/oauth/authorize?${query}`, 302);
  }
  routes.get("/login", (c) => authorize(c));
  routes.get("/connect", async (c) => {
    const account = attach && await attach.owner(c);
    if (!account) return c.redirect(`${origin()}/auth/login?next=${encodeURIComponent(localUrl(c.req.query("next"), origin()))}`, 302);
    return authorize(c, account);
  });
  const returnTo = (c: Context, next: unknown, result: ConnectResult) => {
    const url = new URL(localUrl(next, origin()));
    url.searchParams.set("connect", result);
    return c.redirect(url.href, 302);
  };
  routes.get("/callback", async (c) => {
    c.header("Referrer-Policy", "no-referrer");
    const flow = unpack(await getSignedCookie(c, auth.secret, STATE_COOKIE, "host"));
    deleteCookie(c, STATE_COOKIE, { path: "/", secure: true, prefix: "host" });
    const code = c.req.query("code");
    if (!flow) return c.json({ error: "this sign-in did not start here, or it took too long: open the page again" }, 400);
    const valid = typeof flow.state === "string" && flow.state === c.req.query("state") && typeof flow.verifier === "string" &&
      !!flow.verifier && typeof flow.expiresAt === "number" && flow.expiresAt > now();
    const connecting = valid && flow.attach !== undefined;
    // A connection never falls through to sign-in, also when this instance cannot attach workspaces.
    if (connecting && (typeof flow.attach !== "string" || !attach)) return returnTo(c, flow.next, "failed");
    if (connecting && !code) return returnTo(c, flow.next, "denied");
    if (!valid || !code) {
      return c.json({ error: "this sign-in did not start here, or it took too long: open the page again" }, 400);
    }
    // The session that started the connection must still be the signed-in owner.
    if (connecting && await attach!.owner(c) !== flow.attach) return returnTo(c, flow.next, "expired");
    const credential = await requestToken(auth, {
      code, code_verifier: flow.verifier as string, redirect_uri: redirectUri(), grant_type: "authorization_code",
    }, now).catch(() => null);
    const data = credential && await identity(credential.key);
    if (credential && !data) await revokeLinearToken(credential.refreshToken);
    if (connecting && (!credential || !data)) return returnTo(c, flow.next, "failed");
    if (!credential || !data) return c.json({ error: "Linear did not complete the sign-in: open the page again" }, 502);
    const { viewer, organization, teams } = data;
    if (connecting) {
      // An attached workspace is not a sign-up, so the sign-up list of WG_ALLOWED_ORGS does not apply.
      const result = await attach!.save(flow.attach as string, {
        workspaceId: organization.urlKey, linearOrgId: organization.id, name: organization.name, ownerName: viewer.name,
        team: teams?.nodes?.length === 1 ? teams.nodes[0].key : "", teamLabels: await defaultTeamLabels(`Bearer ${credential.key}`), credential,
      }).then(async ({ created, displaced }) => {
        if (displaced) await revokeLinearToken(displaced);
        return created ? "connected" as const : "reconnected" as const;
      }, (error: unknown) => {
        const message = error instanceof Error ? error.message : "";
        return message === "The sign-in workspace uses Linear sign-in" ? "signin-workspace" as const
          : message === "Connection limit reached" ? "limit" as const : "failed" as const;
      });
      if (result !== "connected" && result !== "reconnected") await revokeLinearToken(credential.refreshToken);
      return returnTo(c, flow.next, result);
    }
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (auth.allowedOrgs && !auth.allowedOrgs.some((entry) =>
      entry.toLowerCase() === (uuid.test(entry) ? organization.id : organization.urlKey).toLowerCase())) {
      await revokeLinearToken(credential.refreshToken);
      return c.text("This service is not open for your workspace.", 403);
    }
    const accountId = await save({ linearUserId: viewer.id, linearOrgId: organization.id, name: viewer.name, email: viewer.email }, {
      workspaceId: organization.urlKey, linearOrgId: organization.id, name: organization.name,
      team: teams?.nodes?.[0]?.key ?? "", teamLabels: await defaultTeamLabels(`Bearer ${credential.key}`), credential,
    }, observe && ((id, created) => observe(id, { id: organization.urlKey, organization: organization.id }, created)));
    const exp = Math.floor(now() / 1000) + SESSION_S;
    const session = { accountId, email: viewer.email, exp, id: randomBytes(24).toString("base64url") };
    await setSignedCookie(c, SESSION_COOKIE, pack(session), auth.secret, cookie(SESSION_S));
    return c.redirect(localUrl(flow.next, origin()), 302);
  });
  routes.get("/logout", async (c) => {
    const session = await linearSessionOf(c, auth, now);
    if (session) await onLogout(session);
    clearSessionCookie(c);
    return c.redirect(`${origin()}/`, 302);
  });
  return routes;
}
