import contract from "../../../skills/work-graph/contract.json";
import { signalOf } from "../../lib/graph";
import type { AccountConnection, SetupItem, StateType, TeamSetupState } from "../../lib/types";
import { Lamp } from "../ui";

const meanings: Record<string, [string, string]> = {
  Triage: ["New work needs a decision.", "Worker"],
  Backlog: ["Work is deferred.", "You"],
  Todo: ["The issue needs a specification or has open blockers.", "Coordinator"],
  Ready: ["All blockers are closed. Work can start.", "Coordinator"],
  "In Progress": ["A worker has started the issue.", "Coordinator"],
  "Needs {name}": ["Work waits for your answer or action.", "Worker"],
  "In Review": ["The pull request is open for review.", "Worker"],
  "Ready to Merge": ["Checks passed and review is complete.", "Worker"],
  Merged: ["The change is merged and waits for deployment.", "Worker"],
  Verifying: ["Checks are running after deployment.", "Coordinator"],
  Done: ["The change meets its acceptance criteria.", "Coordinator"],
  Canceled: ["Work stopped on this issue.", "You"],
  Duplicate: ["Another issue tracks the same work.", "Linear"],
};

function Mark({ item }: { item?: SetupItem }) {
  const state = item?.state ?? "missing";
  return <span className={`setup-mark ${state}`} aria-label={state === "exists" ? "Present" : state === "warn" ? "Check in Linear" : "Missing"}>
    {state === "exists" ? "✓" : state === "warn" ? "!" : "○"}
  </span>;
}

export function StatusFlow({ state, workspace, human, apply, busy }: {
  state: TeamSetupState; workspace: AccountConnection; human: string; apply: () => void; busy: boolean;
}) {
  const items = [...state.statuses, ...state.labels];
  const missing = items.filter(item => item.state === "missing").length;
  const actionable = missing || state.statuses.some(item => item.type === "triage" && item.state === "warn");
  const settings = `https://linear.app/${encodeURIComponent(workspace.workspace_id)}/settings/teams/${encodeURIComponent(workspace.team)}/workflow`;
  return <>
    <ol aria-label="Status flow" className="setup-flow">{contract.setup.statuses.map(({ name: template, type }) => {
      const name = template.replace("{name}", () => human);
      const item = state.statuses.find(i => i.name === name);
      const [meaning, who] = meanings[template];
      const waits = template === "Needs {name}";
      return <li key={template} className={waits ? "setup-wait" : undefined}>
        <Lamp signal={waits ? "stop" : signalOf(name, type as StateType)} />
        <div><strong>{name}</strong> · {who}<p>{meaning}</p>
          {item?.detail && <a href={settings}>{item.detail} Open team workflow settings.</a>}
        </div><Mark item={item} />
      </li>;
    })}</ol>
    <h3>Labels</h3>
    <ul className="setup-labels">{state.labels.map(item => <li key={item.scope + ":" + item.name}>
      <Mark item={item} /><span>{item.name} <small>{item.scope}{item.group && " · " + item.group}</small>
        {item.detail && <p>{item.detail}</p>}</span>
    </li>)}</ul>
    <div><button disabled={busy || !actionable} onClick={apply}>Add {missing} missing statuses and labels</button></div>
  </>;
}
