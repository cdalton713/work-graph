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
    const { collaborator, scope } = await projectFixture(await open(), "other-org");
    let member = true;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
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
    const { owner, collaborator, viewer, outsider, scope, memberPath } = await projectFixture(await open());
    let member = true;
    let refused = false;
    const output: string[] = [];
    for (const level of ["log", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args) => { output.push(args.join(" ")); });
    }
    const writes: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const { query, variables } = JSON.parse(String(init.body));
      const credential = new Headers(init.headers).get("authorization");
      if (query.includes("mutation")) {
        writes.push([credential, variables.input]);
        if (refused) return Response.json({ errors: [{ message: "Team membership is managed by SCIM (Ada-access)" }] });
        return Response.json({ data: { teamMembershipCreate: { success: true }, organizationInviteCreate: { success: true } } });
      }
      return Response.json({ data: {
        organization: { id: "org", name: "Work", urlKey: "work" },
        project: { id: "project", teams: { nodes: [{ id: "team", key: "WG" }] } },
        users: { nodes: member ? [{ id: "member-in-org", active: true }] : [] },
      } });
    });
    const add = memberPath + "/access";
    const input = { email: "other@example.com", team: "other" };
    for (const account of [collaborator, viewer, outsider]) {
      expect((await account.request(add, "POST", input, undefined, true)).status).toBe(404);
    }
    expect((await owner.request(add, "POST", input)).status).toBeGreaterThanOrEqual(400);
    expect((await owner.request(add, "POST", input, undefined, true, { origin: "https://other.example.com" })).status).toBe(403);
    const members = (await (await owner.request(share, "GET", undefined, undefined, true)).json()).members;
    const viewerId = members.find(({ email }: { email: string }) => email === viewer.email).id;
    expect((await owner.request(share.replace("/share", "/members/" + viewerId + "/access"), "POST", input, undefined, true)).status).toBe(403);
    expect((await owner.request(add.replace("/project/", "/other/"), "POST", input, undefined, true)).status).toBe(404);
    expect(writes).toEqual([]);
    expect(await (await owner.request(add, "POST", input, undefined, true)).json()).toEqual({ status: "added" });
    expect(writes).toEqual([["Bearer Ada-access", { userId: "member-in-org", teamId: "team" }]]);
    member = false;
    expect((await owner.request(add, "POST", input, undefined, true)).status).toBe(409);
    expect(writes).toHaveLength(1);
    expect(await (await owner.request(add, "POST", { ...input, invite: true }, undefined, true)).json()).toEqual({ status: "invited" });
    expect(writes[1]).toEqual(["Bearer Ada-access", { email: collaborator.email, teamIds: ["team"], role: "user" }]);
    expect((await collaborator.request(access + "/request", "POST", {}, scope, true)).status).toBe(204);
    refused = true;
    const result = await owner.request(add, "POST", { invite: true }, undefined, true);
    expect(result.status).toBe(403);
    expect(await result.json()).toEqual({ error: "Team membership is managed by SCIM ([redacted])",
      settingsUrl: "https://linear.app/work/settings/teams/WG/members" });
    expect((await (await owner.request(share, "GET", undefined, undefined, true)).json()).members
      .find(({ email }: { email: string }) => email === collaborator.email).accessRequestedAt).toEqual(expect.any(String));
    expect(output.join("\n")).not.toContain("Ada-access");
    expect((await owner.request(memberPath, "DELETE", undefined, undefined, true)).status).toBe(204);
    expect((await (await owner.request(share, "GET", undefined, undefined, true)).json()).members
      .some(({ email }: { email: string }) => email === collaborator.email)).toBe(false);
  });
});

it("returns 404 for access routes outside service mode", async () => {
  const app = createApp(rules, options);
  for (const [path, method] of [[access, "GET"], [access + "/request", "POST"], ["/api/projects/project/members/member/access", "POST"]]) {
    expect((await app.request(path, { method, headers: { host } })).status).toBe(404);
  }
});
