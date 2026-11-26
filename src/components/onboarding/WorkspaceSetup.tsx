import { useEffect, useState } from "react";
import { accountApi, ApiError } from "../../api";
import { validateNewTeam, type Step } from "../../lib/onboarding";
import type { AccountConnection, AccountTeam, TeamSetupState } from "../../lib/types";
import { TeamForm, WorkspaceStatus, type RefreshAccount } from "../Settings";
import { StatusFlow } from "./StatusFlow";

function SetupError({ error }: { error: unknown }) {
  if (!error) return null;
  return <div role="alert" className="account-error">
    {error instanceof Error ? error.message : "Could not check team setup."}
    {error instanceof ApiError && error.body.fallback && <p>Run this command on your computer.<br /><code>{error.body.fallback}</code></p>}
  </div>;
}

function CreateTeam({ workspace, human, plan, refresh }: {
  workspace: AccountConnection; human: string; plan: TeamSetupState["plan"]; refresh: RefreshAccount;
}) {
  const [teams, setTeams] = useState<AccountTeam[]>([]);
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
      const initials = human.toUpperCase().match(/\b[A-Z]/g)?.join("").slice(0, 5) ?? "";
      setKey(["WG", initials.slice(0, 1) + "WG", initials + "WG"].find(k => !list.some(t => t.key === k)) ?? "");
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
      await accountApi.createTeam(workspace.id, { ...team, parent: privateTeam ? parent : null, private: privateTeam });
      await refresh();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }}>
    <h3>Recommended: a private sub-team for agent work</h3>
    <p>Agent claims, the 13 work-graph statuses, and agent follow-ups stay out of your main team.
      Only you see the private sub-team. Its parent team can include it in views. You can add people later.</p>
    {privateTeam ? <label>Parent team<select value={parent} onChange={e => setParent(e.target.value)} required>
      {teams.map(t => <option key={t.key} value={t.key}>{t.name} ({t.key})</option>)}
    </select></label> : <p>Your plan does not include private sub-teams. You can create a public team.</p>}
    <label>Key<input required maxLength={7} pattern="[A-Z][A-Z0-9]{0,6}" value={key} onChange={e => setKey(e.target.value.toUpperCase())} /></label>
    <label>Name<input required maxLength={80} value={name} onChange={e => setName(e.target.value)} /></label>
    <div><button disabled={busy || !validateNewTeam(key, name) || (privateTeam && !parent)}>
      {privateTeam ? "Create private sub-team" : "Create team"}</button></div>
    <SetupError error={error} />
    {error && !teams.length ? <button type="button" onClick={() => retry(n => n + 1)}>Retry teams</button> : null}
  </form>;
}

export function WorkspaceSetup({ workspace, human, step, record, checkKey, refresh }: {
  workspace: AccountConnection; human: string; step: Step; checkKey: string; refresh: RefreshAccount;
  record: (key: string, ready: boolean) => void;
}) {
  const [state, setState] = useState<TeamSetupState>();
  const [error, setError] = useState<unknown>();
  const [attempt, retry] = useState(0);
  const [busy, setBusy] = useState(false);
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
    setError(null);
    try {
      await accountApi.applyTeamSetup(id, team);
      setState(await accountApi.teamSetup(id, team));
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return <article className="account-item">
    <h3>{workspace.name}</h3><WorkspaceStatus workspace={workspace} />
    <SetupError error={error} />
    {status === "ok" && <>
      {!state && !error && <p role="status">Checking team setup…</p>}
      {error || (step === "statuses" && state?.team && !ready) ? <div><button onClick={() => retry(n => n + 1)}>Check again</button></div> : null}
      {step === "teams" ? <>
        {state && <CreateTeam workspace={workspace} human={human} plan={state.plan} refresh={refresh} />}
        <h3>Use an existing team</h3><TeamForm workspace={workspace} refresh={refresh} />
      </> : team && state?.team ? <StatusFlow state={state} workspace={workspace} human={human} apply={apply} busy={busy} /> :
        <p>Select a team on the Team step.</p>}
    </>}
  </article>;
}
