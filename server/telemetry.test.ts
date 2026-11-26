import { expect, it, vi } from "vitest";
import { createTelemetry } from "./telemetry.ts";

const env = {
  DD_API_KEY: "test-header-secret", WG_SESSION_SECRET: "test-session-secret-at-least-32-characters",
  WG_TELEMETRY_WORKSPACES: "work",
};
const scope = { tenant: "private-tenant", workspace: { id: "work", organization: "private-org" }, enabled: true };

it("sends only permitted events and attributes, with stable hashes and a header-only key", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
  const jobs: Promise<void>[] = [];
  const telemetry = createTelemetry(env, "service", (job) => jobs.push(job), fetcher)!;
  const extra = { kind: "api_key", name: "Ada", email: "ada@example.com", text: "private issue" } as const;
  telemetry.emit("workspace_attached", extra, () => scope);
  // Runtime defense also rejects input from an untyped or outdated caller.
  telemetry.emit("workspace_attached", { kind: "Ada" } as unknown as { kind: "api_key" }, () => scope);
  telemetry.emit("sign_in", {}, () => ({ ...scope, enabled: false }));
  telemetry.emit("sign_up", {}, () => ({ ...scope, workspace: { id: "personal", organization: "other" } }));
  await Promise.all(jobs);

  const [metrics, logs] = fetcher.mock.calls;
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(metrics[0]).toBe("https://api.datadoghq.com/api/v2/series");
  expect(logs[0]).toBe("https://http-intake.logs.datadoghq.com/api/v2/logs");
  for (const [, init] of fetcher.mock.calls) {
    expect(new Headers(init?.headers).get("dd-api-key")).toBe(env.DD_API_KEY);
    for (const value of [env.DD_API_KEY, "Ada", "ada@example.com", "private issue", scope.tenant, scope.workspace.organization]) {
      expect(init?.body).not.toContain(value);
    }
  }
  expect(JSON.parse(metrics[1]!.body as string).series.map(({ tags }: { tags: string[] }) => tags))
    .toEqual([["mode:service", "kind:api_key"], ["mode:service"]]);
  const [first, second] = JSON.parse(logs[1]!.body as string);
  expect(first.tenant).toMatch(/^[a-f0-9]{64}$/);
  expect(first.workspace).toMatch(/^[a-f0-9]{64}$/);
  expect(second.tenant).toBe(first.tenant);
  expect(second.workspace).toBe(first.workspace);
  expect(second.kind).toBeUndefined();
});

it("drops the oldest events when the queue fills", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
  const jobs: Promise<void>[] = [];
  const telemetry = createTelemetry(env, "service", (job) => jobs.push(job), fetcher)!;
  telemetry.emit("sign_in", {}, () => scope);
  for (let i = 0; i < 1000; i++) telemetry.emit("sign_up", {}, () => scope);
  await Promise.all(jobs);
  const logs = fetcher.mock.calls.filter(([url]) => String(url).endsWith("/logs"))
    .flatMap(([, init]) => JSON.parse(init!.body as string));
  expect(logs).toHaveLength(1000);
  expect(logs.every(({ message }) => message === "sign_up")).toBe(true);
});

it("cancels slow intake requests after two seconds and logs one fixed warning", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const signal = init?.signal!;
    return new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(env.DD_API_KEY)), 5000);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(signal.reason);
      }, { once: true });
    });
  });
  try {
    const jobs: Promise<void>[] = [];
    const telemetry = createTelemetry(env, "service", (job) => jobs.push(job), fetcher)!;
    telemetry.emit("node_opened", {}, () => scope);
    await Promise.all(jobs);
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(warning.mock.calls).toEqual([["Usage data could not be sent"]]);
  } finally { warning.mockRestore(); }
});

it("drops a stuck preparation and sends the next event", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
  const jobs: Promise<void>[] = [];
  try {
    const telemetry = createTelemetry(env, "service", (job) => jobs.push(job), fetcher)!;
    telemetry.emit("sign_in", {}, () => new Promise(() => {}));
    telemetry.emit("node_opened", {}, () => scope);
    await Promise.race([
      Promise.all(jobs),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Preparation held the queue open")), 3000).unref();
      }),
    ]);
    const logs = fetcher.mock.calls.find(([url]) => String(url).endsWith("/logs"));
    expect(JSON.parse(String(logs?.[1]?.body)).map(({ message }: { message: string }) => message)).toEqual(["node_opened"]);
  } finally { warning.mockRestore(); }
});

it("warns once when an intake key has no usable session secret", () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    for (const secret of [undefined, "short-secret"]) {
      warning.mockClear();
      expect(createTelemetry({ ...env, WG_SESSION_SECRET: secret }, "service")).toBeNull();
      expect(warning.mock.calls).toEqual([["Usage data is off because WG_SESSION_SECRET must have at least 32 characters"]]);
    }
  } finally { warning.mockRestore(); }
});

it("sends plan versions as numeric log attributes and keeps them out of metric tags", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
  const jobs: Promise<void>[] = [];
  const telemetry = createTelemetry(env, "service", (job) => jobs.push(job), fetcher)!;
  telemetry.emit("plan_written", { version: 3, role: "collaborator" }, () => scope);
  telemetry.emit("plan_written", { version: -1 }, () => scope);
  telemetry.emit("plan_conflict", {}, () => scope);
  await Promise.all(jobs);
  const [metrics, logs] = fetcher.mock.calls;
  expect(JSON.parse(metrics[1]!.body as string).series.map(({ tags }: { tags: string[] }) => tags))
    .toEqual([["mode:service", "role:collaborator"], ["mode:service"], ["mode:service"]]);
  const [written, invalid, conflict] = JSON.parse(logs[1]!.body as string);
  expect(written).toMatchObject({ message: "plan_written", version: 3, role: "collaborator" });
  expect(invalid.version).toBeUndefined();
  expect(conflict.message).toBe("plan_conflict");
});
