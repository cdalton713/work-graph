import { randomUUID } from "node:crypto";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "./app.ts";
import { credentialCrypto } from "./db/crypto.ts";
import { migrate } from "./db/migrations.ts";
import { dbTenants } from "./db/tenants.ts";
import type { Database } from "./db/sql.ts";
import { databaseSuites } from "./testing/sql.ts";

const host = "page.example.com";
const origin = "https://" + host;
const rules = { port: 443, tailnet: null, hosted: { host } };
const options = { team: "WG", dist: "/unused/", watchMs: 0, readOnly: false };
const auth = { clientId: "client", clientSecret: "secret", secret: "test-session-secret-of-32-characters" };
const path = "/api/projects/project/claims";
const node = path + "/build";
const job = { job: "dispatch", lease_s: 30 };

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function fixture(db: Database) {
  await migrate(db);
  const tenants = dbTenants(db, credentialCrypto({ WG_DATA_KEY: Buffer.alloc(32).toString("base64") }), { linearAuth: auth });
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const { variables } = JSON.parse(String(init.body));
    return Response.json({ data: { project: variables.id === "project" ? { id: "project", name: "Example" } : null } });
  });
  const app = createApp(rules, { ...options, tenants, linearAuth: auth });
  async function account(name: string) {
    const email = name + "@example.com";
    const id = await tenants.accounts.signIn({ linearUserId: name, linearOrgId: "org", name, email }, {
      workspaceId: "work", linearOrgId: "org", name: "Work", team: "WG", teamLabels: false,
      credential: { kind: "oauth", key: name + "-access", refreshToken: "refresh", expiresAt: new Date(Date.now() + 3600_000) },
    });
    const { token } = await tenants.accounts.createToken(id, "Coordinator");
    const packed = Buffer.from(JSON.stringify({ accountId: id, id: randomUUID(), email, exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url");
    const cookie = (await serializeSigned("__Host-wg_session", packed, auth.secret, { secure: true, path: "/" })).split(";")[0];
    return {
      id, token, email,
      request(url: string, method = "GET", data?: object, workspace?: string, session = false) {
        const credentials: Record<string, string> = session ? { cookie, origin } : { authorization: "Bearer " + token };
        return app.request(url, {
          method, headers: { host, "content-type": "application/json", ...credentials, ...(workspace && { "x-workspace": workspace }) },
          body: data && JSON.stringify(data),
        });
      },
    };
  }
  const owner = await account("Ada");
  const collaborator = await account("Grace");
  const viewer = await account("Pat");
  const outsider = await account("Sam");
  const links = await (await owner.request("/api/projects/project/share", "POST", {}, undefined, true)).json();
  for (const [member, link] of [[collaborator, links.collab], [viewer, links.view]] as const) {
    const token = new URL(link.url).pathname.split("/").at(-1)!;
    expect((await member.request("/api/join", "POST", { token, confirm: true }, undefined, true)).status).toBe(200);
  }
  const [shared] = await tenants.accounts.shares.memberships(collaborator.id);
  const [view] = await tenants.accounts.shares.memberships(viewer.id);
  const members = (await (await owner.request("/api/projects/project/share", "GET", undefined, undefined, true)).json()).members;
  return { owner, collaborator, viewer, outsider, scope: "shared:" + shared.id, viewScope: "shared:" + view.id,
    memberPath: "/api/projects/project/members/" + members.find(({ name }: { name: string }) => name === "Grace").id };
}

databaseSuites((open) => {
  it("admits one account in a race and renews claims for that account", async () => {
    const db = await open();
    try {
      const { owner, collaborator, scope } = await fixture(db);
      const logs: string[] = [];
      for (const level of ["log", "warn", "error"] as const) {
        vi.spyOn(console, level).mockImplementation((...args) => logs.push(args.join(" ")));
      }
      const responses = await Promise.all(Array.from({ length: 50 }, (_, index) => index % 2
        ? collaborator.request(node, "POST", job, scope) : owner.request(node, "POST", job)));
      const bodies = await Promise.all(responses.map((response) => response.json()));
      const winner = responses[0].status === 200 ? "Ada" : "Grace";
      expect(responses.map(({ status }) => status)).toEqual(Array.from({ length: 50 }, (_, index) =>
        (index % 2 ? "Grace" : "Ada") === winner ? 200 : 409));
      expect(bodies.every(({ claim }) => claim.holder === winner && claim.job === "dispatch")).toBe(true);
      const list = await (await owner.request(path)).json();
      expect(list.claims).toEqual([expect.objectContaining({ node: "build", holder: winner, stale: false })]);
      expect(bodies.filter(({ action }) => action === "claimed")).toHaveLength(1);
      expect(bodies.filter(({ action }) => action === "renewed")).toHaveLength(24);
      for (const account of [owner, collaborator]) {
        for (const secret of [account.id, account.token, account.email]) {
          expect(JSON.stringify({ bodies, list, logs })).not.toContain(secret);
        }
      }
    } finally { await db.close(); }
  }, 30_000);

  it("enforces scope and access, and releases claims when membership changes", async () => {
    const db = await open();
    try {
      const { owner, collaborator, viewer, outsider, scope, viewScope, memberPath } = await fixture(db);
      expect((await viewer.request(node, "POST", job, viewScope)).status).toBe(403);
      expect((await owner.request(node, "POST", job, undefined, true)).status).toBe(403);
      expect((await outsider.request(path, "GET", undefined, scope)).status).toBe(404);
      expect((await collaborator.request(path.replace("/project/", "/other/"), "GET", undefined, scope)).status).toBe(404);
      expect((await collaborator.request(node, "POST", job, scope)).status).toBe(200);
      for (const [account, workspace] of [[owner, undefined], [viewer, viewScope]] as const) {
        const response = await account.request(path, "GET", undefined, workspace);
        expect(await response.json()).toMatchObject({ claims: [{ holder: "Grace", stale: false }] });
      }
      const viewerList = await viewer.request(path, "GET", undefined, viewScope, true);
      expect(await viewerList.json()).toMatchObject({ claims: [{ holder: "Grace" }] });
      expect((await owner.request(node, "DELETE", undefined, undefined, true)).status).toBe(204);
      expect((await owner.request(node, "POST", job)).status).toBe(200);
      expect((await collaborator.request(node, "DELETE", undefined, scope)).status).toBe(403);
      expect((await owner.request(node, "DELETE")).status).toBe(204);
      expect((await collaborator.request(node, "POST", job, scope)).status).toBe(200);
      expect((await owner.request(memberPath, "PATCH", { role: "viewer" }, undefined, true)).status).toBe(204);
      expect(await (await owner.request(path)).json()).toEqual({ claims: [] });
      expect((await owner.request(memberPath, "PATCH", { role: "collaborator" }, undefined, true)).status).toBe(204);
      expect((await collaborator.request(node, "POST", job, scope)).status).toBe(200);
      expect((await owner.request(memberPath, "DELETE", undefined, undefined, true)).status).toBe(204);
      expect(await (await owner.request(path)).json()).toEqual({ claims: [] });
    } finally { await db.close(); }
  }, 30_000);

  it("permits a takeover after expiry and refuses the old holder's renewal", async () => {
    const db = await open();
    try {
      const { owner, collaborator, scope } = await fixture(db);
      expect((await owner.request(node, "POST", job)).status).toBe(200);
      await db.query("UPDATE node_claims SET lease_until = now() - interval '1 second'");
      expect(await (await owner.request(path)).json()).toMatchObject({ claims: [{ holder: "Ada", stale: true }] });
      expect(await (await collaborator.request(node, "POST", job, scope)).json()).toMatchObject({ action: "taken_over", claim: { holder: "Grace" } });
      const conflict = await owner.request(node, "PUT", { lease_s: 600 });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ claim: { holder: "Grace" } });
      const renewed = await collaborator.request(node, "PUT", undefined, scope);
      expect(renewed.status).toBe(200);
      const { claim } = await renewed.json();
      expect(Date.parse(claim.leaseUntil) - Date.parse(claim.renewedAt)).toBe(600_000);
      expect((await collaborator.request(node, "DELETE", undefined, scope)).status).toBe(204);
    } finally { await db.close(); }
  }, 30_000);

  it("validates inputs and limits concurrent additions to 200 live claims", async () => {
    const db = await open();
    try {
      const { owner } = await fixture(db);
      for (const [key, input] of [["Bad_key", job], ["x".repeat(41), job], ["valid", { job: "other" }], ["valid", { ...job, lease_s: 29 }]] as const) {
        expect((await owner.request(path + "/" + key, "POST", input)).status).toBe(400);
      }
      // Seed live rows to leave two slots for concurrent requests.
      await db.query(`INSERT INTO node_claims (tenant_id, connection_id, project_id, node_key, holder_user_id, job, lease_until)
        SELECT t.id, c.id, 'project', 'node-' || n, t.owner_user_id, 'dispatch', now() + interval '10 minutes'
        FROM tenants t JOIN linear_connections c ON c.tenant_id = t.id
        CROSS JOIN generate_series(1, 198) AS n WHERE t.id = $1`, [owner.id]);
      const results = await Promise.all(["one", "two", "three"].map((key) => owner.request(path + "/" + key, "POST", { job: "ci" })));
      expect(results.map(({ status }) => status).sort()).toEqual([200, 200, 409]);
      expect((await (await owner.request(path)).json()).claims).toHaveLength(200);
    } finally { await db.close(); }
  }, 30_000);
});

it("returns 404 for every claim route outside service mode", async () => {
  const app = createApp(rules, options);
  for (const [url, method] of [[path, "GET"], [node, "POST"], [node, "PUT"], [node, "DELETE"]]) {
    expect((await app.request(url, { method, headers: { host } })).status).toBe(404);
  }
});
