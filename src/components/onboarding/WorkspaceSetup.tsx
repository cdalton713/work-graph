import { useEffect, useRef, useState } from "react";
import { accountApi, ApiError } from "../../api";
import { defaultTeamKey, validateNewTeam, type Step } from "../../lib/onboarding";
import type { AccountConnection, ListedTeam, SetupTeam, TeamSetupState } from "../../lib/types";
import { TeamForm, WorkspaceStatus, type RefreshAccount } from "../Settings";
import { CopyButton } from "../ui";
import { StatusFlow } from "./StatusFlow";

function SetupError({ error }: { error: unknown }) {
  if (!error) return null;
  const body = error instanceof ApiError ? error.body : undefined;
  return <div role="alert" className="account-error">
    {error instanceof Error ? error.message : "Could not check team setup."}
    {body?.team && <p>Linear created {body.team.name} ({body.team.key}). Check its visibility before you use it.</p>}
    {body?.fallback && <>
      <p>Run this command on your computer.</p>
      <div className="account-command"><pre>{body.fallback}</pre><CopyButton text={body.fallback} label="Copy fallback command" /></div>
      <p>After it runs, select the new team under Use an existing team, then choose Check again.</p>
    </>}
  </div>;
}

function CreateTeam({ workspace, human, plan, refresh, onCreated, onError }: {
  workspace: AccountConnection; human: string; plan: TeamSetupState["plan"]; refresh: RefreshAccount;
  onCreated: (team: SetupTeam) => void; onError: (error: unknown) => void;
}) {
  const [teams, setTeams] = useState<ListedTeam[]>([]);
  const [key, setKey] = useState("");
  const [name, setName] = useState(`Work Graph – ${human}`);
  const [parent, setParent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [attempt, retry] = useState(0);
  const privateTeam = plan.privateTeams && plan.subTeams;
  useEffect(() => {
    const controller = new AbortController();
    accountApi.teams(workspace.id, controller.signal).then(list => {
      if (controller.signal.aborted) return;
      setTeams(list);
      setParent(list.find(t => t.key === workspace.team)?.key ?? list[0]?.key ?? "");
      setKey(defaultTeamKey(human, list.map(t => t.key)));
      setError(null);
    }, e => { if (!controller.signal.aborted) setError(e); });
    return () => controller.abort();
  }, [workspace.id, workspace.team, human, attempt]);
  return <form className="account-form setup-recommendation" onSubmit={async event => {
    event.preventDefault();
    const team = validateNewTeam(key, name);
    if (!team || (privateTeam && !parent)) return;
    setBusy(true);
    setError(null);
    try {
      const created = await accountApi.createTeam(workspace.id, { ...team, parent: privateTeam ? parent : null, private: privateTeam });
      onCreated(created);
      await refresh();
    } catch (e) { onError(e); } finally { setBusy(false); }
  }}>
    <h3>Recommended: {privateTeam ? "a private sub-team" : "a team"} for agent work</h3>
    {privateTeam ? <ul>
      <li>Agent claims, the 13 work-graph statuses, and agent follow-ups stay out of your main team.</li>
      <li>Only you see it. Its parent team can still include it in views.</li>
      <li>You can add people later.</li>
    </ul> : <p>Your plan does not include private sub-teams. You can create a public team for agent work.</p>}
    {privateTeam ? <label>Parent team for {workspace.name}<select value={parent} onChange={e => setParent(e.target.value)} required>
      {teams.map(t => <option key={t.key} value={t.key}>{t.name} ({t.key})</option>)}
    </select></label> : null}
    <label>Key for {workspace.name}<input required maxLength={7} pattern="[A-Z][A-Z0-9]{0,6}" value={key} onChange={e => setKey(e.target.value.toUpperCase())} /></label>
    <label>Name for {workspace.name}<input required maxLength={80} value={name} onChange={e => setName(e.target.value)} /></label>
    <div><button disabled={busy || !validateNewTeam(key, name) || (privateTeam && !parent)}>
      {privateTeam ? "Create private sub-team" : "Create team"}</button></div>
    <SetupError error={error} />
    {error && !teams.length ? <button type="button" onClick={() => retry(n => n + 1)}>Retry teams</button> : null}
  </form>;
}

export function WorkspaceSetup({ workspace, human, step, record, checkKey, refresh, created, onCreated, confirmationRef }: {
  workspace: AccountConnection; human: string; step: Step; checkKey: string; refresh: RefreshAccount;
  created?: SetupTeam; onCreated: (team: SetupTeam) => void; confirmationRef: (node: HTMLParagraphElement | null) => void;
  record: (key: string, ready: boolean) => void;
}) {
  const [state, setState] = useState<TeamSetupState>();
  const [error, setError] = useState<unknown>();
  const [attempt, retry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>();
  const [listVersion, reloadTeams] = useState(0);
  const [added, setAdded] = useState("");
  const addStatus = useRef<HTMLParagraphElement>(null);
  const partialTeam = actionError instanceof ApiError ? actionError.body.team : undefined;
  function checkAgain() {
    retry(n => n + 1);
    reloadTeams(n => n + 1);
  }
  useEffect(() => {
    if (!(actionError instanceof ApiError && actionError.body.fallback)) return;
    const reload = () => reloadTeams(n => n + 1);
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [actionError]);
  useEffect(() => { if (added) addStatus.current?.focus(); }, [added]);
  const { id, team, status } = workspace;
  useEffect(() => {
    if (status !== "ok") return;
    const controller = new AbortController();
    accountApi.teamSetup(id, team || "WG", controller.signal).then(result => {
      if (!controller.signal.aborted) { setState(result); setError(null); }
    }, e => { if (!controller.signal.aborted) { setError(e); setState(undefined); } });
    return () => controller.abort();
  }, [id, status, team, attempt]);
  const ready = !!team && state?.team?.key === team && [...state.statuses, ...state.labels].every(item => item.state === "exists");
  useEffect(() => record(checkKey, ready), [checkKey, ready, record]);
  if (step !== "teams" && step !== "statuses") return null;
  async function apply() {
    setBusy(true);
    setActionError(null);
    setAdded("");
    try {
      const result = await accountApi.applyTeamSetup(id, team);
      setState(await accountApi.teamSetup(id, team));
      const warnings = result.warned.length ? " Check in Linear: " + result.warned.join(", ") + "." : "";
      setAdded(`Added ${result.created.length} items.${warnings}`);
    } catch (e) { setActionError(e); } finally { setBusy(false); }
  }
  return <article className="account-item">
    <h3>{workspace.name}</h3><WorkspaceStatus workspace={workspace} />
    <SetupError error={error || actionError} />
    {partialTeam && <div><button disabled={busy} onClick={async () => {
      setBusy(true);
      try {
        await accountApi.updateWorkspace(id, { team: partialTeam.key });
        onCreated(partialTeam);
        await refresh();
        checkAgain();
      } catch (e) { setError(e); } finally { setBusy(false); }
    }}>Use this team</button></div>}
    {status === "ok" && <>
      {!state && !error && <p role="status">Checking team setup…</p>}
      {(error || actionError || step === "teams" || !ready) ? <div><button disabled={busy} onClick={checkAgain}>Check again</button></div> : null}
      {step === "teams" ? <>
        {created && created.key === team ? <p role="status" tabIndex={-1} ref={confirmationRef}>
          Created {created.name} ({created.key}), {created.private ? "private" : "public"}{created.parent && ", under " + created.parent.key}. It is now the team for {workspace.name}.
        </p> : state && <CreateTeam workspace={workspace} human={human} plan={state.plan} refresh={refresh}
          onCreated={onCreated} onError={e => { setActionError(e); reloadTeams(n => n + 1); }} />}
        <h3>Use an existing team</h3><TeamForm key={listVersion} workspace={workspace} refresh={refresh} />
      </> : team && state?.team ? <>
        {added && <p role="status" tabIndex={-1} ref={addStatus}>{added}</p>}
        {state.suggestedProjectLabelScope && <button disabled={busy} onClick={async () => {
          setBusy(true);
          setActionError(null);
          try {
            await accountApi.updateWorkspace(id, { team_labels: state.suggestedProjectLabelScope === "team" });
            await refresh();
          } catch (e) { setActionError(e); } finally { setBusy(false); }
        }}>Use {state.suggestedProjectLabelScope} project labels</button>}
        <StatusFlow state={state} workspace={workspace} human={human} apply={apply} busy={busy} /></> :
        <p>Select a team on the Team step.</p>}
    </>}
  </article>;
}
