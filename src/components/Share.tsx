import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { linearAccessRequired, shareApi } from "../api";
import { accessNotice, linkRow, orderMembers } from "../lib/share";
import type { LinearAccess, ProjectShare, ShareKind, ShareMember } from "../lib/types";
import { CopyButton } from "./ui";
import { useDialogViewport } from "./Settings";

const links = [
  { kind: "view", name: "Read-only link", description: "View the project and its issues." },
  { kind: "collab", name: "Collab link", description: "View the project and work on its issues with Linear access." },
] as const;

const date = (at: string) => new Date(at).toLocaleDateString();
const time = (at: string) => new Date(at).toLocaleString();

type Confirmation =
  | { action: "rotate" | "revoke"; kind: ShareKind }
  | { action: "remove" | "invite" | "demote"; member: ShareMember };

export function Share({ id, workspace, team, close }: { id: string; workspace: string; team?: string; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useDialogViewport(dialog);
  const confirmation = useRef<HTMLElement>(null);
  const confirmationTrigger = useRef<HTMLElement | null>(null);
  const [data, setData] = useState<ProjectShare | null>(null);
  const [urls, setUrls] = useState<Partial<Record<ShareKind, string>>>({});
  const [pending, setPending] = useState<Confirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [accessFeedback, setAccessFeedback] = useState<{ member: string; message: string; settingsUrl?: string } | null>(null);

  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement;
    element.showModal();
    return () => {
      if (element.open) element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void shareApi.read(id, workspace, controller.signal).then(setData, (reason: Error) => {
      if (!controller.signal.aborted) setError(reason.message);
    });
    return () => controller.abort();
  }, [id, workspace]);

  useLayoutEffect(() => {
    if (pending) confirmation.current?.focus();
    else if (!busy && confirmationTrigger.current) {
      confirmationTrigger.current.focus();
      confirmationTrigger.current = null;
    }
  }, [pending, busy]);

  function ask(choice: Confirmation, trigger: HTMLElement) {
    confirmationTrigger.current = trigger;
    setPending(choice);
  }

  async function changeRole(member: ShareMember, role: ShareMember["role"]) {
    await shareApi.changeRole(id, workspace, member.id, role);
    setData(await shareApi.read(id, workspace));
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try { await action(); }
    catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }

  async function make(kind: ShareKind, rotate = false) {
    const result = await (rotate ? shareApi.rotate(id, workspace, kind) : shareApi.make(id, workspace, kind));
    setUrls((current) => ({ ...current, [kind]: "url" in result ? result.url : undefined }));
    setData(await shareApi.read(id, workspace));
  }

  async function grant(member: ShareMember, invite: boolean, trigger?: HTMLButtonElement) {
    setAccessFeedback(null);
    const result = await shareApi.addAccess(id, workspace, member.id, invite);
    switch (result.status) {
      case "invite_required":
        if (trigger) ask({ action: "invite", member }, trigger);
        break;
      case "refused":
        setAccessFeedback({ member: member.id, message: result.reason, settingsUrl: result.settingsUrl });
        break;
      case "added":
      case "already_member":
        setAccessFeedback({ member: member.id, message: `Has access to team ${result.team}.` });
        break;
      case "invited":
      case "invite_pending":
        setAccessFeedback({ member: member.id, message: "The Linear workspace invitation is pending." });
        break;
    }
  }

  function confirm() {
    const choice = pending;
    if (!choice) return;
    setPending(null);
    void run(async () => {
      switch (choice.action) {
        case "rotate": await make(choice.kind, true); break;
        case "revoke":
          await shareApi.revoke(id, workspace, choice.kind);
          setUrls((current) => ({ ...current, [choice.kind]: undefined }));
          setData(await shareApi.read(id, workspace));
          break;
        case "remove":
          await shareApi.remove(id, workspace, choice.member.id);
          setData(await shareApi.read(id, workspace));
          break;
        case "demote": await changeRole(choice.member, "viewer"); break;
        case "invite": await grant(choice.member, true); break;
      }
    });
  }

  const prompt = pending && (pending.action === "invite"
    ? { text: `Invite ${pending.member.name} to the Linear workspace?`, detail: "An invite can add a seat to the Linear plan.", button: "Send invite" }
    : pending.action === "remove"
      ? { text: `Remove ${pending.member.name} from this project?`, detail: "This releases their claims.", button: "Remove member" }
      : pending.action === "demote"
        ? { text: `Change ${pending.member.name} to a viewer?`, detail: "This releases their claims. They can only read the project after this change.", button: "Change to viewer" }
        : { text: pending.action === "rotate" ? "Make a new link?" : "Turn off this link?", detail: "The current link will stop working.", button: pending.action === "rotate" ? "New link" : "Turn off" });

  return <dialog ref={dialog} className="account-dialog share-dialog" aria-label="Share project"
    onCancel={(event) => {
      event.preventDefault();
      if (pending) setPending(null);
      else close();
    }}>
    <header className="account-heading share-heading">
      <h2>Share project</h2>
      <button type="button" className="ghost" autoFocus onClick={close}>Close</button>
    </header>
    {error && <p className="account-error" role="alert">{error}</p>}
    {!data && !error && <p role="status">Loading share settings…</p>}
    {data && <>
      <section aria-label="Links">
        {links.map(({ kind, name, description }) => {
          const row = linkRow(data[kind], urls[kind]);
          return <div className="account-item" key={kind}>
            <div><h3>{name}</h3><p>{description}</p></div>
            {row.state === "new" && <>
              <div className="account-form"><label>New {name.toLowerCase()}<input readOnly value={row.url} /></label></div>
              <div className="account-actions"><CopyButton label={`Copy ${name.toLowerCase()}`} text={row.url} secret /></div>
              <p role="status">Copy this address now. It will not appear again after you close this dialog.</p>
            </>}
            {row.state === "live" && <p>Made {date(row.made)}</p>}
            <div className="account-actions">{row.state === "missing" ?
                <button type="button" disabled={busy || !!pending} onClick={() => void run(() => make(kind))}>Make link</button> :
                <>
                  <button type="button" disabled={busy || !!pending} onClick={(event) => ask({ action: "rotate", kind }, event.currentTarget)}>New link</button>
                  <button type="button" className="ghost" disabled={busy || !!pending} onClick={(event) => ask({ action: "revoke", kind }, event.currentTarget)}>Turn off</button>
                </>}
              </div>
            {pending && "kind" in pending && pending.kind === kind && renderPrompt()}
          </div>;
        })}
      </section>
      <section aria-label="Members">
        <h3>Members</h3>
        {!data.members.length && <p>No members yet.</p>}
        {orderMembers(data.members).map((member) => {
          const { id: memberId, name, email, role, joinedAt, accessRequestedAt } = member;
          const feedback = accessFeedback?.member === memberId ? accessFeedback : null;
          return <div className="account-item" key={memberId}>
            <div><strong>{name}</strong><p>{email} · Joined {date(joinedAt)}</p></div>
            <div className="account-form"><label>Role for {name}
              <select value={role} disabled={busy || !!pending} onChange={(event) => {
                if (event.currentTarget.value === "viewer") {
                  ask({ action: "demote", member }, event.currentTarget);
                } else {
                  void run(() => changeRole(member, "collaborator"));
                }
              }}>
                <option value="viewer">Viewer</option>
                <option value="collaborator">Collaborator</option>
              </select>
            </label></div>
            {role === "collaborator" && accessRequestedAt && <>
              <p>Asked for access to {team ? `team ${team}` : "the Linear team"} on {time(accessRequestedAt)}.</p>
              <div className="account-actions">
                <button type="button" disabled={busy || !!pending} onClick={(event) => {
                  const trigger = event.currentTarget;
                  void run(() => grant(member, false, trigger));
                }}>Add access</button>
              </div>
            </>}
            {feedback && <p role="status">{feedback.message}{feedback.settingsUrl &&
              <> <a href={feedback.settingsUrl} target="_blank" rel="noreferrer">Team member settings</a>.</>}
            </p>}
            <div className="account-actions">
              <button type="button" className="ghost" disabled={busy || !!pending}
                onClick={(event) => ask({ action: "remove", member }, event.currentTarget)}>Remove</button>
            </div>
            {pending && "member" in pending && pending.member.id === memberId && renderPrompt()}
          </div>;
        })}
      </section>
    </>}

  </dialog>;

  function renderPrompt() {
    if (!prompt) return null;
    return <aside className="share-confirm" tabIndex={-1} ref={confirmation}>
      <strong>{prompt.text}</strong>
      <p>{prompt.detail}</p>
      <div className="account-actions">
        <button type="button" className="ghost" onClick={() => setPending(null)}>Cancel</button>
        <button type="button" onClick={confirm}>{prompt.button}</button>
      </div>
    </aside>;
  }
}

export function MemberAccess({ id, workspace, openSettings }: { id: string; workspace: string; openSettings: () => void }) {
  const [access, setAccess] = useState<LinearAccess | null>(null);
  const [checkFailed, setCheckFailed] = useState(false);
  const [canRetryWrite, setCanRetryWrite] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const failedWrite = useRef(false);
  const check = useRef<AbortController | null>(null);

  const read = useCallback(async () => {
    check.current?.abort();
    const controller = new AbortController();
    check.current = controller;
    setCheckFailed(false);
    try {
      const result = await shareApi.access(id, workspace, controller.signal);
      if (controller.signal.aborted) return;
      setAccess(result);
      if (result.status === "ok" && failedWrite.current) {
        failedWrite.current = false;
        setCanRetryWrite(true);
      }
    } catch {
      if (!controller.signal.aborted) setCheckFailed(true);
    }
  }, [id, workspace]);

  useEffect(() => {
    function refused(event: Event) {
      if ((event as CustomEvent<string>).detail !== workspace) return;
      failedWrite.current = true;
      setCanRetryWrite(false);
      void read();
    }
    void read();
    window.addEventListener(linearAccessRequired, refused);
    return () => {
      check.current?.abort();
      window.removeEventListener(linearAccessRequired, refused);
    };
  }, [read, workspace]);

  async function request() {
    setBusy(true);
    setError("");
    try {
      await shareApi.requestAccess(id, workspace);
      await read();
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }

  if (checkFailed) return <aside className="effort effort-warning member-access" aria-label="Linear access">
    <span role="status">Could not check your Linear access.</span>
    <button type="button" onClick={() => void read()}>Retry</button>
  </aside>;

  const notice = access && accessNotice(access);
  if (!notice) return canRetryWrite ? <div className="effort" role="status">Linear access is available. You can send the write again.</div> : null;

  return <aside className="effort effort-warning member-access" aria-label="Linear access">
    <span role="status">{notice.message}</span>
    {notice.action === "settings" ?
      <button type="button" onClick={openSettings}>Open Settings to attach a key</button> :
      access?.accessRequestedAt ? <span role="status">Asked {time(access.accessRequestedAt)}</span> :
      <button type="button" disabled={busy} onClick={() => void request()}>Request access</button>}
    {error && <span role="alert">{error}</span>}
  </aside>;
}
