import { useEffect, useRef, useState } from "react";
import { joinProject } from "../api";
import type { ProjectJoin } from "../lib/types";

export function Join({ path }: { path: string }) {
  const request = useRef<Promise<ProjectJoin | null>>(null);
  const [joined, setJoined] = useState<ProjectJoin | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    request.current ??= joinProject(path.slice("/join/".length));
    void request.current.then((value) => {
      if (!active) return;
      if (value) setJoined(value);
      else location.replace("/auth/login?" + new URLSearchParams({ next: path }));
    }, (reason: Error) => {
      if (active) setError(reason.message);
    });
    return () => { active = false; };
  }, [path]);
  return <main className="account-page">
    <div className="account-content">
      <h1>{joined?.project ?? "Join project"}</h1>
      {error ? <p role="alert">{error}</p> :
        joined ? <p role="status">You joined as a {joined.role === "viewer" ? "viewer" : "collaborator"}.</p> :
        <p role="status">Joining project…</p>}
      {(error || joined) && <p><a href="/">Go to overview</a></p>}
    </div>
  </main>;
}
