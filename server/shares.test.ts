import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as filePath, sep } from "node:path";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "./app.ts";
import { credentialCrypto } from "./db/crypto.ts";
import { migrate } from "./db/migrations.ts";
import { dbTenants } from "./db/tenants.ts";
import { databaseSuites } from "./testing/sql.ts";

const host = "page.example.com";
const origin = "https://" + host;
const rules = { port: 443, tailnet: null, hosted: { host } };
const options = { team: "WG", dist: "/unused/", watchMs: 0, readOnly: false };
const auth = { clientId: "client", clientSecret: "secret", secret: "test-session-secret-of-32-characters" };
const share = "/api/projects/project/share";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

databaseSuites((open) => {
  it("issues links once, scopes owner actions, and preserves membership on revocation", async () => {
    const db = await open();
    await migrate(db);
    const tenants = dbTenants(db, credentialCrypto({ WG_DATA_KEY: Buffer.alloc(32).toString("base64") }), { linearAuth: auth });
    const dist = await mkdtemp(filePath(tmpdir(), "wg-join-"));
    await writeFile(filePath(dist, "index.html"), "<html>Example</html>");
    let time = Date.now();
    let slow = false;
    const app = createApp(rules, { ...options, dist: dist + sep, linearAuth: auth, tenants, now: () => time += slow ? 6_000 : 0 });
    const output: string[] = [];
    for (const level of ["log", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation((...args) => output.push(args.join(" ")));
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const { variables } = JSON.parse(String(init.body));
      return Response.json({ data: { project: variables.id === "project" ? { id: "project", name: "Example" } : null } });
    });
    async function account(user: string) {
      const accountId = await tenants.accounts.signIn({
        linearUserId: user, linearOrgId: "org", name: user, email: user + "@example.com",
      }, {
        workspaceId: "work", linearOrgId: "org", name: "Work", team: "WG", teamLabels: false,
        credential: { kind: "oauth", key: "access", refreshToken: "refresh", expiresAt: new Date(Date.now() + 3600_000) },
      });
      const packed = Buffer.from(JSON.stringify({
        accountId, id: randomUUID(), email: user + "@example.com", exp: Math.floor(Date.now() / 1000) + 600,
      })).toString("base64url");
      const cookie = (await serializeSigned("__Host-wg_session", packed, auth.secret, { secure: true, path: "/" })).split(";")[0];
      return { accountId, request: (path: string, method = "GET", data?: object, headers?: Record<string, string>) => app.request(path, {
        method, headers: { host, origin, cookie, "content-type": "application/json", ...headers },
        body: data && JSON.stringify(data),
      }) };
    }
    try {
      const owner = await account("Ada");
      const member = await account("Sam");
      const other = await account("Pat");
      const memberRoute = "/api/projects/project/members/" + randomUUID();
      const minted = await tenants.accounts.createToken(owner.accountId, "Coordinator");
      const ownerWrites = [[share, "POST"], [share + "/view/rotate", "POST"], [share + "/view", "DELETE"],
        [memberRoute, "PATCH"], [memberRoute, "DELETE"]];
      for (const [path, method] of ownerWrites) {
        expect((await owner.request(path, method, { role: "viewer" }, { origin: "https://other.example.com" })).status).toBe(403);
      }
      for (const [path, method] of [[share, "GET"], ...ownerWrites]) {
        const response = await app.request(path, { method, headers: {
          host, origin, "content-type": "application/json", authorization: "Bearer " + minted.token,
        } });
        expect(response.status).toBe(401);
      }
      await tenants.accounts.addConnection(owner.accountId, {
        workspaceId: "personal", linearOrgId: "personal", name: "Personal", team: "WG", teamLabels: false,
        credential: { kind: "api_key", key: "personal-key" },
      });
      const personal = await owner.request(share, "POST", undefined, { "x-workspace": "personal" });
      expect(personal.status).toBe(400);
      expect(await personal.text()).toContain("API key workspace");
      const concurrent = await Promise.all([owner.request(share, "POST"), owner.request(share, "POST")]);
      expect(concurrent.map(({ status }) => status)).toEqual([200, 200]);
      const issued = await Promise.all(concurrent.map((response) => response.json()));
      const links = issued.find(({ view }) => view.url);
      expect(issued.find(({ view }) => view.exists)).toEqual({ view: { exists: true }, collab: { exists: true } });
      const token = (url: string) => {
        expect(url).toMatch(/^https:\/\/page\.example\.com\/join\/[A-Za-z0-9_-]{43}$/);
        return url.split("/").at(-1)!;
      };
      const view = token(links.view.url);
      const collab = token(links.collab.url);
      slow = true;
      const page = await app.request("/join/" + view, { headers: { host } });
      slow = false;
      expect(page.status).toBe(200);
      expect(page.headers.get("referrer-policy")).toBe("no-referrer");
      expect(page.headers.get("cache-control")).toBe("no-store");
      expect(await page.text()).toBe("<html>Example</html>");
      expect(output.join("\n")).toContain("/join/[link]");
      expect(await (await owner.request(share, "POST")).json()).toEqual({ view: { exists: true }, collab: { exists: true } });
      expect((await other.request(share)).status).toBe(404);
      expect((await other.request(share + "/view/rotate", "POST")).status).toBe(404);
      expect((await other.request(share + "/collab", "DELETE")).status).toBe(404);
      expect((await owner.request("/api/projects/missing/share", "POST")).status).toBe(404);
      const joinAs = (person: typeof member, token: string, confirm?: boolean, headers?: Record<string, string>) =>
        person.request("/api/join", "POST", { token, confirm }, headers);
      const join = (value: string) => joinAs(member, value, true);
      for (const confirm of [undefined, true]) {
        expect((await joinAs(member, view, confirm, { origin: "https://other.example.com" })).status).toBe(403);
      }
      expect(await (await joinAs(member, view)).json()).toEqual({ project: "Example", owner: "Ada", role: "viewer" });
      expect((await (await owner.request(share)).json()).members).toEqual([]);
      expect(await (await join(view)).json()).toMatchObject({ project: "Example", role: "viewer" });
      expect((await member.request(share)).status).toBe(404);
      expect((await member.request(share + "/view/rotate", "POST")).status).toBe(404);
      expect((await member.request(share + "/collab", "DELETE")).status).toBe(404);
      const memberShare = await member.request(share, "POST");
      expect(memberShare.status).toBe(200);
      const memberLink = token((await memberShare.json()).view.url);
      expect((await joinAs(other, memberLink, true)).status).toBe(200);
      expect((await (await member.request(share)).json()).members).toHaveLength(1);
      const connection = (await tenants.accounts.readTenant(member.accountId))!.connections[0];
      await tenants.accounts.removeConnection(member.accountId, connection.id);
      expect((await joinAs(other, memberLink)).status).toBe(404);
      expect(await db.query("SELECT id FROM shares WHERE connection_id = $1", [connection.id])).toEqual([]);
      expect(await db.query("SELECT user_id FROM project_members WHERE connection_id = $1", [connection.id])).toEqual([]);
      expect(await (await join(collab)).json()).toMatchObject({ role: "collaborator" });
      expect(await (await join(view)).json()).toMatchObject({ role: "collaborator" });
      expect((await joinAs(owner, view, true)).ok).toBe(true);
      const rotated = await owner.request(share + "/view/rotate", "POST");
      expect(rotated.ok).toBe(true);
      const fresh = token((await rotated.json()).url);
      expect(fresh).not.toBe(view);
      expect((await owner.request(share + "/collab", "DELETE")).status).toBe(204);
      const invalid = await join("bad");
      expect(invalid.status).toBe(404);
      const message = await invalid.text();
      for (const value of [view, collab, "A".repeat(43)]) {
        const response = await join(value);
        expect(response.status).toBe(404);
        expect(await response.text()).toBe(message);
      }
      const list = await owner.request(share);
      const text = await list.text();
      for (const value of [view, collab, fresh]) {
        const hash = createHash("sha256").update(value).digest("hex");
        expect(await db.query("SELECT 1 FROM shares WHERE token_hash = $1", [hash])).toHaveLength(1);
        for (const secret of [value, hash]) {
          expect(text).not.toContain(secret);
          expect(output.join("\n")).not.toContain(secret);
        }
      }
      const { members } = JSON.parse(text);
      expect(members).toMatchObject([{ name: "Sam", email: "Sam@example.com", role: "collaborator" }]);
      const memberPath = "/api/projects/project/members/" + members[0].id;
      expect((await member.request(memberPath, "DELETE")).status).toBe(404);
      expect((await other.request(memberPath, "DELETE")).status).toBe(404);
      expect((await owner.request(memberPath, "PATCH", { role: "viewer" })).status).toBe(204);
      expect((await (await owner.request(share)).json()).members[0].role).toBe("viewer");
      expect((await owner.request(memberPath, "DELETE")).status).toBe(204);
      for (let i = 0; i < 2; i++) expect((await join(fresh)).ok).toBe(true);
      expect((await join(fresh)).status).toBe(429);
      const changes: string[] = [];
      const stop = tenants.onChange((tenant) => changes.push(tenant));
      await tenants.accounts.deleteAccount(member.accountId);
      stop();
      expect(changes).toContain(owner.accountId);
      expect((await (await owner.request(share)).json()).members).toEqual([]);
      const fill = await db.query(`INSERT INTO users (id, linear_user_id, linear_org_id, email, name)
        SELECT gen_random_uuid(), n::text, 'org', n::text || '@example.com', n::text FROM generate_series(1, 50) n RETURNING id`);
      await db.query(`INSERT INTO project_members (tenant_id, connection_id, project_id, user_id, role, share_id)
        SELECT s.tenant_id, s.connection_id, s.project_id, u.id, 'viewer', s.id FROM shares s
        CROSS JOIN users u WHERE s.token_hash = $1 AND u.id = ANY($2::uuid[])`,
      [createHash("sha256").update(fresh).digest("hex"), fill.map(({ id }) => id)]);
      expect((await joinAs(other, fresh, true)).status).toBe(409);
      expect((await (await owner.request(share)).json()).members).toHaveLength(50);
      await tenants.accounts.deleteAccount(owner.accountId);
      expect(await db.query("SELECT id FROM shares")).toEqual([]);
      expect(await db.query("SELECT user_id FROM project_members")).toEqual([]);
    } finally {
      app.link.stop();
      tenants.close();
      await db.close();
      await rm(dist, { recursive: true });
    }
  });
});
