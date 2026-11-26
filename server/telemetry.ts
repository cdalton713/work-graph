import { createHmac } from "node:crypto";
import { claimJobs } from "./db/claims.ts";

const sites = new Set([
  "datadoghq.com", "us3.datadoghq.com", "us5.datadoghq.com", "datadoghq.eu", "ddog-gov.com",
  "us2.ddog-gov.com", "ap1.datadoghq.com", "ap2.datadoghq.com", "uk1.datadoghq.com",
]);

const claimFields = { job: claimJobs, role: ["owner", "collaborator"] } as const;

const fields = {
  plan_written: { version: "positiveInteger", role: claimFields.role },
  plan_conflict: {},
  node_claimed: claimFields,
  claim_conflict: claimFields,
  sign_up: {},
  sign_in: {},
  account_deleted: {},
  workspace_attached: { kind: ["api_key", "oauth"] },
  workspace_removed: { kind: ["api_key", "oauth"] },
  onboarding_step: { step: ["name", "workspaces", "teams", "setup", "connect"] },
  onboarding_complete: {},
  onboarding_skipped: {},
  first_connection: {},
  token_created: {},
  token_revoked: {},
  coordinator_connected: {},
  share_made: {},
  share_revoked: {},
  member_joined: { role: ["viewer", "collaborator"] },
  member_removed: {},
  page_view: { page: ["overview", "project", "settings", "onboarding"], role: ["owner", "viewer", "collaborator"] },
  node_opened: { role: ["owner", "viewer", "collaborator"] },
  page_write: { kind: ["comment", "status", "answer", "command"], role: ["owner", "viewer", "collaborator"] },
} as const;

type Event = keyof typeof fields;
type Fields<E extends Event> = E extends Event
  ? Partial<{ [K in keyof typeof fields[E]]: typeof fields[E][K] extends readonly string[] ? typeof fields[E][K][number]
    : typeof fields[E][K] extends "positiveInteger" ? number : never }>
  : never;
export interface UsageWorkspace { id: string; organization: string; configId?: string }
export interface UsageScope {
  tenant: string;
  workspace: UsageWorkspace;
  enabled: boolean;
}
type Resolve = () => UsageScope | null | Promise<UsageScope | null>;
type Claims = (scope: UsageScope) => boolean | Promise<boolean>;
type Log = Record<string, string | number>;
type Metric = { metric: string; tags: string[]; type: 1; interval: 1; points: [{ timestamp: number; value: number }] };
type Entry = { tenant: string; cancelled?: boolean; prepare(): Promise<{ metric: Metric; log: Log } | null> };

const timeoutMs = 2000;
const batchSize = 25;
const queueLimit = 1000;

export function createTelemetry(
  env: NodeJS.ProcessEnv, mode: "config" | "service",
  waitUntil?: (job: Promise<void>) => void, fetcher: typeof fetch = (input, init) => fetch(input, init), now = Date.now,
) {
  const key = env.DD_API_KEY?.trim();
  const secret = env.WG_SESSION_SECRET?.trim();
  const workspaceIds = new Set(env.WG_TELEMETRY_WORKSPACES?.toLowerCase().split(/[\s,]+/).filter(Boolean));
  const site = env.DD_SITE?.trim() || "datadoghq.com";
  if (!key) return null;
  if (!secret || secret.length < 32) {
    console.warn("Usage data is off because WG_SESSION_SECRET must have at least 32 characters");
    return null;
  }
  if (!workspaceIds.size || !sites.has(site)) return null;

  const hashKey = createHmac("sha256", secret).update("workgraph-usage-v1").digest();
  const hash = (kind: string, value: string) => createHmac("sha256", hashKey).update(kind + ":" + value).digest("hex");
  const queue: Entry[] = [];
  let working: Promise<void> | undefined;
  let active: Entry[] = [];
  let lastWarning = -Infinity;

  function warn() {
    const time = now();
    if (time - lastWarning < 60_000) return;
    lastWarning = time;
    console.warn("Usage data could not be sent");
  }

  async function send(url: string, body: object) {
    try {
      const response = await fetcher(url, {
        method: "POST", headers: { "Content-Type": "application/json", "DD-API-KEY": key! },
        body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) warn();
      await response.body?.cancel();
    } catch {
      warn();
    }
  }

  async function prepareWithinDeadline(entry: Entry) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([entry.prepare(), new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          entry.cancelled = true;
          warn();
          resolve(null);
        }, timeoutMs);
      })]);
    } catch {
      warn();
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function drain() {
    while (queue.length) {
      const batch = queue.splice(0, batchSize);
      active = batch;
      const prepared = await Promise.all(batch.map(prepareWithinDeadline));
      const series = new Map<string, Metric>();
      const logs: Log[] = [];
      for (const [index, entry] of prepared.entries()) {
        if (!entry || batch[index].cancelled) continue;
        const { metric, log } = entry;
        const id = JSON.stringify([metric.metric, metric.tags, metric.points[0].timestamp]);
        const first = series.get(id);
        if (first) first.points[0].value += 1;
        else series.set(id, metric);
        logs.push(log);
      }
      if (logs.length) await Promise.all([
        send(`https://api.${site}/api/v2/series`, { series: [...series.values()] }),
        send(`https://http-intake.logs.${site}/api/v2/logs`, logs),
      ]);
      active = [];
    }
    working = undefined;
  }

  return {
    discard(tenant: string) {
      for (const entry of active) if (entry.tenant === tenant) entry.cancelled = true;
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].tenant === tenant) queue.splice(i, 1);
      }
    },
    emit<E extends Event>(event: E, input: Fields<NoInfer<E>>, resolve: Resolve, tenant = "", claim?: Claims) {
      if (!Object.hasOwn(fields, event)) return;
      const accepted: Log = {};
      for (const [field, allowed] of Object.entries(fields[event]) as [string, readonly string[] | "positiveInteger"][]) {
        const value = (input as Record<string, unknown>)[field];
        if (allowed === "positiveInteger") {
          if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) accepted[field] = value;
        } else if (typeof value === "string" && allowed.includes(value)) accepted[field] = value;
      }
      if (queue.length + active.length === queueLimit) queue.shift();
      const timestamp = Math.floor(now() / 1000);
      queue.push({ tenant, async prepare() {
        const scope = await resolve();
        if (this.cancelled || !scope?.enabled || ![scope.workspace.id, scope.workspace.organization, scope.workspace.configId].some((id) => id && workspaceIds.has(id.toLowerCase()))) return null;
        if (claim && !await claim(scope)) return null;
        const tags = [`mode:${mode}`, ...Object.entries(accepted).flatMap(([name, value]) => typeof value === "string" ? [`${name}:${value}`] : [])];
        return {
          metric: { metric: `workgraph.${event}`, type: 1, interval: 1, points: [{ timestamp, value: 1 }], tags },
          log: { message: event, ddsource: "nodejs", service: "workgraph", ddtags: tags.join(","), ...accepted,
            tenant: hash("tenant", mode === "config" ? "config" : scope.tenant),
            workspace: hash("workspace", scope.workspace.organization) },
        };
      } });
      working ??= new Promise<void>((resolve) => setImmediate(resolve)).then(drain);
      try { waitUntil?.(working); } catch { /* The host may have no active invocation. */ }
    },
  };
}

export type Telemetry = NonNullable<ReturnType<typeof createTelemetry>>;
