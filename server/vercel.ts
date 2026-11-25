import type { Server } from "node:http";
import { join, sep } from "node:path";
import { createAdaptorServer } from "@hono/node-server";
import { Hono } from "hono";
import { createApp } from "./app.ts";
import { linkSettings } from "./link.ts";
import { readConfig } from "./workspaces.ts";

export const VERCEL_MAX_DURATION = 300;

export function vercelLinkSettings(env: NodeJS.ProcessEnv) {
  const settings = linkSettings({
    ...env, WG_LINK_MAX_AGE: env.WG_LINK_MAX_AGE?.trim() || String(VERCEL_MAX_DURATION - 30),
  });
  if (!settings.linkMaxAgeMs || settings.linkMaxAgeMs > (VERCEL_MAX_DURATION - 20) * 1000) {
    throw new Error("WG_LINK_MAX_AGE must leave at least 20 seconds before the function limit");
  }
  return settings;
}

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
    if ([...env.WG_LINK_TOKEN!.trim()].length < 32) return unavailable("WG_LINK_TOKEN");
    if (URL.parse(`https://${hostedName}`)?.hostname !== hostedName?.toLowerCase()) return unavailable("WG_HOSTED");
  }
  if (!hostedName) throw new Error("set WG_HOSTED to the name that the page answers under");

  let config: ReturnType<typeof readConfig>;
  try {
    config = readConfig(undefined, env);
  } catch (error) {
    if (readOnly) throw error;
    const message = error instanceof Error ? error.message : "";
    if (message.startsWith("auth.domains ")) return unavailable("auth.domains");
    if (message.startsWith("auth.owners ")) return unavailable("auth.owners");
    return unavailable(env.WG_CONFIG_JSON !== undefined ? "WG_CONFIG_JSON" : "WG_CONFIG");
  }
  if (!readOnly && !config.auth) return unavailable("auth");
  if (!readOnly && !config.auth?.owners?.length) return unavailable("auth.owners");

  let socketSettings: ReturnType<typeof linkSettings>;
  try {
    socketSettings = readOnly ? linkSettings(env) : vercelLinkSettings(env);
  } catch (error) {
    if (!readOnly && error instanceof Error) {
      for (const name of ["WG_LINK_MAX_AGE", "WG_LINK_PONG_MS"]) {
        if (error.message.startsWith(`${name} `)) return unavailable(name);
      }
    }
    throw error;
  }

  // Vercel starts the function at the repository root. The CDN serves the built page.
  const root = process.cwd();
  let app: ReturnType<typeof createApp>;
  try {
    app = createApp({ port: 443, tailnet: null, hosted: { host: hostedName.toLowerCase() } }, {
      team: config.workspaces[0].team, dist: join(root, "dist") + sep, human: config.human, workspaces: config.workspaces, auth: config.auth,
      linkToken: env.WG_LINK_TOKEN,
      ...socketSettings,
      redisUrl: env.WG_REDIS_URL,
      redisPrefix: env.WG_REDIS_PREFIX || undefined,
      stateDir: env.WG_STATE_DIR || undefined,
      readOnly, watchMs: readOnly ? 0 : undefined,
      contractFile: join(root, "skills/work-graph/contract.json"),
      version: env.WG_VERSION || env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || "dev",
    });
  } catch (error) {
    if (!readOnly && error instanceof Error && error.message === "invalid Redis link configuration") return unavailable("WG_REDIS_URL");
    throw error;
  }
  if (readOnly) return { app, entry: { fetch: (request: Request) => app.fetch(request) } };

  // Vercel dispatches HTTP requests and upgrades to the exported server.
  const server = createAdaptorServer({ fetch: app.fetch }) as Server;
  app.injectWebSocket(server);
  return { app, entry: server };
}
