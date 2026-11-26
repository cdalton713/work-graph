import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "./app.ts";
import { databaseSuites } from "./testing/sql.ts";
import { host, options, projectFixture, rules } from "./testing/projects.ts";

const path = "/api/projects/project/claims";
const node = path + "/build";
const job = { job: "dispatch", lease_s: 30 };

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const planPath = "/api/projects/project/plan";
const planBody = {
  plan: { effort: { name: "Example" }, nodes: [
    { key: "build", kind: "task" }, { key: "merge", kind: "merge-point" },
    { key: "ship", kind: "ship-point" }, { key: "deploy", kind: "ops" },
  ], edges: [{ from: "build", to: "merge" }] },
  keymap: { build: "WG-1" },
};

databaseSuites((open) => {
  it("stores conditional versions and gives one writer the next version", async () => {
    const db = await open();
    try {
      const { owner, collaborator, viewer, scope, viewScope } = await projectFixture(db);
      const first = { "if-none-match": "*" };
      expect(await (await owner.request(planPath)).text()).toContain("No plan");
      expect((await collaborator.request(planPath, "PUT", planBody, scope, false, first)).status).toBe(403);
      expect((await owner.request(planPath, "PUT", planBody)).status).toBe(428);
      expect((await owner.request(planPath, "PUT", planBody, undefined, true, first)).status).toBe(403);
      expect((await owner.request(planPath, "PUT", planBody, undefined, false, { "if-match": "1" })).status).toBe(412);
      const created = await owner.request(planPath, "PUT", planBody, undefined, false, first);
      expect(created.status).toBe(200);
      expect(created.headers.get("etag")).toBe('"1"');
      const read = await viewer.request(planPath, "GET", undefined, viewScope, true);
      expect(await read.json()).toEqual({ version: 1, ...planBody });
      expect((await viewer.request(planPath, "GET", undefined, viewScope, false, { "if-none-match": '"1"' })).status).toBe(304);
      expect((await viewer.request(planPath, "PUT", planBody, viewScope, false, first)).status).toBe(403);
      expect((await viewer.request(planPath + "/versions/1", "GET", undefined, viewScope)).status).toBe(403);
      const other = planPath.replace("/project/", "/other/");
      expect((await collaborator.request(other, "GET", undefined, scope)).status).toBe(404);
      expect((await collaborator.request(other, "PUT", planBody, scope, false, first)).status).toBe(404);
      const match = { "if-match": '"1"' };
      const writes = Array.from({ length: 20 }, (_, index) => ({ ...planBody, keymap: { build: "WG-" + (index + 10) } }));
      const responses = await Promise.all(writes.map((body) =>
        collaborator.request(planPath, "PUT", body, scope, false, match)));
      const winner = writes[responses.findIndex(({ status }) => status === 200)];
      expect(await (await collaborator.request(planPath, "GET", undefined, scope)).json()).toEqual({ version: 2, ...winner });
      expect((await owner.request(planPath, "PUT", planBody, undefined, false, first)).status).toBe(412);
      expect(responses.filter(({ status }) => status === 200)).toHaveLength(1);
      const conflicts = responses.filter(({ status }) => status === 412);
      expect(conflicts).toHaveLength(19);
      for (const response of conflicts) expect(await response.json()).toMatchObject({ version: 2, writer: "Grace" });
      const versions = await (await owner.request(planPath + "/versions")).json();
      expect(versions).toEqual({ versions: [
        { version: 2, writer: "Grace", writtenAt: expect.any(String) },
        { version: 1, writer: "Ada", writtenAt: expect.any(String) },
      ] });
      expect(await (await collaborator.request(planPath + "/versions/1", "GET", undefined, scope)).json())
        .toEqual({ version: 1, ...planBody });
    } finally { await db.close(); }
  }, 30_000);

  it("checks node kind, lease bounds and job changes when taking claims", async () => {
    const db = await open();
    try {
      const { owner, collaborator, scope } = await projectFixture(db);
      expect((await owner.request(planPath, "PUT", planBody, undefined, false, { "if-none-match": "*" })).status).toBe(200);
      expect((await owner.request(path + "/unknown", "POST", job)).status).toBe(404);
      for (const key of ["merge", "ship", "deploy"]) {
        expect((await collaborator.request(path + "/" + key, "POST", job, scope)).status).toBe(403);
        expect((await owner.request(path + "/" + key, "POST", job)).status).toBe(200);
      }
      for (const lease_s of [29, 3601]) {
        expect((await owner.request(node, "POST", { ...job, lease_s })).status).toBe(400);
        expect((await owner.request(node, "PUT", { lease_s })).status).toBe(400);
      }
      expect((await collaborator.request(node, "POST", job, scope)).status).toBe(200);
      expect(await (await collaborator.request(node, "POST", { ...job, job: "review" }, scope)).json())
        .toMatchObject({ claim: { job: "review" } });
      expect(await (await collaborator.request(node, "PUT", {}, scope)).json()).toMatchObject({ claim: { job: "review" } });
      const changed = { ...planBody, plan: { ...planBody.plan, nodes: [{ key: "merge", kind: "task" }], edges: [] } };
      expect((await owner.request(planPath, "PUT", changed, undefined, false, { "if-match": "1" })).status).toBe(200);
      expect((await collaborator.request(node, "PUT", {}, scope)).status).toBe(404);
      expect((await collaborator.request(node, "DELETE", undefined, scope)).status).toBe(204);
    } finally { await db.close(); }
  }, 30_000);

  it("validates plan data and keeps only the newest 50 versions", async () => {
    const db = await open();
    try {
      const { owner } = await projectFixture(db);
      const first = { "if-none-match": "*" };
      const bad: [object, string][] = [
        [{ ...planBody, plan: [] }, "plan"],
        [{ ...planBody, keymap: [] }, "keymap"],
        [{ ...planBody, plan: { ...planBody.plan, effort: {} } }, "effort.name"],
        [{ ...planBody, plan: { ...planBody.plan, effort: { name: "Other" } } }, "effort.name"],
        [{ ...planBody, plan: { ...planBody.plan, nodes: null } }, "nodes"],
        [{ ...planBody, plan: { ...planBody.plan, nodes: [{ key: "?", kind: "task" }] } }, "key"],
        [{ ...planBody, plan: { ...planBody.plan, nodes: [{ key: "build", kind: "other" }] } }, "kind"],
        [{ ...planBody, plan: { ...planBody.plan, edges: null } }, "edges"],
        [{ ...planBody, plan: { ...planBody.plan, edges: [{ from: "build", to: "missing" }] } }, "edges"],
      ];
      for (const [body, field] of bad) {
        const response = await owner.request(planPath, "PUT", body, undefined, false, first);
        expect(response.status).toBe(400);
        expect(await response.text()).toContain(field);
      }
      const large = await owner.request(planPath, "PUT", { ...planBody, keymap: { text: "é".repeat(600_000) } }, undefined, false, first);
      expect(large.status).toBe(413);
      expect(await large.text()).toContain("1 MB");
      for (let version = 1; version <= 51; version++) {
        const condition: Record<string, string> = version === 1 ? first : { "if-match": String(version - 1) };
        expect((await owner.request(planPath, "PUT", planBody, undefined, false, condition)).status).toBe(200);
      }
      expect((await owner.request(planPath + "/versions/1")).status).toBe(404);
      expect((await owner.request(planPath + "/versions/2")).status).toBe(200);
      const { versions } = await (await owner.request(planPath + "/versions")).json();
      expect(versions).toHaveLength(50);
      expect(versions[0].version).toBe(51);
    } finally { await db.close(); }
  }, 30_000);

  it.each(["member", "owner", "connection"])("cleans up rows when deleting the %s", async (deleted) => {
    const db = await open();
    try {
      const { accounts, owner, collaborator, scope } = await projectFixture(db);
      expect((await owner.request(planPath, "PUT", planBody, undefined, false, { "if-none-match": "*" })).status).toBe(200);
      expect((await collaborator.request(planPath, "PUT", planBody, scope, false, { "if-match": "1" })).status).toBe(200);
      expect((await collaborator.request(node, "POST", job, scope)).status).toBe(200);
      if (deleted === "connection") await db.query("DELETE FROM linear_connections WHERE tenant_id = $1", [owner.id]);
      else await accounts.deleteAccount(deleted === "owner" ? owner.id : collaborator.id);
      expect(await db.query("SELECT node_key FROM node_claims")).toEqual([]);
      if (deleted === "member") {
        expect(await (await owner.request(planPath + "/versions")).json()).toMatchObject({ versions: [
          { version: 2, writer: null }, { version: 1, writer: "Ada" },
        ] });
      } else {
        expect(await db.query("SELECT version FROM project_plans")).toEqual([]);
      }
    } finally { await db.close(); }
  }, 30_000);
});

it("refuses all plan routes without the account service", async () => {
  const app = createApp(rules, options);
  for (const [url, method] of [[planPath, "GET"], [planPath, "PUT"],
    [planPath + "/versions", "GET"], [planPath + "/versions/1", "GET"]]) {
    expect((await app.request(url, { method, headers: { host } })).status).toBe(404);
  }
});
