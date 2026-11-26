import { randomBytes, randomUUID } from "node:crypto";
import { Server } from "node:http";
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

const productionSetting = ["DATABASE_URL", "WG_HOSTED", "WG_DATA_KEY", "WG_SESSION_SECRET"]
  .find((name) => process.env[name] !== undefined) ??
  (process.env.NODE_ENV === "production" ? "NODE_ENV" : undefined);
if (productionSetting) {
  console.error(`Service preview cannot start with ${productionSetting} set for production. Use a local development environment.`);
  process.exit(1);
}

const { values } = parseArgs({ options: { port: { type: "string", default: "4748" }, "refuse-access": { type: "boolean" } } });
const port = Number(values.port);
const host = "example.com";
const origin = `https://${host}`;
const auth = { clientId: "stub", clientSecret: randomUUID(), secret: randomBytes(32).toString("hex") };
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
const project = { id: "project", name: "Example project", url: "https://example.com/project", status: { name: "In progress", type: "started" } };
const exampleTeam = { id: "work-graph", key: "WG", name: "Work Graph" };
const pageInfo = { hasNextPage: false, endCursor: null };
const empty = { nodes: [], pageInfo };
const started = { id: "started", name: "In progress", type: "started", color: "#4466aa", position: 1 };
const issue = {
  id: "issue", identifier: "WG-1", title: "Example issue", description: "", priority: 0,
  url: "https://example.com/issue", sortOrder: 0, updatedAt: new Date().toISOString(),
  project, team: exampleTeam, state: { ...started, id: "needs-ada", name: "Needs Ada" }, assignee: null, labels: empty,
  relations: empty, inverseRelations: empty, attachments: empty,
  comments: { nodes: [{ id: "card", body: '**work-graph node card**\n\n```json\n{"wg":1,"key":"example","kind":"task"}\n```' }], pageInfo },
};
const graceIssue = {
  ...issue, id: "grace-issue", identifier: "WG-2", title: "Check the shared project",
  sortOrder: 1, state: { ...started, id: "needs-grace", name: "Needs Grace" },
  comments: { nodes: [{ id: "grace-card", body: issue.comments.nodes[0].body.replace('"example"', '"check"') }], pageInfo },
};
const issues = [issue, graceIssue];
const accounts = tenants.accounts;
const people = await Promise.all([
  { id: "ada", name: "Ada", org: workspace },
  { id: "grace", name: "Grace", org: extra },
  { id: "pat", name: "Pat", org: workspace },
].map(async (person) => {
  const key = randomUUID();
  const email = person.id + "@example.com";
  const accountId = await tenants.signIn({
    linearUserId: person.id, linearOrgId: person.org.id, name: person.name, email,
  }, {
    workspaceId: person.org.urlKey, linearOrgId: person.org.id, name: person.org.name,
    team: person.org === workspace ? "WG" : "DEMO", teamLabels: false,
    credential: { kind: "oauth", key, refreshToken: randomUUID(), expiresAt: new Date(Date.now() + 86_400_000) },
  });
  return { ...person, key, email, accountId };
}));
const [owner, collaborator, viewer] = people;
const ownerAccount = (await accounts.readTenant(owner.accountId))!;
const scope = [owner.accountId, ownerAccount.connections[0].id, project.id] as const;
const { created } = (await accounts.shares.make([...scope], project.name))!;
await accounts.shares.join(collaborator.accountId, created.collab!);
await accounts.shares.join(viewer.accountId, created.view!);
const [membership] = await accounts.shares.memberships(collaborator.accountId);
await accounts.shares.requestAccess([...scope], membership.id);
await sql.query(`UPDATE project_members SET access_requested_at = now() - interval '1 hour',
  access_request_limit_until = NULL WHERE id = $1`, [membership.id]);
// Leave the read-only link off so the preview covers both initial link states.
await accounts.shares.revoke([...scope], "view");
for (const [person, node, job] of [[owner, "example", "dispatch"], [collaborator, "check", "review"]] as const) {
  await accounts.claims({ project: [...scope], account: person.accountId,
    ...(person === collaborator && { membership: membership.id }) }, { kind: "post", node, job, lease: 3600, takeover: false });
}
await sql.query(`UPDATE node_claims SET claimed_at = now() - interval '1 hour',
  renewed_at = now() - interval '30 minutes', lease_until = now() - interval '1 minute'
  WHERE tenant_id = $1 AND connection_id = $2 AND project_id = $3 AND node_key = 'check'`, [...scope]);
const ref = { tenant: owner.accountId, workspace: "example", id: project.id };
async function previewCoordinators() {
  const { coordinators } = await app.link.hub.presence(ref);
  if (coordinators.filter(({ connected }) => connected).length === 2) return;
  async function connect(session: string, member?: Parameters<typeof app.link.hub.joinCoordinator>[2]) {
    const connection = await app.link.hub.joinCoordinator({
      close() { void connection.closed(); }, send() {},
    }, ref, member);
    await connection.receive(JSON.stringify({ v: 1, type: "hello", payload: { session, plan: "example" } }));
    await connection.receive(JSON.stringify({ v: 1, type: "state", payload: { mode: "waiting" } }));
    return connection;
  }
  await connect("owner");
  const second = await connect("collaborator", {
    account: collaborator.accountId, name: collaborator.name, workspace: `shared:${membership.id}`, ownerName: owner.name,
  });
  await second.receive(JSON.stringify({ v: 1, type: "asks", payload: { asks: [
    { id: "question", key: "check", issue: "WG-2", from: "worker", body: "Can you check the result?", at: new Date().toISOString() },
  ] } }));
}

const teamMembers = new Set([owner.id]);
let invitationPending = false;

// The preview runs in its own process. No request can leave it for Linear.
globalThis.fetch = async (input, init) => {
  const url = new URL(input.toString());
  if (url.origin !== "https://api.linear.app") return new Response(null, { status: 502 });
  if (url.pathname === "/oauth/revoke") return new Response(null, { status: 200 });
  const key = new Headers(init?.headers).get("Authorization");
  const person = people.find((person) => key === `Bearer ${person.key}`);
  const organization = person?.org ?? (key === extraKey ? extra : null);
  if (url.pathname !== "/graphql" || !organization) return new Response(null, { status: 401 });
  const { query, variables } = JSON.parse(String(init?.body));
  const teams = organization === workspace ? [exampleTeam, { key: "OPS", name: "OPS" }] :
    [{ key: "DEMO", name: "DEMO" }, { key: "LAB", name: "LAB" }];
  const visible = person ? organization === workspace && teamMembers.has(person.id) : false;
  const data = (data: object) => Response.json({ data });
  const identity = person ?? owner;
  const linearViewer = { id: identity.id, name: identity.name, email: identity.email };
  const graphProject = { ...project, projectMilestones: empty, documents: empty, issues: empty, teams: { nodes: [exampleTeam] } };

  if (query.includes("ProjectAccessTeam")) return data({ organization, project: graphProject });
  if (query.includes("CheckProjectAccess")) {
    return data({ organization, teams: { nodes: visible ? [exampleTeam] : [] }, projects: { nodes: visible ? [project] : [] } });
  }
  if (query.includes("AccessWorkspaceUser") || query.includes("AccessWorkspaceMember")) {
    const found = people.find((p) => p.org === organization && (p.id === variables.id || p.email === variables.email));
    return data({ users: { nodes: found ? [{ id: found.id, active: true }] : [] } });
  }
  if (query.includes("AccessTeamMember")) {
    return data({ team: { members: { nodes: teamMembers.has(variables.user) ? [{ id: variables.user }] : [] } } });
  }
  if (query.includes("AccessPendingInvites")) {
    return data({ organizationInvites: { pageInfo, nodes: invitationPending ?
      [{ email: collaborator.email, expiresAt: null, acceptedAt: null }] : [] } });
  }
  if (query.includes("AddTeamAccess") || query.includes("InviteProjectMember")) {
    if (values["refuse-access"]) return Response.json({ errors: [{ message: "Insufficient permissions" }] }, { status: 403 });
    if (query.includes("AddTeamAccess")) {
      teamMembers.add(variables.input.userId);
      return data({ teamMembershipCreate: { success: true } });
    }
    invitationPending = true;
    return data({ organizationInviteCreate: { success: true } });
  }
  if (query.includes("issue(id:")) {
    const found = issues.find(({ id }) => id === variables.id);
    return data({ issue: visible && found ? { ...found, comments: empty } : null });
  }
  if (query.includes("teams(first:10")) return data({ teams: { nodes: [{ ...exampleTeam, states: { nodes: [started, ...issues.map((item) => item.state)] }, members: empty }] } });
  if (query.includes("issueLabels(")) return data({ issueLabels: empty });
  if (query.includes("issues(first:1,")) return data({ issues: empty, comments: empty, project: { documents: empty } });
  if (query.includes("project(id:")) {
    return data({ viewer: linearViewer, project: visible && variables.id === project.id ? { ...graphProject, issues: { nodes: issues, pageInfo } } : null });
  }
  return data({
    viewer: linearViewer,
    organization,
    teams: { nodes: query.includes("projects(") ?
      [{ projects: { nodes: visible ? [project] : [], pageInfo } }] : teams, pageInfo },
  });
};

const server = serve({ port, hostname: "127.0.0.1", async fetch(request) {
  const url = new URL(request.url);
  const address = server.address();
  if (!address || typeof address === "string" || url.host !== `127.0.0.1:${address.port}`) {
    return new Response("Use the loopback address shown in the terminal.", { status: 403 });
  }
  if (url.pathname === "/auth/login") {
    const identity = url.searchParams.get("as");
    const person = people.find(({ id }) => id === identity) ?? owner;
    if (identity) await accounts.setOnboarding(person.accountId, undefined, true);
    await previewCoordinators();
    const value = pack({ accountId: person.accountId, email: person.email, id: randomUUID(), exp: Math.floor(Date.now() / 1000) + SESSION_S });
    const cookie = await serializeSigned("wg_preview_session", value, auth.secret, { path: "/", httpOnly: true, sameSite: "Strict" });
    return new Response(null, { status: 302, headers: {
      "Set-Cookie": cookie, Location: localUrl(url.searchParams.get("next") ?? undefined, url.origin),
    } });
  }

  const headers = new Headers(request.headers);
  const accountRead = url.pathname === "/api/account" && request.method === "GET";
  const shareWrite = request.method === "POST" && /^\/api\/projects\/[^/]+\/share(?:\/[^/]+(?:\/rotate)?)?$/.test(url.pathname);
  if (accountRead || shareWrite) headers.delete("accept-encoding");
  headers.set("host", host);
  if (headers.get("origin") === url.origin) headers.set("origin", origin);
  const cookie = /(?:^|;\s*)wg_preview_session=([^;]+)/.exec(headers.get("cookie") ?? "")?.[1];
  if (cookie) headers.set("cookie", `__Host-${SESSION_COOKIE}=${cookie}`);
  const response = await app.fetch(new Request(origin + url.pathname + url.search, new Request(request, { headers })));
  if (accountRead && response.ok) {
    return Response.json({ ...await response.json(), pageUrl: url.origin }, { headers: response.headers });
  }
  if (shareWrite && response.ok) {
    const body = await response.json();
    const useLoopback = (link: { url?: string }) => link.url ? { url: link.url.replace(origin, url.origin) } : link;
    const local = body.view && body.collab ? { view: useLoopback(body.view), collab: useLoopback(body.collab) } : useLoopback(body);
    return Response.json(local, { headers: response.headers });
  }
  if (response.headers.get("location") === origin + "/") response.headers.set("location", "/");
  if (response.headers.get("set-cookie")?.includes(`__Host-${SESSION_COOKIE}=`)) {
    response.headers.set("set-cookie", "wg_preview_session=; Path=/; Max-Age=0");
  }
  return response;
} }, ({ port }) => console.log(`Service preview at http://127.0.0.1:${port}/`));

server.on("upgrade", (request) => {
  const address = server.address();
  if (!address || typeof address === "string") return;
  const localHost = `127.0.0.1:${address.port}`;
  if (request.headers.host !== localHost || request.headers.origin !== `http://${localHost}`) return;
  request.headers.host = host;
  request.headers.origin = origin;
  const cookie = /(?:^|;\s*)wg_preview_session=([^;]+)/.exec(request.headers.cookie ?? "")?.[1];
  if (cookie) request.headers.cookie = `__Host-${SESSION_COOKIE}=${cookie}`;
});
if (server instanceof Server) app.injectWebSocket(server);

stopOnSignals(async () => {
  await app.link.shutdown();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  tenants.close();
  await sql.close();
}, (signal, handle) => process.on(signal, handle), (code) => process.exit(code));
