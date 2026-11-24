#!/usr/bin/env node
// Server for the work-graph UI. Node runs this TypeScript file directly (type stripping).
// `wg ui` runs it on this machine. `--hosted <name>` runs it as the hosted page behind the edge
// proxy of deploy/compose.yml.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import type { Rules } from "./access.ts";
import { createApp } from "./app.ts";
import { serve as serveTailnet } from "./tailnet.ts";
import { readConfig } from "./workspaces.ts";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "4747" }, project: { type: "string" }, "no-open": { type: "boolean" }, "no-tailnet": { type: "boolean" },
    team: { type: "string" },
    workspace: { type: "string" },
    hosted: { type: "string" },
  },
});
// `--hosted <name>` or WG_HOSTED: the public name of a hosted page (README "Host the page").
const hostedName = values.hosted ?? process.env.WG_HOSTED;
const hosted = hostedName ? { host: hostedName.toLowerCase() } : null;
const port = Number(values.port);
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
// `tailnet` is set while Tailscale Serve sends requests to this server (see below).
const rules: Rules = { port, tailnet: null, hosted };
const config = readConfig(values.team);
const app = createApp(rules, { team: config.workspaces[0].team, dist, human: config.human, workspaces: config.workspaces });

// A signal must end the process through `exit`, so that Tailscale Serve stops with it. Before that, the link
// closes each socket with a close frame (code 1012), so that each client connects again at once.
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void app.link.shutdown().finally(() => process.exit(0));
  });
}

const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
  if (hosted) {
    console.log(`work-graph UI: https://${hosted.host}/ on 127.0.0.1:${port}`);
    return;
  }
  const query = values.project ? `?${new URLSearchParams({ project: values.project, ...(values.workspace ? { workspace: values.workspace } : {}) })}` : "";
  const url = `http://127.0.0.1:${port}/${query}`;
  console.log(`work-graph UI: ${url}  (Ctrl-C stops it)`);
  if (!values["no-open"]) {
    spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  }
  if (values["no-tailnet"]) return;
  // The page is also on the tailnet while this server runs, for the phone. This server still
  // listens on 127.0.0.1 only: Tailscale Serve sends the tailnet requests to it.
  const off = (reason: string) => {
    rules.tailnet = null;
    console.log(`tailnet: off (${reason}). The page is on this machine only.`);
  };
  serveTailnet(port, () => off("Tailscale Serve stopped")).then((me) => {
    rules.tailnet = me;
    console.log(`on your tailnet: https://${me.host}/${query}  (--no-tailnet turns this off)`);
  }, (error: Error) => off(error.message));
});
// The link (`/api/link`) is a WebSocket upgrade of this same server.
app.injectWebSocket(server as import("node:http").Server);
server.on("error", (error: NodeJS.ErrnoException) => {
  console.error(error.code === "EADDRINUSE" ? `port ${port} is in use; pass --port` : error.message);
  process.exit(1);
});
