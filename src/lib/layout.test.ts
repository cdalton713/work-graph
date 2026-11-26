import { describe, expect, it } from "vitest";
import { buildGraph, reduceEdges } from "./graph";
import { EDGE_TAP_REACH, NODE_H, NODE_W, arrow, layout, roundedPath, routeAt } from "./layout";
import type { GraphData, Issue, Milestone } from "./types";

const card = (lane: string) => ({ id: "c", body: `**work-graph node card** \`k\`\n\n\`\`\`json\n${JSON.stringify({ wg: 1, lane })}\n\`\`\`` });
function issue(id: string, milestoneId: string | null, sortOrder: number, lane?: string): Issue {
  return {
    id, identifier: id, title: id, description: "", priority: 0, url: "", sortOrder, updatedAt: "", teamId: "t", teamKey: "CD",
    state: { id: "s", name: "Todo", type: "unstarted", color: "" }, assignee: null, labels: [], milestoneId,
    blocks: [], blockedBy: [], card: lane ? card(lane) : null, external: false, pullRequests: [],
  };
}
const milestones: Milestone[] = [{ id: "p1", name: "Phase 1", sortOrder: 1, description: null }, { id: "p2", name: "Phase 2", sortOrder: 2, description: null }];

// Two lanes in phase 1 that join at a merge point, then a chain in phase 2, and one node with no phase.
function sample() {
  const issues = [
    issue("a1", "p1", 1, "a"), issue("a2", "p1", 2, "a"), issue("b1", "p1", 3, "b"), issue("b2", "p1", 4, "b"),
    issue("mp", "p1", 5), issue("ship", "p1", 6), issue("x", "p2", 7), issue("y", "p2", 8), issue("free", null, 0),
  ];
  const pairs = [["a1", "a2"], ["b1", "b2"], ["a1", "mp"], ["a2", "mp"], ["b1", "mp"], ["b2", "mp"], ["mp", "ship"], ["ship", "x"], ["x", "y"], ["ship", "y"]];
  const byId = new Map(issues.map((i) => [i.id, i]));
  for (const [from, to] of pairs) byId.get(from)!.blocks.push({ id: to, identifier: to, title: to, url: "", teamKey: "CD", state: byId.get(to)!.state, inProject: true });
  const data: GraphData = { project: { id: "p", name: "P", url: "" }, milestones, issues, teams: {}, labels: [], viewerId: "", status: null };
  return buildGraph(data);
}
const overlaps = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) < NODE_W && Math.abs(a.y - b.y) < NODE_H;

describe("layout", () => {
  it("places every node with no overlap and each blocker above the node it blocks", async () => {
    const graph = sample();
    const edges = reduceEdges(graph);
    const result = await layout(graph.nodes, edges, milestones);
    const placed = [...result.positions];
    expect(placed).toHaveLength(graph.nodes.length);
    for (const [i, [, a]] of placed.entries()) for (const [, b] of placed.slice(i + 1)) expect(overlaps(a, b)).toBe(false);
    for (const e of edges) expect(result.positions.get(e.from)!.y + NODE_H).toBeLessThanOrEqual(result.positions.get(e.to)!.y);
  });
  it("keeps the nodes of a phase and of a lane inside their boxes", async () => {
    const graph = sample();
    const result = await layout(graph.nodes, reduceEdges(graph), milestones);
    const inside = (id: string, boxId: string) => {
      const p = result.positions.get(id)!, b = result.boxes.find((x) => x.id === boxId)!;
      return p.x >= b.x && p.y >= b.y && p.x + NODE_W <= b.x + b.width && p.y + NODE_H <= b.y + b.height;
    };
    expect(result.boxes.map((b) => b.id).sort()).toEqual(["lane:p1:a", "lane:p1:b", "loose", "phase:p1", "phase:p2"]);
    expect(inside("free", "loose")).toBe(true);
    expect(["a1", "a2", "mp", "ship"].every((id) => inside(id, "phase:p1"))).toBe(true);
    expect(inside("a1", "lane:p1:a") && inside("a2", "lane:p1:a") && inside("b2", "lane:p1:b")).toBe(true);
    expect(inside("x", "phase:p2") && !inside("free", "phase:p1") && !inside("mp", "lane:p1:a")).toBe(true);
    expect([...result.boxed].sort()).toEqual(["a1", "a2", "b1", "b2"]);
  });
  it("routes each edge at right angles from its blocker to its target, also across phases", async () => {
    const graph = sample();
    const edges = reduceEdges(graph);
    const result = await layout(graph.nodes, edges, milestones);
    for (const e of edges) {
      const route = result.routes.get(e.id)!, from = result.positions.get(e.from)!, to = result.positions.get(e.to)!;
      const first = route[0], last = route[route.length - 1];
      expect(Math.abs(first.y - (from.y + NODE_H))).toBeLessThan(1);
      expect(first.x).toBeGreaterThanOrEqual(from.x);
      expect(first.x).toBeLessThanOrEqual(from.x + NODE_W);
      expect(Math.abs(last.y - to.y)).toBeLessThan(1);
      expect(last.x).toBeGreaterThanOrEqual(to.x);
      expect(last.x).toBeLessThanOrEqual(to.x + NODE_W);
      for (let i = 1; i < route.length; i++) expect(Math.min(Math.abs(route[i].x - route[i - 1].x), Math.abs(route[i].y - route[i - 1].y))).toBeLessThan(0.5);
    }
  });
});

describe("roundedPath", () => {
  it("draws a straight line for two points and a curve at a corner", () => {
    expect(roundedPath([{ x: 0, y: 0 }, { x: 0, y: 50 }])).toBe("M0,0 L0,50");
    expect(roundedPath([{ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 40, y: 50 }], 10)).toBe("M0,0 L0,40 Q0,50 10,50 L40,50");
  });
  it("makes the curve smaller when a segment is short", () => {
    expect(roundedPath([{ x: 0, y: 0 }, { x: 0, y: 8 }, { x: 40, y: 8 }], 10)).toBe("M0,0 L0,4 Q0,8 4,8 L40,8");
  });
});

describe("arrow", () => {
  it("cuts the route at its end and fills the cut with a head that points down", () => {
    expect(arrow([{ x: 0, y: 0 }, { x: 0, y: 50 }], 8, 8)).toEqual({ shaft: [{ x: 0, y: 0 }, { x: 0, y: 42 }], head: "M0,50 L-4,42 L4,42 Z" });
  });
  it("points the head along the last segment of the route", () => {
    const { shaft, head } = arrow([{ x: 0, y: 0 }, { x: 0, y: 20 }, { x: 50, y: 20 }], 8, 8);
    expect(shaft).toEqual([{ x: 0, y: 0 }, { x: 0, y: 20 }, { x: 42, y: 20 }]);
    expect(head).toBe("M50,20 L42,24 L42,16 Z");
  });
  it("keeps a last segment that is shorter than the head", () => {
    const points = [{ x: 0, y: 0 }, { x: 0, y: 5 }];
    expect(arrow(points, 8, 8).shaft).toEqual(points);
    expect(arrow(points, 8, 8).head).toBe("M0,5 L-4,-3 L4,-3 Z");
  });
  it("draws no head for a route with no length", () => {
    expect(arrow([{ x: 3, y: 3 }]).head).toBe("");
    expect(arrow([{ x: 3, y: 3 }, { x: 3, y: 3 }]).head).toBe("");
  });
});

describe("routeAt", () => {
  // "a" goes down and then right. "b" goes down, 30 to the right of the first part of "a".
  const routes = new Map([
    ["a", [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 80, y: 100 }]],
    ["b", [{ x: 30, y: 0 }, { x: 30, y: 60 }]],
  ]);
  it("gives the route that is within reach of the point, on each of its segments", () => {
    expect(routeAt(routes, { x: 4, y: 50 }, 6)).toBe("a");
    expect(routeAt(routes, { x: 60, y: 95 }, 6)).toBe("a");
    expect(routeAt(routes, { x: 27, y: 10 }, 6)).toBe("b");
  });
  it("gives the nearer route when two are within reach", () => {
    expect(routeAt(routes, { x: 12, y: 30 }, 20)).toBe("a");
    expect(routeAt(routes, { x: 18, y: 30 }, 20)).toBe("b");
  });
  it("includes taps 12 screen pixels from a route at double zoom", () => {
    const reach = EDGE_TAP_REACH / 2;
    expect(routeAt(routes, { x: 6, y: 50 }, reach)).toBe("a");
    expect(routeAt(routes, { x: 6.5, y: 50 }, reach)).toBeNull();
  });
  it("gives nothing when no route is within reach, also past the end of a route", () => {
    expect(routeAt(routes, { x: 15, y: 30 }, 6)).toBeNull();
    expect(routeAt(routes, { x: 30, y: 75 }, 6)).toBeNull();
    expect(routeAt(new Map(), { x: 0, y: 0 }, 6)).toBeNull();
  });
});
