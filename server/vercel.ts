import type { Server } from "node:http";
import { join, sep } from "node:path";
import { createAdaptorServer } from "@hono/node-server";
import { Hono } from "hono";
import { createApp } from "./app.ts";
import { linkSettings } from "./link.ts";
import { readConfig } from "./workspaces.ts";

// Keep 30 seconds between the planned socket close and maxDuration in vercel.json.
const defaultLinkMaxAge = 270;

function unavailable(setting: string) {
  const app = new Hono();
  app.all("*", (c) => c.text(`Vercel full page requires ${setting}`, 500));
  return { app, entry: { fetch: app.fetch } };
}

export function createVercelApp(env: NodeJS.ProcessEnv) {
  const readOnly = env.WG_READ_ONLY !== "0";
  const hostedName = env.WG_HOSTED;
  if (!readOnly) {
    for (const name of ["WG_HOSTED", "WG_AUTH_CLIENT_ID", "WG_AUTH_CLIENT_SECRET", "WG_SESSION_SECRET", "WG_LINK_TOKEN", "WG_REDIS_URL"]) {
      if (!env[name]?.trim()) return unavailable(name);
    }
    if (env.WG_SESSION_SECRET!.trim().length < 32) return unavailable("WG_SESSION_SECRET");
  }
  if (!hostedName) throw new Error("set WG_HOSTED to the name that the page answers under");

  let config: ReturnType<typeof readConfig>;
  try {
    config = readConfig(undefined, env);
  } catch (error) {
    if (readOnly) throw error;
    return unavailable("valid config (WG_CONFIG_JSON or WG_CONFIG)");
  }
  if (!readOnly && !config.auth) return unavailable("auth");
  if (!readOnly && !config.auth?.owners?.length) return unavailable("auth.owners");

  // Vercel starts the function at the repository root. The CDN serves the built page.
  const root = process.cwd();
  const app = createApp({ port: 443, tailnet: null, hosted: { host: hostedName.toLowerCase() } }, {
    team: config.workspaces[0].team, dist: join(root, "dist") + sep, human: config.human, workspaces: config.workspaces, auth: config.auth,
    linkToken: env.WG_LINK_TOKEN,
    ...linkSettings(readOnly ? env : { ...env, WG_LINK_MAX_AGE: env.WG_LINK_MAX_AGE ?? String(defaultLinkMaxAge) }),
    redisUrl: env.WG_REDIS_URL,
    redisPrefix: env.WG_REDIS_PREFIX || undefined,
    stateDir: env.WG_STATE_DIR || undefined,
    readOnly, watchMs: readOnly ? 0 : undefined,
    contractFile: join(root, "skills/work-graph/contract.json"),
    version: env.WG_VERSION || env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || "dev",
  });
  if (readOnly) return { app, entry: { fetch: (request: Request) => app.fetch(request) } };

  // Vercel dispatches HTTP requests and upgrades to the exported server.
  const server = createAdaptorServer({ fetch: app.fetch }) as Server;
  app.injectWebSocket(server);
  return { app, entry: server };
}
