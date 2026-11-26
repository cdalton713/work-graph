import { createHash } from "node:crypto";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "./app.ts";
import { databaseSuites } from "./testing/sql.ts";
import { host, options, projectFixture, rules } from "./testing/projects.ts";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const auth = { domains: ["example.com"], owners: ["owner@example.com"], clientId: "client", clientSecret: "secret",
  secret: "test-session-secret-of-32-characters" };
const input = { name: "Starter", firstTask: "Build", team: "WG" };
const key = (workspace: string) => createHash("sha256").update(JSON.stringify([workspace, "WG", "Starter", "Build"])).digest("hex");

function linearFixture(credential: string) {
  const writes: string[] = [];
  const team = { id: "team", name: "Team", key: "WG", states: { nodes: [{ id: "r", name: "Ready" }, { id: "t", name: "Todo" }] } };
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    expect(new Headers(init.headers).get("authorization")).toBe(credential);
    const { query, variables } = JSON.parse(String(init.body));
    if (query.includes("StarterTeam")) return Response.json({ data: { organization: { id: "org" }, viewer: { id: "me", teams: { nodes: [team] } } } });
    if (query.includes("mutation")) {
      const i = variables.input;
      writes.push(i.id);
      return Response.json({ data: { result: { success: true, object: { id: i.id, url: "u", identifier: "WG-" + writes.length,
        teams: { nodes: [team] }, team, project: { id: i.projectId }, issue: { id: i.issueId }, type: i.type, relatedIssue: { id: i.relatedIssueId } } } } });
    }
    return Response.json({ data: { project: { id: variables.id, name: input.name } } });
  });
  return writes;
}

it("requires an enabled owner session and writes only in the selected workspace", async () => {
  vi.stubEnv("WG_CREATE_PROJECTS", "1");
  const workspaces = ["first", "second"].map(id => ({ id, name: id, key: id, team: "WG", teamLabels: true }));
  const page = createApp(rules, { ...options, auth, workspaces, linkToken: "fixture-coordinator-token-with-32-characters" });
  const writes = linearFixture("second");
  async function post(email: string, workspace: string, body = input) {
    const value = Buffer.from(JSON.stringify({ email, hd: "example.com", exp: Date.now() / 1000 + 600 })).toString("base64url");
    const cookie = email && (await serializeSigned("__Host-wg_session", value, auth.secret, { secure: true, path: "/" })).split(";")[0];
    return page.request("/api/projects", { method: "POST", headers: { host, origin: "https://" + host, cookie,
      "content-type": "application/json", "x-workspace": workspace, "idempotency-key": key(workspace) }, body: JSON.stringify(body) });
  }
  try {
    expect((await post("", "second")).status).toBe(401);
    expect((await post("viewer@example.com", "second")).status).toBe(405);
    expect((await post(auth.owners[0], "unknown")).status).toBe(400);
    expect((await post(auth.owners[0], "second", { ...input, team: "OTHER" })).status).toBe(403);
    expect(writes).toEqual([]);
    const response = await post(auth.owners[0], "second");
    expect(await response.json()).toMatchObject({ workspace: "second", handoff: { command: "wg next .", plan: { effort: { name: "Starter" } } } });
    expect(writes).toHaveLength(10);
  } finally { page.link.stop(); }
});

it.each([
  { enabled: "0", readOnly: false, status: 403 },
  { enabled: "1", readOnly: true, status: 405 },
])("disables creation with flag $enabled and readOnly $readOnly", async ({ enabled, readOnly, status }) => {
  vi.stubEnv("WG_CREATE_PROJECTS", enabled);
  const page = createApp(rules, { ...options, auth, readOnly, linkToken: "fixture-coordinator-token-with-32-characters" });
  const value = Buffer.from(JSON.stringify({ email: auth.owners[0], hd: "example.com", exp: Date.now() / 1000 + 600 })).toString("base64url");
  const cookie = (await serializeSigned("__Host-wg_session", value, auth.secret, { secure: true, path: "/" })).split(";")[0];
  const headers = { host, origin: "https://" + host, cookie, "content-type": "application/json" };
  const writes = linearFixture("unused");
  try {
    expect((await (await page.request("/api/config", { headers })).json()).createProjects).toBeUndefined();
    expect((await page.request("/api/projects", { method: "POST", headers, body: JSON.stringify(input) })).status).toBe(status);
    expect(writes).toEqual([]);
  } finally { page.link.stop(); }
});

databaseSuites(open => {
  it("stores the hosted owner's plan and excludes shared memberships", async () => {
    vi.stubEnv("WG_CREATE_PROJECTS", "1");
    const db = await open();
    try {
      const { app, owner, viewer, viewScope, collaborator, scope } = await projectFixture(db);
      try {
        const writes = linearFixture("Bearer Ada-access");
        const headers = { "idempotency-key": key("work") };
        for (const [member, selected] of [[viewer, viewScope], [collaborator, scope]] as const) {
          expect((await member.request("/api/projects", "POST", input, selected, true, headers)).status).toBeGreaterThanOrEqual(400);
        }
        expect(writes).toEqual([]);
        const response = await owner.request("/api/projects", "POST", input, "work", true, headers);
        const { project, handoff } = await response.json();
        expect(response.status).toBe(200);
        const stored = await owner.request("/api/projects/" + project.id + "/plan", "GET", undefined, "work");
        const { collab, ...mapping } = handoff.keymap;
        expect(collab).toEqual({ page: "https://" + host, workspace: "work", project: project.id, name: input.name });
        expect(await stored.json()).toEqual({ version: 1, plan: handoff.plan, keymap: mapping });
      } finally { app.link.stop(); }
    } finally { await db.close(); }
  }, 30_000);
});
