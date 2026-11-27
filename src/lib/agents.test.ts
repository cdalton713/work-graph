import { describe, expect, it } from "vitest";
import { describeAgent, safeValue, validateAgents } from "./agents";

describe("agent settings", () => {
  it("keeps the set fields and drops empty roles", () => {
    expect(validateAgents({
      coordinator: { agent: "claude", model: "claude-opus-5-5", effort: "high" },
      worker: { agent: "", model: "" },
    })).toEqual({ coordinator: { agent: "claude", model: "claude-opus-5-5", effort: "high" } });
  });

  it.each([
    [[], "agents must be an object"],
    [{ reviewer: {} }, "agents.reviewer: unknown role"],
    [{ worker: "codex" }, "agents.worker: must be an object"],
    [{ worker: { agent: "pi" } }, "agents.worker.agent: must be claude or codex"],
    [{ worker: { model: "-x" } }, "agents.worker.model: must be nonempty text with no leading dash, spaces, or control characters"],
    [{ worker: { model: "a b" } }, "agents.worker.model: must be nonempty text with no leading dash, spaces, or control characters"],
    [{ worker: { effort: "high" } }, "agents.worker.effort: needs a model"],
    [{ worker: { color: "red" } }, "agents.worker.color: unknown field"],
  ])("refuses %j", (input, error) => {
    expect(validateAgents(input)).toBe(error);
  });

  it("matches the value rule of wg", () => {
    expect(safeValue("gpt-6.1-sol")).toBe(true);
    expect(safeValue("provider/model:tag")).toBe(true);
    for (const bad of ["", "-m", "a\tb", "a​b", "a b", 3]) expect(safeValue(bad)).toBe(false);
  });

  it("describes a role", () => {
    expect(describeAgent(undefined)).toBe("default");
    expect(describeAgent({ agent: "codex", model: "gpt-6-astra", effort: "high" })).toBe("codex · gpt-6-astra · high");
  });
});
