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

  it("reads the viewer address of a workspace, with no / at its end", () => {
    const text = JSON.stringify({ workspaces: [{ id: "x", team: "X", share_url: "https://view.example.com/" }] });
    expect(readConfig("CD", { WG_CONFIG_JSON: text, LINEAR_X_API_KEY: "k" }, home()).workspaces[0].shareUrl).toBe("https://view.example.com");
  });

  it("reads the sign-in: the domains from the config, the secrets from the environment", () => {
    const text = JSON.stringify({ workspaces: [{ id: "x", team: "X" }], auth: { domains: ["Example.com"] } });
    const secrets = { WG_AUTH_CLIENT_ID: "client-1", WG_AUTH_CLIENT_SECRET: "client-secret", WG_SESSION_SECRET: "a-session-secret-of-32-characters" };
    const read = (env: Record<string, string>) => readConfig("CD", { WG_CONFIG_JSON: text, LINEAR_X_API_KEY: "k", ...env }, home());
    expect(read(secrets).auth).toEqual({ domains: ["example.com"], clientId: "client-1", clientSecret: "client-secret", secret: "a-session-secret-of-32-characters" });
    // A config that asks for a sign-in never gives a page without one.
    expect(() => read({ ...secrets, WG_AUTH_CLIENT_SECRET: "" })).toThrow("the sign-in needs WG_AUTH_CLIENT_SECRET");
    expect(() => read({ ...secrets, WG_SESSION_SECRET: "short" })).toThrow("WG_SESSION_SECRET must have 32 characters or more");
    const none = (auth: unknown) => () => readConfig("CD", { WG_CONFIG_JSON: JSON.stringify({ workspaces: [{ id: "x", team: "X" }], auth }), LINEAR_X_API_KEY: "k", ...secrets }, home());
    expect(none({ domains: ["example.com"], owners: ["ada@other.example"] })).toThrow("auth.owners");
    const owners = readConfig("WG", { ...secrets, WG_CONFIG_JSON: JSON.stringify({
      auth: { domains: ["example.com"], owners: [" Ada@Example.com "] },
    }) }, home());
    expect(owners.auth?.owners).toEqual(["ada@example.com"]);
    expect(none({ domains: [] })).toThrow("auth.domains must name one domain or more");
    expect(none({ domains: ["a@example.com"] })).toThrow("auth.domains must name one domain or more");
    expect(none({})).toThrow("auth.domains must name one domain or more");
  });
});
