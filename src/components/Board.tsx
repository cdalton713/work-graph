import { useEffect, useMemo, useRef, useState } from "react";
import { ownerWords } from "../lib/words";
import { type BoardGroupId, type GNode, type Graph, agentStep, boardGroups, reviewOf, runTime, satisfied, yourMove } from "../lib/graph";
import { matchesClaim, type ClaimFilter, type ClaimMark } from "../lib/claims";
import { Lamp, PrLinks } from "./ui";

/** Groups that start folded: they hold the issues that need nothing now. */
const FOLDED: BoardGroupId[] = ["waiting", "merged", "closed"];
/** Groups whose pull requests the human opens: to merge, to review, or to see a worker's draft. */
const PR_GROUPS: BoardGroupId[] = ["you", "running", "review"];

export interface BoardProps {
  marks: ReadonlyMap<string, ClaimMark>; filter: ClaimFilter;
  graph: Graph; now: number; selectedId: string | null;
  onPick: (id: string) => void; onHover: (id: string | null) => void;
  /** Adds or removes the `reviewed` label. Absent when the team has no such label. */
  onReview?: (id: string) => void;
  /** The identifiers of issues whose worker asks a question (from the link). */
  asked?: Set<string>;
  /** The live job of each issue, by identifier (from the link). */
  live?: Map<string, string>;
}

/**
 * The departure board: the issues by the action they need, in run order. A row selects the issue and
 * centres it on the canvas. The find field takes an id or words of a title; `/` puts the focus in it.
 */
export function Board({ graph, now, selectedId, onPick, onHover, onReview, asked, live, marks, filter }: BoardProps) {
  const copy = ownerWords();
  const includes = (node: GNode) => matchesClaim(node.card?.key ? marks.get(node.card.key) : undefined, filter);
  const groups = useMemo(() => boardGroups(graph, asked), [graph, asked]);
  const [query, setQuery] = useState("");
  const [folded, setFolded] = useState<Set<BoardGroupId>>(() => new Set(FOLDED));
  const find = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && e.target.closest("input, textarea, [contenteditable]");
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        find.current?.focus();
        find.current?.select();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = words.length
    ? graph.nodes.filter((n) => includes(n) && words.every((w) => `${n.issue.identifier} ${n.issue.title}`.toLowerCase().includes(w)))
      .sort((a, b) => a.issue.sortOrder - b.issue.sortOrder)
    : null;

  const row = (n: GNode, groupId?: BoardGroupId) => {
    const job = live?.get(n.issue.identifier);
    const claim = n.card?.key ? marks.get(n.card.key) : undefined;
    const worker = job ?? n.claim?.replace(/^agent:/, "");
    const elapsed = runTime(n.card, now);
    const holder = groupId === "waiting" ? (graph.blockers.get(n.id) ?? []).map((b) => graph.byId.get(b)!).find((b) => !satisfied(b, n)) : undefined;
    const reason = n.status === "Triage" ? "Triage: decide if it joins the graph" : yourMove(n.card?.next);
    return (
      <li key={n.id}>
        <button type="button" className={`board-row${n.id === selectedId ? " is-selected" : ""}`} aria-current={n.id === selectedId || undefined}
          onClick={() => onPick(n.id)} onMouseEnter={() => onHover(n.id)} onMouseLeave={() => onHover(null)}>
          <Lamp signal={n.signal} pulse={!!worker} />
          <span className="board-id mono">{n.issue.identifier}{asked?.has(n.issue.identifier) && <b className="board-ask" title={`The worker asks ${copy.owner} a question. Open the issue to reply.`}>asks {copy.owner}</b>}</span>
          <span className="board-title">{n.issue.title}{claim && <span className={`runner-mark${claim.stale ? " is-stale" : ""}`} role="img"
            aria-label={`Runner: ${claim.holder}${claim.stale ? ", stale claim" : ""}`} title={claim.holder}>
            {claim.stale && "⚠ "}{claim.initials}</span>}</span>
          <span className={`board-status sig-fg-${n.signal}`}>
            {n.waitsOnOther ? `waits on ${n.waitsOnOther}` : n.status === "Backlog" ? n.status : worker ?? (holder ? `after ${holder.issue.identifier}` : groupId === "running" ? "" : groupId === "review" ? (n.status === "Ready to Merge" && agentStep(n.card?.next) ? `${n.status} · wg: ${agentStep(n.card?.next)}` : "") : n.status)}
            {elapsed && <> <span className={`run-time${elapsed.warning ? " run-warning" : ""}`} title="Worker run time">{elapsed.text}</span></>}
          </span>
        </button>
        {/* A reason that is the title (a decision: its question) shows once. */}
        {groupId === "you" && reason && !reason.includes(n.issue.title.trim()) && <div className="board-why">{reason}</div>}
        {groupId && PR_GROUPS.includes(groupId) && n.issue.pullRequests.map((pr) => (
          <div key={pr.url} className="board-pr"><span className="mono">#{pr.number}</span><PrLinks pr={pr} compact /></div>
        ))}
        {groupId === "you" && onReview && n.kind === "task" && !n.issue.external && n.issue.pullRequests.length > 0 && (
          <div className="board-pr">
            <button type="button" className={`board-mark${reviewOf(n.issue, n.card).marked ? " is-on" : ""}`} onClick={() => onReview(n.id)} title="Add or remove the `reviewed` label: it counts as the wave review and the merge review of this PR.">
              {reviewOf(n.issue, n.card).marked ? "✓ Reviewed" : "Mark reviewed"}
            </button>
          </div>
        )}
      </li>
    );
  };

  return (
    <nav className="board" aria-label="Issues by the action they need">
      <div className="board-find">
        <input ref={find} type="search" placeholder="Find an issue" aria-label="Find an issue by id or title" value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && matches?.[0]) onPick(matches[0].id);
            if (e.key === "Escape") { setQuery(""); e.currentTarget.blur(); }
          }} />
        {!query && <kbd aria-hidden>/</kbd>}
      </div>
      <div className="board-scroll">
        {!matches && !groups.some((g) => g.id === "you" && g.nodes.some(includes)) && <p className="board-clear"><Lamp signal="done" />{copy.clear}</p>}
        {matches ? (
          <section className="board-group">
            <h3 className="board-head"><span>Matches</span><b className="mono">{matches.length}</b></h3>
            {matches.length ? <ul>{matches.map((n) => row(n))}</ul> : <p className="board-empty">No issue has these words.</p>}
          </section>
        ) : groups.map((g) => ({ ...g, nodes: g.nodes.filter(includes) })).filter((g) => g.nodes.length).map((g) => {
          const open = !folded.has(g.id);
          return (
            <section key={g.id} className={`board-group board-${g.id}`}>
              <h3>
                <button type="button" className="board-head" aria-expanded={open} title={g.hint}
                  onClick={() => setFolded((now) => { const next = new Set(now); if (!next.delete(g.id)) next.add(g.id); return next; })}>
                  <span className="board-caret" aria-hidden>{open ? "▾" : "▸"}</span><span>{g.title}</span><b className="mono">{g.nodes.length}</b>
                </button>
              </h3>
              {open && <ul>{g.nodes.map((n) => row(n, g.id))}</ul>}
            </section>
          );
        })}
      </div>
    </nav>
  );
}
