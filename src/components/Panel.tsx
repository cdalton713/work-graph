import { useEffect, useState } from "react";
import { api } from "../api";
import { CARD_PREFIX, ageText, cardText, type GNode, type Graph, isProtectedLabel, moveWarnings, reviewMark, reviewOf, runTime, satisfied, signalOf, sortStates, statusName, yourMove } from "../lib/graph";
import type { Comment, GraphData, IssuePatch, Issue, State } from "../lib/types";
import { Lamp, Picker, PrLinks, Rich } from "./ui";
import { type AgentRow, type Ask, type Progress, agentNeeds, agentState, liveJob } from "../lib/link";
import { Asks } from "./Asks";

const COMMENTS_MS = 60_000;
const PRIORITY = ["No priority", "Urgent", "High", "Medium", "Low"];
const WG_FIELDS: [string, string][] = [["key", "Key"], ["phase", "Phase"], ["lane", "Lane"], ["role", "Role"], ["branch", "Branch"], ["pr", "PR"], ["review", "Wave review"], ["merge_review", "Merge review"], ["code_done", "Code done"], ["state", "Worker"], ["job", "Job"], ["soak_until", "Soak until"]];

export interface PanelProps {
  node: GNode; now: number; graph: Graph; data: GraphData;
  /** Resolves to false when the server refused the change. */
  onPatch: (id: string, patch: IssuePatch, optimistic: Partial<Issue>) => Promise<boolean>;
  onGo: (id: string) => void; onClose: () => void; onError: (message: string) => void;
  /** Adds or removes the `reviewed` label. Absent when the team has no such label. */
  onReview?: (id: string) => void;
  /** The open questions of this issue's worker, from the link. */
  asks?: Ask[];
  /** Asks the coordinator to dispatch this node. Absent when no coordinator is linked. */
  onDispatch?: (key: string, issue: string) => Promise<void>;
  /** What the coordinator last reported about this node's job (from the link). */
  progress?: Progress;
  /** The agent in this node's worktree, as Orca reports it (`wg agents`). */
  agent?: AgentRow;
}

/** `note` says how many of these relations still hold, in the words of the canvas key. */
function Links({ title, ids, graph, onGo, note, clear }: { title: string; ids: string[]; graph: Graph; onGo: (id: string) => void; note: string; clear: boolean }) {
  if (!ids.length) return null;
  return (
    <section>
      <h3>{title} <span className="count">{ids.length}</span>{note && <span className={`count-note${clear ? " is-clear" : ""}`}>{note}</span>}</h3>
      {ids.map((id) => graph.byId.get(id)!).map((n) => (
        <button type="button" key={n.id} className="link-row" onClick={() => onGo(n.id)}>
          <Lamp signal={n.signal} /><span className="mono">{n.issue.identifier}</span>
          <span className="link-title">{n.issue.title}</span><span className="link-status">{n.status}</span>
        </button>
      ))}
    </section>
  );
}

export function Panel({ node, now, graph, data, onPatch, onGo, onClose, onError, onReview, asks, onDispatch, progress, agent }: PanelProps) {
  const { issue, card } = node;
  const elapsed = runTime(card, now);
  const team = data.teams[issue.teamId];
  const locked = issue.external || !team;
  const [title, setTitle] = useState(issue.title);
  const [draft, setDraft] = useState<string | null>(null);
  // The description that the draft started from. The server refuses a save when Linear has another text.
  const [base, setBase] = useState("");
  const [move, setMove] = useState<{ state: State; warnings: string[] } | null>(null);
  // An ops or decision node goes to a done status with its evidence or answer (the rule of `wg move --note`).
  const [note, setNote] = useState("");
  const noteWord = node.kind === "ops" ? "evidence" : node.kind === "decision" ? "answer" : null;
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    setDraft(null);
    setMove(null);
    setNote("");
    setReply("");
    setComments(null);
  }, [issue.id]);
  // A worker comments while the panel is open. Load the comments again when the issue changes, and
  // each minute, because a new comment does not always change the issue itself.
  useEffect(() => {
    let live = true;
    const load = () => api.comments(issue.id, data.workspace).then((c) => live && setComments(c)).catch((e) => live && onError(e.message));
    void load();
    const timer = setInterval(() => !document.hidden && void load(), COMMENTS_MS);
    return () => { live = false; clearInterval(timer); };
  }, [issue.id, issue.updatedAt, data.workspace]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setTitle(issue.title), [issue.title]);

  const patch = (p: IssuePatch, optimistic: Partial<Issue>) => onPatch(issue.id, p, optimistic);
  const saveDescription = () => {
    const text = draft;
    setDraft(null);
    if (text === null || text === base) return;
    // A refused save gives the draft back, so the text is not lost.
    void patch({ description: text, baseDescription: base }, { description: text }).then((saved) => { if (!saved) setDraft(text); });
  };
  const saveTitle = () => {
    const next = title.trim();
    if (next && next !== issue.title) patch({ title: next }, { title: next });
    else setTitle(issue.title);
  };
  const requestMove = (state: State) => {
    const warnings = moveWarnings(graph, issue.id, state);
    setNote("");
    if (warnings.length || (noteWord && state.type === "completed")) setMove({ state, warnings });
    else void patch({ stateId: state.id }, { state });
  };
  const send = async () => {
    setSending(true);
    try {
      const created = await api.comment(issue.id, reply.trim(), data.workspace);
      setComments((c) => [...(c ?? []), created]);
      setReply("");
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const states = team ? sortStates(team.states) : [];
  const teamLabels = data.labels.filter((l) => !l.teamId || l.teamId === issue.teamId);
  const freeLabels = teamLabels.filter((l) => !isProtectedLabel(l));
  const fixed = issue.labels.filter(isProtectedLabel);
  const setLabels = (ids: string[]) => {
    const chosen = freeLabels.filter((l) => ids.includes(l.id));
    patch({ labelIds: [...fixed.map((l) => l.id), ...chosen.map((l) => l.id)] }, { labels: [...fixed, ...chosen] });
  };
  const notes = card && issue.card ? cardText(issue.card.body) : "";
  const blockers = graph.blockers.get(node.id) ?? [], dependents = graph.dependents.get(node.id) ?? [];
  const open = blockers.filter((id) => !satisfied(graph.byId.get(id)!, node)).length;
  const held = dependents.filter((id) => !satisfied(node, graph.byId.get(id)!)).length;
  const thread = comments?.filter((c) => !c.body.startsWith(CARD_PREFIX)) ?? [];

  return (
    <aside className="panel">
      <header className="panel-head">
        <Lamp signal={node.signal} />
        <a className="mono panel-id" href={issue.url} target="_blank" rel="noreferrer" title="Open in Linear">{issue.identifier} ↗</a>
        <span className="chip">{node.kind}</span>
        {node.claim && <span className="chip chip-claim"><Lamp signal="running" pulse />{node.claim}</span>}
        <span className="station-fill" />
        <button type="button" className="ghost" onClick={onClose} aria-label="Close panel">✕</button>
      </header>

      <div className="panel-body" key={issue.id}>
        {locked && (
          <p className="notice">
            {issue.external
              ? `${issue.identifier} is in team ${issue.teamKey}, outside this project${card ? "; wg maps it as a node of this effort" : ""}. `
              : `${issue.identifier} is in team ${issue.teamKey}. `}
            This page writes only to its own team, so the issue is read-only here. <a href={issue.url} target="_blank" rel="noreferrer">Change it in Linear ↗</a>
          </p>
        )}
        {agent && (
          <p className={`notice panel-agent${agentNeeds(agent) ? " is-warning" : ""}`} title={agent.title || undefined}>
            <b>Agent in Orca:</b> {agent.agent} {agentState(agent).text}{agent.at ? ` · ${ageText(now - Date.parse(agent.at))}` : ""}
            {agent.said && <span className="panel-agent-said">{agent.said}</span>}
          </p>
        )}
        {asks && asks.length > 0 && <Asks asks={asks} projectId={data.project.id} workspace={data.workspace} now={now} onError={onError} />}
        {/* `wg load` sets the title of a node from plan.json, so the title of a node is not changed here. */}
        <textarea className="title-input" rows={2} value={title} readOnly={locked || !!card}
          title={card && !locked ? "plan.json has the title of a wg node. Change it there, then run `wg load --apply`." : undefined} onChange={(e) => setTitle(e.target.value)} onBlur={saveTitle}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } }} />

        {/* What wg next says about this node comes first: it is the action. */}
        {card?.next && (
          <div className={`next-action${yourMove(card.next) ? " is-you" : ""}`}>
            <span className="next-mark">wg next</span>
            <div className="next-lines mono">{card.next.split("\n").map((line) => <div key={line}>{line}</div>)}</div>
            {onDispatch && card.key && /(^|\n)do dispatch\b/.test(card.next) && (
              <button type="button" className="primary" onClick={() => void onDispatch(card.key!, issue.identifier)}
                title="wg next says this node can be dispatched. The coordinator dispatches it at once if it listens, else at its next wg next.">Dispatch</button>
            )}
          </div>
        )}

        <dl className="fields">
          <dt>Status</dt>
          <dd>
            <Picker disabled={locked} value={[issue.state.id]} onChange={([id]) => requestMove(states.find((s) => s.id === id)!)}
              options={states.map((s) => ({ id: s.id, label: s.name, lead: <Lamp signal={signalOf(statusName(s), s.type)} /> }))}>
              <Lamp signal={node.signal} />{issue.state.name}
            </Picker>
          </dd>
          <dt>Priority</dt>
          <dd>
            <Picker disabled={locked} value={[String(issue.priority)]} onChange={([p]) => patch({ priority: Number(p) }, { priority: Number(p) })}
              options={PRIORITY.map((label, i) => ({ id: String(i), label }))}>
              {PRIORITY[issue.priority] ?? "No priority"}
            </Picker>
          </dd>
          <dt>Assignee</dt>
          <dd>
            <Picker disabled={locked} value={[issue.assignee?.id ?? "none"]}
              onChange={([id]) => patch({ assigneeId: id === "none" ? null : id }, { assignee: team?.members.find((m) => m.id === id) ?? null })}
              options={[{ id: "none", label: "No assignee" }, ...(team?.members ?? []).map((m) => ({ id: m.id, label: m.name, hint: m.id === data.viewerId ? "you" : undefined }))]}>
              {issue.assignee?.name ?? "No assignee"}
            </Picker>
          </dd>
          <dt>Labels</dt>
          <dd className="labels">
            {fixed.map((l) => <span key={l.id} className="chip chip-fixed" title="Set by wg or the coordinator">{l.name}</span>)}
            {issue.labels.filter((l) => !isProtectedLabel(l)).map((l) => <span key={l.id} className="chip"><i style={{ background: l.color }} />{l.name}</span>)}
            {!locked && (
              <Picker multi value={issue.labels.map((l) => l.id)} onChange={setLabels}
                options={freeLabels.map((l) => ({ id: l.id, label: l.name, hint: l.group ?? undefined, lead: <i className="dot" style={{ background: l.color }} /> }))}>
                Edit
              </Picker>
            )}
          </dd>
          {issue.pullRequests.length > 0 && <dt>Pull request</dt>}
          {issue.pullRequests.length > 0 && (
            <dd className="prs">
              {issue.pullRequests.map((pr) => (
                <div key={pr.url} className="pr-row" title={pr.title}>
                  <span className="mono">#{pr.number}</span><span className="pr-status">{pr.status}</span><PrLinks pr={pr} />
                </div>
              ))}
            </dd>
          )}
        </dl>

        {onReview && !locked && node.kind === "task" && (issue.pullRequests.length > 0 || card?.pr) && (() => {
          const { marked } = reviewOf(issue, card);
          return (
            <div className="review-row">
              <button type="button" className={marked ? "" : "primary"} onClick={() => onReview(issue.id)}
                title="The `reviewed` label on the issue. It counts as the wave review and the merge review of this PR, and it accepts findings that are still open.">
                {marked ? "Remove “reviewed”" : "Mark reviewed"}
              </button>
              <span>{marked ? "You marked this PR reviewed." : reviewMark(issue, card)?.title ?? "No review passed yet."}</span>
            </div>
          );
        })()}

        {move && (() => {
          const needsNote = !!noteWord && move.state.type === "completed";
          const go = () => {
            const text = note.trim();
            setMove(null);
            // A refused move gives the form back with its text.
            void patch({ stateId: move.state.id, ...(needsNote && { note: text }) }, { state: move.state }).then((saved) => { if (!saved) { setMove(move); setNote(text); } });
          };
          return (
            <div className={move.warnings.length ? "warning" : "warning warning-form"} role={move.warnings.length ? "alert" : "group"}>
              <strong>{issue.identifier} to {move.state.name}{move.warnings.length ? ": this breaks the graph order." : ""}</strong>
              {move.warnings.map((w) => <p key={w}>{w}</p>)}
              {needsNote && (
                <>
                  <p>{noteWord === "evidence"
                    ? "Give the evidence: what you deployed or ran (commit or version, environment), the check, and its result."
                    : "Give your answer to this decision."} It becomes a comment on the issue, then the issue moves.</p>
                  <textarea className="editor" autoFocus rows={4} value={note} aria-label={`The ${noteWord} for ${issue.identifier}`}
                    placeholder={noteWord === "evidence" ? "abc1234 to beta at 14:05; check: /healthz and one order; result: 200, order saved" : "Yes: cut over on Monday"}
                    onChange={(e) => setNote(e.target.value)} />
                </>
              )}
              <div className="row">
                <button type="button" className={move.warnings.length ? "danger" : "primary"} disabled={needsNote && !note.trim()} onClick={go}>
                  {move.warnings.length ? "Move anyway" : `Move to ${move.state.name}`}
                </button>
                <button type="button" onClick={() => setMove(null)}>Keep {issue.state.name}</button>
              </div>
            </div>
          );
        })()}

        {card && (
          <section className="wg">
            <h3>Work graph</h3>
            <dl className="fields fields-wg">
              {/* The PR shows above, with its links, when Linear has it as an attachment. */}
              {WG_FIELDS.filter(([f]) => card[f as keyof typeof card] && !(f === "pr" && issue.pullRequests.some((p) => String(p.number) === card.pr))).map(([f, label]) => (
                <div key={f}><dt>{label}</dt><dd className="mono">{f === "pr" ? `#${card.pr}` : card[f as keyof typeof card]}</dd></div>
              ))}
              {progress && (liveJob(progress) || progress.evidence) && (
                <div className="wide" title="Reported by the coordinator through the link, before it reaches Linear."><dt>Live</dt>
                  <dd className="mono live-job">{[liveJob(progress), progress.evidence && `tests ${progress.evidence}`, progress.ci && `CI ${progress.ci}`].filter(Boolean).join(" · ")}</dd></div>
              )}
              {elapsed && <div><dt>Run time</dt><dd className={`mono run-time${elapsed.warning ? " run-warning" : ""}`}>{elapsed.text}</dd></div>}
            </dl>
            {notes && <Rich text={notes} />}
          </section>
        )}

        <Links title="Blocked by" ids={blockers} graph={graph} onGo={onGo} clear={!open} note={open ? `${open} open` : "all done"} />
        <Links title="Blocks" ids={dependents} graph={graph} onGo={onGo} clear={!held} note={held ? `${held} ${held === 1 ? "waits" : "wait"} on this` : ""} />

        <section>
          <h3>Description
            {!locked && draft === null && <button type="button" className="ghost" onClick={() => { setBase(issue.description); setDraft(issue.description); }}>Edit</button>}
          </h3>
          {draft === null ? (issue.description ? <Rich text={issue.description} /> : <p className="empty">No description.</p>) : (
            <>
              {issue.description !== base && <p className="notice">The description changed in Linear after you opened it. Copy your text, cancel, and edit the new description.</p>}
              <textarea className="editor" autoFocus rows={14} value={draft} onChange={(e) => setDraft(e.target.value)} />
              <div className="row">
                <button type="button" className="primary" onClick={saveDescription}>Save</button>
                <button type="button" onClick={() => setDraft(null)}>Cancel</button>
              </div>
            </>
          )}
        </section>

        <section>
          <h3>Comments {comments && <span className="count">{thread.length}</span>}</h3>
          {comments === null && <p className="empty">Loading comments…</p>}
          {comments && !thread.length && <p className="empty">No comments.</p>}
          {thread.map((c) => (
            <article key={c.id} className={`comment${c.parentId ? " comment-reply" : ""}`}>
              <header><strong>{c.author}</strong><time>{new Date(c.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</time></header>
              <Rich text={c.body} />
            </article>
          ))}
          <textarea className="editor" rows={3} placeholder="Add a comment (Markdown). ⌘↵ sends it." value={reply} onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && reply.trim() && !sending) void send(); }} />
          <div className="row"><button type="button" className="primary" disabled={!reply.trim() || sending} onClick={() => void send()}>{sending ? "Sending…" : "Comment"}</button></div>
        </section>
      </div>
    </aside>
  );
}
