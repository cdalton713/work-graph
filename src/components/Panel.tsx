import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { CARD_PREFIX, ageText, cardText, type GNode, type Graph, isProtectedLabel, moveWarnings, reviewMark, reviewOf, runTime, satisfied, signalOf, sortStates, statusName, yourMove } from "../lib/graph";
import type { Comment, GraphData, IssuePatch, Issue, State } from "../lib/types";
import { Hint, Lamp, Picker, PrLinks, Rich, Sheet } from "./ui";
import { type AgentRow, type Ask, type Progress, agentNeeds, agentState, liveJob } from "../lib/link";
import type { ClaimMark } from "../lib/claims";
import { site } from "../lib/site";
import { Asks } from "./Asks";
import { Reply } from "./Reply";
import { latestReplyPrompt } from "../lib/reply";
import { parseOptions } from "../lib/options";
import { useNarrow } from "../lib/screen";

const COMMENTS_MS = 60_000;
const PRIORITY = ["No priority", "Urgent", "High", "Medium", "Low"];
const WG_FIELDS: [string, string][] = [["key", "Key"], ["phase", "Phase"], ["lane", "Lane"], ["role", "Role"], ["branch", "Branch"], ["pr", "PR"], ["review", "Wave review"], ["merge_review", "Merge review"], ["code_done", "Code done"], ["state", "Worker"], ["job", "Job"]];

export interface PanelProps {
  claim?: ClaimMark;
  onRelease?: (node: string) => Promise<void>;
  node: GNode; now: number; graph: Graph; data: GraphData;
  /** Resolves to false when the server refused the change. */
  onPatch: (id: string, patch: IssuePatch, optimistic: Partial<Issue>) => Promise<boolean>;
  onShowInGraph?: () => void;
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
  /** The viewer: the panel shows the issue with no control that writes. */
  readOnly?: boolean;
  limitedEdits?: boolean;
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

export function Panel({ node, claim, onRelease, now, graph, data, onPatch, onGo, onClose, onShowInGraph, onError, onReview, asks, onDispatch, progress, agent, readOnly = false, limitedEdits = false }: PanelProps) {
  const { issue, card } = node;
  const phone = useNarrow();
  const body = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const settings = { ...site, waitNames: data.waitNames };
  const [releasing, setReleasing] = useState(false);
  async function release() {
    if (!onRelease || !claim || !window.confirm(`Release the stale claim held by ${claim.holder}?`)) return;
    setReleasing(true);
    try {
      await onRelease(claim.node);
    } catch (error) {
      onError(`Claim not released: ${(error as Error).message}`);
    } finally {
      setReleasing(false);
    }
  }
  const elapsed = runTime(card, now);
  const team = data.teams[issue.teamId];
  // The issue of another team, and each issue on the viewer, has no control that writes.
  const foreign = issue.external || !team;
  const locked = foreign || readOnly;
  const [title, setTitle] = useState(issue.title);
  const [draft, setDraft] = useState<string | null>(null);
  // The description that the draft started from. The server refuses a save when Linear has another text.
  const [base, setBase] = useState("");
  const [move, setMove] = useState<{ state: State; warnings: string[] } | null>(null);
  // An ops or decision node goes to a done status with its evidence or answer (the rule of `wg move --note`).
  const noteWord = node.kind === "ops" ? "evidence" : node.kind === "decision" ? "answer" : null;
  const [comments, setComments] = useState<Comment[] | null>(null);
  const waitingForReply = !locked && node.status === settings.waitStatus
    && !issue.labels.some((label) => label.name === "answered");
  const replyOptions = waitingForReply ? parseOptions(latestReplyPrompt(comments ?? []) ?? "").options : [];

  useEffect(() => {
    setDraft(null);
    setMove(null);
    setComments(null);
    setMore(false);
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
    if (warnings.length || (noteWord && state.type === "completed")) setMove({ state, warnings });
    else void patch({ stateId: state.id }, { state });
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

  const dispatch = onDispatch && card?.key && /(^|\n)do dispatch\b/.test(card.next ?? "") ? (
    <button type="button" className="primary" onClick={() => void onDispatch(card.key!, issue.identifier)}>Dispatch</button>
  ) : null;
  const { marked } = reviewOf(issue, card);
  const review = onReview && !locked && node.kind === "task" && (issue.pullRequests.length > 0 || card?.pr) ? (
    <button type="button" className={marked ? "" : "primary"} onClick={() => onReview(issue.id)}>
      {marked ? "Remove “reviewed”" : "Mark reviewed"}
    </button>
  ) : null;
  const completion = states.findLast((state) => state.type === "completed");
  const showAnswer = waitingForReply || (!readOnly && !!asks?.length);
  const focusAnswer = () => {
    setMore(false);
    const editor = body.current?.querySelector<HTMLTextAreaElement>(".asks textarea, textarea[aria-label='Comment']");
    requestAnimationFrame(() => editor?.focus());
  };
  const openCompletion = () => {
    if (!completion) return;
    setMore(false);
    requestMove(completion);
    requestAnimationFrame(() => body.current?.querySelector<HTMLTextAreaElement>(".warning textarea")?.focus());
  };
  const actions: ReactNode[] = [dispatch, review, showAnswer && (
    <button type="button" onClick={focusAnswer}>Answer</button>
  ), !locked && completion && noteWord && issue.state.type !== "completed" && (
    <button type="button" onClick={openCompletion}>{noteWord === "evidence" ? "Record evidence" : "Record answer"}</button>
  )].filter(Boolean);

  const titleField = <textarea className="title-input" aria-label="Issue title" rows={2} value={title} readOnly={locked || limitedEdits || !!card}
          onChange={(e) => setTitle(e.target.value)} onBlur={saveTitle}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } }} />;

  const agentDetails = agent && (
    <><b>Agent in Orca:</b> {agent.agent} {agentState(agent).text}{agent.at ? ` · ${ageText(now - Date.parse(agent.at))}` : ""}</>
  );

  const pullRequests = (
    <div className="prs">
      {issue.pullRequests.map((pr) => {
        const row = <div className="pr-row">
          <span className="mono">#{pr.number}</span><span className="pr-status">{pr.status}</span><PrLinks pr={pr} linkHints />
          {phone && pr.title && <span className="panel-pr-title">{pr.title}</span>}
        </div>;
        return pr.title && !phone
          ? <Hint key={pr.url} text={pr.title} infoLabel={`About PR #${pr.number}`}>{row}</Hint>
          : <div key={pr.url}>{row}</div>;
      })}
    </div>
  );

  return (
    <aside className="panel">
      <header className="panel-head">
        <Lamp signal={node.signal} />
        <a className="mono panel-id" href={issue.url} target="_blank" rel="noreferrer" aria-label={`Open ${issue.identifier} in Linear`}>{issue.identifier} ↗</a>
        <span className="chip">{node.kind}</span>
        {node.claim && <span className="chip chip-claim"><Lamp signal="running" pulse />{node.claim}</span>}
        <span className="station-fill" />
        <button type="button" className="ghost" onClick={onClose} aria-label="Close panel">✕</button>
      </header>

      <div className="panel-body" key={issue.id} ref={body}>
        {onShowInGraph && <button type="button" className="show-in-graph" onClick={onShowInGraph}>Show in graph</button>}
        {claim && <div className={`notice${claim.stale ? " is-warning" : ""}`}>
          <div>Runner: {claim.holder} · {claim.job} · since <time dateTime={claim.claimedAt}>{new Date(claim.claimedAt).toLocaleString()}</time></div>
          {claim.stale && <div>⚠ No sign of {claim.holder}'s coordinator since <time dateTime={claim.renewedAt}>{new Date(claim.renewedAt).toLocaleString()}</time></div>}
          {onRelease && <button type="button" className="ghost" disabled={releasing} onClick={() => void release()}>
            {releasing ? "Releasing…" : "Release"}
          </button>}
        </div>}
        {node.waitsOnOther && <p className="notice">This issue waits on {node.waitsOnOther}.</p>}
        {foreign && !readOnly && (
          <p className="notice">
            {issue.external
              ? `${issue.identifier} is in team ${issue.teamKey}, outside this project${card ? "; wg maps it as a node of this effort" : ""}. `
              : `${issue.identifier} is in team ${issue.teamKey}. `}
            This page writes only to its own team, so the issue is read-only here. <a href={issue.url} target="_blank" rel="noreferrer">Change it in Linear ↗</a>
          </p>
        )}
        {agent && (
          <p className={`notice panel-agent${agentNeeds(agent) ? " is-warning" : ""}`}>
            {agent.title ? <Hint text={agent.title} infoLabel="About the agent">{agentDetails}</Hint> : agentDetails}
            {agent.said && <span className="panel-agent-said">{agent.said}</span>}
          </p>
        )}
        {!readOnly && asks && asks.length > 0 && <Asks asks={asks} projectId={data.project.id} workspace={data.workspace} now={now} />}
        {card && !locked ? (
          <Hint text="plan.json has the title of a wg node. Change it there, then run wg load --apply."
            infoLabel="About the issue title" className="panel-title-hint">{titleField}</Hint>
        ) : titleField}

        {/* What wg next says about this node comes first: it is the action. */}
        {card?.next && (
          <div className={`next-action${!node.waitsOnOther && yourMove(card.next) ? " is-you" : ""}`}>
            <span className="next-mark">wg next</span>
            <div className="next-lines mono">{card.next.split("\n").map((line) => <div key={line}>{line}</div>)}</div>
            {dispatch && <Hint text="The coordinator dispatches this node now if it is listening, or at its next wg next."
              infoLabel="About Dispatch">{!phone && dispatch}</Hint>}
          </div>
        )}

        <dl className="fields">
          <dt>Status</dt>
          <dd>
            <Picker label="Status" disabled={locked} value={[issue.state.id]} onChange={([id]) => requestMove(states.find((s) => s.id === id)!)}
              options={states.map((s) => ({ id: s.id, label: s.name, lead: <Lamp signal={signalOf(statusName(s, [], settings), s.type, settings)} /> }))}>
              <Lamp signal={node.signal} />{issue.state.name}
            </Picker>
          </dd>
          <dt>Priority</dt>
          <dd>
            <Picker label="Priority" disabled={locked || limitedEdits} value={[String(issue.priority)]} onChange={([p]) => patch({ priority: Number(p) }, { priority: Number(p) })}
              options={PRIORITY.map((label, i) => ({ id: String(i), label }))}>
              {PRIORITY[issue.priority] ?? "No priority"}
            </Picker>
          </dd>
          <dt>Assignee</dt>
          <dd>
            <Picker label="Assignee" disabled={locked || limitedEdits} value={[issue.assignee?.id ?? "none"]}
              onChange={([id]) => patch({ assigneeId: id === "none" ? null : id }, { assignee: team?.members.find((m) => m.id === id) ?? null })}
              options={[{ id: "none", label: "No assignee" }, ...(team?.members ?? []).map((m) => ({ id: m.id, label: m.name, hint: m.id === data.viewerId ? "you" : undefined }))]}>
              {issue.assignee?.name ?? "No assignee"}
            </Picker>
          </dd>
          <dt>Labels</dt>
          <dd className="labels">
            {fixed.map((l) => <Hint key={l.id} text="Set by wg or the coordinator." infoLabel={`About ${l.name}`}><span className="chip chip-fixed">{l.name}</span></Hint>)}
            {issue.labels.filter((l) => !isProtectedLabel(l)).map((l) => <span key={l.id} className="chip"><i style={{ background: l.color }} />{l.name}</span>)}
            {!locked && (
              <Picker label="Labels" multi value={issue.labels.map((l) => l.id)} onChange={setLabels}
                options={freeLabels.map((l) => ({ id: l.id, label: l.name, hint: l.group ?? undefined, lead: <i className="dot" style={{ background: l.color }} /> }))}>
                Edit
              </Picker>
            )}
          </dd>
          {!phone && issue.pullRequests.length > 0 && <dt>Pull request</dt>}
          {!phone && issue.pullRequests.length > 0 && <dd>{pullRequests}</dd>}
        </dl>

        {review && (
          <div className="review-row">
            <Hint text="This accepts the wave review, the merge review, and any open findings for this PR."
              infoLabel="About Mark reviewed">{!phone && review}</Hint>
            <span>{marked ? "You marked this PR reviewed." : reviewMark(issue, card)?.title ?? "No review passed yet."}</span>
          </div>
        )}

        {move && (() => {
          const needsNote = !!noteWord && move.state.type === "completed";
          const go = async (note: string) => {
            const saved = await patch({ stateId: move.state.id, note }, {});
            if (!saved) throw new Error("The issue update was refused. See the page error for details.");
            setMove((current) => current === move ? null : current);
          };
          const moveLabel = move.warnings.length ? "Move anyway" : `Move to ${move.state.name}`;
          const cancel = { label: `Keep ${issue.state.name}`, run: () => setMove(null) };
          return (
            <div className={move.warnings.length ? "warning" : "warning warning-form"} role={move.warnings.length ? "alert" : "group"}>
              <strong>{issue.identifier} to {move.state.name}{move.warnings.length ? ": this breaks the graph order." : ""}</strong>
              {move.warnings.map((w) => <p key={w}>{w}</p>)}
              {needsNote ? (
                <>
                  <p>{noteWord === "evidence"
                    ? "Give the evidence: what you deployed or ran (commit or version, environment), the check, and its result."
                    : "Give your answer to this decision."} It becomes a comment on the issue, then the issue moves.</p>
                  <Reply autoFocus rows={4} label={moveLabel} fieldLabel={`The ${noteWord} for ${issue.identifier}`}
                    draftKey={[data.workspace ?? site.defaultWorkspace, data.project.id, issue.id, noteWord]}
                    placeholder={noteWord === "evidence" ? "abc1234 to beta at 14:05; check: /healthz and one order; result: 200, order saved" : "Yes: cut over on Monday"}
                    literalInput={noteWord === "evidence"} danger={!!move.warnings.length} cancel={cancel} send={go} />
                </>
              ) : (
                <div className="row">
                  <button type="button" className="danger" onClick={() => {
                    setMove(null);
                    void patch({ stateId: move.state.id }, { state: move.state }).then((saved) => {
                      if (!saved) setMove(move);
                    });
                  }}>{moveLabel}</button>
                  <button type="button" onClick={cancel.run}>{cancel.label}</button>
                </div>
              )}
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
              {card.wave === "yes" && <div><dt>Wave</dt><dd>In the current wave.</dd></div>}
              {card.soak_until && <div><dt>Soak ends</dt><dd className="mono">
                <time dateTime={card.soak_until}>{new Date(card.soak_until).toLocaleString()}</time>
              </dd></div>}
              {progress && (liveJob(progress) || progress.evidence) && (
                <div className="wide"><dt>Live</dt>
                  <dd className="mono live-job">
                    <Hint text="Reported by the coordinator through the link, before it reaches Linear." infoLabel="About live progress">
                      {[liveJob(progress), progress.evidence && `tests ${progress.evidence}`, progress.ci && `CI ${progress.ci}`].filter(Boolean).join(" · ")}
                    </Hint>
                  </dd></div>
              )}
              {elapsed && <div><dt>Run time</dt><dd className={`mono run-time${elapsed.warning ? " run-warning" : ""}`}>{elapsed.text}</dd></div>}
            </dl>
            {notes && <Rich linkHints text={notes} />}
          </section>
        )}

        <Links title="Blocked by" ids={blockers} graph={graph} onGo={onGo} clear={!open} note={open ? `${open} open` : "all done"} />
        <Links title="Blocks" ids={dependents} graph={graph} onGo={onGo} clear={!held} note={held ? `${held} ${held === 1 ? "waits" : "wait"} on this` : ""} />

        <section>
          <h3>Description
            {!locked && !limitedEdits && draft === null && <button type="button" className="ghost" onClick={() => { setBase(issue.description); setDraft(issue.description); }}>Edit</button>}
          </h3>
          {draft === null ? (issue.description ? <Rich linkHints text={issue.description} /> : <p className="empty">No description.</p>) : (
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
              <Rich linkHints text={c.body} />
            </article>
          ))}
          {!readOnly && (
            <Reply options={replyOptions} label="Comment" placeholder="Add a comment (Markdown)."
              draftKey={[data.workspace ?? site.defaultWorkspace, data.project.id, issue.id, "comment"]} send={async (body) => {
              const created = await api.comment(issue.id, body, data.workspace, data.project.id);
              setComments((c) => [...(c ?? []), created]);
            }} />
          )}
        </section>
      </div>
      {phone && (actions.length > 0 || issue.pullRequests.length > 0) && (
        <footer className="panel-actions" aria-label="Issue actions">
          {actions.slice(0, 2).map((action, index) => <div key={index}>{action}</div>)}
          {(actions.length > 2 || issue.pullRequests.length > 0) && (
            <button type="button" aria-haspopup="dialog" onClick={() => setMore(true)}>More</button>
          )}
          {more && <Sheet open title="More issue actions" onClose={() => setMore(false)}>
            <div className="panel-more">
              {actions.slice(2).map((action, index) => (
                <div key={index}>{action}</div>
              ))}
              {issue.pullRequests.length > 0 && <section>
                <h3>Pull requests</h3>
                {pullRequests}
              </section>}
            </div>
          </Sheet>}
        </footer>
      )}
    </aside>
  );
}
