import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pageEvent } from "./lib/telemetry";
import { accountApi, api, setOpenProject } from "./api";
import { Onboarding } from "./components/Onboarding";
import { AccountError, Settings, useAccountAction } from "./components/Settings";
import { firstStep } from "./lib/onboarding";
import { BarMenu, useCompactBar } from "./components/BarMenu";
import { Board } from "./components/Board";
import { Canvas } from "./components/Canvas";
import { Overview } from "./components/Overview";
import { MemberAccess, Share } from "./components/Share";
import { Panel } from "./components/Panel";
import { CopyButton, Hint, Lamp, Picker } from "./components/ui";
import { REVIEWED, boardOrder, buildGraph, parseStatus, projectGroups, reduceEdges, shapeKey, statusTiming, type GNode, type Signal, toggleReviewed } from "./lib/graph";
import { AUTONOMY_DEFAULT, AUTONOMY_HINTS, AUTONOMY_LEVELS, type AutonomyLevel } from "./lib/autonomy";
import { REVIEW_DEFAULT, REVIEW_HINTS, REVIEW_LEVELS, type ReviewEffort } from "./lib/review";
import { type HeldGraph, budgetWarnings, mergeDirectory, pollGraph, staleBanner, versionText } from "./lib/health";
import { agentsFresh, agentsWaiting, canCommandCoordinator, liveJob, presenceText } from "./lib/link";
import { type OverviewData, PROJECT_LAMP, movesWithAgents, movesWithAsks, readProjectStates, summaryKey } from "./lib/overview";
import { ownerWords } from "./lib/words";
import { configureSite, site, statusOrder } from "./lib/site";
import { type Layout, layout as runLayout } from "./lib/layout";
import type { Account, AccountConnection, GraphData, Issue, IssuePatch, Project, ProjectList, ServerStatus } from "./lib/types";
import { TABLET_OR_WIDER, useHover, useNarrow } from "./lib/screen";
import { useLink } from "./useLink";
import { canReleaseClaim, claimMarks, matchesClaim, parseClaimFilter, type ClaimFilter, type ProjectClaims } from "./lib/claims";

const POLL_MS = 15_000;
/** The overview loads a graph for each open project, so it polls less often than one graph. */
const OVERVIEW_MS = 60_000;

function useQuery() {
  const read = () => new URLSearchParams(location.search);
  const [query, setQuery] = useState(read);
  useEffect(() => {
    const sync = () => setQuery(read());
    addEventListener("popstate", sync);
    return () => removeEventListener("popstate", sync);
  }, []);
  const set = useCallback((changes: Record<string, string | null>, push = false) => {
    const next = read();
    for (const [k, v] of Object.entries(changes)) v === null ? next.delete(k) : next.set(k, v);
    history[push ? "pushState" : "replaceState"](null, "", `?${next}`);
    setQuery(next);
  }, []);
  return [query, set] as const;
}

// The project parameter holds an ID or the name that wg ui passed.
export function projectFromQuery(directory: ProjectList | null, query: URLSearchParams) {
  const wanted = query.get("project") || null;
  const workspace = query.get("workspace") ?? site.defaultWorkspace;
  // An id is exact, so it comes first: a project whose name is the id of another one does not take its link.
  const here = directory?.projects.filter((p) => p.workspace === workspace) ?? [];
  const project = here.find((p) => p.id === wanted) ?? here.find((p) => p.name.toLowerCase() === wanted?.toLowerCase()) ?? null;
  const entry = directory?.workspaces.find((w) => w.id === workspace);
  const missing = directory && wanted && !project && !entry?.error ? `No project "${wanted}" in ${entry?.name ?? workspace}` : null;
  return { project, missing };
}

export function ServiceApp() {
  const compactBar = useCompactBar();
  const [query, navigate] = useQuery();
  const [account, setAccount] = useState<Account | null>(null);
  const { error, busy, run } = useAccountAction();
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    const account = await accountApi.read();
    if (request === sequence.current) {
      configureSite({ human: account.human, defaultWorkspace: account.connections[0]?.workspace_id });
      setAccount(account);
    }
    return account;
  }, []);
  useEffect(() => { void run(async () => { await refresh(); }); }, [refresh]);
  const [guide, setGuide] = useState(false);
  const page = query.get("page");
  const route = (page: string | null) => navigate({ page }, true);
  const overview = () => { setGuide(false); navigate({ page: null, project: null, workspace: null }, true); };
  const showGuide = !!account && (page === "setup" || (!account.onboarding.skipped && (guide || !!firstStep(account.onboarding))));
  useEffect(() => {
    if (account && firstStep(account.onboarding)) setGuide(true);
  }, [account]);
  const signInWorkspace = account?.connections.find(({ kind }) => kind === "oauth")?.workspace_id;
  const accountView = page === "settings" ? "settings_viewed" : showGuide ? "onboarding_viewed" : null;
  const lastAccountView = useRef<typeof accountView>(null);
  useEffect(() => {
    if (!signInWorkspace || lastAccountView.current === accountView) return;
    lastAccountView.current = accountView;
    if (accountView) pageEvent(accountView, signInWorkspace);
  }, [accountView, signInWorkspace]);
  if (account && page !== "settings" && !showGuide) return <App service connections={account.connections} openSettings={() => route("settings")} overviewWorkspace={signInWorkspace} />;
  const signOut = <a className="bar-user" href="/auth/logout">Sign out</a>;
  return <div className="app">
    <header className="bar account-bar">
      <span className="brand">work-graph</span><span className="station-fill" />
      {page === "settings" ?
        <button onClick={() => route(null)}>{showGuide ? "Setup guide" : "Overview"}</button> :
        <button onClick={() => route("settings")}>Settings</button>}
      {compactBar ? <BarMenu title="Account controls">{() => signOut}</BarMenu> : signOut}
    </header>
    {!account ? <main className="account-page"><div className="account-content">
      {error ? <><AccountError error={error} /><button disabled={busy} onClick={() => void run(async () => { await refresh(); })}>Retry</button></> :
        <p role="status">Loading your account…</p>}
    </div></main> : page === "settings" ?
      <Settings account={account} refresh={refresh} openGuide={() => route("setup")} /> :
      <Onboarding account={account} refresh={refresh} overview={overview} />}
  </div>;
}

export function App({ openSettings, overviewWorkspace = site.defaultWorkspace, service = false, connections }: {
  openSettings?: () => void; overviewWorkspace?: string; service?: boolean; connections?: AccountConnection[];
} = {}) {
  const [query, setQuery] = useQuery();
  const overviewStates = useMemo(() => readProjectStates(query), [query]);
  const [directory, setDirectory] = useState<ProjectList | null>(null);
  const [data, setData] = useState<GraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [openOnly, setOpenOnly] = useState(false);
  const [allEdges, setAllEdges] = useState(false);
  const [map, setMap] = useState(() => localStorage.getItem("wg-map") !== "off");
  useEffect(() => localStorage.setItem("wg-map", map ? "on" : "off"), [map]);
  // The board starts open on a wide pane. On a phone it covers the canvas, so it starts closed there.
  const [board, setBoard] = useState(() => localStorage.getItem("wg-board") !== "off" && matchMedia(TABLET_OR_WIDER).matches);
  useEffect(() => localStorage.setItem("wg-board", board ? "on" : "off"), [board]);
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set());
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ id: string; tick: number } | null>(null);
  const [placed, setPlaced] = useState<{ key: string; layout: Layout } | null>(null);
  const pending = useRef(0);
  // The version of the graph that the server sent last. An edit changes the graph on screen, so it clears this.
  // While the graph is stale, the page asks without the version: a fresh graph with the same version must replace it.
  const version = useRef<HeldGraph | null>(null);
  const generation = useRef(0);

  const { project, missing } = useMemo(() => projectFromQuery(directory, query), [directory, query]);

  useEffect(() => { api.projects().then((list) => setDirectory((now) => now ?? list)).catch((e) => setError(e.message)); }, []);

  // The overview also gives the project picker the count of issues that wait on the human.
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [overviewBusy, setOverviewBusy] = useState(false);
  const [overviewTick, setOverviewTick] = useState(0);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(clock);
  }, []);
  // The build and the Linear budget of the server, with the overview poll. A failed status changes nothing.
  const [status, setStatus] = useState<ServerStatus | null>(null);
  useEffect(() => {
    let live = true, running = false, statusRunning = false;
    const poll = () => {
      if (running || document.hidden) return;
      running = true;
      setOverviewBusy(true);
      // Status has its own guard: a slow status answer must not come after a newer one.
      if (!statusRunning) {
        statusRunning = true;
        api.status().then((s) => live && setStatus(s)).catch(() => {}).finally(() => { statusRunning = false; });
      }
      api.overview().then((o) => { if (live) { setOverview(o); setDirectory((old) => mergeDirectory(old, o)); setNow(Date.now()); } })
        .catch((e) => live && setError(`overview: ${e.message}`))
        .finally(() => { running = false; if (live) setOverviewBusy(false); });
    };
    poll();
    const timer = setInterval(poll, OVERVIEW_MS);
    document.addEventListener("visibilitychange", poll);
    return () => { live = false; clearInterval(timer); document.removeEventListener("visibilitychange", poll); };
  }, [overviewTick]);


  const load = useCallback(async (project: Project) => {
    if (pending.current) return; // A poll result older than an edit in flight would undo the edit on screen.
    const mine = ++generation.current;
    setNow(Date.now());
    setBusy(true);
    try {
      const scope = `${project.workspace}:${project.id}`;
      const { held, next } = await pollGraph(version.current, scope, (have) => api.graph(project.id, have, project.workspace));
      if (mine !== generation.current || pending.current) return;
      version.current = held;
      if (next) setData(next);
      setSyncedAt(new Date()); // also for an answer of "no change": the page is as new as this poll
      setError(null);
    } catch (e) {
      if (mine === generation.current) setError((e as Error).message);
    } finally {
      if (mine === generation.current) setBusy(false);
    }
  }, []);

  // Each overview poll gives the directory new objects, so `project` gets a new identity with the same project.
  // The graph resets only when the open project is a different project: else each poll blanks the page.
  const openKey = project ? `${project.workspace}:${project.id}` : null;
  const lastView = useRef<string | null>(null);
  const workspace = project?.workspace ?? overviewWorkspace;
  const wantedProject = query.get("project");
  useEffect(() => {
    if (wantedProject && !openKey) return;
    const view = openKey ?? `overview:${workspace}`;
    if (lastView.current === view) return;
    lastView.current = view;
    pageEvent(openKey ? "project_viewed" : "overview_viewed", workspace);
  }, [openKey, workspace, wantedProject]);
  const currentProject = useRef(project);
  currentProject.current = project;
  useEffect(() => {
    setData(null);
    version.current = null;
    setPlaced(null);
    const project = currentProject.current;
    if (!project) return;
    setStatusFilter(new Set()); // The statuses of one project are not the statuses of the next.
    void load(project);
    const timer = setInterval(() => !document.hidden && void load(project), POLL_MS);
    const wake = () => !document.hidden && void load(project);
    document.addEventListener("visibilitychange", wake);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", wake);
      generation.current++;
    };
  }, [openKey, load]);

  // The link: the coordinator of this project (or of every project, on the overview), and a change on the
  // page or in Linear at once instead of at the next poll.
  useEffect(() => { setOpenProject(project?.id ?? null); }, [openKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const linkRef = useMemo(() => (project ? { workspace: project.workspace ?? site.defaultWorkspace, id: project.id } : null), [openKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const entry = directory?.workspaces.find(({ id }) => id === project?.workspace);
  const sharedRole = entry?.role;
  const sharedProject = service && data?.workspace === linkRef?.workspace && data?.project.id === linkRef?.id && !!data?.waitNames;
  const refreshClaims = useRef<() => void>(() => {});
  const [claimData, setClaimData] = useState<{ key: string; result: ProjectClaims } | null>(null);
  useEffect(() => {
    if (!sharedProject || !linkRef || !openKey) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let nextRequest = 0, running = false, queued = false;
    const refresh = () => {
      if (controller.signal.aborted) return;
      queued = true;
      if (running || timer !== undefined) return;
      const delay = nextRequest - performance.now();
      if (delay > 0) {
        timer = setTimeout(() => { timer = undefined; refresh(); }, Math.ceil(delay));
        return;
      }
      queued = false;
      running = true;
      nextRequest = performance.now() + 2000;
      void api.claims(linkRef.id, linkRef.workspace, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) setClaimData({ key: openKey, result });
        })
        .catch(() => {})
        .finally(() => { running = false; if (queued) refresh(); });
    };
    refreshClaims.current = refresh;
    refresh();
    // Renewals can extend a lease without a changed message. Poll while the page is visible.
    const poll = () => { if (!document.hidden) refresh(); };
    const interval = setInterval(poll, POLL_MS);
    document.addEventListener("visibilitychange", poll);
    return () => {
      controller.abort();
      clearTimeout(timer);
      clearInterval(interval);
      document.removeEventListener("visibilitychange", poll);
      refreshClaims.current = () => {};
      setClaimData(null);
    };
  }, [sharedProject, linkRef, openKey]);
  const link = useLink(sharedRole === "viewer" ? null : linkRef, () => {
    refreshClaims.current();
    if (project && !document.hidden) void load(project);
  });
  const claims = sharedProject && claimData?.key === openKey ? claimData?.result : undefined;
  const [filterChoice, setFilterChoice] = useState<{ key: string; value: ClaimFilter } | null>(null);
  const storedFilter = useMemo(() => {
    try { return openKey ? parseClaimFilter(localStorage.getItem(`wg:claims:${openKey}`)) : "all"; }
    catch { return "all"; }
  }, [openKey]);
  const marks = useMemo(() => claimMarks(claims?.claims ?? []), [claims]);
  const canFilterClaims = !!claims && (claims.claims.length ? claims.claims.some((claim) => claim.mine !== undefined) : claims.role !== undefined);
  const claimFilter = canFilterClaims ? (filterChoice?.key === openKey ? filterChoice!.value : storedFilter) : "all";
  const chooseClaimFilter = (value: ClaimFilter) => {
    if (!openKey) return;
    try { localStorage.setItem(`wg:claims:${openKey}`, value); } catch { /* The filter still works on this page. */ }
    setFilterChoice({ key: openKey, value });
  };
  // A worker's question is a move of the human's: it counts in "Your move", the picker, and the badge.
  const yours = useMemo(() => new Map((overview?.summaries ?? []).map((s) => [summaryKey(s), movesWithAgents(movesWithAsks(s.you, link.asksBy.get(summaryKey(s))), link.agentsBy.get(summaryKey(s)), now).length])), [overview, link.asksBy, link.agentsBy, now]);
  const [sharedPresence, setSharedPresence] = useState<{ key: string; data: Awaited<ReturnType<typeof api.sharedPresence>> } | null>(null);
  useEffect(() => {
    if (sharedRole !== "collaborator" || link.connected || !linkRef || !openKey) return;
    let active = true;
    const poll = () => {
      if (document.hidden) return;
      void api.sharedPresence(linkRef.id, linkRef.workspace)
        .then((data) => { if (active) setSharedPresence({ key: openKey, data }); })
        .catch(() => { if (active) setSharedPresence(null); });
    };
    poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, [sharedRole, link.connected, linkRef, openKey]);
  const projectPresence = !link.connected && sharedPresence?.key === openKey && sharedRole === "collaborator" ? sharedPresence.data : undefined;
  const asks = sharedRole === "viewer" ? [] : projectPresence?.asks ?? link.asks;
  const asked = useMemo(() => new Set(asks.flatMap((a) => (a.issue && (!a.accountName || a.accountName === site.human) ? [a.issue] : []))), [asks]);
  const presence = projectPresence ?? (linkRef ? link.presence.get(summaryKey(linkRef)) : undefined);
  const agents = linkRef ? link.agentsBy.get(summaryKey(linkRef)) : undefined;
  const atPrompt = useMemo(() => new Set(agentsWaiting(agents, now).flatMap((a) => a.issue ? [a.issue] : [])), [agents, now]);
  const viewer = site.readOnly || sharedRole === "viewer";
  const collaborator = sharedRole === "collaborator";
  const coordinator = useMemo(() => (linkRef ? presenceText(presence, now, agents, viewer) : null), [presence, linkRef, now, agents, viewer]);
  const stale = useMemo(() => (project ? staleBanner(data, now) : null), [project, data, now]);
  const budget = useMemo(() => budgetWarnings(status, now), [status, now]);
  // The project label `paused` is the record; an older coordinator report stands in until the list has it.
  const paused = project?.paused ?? !!presence?.coordinators[0]?.paused;
  const [commandNote, setCommandNote] = useState<string | null>(null);
  const command = useCallback(async (cmd: Parameters<typeof api.command>[1], done: string) => {
    if (!project) return;
    try {
      const result = await api.command(project.id, cmd, project.workspace);
      if (cmd.name === "pause" || cmd.name === "resume") {
        const target = project, on = cmd.name === "pause";
        setDirectory((list) => list && { ...list, projects: list.projects.map((p) => p.id === target.id && p.workspace === target.workspace ? { ...p, paused: on } : p) });
      }
      setCommandNote(coordinator?.state === "listening" ? done : `${done} It waits in the queue (${result.queued}) until the next wg next.`);
      setTimeout(() => setCommandNote(null), 6000);
    } catch (e) {
      setError(`${cmd.name}: ${(e as Error).message}`);
    }
  }, [project, coordinator]);
  const canCommand = !viewer && (collaborator || canCommandCoordinator(viewer, coordinator));
  const commands = canCommand && (
    <span className="effort-commands">
      {commandNote && <span className="effort-note" role="status">{commandNote}</span>}
      <button type="button" className="ghost" onClick={() => void command({ name: "next" }, "wg next runs again.")} title="The coordinator reads Linear and publishes again at once.">Run wg next now</button>
      {!sharedRole && <button type="button" className="ghost" onClick={() => void command({ name: paused ? "resume" : "pause" }, paused ? "Resumed." : "Paused.")}
        title={paused ? "The coordinator acts again." : "The coordinator stops acting: wg next holds each action until you resume."}>{paused ? "Resume" : "Pause"}</button>}
    </span>
  );

  // The autonomy level is a label of the project. A change goes to Linear, then to the coordinator at once.
  const [autonomyBusy, setAutonomyBusy] = useState(false);
  const setAutonomy = async (level: AutonomyLevel) => {
    if (!project || autonomyBusy) return;
    const target = project;
    setAutonomyBusy(true);
    try {
      const result = await api.autonomy(target.id, level, target.workspace);
      setDirectory((list) => list && { ...list, projects: list.projects.map((p) => p.id === target.id && p.workspace === target.workspace ? { ...p, autonomy: level } : p) });
      setCommandNote(coordinator?.state === "listening" ? `Autonomy ${level}: the coordinator was told.`
        : `Autonomy ${level}. The coordinator gets it at its next wg next${result.queued ? ` (queue: ${result.queued})` : ""}.`);
      setTimeout(() => setCommandNote(null), 6000);
    } catch (e) {
      setError(`autonomy: ${(e as Error).message}`);
    } finally {
      setAutonomyBusy(false);
    }
  };
  const autonomy = project?.autonomy ?? AUTONOMY_DEFAULT;
  // The review effort is a label of the project too. A change goes to Linear, then wakes the coordinator.
  const [reviewBusy, setReviewBusy] = useState(false);
  const setReviewEffort = async (level: ReviewEffort) => {
    if (!project || reviewBusy) return;
    const target = project;
    setReviewBusy(true);
    try {
      const result = await api.reviewEffort(target.id, level, target.workspace);
      setDirectory((list) => list && { ...list, projects: list.projects.map((p) => p.id === target.id && p.workspace === target.workspace ? { ...p, review: level } : p) });
      setCommandNote(coordinator?.state === "listening" ? `Review effort ${level}: the coordinator was told.`
        : `Review effort ${level}. The coordinator gets it at its next wg next${result.queued ? ` (queue: ${result.queued})` : ""}.`);
      setTimeout(() => setCommandNote(null), 6000);
    } catch (e) {
      setError(`review effort: ${(e as Error).message}`);
    } finally {
      setReviewBusy(false);
    }
  };
  const review = project?.review ?? REVIEW_DEFAULT;

  const words = ownerWords();
  // Share with the viewer: the project label `shared` is the record. The link opens the project on the viewer of
  // its workspace (config `share_url`), which names the workspace with the same id. It has the id of the project,
  // not its name: two projects can have one name.
  const shareUrl = project ? directory?.workspaces.find((w) => w.id === project.workspace)?.shareUrl : undefined;
  const shareLink = project && shareUrl
    ? `${shareUrl}/?${new URLSearchParams({ workspace: project.workspace ?? site.defaultWorkspace, project: project.id })}` : null;
  const [shareBusy, setShareBusy] = useState(false);
  const [sharing, setSharing] = useState<string | null>(null);
  useEffect(() => { setSharing(null); }, [openKey]);
  const setShared = async (shared: boolean) => {
    if (!project || shareBusy) return;
    const target = project;
    setShareBusy(true);
    try {
      await api.share(target.id, shared, target.workspace);
      setDirectory((list) => list && { ...list, projects: list.projects.map((p) => p.id === target.id && p.workspace === target.workspace ? { ...p, shared } : p) });
    } catch (e) {
      setError(`share: ${(e as Error).message}`);
    } finally {
      setShareBusy(false);
    }
  };

  const closeProject = async () => {
    if (!project || closing || pending.current) return;
    const target = project;
    if (!window.confirm(`Close “${target.name}” in ${target.workspaceName}?\n\nThis marks every issue in this project Done, including canceled issues, and completes the project.`)) return;
    setClosing(true);
    setCloseError(null);
    pending.current++;
    generation.current++;
    version.current = null;
    setError(null);
    try {
      await api.closeProject(target.id, target.workspace);
      // Keep the current selection if the user changed projects during the request.
      setDirectory((list) => list && { ...list, projects: list.projects.map((p) => p.id === target.id && p.workspace === target.workspace
        ? { ...p, status: "Completed", statusType: "completed" } : p) });
      setOverview(null);
      setOverviewTick((tick) => tick + 1);
    } catch (e) {
      setCloseError(`“${target.name}” was not closed: ${(e as Error).message}`);
    } finally {
      pending.current--;
      setClosing(false);
      setBusy(false);
      // Refresh even after a partial failure so completed issues are visible.
      const current = new URLSearchParams(location.search);
      if ((current.get("workspace") ?? site.defaultWorkspace) === target.workspace
        && [target.id, target.name.toLowerCase()].includes((current.get("project") ?? "").toLowerCase())) void load(target);
    }
  };

  const includeClaim = useCallback(({ card }: GNode) =>
    matchesClaim(card?.key ? marks.get(card.key) : undefined, claimFilter), [marks, claimFilter]);
  const graph = useMemo(() => (data ? buildGraph(data, { openOnly, include: includeClaim }) : null), [data, openOnly, includeClaim]);
  const full = useMemo(() => (data ? buildGraph(data) : null), [data]);
  const edges = useMemo(() => (graph ? (allEdges ? graph.edges : reduceEdges(graph)) : []), [graph, allEdges]);
  const key = graph ? shapeKey(graph, edges) : "";
  useEffect(() => {
    if (!graph || !data) return;
    let live = true;
    runLayout(graph.nodes, edges, data.milestones).then((l) => live && setPlaced({ key, layout: l })).catch((e) => live && setError(`layout: ${e.message}`));
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = useMemo(() => {
    const wanted = query.get("issue");
    return full?.nodes.find((n) => n.issue.identifier === wanted) ?? null;
  }, [full, query]);
  const selectedClaim = selected?.card?.key ? marks.get(selected.card.key) : undefined;
  const lastNode = useRef<string | null>(null);
  const selectedId = selected && openKey ? `${openKey}:${selected.id}` : null;
  useEffect(() => {
    if (lastNode.current === selectedId) return;
    lastNode.current = selectedId;
    if (selectedId) pageEvent("node_opened", workspace);
  }, [selectedId, workspace]);
  const select = useCallback((id: string | null) => {
    // A click pins the node. The canvas then shows the pinned state, not the trace of the pointer,
    // until the pointer goes onto a node again.
    setHoverId(null);
    setQuery({ issue: id ? full?.byId.get(id)?.issue.identifier ?? null : null });
  }, [full, setQuery]);

  const onPatch = useCallback((id: string, patch: IssuePatch, optimistic: Partial<Issue>) => {
    let before: Issue | undefined;
    const swap = (issue: Issue) => setData((d) => d && d.workspace === project?.workspace && d.project.id === project?.id ? {
      ...d, issues: d.issues.map((i) => (i.id === id ? issue : i)),
    } : d);
    setData((d) => {
      before = d?.issues.find((i) => i.id === id);
      return d && { ...d, issues: d.issues.map((i) => (i.id === id ? { ...i, ...optimistic } : i)) };
    });
    pending.current++;
    generation.current++;
    version.current = null;
    return api.update(id, patch, project?.workspace).then((issue) => { swap(issue); return true; }, (e) => {
      if (before) swap(before);
      setError(`${before?.identifier ?? "Issue"} not saved: ${e.message}`);
      return false;
    }).finally(() => { pending.current--; });
  }, [project]);

  // The human marks a PR reviewed with the `reviewed` label (work-graph SKILL.md "Mark a PR reviewed").
  const reviewedLabel = (teamId: string) => data?.labels.find((l) => l.name === REVIEWED && (!l.teamId || l.teamId === teamId));
  const onReview = useCallback((id: string) => {
    const issue = data?.issues.find((i) => i.id === id), label = issue && reviewedLabel(issue.teamId);
    if (!issue || !label) return;
    const labels = toggleReviewed(issue.labels, label);
    void onPatch(id, { labelIds: labels.map((l) => l.id) }, { labels });
  }, [data, onPatch]); // eslint-disable-line react-hooks/exhaustive-deps
  const canReview = !!data?.labels.some((l) => l.name === REVIEWED);

  // A board row selects the issue and centres it. On a phone the board then gives the screen to the canvas.
  const pick = useCallback((id: string) => {
    select(id);
    setFocus({ id, tick: Date.now() });
    if (!matchMedia(TABLET_OR_WIDER).matches) setBoard(false);
  }, [select]);

  // The keys of a project page. `j` and `k` step through the issues in board order (Your move first).
  const hover = useHover();
  const narrow = useNarrow();
  const compactBar = useCompactBar();
  const [keys, setKeys] = useState(false);
  const order = useMemo(() => (full ? boardOrder(full, asked, atPrompt).filter(includeClaim) : []), [full, asked, atPrompt, includeClaim]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && e.target.closest("input, textarea, select, [contenteditable]");
      // An open picker or dialog takes its keys for itself.
      if (typing || document.querySelector(".picker-list, dialog[open]") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        if (keys) setKeys(false);
        else if (query.get("issue")) select(null);
        return;
      }
      if (e.key === "?" && hover) { setKeys((on) => !on); return; }
      if (!full) return;
      const at = selected ? order.findIndex((n) => n.id === selected.id) : -1;
      if ((e.key === "j" || e.key === "k") && order.length) {
        e.preventDefault();
        const next = order[at < 0 ? 0 : (at + (e.key === "j" ? 1 : -1) + order.length) % order.length];
        select(next.id);
        setFocus({ id: next.id, tick: Date.now() });
      } else if (e.key === "o" && selected) {
        window.open(selected.issue.url, "_blank", "noopener");
      } else if (e.key === "p" && selected?.issue.pullRequests[0]) {
        window.open(selected.issue.pullRequests[0].url, "_blank", "noopener");
      } else if (e.key === "b") {
        setBoard((on) => !on);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [query, select, full, order, selected, keys, hover]);

  const counts = useMemo(() => {
    const tally = new Map<string, { n: number; signal: Signal }>();
    for (const n of full?.nodes ?? []) tally.set(n.status, { n: (tally.get(n.status)?.n ?? 0) + 1, signal: n.signal });
    const statuses = statusOrder({ ...site, waitNames: data?.waitNames });
    return [...tally].sort((a, b) => statuses.indexOf(a[0]) - statuses.indexOf(b[0]));
  }, [full, data?.waitNames]);
  const toggleStatus = useCallback((status: string) => setStatusFilter((now) => {
    const next = new Set(now);
    if (!next.delete(status)) next.add(status);
    return next;
  }), []);
  const effort = useMemo(() => parseStatus(data?.status?.content), [data?.status?.content]);
  const hasCards = useMemo(() => full?.nodes.some((n) => n.card && !n.issue.external) ?? false, [full]);
  const timing = statusTiming(effort, hasCards, data?.status?.updatedAt ?? null, now);
  const ageLabel = timing?.state === "unknown" ? "changed" : timing?.state === "stale" ? "last ran" : "ran";
  const contractMismatch = effort?.contract != null && effort.contract !== import.meta.env.WG_CONTRACT_HASH;
  const listed = useMemo(() => projectGroups(directory?.projects ?? []), [directory]);
  const initiatives = useMemo(() => (directory?.projects ?? []).some((p) => p.initiative), [directory]);
  // One group per workspace and initiative, open projects first; the projects with no initiative come last in
  // their workspace. The lamp is the status; the text names it only when it is not In Progress.
  const projectOptions = useMemo(() => (directory?.workspaces ?? []).flatMap(({ id, name, role, owner }) => [...listed.open, ...listed.closed]
    .filter((p) => p.workspace === id)
    .map((p, at) => ({ p, at }))
    .sort((a, b) => Number(!a.p.initiative) - Number(!b.p.initiative) || (a.p.initiative ?? "").localeCompare(b.p.initiative ?? "") || a.at - b.at)
    .map(({ p }) => {
      const closed = p.statusType === "completed" || p.statusType === "canceled";
      const mine = yours.get(summaryKey(p)) ?? 0;
      const hint = [owner, mine ? `${mine} ${words.forOwner}` : "", p.statusType === "started" ? "" : p.status].filter(Boolean).join(" · ");
      return {
        id: `${p.workspace}:${p.id}`, label: p.name, dim: closed,
        group: role ? "Shared projects" : [directory && directory.workspaces.length > 1 ? name : "", p.initiative ?? (initiatives ? "No initiative" : "")].filter(Boolean).join(" · ") || undefined,
        hint: hint || undefined, lead: <Lamp signal={mine ? "stop" : PROJECT_LAMP[p.statusType] ?? "idle"} />,
      };
    })), [directory, listed, yours, initiatives]);
  const openProject = useCallback((p: Project, issue?: string) =>
    setQuery({ workspace: p.workspace ?? site.defaultWorkspace, project: p.id, issue: issue ?? null }, true), [setQuery]);
  const home = () => setQuery({ workspace: null, project: null, issue: null }, true);
  const waitingTotal = [...yours.values()].reduce((a, b) => a + b, 0);
  const total = full?.nodes.length ?? 0;
  const done = full?.nodes.filter((n) => n.status === "Done").length ?? 0;
  // A canceled issue is not work that is left, so it is not in the total that "done" counts to.
  const planned = total - (full?.nodes.filter((n) => n.status === "Canceled").length ?? 0);

  const nativeBarTitles = hover && !compactBar;
  const overviewHelp = `All projects: which ones wait ${words.onOwner}, and how far each one is.`;
  const autonomyHelp = `Autonomy level: what the coordinator may do without ${words.owner}.${project?.autonomy ? "" : " No label on the project: standard."} A change tells the coordinator at once.`;
  const reviewHelp = `Review effort: how much review each PR gets.${project?.review ? "" : " No label on the project: thorough."} A change tells the coordinator at once.`;
  const sharedHelp = "Each account that may sign in to the viewer can read this project there. It cannot change it.";
  const stopSharingHelp = "Remove this project from the viewer.";
  const shareHelp = "Show this project on the read-only viewer, for each account that may sign in there. The link to copy shows here then.";
  const viewerHelp = "This page changes nothing. The owner of the project changes it on their own page.";
  const boardHelp = "Show or hide the list of issues by the action they need. Press / to find an issue.";
  const syncHelp = `Refresh now. The graph also refreshes every 15 s.${syncedAt ? ` Last sync ${syncedAt.toLocaleTimeString()}.` : ""}`;
  const keysHelp = "Keyboard keys (?)";
  const signOutHelp = `Signed in as ${site.user}. Select to sign out.`;
  const closeHelp = "Mark every issue in this project Done and complete the project.";
  const activeProject = project && project.statusType !== "completed" && project.statusType !== "canceled";
  const autonomyPicker = !sharedRole && activeProject && (
    <Picker wide value={[autonomy]} onChange={([level]) => void setAutonomy(level as AutonomyLevel)} disabled={autonomyBusy || viewer} title={nativeBarTitles ? autonomyHelp : undefined}
      options={AUTONOMY_LEVELS.map((level) => ({ id: level, label: level, hint: AUTONOMY_HINTS[level] }))}>
      <span className={`bar-autonomy auto-${autonomy}`}>{autonomyBusy ? "Autonomy…" : <>Autonomy <b>{autonomy}</b></>}</span><span className="caret">▾</span>
    </Picker>
  );
  const reviewPicker = !sharedRole && activeProject && (
    <Picker wide value={[review]} onChange={([level]) => void setReviewEffort(level as ReviewEffort)} disabled={reviewBusy || viewer} title={nativeBarTitles ? reviewHelp : undefined}
      options={REVIEW_LEVELS.map((level) => ({ id: level, label: level, hint: REVIEW_HINTS[level] }))}>
      <span className={`bar-review review-${review}`}>{reviewBusy ? "Review…" : <>Review <b>{review}</b></>}</span><span className="caret">▾</span>
    </Picker>
  );
  const shareControl = (dismiss?: () => void) => {
    if (viewer || sharedRole || !project) return null;
    if (service && openKey) return (
      <button type="button" className="ghost bar-share" onClick={() => {
        dismiss?.();
        setSharing(openKey);
        pageEvent("share_dialog_opened", project.workspace);
      }}>Share</button>
    );
    if (!shareLink) return null;
    if (project.shared) return (
      <span className="bar-share" title={nativeBarTitles ? sharedHelp : undefined}>
        <b>Shared</b><CopyButton text={shareLink} label="Copy the viewer link" />
        <button type="button" className="ghost" disabled={shareBusy} onClick={() => void setShared(false)} aria-label="Stop sharing" title={nativeBarTitles ? stopSharingHelp : undefined}>Stop</button>
      </span>
    );
    return <button type="button" className="ghost bar-share" disabled={shareBusy} onClick={() => void setShared(true)} title={nativeBarTitles ? shareHelp : undefined}>{shareBusy ? "Sharing…" : "Share"}</button>;
  };
  const boardControl = (dismiss?: () => void) => full && (
    <button type="button" className={`toggle toggle-board${board ? " is-on" : ""}`} aria-pressed={board} title={nativeBarTitles ? boardHelp : undefined}
      onClick={() => { setBoard(!board); dismiss?.(); }}>Board</button>
  );
  const viewPicker = full && (
    <Picker multi align="right" title={nativeBarTitles ? "View options" : undefined} value={[openOnly && "open", allEdges && "edges", map && "map"].filter(Boolean) as string[]}
      onChange={(ids) => { setOpenOnly(ids.includes("open")); setAllEdges(ids.includes("edges")); setMap(ids.includes("map")); }}
      options={[
        { id: "open", label: "Open issues only", hint: "hide done, canceled" },
        { id: "edges", label: "Every blocks edge", hint: "also implied ones" },
        { id: "map", label: "Small map" },
      ]}>
      <span className="bar-view">View{(openOnly || allEdges) && <i className="bar-view-dot" aria-label="filters on" />}</span><span className="caret">▾</span>
    </Picker>
  );
  const syncTime = syncedAt?.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const serverVersion = versionText(status);
  const keysControl = hover && (
    <button type="button" className={`ghost bar-keys${keys ? " is-on" : ""}`} aria-pressed={keys} onClick={() => setKeys(!keys)} aria-label="Keyboard keys" title={nativeBarTitles ? keysHelp : undefined}>?</button>
  );
  const settings = openSettings && <button type="button" className="ghost bar-settings" onClick={openSettings}>Settings</button>;
  const signOut = site.user && <a className="bar-user" href="/auth/logout" title={nativeBarTitles ? signOutHelp : undefined}>Sign out</a>;
  const closeControl = !viewer && !sharedRole && activeProject && (
    <button type="button" className="ghost bar-close" disabled={closing || busy} onClick={() => void closeProject()} title={nativeBarTitles ? closeHelp : undefined}>
      {closing ? "Closing…" : "Close project"}
    </button>
  );
  const projectLink = project && new URL(`?${new URLSearchParams({ workspace: project.workspace ?? site.defaultWorkspace, project: project.id })}`, location.href).href;

  return (
    <div className={service ? "app service-app" : "app"}>
      <header className="bar project-bar">
        <span className="brand">work-graph</span>
        {(project || missing) && (
          <button type="button" className="bar-home" onClick={home} title={nativeBarTitles ? overviewHelp : undefined}>
            <span className="bar-home-label">Overview</span><span className="bar-home-arrow" aria-hidden>←</span>
            {waitingTotal > 0 && <b className="bar-home-count mono" aria-label={`${waitingTotal} issues wait ${words.onOwner}`}>{waitingTotal}</b>}
          </button>
        )}
        <Picker value={project ? [`${project.workspace}:${project.id}`] : []} onChange={([id]) => {
          const selected = directory?.projects.find((p) => `${p.workspace}:${p.id}` === id);
          if (selected) openProject(selected);
        }} wide options={projectOptions}>
          <span className="bar-project">{project
            ? (narrow ? project.name : [project.workspaceName, project.initiative, project.name].filter(Boolean).join(" / "))
            : (directory ? "Open a project" : "Loading projects…")}</span><span className="caret">▾</span>
        </Picker>
        {!compactBar && <>
          {project && <CopyButton text={project.name} label="Copy the project name" />}
          {autonomyPicker}
          {reviewPicker}
          {shareControl()}
        </>}
        <span className="station-fill" />
        {!narrow && viewer && <span className="bar-viewer" title={nativeBarTitles ? viewerHelp : undefined}>view only</span>}
        {!narrow && boardControl()}
        {!narrow && viewPicker}
        {full && (
          <button type="button" className="sync" onClick={() => project && void load(project)} aria-label="Refresh project"
            title={nativeBarTitles ? syncHelp : undefined} aria-description={syncHelp}>
            <span className={`sync-dot${busy ? " is-busy" : ""}`} /><span className="sync-time">{syncTime ?? "…"}</span>
          </button>
        )}
        {compactBar ? (
          <BarMenu key={openKey} title={project ? "Project controls" : "More controls"}>{(dismiss) => <>
            {viewer && <p>{viewerHelp}</p>}
            {projectLink && <div className="bar-menu-row"><span>Project link</span><CopyButton text={projectLink} label="Copy the project link" secret /></div>}
            {project && <div className="bar-menu-row"><span>Copy the project name: {project.name}</span><CopyButton text={project.name} label="Copy the project name" /></div>}
            {!service && !viewer && !sharedRole && shareLink && <p>{project?.shared ? sharedHelp : shareHelp}</p>}
            {shareControl(dismiss)}
            {!service && !viewer && !sharedRole && project?.shared && shareLink && <>
              <p>Copy the viewer link: {shareLink}</p>
              <p>{stopSharingHelp}</p>
            </>}
            {autonomyPicker && <div className="bar-menu-field">
              {autonomyPicker}
              <p>{autonomyHelp}</p>
            </div>}
            {reviewPicker && <div className="bar-menu-field">
              {reviewPicker}
              <p>{reviewHelp}</p>
            </div>}
            {narrow && boardControl(dismiss)}
            {narrow && viewPicker}
            {full && <>
              <p>{boardHelp}</p>
              <p>View options</p>
              <p>{syncHelp}</p>
            </>}
            {(project || missing) && <p>{overviewHelp}</p>}
            {serverVersion && <p>The build of the server: <span className="mono">{status?.version}</span></p>}
            {hover && <button type="button" className="ghost" onClick={() => { dismiss(); setKeys(!keys); }}>{keysHelp}</button>}
            {!hover && <p>{keysHelp}</p>}
            {settings}
            {site.user && <div className="bar-menu-row"><span>{signOutHelp}</span>{signOut}</div>}
            {closeControl && <div className="bar-menu-danger"><p>{closeHelp}</p>{closeControl}</div>}
          </>}</BarMenu>
        ) : <>
          {serverVersion && <Hint className="bar-version mono" text={`The build of the server: ${status!.version}`}>{serverVersion}</Hint>}
          {keysControl}
          {settings}
          {signOut}
          {closeControl}
        </>}
      </header>

      {sharing && sharing === openKey && project && <Share id={project.id}
        workspace={project.workspace} team={connections?.find(({ workspace_id }) => workspace_id === project.workspace)?.team}
        close={() => setSharing(null)} />}
      {service && collaborator && openKey && project && openSettings && <MemberAccess key={openKey}
        id={project.id} workspace={project.workspace} openSettings={openSettings} />}

      {full && (
        <div className="rail-bar">
          <div className={`aspects${statusFilter.size ? " is-filtered" : ""}`} role="group" aria-label="Show only these statuses">
            {counts.map(([status, c]) => (
              <button type="button" key={status} className={`aspect${statusFilter.has(status) ? " is-on" : ""}`} aria-pressed={statusFilter.has(status)}
                onClick={() => toggleStatus(status)} title={statusFilter.has(status) ? `Stop the filter on ${status}` : `Dim all but ${status}`}>
                <Lamp signal={c.signal} />{status}<b className="mono">{c.n}</b>
              </button>
            ))}
            {statusFilter.size > 0 && <button type="button" className="ghost" onClick={() => setStatusFilter(new Set())}>Show all</button>}
          </div>
          {canFilterClaims && <label className="claim-filter">
            Runner <select value={claimFilter} onChange={(event) => chooseClaimFilter(parseClaimFilter(event.target.value))}>
              <option value="all">All</option><option value="mine">Mine</option><option value="theirs">Theirs</option>
            </select>
          </label>}
          <div className="tally">
            <div className="tally-track">
              {counts.map(([status, c]) => (
                <span key={status} className="tally-segment" style={{ flexGrow: c.n }} tabIndex={0}
                  role="img" aria-label={`${status}: ${c.n} of ${total} issues`}>
                  <i className={`sig-bg-${c.signal}`} />
                  <span className="tally-tip" aria-hidden="true">{status} · {c.n}/{total}</span>
                </span>
              ))}
            </div>
            <span><b className="mono">{done}/{planned}</b> done</span>
          </div>
        </div>
      )}

      {contractMismatch && (
        // A hash cannot tell which side is older: an old record and an old page look the same.
        <div className="effort effort-warning" role="status">
          wg next wrote this record with contract <span className="mono">{effort?.contract}</span>; this page has <span className="mono">{import.meta.env.WG_CONTRACT_HASH}</span>.
          Run wg next with the wg of this repository.
        </div>
      )}
      {sharedProject && presence?.coordinators.some((row) => row.connected) && (
        <div className="effort" aria-label="Connected coordinators">
          <span className="effort-mark">Coordinators</span>
          {presence.coordinators.filter((row) => row.connected).map((row) =>
            <span key={row.session} className="effort-age">{row.accountName ?? (!sharedRole ? site.human : entry?.owner)}</span>)}
        </div>
      )}
      {!timing && (coordinator || commands) && (
        <div className="effort">
          <span className="effort-mark">wg next</span><span className="effort-status" />
          {coordinator && <span className={`effort-age coord-${coordinator.state}`} title={coordinator.title}>{coordinator.text}</span>}
          {commands}
        </div>
      )}
      {timing && (
        <div className={`effort${timing.state === "stale" || timing.state === "never" ? " effort-warning" : ""}`}
          title={effort?.lines.map((l) => `${l.level} ${l.text}`).join("\n") || undefined}>
          <span className="effort-mark">wg next</span>
          {timing.state === "never"
            ? <span>wg next has not published this effort</span>
            : <span className="effort-status">{effort?.status}</span>}
          {coordinator
            ? <span className={`effort-age coord-${coordinator.state}`} title={coordinator.title}>{coordinator.text}</span>
            : timing.state === "listening" && <span className="effort-age">listening</span>}
          {timing.age && <span className="effort-age" title={timing.state === "unknown" ? "When the result last changed." : "When wg next last published."}>{ageLabel} {timing.age}</span>}
          {commands}
        </div>
      )}

      {stale && <div className="effort effort-warning" role="status" title={stale.title}>{stale.text}</div>}
      {(closeError || error) && <div className="error" role="alert"><span>{closeError || error}</span><button type="button" className="ghost" onClick={() => { setError(null); setCloseError(null); }}>Dismiss</button></div>}

      {hover && keys && (
        <div className="keys" role="dialog" aria-label="Keyboard keys">
          <header><b>Keys</b><button type="button" className="ghost" onClick={() => setKeys(false)} aria-label="Close">✕</button></header>
          <dl>
            <dt><kbd>j</kbd> <kbd>k</kbd></dt><dd>Next or previous issue, in board order: {words.move} first</dd>
            <dt><kbd>o</kbd></dt><dd>Open the issue in Linear</dd>
            <dt><kbd>p</kbd></dt><dd>Open the PR of the issue in GitHub</dd>
            <dt><kbd>b</kbd></dt><dd>Show or hide the board</dd>
            <dt><kbd>/</kbd></dt><dd>Find an issue (board) or a project (overview)</dd>
            {!project && <>
              <dt><kbd>↑</kbd> <kbd>↓</kbd></dt><dd>Move between inbox rows when the inbox has focus</dd>
              <dt><kbd>r</kbd> <kbd>↵</kbd></dt><dd>Open a reply in the inbox</dd>
            </>}
            <dt><kbd>Esc</kbd></dt><dd>{project ? "Close the issue" : "Close the inbox reply"}</dd>
            <dt><kbd>⌘</kbd> <kbd>↵</kbd></dt><dd>Send a comment or a reply</dd>
            <dt><kbd>⌥1</kbd>–<kbd>⌥4</kbd></dt><dd>Send a choice when its group has focus and the reply box is empty</dd>
          </dl>
          {!project && <p>Overview order is Stalled, Waits {words.onOwner}, Moving, then Idle by design.</p>}
        </div>
      )}

      <main className="stage">
        {!project && directory && (
          <Overview list={overview ?? directory} loading={overviewBusy} missing={missing} now={now} onOpen={openProject} readOnly={viewer} presence={link.presence} asks={link.asksBy} agents={link.agentsBy}
            budget={budget} states={overviewStates} onStates={(states) => setQuery({ state: states.join(",") || null }, true)}
            initiative={query.get("initiative")} onInitiative={(name) => setQuery({ initiative: name }, true)} />
        )}
        {project && !data && !error && <div className="blank">Loading {project.name}…</div>}
        {board && full && full.nodes.length > 0 && <Board graph={full} marks={marks} filter={claimFilter} now={now} selectedId={selected?.id ?? null} onPick={pick} onHover={setHoverId} onReview={canReview && !viewer ? onReview : undefined}
          asked={asked} atPrompt={atPrompt}
          live={new Map(link.progress.flatMap((p) => { const job = liveJob(p); return job && p.issue ? [[p.issue, job] as [string, string]] : []; }))} />}
        {graph && data && !graph.nodes.length && <div className="blank">{claimFilter !== "all" ? "No issues match this runner filter." : openOnly ? "No open issues. Turn off “Open issues only” under View to see all." : "This project has no issues."}</div>}
        {graph && placed && graph.nodes.length > 0 && (
          <Canvas graph={graph} marks={marks} now={now} edges={edges} layout={placed.layout} selectedId={selected?.id ?? null} hoverId={hoverId} statusFilter={statusFilter}
            focus={focus} showMap={map} onSelect={select} onHover={setHoverId} />
        )}
        {selected && full && data && (
          <Panel node={selected} claim={selectedClaim}
            onRelease={!viewer && linkRef && canReleaseClaim(selectedClaim, claims?.role) ? async (node) => {
              await api.releaseClaim(linkRef.id, linkRef.workspace, node);
              refreshClaims.current();
            } : undefined} now={now} graph={full} data={data} asks={asks.filter((a) => a.issue === selected.issue.identifier)}
            progress={link.progress.find((p) => p.issue === selected.issue.identifier)}
            agent={agentsFresh(agents, now) ? agents.agents.find((a) => a.issue === selected.issue.identifier) : undefined}
            onDispatch={canCommand ? (key, issue) => command({ name: "dispatch", key, issue }, `Dispatch of ${issue} sent.`) : undefined} onPatch={onPatch} onClose={() => select(null)} onError={setError} onReview={canReview && !viewer ? onReview : undefined} readOnly={viewer} limitedEdits={collaborator}
            onGo={(id) => { select(id); setFocus({ id, tick: Date.now() }); }} />
        )}
      </main>
    </div>
  );
}
