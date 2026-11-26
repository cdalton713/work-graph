import { serializeSigned } from "hono/utils/cookie";
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

const canvasProject = { ...project, id: "canvas", name: "Graph example", url: "https://example.com/graph" };
projects.push(canvasProject);
const canvasPhases = [
  { id: "finished", name: "Finished phase", description: "", sortOrder: 0 },
  { id: "current", name: "Current phase", description: "", sortOrder: 1 },
];
const canvasIssues = Array.from({ length: 16 }, (_, order) => {
  const id = order + 21;
  const active = order === 14 || order === 15;
  return {
    ...issues[0], id: `issue-${id}`, identifier: `WG-${id}`, title: `Graph issue ${id}`,
    url: `https://example.com/issue/${id}`, project: canvasProject, sortOrder: order,
    state: states.find(({ name }) => name === (active ? "In Progress" : "Done"))!,
    projectMilestone: canvasPhases[active ? 1 : 0],
    comments: { nodes: [{
      id: `card-${id}`, createdAt: updatedAt, user: null,
      body: `**work-graph node card**\n\n\`\`\`json\n${JSON.stringify({
        wg: 1, key: `graph-${id}`, kind: "task", lane: "Build", ...(active && { wave: "yes" }),
      })}\n\`\`\``,
    }], pageInfo },
  };
});
for (let order = 1; order < canvasIssues.length; order++) {
  const { id, identifier, title, url, team, state } = canvasIssues[order - 1];
  canvasIssues[order] = {
    ...canvasIssues[order],
    inverseRelations: { nodes: [{ type: "blocks", issue: { id, identifier, title, url, team, state, project: canvasProject } }], pageInfo },
  };
}

// Starter writes go to this in-memory Linear fixture. The directory deliberately lags the graph.
const starterProjects = new Map<string, typeof project>();
const starterIssues = new Map<string, typeof issues[number]>();
const starterPhases = new Map<string, typeof canvasPhases[number]>();
// Keep the real page API and graph loader. Only the upstream data comes from the fixture.
setTransport({
  async fetch(_url, init) {
    const { query, variables } = JSON.parse(String(init.body));
    const data = (value: object) => Response.json({ data: value });
    if (query.includes("StarterTeam")) {
      return data({ organization: { id: "org" }, viewer: { id: "ada", teams: { nodes: [
        { ...team, name: "Build", states: { nodes: states } },
      ] } } });
    }
    if (query.includes("Create(input:$input)")) {
      const input = variables.input;
      let identifier;
      if (query.includes("projectCreate(")) starterProjects.set(input.id, { ...project, id: input.id, name: input.name });
      if (query.includes("projectMilestoneCreate(")) starterPhases.set(input.projectId, { ...canvasPhases[0], ...input });
      if (query.includes("issueCreate(")) {
        identifier = starterIssues.get(input.id)?.identifier ?? "WG-" + (100 + starterIssues.size);
        starterIssues.set(input.id, { ...issues[0], ...input, project: starterProjects.get(input.projectId),
          state: states.find(s => s.id === input.stateId), identifier, comments: { nodes: [], pageInfo },
          projectMilestone: starterPhases.get(input.projectId) });
      }
      if (query.includes("commentCreate(")) starterIssues.get(input.issueId)!.comments.nodes = [
        { ...issues[0].comments.nodes[0], id: input.id, body: input.body },
      ];
      if (query.includes("issueRelationCreate(")) {
        const blocked = starterIssues.get(input.relatedIssueId)!;
        const blocker = starterIssues.get(input.issueId)!;
        Object.assign(blocked, { inverseRelations: { nodes: [{ type: "blocks", issue: blocker }], pageInfo } });
      }
      return data({ result: { success: true, object: { ...input, url: project.url, identifier, teams: { nodes: [team] },
        team, project: { id: input.projectId }, issue: { id: input.issueId }, relatedIssue: { id: input.relatedIssueId } } } });
    }
    if (query.includes("project(id:") && starterProjects.has(variables.id)) return data({
      viewer: { id: "ada" }, project: { ...starterProjects.get(variables.id), documents: empty,
        projectMilestones: { nodes: [starterPhases.get(variables.id)], pageInfo },
        issues: { nodes: [...starterIssues.values()].filter(i => i.project.id === variables.id), pageInfo } },
    });
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
      if (variables.id === canvasProject.id) {
        return data({ viewer: { id: "ada" }, project: { ...canvasProject,
          projectMilestones: { nodes: canvasPhases }, documents: empty,
          issues: { nodes: canvasIssues, pageInfo },
        } });
      }
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
const fixtureHost = "starter.example.com";
const owner = "owner@example.com";
const secret = "fixture-only-session-secret-for-local-tests";
process.env.WG_CREATE_PROJECTS = "1";
const starterApp = createApp({ port: 443, tailnet: null, hosted: { host: fixtureHost } }, {
  team: team.key, human: "Ada", dist: "/unused/", watchMs: 0, readOnly: false, telemetryEnv: {},
  auth: { domains: ["example.com"], owners: [owner], clientId: "fixture", clientSecret: "fixture", secret },
  linkToken: "fixture-coordinator-token-with-32-characters",
  workspaces: [{ id: "work", name: "Workspace", team: team.key, key: "fixture", teamLabels: false }],
});
const session = Buffer.from(JSON.stringify({ email: owner, hd: "example.com", exp: Date.now() / 1000 + 3600 })).toString("base64url");
const cookie = (await serializeSigned("__Host-wg_session", session, secret, { secure: true, path: "/" })).split(";")[0];
const server = serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
  if (!request.headers.has("x-starter-fixture") || !new URL(request.url).pathname.startsWith("/api/")) return app.fetch(request);
  const headers = new Headers(request.headers);
  headers.set("host", fixtureHost);
  headers.set("origin", "https://" + fixtureHost);
  headers.set("cookie", cookie);
  return starterApp.fetch(new Request(request, { headers }));
} }, ({ port }) => {
  rules.port = port;
  console.log(`Page fixture at http://127.0.0.1:${port}/`);
});
if (server instanceof Server) app.injectWebSocket(server);
if (server instanceof Server) {
  // The same socket keeps this listener when HTTP upgrades to WebSocket.
  server.on("connection", (socket) => {
    socket.on("error", (error: NodeJS.ErrnoException) => {
      console.warn(`Page fixture socket error: ${error.code ?? error.name}`);
    });
  });
  // A parser error can occur before a request exists. Close only its socket.
  server.on("clientError", (error, socket) => socket.destroy(error));
}
