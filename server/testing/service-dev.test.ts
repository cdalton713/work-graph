import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { test, expect } from "vitest";

const productionSettings = ["DATABASE_URL", "WG_HOSTED", "WG_DATA_KEY", "WG_SESSION_SECRET", "NODE_ENV"];
const previewEnv = { ...process.env };
for (const name of productionSettings) delete previewEnv[name];

test.each(productionSettings)("the service preview refuses %s before it starts", (name) => {
  const result = spawnSync(process.execPath, ["server/testing/service-dev.ts", "--port", "0"], {
    encoding: "utf8", timeout: 5000,
    env: { ...previewEnv, [name]: name === "NODE_ENV" ? "production" : "example" },
  });
  expect(result.stderr).toContain(`Service preview cannot start with ${name} set for production.`);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
});

test("the local service starts on loopback, serves service config, and stops", async () => {
  const child = spawn(process.execPath, ["server/testing/service-dev.ts", "--port", "0"], {
    env: previewEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let started = false;
  let output = "";
  try {
    const url = await new Promise<string>((resolve, reject) => {
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output);
        if (match) resolve(match[0]);
      });
      child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      child.once("error", reject);
      void exited.then(() => reject(new Error(output)));
    });
    started = true;
    const response = await fetch(url + "/api/config");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ auth: true, signIn: "linear", user: null });
    const viewer = await fetch(url + "/auth/login?as=pat", { redirect: "manual" });
    const viewerCookie = viewer.headers.get("set-cookie")!.split(";")[0];
    const viewerDirectory = await (await fetch(url + "/api/projects", { headers: { cookie: viewerCookie } })).json();
    const viewerWorkspace = viewerDirectory.workspaces.find(({ role }: { role?: string }) => role === "viewer");
    const viewerGraph = await fetch(url + "/api/projects/project/graph", {
      headers: { cookie: viewerCookie, "x-workspace": viewerWorkspace.id },
    });
    expect(viewerGraph.status).toBe(200);
    expect(await viewerGraph.json()).toMatchObject({ waitNames: ["Ada", "Grace"] });

    const signedIn = await fetch(url + "/auth/login", { redirect: "manual" });
    expect(signedIn.status).toBe(302);
    const cookie = signedIn.headers.get("set-cookie")!.split(";")[0];
    const account = await fetch(url + "/api/account", { headers: { cookie } });
    const settings = await account.json();
    expect(settings).toMatchObject({ human: "Ada", pageUrl: url, onboarding: { name: false } });
    expect(settings).not.toHaveProperty("sendUsageData");
    const projects = await fetch(url + "/api/projects", { headers: { cookie } });
    expect(await projects.json()).toMatchObject({ projects: [{ id: "project", name: "Example project", workspace: "example" }] });
    const claimsPath = url + "/api/projects/project/claims";
    const ownerHeaders = { cookie, "x-workspace": "example" };
    expect(await (await fetch(claimsPath, { headers: ownerHeaders })).json()).toMatchObject({
      role: "owner",
      claims: [{ node: "check", mine: false, stale: true }, { node: "example", mine: true, stale: false }],
    });
    const share = await fetch(url + "/api/projects/project/share", { headers: { cookie, "x-workspace": "example" } });
    const shareData = await share.json();
    expect(shareData).toMatchObject({
      members: expect.arrayContaining([
        expect.objectContaining({ role: "collaborator", accessRequestedAt: expect.any(String) }),
        expect.objectContaining({ role: "viewer", accessRequestedAt: null }),
      ]),
    });
    const member = shareData.members.find(({ role }: { role: string }) => role === "collaborator");
    const add = (invite: boolean) => fetch(url + `/api/projects/project/members/${member.id}/access`, {
      method: "POST", headers: { cookie, origin: url, "content-type": "application/json", "x-workspace": "example" },
      body: JSON.stringify({ invite }),
    });
    expect(await (await add(false)).json()).toMatchObject({ status: "invite_required" });
    expect(await (await add(true)).json()).toMatchObject({ status: "invited" });
    expect(await (await add(false)).json()).toMatchObject({ status: "invite_pending" });
    const signInCollab = await fetch(url + "/auth/login?as=grace", { redirect: "manual" });
    const collaboratorCookie = signInCollab.headers.get("set-cookie")!.split(";")[0];
    const directory = await fetch(url + "/api/projects", { headers: { cookie: collaboratorCookie } });
    const shared = (await directory.json()).workspaces.find((workspace: { role?: string }) => workspace.role === "collaborator");
    const sharedHeaders = { cookie: collaboratorCookie, "x-workspace": shared.id };
    expect(await (await fetch(claimsPath, { headers: sharedHeaders })).json()).toMatchObject({
      role: "collaborator",
      claims: [{ node: "check", mine: true }, { node: "example", mine: false }],
    });
    const release = (headers: Record<string, string>, force: string) => fetch(claimsPath + "/check" + force, {
      method: "DELETE", headers: { ...headers, origin: url, "content-type": "application/json" },
    });
    expect((await release(ownerHeaders, "")).status).toBe(409);
    expect((await release(ownerHeaders, "?force=1")).status).toBe(204);
    const access = await fetch(url + "/api/projects/project/access", { headers: sharedHeaders });
    expect(await access.json()).toMatchObject({ status: "not_member", team: "WG", accessRequestedAt: member.accessRequestedAt });
    const graph = await fetch(url + "/api/projects/project/graph", { headers: sharedHeaders });
    expect(await graph.json()).toMatchObject({ issues: [{ identifier: "WG-1" }, { identifier: "WG-2" }] });
    const write = await fetch(url + "/api/issues/issue/comments", {
      method: "POST", headers: { ...sharedHeaders, origin: url, "content-type": "application/json" },
      body: JSON.stringify({ body: "Example comment" }),
    });
    expect(write.status).toBe(403);
    expect(await write.json()).toMatchObject({ code: "needs_linear_access" });
  } finally {
    child.kill("SIGTERM");
    const result = await exited;
    if (started) expect(result).toEqual([0, null]);
  }
}, 20_000);
