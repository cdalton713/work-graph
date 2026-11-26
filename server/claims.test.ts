import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "./app.ts";
import { databaseSuites } from "./testing/sql.ts";
import { host, options, projectFixture, rules } from "./testing/projects.ts";

const path = "/api/projects/project/claims";
const node = path + "/build";
const job = { job: "dispatch", lease_s: 30 };

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

databaseSuites((open) => {
  it("admits one account in a race and renews claims for that account", async () => {
    const db = await open();
    try {
      const { owner, collaborator, scope } = await projectFixture(db);
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
      expect(list).toEqual({ role: "owner", claims: [expect.objectContaining({ node: "build", holder: winner, stale: false, mine: winner === "Ada" })] });
      expect(await (await collaborator.request(path, "GET", undefined, scope)).json()).toMatchObject({
        role: "collaborator", claims: [{ holder: winner, mine: winner === "Grace" }],
      });
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
      const { owner, collaborator, viewer, outsider, scope, viewScope, memberPath } = await projectFixture(db);
      expect((await viewer.request(node, "POST", job, viewScope)).status).toBe(403);
      expect((await owner.request(node, "POST", job, undefined, true)).status).toBe(403);
      expect((await outsider.request(path, "GET", undefined, scope)).status).toBe(404);
      expect((await collaborator.request(path.replace("/project/", "/other/"), "GET", undefined, scope)).status).toBe(404);
      expect((await collaborator.request(node, "POST", job, scope)).status).toBe(200);
      for (const [account, workspace] of [[owner, undefined], [viewer, viewScope]] as const) {
        const response = await account.request(path, "GET", undefined, workspace);
        expect(await response.json()).toMatchObject({ role: workspace ? "viewer" : "owner", claims: [{ holder: "Grace", stale: false, mine: false }] });
      }
      const viewerList = await viewer.request(path, "GET", undefined, viewScope, true);
      expect(await viewerList.json()).toMatchObject({ claims: [{ holder: "Grace" }] });
      const refused = await owner.request(node, "DELETE", undefined, undefined, true);
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ claim: { holder: "Grace" } });
      expect((await owner.request(node + "?force=1", "DELETE", undefined, undefined, true)).status).toBe(204);
      expect((await owner.request(node, "POST", job)).status).toBe(200);
      expect((await collaborator.request(node, "DELETE", undefined, scope)).status).toBe(409);
      expect((await collaborator.request(node + "?force=1", "DELETE", undefined, scope)).status).toBe(409);
      expect((await owner.request(node, "DELETE")).status).toBe(204);
      expect((await collaborator.request(node, "POST", job, scope)).status).toBe(200);
      expect((await owner.request(memberPath, "PATCH", { role: "viewer" }, undefined, true)).status).toBe(204);
      expect(await (await owner.request(path)).json()).toEqual({ role: "owner", claims: [] });
      expect((await owner.request(memberPath, "PATCH", { role: "collaborator" }, undefined, true)).status).toBe(204);
      expect((await collaborator.request(node, "POST", job, scope)).status).toBe(200);
      expect((await owner.request(memberPath, "DELETE", undefined, undefined, true)).status).toBe(204);
      expect(await (await owner.request(path)).json()).toEqual({ role: "owner", claims: [] });
    } finally { await db.close(); }
  }, 30_000);

  it("permits a takeover after expiry and refuses the old holder's renewal", async () => {
    const db = await open();
    try {
      const { owner, collaborator, scope } = await projectFixture(db);
      expect((await owner.request(node, "POST", job)).status).toBe(200);
      expect((await collaborator.request(node, "POST", { ...job, takeover: true }, scope)).status).toBe(409);
      await db.query("UPDATE node_claims SET lease_until = now() - interval '1 second'");
      expect(await (await owner.request(path)).json()).toMatchObject({ claims: [{ holder: "Ada", stale: true }] });
      const attempts = await Promise.all(Array.from({ length: 10 }, () => collaborator.request(node, "POST", job, scope)));
      for (const attempt of attempts) {
        expect(attempt.status).toBe(409);
        expect(await attempt.json()).toMatchObject({ claim: { holder: "Ada", stale: true } });
      }
      const takeovers = await Promise.all(Array.from({ length: 10 }, () =>
        collaborator.request(node, "POST", { ...job, takeover: true }, scope)));
      const results = await Promise.all(takeovers.map((response) => response.json()));
      expect(results.filter(({ action }) => action === "taken_over")).toHaveLength(1);
      expect(results.every(({ claim }) => claim.holder === "Grace")).toBe(true);
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

  it("admits one account when two collaborators race to take over a stale claim", async () => {
    const db = await open();
    try {
      const { owner, collaborator, viewer, scope, viewScope } = await projectFixture(db);
      const membersPath = "/api/projects/project/members/";
      const { members } = await (await owner.request("/api/projects/project/share", "GET", undefined, undefined, true)).json();
      const member = members.find(({ name }: { name: string }) => name === "Pat");
      expect((await owner.request(membersPath + member.id, "PATCH", { role: "collaborator" }, undefined, true)).status).toBe(204);
      expect((await owner.request(node, "POST", job)).status).toBe(200);
      await db.query("UPDATE node_claims SET lease_until = now() - interval '1 second'");
      const input = { ...job, takeover: true };
      const responses = await Promise.all(Array.from({ length: 20 }, (_, index) => index % 2
        ? collaborator.request(node, "POST", input, scope) : viewer.request(node, "POST", input, viewScope)));
      const winner = responses[0].status === 200 ? "Pat" : "Grace";
      expect(responses.map(({ status }) => status)).toEqual(Array.from({ length: 20 }, (_, index) =>
        (index % 2 ? "Grace" : "Pat") === winner ? 200 : 409));
      const bodies = await Promise.all(responses.map((response) => response.json()));
      expect(bodies.filter(({ action }) => action === "taken_over")).toHaveLength(1);
      expect(bodies.every(({ claim }) => claim.holder === winner)).toBe(true);
    } finally { await db.close(); }
  }, 30_000);

  it("validates inputs and limits concurrent additions to 200 live claims", async () => {
    const db = await open();
    try {
      const { owner } = await projectFixture(db);
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
