import { useEffect, useRef, useState } from "react";
import { joinProject } from "../api";
import type { ProjectJoin, ProjectJoinPreview } from "../lib/types";

export function Join({ path, returnedFromSignIn }: { path: string; returnedFromSignIn: boolean }) {
  const request = useRef<Promise<ProjectJoinPreview | null>>(null);
  const [preview, setPreview] = useState<ProjectJoinPreview | null>(null);
  const [joined, setJoined] = useState<ProjectJoin | null>(null);
  const [error, setError] = useState("");
  const [signInRequired, setSignInRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const token = path.slice("/join/".length);
  const login = "/auth/login?" + new URLSearchParams({ next: path + "?signed-in=1" });
  useEffect(() => {
    let active = true;
    request.current ??= joinProject(token);
    void request.current.then((value) => {
      if (!active) return;
      if (value) setPreview(value);
      else if (returnedFromSignIn) setSignInRequired(true);
      else location.replace(login);
    }, (reason: Error) => {
      if (active) setError(reason.message);
    });
    return () => { active = false; };
  }, [login, returnedFromSignIn, token]);

  async function confirm() {
    setBusy(true);
    try {
      const value = await joinProject(token, true);
      if (value) setJoined(value);
      else setSignInRequired(true);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <main className="account-page">
    <div className="account-content">
      <h1>{joined?.project ?? preview?.project ?? "Join project"}</h1>
      {signInRequired ? <p>Sign-in did not complete. <a href={login}>Try signing in again</a>.</p> :
        error ? <p role="alert">{error}</p> :
        joined ? <p role="status">You joined as a {joined.role}.</p> :
        preview ? <>
          <p>{preview.owner} invited you to join as a {preview.role}.</p>
          <div className="account-actions">
            <button type="button" disabled={busy} onClick={() => void confirm()}>{busy ? "Joining…" : "Join"}</button>
            <button type="button" disabled={busy} onClick={() => location.replace("/")}>Not now</button>
          </div>
        </> : <p role="status">Loading invitation…</p>}
      {(error || joined || signInRequired) && <p><a href="/">Go to overview</a></p>}
    </div>
  </main>;
}
