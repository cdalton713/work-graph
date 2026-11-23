import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readConfig } from "./workspaces.ts";

const home = () => mkdtempSync(join(tmpdir(), "wg-config-"));

describe("the work-graph config", () => {
  it("without a file: one workspace with LINEAR_API_KEY, the --team, and the default human", () => {
    expect(readConfig("ENG", { LINEAR_API_KEY: "k" }, home())).toEqual({
      human: "Human",
      workspaces: [{ id: "default", name: "Linear", team: "ENG", key: "k", teamLabels: true }],
    });
  });

  it("reads each workspace's key from LINEAR_<ID>_API_KEY, key_env, or a key file, and drops a later one with no key", () => {
    const dir = home();
    mkdirSync(join(dir, ".config/work-graph"), { recursive: true });
    writeFileSync(join(dir, ".config/work-graph/home-linear-api-key"), "file-key\n");
    writeFileSync(join(dir, ".config/work-graph/config.json"), JSON.stringify({
      human: "Ada",
      workspaces: [
        { id: "work", name: "Work", team: "CD", key_env: ["LINEAR_API_KEY"] },
        { id: "home", name: "Home", team: "HOM", key_env: [], team_labels: false },
        { id: "side-job", name: "Side", team: "SJ", key_env: [] },
      ],
    }));
    const config = readConfig("CD", { LINEAR_API_KEY: "fallback", LINEAR_WORK_API_KEY: "work-key" }, dir);
    expect(config.human).toBe("Ada");
    expect(config.workspaces).toEqual([
      { id: "work", name: "Work", team: "CD", key: "work-key", teamLabels: true },
      { id: "home", name: "Home", team: "HOM", key: "file-key", teamLabels: false },
    ]);
  });

  it("stops when a workspace has no team and no --team is given", () => {
    expect(() => readConfig(undefined, { LINEAR_API_KEY: "k" }, home())).toThrow(/workspace default has no team/);
  });

  it("takes the config text from WG_CONFIG_JSON, for a container with no home directory", () => {
    const config = readConfig("CD", { WG_CONFIG_JSON: JSON.stringify({ human: "Bo", workspaces: [{ id: "x", team: "X" }] }), LINEAR_X_API_KEY: "k" }, home());
    expect(config).toEqual({ human: "Bo", workspaces: [{ id: "x", name: "x", team: "X", key: "k", teamLabels: true }] });
  });
});
