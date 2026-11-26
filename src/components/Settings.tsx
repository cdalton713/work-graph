import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Intro } from "./Intro";
import { InstalledSignInHelp } from "./SignIn";
import { accountApi } from "../api";
import { validateNewTeam, type NewTeam } from "../lib/onboarding";
import type { Account, AccountConnection, AccountTeam } from "../lib/types";

export type RefreshAccount = () => Promise<Account>;

export function useAccountAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : "The request failed. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

export function AccountError({ error }: { error: string }) {
  return error ? <p className="account-error" role="alert">{error}</p> : null;
}

export function useDialogViewport(dialog: RefObject<HTMLDialogElement | null>) {
  useLayoutEffect(() => {
    const node = dialog.current;
    const viewport = window.visualViewport;
    if (!node || !viewport) return;

    const resize = () => {
      node.style.setProperty("--dialog-top", `${viewport.offsetTop}px`);
      node.style.setProperty("--dialog-height", `${viewport.height}px`);
    };
    resize();
    viewport.addEventListener("resize", resize);
    viewport.addEventListener("scroll", resize);
    return () => {
      viewport.removeEventListener("resize", resize);
      viewport.removeEventListener("scroll", resize);
    };
  }, [dialog]);
}

function AccountDialog({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const closeButton = useRef<HTMLButtonElement>(null);
  useDialogViewport(dialog);
  useLayoutEffect(() => {
    const node = dialog.current!;
    const opener = document.activeElement;
    node.showModal();
    (node.querySelector("input") ?? closeButton.current)?.focus();
    return () => {
      node.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  return <dialog ref={dialog} className="account-dialog" aria-labelledby={heading} onCancel={(event) => {
    event.preventDefault();
    close();
  }}>
    <h2 id={heading}>{title}</h2>
    {children}
    <button ref={closeButton} type="button" onClick={close}>Close</button>
  </dialog>;
}

export function NameForm({ human, refresh, next }: { human: string; refresh: RefreshAccount; next?: () => void }) {
  const [name, setName] = useState(human);
  const { busy, error, run } = useAccountAction();
  return <form className="account-form" onSubmit={(event) => {
    event.preventDefault();
    void run(async () => {
      const trimmed = name.trim();
      if (!/^[A-Za-z][A-Za-z0-9 ]*$/.test(trimmed)) {
        throw new Error("Use letters A to Z, digits, and spaces. Start with a letter.");
      }
      await accountApi.saveName(trimmed);
      await accountApi.onboarding({ name: true });
      const account = await refresh();
      setName(account.human);
      next?.();
    });
  }}>
    <label>Name<input value={name} onChange={(event) => setName(event.target.value)} required maxLength={40} /></label>
    <p><code>wg</code> and the page use your name for the <code>Needs {name || "Name"}</code> status.</p>
    {!next && <p>Use the same <code>human</code> name in your <code>wg</code> config.</p>}
    <AccountError error={error} />
    <div><button className="primary" disabled={busy}>Save name</button></div>
  </form>;
}

export function WorkspaceKeyForm({ workspace, refresh }: { workspace?: AccountConnection; refresh: RefreshAccount }) {
  const [key, setKey] = useState("");
  const { busy, error, run } = useAccountAction();
  return <form className="account-form" onSubmit={(event) => {
    event.preventDefault();
    void run(async () => {
      if (workspace) await accountApi.replace(workspace.id, key.trim());
      else await accountApi.attach(key.trim());
      setKey("");
      await refresh();
    });
  }}>
    <label>{workspace ? `New API key for ${workspace.name}` : "Personal API key"}
      <input type="password" autoComplete="off" spellCheck={false} value={key} disabled={busy}
        onChange={(event) => setKey(event.target.value)} required />
    </label>
    <AccountError error={error} />
    <p><a href="https://linear.app/settings/api" target="_blank" rel="noreferrer">Open Linear API key settings</a>. The service encrypts
      your key, hides it after you save it, and deletes it when you remove the workspace.</p>
    <div><button className="primary" disabled={busy}>{workspace ? "Replace key" : "Attach another workspace"}</button></div>
  </form>;
}

export function WorkspaceStatus({ workspace }: { workspace: AccountConnection }) {
  return <><p className="account-muted">
    {workspace.kind === "oauth" ? "Sign-in workspace" : "Personal API key"} · {workspace.status === "ok" ? "Active" :
      workspace.kind === "api_key" ? "Needs a new key" :
        <a href={`/auth/login?next=${encodeURIComponent(location.pathname + location.search)}`}>Sign in again</a>}
  </p>
  {workspace.kind === "oauth" && workspace.status !== "ok" && <InstalledSignInHelp />}
  </>;
}

export function TeamForm({ workspace, refresh, draft, saveDraft }: {
  workspace: AccountConnection; refresh: RefreshAccount; draft?: NewTeam; saveDraft?: (team?: NewTeam) => void;
}) {
  const [teams, setTeams] = useState<AccountTeam[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [choice, setChoice] = useState(draft ? ":new" : workspace.team);
  const [key, setKey] = useState(draft?.key ?? "");
  const [name, setName] = useState(draft?.name ?? "");
  const { busy, error, run } = useAccountAction();
  const { id, status, team } = workspace;
  useEffect(() => {
    if (status !== "ok") return;
    const controller = new AbortController();
    setLoadError("");
    setTeams(null);
    accountApi.teams(id, controller.signal).then(setTeams, (error: Error) => {
      if (controller.signal.aborted) return;
      setLoadError(error.message);
      void refresh().catch(() => {});
    });
    return () => controller.abort();
  }, [id, status, attempt, refresh]);

  if (status !== "ok") return null;
  if (loadError) return <><AccountError error={loadError} /><button onClick={() => setAttempt(attempt + 1)}>Retry teams</button></>;
  if (!teams) return <p role="status">Loading teams…</p>;
  return <form className="account-form" onSubmit={(event) => {
    event.preventDefault();
    void run(async () => {
      if (choice === ":new") {
        const next = validateNewTeam(key, name);
        if (!next) throw new Error("Enter a team key of 1 to 7 letters or digits starting with a letter, and a team name of 1 to 80 characters.");
        if (teams.some(({ key }) => key === next.key)) throw new Error("This key already exists. Select its team from the list.");
        saveDraft?.(next);
        return;
      }
      await accountApi.updateWorkspace(id, { team: choice });
      saveDraft?.();
      await refresh();
    });
  }}>
    <label>Team for {workspace.name}
      <select value={choice} onChange={(event) => setChoice(event.target.value)}>
        <option value="">Select a team</option>
        {team && !teams.some(({ key }) => key === team) && <option value={team} disabled>{team} (unavailable)</option>}
        {teams.map(({ key, name }) => <option key={key} value={key}>{name} ({key})</option>)}
        {saveDraft && <option value=":new">A new team that wg setup makes</option>}
      </select>
    </label>
    {choice === ":new" && <>
      <label>New team key<input value={key} onChange={(e) => setKey(e.target.value)} required /></label>
      <label>New team name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} /></label>
      <p>The setup command creates this team. Keep this tab open until you connect <code>wg</code>.</p>
    </>}
    <AccountError error={error} />
    <div className="account-actions"><button disabled={busy || !choice}>{choice === ":new" ? "Use in setup" : "Save team"}</button>
      {choice === ":new" && draft && key.trim().toUpperCase() === draft.key && name.trim() === draft.name &&
        <span role="status">Ready for setup</span>}
    </div>
  </form>;
}

async function copySecret(text: string, trigger: HTMLButtonElement) {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* Try a selection when the Clipboard API is blocked. */ }

  // A field outside the open modal is inert and cannot take the selection.
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.style.cssText = "position:fixed;top:0;left:0;opacity:0;font-size:16px";
  (trigger.closest("dialog") ?? document.body).append(field);
  try {
    field.focus({ preventScroll: true });
    field.select();
    field.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
    trigger.focus({ preventScroll: true });
  }
}

export function SecretCopyButton({ text, label, success, manual }: {
  text: string; label: string; success: string; manual: string;
}) {
  const [status, setStatus] = useState("");
  return <>
    <button type="button" className="ghost copy" aria-label={label} onClick={async (event) => {
      setStatus(await copySecret(text, event.currentTarget) ? success : `Could not copy. ${manual}`);
    }}>Copy</button>
    {status && <p role="status">{status}</p>}
  </>;
}

export function TokenForm({ refresh }: { refresh: RefreshAccount }) {
  const [name, setName] = useState("Coordinator");
  const [token, setToken] = useState("");
  const [revealed, setRevealed] = useState(false);
  const { busy, error, run } = useAccountAction();

  return token ? <div className="account-form">
    <label>Coordinator token<input readOnly value={token} type={revealed ? "text" : "password"} autoComplete="off" spellCheck={false} /></label>
    <p>Copy this token now. It will not appear again after you leave this form or clear it.</p>
    <div className="account-actions">
      <SecretCopyButton text={token} label="Copy coordinator token" success="Token copied."
        manual="Show the token, then select and copy it." />
      <button type="button" onClick={() => setRevealed(!revealed)}>{revealed ? "Mask token" : "Show token"}</button>
      <button type="button" onClick={() => { setRevealed(false); setToken(""); }}>Clear token</button>
    </div>
    <AccountError error={error} />
  </div> : <form className="account-form" onSubmit={(event) => {
    event.preventDefault();
    void run(async () => {
      const result = await accountApi.makeToken(name);
      setToken(result.token);
      await refresh();
    });
  }}>
    <label>Token name<input value={name} onChange={(event) => setName(event.target.value)} required maxLength={40} /></label>
    <div><button className="primary" disabled={busy}>Make a token</button></div>
    <AccountError error={error} />
  </form>;
}

function Confirm({ title, description, close, action, typed }: {
  title: string; description: string; close: () => void; action: () => Promise<void>; typed?: boolean;
}) {
  const [value, setValue] = useState("");
  const { busy, error, run } = useAccountAction();
  return <AccountDialog title={title} close={close}>
    <p>{description}</p>
    <form className="account-form" onSubmit={(event) => {
      event.preventDefault();
      if (typed && value !== "delete") return;
      void run(async () => { await action(); close(); });
    }}>
      {typed && <label>Type delete to confirm<input autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} /></label>}
      <AccountError error={error} />
      <div><button className="danger" disabled={busy || (typed && value !== "delete")}>{title}</button></div>
    </form>
  </AccountDialog>;
}

function WorkspaceSettings({ workspace, count, refresh }: { workspace: AccountConnection; count: number; refresh: RefreshAccount }) {
  const [dialog, setDialog] = useState<"remove" | "replace" | null>(null);
  const { busy, error, run } = useAccountAction();
  const { id, name, position } = workspace;
  const change = (settings: Parameters<typeof accountApi.updateWorkspace>[1]) => void run(async () => {
    await accountApi.updateWorkspace(id, settings);
    await refresh();
  });
  return <article className="account-item">
    <h3>{name}</h3>
    <WorkspaceStatus workspace={workspace} />
    <TeamForm key={`${workspace.team}:${workspace.status}`} workspace={workspace} refresh={refresh} />
    <label className="account-check"><input type="checkbox" checked={workspace.team_labels} disabled={busy}
      onChange={(event) => change({ team_labels: event.target.checked })} /> Use team labels</label>
    <div className="account-actions">
      <button type="button" disabled={busy || position <= 0} aria-label={`Move ${name} up`}
        onClick={() => change({ position: position - 1 })}>Move up</button>
      <button type="button" disabled={busy || position >= count - 1} aria-label={`Move ${name} down`}
        onClick={() => change({ position: position + 1 })}>Move down</button>
      {workspace.kind === "api_key" && <>
        {workspace.status === "ok" && <button onClick={() => setDialog("replace")}>Replace key</button>}
        <button className="danger" onClick={() => setDialog("remove")}>Remove workspace</button>
      </>}
    </div>
    <AccountError error={error} />
    {workspace.kind === "api_key" && workspace.status === "needs_key" && <WorkspaceKeyForm workspace={workspace} refresh={refresh} />}
    {dialog === "replace" && <AccountDialog title={`Replace key for ${name}`} close={() => setDialog(null)}>
      <WorkspaceKeyForm workspace={workspace} refresh={async () => {
        const result = await refresh();
        setDialog(null);
        return result;
      }} />
    </AccountDialog>}
    {dialog === "remove" && <Confirm title="Remove workspace" description={`Remove ${name} and its saved API key from this account?`}
      close={() => setDialog(null)} action={async () => { await accountApi.removeWorkspace(id); await refresh(); }} />}
  </article>;
}

export function Settings({ account, refresh, openGuide }: { account: Account; refresh: RefreshAccount; openGuide: () => void }) {
  const [dialog, setDialog] = useState<"attach" | "token" | "delete" | null>(null);
  const [revoke, setRevoke] = useState<Account["tokens"][number] | null>(null);
  const date = (value: string) => new Date(value).toLocaleString();
  return <main className="account-page">
    <div className="account-content">
      <h1>Settings</h1>
      <section className="account-card">
        <h2>Name</h2>
        <NameForm human={account.human} refresh={refresh} />
      </section>
      <section className="account-card">
        <h2>Linear workspaces</h2>
        {account.connections.map((workspace) => <WorkspaceSettings key={workspace.id} workspace={workspace} count={account.connections.length} refresh={refresh} />)}
        <div><button onClick={() => setDialog("attach")}>Attach another workspace</button></div>
      </section>
      <section className="account-card">
        <h2>Coordinator tokens</h2>
        {!account.tokens.length && <p>No coordinator tokens.</p>}
        {account.tokens.map((token) => <article key={token.id} className="account-item">
          <h3>{token.name}</h3>
          <p>Made {date(token.createdAt)} · {token.lastUsedAt ? `Last used ${date(token.lastUsedAt)}` : "Never used"}</p>
          <div><button className="danger" onClick={() => setRevoke(token)}>Revoke token</button></div>
        </article>)}
        <div><button onClick={() => setDialog("token")}>Make a token</button></div>
      </section>
      <section className="account-card">
        <h2>Setup guide</h2>
        <details className="intro-details"><summary>How Work Graph works</summary><Intro /></details>
        <div><button onClick={openGuide}>Open setup guide</button></div>
      </section>
      <section className="account-card">
        <h2>Delete account</h2>
        <p>This removes your account, workspace connections and their saved keys, and coordinator tokens.</p>
        <div><button className="danger" onClick={() => setDialog("delete")}>Delete account</button></div>
      </section>
    </div>
    {dialog === "attach" && <AccountDialog title="Attach another workspace" close={() => setDialog(null)}>
      <WorkspaceKeyForm refresh={async () => {
        const result = await refresh();
        setDialog(null);
        return result;
      }} />
    </AccountDialog>}
    {dialog === "token" && <AccountDialog title="Make a coordinator token" close={() => setDialog(null)}><TokenForm refresh={refresh} /></AccountDialog>}
    {dialog === "delete" && <Confirm title="Delete account" description="This removes your account, saved workspace credentials, and coordinator tokens."
      typed close={() => setDialog(null)} action={async () => {
        const { message } = await accountApi.delete();
        if (message) window.alert(message);
        location.assign("/");
      }} />}
    {revoke && <Confirm title="Revoke token" description={`Revoke ${revoke.name}? Any coordinator using it will lose access.`}
      close={() => setRevoke(null)} action={async () => { await accountApi.revokeToken(revoke.id); await refresh(); }} />}
  </main>;
}
