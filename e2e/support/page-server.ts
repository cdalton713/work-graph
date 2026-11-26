import { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "../../server/app.ts";
import { setTransport } from "../../server/linear.ts";
import { createSite, statusOrder } from "../../src/lib/site.ts";
import contract from "../../skills/work-graph/contract.json" with { type: "json" };

const team = { id: "team", key: "WG" };
const pageInfo = { hasNextPage: false, endCursor: null };
const empty = { nodes: [], pageInfo };
const project = {
  id: "fixture", name: "Example project", url: "https://example.com/project",
  status: { name: "In progress", type: "started" },
};
const projects = [project, {
  ...project, id: "planned", name: "Planned project", url: "https://example.com/planned",
  status: { name: "Planned", type: "planned" },
}];
const updatedAt = "2026-01-01T00:00:00Z";
const stateTypes = [
  "triage", "backlog", "unstarted", "unstarted", "started", "started",
  "started", "started", "started", "started", "completed", "canceled",
];
const states = statusOrder(createSite("Ada", "default")).map((name, position) => ({
  id: `state-${position}`, name, position, type: stateTypes[position], color: "#4466aa",
}));
const issues = states.map((state, order) => {
  const id = order + 1;
  return {
    id: `issue-${id}`, identifier: `WG-${id}`, title: `Example issue ${id}`,
    description: "Check the result and record the evidence.", priority: 0, sortOrder: order,
    url: `https://example.com/issue/${id}`, updatedAt, project, team, state, assignee: null,
    labels: empty, relations: empty, inverseRelations: empty, attachments: empty,
    comments: { nodes: [{
      id: `card-${id}`, createdAt: updatedAt, user: null,
      body: `**work-graph node card**\n\n\`\`\`json\n${JSON.stringify({
        wg: 1, key: `example-${id}`, kind: contract.kinds[order % contract.kinds.length],
      })}\n\`\`\``,
    }], pageInfo },
  };
});

// Keep the real page API and graph loader. Only the upstream data comes from the fixture.
setTransport({
  async fetch(_url, init) {
    const { query, variables } = JSON.parse(String(init.body));
    const data = (value: object) => Response.json({ data: value });
    if (query.includes("projects(first:50")) {
      return data({ teams: { nodes: [{ projects: { nodes: [...projects, panelProject], pageInfo } }] } });
    }
    if (query.includes("teams(first:10")) {
      return data({ teams: { nodes: [{ ...team, states: { nodes: states }, members: empty }] } });
    }
    if (query.includes("issueLabels(")) return data({ issueLabels: empty });
    if (query.includes("project(id:") && variables.id === panelProject.id) return data({
      viewer: { id: "ada" },
      project: { ...panelProject, projectMilestones: empty, documents: empty,
        issues: { nodes: panelIssues, pageInfo } },
    });
    if (query.includes("issue(id:") && variables.id === panelIssue.id) {
      return data({ issue: { project: panelProject, comments: { nodes: [{
        id: "panel-comment", createdAt: updatedAt, user: { name: "Ada" }, body: panelMarkdown,
      }], pageInfo } } });
    }
    if (query.includes("issue(id:")) {
      return data({ issue: { project, comments: empty } });
    }
    if (query.includes("project(id:")) {
      const entry = projects.find(({ id }) => id === variables.id);
      return data({
        viewer: { id: "ada" },
        project: entry && { ...entry, projectMilestones: empty, documents: empty,
          issues: { nodes: entry === project ? issues : [], pageInfo } },
      });
    }
    throw new Error(`Unhandled fixture query: ${query}`);
  },
  sleep: async () => {},
});

const panelProject = { ...project, id: "panel", name: "Panel project", url: "https://example.com/panel" };
const wideLine = "long-value-".repeat(28);
const panelMarkdown = `\`\`\`text
${wideLine}
\`\`\`

| First column | Second column |
| --- | --- |
| ${wideLine} | ${wideLine} |
`;
const blocker = {
  ...issues[2], project: panelProject, id: "panel-blocker", identifier: "WG-13",
  title: `Blocker ${wideLine}`, sortOrder: 12,
};
const panelIssue = {
  ...issues[5], project: panelProject, id: "panel-task", identifier: "WG-14",
  state: states[4],
  title: "Panel actions", sortOrder: 13, description: panelMarkdown,
  labels: { nodes: [{ id: "worker", name: "agent:worker", color: "#4466aa" }], pageInfo },
  inverseRelations: { nodes: [{ type: "blocks", issue: blocker }], pageInfo },
  comments: { nodes: [{
    id: "panel-card", createdAt: updatedAt, user: null, body: `**work-graph node card**

\`\`\`json
${JSON.stringify({
      wg: 1, key: "panel-task", kind: "task", branch: `cd/${wideLine}`,
      wave: "yes", soak_until: "2099-01-01T00:00:00Z", job: "build",
      next: `do dispatch ${wideLine}`, pr: "42",
    })}
\`\`\``,
  }], pageInfo },
};
const panelIssues = [blocker, panelIssue, {
  ...issues[5], project: panelProject, id: "panel-ops", identifier: "WG-15", title: "Check the rollout", sortOrder: 14,
  state: states[4],
  comments: { nodes: [{
    id: "panel-ops-card", createdAt: updatedAt, user: null,
    body: "**work-graph node card**\n\n\`\`\`json\n{\"wg\":1,\"key\":\"panel-ops\",\"kind\":\"ops\"}\n\`\`\`",
  }], pageInfo },
}];

const rules = { port: 0, tailnet: null };
const app = createApp(rules, {
  team: team.key, human: "Ada", dist: fileURLToPath(new URL("../../dist/", import.meta.url)),
  watchMs: 0, telemetryEnv: {}, readOnly: false,
  workspaces: [{ id: "default", name: "Example", team: team.key, key: "fixture", teamLabels: false }],
});
const server = serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch }, ({ port }) => {
  rules.port = port;
  console.log(`Page fixture at http://127.0.0.1:${port}/`);
});
if (server instanceof Server) app.injectWebSocket(server);
