import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { claimJobs, type ClaimJob, type ClaimScope } from "./db/claims.ts";
import type { createAccounts } from "./db/accounts.ts";
import type { Telemetry, UsageScope } from "./telemetry.ts";

type Access = {
  claims: ReturnType<typeof createAccounts>["claims"];
  notice: (nodes: string[]) => Promise<void>;
  scope: ClaimScope;
  usage: () => Promise<UsageScope | null>;
};

const jobNames: ReadonlySet<unknown> = new Set(claimJobs);
const nodeKey = /^[a-z0-9-]{1,40}$/;

export function claimRoutes(access?: (c: Context) => Promise<Access | Response>, telemetry?: Telemetry | null) {
  const routes = new Hono();
  const project = "/projects/:id/claims";
  const node = project + "/:node";
  const smallBody = bodyLimit({ maxSize: 1024 });
  const missing = (c: Context) => c.json({ error: "Project or claim not found" }, 404);
  if (!access) {
    routes.get(project, missing);
    routes.post(node, missing);
    routes.put(node, missing);
    routes.delete(node, missing);
    return routes;
  }

  routes.get(project, async (c) => {
    const target = await access(c);
    if (target instanceof Response) return target;
    const result = await target.claims(target.scope, { kind: "list" });
    return "claims" in result ? c.json({ claims: result.claims }) : missing(c);
  });

  async function write(c: Context, kind: "post" | "put" | "release") {
    const target = await access!(c);
    if (target instanceof Response) return target;
    const key = c.req.param("node");
    if (!key || !nodeKey.test(key)) return c.json({ error: "Invalid node key" }, 400);
    if (kind === "release") {
      const { status } = await target.claims(target.scope, { kind, node: key });
      if (status === 204) {
        await target.notice([key]);
        return c.body(null, 204);
      }
      return status === 403 ? c.json({ error: "Only the holder or project owner can release this claim" }, 403) : missing(c);
    }
    const input: { job?: unknown; lease_s?: unknown } | null = kind === "put" && !c.req.raw.body
      ? {} : await c.req.json().catch(() => null);
    const lease = input?.lease_s === undefined ? 600 : input.lease_s;
    if (!input || typeof input !== "object" || Array.isArray(input) || (kind === "post" && !jobNames.has(input.job))
      || typeof lease !== "number" || !Number.isInteger(lease) || lease < 30 || lease > 3600) {
      return c.json({ error: "Invalid job or lease" }, 400);
    }
    const result = await target.claims(target.scope, kind === "post"
      ? { kind, node: key, job: input.job as ClaimJob, lease }
      : { kind, node: key, lease });
    if (result.status === 200 && result.claim) {
      if (result.action !== "renewed") telemetry?.emit("node_claimed",
        { job: result.claim.job, role: result.role }, target.usage, target.scope.project[0]);
      if (result.action !== "renewed" || result.jobChanged) await target.notice([key]);
      return c.json({ action: result.action, claim: result.claim });
    }
    if (result.status === 409) {
      if (result.claim) {
        telemetry?.emit("claim_conflict", { job: kind === "post" ? input.job as ClaimJob : result.claim.job, role: result.role },
          target.usage, target.scope.project[0]);
        return c.json({ error: "Node already claimed", claim: result.claim }, 409);
      }
      return c.json({ error: "Project has reached its live claim limit" }, 409);
    }
    return result.status === 403 ? c.json({ error: "Only owners and collaborators can claim nodes" }, 403) : missing(c);
  }

  routes.post(node, smallBody, (c) => write(c, "post"));
  routes.put(node, smallBody, (c) => write(c, "put"));
  routes.delete(node, (c) => write(c, "release"));
  return routes;
}
