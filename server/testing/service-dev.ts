import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { serializeSigned } from "hono/utils/cookie";
import { createApp } from "../app.ts";
import { localUrl, pack, SESSION_COOKIE, SESSION_S } from "../auth.ts";
import { credentialCrypto } from "../db/crypto.ts";
import { migrate } from "../db/migrations.ts";
import { dbTenants } from "../db/tenants.ts";
import { stopOnSignals } from "../link.ts";
import { pgliteSql } from "./pglite.ts";

const { values } = parseArgs({ options: { port: { type: "string", default: "4748" } } });
const port = Number(values.port);
const host = "example.com";
const origin = `https://${host}`;
const auth = { clientId: "stub", clientSecret: randomUUID(), secret: randomBytes(32).toString("hex") };
const email = "ada@example.com";
const accessKey = randomUUID();
const extraKey = "lin_api_example00000000000000000000";

const sql = await pgliteSql();
await migrate(sql);
const tenants = dbTenants(sql, credentialCrypto({ WG_DATA_KEY: randomBytes(32).toString("base64") }), { linearAuth: auth });
const app = createApp({ port, tailnet: null, hosted: { host } }, {
  team: "", dist: fileURLToPath(new URL("../../dist/", import.meta.url)),
  stateDir: undefined, linearAuth: auth, tenants, watchMs: 0, readOnly: false, workspaces: [],
});
const workspace = { id: "home", name: "Example", urlKey: "example" };
const extra = { id: "extra", name: "Extra", urlKey: "extra" };
const teamList = (keys: string[]) => keys.map((key) => ({ key, name: key === "WG" ? "Work Graph" : key }));

// The preview runs in its own process. No request can leave it for Linear.
globalThis.fetch = async (input, init) => {
  const url = new URL(input.toString());
  if (url.origin !== "https://api.linear.app") return new Response(null, { status: 502 });
  if (url.pathname === "/oauth/revoke") return new Response(null, { status: 200 });
  const key = new Headers(init?.headers).get("Authorization");
  const organization = key === `Bearer ${accessKey}` ? workspace : key === extraKey ? extra : null;
  if (url.pathname !== "/graphql" || !organization) return new Response(null, { status: 401 });
  const { query } = JSON.parse(String(init?.body));
  const pageInfo = { hasNextPage: false, endCursor: null };
  const teams = teamList(organization === workspace ? ["WG", "OPS"] : ["DEMO", "LAB"]);
  return Response.json({ data: {
    viewer: { id: "ada", name: "Ada", email },
    organization,
    teams: { nodes: query.includes("projects(") ? [{ projects: { nodes: [], pageInfo } }] : teams, pageInfo },
  } });
};

const server = serve({ port, hostname: "127.0.0.1", async fetch(request) {
  const url = new URL(request.url);
  const address = server.address();
  if (!address || typeof address === "string" || url.host !== `127.0.0.1:${address.port}`) {
    return new Response("Use the loopback address shown in the terminal.", { status: 403 });
  }
  if (url.pathname === "/auth/login") {
    const accountId = await tenants.signIn({
      linearUserId: "ada", linearOrgId: workspace.id, name: "Ada", email,
    }, {
      workspaceId: workspace.urlKey, linearOrgId: workspace.id, name: workspace.name, team: "WG",
      teamLabels: false, credential: { kind: "oauth", key: accessKey, refreshToken: randomUUID(), expiresAt: new Date(Date.now() + 86_400_000) },
    });
    const value = pack({ accountId, email, id: randomUUID(), exp: Math.floor(Date.now() / 1000) + SESSION_S });
    const cookie = await serializeSigned("wg_preview_session", value, auth.secret, { path: "/", httpOnly: true, sameSite: "Strict" });
    return new Response(null, { status: 302, headers: {
      "Set-Cookie": cookie, Location: localUrl(url.searchParams.get("next") ?? undefined, url.origin),
    } });
  }

  const headers = new Headers(request.headers);
  const accountRead = url.pathname === "/api/account" && request.method === "GET";
  if (accountRead) headers.delete("accept-encoding");
  headers.set("host", host);
  if (headers.get("origin") === url.origin) headers.set("origin", origin);
  const cookie = /(?:^|;\s*)wg_preview_session=([^;]+)/.exec(headers.get("cookie") ?? "")?.[1];
  if (cookie) headers.set("cookie", `__Host-${SESSION_COOKIE}=${cookie}`);
  const response = await app.fetch(new Request(origin + url.pathname + url.search, new Request(request, { headers })));
  if (accountRead && response.ok) {
    return Response.json({ ...await response.json(), pageUrl: url.origin }, { headers: response.headers });
  }
  if (response.headers.get("location") === origin + "/") response.headers.set("location", "/");
  if (response.headers.get("set-cookie")?.includes(`__Host-${SESSION_COOKIE}=`)) {
    response.headers.set("set-cookie", "wg_preview_session=; Path=/; Max-Age=0");
  }
  return response;
} }, ({ port }) => console.log(`Service preview at http://127.0.0.1:${port}/`));

stopOnSignals(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await app.link.shutdown();
  tenants.close();
  await sql.close();
}, (signal, handle) => process.on(signal, handle), (code) => process.exit(code));
