import { useState } from "react";
import { api } from "../api";
import { ageText } from "../lib/graph";
import type { Ask } from "../lib/link";
import { Rich } from "./ui";
import { Reply } from "./Reply";

export interface AsksProps { asks: Ask[]; projectId: string; workspace?: string; now: number }

/**
 * The open questions of the worker on this issue (Orca asks that the coordinator reported). A reply is a
 * comment on the issue at once, and the coordinator sends it to the worker.
 */
export function Asks({ asks, projectId, workspace, now }: AsksProps) {
  const [sent, setSent] = useState<Set<string>>(new Set());
  const open = asks.filter((a) => !sent.has(a.id));
  if (!open.length) return null;
  return (
    <section className="asks" aria-label="Questions of the worker">
      {open.map((ask) => (
        <div key={ask.id} className="ask">
          <h3>{ask.kind === "escalation" ? "The worker stopped and escalates" : "The worker asks"}{ask.accountName && <span className="count-note">{ask.accountName}'s coordinator</span>}{ask.at && <span className="count-note">{ageText(now - Date.parse(ask.at))}</span>}</h3>
          <div className="ask-body"><Rich text={ask.body} /></div>
          <Reply label="Reply to the worker" placeholder="Your reply. ⌘↵ sends it to the worker."
            hint="It is also a comment on this issue." send={async (body) => {
              await api.reply(projectId, ask.id, body, workspace);
              setSent((s) => new Set(s).add(ask.id));
            }} />
        </div>
      ))}
    </section>
  );
}
