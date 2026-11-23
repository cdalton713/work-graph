import ELK, { type ElkExtendedEdge, type ElkNode } from "elkjs/lib/elk.bundled.js";
import type { GEdge, GNode } from "./graph";
import type { Milestone } from "./types";

export const NODE_W = 264;
export const NODE_H = 72;

export type Point = { x: number; y: number };
export interface Box { id: string; kind: "phase" | "lane"; label: string; note: string; x: number; y: number; width: number; height: number }
export interface Layout { positions: Map<string, Point>; boxes: Box[]; routes: Map<string, Point[]>; boxed: Set<string> }

const elk = new ELK();
const PHASE_PAD = "[top=44,left=24,bottom=24,right=24]";
const LANE_PAD = "[top=30,left=14,bottom=14,right=14]";

/**
 * One layered layout for the whole graph. The work flows from top to bottom with no wrap, so each
 * edge points down. (Left to right makes a long chain one thin strip that is too small to read.) ELK routes each edge at right angles around the nodes; the result
 * holds those routes, and the canvas draws them as they are.
 * A phase is a box. A lane with two or more nodes is a box inside its phase.
 */
export async function layout(nodes: GNode[], edges: GEdge[], milestones: Milestone[]): Promise<Layout> {
  const laneSize = new Map<string, number>();
  const laneId = (n: GNode) => `lane:${n.phaseId}:${n.lane}`;
  for (const n of nodes) if (n.phaseId && n.lane) laneSize.set(laneId(n), (laneSize.get(laneId(n)) ?? 0) + 1);

  const phases = new Map<string, ElkNode>(milestones.map((m) => [m.id, { id: `phase:${m.id}`, children: [], layoutOptions: { "elk.padding": PHASE_PAD } }]));
  const lanes = new Map<string, ElkNode>();
  const root: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered", "elk.direction": "DOWN",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN", "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.spacing.nodeNodeBetweenLayers": "52", "elk.spacing.nodeNode": "28",
      "elk.spacing.edgeNode": "26", "elk.spacing.edgeEdge": "18",
      "elk.layered.spacing.edgeNodeBetweenLayers": "20", "elk.layered.spacing.edgeEdgeBetweenLayers": "16",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX", "elk.layered.layering.strategy": "LONGEST_PATH_SOURCE", "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.mergeEdges": "false", "elk.spacing.componentComponent": "40",
    },
    children: [],
    edges: edges.map((e): ElkExtendedEdge => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  };
  const boxed = new Set<string>();
  // A node with no phase and no edge has no place in the flow. ELK would put it anywhere, so these
  // go in their own box beside the graph.
  const linked = new Set(edges.flatMap((e) => [e.from, e.to]));
  const ordered = [...nodes].sort((a, b) => a.issue.sortOrder - b.issue.sortOrder);
  const loose = ordered.filter((n) => !(n.phaseId && phases.has(n.phaseId)) && !linked.has(n.id));
  for (const n of ordered.filter((n) => !loose.includes(n))) {
    const leaf: ElkNode = { id: n.id, width: NODE_W, height: NODE_H };
    const phase = n.phaseId ? phases.get(n.phaseId) : undefined;
    if (!phase) root.children!.push(leaf);
    else if (!n.lane || laneSize.get(laneId(n))! < 2) phase.children!.push(leaf);
    else {
      if (!lanes.has(laneId(n))) {
        lanes.set(laneId(n), { id: laneId(n), children: [], layoutOptions: { "elk.padding": LANE_PAD } });
        phase.children!.push(lanes.get(laneId(n))!);
      }
      lanes.get(laneId(n))!.children!.push(leaf);
      boxed.add(n.id);
    }
  }
  for (const m of milestones) if (phases.get(m.id)!.children!.length) root.children!.push(phases.get(m.id)!);

  const done = await elk.layout(root);
  const positions = new Map<string, Point>();
  const boxes: Box[] = [];
  const origin = new Map<string, Point>([["root", { x: 0, y: 0 }]]);
  const names = new Map(milestones.map((m) => [`phase:${m.id}`, m]));
  const found: ElkExtendedEdge[] = [];
  const walk = (node: ElkNode, at: Point) => {
    found.push(...(node.edges ?? []));
    for (const child of node.children ?? []) {
      const here = { x: at.x + (child.x ?? 0), y: at.y + (child.y ?? 0) };
      if (!child.children) {
        positions.set(child.id, here);
        continue;
      }
      origin.set(child.id, here);
      const phase = names.get(child.id);
      boxes.push({
        id: child.id, kind: phase ? "phase" : "lane", label: phase ? phase.name : child.id.split(":").slice(2).join(":"),
        note: phase?.description ?? "", ...here, width: child.width ?? 0, height: child.height ?? 0,
      });
      walk(child, here);
    }
  };
  walk(done, { x: 0, y: 0 });
  if (loose.length) {
    const PER_COLUMN = 8, GAP = 16, PAD = 20, TOP = 40;
    const columns = Math.ceil(loose.length / PER_COLUMN), rows = Math.min(loose.length, PER_COLUMN);
    const width = columns * NODE_W + (columns - 1) * GAP + PAD * 2, height = TOP + rows * NODE_H + (rows - 1) * GAP + PAD;
    const x = positions.size ? -width - 56 : 0;
    loose.forEach((n, i) => positions.set(n.id, {
      x: x + PAD + Math.floor(i / PER_COLUMN) * (NODE_W + GAP), y: TOP + (i % PER_COLUMN) * (NODE_H + GAP),
    }));
    boxes.push({ id: "loose", kind: "phase", label: "No phase, no links", note: "", x, y: 0, width, height });
  }

  // ELK gives the points of an edge relative to the edge's container.
  const routes = new Map<string, Point[]>();
  for (const edge of found) {
    const base = origin.get((edge as ElkExtendedEdge & { container?: string }).container ?? "root") ?? { x: 0, y: 0 };
    const points = (edge.sections ?? []).flatMap((s) => [s.startPoint, ...(s.bendPoints ?? []), s.endPoint]);
    if (points.length >= 2) routes.set(edge.id, points.map((p) => ({ x: p.x + base.x, y: p.y + base.y })));
  }
  return { positions, boxes, routes, boxed };
}

/** An SVG path through `points` with each corner rounded. */
export function roundedPath(points: Point[], radius = 7): string {
  if (points.length < 2) return "";
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [a, b, c] = [points[i - 1], points[i], points[i + 1]];
    const inLen = Math.hypot(b.x - a.x, b.y - a.y), outLen = Math.hypot(c.x - b.x, c.y - b.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    if (r < 1) {
      d += ` L${b.x},${b.y}`;
      continue;
    }
    const start = { x: b.x + ((a.x - b.x) / inLen) * r, y: b.y + ((a.y - b.y) / inLen) * r };
    const end = { x: b.x + ((c.x - b.x) / outLen) * r, y: b.y + ((c.y - b.y) / outLen) * r };
    d += ` L${start.x},${start.y} Q${b.x},${b.y} ${end.x},${end.y}`;
  }
  const last = points[points.length - 1];
  return `${d} L${last.x},${last.y}`;
}

/**
 * The id of the route nearest to `at`, when that route is within `reach` of it. The canvas uses
 * this for the edge under the pointer. The edges themselves take no pointer events, so a drag
 * that starts on an edge still moves the canvas.
 */
export function routeAt(routes: Map<string, Point[]>, at: Point, reach: number): string | null {
  let nearest: string | null = null, least = Infinity;
  for (const [id, points] of routes) {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      const dx = b.x - a.x, dy = b.y - a.y, span = dx * dx + dy * dy;
      const along = span ? Math.max(0, Math.min(1, ((at.x - a.x) * dx + (at.y - a.y) * dy) / span)) : 0;
      const gap = Math.hypot(at.x - (a.x + along * dx), at.y - (a.y + along * dy));
      if (gap < least) [nearest, least] = [id, gap];
    }
  }
  return least <= reach ? nearest : null;
}

/**
 * The route cut short at its end, and the arrowhead that fills the cut. The head points along the
 * last segment of the route. A last segment shorter than the head keeps its length.
 */
export function arrow(points: Point[], length = 8, width = 8): { shaft: Point[]; head: string } {
  if (points.length < 2) return { shaft: points, head: "" };
  const tip = points[points.length - 1], before = points[points.length - 2];
  const span = Math.hypot(tip.x - before.x, tip.y - before.y);
  if (span < 0.5) return { shaft: points, head: "" };
  const ux = (tip.x - before.x) / span, uy = (tip.y - before.y) / span;
  const base = { x: tip.x - ux * length, y: tip.y - uy * length };
  const half = width / 2;
  const head = `M${tip.x},${tip.y} L${base.x - uy * half},${base.y + ux * half} L${base.x + uy * half},${base.y - ux * half} Z`;
  return { shaft: span > length ? [...points.slice(0, -1), base] : points, head };
}
