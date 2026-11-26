import { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "../../server/app.ts";
import { setTransport } from "../../server/linear.ts";
import { createSite, statusOrder } from "../../src/lib/site.ts";
import contract from "../../skills/work-graph/contract.json" with { type: "json" };
import { pagePort } from "./ports.ts";

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
      return data({ teams: { nodes: [{ projects: { nodes: projects, pageInfo } }] } });
    }
    if (query.includes("teams(first:10")) {
      return data({ teams: { nodes: [{ ...team, states: { nodes: states }, members: empty }] } });
    }
    if (query.includes("issueLabels(")) return data({ issueLabels: empty });
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

const app = createApp({ port: pagePort, tailnet: null }, {
  team: team.key, human: "Ada", dist: fileURLToPath(new URL("../../dist/", import.meta.url)),
  watchMs: 0, telemetryEnv: {}, readOnly: false,
  workspaces: [{ id: "default", name: "Example", team: team.key, key: "fixture", teamLabels: false }],
});
const server = serve({ port: pagePort, hostname: "127.0.0.1", fetch: app.fetch });
if (server instanceof Server) app.injectWebSocket(server);
