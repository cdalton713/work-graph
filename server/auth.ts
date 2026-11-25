// Sign-in for a hosted page (README "Host a read-only viewer"): Google OpenID Connect and a signed session cookie.
// The server keeps no session state: the cookie holds the email and its end time, signed with `secret`.
import { randomBytes } from "node:crypto";
import type { Context } from "hono";
import { Hono } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";

/** Who may sign in, and the secrets of the sign-in. The secrets come from the environment, never from the config. */
export interface Auth {
  /** The Google Workspace domains whose accounts may sign in (config `auth.domains`), in lowercase. */
  domains: string[];
  /** The OAuth client of the page (`WG_AUTH_CLIENT_ID`, `WG_AUTH_CLIENT_SECRET`). */
  clientId: string;
  clientSecret: string;
  /** The key that signs the cookies (`WG_SESSION_SECRET`), at least 32 characters. */
  secret: string;
}
export interface Session { email: string }
/** What the session cookie holds: the address, the Workspace domain of its account, and the end time (epoch s). */
interface SessionValue { email: string; hd: string; exp: number }

/** The path that starts a sign-in. A 401 of the API names it. */
export const LOGIN_PATH = "/auth/login";
const SESSION_COOKIE = "wg_session";
const STATE_COOKIE = "wg_signin";
/** How long a session lasts, and how long a sign-in may take, in seconds. */
export const SESSION_S = 7 * 24 * 3600;
const STATE_S = 600;
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

/** `__Host-` cookies: the browser sends them only to this host, over HTTPS, and no other host can set them. */
const cookie = (maxAge: number) => ({ path: "/", secure: true, httpOnly: true, sameSite: "Lax", maxAge, prefix: "host" }) as const;
const pack = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const unpack = (text: string | false | undefined): Record<string, unknown> | null => {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
};
const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

/** True when the config names the Workspace domain of the account and the domain of its address. */
const allowed = (auth: Auth, email: string, hd: string) => auth.domains.includes(hd.toLowerCase()) && auth.domains.includes(domainOf(email));

/**
 * The session of a request, or null: no cookie, a cookie that this server did not sign, a session that ended, or
 * an account that the config no longer lets in.
 */
export async function sessionOf(c: Context, auth: Auth, now: () => number): Promise<Session | null> {
  const value = unpack(await getSignedCookie(c, auth.secret, SESSION_COOKIE, "host"));
  if (!value || typeof value.email !== "string" || typeof value.hd !== "string" || typeof value.exp !== "number") return null;
  if (value.exp * 1000 <= now() || !allowed(auth, value.email, value.hd)) return null;
  return { email: value.email };
}

/**
 * The address of this page to go to after the sign-in, as a browser reads `next` on this page. A browser drops a
 * tab and a line break from a URL and takes a backslash as `/`, so the URL parser decides, not a pattern: another
 * site gives the start of this page. The result is the full address, never a path: the parser makes `/.//name`
 * into the path `//name`, which a browser reads as another site when it comes alone.
 */
function localUrl(next: unknown, origin: string): string {
  const home = `${origin}/`;
  if (typeof next !== "string") return home;
  try {
    const url = new URL(next, home);
    return url.origin === origin ? url.href : home;
  } catch {
    return home;
  }
}

/**
 * Why Google's ID token gives no session, or the email. The token comes from Google's token endpoint over TLS, in
 * answer to this client's secret, so its signature is not checked again here.
 */
export function accountOf(idToken: unknown, auth: Auth, now: () => number): { email: string; hd: string } | { refused: string } {
  const claims = typeof idToken === "string" ? unpack(idToken.split(".")[1]) : null;
  if (!claims) return { refused: "Google gave no ID token" };
  if (claims.aud !== auth.clientId || !ISSUERS.has(String(claims.iss))) return { refused: "the ID token is not for this page" };
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= now()) return { refused: "the ID token ended" };
  if (typeof claims.email !== "string" || claims.email_verified !== true) return { refused: "the account has no verified email" };
  // `hd` is the Google Workspace domain of the account's organization. A personal account has none, also with an
  // address of the domain. An organization with more domains gives its first one for each address, so the list
  // must name the domain of the organization and the domain of the address.
  if (typeof claims.hd !== "string" || !allowed(auth, claims.email, claims.hd)) return { refused: "this account may not use this page" };
  return { email: claims.email.toLowerCase(), hd: claims.hd.toLowerCase() };
}

/**
 * The routes `/login`, `/callback`, and `/logout` (under `/auth`). `origin` is the HTTPS origin of the page:
 * Google sends the browser back to `<origin>/auth/callback`, which the OAuth client must name as a redirect URI.
 */
export function authRoutes(auth: Auth, origin: () => string, now: () => number): Hono {
  const routes = new Hono();
  const redirectUri = () => `${origin()}/auth/callback`;
  routes.get("/login", async (c) => {
    const state = randomBytes(24).toString("base64url");
    await setSignedCookie(c, STATE_COOKIE, pack({ state, next: localUrl(c.req.query("next"), origin()) }), auth.secret, cookie(STATE_S));
    const query = new URLSearchParams({
      client_id: auth.clientId, redirect_uri: redirectUri(), response_type: "code", scope: "openid email", state,
      // A hint for Google's account picker. The check of the domain is `accountOf`.
      ...(auth.domains.length === 1 ? { hd: auth.domains[0] } : {}),
    });
    return c.redirect(`${AUTHORIZE_URL}?${query}`, 302);
  });
  routes.get("/callback", async (c) => {
    const sent = unpack(await getSignedCookie(c, auth.secret, STATE_COOKIE, "host"));
    deleteCookie(c, STATE_COOKIE, { path: "/", secure: true, prefix: "host" });
    const code = c.req.query("code");
    if (!sent || typeof sent.state !== "string" || sent.state !== c.req.query("state") || !code) {
      return c.json({ error: "this sign-in did not start here, or it took too long: open the page again" }, 400);
    }
    let token: { id_token?: unknown } | null = null;
    try {
      const response = await fetch(TOKEN_URL, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code, client_id: auth.clientId, client_secret: auth.clientSecret, redirect_uri: redirectUri(), grant_type: "authorization_code" }),
        signal: AbortSignal.timeout(10_000),
      });
      token = response.ok ? await response.json() as { id_token?: unknown } : null;
    } catch {
      token = null;
    }
    if (!token) return c.json({ error: "Google did not complete the sign-in: open the page again" }, 502);
    const account = accountOf(token.id_token, auth, now);
    if ("refused" in account) return c.json({ error: account.refused }, 403);
    const exp = Math.floor(now() / 1000) + SESSION_S;
    await setSignedCookie(c, SESSION_COOKIE, pack({ email: account.email, hd: account.hd, exp } satisfies SessionValue), auth.secret, cookie(SESSION_S));
    return c.redirect(localUrl(sent.next, origin()), 302);
  });
  routes.get("/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true, prefix: "host" });
    return c.redirect(`${origin()}/`, 302);
  });
  return routes;
}
