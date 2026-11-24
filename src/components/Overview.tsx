import { useEffect, useMemo, useRef, useState } from "react";
import { type OverviewData, type OverviewFilter, type OverviewRow, type ProjectSummary, NO_INITIATIVE, PROJECT_LAMP, initiativeNames, initiativeSections, movesWithAgents, movesWithAsks, overviewRows, summaryKey } from "../lib/overview";
import { ageText } from "../lib/graph";
import { type Agents, type Ask, type Presence, agentName, agentState, agentsFresh, agentsShown, presenceText } from "../lib/link";
import type { Project, ProjectList } from "../lib/types";
import { CopyButton, Lamp, Picker, PrLinks } from "./ui";

const STORE = "wg-overview";
/** The inbox items that show before "Show all". */
const INBOX = 8;
const START: OverviewFilter = { text: "", workspace: null, mine: false, closed: false };

function freshnessText({ state, ran }: NonNullable<ProjectSummary["freshness"]>, at: string | null, now: number): string | null {
  if (state === "never") return "wg next has not published this effort";
  if (state === "listening") return "listening";
  const age = ageText(now - Date.parse((state === "unknown" ? at : ran) ?? ""));
  if (!age) return null;
  const label = state === "stale" ? "last ran" : state === "unknown" ? "changed" : "ran";
  return `${label} ${age}`;
}

function stored(): OverviewFilter {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? "null") as Partial<OverviewFilter> | null;
    return { ...START, ...saved, text: "" };
  } catch {
    return START;
  }
}

export interface OverviewProps {
  /** The project list alone, until the first overview answer comes. */
  list: OverviewData | ProjectList;
  loading: boolean; missing: string | null; now: number;
  onOpen: (project: Project, issue?: string) => void;
  /** The coordinators of each project, by `workspace:id`, from the link. */
  presence?: Map<string, Presence>;
  /** The open questions of the workers of each project, by `workspace:id`, from the link. Each one is a move of the human's. */
  asks?: Map<string, Ask[]>;
  /** The agents of each project, by `workspace:id`, from the link (`wg agents`). One that waits at a prompt is a move of the human's. */
  agents?: Map<string, Agents>;
  /** The initiative filter from the link (`?initiative=`): null shows all; NO_INITIATIVE the projects with none. */
  initiative?: string | null;
  onInitiative?: (name: string | null) => void;
  /** The workspaces with a low Linear budget (`budgetWarnings`). */
  budget?: { id: string; text: string; title: string }[];
}

/**
 * All projects on one page: which ones wait on the human, how far each is, and what wg next last said.
 * `/` finds a project, the arrow keys move, Enter opens.
 */
export function Overview({ list: given, loading, missing, now, onOpen, presence, asks, agents, initiative = null, onInitiative, budget = [] }: OverviewProps) {
  const list = useMemo<OverviewData | ProjectList>(() => ("summaries" in given && (asks?.size || agents?.size)
    ? { ...given, summaries: given.summaries.map((s) => ({ ...s, you: movesWithAgents(movesWithAsks(s.you, asks?.get(summaryKey(s))), agents?.get(summaryKey(s)), now) })) }
    : given), [given, asks, agents, now]);
  const [filter, setFilter] = useState(stored);
  useEffect(() => {
    try { localStorage.setItem(STORE, JSON.stringify({ ...filter, text: "" })); } catch { /* the filter is a convenience */ }
  }, [filter]);
  const set = (change: Partial<OverviewFilter>) => setFilter((f) => ({ ...f, ...change }));
  const names = useMemo(() => initiativeNames(list.projects), [list]);
  // Sections only when some project has an initiative; then the rows go in the order of the sections.
  const grouped = names.length > 0;
  const sections = useMemo(() => initiativeSections(overviewRows(list, { ...filter, initiative }), list.workspaces), [list, filter, initiative]);
  const rows = useMemo(() => sections.flatMap((section) => section.rows), [sections]);
  const waiting = useMemo(() => overviewRows(list, { ...START, workspace: filter.workspace, mine: true, initiative }), [list, filter.workspace, initiative]);
  const waitingIssues = waiting.reduce((n, r) => n + (r.summary?.you.length ?? 0), 0);
  const [active, setActive] = useState(0);
  // One inbox for all projects: each move that waits on the human, the one that waits longest first.
  const inbox = useMemo(() => waiting.flatMap(({ project, summary }) => (summary?.you ?? []).map((move) => ({ project, move })))
    .sort((a, b) => (a.move.updatedAt || "~").localeCompare(b.move.updatedAt || "~")), [waiting]);
  const [allMoves, setAllMoves] = useState(false);
  const find = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => setActive(0), [filter, initiative]);
  useEffect(() => { root.current?.querySelector(".ov-row.is-active")?.scrollIntoView({ block: "nearest" }); }, [active]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector(".picker-list")) return; // an open picker takes the keys
      const typing = e.target instanceof HTMLElement && e.target.closest("input, textarea, [contenteditable]");
      const inFind = e.target === find.current;
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        find.current?.focus();
        find.current?.select();
      } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && (!typing || inFind)) {
        e.preventDefault();
        setActive((a) => Math.min(rows.length - 1, Math.max(0, a + (e.key === "ArrowDown" ? 1 : -1))));
      } else if (e.key === "Enter" && inFind && rows[active]) {
        e.preventDefault();
        onOpen(rows[active].project);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [rows, active, onOpen]);

  const multi = list.workspaces.length > 1;
  const closedCount = list.projects.filter((p) => p.statusType === "completed" || p.statusType === "canceled").length;

  const renderRow = ({ project: p, summary: s }: OverviewRow, at: number) => {
      const closed = p.statusType === "completed" || p.statusType === "canceled";
      const you = s?.you ?? [];
      const reported = agents?.get(summaryKey(p));
      const coordinator = presenceText(presence?.get(summaryKey(p)), Date.now(), reported);
      const shown = agentsShown(reported, now);
      const fresh = agentsFresh(reported, now);
      return (
        <li key={summaryKey(p)} className={`ov-row${at === active ? " is-active" : ""}${you.length ? " is-you" : ""}${closed ? " is-closed" : ""}`}>
          <button type="button" className="ov-open" onClick={() => onOpen(p)} onFocus={() => setActive(at)} onMouseEnter={() => setActive(at)}>
            <span className="ov-name">
              <Lamp signal={PROJECT_LAMP[p.statusType] ?? "idle"} />
              <span className="ov-title" title={p.name}>{p.name}</span>
              {multi && !grouped && <span className="ov-ws">{p.workspaceName}</span>}
              {p.statusType !== "started" && <span className="ov-pstatus">{p.status}</span>}
              {p.autonomy && <span className={`ov-auto auto-${p.autonomy}`} title="Autonomy level of the coordinator">{p.autonomy}</span>}
              {coordinator && <span className={`ov-coord coord-${coordinator.state}`} title={coordinator.title}>{coordinator.text}</span>}
            </span>
            <span className={`ov-you${you.length ? "" : " is-zero"}`} title="Issues in Your move">
              {you.length ? <><b className="mono">{you.length}</b> for you</> : s ? "—" : ""}
            </span>
            <span className="ov-progress">
              {s && s.planned > 0 && (
                <>
                  <span className="ov-track" role="img" aria-label={s.counts.map((c) => `${c.status} ${c.n}`).join(", ")}>
                    {s.counts.map((c) => <i key={c.status} className={`sig-bg-${c.signal}`} style={{ flexGrow: c.n }} title={`${c.status} · ${c.n}`} />)}
                  </span>
                  <span className="mono ov-done">{s.done}/{s.planned}</span>
                </>
              )}
            </span>
            <span className="ov-flow">
              {s && s.running > 0 && <span className="sig-fg-running" title="A worker runs on it, or it is In Progress"><Lamp signal="running" pulse />{s.running} running</span>}
              {s && s.review > 0 && <span className="sig-fg-review" title="In Review or Verifying"><Lamp signal="review" />{s.review} in review</span>}
              {s && s.ready > 0 && <span className="sig-fg-ready" title="Not started, and no blocker holds it back"><Lamp signal="ready" />{s.ready} can start</span>}
            </span>
            <span className={`ov-age${s?.freshness?.state === "stale" || s?.freshness?.state === "never" ? " is-warning" : ""}`}>
              {s?.freshness && freshnessText(s.freshness, s.effort?.at ?? null, now)}
            </span>
            {(s?.error || s?.effort) && (
              <span className="ov-effort">
                {s.error ? <span className="sig-fg-stop">{s.error}</span>
                  : <><span className="ov-effort-mark">wg next</span><span className="ov-effort-status">{s.effort!.status}</span></>}
              </span>
            )}
          </button>
          <CopyButton text={p.name} label="Copy the project name" className="ov-copy" />
          {shown.length > 0 && (
            <ul className={`ov-agents${fresh ? "" : " is-stale"}`} aria-label={`Agents of ${p.name} in Orca`}>
              {!fresh && <li className="ov-agents-note is-warning">agent view stopped · last report {ageText(now - Date.parse(reported!.at))} · wg agents does not run</li>}
              {shown.map((a) => {
                const state = agentState(a);
                return (
                  <li key={a.id}>
                    <details className="ov-agent">
                      <summary title={a.title || undefined}>
                        <Lamp signal={fresh ? state.signal : "off"} pulse={fresh && state.signal === "running"} />
                        <span className="ov-agent-who mono">{agentName(a)}</span>
                        <span className={`ov-agent-state${fresh && state.signal === "stop" ? " sig-fg-stop" : ""}`}>{a.agent} {state.text}</span>
                        <span className="ov-agent-age mono">{a.at ? ageText(now - Date.parse(a.at)) : ""}</span>
                        <span className="ov-agent-said">{a.said || "no message yet"}</span>
                      </summary>
                      <p className="ov-agent-full">{a.said || "no message yet"}</p>
                    </details>
                  </li>
                );
              })}
            </ul>
          )}
        </li>
      );
  };

  return (
    <div className="overview" ref={root}>
      <div className="ov-head">
        <h1>Overview</h1>
        <p className={`ov-sum${waiting.length ? " is-you" : ""}`} role="status">
          {"summaries" in list
            ? waiting.length
              ? <><Lamp signal="stop" /><b>{waiting.length}</b> {waiting.length === 1 ? "project waits" : "projects wait"} on you · <b>{waitingIssues}</b> {waitingIssues === 1 ? "issue" : "issues"}</>
              : <><Lamp signal="done" />Nothing waits on you.</>
            : "Loading the projects…"}
          {loading && "summaries" in list && <span className="sync-dot is-busy" aria-label="Refreshing" />}
        </p>
        {budget.map((w) => <span key={w.id} className="ov-budget is-warning mono" role="status" title={w.title}>{w.text}</span>)}
      </div>
      {missing && <p className="empty" role="status">{missing}</p>}

      {inbox.length > 0 && (
        <section className="inbox" aria-label="Your move in all projects">
          <h2 className="inbox-head"><span>Your move</span><b className="mono">{inbox.length}</b><span className="inbox-note">oldest first</span></h2>
          <ul>
            {(allMoves ? inbox : inbox.slice(0, INBOX)).map(({ project: p, move: m }) => {
              const age = m.updatedAt ? ageText(now - Date.parse(m.updatedAt)) : null;
              // A reason that is the title (a decision: its question) shows once.
              const title = m.why.trim() !== m.title.trim() && !m.why.includes(m.title.trim()) ? m.title : null;
              return (
                <li key={`${summaryKey(p)}:${m.identifier}`} className="inbox-row">
                  <button type="button" className="inbox-open" onClick={() => onOpen(p, m.identifier === "worker" || m.identifier === "coordinator" ? undefined : m.identifier)} title={`${p.name}: ${m.title}`}>
                    <Lamp signal="stop" />
                    <span className="inbox-id mono">{m.identifier}</span>
                    <span className="inbox-text">
                      <span className="inbox-why">{m.why}</span>
                      {title && <span className="inbox-title">{title}</span>}
                    </span>
                    <span className="inbox-project">{p.name}</span>
                    <span className="inbox-age mono">{age ?? ""}</span>
                  </button>
                  {/* Always there, so the columns of the rows line up. */}
                  <span className="inbox-prs">
                    {m.pullRequests.map((pr) => <span className="ov-pr" key={pr.url}>#{pr.number} <PrLinks pr={pr} compact /></span>)}
                  </span>
                </li>
              );
            })}
          </ul>
          {inbox.length > INBOX && (
            <button type="button" className="ghost inbox-more" onClick={() => setAllMoves(!allMoves)}>
              {allMoves ? "Show fewer" : `Show all ${inbox.length}`}
            </button>
          )}
        </section>
      )}

      <div className="ov-filters">
        <div className="ov-find">
          <input ref={find} type="search" placeholder="Find a project" aria-label="Find a project by name" value={filter.text}
            onChange={(e) => set({ text: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Escape") { set({ text: "" }); e.currentTarget.blur(); } }} />
          {!filter.text && <kbd aria-hidden>/</kbd>}
        </div>
        {multi && (
          <div className="ov-seg" role="group" aria-label="Workspace">
            {[{ id: null, name: "All" }, ...list.workspaces].map((w) => (
              <button type="button" key={w.id ?? "all"} className={filter.workspace === w.id ? "is-on" : ""} aria-pressed={filter.workspace === w.id}
                onClick={() => set({ workspace: w.id })}>{w.name}</button>
            ))}
          </div>
        )}
        {grouped && onInitiative && (
          <Picker value={initiative === null ? ["*"] : [`=${initiative}`]} onChange={([id]) => onInitiative(id === "*" ? null : id.slice(1))}
            title="Show one initiative" options={[
              { id: "*", label: "All initiatives" },
              ...names.map((n) => ({ id: `=${n}`, label: n })),
              { id: `=${NO_INITIATIVE}`, label: "No initiative" },
            ]}>
            <span className={initiative === null ? "" : "ov-init-on"}>{initiative === null ? "All initiatives" : initiative || "No initiative"}</span><span className="caret">▾</span>
          </Picker>
        )}
        <button type="button" className={`toggle${filter.mine ? " is-on" : ""}`} aria-pressed={filter.mine} onClick={() => set({ mine: !filter.mine })}
          title="Show only the projects that have an issue in Your move.">Waits on me</button>
        {closedCount > 0 && (
          <button type="button" className={`toggle${filter.closed ? " is-on" : ""}`} aria-pressed={filter.closed} onClick={() => set({ closed: !filter.closed })}
            title="Also show the completed and canceled projects.">Closed <span className="mono">{closedCount}</span></button>
        )}
      </div>

      {list.workspaces.filter((w) => w.error).map((w) => <p key={w.id} className="empty" role="status">{w.error}</p>)}
      {!list.projects.length && !list.workspaces.some((w) => w.error) && <p className="empty">No projects. `wg load` makes one from plan.json.</p>}
      {list.projects.length > 0 && !rows.length && (
        <p className="empty">No project matches. <button type="button" className="ghost" onClick={() => { setFilter(START); onInitiative?.(null); }}>Clear the filters</button></p>
      )}

      {grouped ? sections.map((section) => {
        const first = rows.indexOf(section.rows[0]);
        return (
          <section key={section.key} className="ov-section" aria-label={section.name ?? "No initiative"}>
            <h2 className="ov-section-head">
              {onInitiative && initiative === null
                ? <button type="button" className="ov-section-name" onClick={() => onInitiative(section.name ?? NO_INITIATIVE)} title="Show only this initiative">{section.name ?? "No initiative"}</button>
                : <span className="ov-section-name">{section.name ?? "No initiative"}</span>}
              {multi && <span className="ov-ws">{section.workspaceName}</span>}
              <span className="ov-section-sum mono">
                {section.projects} {section.projects === 1 ? "project" : "projects"}
                {section.planned > 0 && ` · ${section.done}/${section.planned} done`}
                {section.running > 0 && ` · ${section.running} running`}
              </span>
              {section.you > 0 && <span className="ov-section-you"><Lamp signal="stop" /><b className="mono">{section.you}</b> for you</span>}
            </h2>
            <ul className="ov-list">{section.rows.map((row, i) => renderRow(row, first + i))}</ul>
          </section>
        );
      }) : <ul className="ov-list">{rows.map(renderRow)}</ul>}
    </div>
  );
}
