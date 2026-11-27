import { useState } from "react";
import { AGENT_CHOICES, AGENT_ROLES, ROLE_LABELS, validateAgents, type AgentId, type AgentRole, type AgentSetting, type AgentSettings } from "../lib/agents";

const CUSTOM = ":custom";

/** The model choices for an agent; with no agent, every known model. */
function modelsFor(agent?: AgentId) {
  return agent ? AGENT_CHOICES[agent].models : Object.values(AGENT_CHOICES).flatMap(({ models }) => models);
}

function effortsFor(agent?: AgentId) {
  return agent ? AGENT_CHOICES[agent].efforts : [...new Set(Object.values(AGENT_CHOICES).flatMap(({ efforts }) => efforts))];
}

function RoleFields({ role, value, change, disabled }: {
  role: AgentRole; value: AgentSetting; change: (next: AgentSetting) => void; disabled?: boolean;
}) {
  const models = modelsFor(value.agent);
  const [custom, setCustom] = useState(!!value.model && !models.includes(value.model));
  const efforts = effortsFor(value.agent);
  const label = ROLE_LABELS[role];
  return <fieldset className="agent-role" disabled={disabled}>
    <legend>{label}</legend>
    <label>Agent
      <select aria-label={`${label} agent`} value={value.agent ?? ""} onChange={(event) => {
        // A new agent drops the model and effort of the previous agent, as in wg.
        setCustom(false);
        change(event.target.value ? { agent: event.target.value as AgentId } : {});
      }}>
        <option value="">{role === "worker" ? "Default (Codex)" : "Default (Orca's default)"}</option>
        {(Object.keys(AGENT_CHOICES) as AgentId[]).map((id) => <option key={id} value={id}>{AGENT_CHOICES[id].label}</option>)}
      </select>
    </label>
    <label>Model
      <select aria-label={`${label} model`} value={custom ? CUSTOM : value.model ?? ""} onChange={(event) => {
        const model = event.target.value;
        setCustom(model === CUSTOM);
        if (model === CUSTOM) change({ ...value, model: "" });
        else change(model ? { ...value, model } : { agent: value.agent });
      }}>
        <option value="">Default</option>
        {models.map((model) => <option key={model} value={model}>{model}</option>)}
        <option value={CUSTOM}>Custom…</option>
      </select>
    </label>
    {custom && <label>Model ID
      <input aria-label={`${label} model ID`} value={value.model ?? ""} spellCheck={false} autoComplete="off" maxLength={100}
        onChange={(event) => change({ ...value, model: event.target.value.trim() })} />
    </label>}
    <label>Effort
      <select aria-label={`${label} effort`} value={value.effort ?? ""} disabled={!value.model}
        title={value.model ? undefined : "Choose a model first"}
        onChange={(event) => change({ ...value, effort: event.target.value || undefined })}>
        <option value="">Default</option>
        {value.effort && !efforts.includes(value.effort) && <option value={value.effort}>{value.effort}</option>}
        {efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
      </select>
    </label>
  </fieldset>;
}

/** The agent, model, and effort of the coordinator and the worker. `save` gets the checked settings. */
export function AgentsForm({ value, save, busy, error, submit = "Save agents", note }: {
  value: AgentSettings; save: (agents: AgentSettings) => void; busy?: boolean; error?: string; submit?: string; note?: string;
}) {
  const [draft, setDraft] = useState<AgentSettings>(value);
  const [problem, setProblem] = useState("");
  const shown = error || problem;
  return <form className="account-form agents-form" onSubmit={(event) => {
    event.preventDefault();
    const checked = validateAgents(draft);
    if (typeof checked === "string") return setProblem(checked.replace(/^agents\./, ""));
    setProblem("");
    save(checked);
  }}>
    <div className="agent-roles">
      {AGENT_ROLES.map((role) => <RoleFields key={role} role={role} value={draft[role] ?? {}} disabled={busy}
        change={(next) => setDraft((previous) => ({ ...previous, [role]: next }))} />)}
    </div>
    {note && <p className="account-muted">{note}</p>}
    {shown && <p className="account-error" role="alert">{shown}</p>}
    <div><button className="primary" disabled={busy}>{submit}</button></div>
  </form>;
}
