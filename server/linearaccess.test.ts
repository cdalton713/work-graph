import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "./app.ts";
import { databaseSuites } from "./testing/sql.ts";
import { host, options, projectFixture, rules } from "./testing/projects.ts";

const access = "/api/projects/project/access";
const share = "/api/projects/project/share";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

databaseSuites((open) => {
  it("checks shared access using the collaborator's own Linear connection", async () => {
    const { collaborator, scope } = await projectFixture(await open());
    let visible = true;
    const calls: (string | null)[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const credential = new Headers(init.headers).get("authorization");
      calls.push(credential);
      if (credential === "Bearer Ada-access") {
        return Response.json({ data: { organization: { id: "org", name: "Work", urlKey: "work" },
          project: { id: "project", teams: { nodes: [{ id: "team", key: "WG" }] } } } });
      }
      return Response.json({ data: { organization: { id: "org" },
        teams: { nodes: visible ? [{ id: "team" }] : [] },
        projects: { nodes: visible ? [{ id: "project" }] : [] } } });
    });
    const check = () => collaborator.request(access, "GET", undefined, scope, true);
    expect(await (await check()).json()).toEqual({ status: "ok", workspace: "Work", team: "WG" });
    expect(calls).toContain("Bearer Grace-access");
    visible = false;
    expect(await (await check()).json()).toEqual({ status: "no_team", workspace: "Work", team: "WG" });
  });

  it("distinguishes a missing connection from a missing workspace membership", async () => {
    let now = Date.now();
    const { collaborator, scope } = await projectFixture(await open(), "other-org", { now: () => now });
    let ownerReads = 0;
    let member = true;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      ownerReads++;
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer Ada-access");
      return Response.json({ data: {
        organization: { id: "org", name: "Work", urlKey: "work" },
        project: { id: "project", teams: { nodes: [{ id: "team", key: "WG" }] } },
        users: { nodes: member ? [{ id: "member-in-org", active: true }] : [] },
      } });
    });
    const check = () => collaborator.request(access, "GET", undefined, scope, true);
    expect(await (await check()).json()).toEqual({ status: "no_connection", workspace: "Work", team: "WG" });
    member = false;
    expect((await (await check()).json()).status).toBe("no_connection");
    expect(ownerReads).toBe(2);
    now += 60_001;
    expect(await (await check()).json()).toEqual({ status: "not_member", workspace: "Work", team: "WG" });
  });

  it("stores one request, reports it to the owner, and clears it after a successful check", async () => {
    const { owner, collaborator, scope } = await projectFixture(await open());
    vi.stubGlobal("fetch", async () => Response.json({ data: {
      organization: { id: "org", name: "Work", urlKey: "work" },
      project: { id: "project", teams: { nodes: [{ id: "team", key: "WG" }] } },
      teams: { nodes: [{ id: "team" }] }, projects: { nodes: [{ id: "project" }] },
    } }));
    const request = () => collaborator.request(access + "/request", "POST", {}, scope, true);
    const list = async () => (await (await owner.request(share, "GET", undefined, undefined, true)).json()).members;
    expect((await request()).status).toBe(204);
    expect((await list()).find(({ email }: { email: string }) => email === collaborator.email).accessRequestedAt).toEqual(expect.any(String));
    expect((await request()).status).toBe(429);
    expect((await collaborator.request(access, "GET", undefined, scope, true)).status).toBe(200);
    expect((await list()).find(({ email }: { email: string }) => email === collaborator.email).accessRequestedAt).toBeNull();
    expect((await request()).status).toBe(429);
  });

  it("adds workspace members or sends a confirmed invite, and reports Linear refusals", async () => {
    const jobs: Promise<void>[] = [];
    const events: { message: string; method?: string }[] = [];
    const { owner, collaborator, viewer, outsider, scope, memberPath } = await projectFixture(await open(), "other-org", {
      telemetryEnv: { DD_API_KEY: "test-key", WG_SESSION_SECRET: "test-session-secret-of-32-characters", WG_TELEMETRY_WORKSPACES: "org" },
      waitUntil: (job) => jobs.push(job),
    });
    await Promise.all(jobs);
    let member = true;
    let refused = false;
    let onTeam = false;
    let failure: Response | undefined;

    const output: string[] = [];
    for (const level of ["log", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args) => { output.push(args.join(" ")); });
    }
    const writes: unknown[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (url.includes("datadoghq.com")) {
        if (url.endsWith("/logs")) events.push(...JSON.parse(String(init.body)));
        return new Response(null, { status: 202 });
      }
      const { query, variables } = JSON.parse(String(init.body));
      const credential = new Headers(init.headers).get("authorization");
      if (query.includes("mutation")) {
        writes.push([credential, variables.input]);
        if (failure) return failure.clone();
        if (refused) return Response.json({ errors: [{ message: "Your plan does not permit this (Ada-access)" }] });
        return Response.json({ data: { teamMembershipCreate: { success: true }, organizationInviteCreate: { success: true } } });
      }
      return Response.json({ data: {
        organization: { id: "org", name: "Work", urlKey: "work" },
        project: { id: "project", teams: { nodes: [{ id: "team", key: "WG" }] } },
        users: { nodes: member ? [{ id: "member-in-org", active: true }] : [] },
        team: { members: { nodes: onTeam ? [{ id: "member-in-org" }] : [] } },
        organizationInvites: { nodes: [], pageInfo: { hasNextPage: false } },
      } });
    });
    const add = memberPath + "/access";
    const input = { email: "other@example.com", team: "other" };
    for (const account of [collaborator, viewer, outsider]) {
      expect((await account.request(add, "POST", input, undefined, true)).status).toBe(404);
    }
    expect((await owner.request(add, "POST", input)).status).toBe(403);
    expect((await owner.request(add, "POST", input, undefined, true, { origin: "https://other.example.com" })).status).toBe(403);
    const members = (await (await owner.request(share, "GET", undefined, undefined, true)).json()).members;
    const viewerId = members.find(({ email }: { email: string }) => email === viewer.email).id;
    expect((await owner.request(share.replace("/share", "/members/" + viewerId + "/access"), "POST", input, undefined, true)).status).toBe(403);
    expect((await owner.request(add.replace("/project/", "/other/"), "POST", input, undefined, true)).status).toBe(404);
    expect(writes).toEqual([]);
    expect(await (await owner.request(add, "POST", input, undefined, true)).json()).toEqual({ status: "added", team: "WG" });
    expect(writes).toEqual([["Bearer Ada-access", { userId: "member-in-org", teamId: "team" }]]);
    onTeam = true;
    expect(await (await owner.request(add, "POST", input, undefined, true)).json()).toEqual({ status: "already_member", team: "WG" });
    expect(writes).toHaveLength(1);
    member = false;
    expect((await owner.request(add, "POST", input, undefined, true)).status).toBe(409);
    expect(writes).toHaveLength(1);
    member = true;
    onTeam = false;
    expect((await collaborator.request(access + "/request", "POST", {}, scope, true)).status).toBe(204);
    for (const [status, code] of [[200, "INTERNAL_SERVER_ERROR"], [400, "GRAPHQL_VALIDATION_FAILED"], [503, "INTERNAL_SERVER_ERROR"]] as const) {
      failure = Response.json({ errors: [{ message: "Sensitive upstream detail", extensions: { code } }] }, { status });
      const result = await owner.request(add, "POST", {}, undefined, true);
      expect(result.status).toBe(502);
      expect(await result.json()).toEqual({ error: "Linear request failed" });
    }
    failure = undefined;
    await Promise.all(jobs);
    expect(events.filter(({ message }) => message === "access_refused")).toHaveLength(0);
    refused = true;
    const result = await owner.request(add, "POST", { invite: true }, undefined, true);
    expect(result.status).toBe(403);
    expect(await result.json()).toEqual({ error: "Your plan does not permit this ([redacted])", team: "WG",
      settingsUrl: "https://linear.app/work/settings/teams/WG/members" });
    expect((await (await owner.request(share, "GET", undefined, undefined, true)).json()).members
      .find(({ email }: { email: string }) => email === collaborator.email).accessRequestedAt).toEqual(expect.any(String));
    expect(output.join("\n")).not.toContain("Ada-access");
    await Promise.all(jobs);
    expect(events.filter(({ message }) => message.startsWith("access_")).map(({ message, method }) => [message, method]))
      .toEqual([["access_added", "added"], ["access_requested", undefined], ["access_refused", undefined]]);
    expect(JSON.stringify(events)).not.toContain(collaborator.email);
    expect((await owner.request(memberPath, "DELETE", undefined, undefined, true)).status).toBe(204);
    expect((await (await owner.request(share, "GET", undefined, undefined, true)).json()).members
      .some(({ email }: { email: string }) => email === collaborator.email)).toBe(false);
  });
  it("reports pending invites and serializes concurrent confirmed invites", async () => {
    const { owner, collaborator, memberPath } = await projectFixture(await open(), "other-org");
    const createdAt = new Date().toISOString();
    let pending = true;
    let calls = 0;
    let invites = 0;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      calls++;
      const { query, variables } = JSON.parse(String(init.body));
      if (query.includes("organizationInviteCreate")) {
        invites++;
        expect(variables.input).toEqual({ email: collaborator.email, teamIds: ["team"], role: "user" });
        return Response.json({ data: { organizationInviteCreate: { success: true } } });
      }
      return Response.json({ data: {
        organization: { id: "org", name: "Work", urlKey: "work" },
        project: { id: "project", teams: { nodes: [{ id: "team", key: "WG" }] } },
        users: { nodes: [] },
        organizationInvites: pending && !variables.after ? {
          nodes: [{ email: collaborator.email, createdAt, expiresAt: "2000-01-01", acceptedAt: null }],
          pageInfo: { hasNextPage: true, endCursor: "next" },
        } : {
          nodes: pending ? [{ email: collaborator.email.toUpperCase(), createdAt, expiresAt: null, acceptedAt: null }] : [],
          pageInfo: { hasNextPage: false },
        },
      } });
    });
    const invite = () => owner.request(memberPath + "/access", "POST", { invite: true }, undefined, true);
    expect(await (await invite()).json()).toEqual({ status: "invite_pending", team: "WG", invitedAt: createdAt });
    expect(invites).toBe(0);
    pending = false;
    const responses = await Promise.all([invite(), invite()]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 429]);
    expect(await responses.find((response) => response.ok)!.json()).toEqual({ status: "invited", team: "WG" });
    expect(invites).toBe(1);
    const before = calls;
    expect((await invite()).status).toBe(429);
    expect(calls).toBe(before);
  });

  it("uses the stored Linear user ID for a same-organization member", async () => {
    const { owner, memberPath } = await projectFixture(await open());
    const ids: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const { query, variables } = JSON.parse(String(init.body));
      if (query.includes("teamMembershipCreate")) ids.push(variables.input.userId);
      return Response.json({ data: {
        organization: { id: "org", name: "Work", urlKey: "work" },
        project: { id: "project", teams: { nodes: [{ id: "team", key: "WG" }] } },
        users: { nodes: [{ id: variables.id ?? "different-user-with-old-email", active: true }] },
        team: { members: { nodes: [] } },
        teamMembershipCreate: { success: true },
      } });
    });
    expect((await owner.request(memberPath + "/access", "POST", {}, undefined, true)).status).toBe(200);
    expect(ids).toEqual(["Grace"]);
  });
});

it("returns 404 for access routes outside service mode", async () => {
  const app = createApp(rules, options);
  for (const [path, method] of [[access, "GET"], [access + "/request", "POST"], ["/api/projects/project/members/member/access", "POST"]]) {
    expect((await app.request(path, { method, headers: { host } })).status).toBe(404);
  }
});
