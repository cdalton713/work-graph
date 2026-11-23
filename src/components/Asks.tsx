import { useState } from "react";
import { api } from "../api";
import { ageText } from "../lib/graph";
import type { Ask } from "../lib/link";
import { Rich } from "./ui";

export interface AsksProps { asks: Ask[]; projectId: string; workspace?: string; now: number; onError: (message: string) => void }

/**
 * The open questions of the worker on this issue (Orca asks that the coordinator reported). A reply is a
 * comment on the issue at once, and the coordinator sends it to the worker.
 */
export function Asks({ asks, projectId, workspace, now, onError }: AsksProps) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<string | null>(null);
  const [sent, setSent] = useState<Set<string>>(new Set());
  const open = asks.filter((a) => !sent.has(a.id));
  if (!open.length) return null;
  const send = async (ask: Ask) => {
    const body = drafts[ask.id]?.trim();
    if (!body) return;
    setSending(ask.id);
    try {
      await api.reply(projectId, ask.id, body, workspace);
      setSent((s) => new Set(s).add(ask.id));
    } catch (e) {
      onError(`Reply not sent: ${(e as Error).message}`);
    } finally {
      setSending(null);
    }
  };
  return (
    <section className="asks" aria-label="Questions of the worker">
      {open.map((ask) => (
        <div key={ask.id} className="ask">
          <h3>The worker asks{ask.at && <span className="count-note">{ageText(now - Date.parse(ask.at))}</span>}</h3>
          <div className="ask-body"><Rich text={ask.body} /></div>
          <textarea className="editor" rows={3} placeholder="Your reply. ⌘↵ sends it to the worker." value={drafts[ask.id] ?? ""}
            onChange={(e) => setDrafts((d) => ({ ...d, [ask.id]: e.target.value }))}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send(ask); }} />
          <div className="row">
            <button type="button" className="primary" disabled={!drafts[ask.id]?.trim() || sending === ask.id} onClick={() => void send(ask)}>
              {sending === ask.id ? "Sending…" : "Reply to the worker"}
            </button>
            <span className="ask-hint">It is also a comment on this issue.</span>
          </div>
        </div>
      ))}
    </section>
  );
}
