import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { createAccounts } from "./db/accounts.ts";
import { LinearError, readLinearTeams } from "./linear.ts";
import { RedisCommandFailed, RedisUnavailable, type RedisLink } from "./redis.ts";
import { LinearSignInRequired, revokeLinearToken } from "./linearauth.ts";
import type { Session } from "./auth.ts";
import type { Telemetry, UsageScope } from "./telemetry.ts";
import type { Tenant } from "./tenants.ts";

import type { Workspace } from "./workspaces.ts";
import type { InWorkspace } from "./linearaccess.ts";
import { createSetupTeam, teamSetup } from "./teamsetup.ts";

type Accounts = ReturnType<typeof createAccounts>;
type Account = NonNullable<Awaited<ReturnType<Accounts["readTenant"]>>>;
type Connection = Account["connections"][number];

export function accountUsage(account: Account, selected?: Pick<Connection, "workspaceId" | "linearOrgId"> | null): UsageScope | null {
  const workspace = selected === undefined ? account.connections.find(({ kind }) => kind === "oauth") : selected;
  return workspace ? {
    tenant: account.id, workspace: { id: workspace.workspaceId, organization: workspace.linearOrgId },
  } : null;
}
type Scope = { accounts: Accounts; tenant: Tenant; session: Session };
type Options = {
  runLinear: (tenant: Tenant, workspace: Workspace) => InWorkspace;
  access: (c: Context) => Scope | Response | Promise<Scope | Response>;
  redis?: RedisLink;
  prefix: string;
  now: () => number;
  pageUrl: string;
  telemetry?: Telemetry | null;
  endSession: (c: Context, session: Session) => Promise<void>;
};
const windowMs = 600_000;
const maxAttempts = 10;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const personalKey = /^lin_api_[A-Za-z0-9]{20,128}$/;

const redisAttempt = `
  local time = redis.call('TIME')
  local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
  local window = tonumber(ARGV[1])
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
  if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then
    local first = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
    return tonumber(first[2]) + window - now
  end
  redis.call('ZADD', KEYS[1], now, ARGV[3])
  redis.call('PEXPIRE', KEYS[1], window)
  return 0
`;

export function attemptLimit({ redis, prefix, now }: Pick<Options, "redis" | "prefix" | "now">,
  namespace = "account-key-attempts:", window = windowMs, limit = maxAttempts) {
  const attempts = new Map<string, number[]>();
  let nextPrune = 0;
  return async (account: string) => {
    if (redis) {
      return Number(await redis.write((client) =>
        client.eval(redisAttempt, 1, prefix + namespace + account, window, limit, randomUUID()), false));
    }
    const time = now(), cutoff = time - window;
    if (time >= nextPrune) {
      for (const [id, times] of attempts) if (times.at(-1)! <= cutoff) attempts.delete(id);
      nextPrune = time + window;
    }
    const recent = attempts.get(account)?.filter((at) => at > cutoff) ?? [];
    if (recent.length >= limit) return recent[0] + window - time;
    attempts.set(account, [...recent, time]);
    return 0;
  };
}

function publicConnection(row: Connection) {
  return {
    id: row.id, workspace_id: row.workspaceId, name: row.name, kind: row.kind, status: row.status,
    team: row.team, team_labels: row.teamLabels, position: row.position,
    owner_name: row.ownerName, created_at: row.createdAt,
  };
}

async function body(c: Context): Promise<Record<string, unknown>> {
  const value: unknown = await c.req.json().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LinearError("Send a JSON object", 400);
  return value as Record<string, unknown>;
}

function displayName(value: unknown) {
  if (typeof value !== "string" || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value)) return null;
  const name = value.trim();
  return name && [...name].length <= 40 ? name : null;
}

function findConnection(rows: Connection[], id: string) {
  const row = uuid.test(id) && rows.find((connection) => connection.id === id.toLowerCase());
  if (!row) throw new LinearError("Workspace connection not found", 404);
  return row;
}

async function currentTeams(tenant: Tenant, row: Connection) {
  const workspace = tenant.workspaces.find(({ id }) => id === row.workspaceId);
  if (!workspace?.key || workspace.needsKey || row.status !== "ok") {
    throw new LinearError("This workspace needs a new credential", 409);
  }
  let key = workspace.oauthKey ? await workspace.oauthKey() : workspace.key;
  try {
    return { ...await readLinearTeams(key, row.kind), key };
  } catch (error) {
    if (!(error instanceof LinearError) || error.status !== 401) throw error;
    if (workspace.oauthKey) {
      key = await workspace.oauthKey(key);
      return { ...await readLinearTeams(key, row.kind), key };
    }
    await workspace.rejectApiKey?.();
    throw new LinearError("Linear refused the workspace key. Replace it in your account.", 409);
  }
}

export function accountRoutes(options: Options) {
  const attempt = attemptLimit(options);
  const { telemetry } = options;

  const routes = new Hono<{ Variables: Scope & { account: Account } }>();

  routes.use(async (c, next) => {
    const access = await options.access(c);
    if (access instanceof Response) return access;
    const { accounts, tenant, session } = access;
    const account = await accounts.readTenant(tenant.id);
    if (!account) return c.json({ error: "Account not found" }, 404);
    c.set("accounts", accounts);
    c.set("tenant", tenant);
    c.set("session", session);
    c.set("account", account);
    await next();
  });
  routes.use(bodyLimit({ maxSize: 16_384, onError: (c) => c.json({ error: "Request body too large" }, 413) }));

  routes.onError((error, c) => {
    if (error instanceof RedisUnavailable || error instanceof RedisCommandFailed) {
      c.header("Retry-After", "1");
      return c.json({ error: "The account service is temporarily unavailable" }, 503);
    }
    if (error instanceof LinearSignInRequired) return c.json({ error: "Sign in with Linear to restore this workspace" }, 409);
    if (error instanceof LinearError) {
      const status = error.status;
      switch (status) {
        case 400: case 403: case 404: case 409: case 429: return c.json({ error: error.message }, status);
        case 401: return c.json({ error: "Linear refused the workspace key" }, 400);
      }
    }
    switch (error.message) {
      case "Connection not found": return c.json({ error: "Workspace connection not found" }, 404);
      case "Account not found": return c.json({ error: "Account not found" }, 404);
      case "Connection limit reached": return c.json({ error: "Workspace connection limit reached" }, 409);
      case "Coordinator token limit reached": return c.json({ error: error.message }, 409);
      case "Coordinator token not found": return c.json({ error: error.message }, 404);
      case "Database record already exists": return c.json({ error: "This Linear workspace is already connected" }, 409);
      case "Invalid connection position": return c.json({ error: "Invalid workspace position" }, 400);
      case "The workspace credential changed. Try again.": return c.json({ error: error.message }, 409);
      case "The replacement key must belong to the same Linear organization": return c.json({ error: error.message }, 400);
    }
    return c.json({ error: "The account request could not be completed" }, 500);
  });

  async function verify(c: Context, account: string) {
    const { key } = await body(c);
    if (typeof key !== "string" || !personalKey.test(key)) throw new LinearError("Enter a Linear personal API key", 400);
    const retry = await attempt(account);
    if (retry > 0) {
      c.header("Retry-After", String(Math.ceil(retry / 1000)));
      throw new LinearError("Too many workspace key attempts. Try again later.", 429);
    }
    const result = await readLinearTeams(key, "api_key", true);
    if (!result.teams.length) throw new LinearError("This key cannot read any Linear teams", 400);
    return { ...result, credential: { kind: "api_key" as const, key } };
  }

  routes.get("/", async (c) => {
    const { accounts, account } = c.var;
    const { id, human, connections, nameConfirmed, onboardingSkipped } = account;
    const { tokens, connected } = await accounts.tokenSummary(id);
    return c.json({
      human, connections: connections.map(publicConnection), tokens, pageUrl: options.pageUrl,
      onboarding: {
        name: nameConfirmed, workspaces: true, teams: connections.every(({ team }) => !!team),
        token: tokens.length > 0, connected, skipped: onboardingSkipped,
      },
    });
  });

  routes.patch("/", async (c) => {
    const input = await body(c);
    const human = displayName(input.human);
    if (!human) {
      return c.json({ error: "Enter a name of 1 to 40 characters without control characters" }, 400);
    }
    await c.var.accounts.setHuman(c.var.account.id, human);
    return c.json({ human, message: "Set the same human name in your wg config." });
  });

  routes.post("/tokens", async (c) => {
    const name = displayName((await body(c)).name);
    if (!name) return c.json({ error: "Enter a token name of 1 to 40 characters without control characters" }, 400);
    const { id, token } = await c.var.accounts.createToken(c.var.account.id, name);
    telemetry?.emit("token_created", {}, () => accountUsage(c.var.account), c.var.account.id);
    c.header("Cache-Control", "no-store");
    return c.json({ id, name, token }, 201);
  });

  routes.delete("/tokens/:id", async (c) => {
    const id = c.req.param("id");
    if (!uuid.test(id)) return c.json({ error: "Coordinator token not found" }, 404);
    await c.var.accounts.revokeToken(c.var.account.id, id);
    telemetry?.emit("token_revoked", {}, () => accountUsage(c.var.account), c.var.account.id);
    return c.json({ ok: true });
  });

  routes.post("/onboarding", async (c) => {
    const { name, skipped, step, complete } = await body(c);
    if ((name !== undefined && name !== true) || (skipped !== undefined && typeof skipped !== "boolean") ||
        (step !== undefined && step !== "workspaces" && step !== "teams" && step !== "setup") ||
        (complete !== undefined && complete !== true) ||
        [name, skipped, step, complete].filter((value) => value !== undefined).length === 0) {
      return c.json({ error: "Invalid setup progress" }, 400);
    }
    const { account, accounts } = c.var;
    const resolve = () => accountUsage(account);
    if (name !== undefined || skipped !== undefined) {
      await accounts.setOnboarding(account.id, name, skipped);
      if (name && !account.nameConfirmed) telemetry?.emit("onboarding_step", { step: "name" }, resolve, account.id);
      if (skipped && !account.onboardingSkipped) telemetry?.emit("onboarding_skipped", {}, resolve, account.id);
    }
    if (telemetry && (step === "workspaces" ||
        (step === "teams" && account.connections.every(({ team }) => !!team)) ||
        (step === "setup" && (await accounts.tokenSummary(account.id)).tokens.length > 0))) {
      telemetry.emit("onboarding_step", { step }, resolve, account.id);
    }
    if (complete && telemetry && account.nameConfirmed && account.connections.every(({ team }) => !!team)) {
      const { tokens, connected } = await accounts.tokenSummary(account.id);
      if (connected && tokens.length) {
        let claimed: Promise<boolean> | undefined;
        const once = () => claimed ??= accounts.claimOnboardingComplete(account.id);
        telemetry.emit("onboarding_step", { step: "connect" }, resolve, account.id, once);
        telemetry.emit("onboarding_complete", {}, resolve, account.id, once);
      }
    }
    return c.json({ ok: true });
  });

  routes.delete("/", async (c) => {
    if ((await body(c)).confirm !== "delete") return c.json({ error: "Enter delete to confirm account deletion" }, 400);
    const { accounts, account, session } = c.var;
    const oauth = account.connections.find(({ kind }) => kind === "oauth");
    const credential = oauth && await accounts.readCredential(account.id, oauth.id).catch(() => null);
    const revocation = oauth && credential?.kind === "oauth" && await revokeLinearToken(credential.refreshToken)
      ? { id: oauth.id, refreshToken: credential.refreshToken }
      : undefined;
    const revoked = await accounts.deleteAccount(account.id, revocation);
    telemetry?.emit("account_deleted", {}, () => accountUsage(account), account.id);
    await options.endSession(c, session);
    return c.json(revoked ? { ok: true, revoked } : {
      ok: true, revoked, message: "You can remove the app under Authorized applications in Linear's settings.",
    });
  });

  routes.post("/workspaces", async (c) => {
    const { accounts, account } = c.var;
    const { credential, identity, teams } = await verify(c, account.id);
    const { workspaceId, organization, name, ownerName } = identity;
    const id = await accounts.addConnection(account.id, {
      workspaceId, linearOrgId: organization, name, ownerName, credential,
      team: teams.length === 1 ? teams[0].key : "", teamLabels: false,
    });
    const saved = await accounts.readTenant(account.id);
    const connection = findConnection(saved?.connections ?? [], id);
    telemetry?.emit("workspace_attached", { kind: connection.kind }, () => accountUsage(account, connection), account.id);
    return c.json({ connection: publicConnection(connection), teams }, 201);
  });

  routes.put("/workspaces/:id/key", async (c) => {
    const { accounts, account } = c.var;
    const row = findConnection(account.connections, c.req.param("id"));
    if (row.kind !== "api_key") throw new LinearError("The sign-in workspace uses Linear sign-in", 403);
    const { credential, identity, teams } = await verify(c, account.id);
    await accounts.replaceCredential(account.id, row.id, credential, {
      ownerName: identity.ownerName, organization: identity.organization, teams: teams.map(({ key }) => key),
    });
    const saved = await accounts.readTenant(account.id);
    return c.json({ connection: publicConnection(findConnection(saved?.connections ?? [], row.id)), teams });
  });

  routes.patch("/workspaces/:id", async (c) => {
    const { accounts, account, tenant } = c.var;
    const row = findConnection(account.connections, c.req.param("id"));
    const { team, team_labels, position } = await body(c);
    if (team !== undefined && (typeof team !== "string" || !team)) throw new LinearError("Select a Linear team", 400);
    if (team_labels !== undefined && typeof team_labels !== "boolean") throw new LinearError("team_labels must be true or false", 400);
    if (position !== undefined && (typeof position !== "number" || !Number.isInteger(position) ||
        position < 0 || position >= account.connections.length)) throw new LinearError("Invalid workspace position", 400);
    if (team === undefined && team_labels === undefined && position === undefined) {
      throw new LinearError("Send a team, team_labels, or position", 400);
    }
    let checkedKey: string | undefined;
    if (team !== undefined) {
      const { teams, key } = await currentTeams(tenant, row);
      if (!teams.some((entry) => entry.key === team)) throw new LinearError("The workspace credential cannot read that team", 400);
      checkedKey = key;
    }
    await accounts.updateConnectionSettings(account.id, row.id, { team, teamLabels: team_labels, position }, checkedKey);
    const saved = await accounts.readTenant(account.id);
    return c.json({ connection: publicConnection(findConnection(saved?.connections ?? [], row.id)) });
  });

  const setupAttempt = attemptLimit(options, "account-team-setup:");
  const teamKey = (value: unknown) => {
    if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(value)) {
      throw new LinearError("Enter a valid team key", 400);
    }
    return value.toUpperCase();
  };
  const shellArg = (value: string) => /^[a-z0-9_-]+$/i.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'";
  async function setup<T>(c: Context<{ Variables: Scope & { account: Account } }>, key: string,
    extra: string, perform: (row: Connection) => Promise<T>) {
    const { tenant, account } = c.var;
    const row = findConnection(account.connections, c.req.param("id") ?? "");
    const workspace = tenant.workspaces.find(w => w.id === row.workspaceId);
    if (!workspace?.key || workspace.needsKey || row.status !== "ok") {
      throw new LinearError("This workspace needs a new credential", 409);
    }
    const retry = await setupAttempt(account.id);
    if (retry > 0) {
      c.header("Retry-After", String(Math.ceil(retry / 1000)));
      throw new LinearError("Too many team setup requests. Try again later.", 429);
    }
    try {
      return await options.runLinear(tenant, workspace)(() => perform(row));
    } catch (error) {
      if (error instanceof LinearError && [404, 409].includes(error.status)) throw error;
      throw new LinearError(`Linear did not confirm team setup. Run wg setup --workspace ${shellArg(row.workspaceId)} --team ${key}${extra}`, 409);
    }
  }

  routes.post("/workspaces/:id/teams", async c => {
    const input = await body(c);
    const key = teamKey(input.key);
    const name = displayName(input.name);
    const parent = input.parent == null ? null : teamKey(input.parent);
    const privacy = input.private;
    if (!name || typeof privacy !== "boolean") throw new LinearError("Enter a team name and private setting", 400);
    const args = ` --name ${shellArg(name)}${parent ? " --parent " + parent : ""}${privacy ? " --private" : ""} --apply`;
    return c.json(await setup(c, key, args, () => createSetupTeam({ key, name, parent, private: privacy })));
  });

  routes.on(["GET", "POST"], "/workspaces/:id/teams/:key/setup", async c => {
    const key = teamKey(c.req.param("key"));
    const apply = c.req.method === "POST";
    return c.json(await setup(c, key, apply ? " --apply" : "", row => teamSetup(key, c.var.account.human, row.teamLabels, apply)));
  });

  routes.get("/workspaces/:id/teams", async (c) => {
    const { tenant, account } = c.var;
    const { teams } = await currentTeams(tenant, findConnection(account.connections, c.req.param("id")));
    return c.json({ teams });
  });

  routes.delete("/workspaces/:id", async (c) => {
    const { accounts, account } = c.var;
    const row = findConnection(account.connections, c.req.param("id"));
    if (row.kind !== "api_key") throw new LinearError("The sign-in workspace cannot be removed", 403);
    await accounts.removeConnection(account.id, row.id, true);
    telemetry?.emit("workspace_removed", { kind: row.kind }, () => accountUsage(account, row), account.id);
    return c.json({ ok: true });
  });
  return routes;
}
