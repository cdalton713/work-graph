import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as filePath, sep } from "node:path";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, expect, it, vi } from "vitest";
import { sharedRoutes } from "./access.ts";
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
    let time = Date.now();
    const tenants = dbTenants(db, credentialCrypto({ WG_DATA_KEY: Buffer.alloc(32).toString("base64") }), { linearAuth: auth, now: () => time });
    const dist = await mkdtemp(filePath(tmpdir(), "wg-join-"));
    await writeFile(filePath(dist, "index.html"), "<html>Example</html>");
    let rejectWrite: Response | undefined;
    let slow = false;
    const calls: { query: string; key: string | null }[] = [];
    const empty = { nodes: [], pageInfo: { hasNextPage: false } };
    const issue = {
      id: "inside", identifier: "WG-1", title: "An issue", url: "https://example.com/issue", description: null,
      priority: 0, updatedAt: "2026-01-01", team: { id: "team", key: "WG" },
      state: { id: "started", name: "In Progress", type: "started", color: "" },
      project: { id: "project" }, labels: empty, comments: { ...empty, nodes: [{
        id: "card", body: "**work-graph node card**\n\n```json\n{\"wg\":1,\"key\":\"node\",\"kind\":\"task\"}\n```",
      }] }, relations: empty, inverseRelations: empty, attachments: empty,
    };
    const app = createApp(rules, { ...options, dist: dist + sep, linearAuth: auth, tenants, now: () => time += slow ? 6_000 : 0 });
    const output: string[] = [];
    for (const level of ["log", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation((...args) => output.push(args.join(" ")));
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const { query, variables } = JSON.parse(String(init.body));
      calls.push({ query, key: new Headers(init.headers).get("authorization") });
      if (query.includes("commentCreate") && rejectWrite) {
        return rejectWrite;
      }
      if (query.includes("commentCreate")) return Response.json({ data: { commentCreate: { success: true,
        comment: { id: "new-comment", body: variables.i.body, createdAt: "2026-01-01", user: { name: "Grace" } } } } });
      if (query.includes("issueUpdate")) return Response.json({ data: { issueUpdate: { success: true, issue } } });
      if (query.includes("issueLabels")) return Response.json({ data: { issueLabels: empty } });
      if (query.includes("issue(id:")) return Response.json({ data: { issue: {
        ...issue, project: { id: variables.id === "inside" ? "project" : "private" }, comments: empty,
      } } });
      if (query.includes("viewer{id}")) return Response.json({ data: { viewer: { id: "ada" },
        project: { id: "project", name: "Example", projectMilestones: { nodes: [] } } } });
      if (query.includes("issues(first:25")) return Response.json({ data: { project: { issues: { ...empty, nodes: [issue] } } } });
      if (query.includes("issues(first:")) return Response.json({ data: { issues: empty, comments: empty, project: { documents: empty } } });
      if (query.includes("teams(first:10")) return Response.json({ data: { teams: empty } });
      if (query.includes("teams(first:")) return Response.json({ data: { teams: { nodes: [{ projects: { nodes: [
        { id: "private", name: "Private" },
      ], pageInfo: { hasNextPage: false } } }] } } });
      return Response.json({ data: { project: variables.id === "project" && new Headers(init.headers).get("authorization") !== "Bearer Pat-access" ? { id: "project", name: "Example" } : null } });
    });
    async function account(user: string, org = "org") {
      const accountId = await tenants.accounts.signIn({
        linearUserId: user, linearOrgId: org, name: user, email: user + "@example.com",
      }, {
        workspaceId: "work", linearOrgId: org, name: "Work", team: "WG", teamLabels: false,
        credential: { kind: "oauth", key: user + "-access", refreshToken: "refresh", expiresAt: new Date(Date.now() + 3600_000) },
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
      const classified = app.routes.filter(({ method, path }) => method !== "ALL" && path.startsWith("/api/"))
        .map(({ method, path }) => `${method} ${path}`);
      expect([...new Set(classified)].sort()).toEqual(Object.keys(sharedRoutes).sort());
      const owner = await account("Ada");
      const member = await account("Grace");
      const other = await account("Pat", "other-org");
      const memberRoute = "/api/projects/project/members/" + randomUUID();
      const minted = await tenants.accounts.createToken(owner.accountId, "Coordinator");
      const ownerWrites = [[share, "POST"], [share + "/view", "POST"], [share + "/view/rotate", "POST"], [share + "/view", "DELETE"],
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
      expect(await personal.text()).toContain("attached workspace");
      expect((await owner.request(share + "/edit", "POST")).status).toBe(404);
      const kindPath = (kind: string) => share + "/" + kind;
      expect((await other.request(kindPath("view"), "POST")).status).toBe(404);
      const concurrent = await Promise.all([
        owner.request(kindPath("view"), "POST"), owner.request(kindPath("view"), "POST"),
      ]);
      expect(concurrent.map(({ status }) => status)).toEqual([200, 200]);
      const issued = await Promise.all(concurrent.map((response) => response.json()));
      expect(issued.find(({ exists }) => exists)).toEqual({ exists: true });
      expect(await (await owner.request(share)).json()).toMatchObject({
        view: { exists: true }, collab: { exists: false },
      });
      expect((await owner.request(kindPath("view"), "DELETE")).status).toBe(204);
      const collabLink = await (await owner.request(kindPath("collab"), "POST")).json();
      expect(await (await owner.request(share)).json()).toMatchObject({
        view: { exists: false }, collab: { exists: true },
      });
      expect(await (await owner.request(kindPath("collab"), "POST")).json()).toEqual({ exists: true });
      const viewLink = await (await owner.request(kindPath("view"), "POST")).json();
      const token = (url: string) => {
        expect(url).toMatch(/^https:\/\/page\.example\.com\/join\/[A-Za-z0-9_-]{43}$/);
        return url.split("/").at(-1)!;
      };
      const view = token(viewLink.url);
      const collab = token(collabLink.url);
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
      const memberStatus = await (await member.request("/api/status")).json();
      const shared = memberStatus.workspaces.find(({ id }: { id: string }) => id.startsWith("shared:"));
      expect(shared).toMatchObject({ name: "Example", owner: "Ada", role: "viewer", projectId: "project" });
      const headers = { "x-workspace": shared.id };
      const summary = { id: shared.id, name: "Example", owner: "Ada", role: "viewer", projectId: "project" };
      const status = await (await member.request("/api/status", "GET", undefined, headers)).json();
      expect(status.workspaces).toEqual([summary]);
      expect(status).not.toHaveProperty("cache");
      expect((await member.request("/api/config", "GET", undefined, headers)).status).toBe(404);
      expect((await member.request("/api/link?workspace=personal", "GET", undefined, headers)).status).toBe(404);
      expect((await member.request("/api/projects/project/graph", "GET", undefined, { ...headers, "x-project": "private" })).status).toBe(404);
      expect((await member.request("/api/issues/inside/comments", "POST", { body: "Read only" }, headers)).status).toBe(405);
      expect((await member.request("/api/issues/inside", "PATCH", { stateId: "started" }, headers)).status).toBe(405);
      expect((await member.request("/api/projects/project/asks/ask1/reply", "POST", { body: "Read only" }, headers)).status).toBe(405);
      for (const path of ["/api/projects", "/api/overview", "/api/overview?view=waiting"]) {
        calls.length = 0;
        const projected = await (await member.request(path, "GET", undefined, {
          ...headers, "x-omit-workspaces": encodeURIComponent(shared.id),
        })).json();
        expect(projected.workspaces).toEqual([{ ...summary, error: "Example is temporarily unavailable." }]);
        expect(projected.projects).toEqual([]);
        expect(calls).toHaveLength(0);
        const list = await (await member.request(path, "GET", undefined, headers)).json();
        expect(list.workspaces).toEqual([summary]);
        expect(list.projects.map(({ id }: { id: string }) => id)).toEqual(["project"]);
      }
      const graph = await member.request("/api/projects/project/graph", "GET", undefined, headers);
      expect(graph.status).toBe(200);
      expect(await graph.json()).toMatchObject({ workspace: shared.id, project: { id: "project" } });
      expect((await member.request("/api/projects/project/commands", "POST", { name: "next" }, headers)).status).toBe(405);
      expect((await member.request("/api/projects/private/graph", "GET", undefined, headers)).status).toBe(404);
      expect((await other.request("/api/projects/project/graph", "GET", undefined, headers)).status).toBe(400);
      const tokenStatus = await app.request("/api/status", { headers: { host, ...headers, authorization: "Bearer " + minted.token } });
      expect(tokenStatus.status).toBe(400);

      expect((await member.request(share)).status).toBe(404);
      expect((await member.request(share + "/view/rotate", "POST")).status).toBe(404);
      expect((await member.request(share + "/collab", "DELETE")).status).toBe(404);
      expect(await (await join(collab)).json()).toMatchObject({ role: "collaborator" });
      const comments = "/api/issues/inside/comments";
      calls.length = 0;
      expect((await member.request(comments, "GET", undefined, headers)).status).toBe(200);
      expect((await member.request(comments, "POST", { body: "A comment" }, headers)).status).toBe(200);
      expect(calls.filter(({ query }) => query.startsWith("mutation")).map(({ key }) => key)).toEqual(["Bearer Grace-access"]);
      expect(calls.filter(({ query }) => query.startsWith("query")).every(({ key }) => key === "Bearer Ada-access")).toBe(true);
      for (const message of ["Forbidden", "Entity not found"]) {
        rejectWrite = Response.json({ errors: [{ message }] });
        const refused = await member.request(comments, "POST", { body: "Refused" }, headers);
        expect(refused.status).toBe(403);
        expect(await refused.json()).toMatchObject({ code: "needs_linear_access" });
      }
      rejectWrite = Response.json({ errors: [{ message: "Entity not found" }] }, { status: 503 });
      expect((await member.request(comments, "POST", { body: "Outage" }, headers)).status).toBe(502);
      rejectWrite = undefined;
      expect((await member.request("/api/issues/outside", "PATCH", { stateId: "started" }, headers)).status).toBe(404);
      expect((await member.request("/api/issues/outside/comments", "GET", undefined, headers)).status).toBe(404);
      expect((await member.request("/api/issues/outside/comments", "POST", { body: "Outside" }, headers)).status).toBe(404);
      expect((await member.request("/api/account", "GET", undefined, headers)).status).toBe(404);
      for (const path of ["close", "autonomy", "review-effort", "share", "share/view"]) {
        expect((await member.request("/api/projects/project/" + path, "POST", {}, headers)).status).toBe(403);
      }
      expect((await member.request("/api/projects/project/commands", "POST", { name: "pause" }, headers)).status).toBe(403);
      expect((await member.request("/api/projects/project/commands", "POST", { name: "next" }, headers)).status).toBe(200);
      for (const patch of [{ stateId: "started" }, { labelIds: ["label"] }]) {
        expect((await member.request("/api/issues/inside", "PATCH", patch, headers)).status).toBe(200);
        expect(calls.findLast(({ query }) => query.startsWith("mutation"))?.key).toBe("Bearer Grace-access");
      }
      expect((await member.request("/api/issues/inside", "PATCH", { title: "Changed" }, headers)).status).toBe(403);
      expect((await member.request("/api/projects/project/commands", "POST", { name: "dispatch", key: "other", issue: "WG-1" }, headers)).status).toBe(404);
      expect((await member.request("/api/projects/project/commands", "POST", { name: "dispatch", key: "node", issue: "WG-1" }, headers)).status).toBe(200);
      const ref = { tenant: owner.accountId, workspace: "work", id: "project" };
      const coordinator = await app.link.hub.joinCoordinator({ send: () => {}, close: () => {} }, ref);
      await coordinator.receive(JSON.stringify({ v: 1, type: "hello", payload: { session: "test", plan: "example" } }));
      await coordinator.receive(JSON.stringify({ v: 1, type: "asks", payload: { asks: [
        { id: "ask1", key: "node", issue: "WG-1", from: "worker", body: "Which page?" },
      ] } }));
      await app.link.hub.joinCoordinator({ send: () => {}, close: () => {} }, { ...ref, id: "private" });
      const scopedStatus = await (await member.request("/api/status", "GET", undefined, headers)).json();
      expect(scopedStatus.rooms).toMatchObject([{ workspace: shared.id, project: "project", asks: 0 }]);
      const memberCoordinator = await app.link.hub.joinCoordinator({ send: () => {}, close: () => {} }, ref, {
        account: member.accountId, name: "Grace", workspace: shared.id, ownerName: "Ada",
      });
      await memberCoordinator.receive(JSON.stringify({ v: 1, type: "hello", payload: { session: "member" } }));
      await memberCoordinator.receive(JSON.stringify({ v: 1, type: "asks", payload: { asks: [{ id: "ask1", issue: "WG-1", body: "Member question" }] } }));
      await app.link.hub.publish(ref, "command", { name: "next", key: null, issue: null });
      const after = await (await member.request("/api/status", "GET", undefined, headers)).json();
      expect(after.rooms).toMatchObject([{
        workspace: shared.id, project: "project", coordinators: 2, asks: 1, queued: scopedStatus.rooms[0].queued,
      }]);
      const presence = await (await member.request("/api/projects/project/presence", "GET", undefined, headers)).json();
      expect(presence.asks).toMatchObject([{ id: "ask1", issue: "WG-1" }, { accountName: "Grace" }]);
      const memberAskId = presence.asks[1].id;
      expect(memberAskId).not.toBe("ask1");
      expect((await member.request("/api/projects/project/asks/ask1/reply", "POST", { body: "The project page." }, headers)).status).toBe(200);
      expect(calls.findLast(({ query }) => query.startsWith("mutation"))?.key).toBe("Bearer Grace-access");
      expect((await member.request("/api/projects/project/asks/" + memberAskId + "/reply", "POST", { body: "The member page." }, headers)).status).toBe(200);
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
      expect((await joinAs(other, collab, true)).ok).toBe(true);
      const otherList = await (await other.request("/api/status")).json();
      const otherShared = otherList.workspaces.find(({ id }: { id: string }) => id.startsWith("shared:"));
      const before = calls.length;
      const denied = await other.request(comments, "POST", { body: "Missing access" }, { "x-workspace": otherShared.id });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: "needs_linear_access" });
      expect(calls.slice(before).some(({ query }) => query.startsWith("mutation"))).toBe(false);
      await tenants.accounts.addConnection(other.accountId, {
        workspaceId: "attached", linearOrgId: "org", name: "Attached", team: "WG", teamLabels: false,
        credential: { kind: "api_key", key: "other-api-key" },
      });
      rejectWrite = Response.json({ errors: [{ message: "Unauthorized" }] }, { status: 401 });
      const invalidKey = await other.request(comments, "POST", { body: "Refused key" }, { "x-workspace": otherShared.id });
      expect(invalidKey.status).toBe(403);
      expect(await invalidKey.json()).toMatchObject({ code: "needs_linear_access" });
      rejectWrite = undefined;

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
      for (const value of [view, collab, fresh, token(issued.find(({ url }) => url).url)]) {
        const hash = createHash("sha256").update(value).digest("hex");
        expect(await db.query("SELECT 1 FROM shares WHERE token_hash = $1", [hash])).toHaveLength(1);
        for (const secret of [value, hash]) {
          expect(text).not.toContain(secret);
          expect(output.join("\n")).not.toContain(secret);
        }
      }
      const { members } = JSON.parse(text);
      const grace = members.find(({ name }: { name: string }) => name === "Grace");
      expect(grace).toMatchObject({ email: "Grace@example.com", role: "collaborator" });
      const memberPath = "/api/projects/project/members/" + grace.id;
      expect((await member.request(memberPath, "DELETE")).status).toBe(404);
      expect((await other.request(memberPath, "DELETE")).status).toBe(404);
      expect((await member.request(memberPath, "DELETE", undefined, headers)).status).toBe(403);
      const silent = { "x-workspace": otherShared.id };
      expect((await other.request("/api/status", "GET", undefined, silent)).status).toBe(200);
      await db.query("DELETE FROM project_members WHERE id = $1", [otherShared.id.slice("shared:".length)]);
      time += 9_999;
      expect((await other.request("/api/status", "GET", undefined, silent)).status).toBe(200);
      time++;
      expect((await other.request("/api/status", "GET", undefined, silent)).status).toBe(400);
      expect((await owner.request(memberPath, "PATCH", { role: "viewer" })).status).toBe(204);
      expect((await (await owner.request(share)).json()).members[0].role).toBe("viewer");
      expect((await member.request(comments, "POST", { body: "Role changed" }, headers)).status).toBe(405);
      expect((await owner.request(memberPath, "DELETE")).status).toBe(204);
      expect((await member.request("/api/projects", "GET", undefined, headers)).status).toBe(400);
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
      const otherProject = "second";
      const ownerConnection = (await tenants.accounts.readTenant(owner.accountId))!.connections[0].id;
      const scope: [string, string, string] = [owner.accountId, ownerConnection, otherProject];
      const newLinks = await tenants.accounts.shares.make(scope, "Second");
      expect((await joinAs(other, newLinks!.created.view!, true)).status).toBe(200);
      const secondList = await (await other.request("/api/status")).json();
      const second = secondList.workspaces.find(({ projectId }: { projectId: string }) => projectId === otherProject);
      await tenants.accounts.deleteAccount(owner.accountId);
      expect((await other.request("/api/status", "GET", undefined, { "x-workspace": second.id })).status).toBe(400);
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
