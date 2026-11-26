import { describe, expect, it, vi } from "vitest";
import { configBlock, pollWhileVisible, workspaceKeyLocation, doneSteps, firstStep, setupCommands, validateNewTeam } from "./onboarding";
import type { OnboardingState, AccountConnection } from "./types";

const complete: OnboardingState = {
  name: true, workspaces: true, teams: true, token: true, connected: true, skipped: false,
};
const home: AccountConnection = {
  id: "first", workspace_id: "example", name: "Example", kind: "oauth", status: "ok",
  team: "WG", team_labels: false, position: 0, owner_name: "Ada", created_at: "",
};
const account = { human: "Ada", pageUrl: "https://example.com", connections: [home] };
const second = { ...home, id: "second", workspace_id: "extra", team: "", position: 1 };

describe("onboarding", () => {
  it("marks the status step done only after verification", () => {
    expect(doneSteps(complete, false).statuses).toBe(false);
    expect(doneSteps(complete, true).statuses).toBe(true);
  });

  it("opens Welcome until the account has confirmed setup progress", () => {
    const fresh = { ...complete, name: false, token: false, connected: false };
    expect(firstStep(fresh)).toBe("welcome");
    expect(firstStep({ ...fresh, name: true })).toBe("setup");
    expect(firstStep({ ...fresh, token: true })).toBe("name");
    expect(firstStep({ ...fresh, connected: true })).toBe("name");
  });

  it.each([
    ["name", "name"], ["workspaces", "workspaces"], ["teams", "teams"],
    ["token", "setup"], ["connected", "connect"],
  ] as const)("opens the first unfinished step when %s is false", (key, step) => {
    expect(firstStep({ ...complete, [key]: false })).toBe(step);
  });

  it("shows the server's progress and closes the guide when skipped or complete", () => {
    const state = { ...complete, name: false, token: false, skipped: true };
    expect(doneSteps(state)).toEqual({ welcome: true, name: false, workspaces: true, teams: true, statuses: false, setup: false, connect: true });
    expect(firstStep(state)).toBeNull();
    expect(firstStep(complete)).toBeNull();
    expect(firstStep({ ...state, skipped: false })).toBe("name");
  });

  it("writes the page URL for each workspace and uses a new team's key", () => {
    expect(JSON.parse(configBlock(account, {}))).toEqual({
      human: "Ada", page_url: "https://example.com", workspaces: [{ id: "example", team: "WG", page_url: "https://example.com", team_labels: false, key_env: [] }],
    });
    const config = JSON.parse(configBlock(
      { ...account, connections: [home, second] }, { second: { key: "NEW", name: "New team" } },
    ));
    expect(config.workspaces).toEqual([
      { id: "example", team: "WG", page_url: "https://example.com", team_labels: false, key_env: [] },
      { id: "extra", team: "NEW", page_url: "https://example.com", team_labels: false, key_env: [] },
    ]);
  });

  it("names the workspace-specific environment variable and key file", () => {
    expect(workspaceKeyLocation("extra-team")).toEqual({
      env: "LINEAR_EXTRA_TEAM_API_KEY",
      file: "~/.config/work-graph/extra-team-linear-api-key",
    });
  });

  it("polls on entry and after returning to the page, with no polls while hidden or after cleanup", () => {
    vi.useFakeTimers();
    const page = Object.assign(new EventTarget(), { visibilityState: "hidden" });
    const poll = vi.fn();
    const stop = pollWhileVisible(page as Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">, poll);
    const show = (state: string) => {
      page.visibilityState = state;
      page.dispatchEvent(new Event("visibilitychange"));
    };
    try {
      vi.advanceTimersByTime(10_000);
      expect(poll).not.toHaveBeenCalled();
      show("visible");
      expect(poll).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(5000);
      expect(poll).toHaveBeenCalledTimes(2);
      show("hidden");
      vi.advanceTimersByTime(10_000);
      expect(poll).toHaveBeenCalledTimes(2);
      show("visible");
      expect(poll).toHaveBeenCalledTimes(3);
    } finally {
      stop();
      show("hidden");
      show("visible");
      vi.advanceTimersByTime(10_000);
      vi.useRealTimers();
    }
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it("orders the commands after the token and quotes the new team name for the shell", () => {
    expect(setupCommands({ ...account, connections: [home, second] }, { second: { key: "NEW", name: "Ada's team" } })).toEqual([
      "wg login https://example.com",
      "wg setup --workspace example --apply",
      "wg setup --workspace extra --apply --name 'Ada'\\''s team'",
      "wg doctor",
    ]);
  });

  it("checks the team key and name before they enter the commands", () => {
    expect(validateNewTeam(" wg2 ", " New team ")).toEqual({ key: "WG2", name: "New team" });
    expect(validateNewTeam("", "New team")).toBeNull();
    expect(validateNewTeam("bad key", "New team")).toBeNull();
    expect(validateNewTeam("WG", "")).toBeNull();
    expect(validateNewTeam("WG", "Bad\nName")).toBeNull();
  });
});
