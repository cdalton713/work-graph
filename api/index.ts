// The read-only viewer on Vercel (README "Host a read-only viewer"). Vercel serves the built page (`dist/`) as
// static files and sends `/api/*`, `/auth/*`, and `/healthz` to this function (`vercel.json`).
//
// It is always read-only. The link needs one process that lives as long as its sockets and keeps the rooms in
// memory, and a function instance is not that: the full page runs from `server/main.ts`.
import { join, sep } from "node:path";
import { createApp } from "../server/app.ts";
import { readConfig } from "../server/workspaces.ts";

const hostedName = process.env.WG_HOSTED;
if (!hostedName) throw new Error("set WG_HOSTED to the name that the page answers under");
const config = readConfig(undefined);
// Vercel runs a function with the root of the repository as its working directory. `includeFiles` of
// `vercel.json` puts the contract file there; the page files are on the CDN, not in the function.
const root = process.cwd();
const app = createApp({ port: 443, tailnet: null, hosted: { host: hostedName.toLowerCase() } }, {
  team: config.workspaces[0].team, dist: join(root, "dist") + sep, human: config.human, workspaces: config.workspaces, auth: config.auth,
  readOnly: true, watchMs: 0,
  contractFile: join(root, "skills/work-graph/contract.json"),
  version: process.env.WG_VERSION || process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || "dev",
});

export default { fetch: (request: Request) => app.fetch(request) };
