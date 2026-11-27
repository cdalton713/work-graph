import { afterEach, aroundEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  CHANGED_PAGES, INITIATIVE_GROUP, LinearError, MAX_PARALLEL, boardRead, updateIssue, addComment, addReviewUrls, changedProjects, changedSince, gql, initiativeOf, linearBudget, listProjects, loadGraph,
  createLinearCache, delay, isMutation, linearCache, mapLimit, pullRequestsOf, setTransport,
} from "./linear.ts";
import { createSite } from "../src/lib/site.ts";
import { requestSite } from "./site.ts";
import { linearWorkspace } from "./workspaces.ts";

aroundEach((run) => requestSite.run(createSite("Human", "default"), () =>
  linearCache.run(createLinearCache(), () => linearWorkspace.run({
    id: "default", name: "Linear", team: "WG", teamLabels: true,
    get key() { return process.env.LINEAR_API_KEY ?? ""; },
  }, run))));

it("requires a workspace, a tenant and a site before reaching Linear", async () => {
  const query = "query{ viewer{id} }";
  await expect(linearWorkspace.exit(() => gql(query))).rejects.toThrow("needs a workspace");
  await expect(linearCache.exit(() => gql(query))).rejects.toThrow("needs a tenant");
  await expect(requestSite.exit(() => gql(query))).rejects.toThrow("needs a site");
});

const pr = (n: number, extra: Record<string, unknown> = {}) => ({ url: `https://github.com/o/r/pull/${n}`, title: `PR ${n}`, sourceType: "github", metadata: { title: `t${n}`, status: "draft", ...extra } });

describe("pullRequestsOf", () => {
  it("keeps GitHub pull requests once each and drops other links", () => {
    const nodes = [pr(7), { ...pr(7), url: "https://github.com/o/r/pull/7/files" }, { url: "https://example.com", title: "doc", metadata: {} }];
    expect(pullRequestsOf({ nodes })).toEqual([{ number: 7, url: "https://github.com/o/r/pull/7", title: "t7", status: "draft", reviewUrl: null }]);
  });
});

describe("addReviewUrls", () => {
  afterEach(() => vi.unstubAllGlobals());
  const issues = () => [{ url: "https://linear.app/acme/issue/CD-1/x", pullRequests: pullRequestsOf({ nodes: [pr(7), pr(8)] }) }];

  it("links each pull request that Linear knows to its review page in the workspace", async () => {
    vi.stubEnv("LINEAR_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ data: { pullRequests: { nodes: [{ slugId: "abc123", url: "https://github.com/o/r/pull/7" }] } } }) })));
    const list = issues();
    await addReviewUrls(list);
    expect(list[0].pullRequests.map((p) => p.reviewUrl)).toEqual(["https://linear.app/acme/review/abc123", null]);
  });

  it("leaves the review links empty when Linear refuses the query", async () => {
    vi.stubEnv("LINEAR_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ errors: [{ message: "Cannot query field" }] }) })));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const list = issues();
    await addReviewUrls(list);
    expect(list[0].pullRequests.map((p) => p.reviewUrl)).toEqual([null, null]);
  });
});

describe("changedProjects", () => {
  afterEach(() => vi.unstubAllGlobals());
  const page = (next: string | null) => ({ hasNextPage: !!next, endCursor: next });

  it("asks one question for all projects, with the status document of each, and gives the latest change of each", async () => {
    vi.stubEnv("LINEAR_API_KEY", "test-key");
    const sent: { query: string; variables: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      sent.push(body);
      const data = sent.length === 1
        ? {
          issues: { nodes: [{ updatedAt: "2026-11-20T01:00:00Z", project: { id: "a" } }, { updatedAt: "2026-11-20T03:00:00Z", project: { id: "a" } }], pageInfo: page("i2") },
          // The comment of "a" is half a second later than its issue, in a text that sorts before it.
          comments: { nodes: [{ updatedAt: "2026-11-20T02:00:00Z", issue: { project: { id: "b" } } }, { updatedAt: "2026-11-20T03:00:00.500Z", issue: { project: { id: "a" } } }], pageInfo: page(null) },
          d0: { documents: { nodes: [] } }, d1: { documents: { nodes: [] } }, d2: { documents: { nodes: [{ updatedAt: "2026-11-20T04:00:00Z" }] } },
        }
        : { issues: { nodes: [{ updatedAt: "2026-11-20T02:00:00Z", project: { id: "a" } }], pageInfo: page(null) } };
      return { ok: true, json: async () => ({ data }) };
    }));
    const changed = await changedProjects(["a", "b", "c"], "2026-11-20T00:00:00Z");
    expect(changed).toEqual(new Map([["a", "2026-11-20T03:00:00.500Z"], ["b", "2026-11-20T02:00:00Z"], ["c", "2026-11-20T04:00:00Z"]]));
    expect(sent).toHaveLength(2);
    expect(sent[0].variables).toMatchObject({ ids: ["a", "b", "c"], t: "2026-11-20T00:00:00Z", d0: "a", d1: "b", d2: "c" });
    expect(sent[0].query).toContain("project:{id:{in:$ids}}");
    // The next page asks only for the issues, from the cursor of the first page.
    expect(sent[1].variables).toMatchObject({ ia: "i2" });
    expect(sent[1].query).not.toContain("comments(");
    expect(sent[1].query).not.toContain("documents(");
  });

  it("treats every project as changed past the last page, and asks nothing for no projects", async () => {
    vi.stubEnv("LINEAR_API_KEY", "test-key");
    let requests = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      requests++;
      const data = { issues: { nodes: [], pageInfo: page(`i${requests}`) }, comments: { nodes: [], pageInfo: page(null) }, d0: { documents: { nodes: [] } } };
      return { ok: true, json: async () => ({ data }) };
    }));
    expect(await changedProjects([], "2026-11-20T00:00:00Z")).toEqual(new Map());
    expect(requests).toBe(0);
    expect(await changedProjects(["a"], "2026-11-20T00:00:00Z")).toBeNull();
    expect(requests).toBe(CHANGED_PAGES);
  });
});

describe("changedSince", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([true, false])("includes a status-only change in the same poll: %s", async (updated) => {
    vi.stubEnv("LINEAR_API_KEY", "test-key");
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const { query, variables } = JSON.parse(init.body as string);
      expect(query).toMatch(/documents\(first:1, filter:\{title:\{eq:"work-graph status"\}, updatedAt:\{gt:\$t\}\}\)/);
      expect(variables.t).toBe("2026-11-20T10:00:00Z");
      return { ok: true, json: async () => ({ data: {
        issues: { nodes: [] }, comments: { nodes: [] },
        project: { documents: { nodes: updated ? [{ id: "doc" }] : [] } },
      } }) };
    });
    vi.stubGlobal("fetch", fetch);
    expect(await changedSince("p", "2026-11-20T10:00:00Z")).toBe(updated);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("loadGraph", () => {
  it.each([null, "r3"])("keeps relation pages and stops at an invalid cursor (%s)", async (lastCursor) => {
    const page = <T>(nodes: T[], endCursor: string | null = null) => ({
      nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor },
    });
    const state = { id: "s", name: "Todo", type: "unstarted", color: "" };
    const ref = (id: string) => ({ id, identifier: id, title: id, url: "u", team: { key: "CD" }, state, project: null });
    const raw = (id: string) => ({
      ...ref(id), description: null, priority: 0, sortOrder: 0, updatedAt: "today",
      team: { id: "relations-test-team", key: "CD" }, assignee: null, labels: { nodes: [] },
      projectMilestone: null, comments: { nodes: [] }, attachments: { nodes: [] },
      relations: page([]), inverseRelations: page([]),
    });
    const outgoing = (id: string) => ({ type: "blocks", relatedIssue: ref(id) });
    const incoming = (id: string) => ({ type: "blocks", issue: ref(id) });
    const calls: Record<string, unknown>[] = [];
    vi.stubEnv("LINEAR_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const { query, variables } = JSON.parse(init.body as string);
      let data;
      if (query.includes("viewer{")) {
        data = { viewer: { id: "me" }, project: { id: "p", name: "Project", url: "u", projectMilestones: { nodes: [] } } };
      } else if (query.includes("project(id:")) {
        data = { project: { issues: page([{
          ...raw("main"), relations: page([outgoing("a")], "r2"), inverseRelations: page([incoming("b")], "i2"),
        }]) } };
      } else if (query.includes("issue(id:")) {
        calls.push(variables);
        expect(calls.length).toBeLessThanOrEqual(3);
        const { id, afterRelations, afterInverseRelations } = variables;
        data = { issue: {
          relations: afterRelations === "r2" ? page([outgoing("c")], "r3")
            : afterRelations === "r3" ? { nodes: [outgoing("d")], pageInfo: { hasNextPage: true, endCursor: lastCursor } } : page([outgoing("a")], "r2"),
          inverseRelations: afterInverseRelations === "i2" ? page([incoming("e")])
            : id === "a" && afterInverseRelations === "outside2" ? page([incoming("f")]) : page([incoming("b")], "i2"),
        } };
      } else if (query.includes("issues(first:25")) {
        data = { issues: { nodes: variables.ids.includes("a") ? [{
          ...raw("a"), inverseRelations: page([incoming("main")], "outside2"),
        }] : [] } };
      } else if (query.includes("members(first")) {
        data = { teams: { nodes: [] } };
      } else {
        data = { issueLabels: page([]) };
      }
      return { ok: true, json: async () => ({ data }) };
    }));

    const { issues } = await loadGraph("p");
    const [main, linked] = issues;
    expect(main.blocks.map((issue) => issue.id)).toEqual(["a", "c", "d"]);
    expect(main.blockedBy.map((issue) => issue.id)).toEqual(["b", "e"]);
    expect(linked.external).toBe(true);
    expect(linked.blockedBy.map((issue) => issue.id)).toEqual(["main", "f"]);
    expect(calls).toHaveLength(3);
  });

  it("reads the archived issues of the project and marks them archived", async () => {
    const page = <T>(nodes: T[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
    const state = { id: "s", name: "Done", type: "completed", color: "" };
    const raw = (id: string, archivedAt: string | null) => ({
      id, identifier: id, title: id, url: "u", state, project: { id: "p" }, description: null, priority: 0, sortOrder: 0,
      updatedAt: "today", archivedAt, team: { id: "t", key: "CD" }, assignee: null, labels: { nodes: [] },
      projectMilestone: null, comments: { nodes: [] }, attachments: { nodes: [] }, relations: page([]), inverseRelations: page([]),
    });
    const issueQueries: string[] = [];
    vi.stubEnv("LINEAR_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const { query } = JSON.parse(init.body as string);
      let data;
      if (query.includes("viewer{")) data = { viewer: { id: "me" }, project: { id: "p", name: "P", url: "u", projectMilestones: { nodes: [] } } };
      else if (query.includes("project(id:")) {
        issueQueries.push(query);
        data = { project: { issues: page([raw("open", null), raw("old", "2026-11-01T00:00:00Z")]) } };
      } else if (query.includes("members(first")) data = { teams: { nodes: [] } };
      else data = { issueLabels: page([]) };
      return { ok: true, json: async () => ({ data }) };
    }));
    const { issues } = await loadGraph("p");
    expect(issueQueries[0]).toContain("includeArchived:true");
    expect(issues.map((i) => [i.identifier, i.archived])).toEqual([["open", false], ["old", true]]);
  });
});

describe("initiativeOf", () => {
  // contract.json is the copy of the file that `wg contract --write` makes; wg load sets labels in this group.
  const contract = JSON.parse(readFileSync(new URL("../skills/work-graph/contract.json", import.meta.url), "utf8")) as { project_labels: { initiative_group: string } };
  it("reads the initiative from the project label group that wg load sets", () => {
    expect(INITIATIVE_GROUP).toBe(contract.project_labels.initiative_group);
    expect(initiativeOf([{ name: "AI", parent: null }, { name: "Tooling", parent: { name: "Initiative" } }])).toBe("Tooling");
    expect(initiativeOf([{ name: "AI", parent: null }])).toBeNull();
    expect(initiativeOf(undefined)).toBeNull();
  });
});

describe("gql retry and limit", () => {
  const sleeps: number[] = [];
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  /** A transport whose fetch gives the answers in order; a function answer is thrown. */
  const answers = (...list: (Response | (() => Error))[]) => {
    const fetch = vi.fn(async () => {
      const next = list.shift();
      if (!next) throw new Error("no more answers");
      if (typeof next === "function") throw next();
      return next;
    });
    setTransport({ fetch, sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5, now: () => 1000 });
    return fetch;
  };
  const ok = () => json({ data: { viewer: { id: "me" } } });
  const rateLimited = () => json({ errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }] }, 400);
  beforeEach(() => { vi.stubEnv("LINEAR_API_KEY", "test-key"); sleeps.length = 0; });
  afterEach(() => setTransport());

  it.each([
    ["a network error", () => new TypeError("fetch failed")],
    ["a timeout", timeout],
    ["HTTP 503", () => json(null, 503)],
  ] as const)("tries a query again after %s, with a longer delay each time", async (_name, failure) => {
    const make = (): Response | (() => Error) => { const f = failure(); return f instanceof Response ? f : () => f; };
    const fetch = answers(make(), make(), ok());
    expect(await gql("query{ viewer{id} }")).toEqual({ viewer: { id: "me" } });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([500, 1000]); // random 0.5: the exponential delay itself
  });

  it.each([
    [429, "90", 90], [400, new Date(91_000).toUTCString(), 90], [400, null, 30],
  ] as const)("holds reads after status %i with Retry-After %s", async (status, header, seconds) => {
    let now = 1000;
    const fetch = vi.fn().mockResolvedValueOnce(json({ errors: [{ message: "Limited",
      extensions: { code: "RATELIMITED" } }] }, status, header ? { "Retry-After": header } : {}))
      .mockImplementation(async () => ok());
    setTransport({ fetch, now: () => now, sleep: async () => {} });
    const read = () => boardRead.run(true, gql, "query{ viewer{id} }");
    await expect(read()).rejects.toMatchObject({ status: 429, retryAfter: String(seconds) });
    now += seconds * 1000 - 1000;
    await Promise.all([read(), read()].map(result => expect(result).rejects.toMatchObject({ retryAfter: "1" })));
    expect(fetch).toHaveBeenCalledTimes(1);
    await linearWorkspace.run({ ...linearWorkspace.getStore()!, key: "other" }, read);
    now += 1000;
    await read();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("can finish an issue edit while board reads wait", async () => {
    const page = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
    const issue = { id: "i", title: "new", team: { key: "WG" }, project: { id: "p" },
      comments: page, labels: page, relations: { ...page, pageInfo: { hasNextPage: true, endCursor: "more" } }, inverseRelations: page };
    const fetch = answers(json(null, 429, { "retry-after": "90" }), json({ data: { issue } }),
      json({ data: { issueUpdate: { success: true, issue } } }), json({ data: { issue: { relations: page } } }));
    const read = () => boardRead.run(true, listProjects, "WG");
    await expect(read()).rejects.toMatchObject({ status: 429 });
    expect(await updateIssue("i", { title: "new" }, "WG")).toMatchObject({ title: "new" });
    await expect(read()).rejects.toMatchObject({ retryAfter: "90" });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("keeps an endpoint limit across OAuth rotation and permits a different operation", async () => {
    const fetch = answers(json(null, 429, { "x-ratelimit-endpoint-requests-remaining": "0", "retry-after": "90" }), ok(), ok());
    let token = "first";
    const connection = { ...linearWorkspace.getStore()!, kind: "oauth" as const, connectionId: "c", oauthKey: async () => token };
    const read = (query: string, workspace = connection) => linearWorkspace.run(workspace, () => boardRead.run(true, gql, query));
    await expect(read("query{viewer{id}}")).rejects.toMatchObject({ endpointOnly: true });
    token = "second";
    await expect(read("query{viewer{id}}")).rejects.toMatchObject({ retryAfter: "90" });
    await read("query{teams{nodes{id}}}");
    token = "first";
    await expect(read("query{viewer{id}}", { ...connection, connectionId: "other" })).rejects.toMatchObject({ retryAfter: "90" });
    token = "independent";
    await read("query{viewer{id}}", { ...connection, connectionId: "other" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([{}, { "retry-after": "20" }] as Record<string, string>[])("uses the latest exhausted budget reset", async extra => {
    const response = json({ errors: [{ message: "Limit", extensions: { code: "RATELIMITED" } }] }, 400, {
      "x-ratelimit-requests-remaining": "0", "x-ratelimit-requests-reset": "91000",
      "x-ratelimit-endpoint-complexity-remaining": "0", "x-ratelimit-endpoint-complexity-reset": "181000",
      "x-ratelimit-complexity-remaining": "5", "x-ratelimit-complexity-reset": "601000", ...extra,
    });
    answers(response);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(boardRead.run(true, gql, "query{ viewer{id} }")).rejects.toMatchObject({
        status: 429, retryAfter: "180", globalDeadline: 91_000,
      });
    }
  });

  it("stops after three tries and gives the last error", async () => {
    const fetch = answers(json(null, 502), json(null, 502), json(null, 502), ok());
    await expect(gql("query{ viewer{id} }")).rejects.toThrow("Linear: HTTP 502");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not try a query again after a GraphQL error that is not a rate limit", async () => {
    const fetch = answers(json({ errors: [{ message: "Entity not found" }] }, 400), ok());
    await expect(gql("query{ viewer{id} }")).rejects.toThrow("Linear: Entity not found");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a timeout", timeout],
    ["a network error", () => new TypeError("fetch failed")],
  ])("does not send a mutation again after %s: Linear can have applied it", async (_name, failure) => {
    const fetch = answers(failure, ok());
    await expect(gql("mutation{ issueUpdate(id:\"i\",input:{}){ success } }")).rejects.toThrow("Linear request failed");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not send a mutation again after HTTP 500", async () => {
    const fetch = answers(json(null, 500), ok());
    await expect(gql("  mutation($i:X){ a }")).rejects.toThrow("HTTP 500");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("sends a mutation again after HTTP 429 or RATELIMITED, and waits as long as Retry-After asks", async () => {
    const fetch = answers(json(null, 429, { "retry-after": "3" }), rateLimited(), ok());
    expect(await gql("mutation{ a }")).toEqual({ viewer: { id: "me" } });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([3000, 1000]);
  });

  it.each([
    ["a timeout", () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })],
    ["a dropped connection", () => new TypeError("terminated")],
  ])("tries a query again after %s while the body of an HTTP 200 arrives", async (_name, failure) => {
    // The headers arrive; the stream of the body then fails, as it does when the connection drops.
    const broken = () => new Response(new ReadableStream({ start(c) { c.error(failure()); } }), { status: 200 });
    const fetch = answers(broken(), ok());
    expect(await gql("query{ viewer{id} }")).toEqual({ viewer: { id: "me" } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not send a mutation again when its body times out: Linear can have applied it", async () => {
    const fetch = answers(new Response(new ReadableStream({ start(c) { c.error(timeout()); } }), { status: 200 }), ok());
    await expect(gql("mutation{ a }")).rejects.toThrow("Linear request failed");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("sends a mutation again after HTTP 429 whose body times out, after the delay that Retry-After asks", async () => {
    const limited = new Response(new ReadableStream({ start(c) { c.error(timeout()); } }), { status: 429, headers: { "retry-after": "3" } });
    const fetch = answers(limited, ok());
    expect(await gql("mutation{ a }")).toEqual({ viewer: { id: "me" } });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([3000]);
  });

  it("does not try again after an answer that is not JSON", async () => {
    const fetch = answers(new Response("<html>", { status: 200 }), ok());
    await expect(gql("query{ viewer{id} }")).rejects.toThrow("Linear: HTTP 200");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    "# write\nmutation{ a }",
    "\uFEFF, \n  # one\n  # two\r\n\tmutation Named($i:X){ a }",
  ])("knows a mutation after ignored tokens and does not send it again after a timeout: %j", async (query) => {
    expect(isMutation(query)).toBe(true);
    const fetch = answers(timeout, ok());
    await expect(gql(query)).rejects.toThrow("Linear request failed");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("knows a mutation that comes after a fragment, and does not send it again after a timeout", async () => {
    const query = "fragment F on Issue { id }\nmutation($i:X){ issueUpdate(input:$i){ issue{ ...F } } }";
    expect(isMutation(query)).toBe(true);
    expect(isMutation("query Q { a }\nmutation { b }")).toBe(true);
    const fetch = answers(timeout, ok());
    await expect(gql(query)).rejects.toThrow("Linear request failed");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not take a fragment, a name, a variable, or a string that is called mutation for a mutation", () => {
    expect(isMutation("fragment mutation on Mutation { id }\nquery { a { ...mutation } }")).toBe(false);
    expect(isMutation("query mutation($mutation: String = \"mutation\") @mutation { a }")).toBe(false);
    expect(isMutation('query { a(t: """\nmutation\n""") }')).toBe(false);
  });

  it("does not take a query that names a mutation in a comment or a field for a mutation", () => {
    expect(isMutation("# mutation\nquery{ a }")).toBe(false);
    expect(isMutation("{ mutationLog }")).toBe(false);
    expect(isMutation("query{ a }")).toBe(false);
  });

  it("waits at least as long as Retry-After asks, and stops when it asks for longer than the server waits", async () => {
    const fetch = answers(json(null, 429, { "retry-after": "30" }), ok()); // also sets random to 0.5
    expect(delay(1, "8")).toBe(8000);
    expect(delay(1, null)).toBe(500);
    expect(delay(9, null)).toBe(10_000); // the exponential delay is capped
    expect(delay(1, "30")).toBeNull();
    await expect(gql("query{ viewer{id} }")).rejects.toThrow("Linear rate limit");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it("runs at most six requests at the same time, also while 20 are asked for", async () => {
    let active = 0;
    let most = 0;
    const release: (() => void)[] = [];
    setTransport({
      fetch: async () => {
        active++;
        most = Math.max(most, active);
        await new Promise<void>((go) => release.push(go));
        active--;
        return ok();
      },
    });
    let done = false;
    const all = Promise.all(Array.from({ length: 20 }, () => gql("query{ viewer{id} }"))).finally(() => { done = true; });
    // Each round lets the waiting requests start, then ends the ones that run.
    for (let round = 0; round < 50 && !done; round++) {
      await new Promise((r) => setTimeout(r, 0));
      release.splice(0).forEach((go) => go());
    }
    const results = await all;
    expect(results).toHaveLength(20);
    expect(MAX_PARALLEL).toBe(6);
    expect(most).toBe(6);
  });

  it("keeps the rate-limit values of the last response", async () => {
    answers(json({ data: {} }, 200, {
      "x-ratelimit-requests-remaining": "4990", "x-ratelimit-requests-limit": "5000", "x-ratelimit-requests-reset": "1700000000000",
      "x-ratelimit-complexity-remaining": "2999000", "x-ratelimit-complexity-limit": "3000000",
    }));
    await gql("query{ viewer{id} }");
    expect(linearBudget("default")).toEqual({
      requestsRemaining: 4990, requestsLimit: 5000, requestsReset: 1700000000000,
      complexityRemaining: 2999000, complexityLimit: 3000000, complexityReset: null, at: 1000,
    });
  });
});

describe("mapLimit", () => {
  it("keeps the order and runs at most the given number at the same time", async () => {
    let active = 0;
    let most = 0;
    const out = await mapLimit([5, 1, 3, 2, 4, 0, 6], 3, async (n) => {
      active++;
      most = Math.max(most, active);
      await new Promise((r) => setTimeout(r, n));
      active--;
      return n * 2;
    });
    expect(out).toEqual([10, 2, 6, 4, 8, 0, 12]);
    expect(most).toBe(3);
  });
});

describe("addComment", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("refuses with 502 when Linear saves no comment", async () => {
    vi.stubEnv("LINEAR_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const { query } = JSON.parse(init.body as string);
      const data = query.includes("commentCreate")
        ? { commentCreate: { success: false, comment: null } }
        : { issue: { team: { key: "TM" }, project: null, description: "", labels: { nodes: [] }, comments: { nodes: [] } } };
      return { ok: true, json: async () => ({ data }) };
    }));
    const error = await addComment("i1", "hi", "TM").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LinearError);
    expect(error).toMatchObject({ status: 502, message: "Linear did not save the comment" });
  });

  it("refuses a comment or an edit on an archived issue before any write", async () => {
    vi.stubEnv("LINEAR_API_KEY", "test-key");
    const queries: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const { query } = JSON.parse(init.body as string);
      queries.push(query);
      const data = { issue: { team: { key: "TM" }, project: null, archivedAt: "2026-11-01T00:00:00Z", description: "",
        labels: { nodes: [] }, comments: { nodes: [] } } };
      return { ok: true, json: async () => ({ data }) };
    }));
    await expect(addComment("i1", "hi", "TM")).rejects.toMatchObject({ status: 403, message: "this issue is archived: it is read-only here" });
    await expect(updateIssue("i1", { priority: 2 }, "TM")).rejects.toMatchObject({ status: 403 });
    expect(queries.some((q) => q.includes("mutation"))).toBe(false);
  });
});
