import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { createAccounts } from "./db/accounts.ts";
import type { ClaimScope } from "./db/claims.ts";
import type { PlanData } from "./db/plans.ts";
import type { Telemetry, UsageScope } from "./telemetry.ts";

type Access = {
  plans: ReturnType<typeof createAccounts>["plans"];
  scope: ClaimScope;
  name: string;
  usage: () => Promise<UsageScope | null>;
};

const nodeKinds: ReadonlySet<unknown> = new Set(["task", "spike", "decision", "ops", "merge-point", "ship-point"]);
const nodeKey = /^[a-z0-9-]{1,40}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const tag = (version: number) => `"${version}"`;

function validate(input: unknown, name: string): PlanData | string {
  if (!record(input) || !record(input.plan)) return "plan must be an object";
  const { plan, keymap } = input;
  if (!record(keymap)) return "keymap must be an object";
  if (!record(plan.effort) || plan.effort.name !== name) return "plan.effort.name must match the Linear project name";
  if (!Array.isArray(plan.nodes)) return "plan.nodes must be an array";
  const keys = new Set<string>();
  for (const node of plan.nodes) {
    if (!record(node) || typeof node.key !== "string" || !nodeKey.test(node.key) || keys.has(node.key)) {
      return "Each plan.nodes entry must have a valid, unique key";
    }
    if (!nodeKinds.has(node.kind)) return "Each plan.nodes entry must have a valid kind";
    keys.add(node.key);
  }
  if (!Array.isArray(plan.edges) || plan.edges.some((edge) => !record(edge)
    || typeof edge.from !== "string" || typeof edge.to !== "string" || !keys.has(edge.from) || !keys.has(edge.to))) {
    return "plan.edges must be an array with from and to keys in plan.nodes";
  }
  return { plan, keymap };
}

export function planRoutes(access?: (c: Context) => Promise<Access | Response>, telemetry?: Telemetry | null) {
  const routes = new Hono();
  const path = "/projects/:id/plan";
  const history = path + "/versions";
  const revision = history + "/:version";
  const missing = (c: Context) => c.text("No plan found", 404);
  const forbidden = (c: Context) => c.text("Your project role does not permit this plan operation", 403);
  if (!access) {
    routes.get(path, missing);
    routes.put(path, missing);
    routes.get(history, missing);
    routes.get(revision, missing);
    return routes;
  }

  async function read(c: Context) {
    const target = await access!(c);
    if (target instanceof Response) return target;
    const requested = c.req.param("version");
    const version = requested === undefined ? undefined : Number(requested);
    if (requested !== undefined && (!/^[1-9][0-9]*$/.test(requested) || version! > 2147483647)) return missing(c);
    const result = await target.plans(target.scope, { kind: "get", version });
    if (result.status === 403) return forbidden(c);
    if (!("plan" in result) || !result.plan) return missing(c);
    const etag = tag(result.plan.version);
    c.header("ETag", etag);
    c.header("Cache-Control", "private, no-cache");
    const match = c.req.header("if-none-match")?.split(",").map((value) => value.trim().replace(/^W\//, ""));
    if (match?.some((value) => value === etag || value === "*" || value === String(result.plan.version))) {
      return c.body(null, 304);
    }
    return c.json(result.plan);
  }

  routes.get(path, read);
  routes.get(revision, read);
  routes.get(history, async (c) => {
    const target = await access(c);
    if (target instanceof Response) return target;
    const result = await target.plans(target.scope, { kind: "list" });
    c.header("Cache-Control", "private, no-cache");
    return "versions" in result ? c.json({ versions: result.versions }) : missing(c);
  });

  routes.put(path, bodyLimit({
    maxSize: 1024 * 1024,
    onError: (c) => c.text("Plan body exceeds 1 MB", 413),
  }), async (c) => {
    const target = await access(c);
    if (target instanceof Response) return target;
    const match = c.req.header("if-match");
    const none = c.req.header("if-none-match");
    if (match === undefined && none === undefined) return c.text("If-Match or If-None-Match is required", 428);
    if (none !== undefined && (none !== "*" || match !== undefined)) return c.text("Use If-None-Match: * to create the plan", 400);
    const data = validate(await c.req.json().catch(() => null), target.name);
    if (typeof data === "string") return c.text(data, 400);
    const result = await target.plans(target.scope, {
      kind: "put", match: match?.replace(/^"([0-9]+)"$/, "$1"), initialize: none === "*", data,
    });
    if (result.status === 403) return forbidden(c);
    if (result.status === 412) {
      telemetry?.emit("plan_conflict", {}, target.usage, target.scope.project[0]);
      return c.json({ error: "Plan version conflict", version: result.version, writer: result.writer }, 412);
    }
    if (result.status !== 200 || !result.version || !result.role) return missing(c);
    telemetry?.emit("plan_written", { version: result.version, role: result.role }, target.usage, target.scope.project[0]);
    c.header("ETag", tag(result.version));
    return c.json({ version: result.version });
  });

  return routes;
}
