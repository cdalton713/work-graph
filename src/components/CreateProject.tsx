import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../api";
import type { StarterResult, WorkspaceSummary } from "../lib/types";
import { Sheet } from "./ui";

interface CreateProps {
  workspaces: WorkspaceSummary[];
  onCreated: (result: StarterResult) => void;
}

export function CreateProject(props: CreateProps) {
  const [open, setOpen] = useState(false);
  return <>
    <button className="primary" aria-haspopup="dialog" onClick={() => setOpen(true)}>Create project</button>
    {open && <CreateForm {...props} onClose={() => setOpen(false)} />}
  </>;
}

function CreateForm({ workspaces, onCreated, onClose }: CreateProps & { onClose: () => void }) {
  const [workspace, setWorkspace] = useState(workspaces[0]?.id ?? "");
  const [teams, setTeams] = useState<{ key: string; name: string }[]>([]);
  const [team, setTeam] = useState("");
  const [name, setName] = useState("");
  const [firstTask, setFirstTask] = useState("");
  const [error, setError] = useState("");
  const [teamError, setTeamError] = useState("");
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setTeamError("");
    if (workspace) {
      api.starterTeams(workspace, controller.signal).then(({ teams }) => {
        if (controller.signal.aborted) return;
        setTeams(teams);
        setTeam(teams[0]?.key ?? "");
      }).catch(e => {
        if (!controller.signal.aborted) setTeamError(e.message);
      }).finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    } else setLoading(false);
    return () => controller.abort();
  }, [workspace, attempt]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || !team || !name.trim() || !firstTask.trim()) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      onCreated(await api.createProject(workspace, team.trim(), name.trim(), firstTask.trim()));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the project.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return <Sheet open title="Create project" onClose={() => { if (!submitting.current) onClose(); }}>
    <form className="account-form starter-form" onSubmit={submit}>
      <label>Workspace<select required value={workspace} disabled={busy} onChange={e => {
        setTeams([]); setTeam(""); setLoading(true); setError(""); setWorkspace(e.target.value);
      }}>{workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
      <label>Team<select required value={team} disabled={busy || loading || !teams.length} onChange={e => setTeam(e.target.value)}>
        {!teams.length && <option value="">{loading ? "Loading teams…" : "No eligible team"}</option>}
        {teams.map(t => <option key={t.key} value={t.key}>{t.name} ({t.key})</option>)}
      </select></label>
      {teamError && <div role="alert">{teamError} <button type="button" onClick={() => setAttempt(n => n + 1)}>Retry teams</button></div>}
      <label>Project name<input required maxLength={120} disabled={busy} value={name} onChange={e => setName(e.target.value)} /></label>
      <label>First task<input required maxLength={120} disabled={busy} value={firstTask} onChange={e => setFirstTask(e.target.value)} /></label>
      {error && <p className="account-error" role="alert">{error}</p>}
      <button className="primary" disabled={busy || !team || !name.trim() || !firstTask.trim()}>{busy ? "Creating…" : "Create project"}</button>
    </form>
  </Sheet>;
}

export function StarterSetup({ handoff, onClose }: { handoff: StarterResult["handoff"]; onClose: () => void }) {
  const [files, setFiles] = useState<{ name: string; href: string }[]>([]);
  useEffect(() => {
    const files = (["plan", "keymap"] as const).map(key => ({
      name: key + ".json",
      href: URL.createObjectURL(new Blob([JSON.stringify(handoff[key], null, 2) + "\n"], { type: "application/json" })),
    }));
    setFiles(files);
    return () => files.forEach(file => URL.revokeObjectURL(file.href));
  }, [handoff]);
  return <Sheet open title="Coordinator setup" onClose={onClose}>
    <div className="account-form starter-form">
      <p>Save both files in a new coordinator checkout of the target repository.</p>
      {files.map(file => <a key={file.name} href={file.href} download={file.name}>Download {file.name}</a>)}
      <p>Configure workspace <code>{handoff.plan.effort.workspace}</code> and team <code>{handoff.plan.effort.team}</code>.</p>
      {handoff.keymap.collab && <p>Sign in with <code>wg login {handoff.keymap.collab.page}</code>.</p>}
      <p>Run this command in the checkout before you edit the files.</p>
      <code>{handoff.command}</code>
    </div>
  </Sheet>;
}
