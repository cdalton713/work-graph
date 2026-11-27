import { BaseEdge, Controls, type Edge, type EdgeProps, getViewportForBounds, Handle, MiniMap, type Node, type NodeProps, Panel as Corner, Position, ReactFlow, ReactFlowProvider, useReactFlow, useViewportStore } from "@xyflow/react";
import { type CSSProperties, type MouseEvent, memo, useEffect, useMemo, useRef, useState } from "react";
import { type GEdge, type GNode, type Graph, reviewMark, runTime, satisfied, soakLeft, startNode, trace } from "../lib/graph";
import { EDGE_TAP_REACH, type Layout, NODE_H, NODE_W, type Point, arrow, roundedPath, routeAt } from "../lib/layout";
import { PHONE_MAX_WIDTH, TABLET_OR_WIDER } from "../lib/screen";
import { Lamp, Sheet } from "./ui";

import type { ClaimMark } from "../lib/claims";

type StationData = { claim?: ClaimMark; node: GNode; dim: boolean; selected: boolean; showLane: boolean; now: number };
type RouteEdge = Edge<{ points: Point[] }, "route">;
type StationNode = Node<StationData, "station">;
type BoxNode = Node<{ kind: "phase" | "lane" }, "box">;
type PlateNode = Node<{ kind: "phase" | "lane"; label: string; note: string; done: number; total: number }, "plate">;

// Short, so the status has room on the same row. The longest status is "Needs <human>".
// A touch screen has no pointer that rests on a node. There, a tap also sends a mouse-enter, and a
// page that changes on it can lose the tap. So the trace of the pointer is for a real pointer only.
const hoverPointer = () => matchMedia("(hover: hover)").matches;
const coarsePointer = () => matchMedia("(pointer: coarse)").matches;
const pointerType = ({ nativeEvent }: MouseEvent) =>
  "pointerType" in nativeEvent ? nativeEvent.pointerType : undefined;
const isTouch = (event: MouseEvent) => {
  const type = pointerType(event);
  return event.detail > 0 && (type ? type === "touch" : coarsePointer());
};
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_REACH = 24;
// Below this pane width the layout is the phone layout of styles.css.
const NARROW = PHONE_MAX_WIDTH;

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

function boundsOf(points: Point[], boxes: Layout["boxes"] = []) {
  const rects = [...boxes, ...points.map((p) => ({ ...p, width: NODE_W, height: NODE_H }))];
  const x = Math.min(...rects.map((r) => r.x)), y = Math.min(...rects.map((r) => r.y));
  return { x, y, width: Math.max(...rects.map((r) => r.x + r.width)) - x,
    height: Math.max(...rects.map((r) => r.y + r.height)) - y };
}

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
            {issue.archived && <span className="station-archived" title="Archived in Linear. Read-only.">ARCHIVED</span>}
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
  const [open, setOpen] = useState(false);
  const meaning = "An arrow points from a blocker to the issue that waits on it.";
  const line = (
    <svg className="key-line" width="28" height="10" viewBox="0 0 28 10" aria-hidden>
      <path className="react-flow__edge-path" d="M0,5 L20,5" /><path className="track-head" d="M28,5 L20,1 L20,9 Z" />
    </svg>
  );
  const marks = (
    <div className="key-body">
      <span className="track">{line}waits on blocker</span>
      <span className="track track-clear">{line}blocker done</span>
      <span><Lamp signal="running" />pulsing lamp: worker running</span>
    </div>
  );
  return (
    <>
      <Corner position="bottom-left" className="key">
        {/* Folded, so it does not cover the nodes in the corner. */}
        <details title={`${meaning} Point at a node or an edge to trace it.`}>
          <summary>Key</summary>
          {marks}
        </details>
        <button className="key-trigger" type="button" onClick={() => setOpen(true)}>Key</button>
      </Corner>
      <Sheet open={open} title="Graph key" onClose={() => setOpen(false)}>
        <p>{meaning} Tap a node or an edge to trace it.</p>
        {marks}
      </Sheet>
    </>
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
  const far = zoom < (coarsePointer() ? 0.8 : FAR);
  const pane = useRef<HTMLDivElement>(null);
  const tap = useRef<{ id: string | null; x: number; y: number; time: number } | null>(null);
  const touchStart = useRef<Point | null>(null);
  const selectTimer = useRef<number | undefined>(undefined);
  // The edge under the pointer, and where the pointer went onto it: the note about the edge shows there.
  const [pointed, setPointed] = useState<{ id: string; x: number; y: number; left: boolean; up: boolean; touch: boolean } | null>(null);
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
      const chosen = selectedId ? layout.positions.get(selectedId) : undefined; // a deep link to an issue
      if (coarsePointer() && !chosen) {
        const wave = graph.nodes.flatMap((node) => {
          const point = layout.positions.get(node.id);
          return node.card?.wave === "yes" && point ? [point] : [];
        });
        if (wave.length) {
          void flow.setViewport(getViewportForBounds(boundsOf(wave), area.width, area.height, 0.08, 1, 0.25));
          return;
        }
      }
      const { x: left, y: top, width, height } = boundsOf(points, layout.boxes);
      // A narrow pane shows one node at full size, and the user moves the canvas with a finger.
      const edge = area.width < NARROW ? 16 : 32, least = area.width < NARROW ? 1 : 0.75;
      const zoom = Math.min(1, Math.max(least, Math.min((area.width - edge * 2) / width, (area.height - edge * 2) / height)));
      // A graph wider than the pane starts on its first phase, because the run order starts there.
      const first = layout.boxes.filter((b) => b.kind === "phase" && b.id !== "loose").sort((a, b) => a.y - b.y)[0];
      const start = first && first.width * zoom <= area.width - edge * 2 ? area.width / 2 - (first.x + first.width / 2) * zoom : edge - (first?.x ?? left) * zoom;
      const x = width * zoom < area.width ? (area.width - width * zoom) / 2 - left * zoom : start;
      const y = height * zoom < area.height ? (area.height - height * zoom) / 2 - top * zoom : edge - top * zoom;
      // A graph larger than the pane starts on the work that needs an action, not on a finished phase.
      const fits = width * zoom <= area.width && height * zoom <= area.height;
      const action = fits ? undefined : layout.positions.get(startNode(graph)?.id ?? "");
      const at = chosen ?? action;
      void flow.setViewport(at ? centred(at, Math.max(zoom, 0.9), area) : { x, y, zoom });
    });
    return () => cancelAnimationFrame(frame);
  }, [layout, flow]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const element = pane.current;
    if (!element) return;
    let previous = element.getBoundingClientRect();
    let windowWidth = window.innerWidth, windowHeight = window.innerHeight;
    const observer = new ResizeObserver(() => {
      const area = element.getBoundingClientRect();
      if (!area.width || !area.height) return;
      // The window can turn or resize. A panel opening only changes the pane.
      const windowChanged = windowWidth !== window.innerWidth || windowHeight !== window.innerHeight;
      if (windowChanged && coarsePointer() && previous.width && previous.height) {
        const dx = (area.width - previous.width) / 2, dy = (area.height - previous.height) / 2;
        const { x, y, zoom } = flow.getViewport();
        if (dx || dy) void flow.setViewport({ x: x + dx, y: y + dy, zoom });
      }
      previous = area;
      windowWidth = window.innerWidth;
      windowHeight = window.innerHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [flow]);
  useEffect(() => () => {
    tap.current = null;
    window.clearTimeout(selectTimer.current);
  }, [layout]);
  // The panel takes the right side of the canvas when it opens. Move the selected node back into
  // view, and only as far as it needs, so the user keeps the place in the graph.
  useEffect(() => {
    // A pick from the board or the panel centres the node (the effect below). Do not move it again here.
    if (focus?.id === selectedId && Date.now() - focus.tick < 1000) return;
    if (coarsePointer() && !matchMedia(TABLET_OR_WIDER).matches) return;
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

  function pointAt(screen: Point, touch: boolean) {
    const area = pane.current?.getBoundingClientRect();
    if (!area) return;
    const id = routeAt(routes, flow.screenToFlowPosition(screen),
      (touch ? EDGE_TAP_REACH : 7) / flow.getZoom());
    if (!touch && id === (pointed?.id ?? null) && !pointed?.touch) return;
    const x = screen.x - area.left, y = screen.y - area.top;
    setPointed(id ? { id, x, y, left: x > area.width - 280, up: y > area.height - 70, touch } : null);
    return id;
  }

  function fitGraph(area: DOMRect) {
    const bounds = boundsOf([...layout.positions.values()], layout.boxes);
    void flow.setViewport(getViewportForBounds(bounds, area.width, area.height, 0.08, 2, 0.15), { duration: 180 });
  }

  function tapCanvas(screen: Point, time: number, id: string | null) {
    const previous = tap.current;
    const at = { ...screen, id, time };
    window.clearTimeout(selectTimer.current);
    if (!id && pointAt(screen, true)) {
      tap.current = null;
      if (selectedId) onSelect(null);
      return;
    }
    if (previous && previous.id === id && at.time - previous.time <= DOUBLE_TAP_MS
      && Math.hypot(at.x - previous.x, at.y - previous.y) <= DOUBLE_TAP_REACH) {
      tap.current = null;
      setPointed(null);
      const position = id && layout.positions.get(id), area = pane.current?.getBoundingClientRect();
      if (position && area) {
        const scale = Math.min(2, (area.width - 32) / NODE_W, (area.height - 32) / NODE_H);
        void flow.setViewport(centred(position, scale, area), { duration: 180 });
      } else if (!id && area) {
        fitGraph(area);
      }
      return;
    }
    tap.current = at;
    if (id) {
      setPointed(null);
      selectTimer.current = window.setTimeout(() => {
        tap.current = null;
        onSelect(id);
      }, DOUBLE_TAP_MS);
    } else {
      if (selectedId) onSelect(null);
    }
  }

  return (
    <ReactFlow
      ref={pane} className={far ? "is-far" : undefined} style={{ "--inv": 1 / Math.max(zoom, 0.05) } as CSSProperties} nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} forceColorMode="dark" minZoom={0.08} maxZoom={2}
      nodesDraggable={false} nodesConnectable={false} edgesFocusable={false} deleteKeyCode={null} onlyRenderVisibleElements attributionPosition="top-right"
      zoomOnDoubleClick={!coarsePointer()}
      onTouchStartCapture={(event) => {
        const first = event.touches[0];
        touchStart.current = event.touches.length === 1 ? { x: first.clientX, y: first.clientY } : null;
        if (!touchStart.current) tap.current = null;
      }}
      onTouchMoveCapture={(event) => {
        const start = touchStart.current, first = event.touches[0];
        if (start && Math.hypot(first.clientX - start.x, first.clientY - start.y) > 8) {
          touchStart.current = null;
          tap.current = null;
        }
      }}
      onTouchCancelCapture={() => { touchStart.current = null; }}
      onTouchEndCapture={(event) => {
        const start = touchStart.current;
        touchStart.current = null;
        if (!start || event.touches.length) return;
        const { clientX: x, clientY: y } = event.changedTouches[0];
        if (Math.hypot(x - start.x, y - start.y) > 8) return;
        // The browser can move a synthetic click from a track onto a nearby station.
        // Use the touch coordinates to identify the station or track before that happens.
        const hit = document.elementFromPoint(x, y);
        if (!hit?.closest(".react-flow__pane")) return;
        const station = hit.closest<HTMLElement>(".react-flow__node-station");
        tapCanvas({ x, y }, event.timeStamp, station?.dataset.id ?? null);
      }}
      onNodeClick={(event, n) => {
        if (!isTouch(event) && n.type === "station") onSelect(n.id);
      }}
      onNodeMouseEnter={(event, n) => {
        if (hoverPointer() && pointerType(event) !== "touch" && n.type === "station") {
          onHover(n.id);
          setPointed(null);
        }
      }}
      onNodeMouseLeave={() => onHover(null)}
      // A move on a node also comes up to the pane, so only a move on the pane itself counts. There,
      // no node is under the pointer: a node that left the view while the pointer was on it sent no
      // leave event. An edge takes no pointer events, so the edge under the pointer is found here.
      onPaneMouseMove={(event) => {
        if (!hoverPointer() || pointerType(event) === "touch" || event.target !== event.currentTarget) return;
        if (hoverId) onHover(null);
        pointAt({ x: event.clientX, y: event.clientY }, false);
      }}
      onPaneMouseLeave={() => setPointed((current) => current?.touch ? current : null)}
      onPaneClick={(event) => {
        if (!isTouch(event)) onSelect(null);
      }}
    >
      <Controls showInteractive={false} position="bottom-left" onFitView={() => {
        const area = pane.current?.getBoundingClientRect();
        if (area && coarsePointer()) fitGraph(area);
      }} />
      <Key />
      {showMap && <MiniMap style={{ width: 160, height: 120 }} pannable zoomable position="bottom-right" nodeClassName={(n) => (n.type === "station" ? `mini sig-${(n.data as StationData).node.signal}` : n.type === "box" ? "mini-box" : "mini-none")} />}
      {note && pointed && (
        <div className={`track-note${pointed.touch ? " track-note-touch" : ""}`} role="status" style={pointed.touch ? undefined : { left: pointed.x, top: pointed.y, transform: `translate(${pointed.left ? "calc(-100% - 12px)" : "14px"}, ${pointed.up ? "calc(-100% - 10px)" : "14px"})` }}>
          <b>{note.to.issue.identifier}</b>{note.clear ? "no longer waits on" : "waits on"}<b>{note.from.issue.identifier}</b><span>{note.from.status}</span>
        </div>
      )}
    </ReactFlow>
  );
}

export function Canvas(props: CanvasProps) {
  return <ReactFlowProvider><Flow {...props} /></ReactFlowProvider>;
}
