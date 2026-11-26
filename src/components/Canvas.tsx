import { BaseEdge, Controls, type Edge, type EdgeProps, Handle, MiniMap, type Node, type NodeProps, Panel as Corner, Position, ReactFlow, ReactFlowProvider, useReactFlow, useViewportStore } from "@xyflow/react";
import { type CSSProperties, memo, useEffect, useMemo, useRef, useState } from "react";
import { type GEdge, type GNode, type Graph, reviewMark, runTime, satisfied, soakLeft, startNode, trace } from "../lib/graph";
import { type Layout, NODE_H, NODE_W, type Point, arrow, roundedPath, routeAt } from "../lib/layout";
import { Lamp } from "./ui";

import type { ClaimMark } from "../lib/claims";

type StationData = { claim?: ClaimMark; node: GNode; dim: boolean; selected: boolean; showLane: boolean; now: number };
type RouteEdge = Edge<{ points: Point[] }, "route">;
type StationNode = Node<StationData, "station">;
type BoxNode = Node<{ kind: "phase" | "lane" }, "box">;
type PlateNode = Node<{ kind: "phase" | "lane"; label: string; note: string; done: number; total: number }, "plate">;

// Short, so the status has room on the same row. The longest status is "Needs <human>".
// A touch screen has no pointer that rests on a node. There, a tap also sends a mouse-enter, and a
// page that changes on it can lose the tap. So the trace of the pointer is for a real pointer only.
const HAS_POINTER = typeof matchMedia === "function" && matchMedia("(hover: hover)").matches;
// Below this pane width the layout is the phone layout of styles.css.
const NARROW = 720;

// Below this zoom the text of a station cannot be read. The station then shows its id only, large,
// and the face takes the colour of its status (see .is-far in styles.css).
const FAR = 0.55;

const KIND_MARK: Record<string, string> = { task: "", spike: "SPIKE", decision: "DECIDE", ops: "OPS", "merge-point": "MERGE", "ship-point": "SHIP" };
const PLATE_H = 30;

/**
 * The viewport that puts a node at the centre of the pane. `area` is the pane as it is on screen
 * now. React Flow's own setCenter uses the size it last measured, and that size is the old one in
 * the frame in which the panel opens or closes.
 */
const centred = (at: Point, zoom: number, area: DOMRect) => ({ x: area.width / 2 - (at.x + NODE_W / 2) * zoom, y: area.height / 2 - (at.y + NODE_H / 2) * zoom, zoom });

/**
 * The two handles of a station, at fixed places. Each node also has a fixed size, so React Flow has
 * nothing to measure. Without these, React Flow measures a node again for each new node object (a
 * hover, a selection, a poll), and it draws no edge of that node until the measure is done: the
 * edge under the pointer went away at the moment the pointer went onto it.
 */
const HANDLES: NonNullable<StationNode["handles"]> = [
  { type: "target", position: Position.Top, x: NODE_W / 2, y: 0, width: 1, height: 1 },
  { type: "source", position: Position.Bottom, x: NODE_W / 2, y: NODE_H, width: 1, height: 1 },
];

const Station = memo(function Station({ data }: NodeProps<StationNode>) {
  const { node, dim, selected, showLane, now, claim } = data;
  const { issue, card } = node;
  const worker = node.claim?.replace(/^agent:/, "");
  const mark = reviewMark(issue, card);
  // The canvas draws again at each poll, so the time left is at most one poll old.
  const soak = soakLeft(card?.soak_until, now);
  const elapsed = runTime(card, now);
  return (
    <div className={`station kind-${node.kind} sig-${node.signal}${worker ? " is-live" : ""}${dim ? " is-dim" : ""}${selected ? " is-selected" : ""}`}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div className="station-face">
        <div className="station-top">
          <Lamp signal={node.signal} pulse={!!worker} />
          <span className="station-id">{issue.identifier}</span>
          {claim && <span className={`runner-mark${claim.stale ? " is-stale" : ""}`} role="img"
            aria-label={`Runner: ${claim.holder}${claim.stale ? ", stale claim" : ""}`}
            title={`Runner: ${claim.holder}${claim.stale ? " (stale claim)" : ""}`}>{claim.stale && "⚠ "}{claim.initials}</span>}
          <span className="station-tags">
            {KIND_MARK[node.kind] && <span>{KIND_MARK[node.kind]}</span>}
            {card?.wave === "yes" && <span className="station-wave" title="In the current wave.">WAVE</span>}
            {worker && <span className="station-worker" title={`A worker runs on this issue now (${node.claim}${card?.job ? `, job ${card.job}` : ""}).`}>{worker}{card?.job ? ` · ${card.job}` : ""}</span>}
            {soak && <span className="station-soak" title={`The soak ends at ${new Date(card!.soak_until!).toLocaleString()}.`}>soak {soak}</span>}
            {showLane && node.lane && <span>{node.lane}</span>}
          </span>
          {card?.pr && <span className="station-pr">#{card.pr}{mark && <i title={mark.title}> {mark.text}</i>}</span>}
          {elapsed && <span className={`run-time${elapsed.warning ? " run-warning" : ""}`} title="Worker run time">{elapsed.text}</span>}
          <span className="station-status" title={node.waitsOnOther ? `Waits on ${node.waitsOnOther}` : undefined}>{node.waitsOnOther ? `waits on ${node.waitsOnOther}` : node.status}</span>
        </div>
        <div className="station-title">{issue.title}</div>
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
});

function BoxView({ data }: NodeProps<BoxNode>) {
  return <div className={`box box-${data.kind}`} />;
}

/** The name of a phase or a lane. It sits above the edges, so an edge goes behind it and the name stays easy to read. */
function PlateView({ data }: NodeProps<PlateNode>) {
  return (
    <div className={`plate plate-${data.kind}${data.total > 0 && data.done === data.total ? " is-complete" : ""}`}>
      <span className="plate-label">{data.label}</span>
      {data.total > 0 && <span className="plate-count">{data.done}/{data.total}</span>}
      {data.note && <span className="plate-note">{data.note}</span>}
    </div>
  );
}

/**
 * Draws the route that ELK made. React Flow's own paths know nothing about the nodes in the way.
 * The head is a path of the edge, not an SVG marker, so it takes its colour from the edge's class.
 */
function Route({ data }: EdgeProps<RouteEdge>) {
  const { shaft, head } = arrow(data?.points ?? []);
  return <><BaseEdge path={roundedPath(shaft)} interactionWidth={0} /><path className="track-head" d={head} /></>;
}

/** What each mark on the canvas means. It uses the classes of the edges, so it cannot differ from them. */
function Key() {
  const line = (
    <svg className="key-line" width="28" height="10" viewBox="0 0 28 10" aria-hidden>
      <path className="react-flow__edge-path" d="M0,5 L20,5" /><path className="track-head" d="M28,5 L20,1 L20,9 Z" />
    </svg>
  );
  return (
    <Corner position="bottom-left" className="key" title="An arrow points from a blocker to the issue that waits on it. Point at a node or an edge to trace it.">
      {/* Folded, so it does not cover the nodes in the corner. */}
      <details>
        <summary>Key</summary>
        <div className="key-body">
        <span className="track">{line}waits on blocker</span>
        <span className="track track-clear">{line}blocker done</span>
        <span><Lamp signal="running" />pulsing lamp: worker running</span>
        </div>
      </details>
    </Corner>
  );
}

const nodeTypes = { station: Station, box: BoxView, plate: PlateView };
const edgeTypes = { route: Route };

export interface CanvasProps {
  marks: ReadonlyMap<string, ClaimMark>;
  graph: Graph; now: number; edges: GEdge[]; layout: Layout; selectedId: string | null; hoverId: string | null;
  statusFilter: Set<string>; focus: { id: string; tick: number } | null; showMap: boolean;
  onSelect: (id: string | null) => void; onHover: (id: string | null) => void;
}

function Flow({ graph, marks, now, edges: shown, layout, selectedId, hoverId, statusFilter, focus, showMap, onSelect, onHover }: CanvasProps) {
  const flow = useReactFlow();
  // In steps of 0.05, so a zoom gesture renders the canvas again only a few times.
  const zoom = useViewportStore((s) => Math.round(s.transform[2] * 20) / 20);
  const far = zoom < FAR;
  const pane = useRef<HTMLDivElement>(null);
  // The edge under the pointer, and where the pointer went onto it: the note about the edge shows there.
  const [pointed, setPointed] = useState<{ id: string; x: number; y: number; left: boolean; up: boolean } | null>(null);
  const routes = useMemo(() => new Map(shown.flatMap((e) => (layout.routes.has(e.id) ? [[e.id, layout.routes.get(e.id)!] as const] : []))), [shown, layout]);
  const lit = useMemo(() => trace(graph, shown, { edge: pointed?.id, hover: hoverId, selected: selectedId }), [graph, shown, pointed?.id, hoverId, selectedId]);
  const dimmed = useMemo(() => new Set(graph.nodes.filter((n) => (lit?.dim ? !lit.nodes.has(n.id) : statusFilter.size > 0 && !statusFilter.has(n.status))).map((n) => n.id)), [graph, lit, statusFilter]);

  const nodes = useMemo(() => {
    const tally = new Map<string, { done: number; total: number }>();
    const count = (boxId: string, n: GNode) => {
      const t = tally.get(boxId) ?? { done: 0, total: 0 };
      tally.set(boxId, { done: t.done + (n.status === "Done" ? 1 : 0), total: t.total + 1 });
    };
    for (const n of graph.nodes) {
      if (!layout.positions.has(n.id)) continue;
      if (n.phaseId) count(`phase:${n.phaseId}`, n);
      if (layout.boxed.has(n.id)) count(`lane:${n.phaseId}:${n.lane}`, n);
    }
    const fixed = { selectable: false, draggable: false, focusable: false, className: "box-node" };
    const boxes: BoxNode[] = layout.boxes.map((b) => ({
      ...fixed, id: b.id, type: "box", position: { x: b.x, y: b.y }, data: { kind: b.kind },
      width: b.width, height: b.height, zIndex: b.kind === "phase" ? -2 : -1,
    }));
    const plates: PlateNode[] = layout.boxes.map((b) => ({
      ...fixed, id: `plate:${b.id}`, type: "plate", position: { x: b.x, y: b.y },
      data: { kind: b.kind, label: b.label, note: b.note, ...(tally.get(b.id) ?? { done: 0, total: 0 }) },
      width: b.width, height: PLATE_H, zIndex: 3,
    }));
    const stations: StationNode[] = graph.nodes.filter((n) => layout.positions.has(n.id)).map((n) => ({
      id: n.id, type: "station", position: layout.positions.get(n.id)!, width: NODE_W, height: NODE_H, handles: HANDLES, draggable: false,
      data: { node: n, now, claim: n.card?.key ? marks.get(n.card.key) : undefined, selected: n.id === selectedId, showLane: !layout.boxed.has(n.id), dim: dimmed.has(n.id) },
    }));
    return [...boxes, ...plates, ...stations];
  }, [graph, marks, now, layout, selectedId, dimmed]);

  // Colour is the state of the blocker. A lit edge is brighter and thicker and keeps that colour.
  const edges = useMemo<RouteEdge[]>(() => shown.filter((e) => layout.routes.has(e.id)).map((e) => {
    const on = !!lit?.edges.has(e.id);
    const dim = !on && (lit?.dim || dimmed.has(e.from) || dimmed.has(e.to));
    const from = graph.byId.get(e.from)!, to = graph.byId.get(e.to)!, clear = satisfied(from, to);
    return {
      id: e.id, source: e.from, target: e.to, type: "route", data: { points: layout.routes.get(e.id)! },
      ariaLabel: `${to.issue.identifier} ${clear ? "no longer waits on" : "waits on"} ${from.issue.identifier}`,
      selectable: false, focusable: false, zIndex: on ? 2 : 0,
      className: `track${clear ? " track-clear" : ""}${on ? " track-lit" : ""}${dim ? " track-dim" : ""}`,
    };
  }), [graph, shown, layout, lit, dimmed]);

  const note = useMemo(() => {
    const edge = pointed && shown.find((e) => e.id === pointed.id);
    const from = edge && graph.byId.get(edge.from), to = edge && graph.byId.get(edge.to);
    return from && to ? { from, to, clear: satisfied(from, to) } : null;
  }, [pointed, shown, graph]);

  // The first view keeps a zoom at which a node can be read, and starts where the run order starts.
  // The fit control still shows all of the graph.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const points = [...layout.positions.values()];
      const area = pane.current?.getBoundingClientRect();
      if (!points.length || !area) return;
      const boxes = [...layout.boxes.map((b) => [b.x, b.y, b.x + b.width, b.y + b.height]), ...points.map((p) => [p.x, p.y, p.x + NODE_W, p.y + NODE_H])];
      const left = Math.min(...boxes.map((b) => b[0])), top = Math.min(...boxes.map((b) => b[1]));
      const width = Math.max(...boxes.map((b) => b[2])) - left, height = Math.max(...boxes.map((b) => b[3])) - top;
      // A narrow pane shows one node at full size, and the user moves the canvas with a finger.
      const edge = area.width < NARROW ? 16 : 32, least = area.width < NARROW ? 1 : 0.75;
      const zoom = Math.min(1, Math.max(least, Math.min((area.width - edge * 2) / width, (area.height - edge * 2) / height)));
      // A graph wider than the pane starts on its first phase, because the run order starts there.
      const first = layout.boxes.filter((b) => b.kind === "phase" && b.id !== "loose").sort((a, b) => a.y - b.y)[0];
      const start = first && first.width * zoom <= area.width - edge * 2 ? area.width / 2 - (first.x + first.width / 2) * zoom : edge - (first?.x ?? left) * zoom;
      const x = width * zoom < area.width ? (area.width - width * zoom) / 2 - left * zoom : start;
      const y = height * zoom < area.height ? (area.height - height * zoom) / 2 - top * zoom : edge - top * zoom;
      const chosen = selectedId ? layout.positions.get(selectedId) : undefined; // a deep link to an issue
      // A graph larger than the pane starts on the work that needs an action, not on a finished phase.
      const fits = width * zoom <= area.width && height * zoom <= area.height;
      const action = fits ? undefined : layout.positions.get(startNode(graph)?.id ?? "");
      const at = chosen ?? action;
      void flow.setViewport(at ? centred(at, Math.max(zoom, 0.9), area) : { x, y, zoom });
    });
    return () => cancelAnimationFrame(frame);
  }, [layout, flow]); // eslint-disable-line react-hooks/exhaustive-deps
  // The panel takes the right side of the canvas when it opens. Move the selected node back into
  // view, and only as far as it needs, so the user keeps the place in the graph.
  useEffect(() => {
    // A pick from the board or the panel centres the node (the effect below). Do not move it again here.
    if (focus?.id === selectedId && Date.now() - focus.tick < 1000) return;
    const frame = requestAnimationFrame(() => {
      const at = selectedId && layout.positions.get(selectedId), area = pane.current?.getBoundingClientRect();
      if (!at || !area) return;
      const { x, y, zoom } = flow.getViewport();
      const left = at.x * zoom + x, top = at.y * zoom + y, EDGE = 24;
      const dx = Math.min(0, area.width - EDGE - (left + NODE_W * zoom)) || Math.max(0, EDGE - left);
      const dy = Math.min(0, area.height - EDGE - (top + NODE_H * zoom)) || Math.max(0, EDGE - top);
      if (dx || dy) void flow.setViewport({ x: x + dx, y: y + dy, zoom }, { duration: 250 });
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const at = focus && layout.positions.get(focus.id), area = pane.current?.getBoundingClientRect();
    if (at && area) void flow.setViewport(centred(at, Math.max(flow.getZoom(), 0.9), area), { duration: 300 });
  }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <ReactFlow
      ref={pane} className={far ? "is-far" : undefined} style={{ "--inv": 1 / Math.max(zoom, 0.05) } as CSSProperties} nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} forceColorMode="dark" minZoom={0.08} maxZoom={2}
      nodesDraggable={false} nodesConnectable={false} edgesFocusable={false} deleteKeyCode={null} onlyRenderVisibleElements attributionPosition="top-right"
      onNodeClick={(_, n) => n.type === "station" && onSelect(n.id)}
      onNodeMouseEnter={(_, n) => { if (HAS_POINTER && n.type === "station") { onHover(n.id); setPointed(null); } }}
      onNodeMouseLeave={() => onHover(null)}
      // A move on a node also comes up to the pane, so only a move on the pane itself counts. There,
      // no node is under the pointer: a node that left the view while the pointer was on it sent no
      // leave event. An edge takes no pointer events, so the edge under the pointer is found here.
      onPaneMouseMove={(event) => {
        const area = HAS_POINTER && event.target === event.currentTarget && pane.current?.getBoundingClientRect();
        if (!area) return;
        if (hoverId) onHover(null);
        const id = routeAt(routes, flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }), 7 / flow.getZoom());
        if (id === (pointed?.id ?? null)) return;
        const x = event.clientX - area.left, y = event.clientY - area.top;
        setPointed(id ? { id, x, y, left: x > area.width - 280, up: y > area.height - 70 } : null);
      }}
      onPaneMouseLeave={() => setPointed(null)}
      onPaneClick={() => onSelect(null)}
    >
      <Controls showInteractive={false} position="bottom-left" />
      <Key />
      {showMap && <MiniMap style={{ width: 160, height: 120 }} pannable zoomable position="bottom-right" nodeClassName={(n) => (n.type === "station" ? `mini sig-${(n.data as StationData).node.signal}` : n.type === "box" ? "mini-box" : "mini-none")} />}
      {note && pointed && (
        <div className="track-note" role="status" style={{ left: pointed.x, top: pointed.y, transform: `translate(${pointed.left ? "calc(-100% - 12px)" : "14px"}, ${pointed.up ? "calc(-100% - 10px)" : "14px"})` }}>
          <b>{note.to.issue.identifier}</b>{note.clear ? "no longer waits on" : "waits on"}<b>{note.from.issue.identifier}</b><span>{note.from.status}</span>
        </div>
      )}
    </ReactFlow>
  );
}

export function Canvas(props: CanvasProps) {
  return <ReactFlowProvider><Flow {...props} /></ReactFlowProvider>;
}
