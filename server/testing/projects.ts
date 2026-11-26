import { randomUUID } from "node:crypto";
import { serializeSigned } from "hono/utils/cookie";
import { expect, vi } from "vitest";
import { createApp } from "../app.ts";
import { credentialCrypto } from "../db/crypto.ts";
import { migrate } from "../db/migrations.ts";
import { dbTenants } from "../db/tenants.ts";
import type { Database } from "../db/sql.ts";

export const host = "page.example.com";
const origin = "https://" + host;
export const rules = { port: 443, tailnet: null, hosted: { host } };
export const options = { team: "WG", dist: "/unused/", watchMs: 0, readOnly: false };
const auth = { clientId: "client", clientSecret: "secret", secret: "test-session-secret-of-32-characters" };
export async function projectFixture(db: Database, collaboratorOrg = "org", overrides: Pick<Parameters<typeof createApp>[1], "telemetryEnv" | "waitUntil" | "now"> = {}) {
  await migrate(db);
  const tenants = dbTenants(db, credentialCrypto({ WG_DATA_KEY: Buffer.alloc(32).toString("base64") }), { linearAuth: auth });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (url.includes("datadoghq.com")) return new Response(null, { status: 202 });
    const { variables } = JSON.parse(String(init.body));
    return Response.json({ data: { project: variables.id === "project" ? { id: "project", name: "Example" } : null } });
  });
  const app = createApp(rules, { ...options, tenants, linearAuth: auth, ...overrides });
  async function account(name: string, org = "org") {
    const email = name + "@example.com";
    const id = await tenants.accounts.signIn({ linearUserId: name, linearOrgId: org, name, email }, {
      workspaceId: "work", linearOrgId: org, name: "Work", team: "WG", teamLabels: false,
      credential: { kind: "oauth", key: name + "-access", refreshToken: "refresh", expiresAt: new Date(Date.now() + 3600_000) },
    });
    const { token } = await tenants.accounts.createToken(id, "Coordinator");
    const packed = Buffer.from(JSON.stringify({ accountId: id, id: randomUUID(), email, exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url");
    const cookie = (await serializeSigned("__Host-wg_session", packed, auth.secret, { secure: true, path: "/" })).split(";")[0];
    return {
      id, token, email,
      request(url: string, method = "GET", data?: object, workspace?: string, session = false, extra: Record<string, string> = {}) {
        const credentials: Record<string, string> = session ? { cookie, origin } : { authorization: "Bearer " + token };
        return app.request(url, {
          method, headers: { host, "content-type": "application/json", ...credentials, ...extra, ...(workspace && { "x-workspace": workspace }) },
          body: data && JSON.stringify(data),
        });
      },
    };
  }
  const owner = await account("Ada");
  const collaborator = await account("Grace", collaboratorOrg);
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
  return { accounts: tenants.accounts, owner, collaborator, viewer, outsider, scope: "shared:" + shared.id, viewScope: "shared:" + view.id,
    memberPath: "/api/projects/project/members/" + members.find(({ name }: { name: string }) => name === "Grace").id };
}
