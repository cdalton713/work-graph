import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { agentReplyLine, agentReplyPending, applyAgentReplyResult, canReplyToAgent, inboxReply, issueReplyReceipt, latestReplyPrompt, type AgentReplyReceipt, type InboxReply } from "../lib/reply";
import { Reply } from "./Reply";
import { parseOptions } from "../lib/options";
import { ownerWords } from "../lib/words";
import { type OverviewData, type OverviewFilter, type OverviewRow, type YourMove, NO_INITIATIVE, countProjectStates, filterProjectStates, initiativeNames, initiativeSections, movesWithAgents, movesWithAsks, overviewMoveReason, overviewRows, summaryKey } from "../lib/overview";
import { ageText, compareMoves, type Signal } from "../lib/graph";
import { PROJECT_STATES, type ProjectStateName, type Stall, overviewTitle } from "../lib/attention";
import { type AgentReplyResult, type Agents, type Ask, type Presence, type ProjectRef, agentName, agentNeeds, agentState, agentsFresh, agentsShown, presenceText, projectKey } from "../lib/link";
import { site } from "../lib/site";
import { useNarrow } from "../lib/screen";
import { useLink } from "../useLink";
import type { Comment, Project, ProjectList } from "../lib/types";
import { CopyButton, Hint, Lamp, Picker, PrLinks, Rich } from "./ui";

const STORE = "wg-overview";
/** The inbox items that show before "Show all". */
const INBOX = 8;
const ALL_INITIATIVES: readonly string[] = [];
const START: OverviewFilter = { text: "", workspace: null, closed: false };
const COORDINATOR_DISPLAY = {
  listening: { label: "Listening", signal: "done" },
  working: { label: "Working", signal: "running" },
  gone: { label: "Offline", signal: "off" },
  needs: { label: "Waiting", signal: "stop" },
  unknown: { label: "None", signal: "off" },
} satisfies Record<string, { label: string; signal: Signal }>;
const NO_STATES: ProjectStateName[] = [];
const STATE_DISPLAY = {
  stalled: { label: "Stalled", signal: "stop" },
  waits: { signal: "stop" },
  moving: { label: "Moving", signal: "running" },
  idle: { label: "Not running", signal: "idle" },
} satisfies Record<ProjectStateName, { label?: string; signal: Signal }>;

function stored(): OverviewFilter {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? "null") as Partial<OverviewFilter> | null;
    return { ...START, workspace: saved?.workspace ?? null, closed: saved?.closed ?? false };
  } catch {
    return START;
  }
}

type SentWorker = { project: Project; move: YourMove };
type InboxRow = SentWorker & { stall: Stall | null };
const INBOX_FILTERS = [
  { id: "all", label: "All", empty: "No inbox items in this scope." },
  { id: "questions", label: "Questions", empty: "No questions in this scope." },
  { id: "stalls", label: "Possible stalls", empty: "No possible stalls in this scope." },
  { id: "actions", label: "Other actions", empty: "No other actions in this scope." },
] as const;
type InboxFilter = typeof INBOX_FILTERS[number]["id"];

function inboxCategory({ move, stall }: InboxRow): Exclude<InboxFilter, "all"> {
  if (stall) return "stalls";
  return move.workerAsk || move.agentWait || move.answer ? "questions" : "actions";
}

function inboxKey({ project, move, stall }: InboxRow) {
  const key = summaryKey(project);
  if (stall) return `${key}:stall:${stall.kind}:${stall.issue ?? ""}`;
  if (move.workerAsk) return `${key}:worker:${move.workerAsk.id}`;
  if (move.answer) return `${key}:issue:${move.answer.issueId}`;
  return `${key}:move:${move.agentWait?.id ?? move.identifier}`;
}

function inboxTimestamp(move: YourMove) {
  return move.agentWait?.at ?? move.updatedAt;
}

function compareInboxRows(a: InboxRow, b: InboxRow) {
  return Number(!!b.stall) - Number(!!a.stall)
    || compareMoves({ ...a.move, updatedAt: inboxTimestamp(a.move) }, { ...b.move, updatedAt: inboxTimestamp(b.move) })
    || inboxKey(a).localeCompare(inboxKey(b));
}

function InboxAnswer({ target, project, expanded, submitted, onSent }: {
  target: InboxReply; project: Project; expanded: boolean; submitted: boolean; onSent: (comment?: Comment) => void;
}) {
  const issueId = target.kind === "issue" ? target.issueId : null;
  const [prompt, setPrompt] = useState<{ body?: string; error?: string } | null>(null);
  useEffect(() => {
    if (!expanded || !issueId) return;
    let live = true;
    setPrompt(null);
    api.comments(issueId, project.workspace, project.id)
      .then((comments) => { if (live) setPrompt({ body: latestReplyPrompt(comments) }); })
      .catch((error: Error) => { if (live) setPrompt({ error: error.message }); });
    return () => { live = false; };
  }, [expanded, issueId, project.workspace, project.id]);

  const body = target.kind === "worker" ? target.ask.body : prompt?.body ?? "";
  const { question, options } = parseOptions(submitted ? "" : body);
  return (
    <>
      {target.kind === "worker"
        ? <Rich text={submitted ? body : question} />
        : prompt?.error
          ? <p role="alert" className="sig-fg-stop">Could not load the last comment. {prompt.error}</p>
          : prompt?.body
            ? <Rich text={submitted ? body : question} />
            : !prompt && <p role="status">Loading the last comment…</p>}
      {!submitted && <Reply options={options} label={target.kind === "worker" ? "Reply to the worker" : "Send answer"}
        draftKey={[project.workspace ?? site.defaultWorkspace, project.id, ...(target.kind === "worker" ? ["worker", target.ask.id] : [target.issueId, "comment"])]}
        accessHref={`?${new URLSearchParams({ workspace: project.workspace ?? site.defaultWorkspace, project: project.id })}`}
        placeholder="Write a reply. ⌘↵ sends it." send={async (body) => {
          if (target.kind === "worker") {
            await api.reply(project.id, target.ask.id, body, project.workspace);
            onSent();
          } else {
            const comment = await api.comment(target.issueId, body, project.workspace, project.id);
            onSent(comment);
          }
        }} />}
    </>
  );
}

type ProjectReply = AgentReplyReceipt & { project: ProjectRef };

function AgentReplyUpdates({ project, onResult }: { project: ProjectRef; onResult: (result: AgentReplyResult) => void }) {
  // The link replays completed replies on a project socket, including after a reload.
  useLink(project, () => {}, onResult);
  return null;
}

function messageCut(said: string): boolean {
  return said.endsWith("…") && [...said].length >= 500;
}

export interface OverviewProps {
  managedPullRefresh?: boolean;
  /** The project list alone, until the first overview answer comes. */
  list: OverviewData | ProjectList;
  loading: boolean; missing: string | null; now: number; readOnly?: boolean;
  onOpen: (project: Project, issue?: string) => void;
  /** The coordinators of each project, by `workspace:id`, from the link. */
  presence?: Map<string, Presence>;
  /** The open questions of the workers of each project, by `workspace:id`, from the link. Each one is a move of the human's. */
  asks?: Map<string, Ask[]>;
  /** The agents of each project, by `workspace:id`, from the link (`wg agents`). One that waits at a prompt is a move of the human's. */
  agents?: Map<string, Agents>;
  /** The initiative selection from the link. An empty selection shows all projects. */
  initiatives?: readonly string[];
  onInitiatives?: (names: string[]) => void;
  states?: ProjectStateName[];
  onStates?: (states: ProjectStateName[]) => void;
  /** The workspaces with a low Linear budget (`budgetWarnings`). */
  budget?: { id: string; text: string; title: string }[];
}

/**
 * All projects on one page: which ones wait on the human, how far each is, and what wg next last said.
 * `/` finds a project, the arrow keys move, Enter opens.
 */
export function Overview({ list: given, loading, missing, now, onOpen, presence, asks, agents, readOnly = false, initiatives = ALL_INITIATIVES, onInitiatives, states = NO_STATES, onStates, budget = [], managedPullRefresh }: OverviewProps) {
  const narrow = useNarrow();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterButton = useRef<HTMLButtonElement>(null);
  const words = ownerWords();
  const stateLabel = (state: ProjectStateName) => state === "waits" ? words.waitsFilter : STATE_DISPLAY[state].label;
  const viewerWorkspaces = useMemo(() => new Set(given.workspaces.filter((w) => w.role === "viewer").map((w) => w.id)), [given.workspaces]);
  const sharedWorkspaces = new Set(given.workspaces.filter((w) => w.role).map((w) => w.id));
  const list = useMemo<OverviewData | ProjectList>(() => ("summaries" in given && (asks?.size || agents?.size)
    ? { ...given, summaries: given.summaries.map((s) => {
      if (readOnly || viewerWorkspaces.has(s.workspace)) return s;
      return { ...s, you: movesWithAgents(movesWithAsks(s.you, asks?.get(summaryKey(s)), s.moveImpacts), agents?.get(summaryKey(s)), now, s.moveImpacts) };
    }) }
    : given), [given, asks, agents, now, readOnly, viewerWorkspaces]);
  const receiptStore = `wg-agent-replies:${site.user ?? "local"}`;
  const [receipts, setReceipts] = useState<ProjectReply[]>(() => {
    try {
      const saved: unknown = JSON.parse(sessionStorage.getItem(receiptStore) ?? "[]");
      return Array.isArray(saved) ? saved.map((receipt: ProjectReply) => ({ ...receipt, sentAt: receipt.sentAt ?? Date.now() })) : [];
    } catch { return []; }
  });
  useEffect(() => {
    try { sessionStorage.setItem(receiptStore, JSON.stringify(receipts)); } catch { /* storage can be disabled */ }
  }, [receiptStore, receipts]);
  const pendingProjects = new Map(receipts
    .filter((receipt) => !readOnly && agentReplyPending(receipt, now) && !sharedWorkspaces.has(receipt.project.workspace))
    .map(({ project }) => [projectKey(project), project]));
  const receiveResult = (key: string, result: AgentReplyResult) => setReceipts((previous) => {
    const index = previous.findIndex((receipt) => projectKey(receipt.project) === key && receipt.id === result.id);
    if (index < 0) return previous;
    const receipt = previous[index];
    const updated = applyAgentReplyResult(receipt, result);
    return updated === receipt ? previous : previous.map((item, i) => i === index ? { ...updated, project: receipt.project } : item);
  });
  const [filter, setFilter] = useState(stored);
  useEffect(() => {
    try { localStorage.setItem(STORE, JSON.stringify({ ...filter, text: "" })); } catch { /* the filter is a convenience */ }
  }, [filter]);
  const set = (change: Partial<OverviewFilter>) => setFilter((f) => ({ ...f, ...change }));
  const names = useMemo(() => initiativeNames(list.projects), [list]);
  const selectedInitiatives = [...new Set(initiatives.map((value) =>
    names.find((name) => name.toLowerCase() === value.toLowerCase()) ?? value))];
  const initiativeLabel = selectedInitiatives.length > 1 ? `${selectedInitiatives.length} initiatives`
    : selectedInitiatives.length === 1 ? selectedInitiatives[0] || "No initiative" : "All initiatives";
  // Sections only when some project has an initiative; then the rows go in the order of the sections.
  const grouped = names.length > 0;
  const activity = useMemo(() => ({ now, presence, agents }), [now, presence, agents]);
  const inboxProjects = useMemo(() => overviewRows(list, { ...START, workspace: filter.workspace, initiatives }, activity),
    [list, filter.workspace, initiatives, activity]);
  const matching = useMemo(() => {
    const projects = filter.closed ? overviewRows(list, { ...filter, text: "", initiatives }, activity) : inboxProjects;
    const words = filter.text.trim().toLowerCase().split(/\s+/);
    return projects.filter(({ project }) => words.every((word) => project.name.toLowerCase().includes(word)));
  }, [list, filter, initiatives, activity, inboxProjects]);
  const counts = countProjectStates(matching);
  const visible = useMemo(() => filterProjectStates(matching, states), [matching, states]);
  const sections = useMemo(() => grouped ? initiativeSections(visible, list.workspaces) : [], [visible, list.workspaces, grouped]);
  const rows = useMemo(() => grouped ? sections.flatMap((section) => section.rows) : visible, [sections, visible, grouped]);
  const incomplete = !!missing || list.workspaces.some((w) => w.error && (!filter.workspace || w.id === filter.workspace))
    || inboxProjects.some(({ summary }) => !summary || summary.error);
  const [category, setCategory] = useState<InboxFilter>("all");
  const [openedReplies, setOpenedReplies] = useState<Set<string>>(() => new Set());
  const [active, setActive] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [issueReceipts, setIssueReceipts] = useState<Map<string, ReturnType<typeof issueReplyReceipt>>>(() => new Map());
  const [sentWorkers, setSentWorkers] = useState<Map<string, SentWorker>>(() => new Map());
  const inbox = useMemo<InboxRow[]>(() => inboxProjects.flatMap<InboxRow>(({ project, summary, stalls }) => [
    ...(summary?.you ?? []).map((move) => ({ project, move, stall: null })),
    ...stalls.map((stall) => ({
      project, stall,
      move: {
        identifier: stall.issue ?? "project", title: stall.title ?? project.name, why: stall.reason,
        pullRequests: [], idle: true, updatedAt: stall.since ?? "", blocks: 0, unblocks: 0,
        ...(stall.issue ? summary?.moveImpacts?.[stall.issue] : undefined),
      },
    })),
  ]).sort(compareInboxRows), [inboxProjects]);
  const pendingWorkers = [...sentWorkers.values()].filter(({ project, move }) => {
    const key = summaryKey(project);
    return !!presence?.get(key)?.queued && !inbox.some((row) => summaryKey(row.project) === key && row.move.workerAsk?.id === move.workerAsk?.id)
      && inboxProjects.some((row) => summaryKey(row.project) === key);
  });
  const [allMoves, setAllMoves] = useState(false);
  const inboxRows = pendingWorkers.length ? [
    ...inbox,
    ...pendingWorkers.map(({ project, move }) => ({ project, move, stall: null })),
  ].sort(compareInboxRows) : inbox;
  const inboxCounts = { all: inboxRows.length, questions: 0, stalls: 0, actions: 0 };
  for (const row of inboxRows) inboxCounts[inboxCategory(row)]++;
  const emptyInbox = INBOX_FILTERS.find(({ id }) => id === category)!.empty;
  const hasInboxItems = inboxRows.length > 0;
  const categoryRows = category === "all" ? inboxRows : inboxRows.filter((row) => inboxCategory(row) === category);
  const shownInbox = new Set((allMoves ? categoryRows : categoryRows.slice(0, INBOX)).map(inboxKey));
  const workspaceName = list.workspaces.find((w) => w.id === filter.workspace)?.name ?? filter.workspace;
  const initiativeName = selectedInitiatives.length ? initiativeLabel : null;
  const scope = [workspaceName ?? "All workspaces", initiativeName ?? "All initiatives"].join(" · ");
  const filterScope = [workspaceName, initiativeName, ...states.map(stateLabel), filter.closed && "Includes closed"]
    .filter(Boolean).join(" · ");
  useEffect(() => {
    const previous = document.title;
    document.title = overviewTitle(inboxRows.length);
    return () => { document.title = previous; };
  }, [inboxRows.length]);
  useEffect(() => {
    // A worker reply leaves the live asks when queued. Keep its receipt until the coordinator drains
    // the queue. An issue answer stays on its original row until the issue moves.
    setSentWorkers((old) => {
      const next = new Map(old);
      for (const [key, { project, move }] of old) {
        const projectKey = summaryKey(project);
        if (presence?.get(projectKey)?.queued === 0 && asks?.get(projectKey)?.every((ask) => ask.id !== move.workerAsk?.id)) next.delete(key);
      }
      return next.size === old.size ? old : next;
    });
  }, [asks, presence, sentWorkers]);
  useEffect(() => {
    if (!("summaries" in list)) return;
    const waiting = new Set(list.summaries.flatMap((summary) => summary.you.flatMap((move) =>
      move.answer ? [`${summaryKey(summary)}:issue:${move.answer.issueId}`] : [])));
    setIssueReceipts((old) => {
      const next = new Map([...old].filter(([key]) => waiting.has(key)));
      return next.size === old.size ? old : next;
    });
  }, [list]);
  const find = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const inboxRoot = useRef<HTMLElement>(null);
  useEffect(() => {
    if (managedPullRefresh) return;
    const stage = root.current?.parentElement;
    const installed = window.matchMedia("(display-mode: standalone)").matches
      || (navigator as Navigator & { standalone?: boolean }).standalone;
    if (!stage || !installed) return;

    let start: Touch | undefined;
    const atTop = () => stage.scrollTop === 0 && window.scrollY === 0;
    const reset = () => { start = undefined; };
    const hasDraft = () => Array.from(stage.querySelectorAll<HTMLTextAreaElement>(".inbox-detail textarea"))
      .some((editor) => editor.value.length > 0);
    const blocksPull = (target: EventTarget | null) => {
      if (!(target instanceof Element) || target.closest("input, textarea, [contenteditable]")) return true;
      for (let node: Element | null = target; node && node !== stage; node = node.parentElement) {
        const { overflowX, overflowY } = getComputedStyle(node);
        const scrollable = /^(auto|scroll|overlay)$/;
        if (node.scrollTop > 0 && scrollable.test(overflowY)) return true;
        if (node.scrollWidth > node.clientWidth && scrollable.test(overflowX)) return true;
      }
      return false;
    };
    const onStart = (event: TouchEvent) => {
      start = event.touches.length === 1 && atTop() && !blocksPull(event.target) && !hasDraft()
        && !document.querySelector("dialog[open], :popover-open")
        ? event.touches[0] : undefined;
    };
    const onMove = (event: TouchEvent) => {
      if (!start) return;
      const touch = event.touches[0];
      if (!atTop() || event.touches.length !== 1) {
        reset();
        return;
      }
      const dy = touch.clientY - start.clientY;
      if (Math.abs(touch.clientX - start.clientX) > 40 || dy < -10) reset();
      else if (dy > 0 && event.cancelable) event.preventDefault();
    };
    const onEnd = (event: TouchEvent) => {
      const first = start;
      reset();
      const last = Array.from(event.changedTouches).find((touch) => touch.identifier === first?.identifier);
      if (first && last && atTop() && !hasDraft() && last.clientY - first.clientY >= 80
        && Math.abs(last.clientX - first.clientX) <= 40) window.location.reload();
    };
    stage.addEventListener("touchstart", onStart, { passive: true });
    stage.addEventListener("touchmove", onMove, { passive: false });
    stage.addEventListener("touchend", onEnd);
    stage.addEventListener("touchcancel", reset);
    return () => {
      stage.removeEventListener("touchstart", onStart);
      stage.removeEventListener("touchmove", onMove);
      stage.removeEventListener("touchend", onEnd);
      stage.removeEventListener("touchcancel", reset);
    };
  }, [managedPullRefresh]);
  const inboxButtons = () => Array.from(inboxRoot.current?.querySelectorAll<HTMLButtonElement>(".inbox-row:not([hidden]) .inbox-open") ?? []);
  useEffect(() => {
    if (expanded) inboxRoot.current?.querySelector<HTMLTextAreaElement>(".inbox-row:not([hidden]) .inbox-detail:not([hidden]) textarea")?.focus();
  }, [expanded]);
  useEffect(() => setActive(0), [filter, initiatives, states]);
  // On a phone or in the installed app, keep the inbox in view until the active project changes.
  const lastScrolledRow = useRef(narrow || managedPullRefresh ? active : null);
  useEffect(() => {
    if (lastScrolledRow.current === active) return;
    lastScrolledRow.current = active;
    root.current?.querySelector(".ov-row.is-active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector(".picker-list, dialog[open], .keys")) return;
      const element = e.target instanceof HTMLElement ? e.target : null;
      const typing = element?.closest("input, textarea, select, [contenteditable]");
      const inFind = e.target === find.current;
      const inInbox = element?.closest(".inbox-row");
      if (e.key === "Escape" && inInbox && expanded) {
        e.preventDefault();
        setExpanded(null);
        inboxButtons().find((button) => button.getAttribute("aria-expanded") === "true")?.focus();
      } else if (e.key === "r" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const buttons = inboxButtons();
        const button = element?.closest(".inbox-row")?.querySelector<HTMLButtonElement>(".inbox-open[aria-expanded]")
          ?? buttons.find((item) => item.hasAttribute("aria-expanded"));
        if (button) {
          e.preventDefault();
          button.focus();
          if (button.getAttribute("aria-expanded") === "false") button.click();
        }
      } else if (inInbox && !typing && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        const buttons = inboxButtons();
        const at = buttons.findIndex((button) => button.closest(".inbox-row")?.contains(element));
        e.preventDefault();
        buttons[Math.max(0, Math.min(buttons.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
      } else if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        find.current?.focus();
        find.current?.select();
      } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && (!typing || inFind)) {
        e.preventDefault();
        setActive((a) => Math.min(Math.max(0, rows.length - 1), Math.max(0, a + (e.key === "ArrowDown" ? 1 : -1))));
      } else if (e.key === "Enter" && inFind && rows[active]) {
        e.preventDefault();
        onOpen(rows[active].project);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [rows, active, onOpen, expanded]);

  const multi = list.workspaces.length > 1;
  const closedCount = list.projects.filter((p) =>
    (p.statusType === "completed" || p.statusType === "canceled")
    && (!selectedInitiatives.length || selectedInitiatives.some((name) => name.toLowerCase() === (p.initiative ?? NO_INITIATIVE).toLowerCase()))).length;
  const hasFilters = !!(filter.workspace || selectedInitiatives.length || states.length || filter.closed || filter.text);
  const clearFilters = () => {
    (filterButton.current ?? find.current)?.focus();
    setFilter(START);
    if (selectedInitiatives.length) onInitiatives?.([]);
    if (states.length) onStates?.([]);
  };

  const renderRow = ({ project: p, summary: s, attention }: OverviewRow, at: number) => {
      const closed = p.statusType === "completed" || p.statusType === "canceled";
      const key = summaryKey(p);
      const reported = !readOnly && !viewerWorkspaces.has(p.workspace ?? "") ? agents?.get(key) : undefined;
      const owner = !readOnly && !sharedWorkspaces.has(p.workspace ?? "");
      const project = { id: p.id, workspace: p.workspace ?? site.defaultWorkspace };
      const shown = agentsShown(reported, now);
      const fresh = agentsFresh(reported, now);
      const waitingAgents = shown.filter(agentNeeds).length;
      const reportAt = Math.max(...[reported?.at, s?.effort?.at, s?.freshness?.ran].map((at) => Date.parse(at ?? "")).filter(Number.isFinite));
      const issueAt = Date.parse(s?.updatedAt ?? "");
      const updatedAt = Number.isFinite(issueAt) ? issueAt : -Infinity;
      const lastAge = ageText(now - Math.max(reportAt, updatedAt));
      const lastActivity = lastAge ? `${reportAt >= updatedAt ? "Last report" : "Last activity"} · ${lastAge}` : "No activity reported";
      const { state, reason } = attention;
      const rowReason = !s && !loading && !closed ? "Project details unavailable" : reason;
      const { signal } = STATE_DISPLAY[state];
      const coordinator = presenceText(presence?.get(key), now, reported, !owner);
      const coordinatorDisplay = COORDINATOR_DISPLAY[coordinator?.state ?? "unknown"];
      const detail = [
        p.name, rowReason, lastActivity, coordinator?.title,
        s?.counts.map((c) => `${c.status} · ${c.n}`).join(", "),
        s?.running ? "Running: a worker runs on it, or it is In Progress." : "",
        s?.review ? "In review: In Review or Verifying." : "",
        s?.ready ? "Can start: not started, and no blocker holds it back." : "",
      ].filter(Boolean).join("\n");
      return (
        <li key={summaryKey(p)} className={`ov-row${at === active ? " is-active" : ""}${signal === "stop" ? " is-you" : ""}${closed ? " is-closed" : ""}`}>
          <button type="button" className="ov-open" onClick={() => onOpen(p)} onFocus={() => setActive(at)} onMouseEnter={() => setActive(at)}>
            <span className="ov-state">
              <Lamp signal={signal} pulse={state === "moving"} />
              <span className={`ov-state-label sig-fg-${signal}`}>{stateLabel(state)}</span>
              <span className="ov-reason" title={rowReason}>{rowReason}</span>
              <span className="ov-age mono">{lastActivity}</span>
            </span>
            <span className="ov-name">
              <span className="ov-title" title={p.name}>{p.name}</span>
              {multi && !grouped && <span className="ov-ws">{p.workspaceName}</span>}
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
              <span className="ov-coord" role="group" aria-label="Coordinator">
                <Lamp signal={coordinatorDisplay.signal} />{coordinatorDisplay.label}
              </span>
              {s && s.running > 0 && <span className="sig-fg-running" title="A worker runs on it, or it is In Progress"><Lamp signal="running" pulse />{s.running} running</span>}
              {s && s.review > 0 && <span className="sig-fg-review" title="In Review or Verifying"><Lamp signal="review" />{s.review} in review</span>}
              {s && s.ready > 0 && <span className="sig-fg-ready" title="Not started, and no blocker holds it back"><Lamp signal="ready" />{s.ready} can start</span>}
            </span>
            {s?.error && <span className="ov-error sig-fg-stop">{s.error}</span>}
          </button>
          <Hint text={detail} infoLabel="Project details" className="ov-row-tools">
            <CopyButton text={p.name} label="Copy the project name" className="ov-copy" />
          </Hint>
          {s?.effort && (
            <details className="ov-effort">
              <summary>wg next</summary>
              <p>{s.effort.status}</p>
            </details>
          )}
          {shown.length > 0 && (
            <details className="ov-agent-group">
              <summary>
                {shown.length} {shown.length === 1 ? "agent" : "agents"}
                {!fresh ? <span className="is-warning"> · Stale report</span>
                  : waitingAgents > 0 && <span className="sig-fg-stop"> · {waitingAgents} waiting</span>}
              </summary>
              <ul className={`ov-agents${fresh ? "" : " is-stale"}`} aria-label={`Agents of ${p.name} in Orca`}>
                {!fresh && <li className="ov-agents-note is-warning">agent view stopped · last report {ageText(now - Date.parse(reported!.at))} · wg agents does not run</li>}
                {owner && reported?.replies !== true && <li className="ov-agents-note">To turn on replies, set <code>agent_replies</code> to <code>true</code> and run <code>wg agents</code> in your Orca terminal.</li>}
                {shown.map((a) => {
                  const state = agentState(a);
                  const receipt = owner ? receipts.find((r) => projectKey(r.project) === key && r.agent === a.id) : undefined;
                  const status = receipt && agentReplyLine(receipt, now);
                  return (
                    <li key={a.id}>
                      <details className="ov-agent">
                        <summary>
                          <Lamp signal={fresh ? state.signal : "off"} pulse={fresh && state.signal === "running"} />
                          <span className="ov-agent-who mono">{agentName(a)}</span>
                          <span className={`ov-agent-state${fresh && state.signal === "stop" ? " sig-fg-stop" : ""}`}>{a.agent} {state.text}</span>
                          <span className="ov-agent-age mono">{a.at ? ageText(now - Date.parse(a.at)) : ""}</span>
                          <span className="ov-agent-said">{a.said || "no message yet"}</span>
                        </summary>
                        {a.title && <p className="ov-agent-full">{a.title}</p>}
                        <p className="ov-agent-full">{a.said || "no message yet"}{messageCut(a.said) && <span className="ov-agents-note"> (message cut at 500 characters)</span>}</p>
                        {agentNeeds(a) && <p className="ov-agent-full">answer this agent in Orca</p>}
                        {canReplyToAgent(a, reported, now, owner) && (!receipt || !agentReplyPending(receipt, now)) &&
                          <div className="ov-agent-full">
                            <Reply label="Reply to the agent" placeholder="Write a reply" send={async (body) => {
                              const { id } = await api.agentReply(project.id, project.workspace, a.id, body);
                              const sentAt = Date.now();
                              setReceipts((previous) => [...previous.filter((r) => projectKey(r.project) !== key || r.agent !== a.id),
                                { id, agent: a.id, sentAt, project }]);
                            }} />
                          </div>}
                      </details>
                      {status && <p className={`ov-agent-reply-status sig-fg-${status.signal}`} role="status">{status.text}</p>}
                    </li>
                  );
                })}
              </ul>
            </details>
          )}
        </li>
      );
  };

  return (
    <div className="overview" ref={root}>
      {[...pendingProjects].map(([key, project]) =>
        <AgentReplyUpdates key={key} project={project} onResult={(result) => receiveResult(key, result)} />)}
      <div className="ov-head">
        <h1>Overview</h1>
        <p className="ov-sum" role="status">
          {inboxCounts.stalls > 0 && <span className="sig-fg-stop"><Lamp signal="stop" /> {inboxCounts.stalls} {inboxCounts.stalls === 1 ? "possible stall" : "possible stalls"}</span>}
          {incomplete && !(loading && !("summaries" in list)) && <span className="sig-fg-stop">Project data incomplete</span>}
          {loading && <span className="sync-dot is-busy" aria-label="Refreshing" />}
        </p>
        {budget.map((w) => <Hint key={w.id} className="ov-budget is-warning mono" text={w.title} infoLabel="Linear budget details">
          <span role="status">{w.text}</span>
        </Hint>)}
      </div>
      {missing && <p className="empty" role="status">{missing}</p>}

      <section className={hasInboxItems ? "inbox" : "inbox is-empty"} ref={inboxRoot} aria-label="Inbox">
        {hasInboxItems && <h2 className="inbox-head">Inbox <span className="inbox-note">{scope}</span></h2>}
        {hasInboxItems && <div className="inbox-filters" role="group" aria-label="Inbox category">
          {INBOX_FILTERS.map(({ id, label }) => (
            <button key={id} type="button" className={`toggle${id === category ? " is-on" : ""}`} aria-pressed={id === category}
              onClick={() => { setCategory(id); setAllMoves(false); }}>
              {label} <span className="mono">{inboxCounts[id]}</span>
            </button>
          ))}
        </div>}
        {categoryRows.length === 0 && <p className="inbox-empty" role="status">
          {loading && !("summaries" in list) ? "Loading the inbox…"
            : <>{hasInboxItems ? emptyInbox : INBOX_FILTERS[0].empty}{incomplete && " Project data is incomplete."}</>}
        </p>}
        <ul hidden={!hasInboxItems}>
          {inboxRows.map((row) => {
            const { project: p, move: m, stall } = row;
            const key = inboxKey(row);
            const visible = shownInbox.has(key);
            if (!visible && !openedReplies.has(key)) return null;
            const target = inboxReply(m, readOnly || viewerWorkspaces.has(p.workspace ?? ""));
            const open = expanded === key;
            const receipt = issueReceipts.get(key);
            const sent = target?.kind === "worker" ? sentWorkers.has(key) : target?.kind === "issue" && target.sent;
            const detailId = `inbox-detail-${encodeURIComponent(key)}`;
            const go = () => onOpen(p, stall ? stall.issue : m.identifier === "worker" || m.identifier === "coordinator" ? undefined : m.identifier);
            const stamp = inboxTimestamp(m);
            const destinationWorkspace = multi && !filter.workspace ? p.workspaceName : null;
            const destination = destinationWorkspace ? `${destinationWorkspace} · ${p.name}` : p.name;
            const age = stamp ? ageText(now - Date.parse(stamp)) : null;
            // A reason that is the title (a decision: its question) shows once.
            const why = overviewMoveReason(m.why);
            const title = m.agentWait?.said !== m.title && why.trim() !== m.title.trim() && !why.includes(m.title.trim()) ? m.title : null;
            const effect = [
              m.idle && !stall && "agent waits",
              m.blocks && `holds back ${m.blocks}, ${m.unblocks ?? 0} can start`,
            ].filter(Boolean).join(" · ");
            return (
              <li key={key} className="inbox-row" hidden={!visible}>
                <div className="inbox-row-head">
                  <button type="button" className="inbox-open" title={`${destination}: ${m.title}`}
                    aria-expanded={target ? open : undefined} aria-controls={target ? detailId : undefined}
                    onClick={target ? () => {
                      setExpanded(open ? null : key);
                      if (!open) setOpenedReplies((old) => new Set(old).add(key));
                    } : go}>
                    <Lamp signal="stop" />
                    <span className="inbox-id mono">{m.identifier}</span>
                    <span>
                      <span className="inbox-text">
                        <span className="inbox-why">{why}</span>
                        {title && <span className="inbox-title">{title}</span>}
                      </span>
                      {m.agentWait && <>
                        {m.agentWait.said && <span className="inbox-agent-message">{m.agentWait.said}</span>}
                        {messageCut(m.agentWait.said) && <span className="inbox-effect">Message cut at 500 characters.</span>}
                        {!target && <span className="inbox-effect">answer this agent in Orca</span>}
                      </>}
                      {effect && <span className="inbox-effect">{effect}</span>}
                      {receipt
                        ? <span className={`inbox-effect sig-fg-${receipt.signal}`} role="status">{receipt.text}</span>
                        : sent && <span className="inbox-effect sig-fg-done" role="status">sent</span>}
                    </span>
                    <span className="inbox-project">
                      <span className="inbox-project-name">{p.name}</span>
                      {destinationWorkspace && <span className="inbox-workspace">{destinationWorkspace}</span>}
                    </span>
                    <span className="inbox-age mono">{age ?? ""}</span>
                  </button>
                  {/* Always there, so the columns of the rows line up. */}
                  <span className="inbox-prs">
                    {m.pullRequests.map((pr) => <span className="ov-pr" key={pr.url}>#{pr.number} <PrLinks pr={pr} compact /></span>)}
                  </span>
                </div>
                {target && (
                  <div className="inbox-detail" id={detailId} hidden={!open || !visible}>
                    {destinationWorkspace && <p className="inbox-workspace">{destination}</p>}
                    <p className="inbox-why">{why}</p>
                    <InboxAnswer target={target} project={p} expanded={open && visible} submitted={!!sent || !!receipt} onSent={(comment) => {
                      if (document.activeElement?.closest(".inbox-detail")?.id === detailId) {
                        inboxButtons().find((button) => button.getAttribute("aria-controls") === detailId)?.focus();
                      }
                      if (target.kind === "worker") setSentWorkers((old) => new Map(old).set(key, { project: p, move: m }));
                      else if (comment) setIssueReceipts((old) => new Map(old).set(key, issueReplyReceipt(comment)));
                    }} />
                    <button type="button" className="ghost" onClick={go}>{m.identifier === "worker" || m.identifier === "coordinator" ? "Open project" : "Open issue"}</button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {categoryRows.length > INBOX && (
          <button type="button" className="ghost inbox-more" onClick={() => setAllMoves(!allMoves)}>
            {allMoves ? "Show fewer" : `Show all ${categoryRows.length}`}
          </button>
        )}
      </section>

      <div className="ov-filters">
        <div className="ov-find">
          <input ref={find} type="search" placeholder="Find a project" aria-label="Find a project by name" value={filter.text}
            onChange={(e) => set({ text: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Escape") { set({ text: "" }); e.currentTarget.blur(); } }} />
          {!filter.text && <kbd aria-hidden>/</kbd>}
        </div>
        {narrow && <button ref={filterButton} className="ov-filter-toggle" type="button"
          aria-expanded={filtersOpen} aria-controls="overview-filter-options" onClick={() => setFiltersOpen(!filtersOpen)}>
          Filters <span className="caret" aria-hidden="true">{filtersOpen ? "▴" : "▾"}</span>
        </button>}
        {narrow && hasFilters && <div className="ov-filter-scope">
          <span>{filterScope || scope}</span>
          <button type="button" className="ghost" onClick={clearFilters}>Clear filters</button>
        </div>}
        <div className="ov-filter-options" id="overview-filter-options" hidden={narrow && !filtersOpen}>
          {multi && (
            <div className="ov-seg" role="group" aria-label="Workspace">
              {[{ id: null, name: "All" }, ...list.workspaces].map((w) => (
                <button type="button" key={w.id ?? "all"} className={filter.workspace === w.id ? "is-on" : ""} aria-pressed={filter.workspace === w.id}
                  onClick={() => set({ workspace: w.id })}>{w.name}</button>
              ))}
            </div>
          )}
          {grouped && onInitiatives && (
            <Picker multi value={selectedInitiatives.length ? selectedInitiatives.map((name) => `=${name}`) : ["*"]}
              onChange={(ids) => onInitiatives(selectedInitiatives.length && ids.includes("*")
                ? [] : ids.filter((id) => id !== "*").map((id) => id.slice(1)))}
              title="Filter by initiative" options={[
                { id: "*", label: "All initiatives" },
                ...names.map((n) => ({ id: `=${n}`, label: n })),
                { id: `=${NO_INITIATIVE}`, label: "No initiative" },
              ]}>
              <span className={selectedInitiatives.length ? "ov-init-on" : ""}>{initiativeLabel}</span><span className="caret">▾</span>
            </Picker>
          )}
          {onStates && <div className="ov-state-filters" role="group" aria-label="Project state">
            {PROJECT_STATES.map((state) => {
              const selected = states.includes(state);
              return (
                <button type="button" key={state} className={`toggle${selected ? " is-on" : ""}`} aria-pressed={selected}
                  onClick={() => onStates(PROJECT_STATES.filter((value) => value === state ? !selected : states.includes(value)))}>
                  {stateLabel(state)} <span className="mono">{counts[state]}</span>
                </button>
              );
            })}
          </div>}
          {closedCount > 0 && (
            <Hint text="Also show the completed and canceled projects." infoLabel="About closed projects">
              <button type="button" className={`toggle${filter.closed ? " is-on" : ""}`} aria-pressed={filter.closed} onClick={() => set({ closed: !filter.closed })}>Closed <span className="mono">{closedCount}</span></button>
            </Hint>
          )}
        </div>
      </div>

      {list.workspaces.filter((w) => w.error).map((w) => <p key={w.id} className="empty" role="status">{w.error}</p>)}
      {!list.projects.length && !list.workspaces.some((w) => w.error) && <p className="empty">No projects. `wg load` makes one from plan.json.</p>}
      {list.projects.length > 0 && !rows.length && (
        <p className="empty">No project matches. {!narrow && <button type="button" className="ghost" onClick={clearFilters}>Clear the filters</button>}</p>
      )}

      {grouped ? sections.map((section) => {
        const first = rows.indexOf(section.rows[0]);
        return (
          <section key={section.key} className="ov-section" aria-label={section.name ?? "No initiative"}>
            <h2 className="ov-section-head">
              {onInitiatives && selectedInitiatives.length !== 1
                ? <Hint text="Show only this initiative" infoLabel="About this initiative filter">
                  <button type="button" className="ov-section-name" onClick={() => onInitiatives([section.name ?? NO_INITIATIVE])}>{section.name ?? "No initiative"}</button>
                </Hint>
                : <span className="ov-section-name">{section.name ?? "No initiative"}</span>}
              {multi && <span className="ov-ws">{section.workspaceName}</span>}
              <span className="ov-section-sum mono">
                {section.projects} {section.projects === 1 ? "project" : "projects"}
                {section.planned > 0 && ` · ${section.done}/${section.planned} done`}
                {section.running > 0 && ` · ${section.running} running`}
              </span>
              <span className={`ov-section-state sig-fg-${STATE_DISPLAY[section.state].signal}`}>
                <Lamp signal={STATE_DISPLAY[section.state].signal} />{stateLabel(section.state)}
              </span>
            </h2>
            <ul className="ov-list">{section.rows.map((row, i) => renderRow(row, first + i))}</ul>
          </section>
        );
      }) : <ul className="ov-list">{rows.map(renderRow)}</ul>}
    </div>
  );
}
