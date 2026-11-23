import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { INITIATIVE_GROUP, addReviewUrls, changedSince, initiativeOf, loadGraph, pullRequestsOf } from "./linear.ts";

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
