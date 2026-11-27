/** The agent, model, and effort of the coordinator and worker jobs: the `agents` object of the wg config
 * and of `effort.agents` in a plan (README "Agent settings"). The rules match `wg`. */

export const AGENT_ROLES = ["coordinator", "worker"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];
export type AgentId = "claude" | "codex";
export interface AgentSetting { agent?: AgentId; model?: string; effort?: string }
export type AgentSettings = Partial<Record<AgentRole, AgentSetting>>;

/** Known models and effort levels for each agent. The page also takes any other model ID that `wg` accepts. */
export const AGENT_CHOICES: Record<AgentId, { label: string; models: string[]; efforts: string[] }> = {
  claude: {
    label: "Claude",
    models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"],
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  codex: {
    label: "Codex",
    models: ["gpt-6.1-sol", "gpt-6-astra"],
    efforts: ["minimal", "low", "medium", "high", "xhigh"],
  },
};

export const ROLE_LABELS: Record<AgentRole, string> = { coordinator: "Coordinator", worker: "Worker" };

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Nonempty text with no leading dash, spaces, or control characters (`safe_value` in the CLI). */
export function safeValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 100 && !value.startsWith("-")
    && !/[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}\p{Zs}\p{Zl}\p{Zp}]/u.test(value);
}

/** The settings without empty fields and roles, or an error message. */
export function validateAgents(input: unknown): AgentSettings | string {
  if (!record(input)) return "agents must be an object";
  const result: AgentSettings = {};
  for (const [role, values] of Object.entries(input)) {
    const path = `agents.${role}`;
    if (!(AGENT_ROLES as readonly string[]).includes(role)) return `${path}: unknown role`;
    if (!record(values)) return `${path}: must be an object`;
    const setting: AgentSetting = {};
    for (const [field, value] of Object.entries(values)) {
      if (value === undefined || value === null || value === "") continue;
      if (field === "agent") {
        if (value !== "claude" && value !== "codex") return `${path}.agent: must be claude or codex`;
        setting.agent = value;
      } else if (field === "model" || field === "effort") {
        if (!safeValue(value)) return `${path}.${field}: must be nonempty text with no leading dash, spaces, or control characters`;
        setting[field] = value;
      } else return `${path}.${field}: unknown field`;
    }
    if (setting.effort && !setting.model) return `${path}.effort: needs a model`;
    if (Object.keys(setting).length) result[role as AgentRole] = setting;
  }
  return result;
}

/** A short text for a role: "codex · gpt-6.1-sol · high", or "default". */
export function describeAgent(setting: AgentSetting | undefined, fallback = "default"): string {
  const parts = [setting?.agent, setting?.model, setting?.effort].filter(Boolean);
  return parts.length ? parts.join(" · ") : fallback;
}
