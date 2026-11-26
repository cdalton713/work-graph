import { useEffect, useRef, useState } from "react";
import { joinProject } from "../api";
import { isStandalone } from "../lib/screen";
import { BrowserSignInHelp, InstalledSignInHelp, isInAppBrowser } from "./SignIn";
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
  const inAppBrowser = isInAppBrowser();
  // The installed app has no address bar: it needs its own way back and its own refresh.
  const installed = isStandalone();
  useEffect(() => {
    let active = true;
    request.current ??= joinProject(token);
    void request.current.then((value) => {
      if (!active) return;
      if (value) setPreview(value);
      else if (returnedFromSignIn || inAppBrowser) setSignInRequired(true);
      else location.replace(login);
    }, (reason: Error) => {
      if (active) setError(reason.message);
    });
    return () => { active = false; };
  }, [inAppBrowser, login, returnedFromSignIn, token]);

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

  const card = <main className="account-page">
    <div className="account-content share-join">
      <section className="account-card">
        <h1>{joined?.project ?? preview?.project ?? "Join project"}</h1>
        {signInRequired ? <>
          <p>{returnedFromSignIn ? "Sign-in did not complete. " : "Sign in to join this project. "}
            <a href={login}>{returnedFromSignIn ? "Try signing in again" : "Sign in"}</a>.
          </p>
          <InstalledSignInHelp />
          {inAppBrowser && <BrowserSignInHelp />}
        </> :
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
      </section>
    </div>
  </main>;
  if (!installed) return card;
  return <div className="app">
    <header className="bar">
      <button type="button" className="installed-back" onClick={() => location.replace("/")}>Overview</button>
      <span className="station-fill" />
      <button type="button" className="installed-refresh" onClick={() => location.reload()}>Refresh</button>
    </header>
    {card}
  </div>;
}
