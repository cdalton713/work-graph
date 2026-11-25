import { expect, it } from "vitest";
import { statusName } from "../src/lib/graph.ts";
import { summarize, summaryKey } from "../src/lib/overview.ts";
import { createSite, currentSite } from "../src/lib/site.ts";
import type { GraphData, Issue } from "../src/lib/types.ts";
import { requestSite } from "./site.ts";

it("uses the site of each async context in the shared rules", async () => {
  const issue: Issue = {
    id: "i1", identifier: "WG-1", title: "Question", description: "", priority: 0, url: "", sortOrder: 0,
    updatedAt: "2026-11-25", teamId: "team", teamKey: "WG",
    state: { id: "started", name: "In Progress", type: "started", color: "" },
    labels: [
      { id: "a", name: "needs-ada", color: "", group: null },
      { id: "g", name: "needs-grace", color: "", group: null },
    ],
    assignee: null, milestoneId: null, blocks: [], blockedBy: [], card: null, external: false, pullRequests: [],
  };
  const graph: GraphData = {
    project: { id: "p1", name: "Project", url: "" }, issues: [issue],
    milestones: [], teams: {}, labels: [], viewerId: "me", status: null,
  };
  const ada = createSite("Ada", "ada");
  const grace = createSite("Grace", "grace");
  const read = () => ({
    status: statusName(issue.state, issue.labels),
    label: currentSite().waitLabel,
    waits: summarize(graph, currentSite().defaultWorkspace).you.map(({ why }) => why),
    key: summaryKey(graph.project),
  });
  const first = requestSite.run(ada, async () => {
    const before = read();
    await Promise.resolve();
    return [before, read()];
  });
  const second = requestSite.run(grace, async () => {
    await Promise.resolve();
    return read();
  });
  const expectedAda = { status: "Needs Ada", label: "needs-ada", waits: ["Needs Ada"], key: "ada:p1" };
  expect(await first).toEqual([expectedAda, expectedAda]);
  expect(await second).toEqual({ status: "Needs Grace", label: "needs-grace", waits: ["Needs Grace"], key: "grace:p1" });
  expect(currentSite().human).toBe("Human");
});
