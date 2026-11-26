import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { parseCard } from "../src/lib/graph.ts";
import { createStarter, creationInput } from "./create-project.ts";

const workspace = { id: "second", name: "Second", team: "WG", key: "fixture", teamLabels: true };
const body = { name: "Project", firstTask: "First", team: "WG" };
const key = createHash("sha256").update(JSON.stringify(["second", "WG", "Project", "First"])).digest("hex");

it("binds a retry to its workspace, team, project name and task", () => {
  expect(creationInput(body, workspace, key)).toEqual(body);
  for (const input of [{ ...body, firstTask: "Changed" }, { ...body, team: "NO" }, { ...body, name: "" }]) {
    expect(() => creationInput(input, workspace, key)).toThrow();
  }
  expect(() => creationInput(body, { ...workspace, id: "other" }, key)).toThrow();
});

it("resumes partial and concurrent writes and returns a valid coordinator plan", async () => {
  const saved = new Map<string, object>();
  const cards: string[] = [];
  let interrupt = true;
  const query = async (document: string, variables: Record<string, unknown> = {}) => {
    const input = variables.input as Record<string, string>;
    const field = document.match(/result: (\w+)/)![1];
    if (!input) return { result: saved.get(String(variables.id)) };
    expect(input.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    if (field === "commentCreate" && interrupt) { interrupt = false; throw Error("interrupted"); }
    if (saved.has(input.id)) throw Error("already exists");
    const object = { id: input.id, identifier: "WG-" + (1 + saved.size), url: "https://example.invalid/p",
      teams: { nodes: [{ id: "team" }] }, project: { id: input.projectId }, team: { id: input.teamId }, issue: { id: input.issueId }, type: input.type, relatedIssue: { id: input.relatedIssueId } };
    saved.set(input.id, object);
    if (field === "commentCreate") cards.push(input.body);
    return { result: { object, success: true } };
  };
  const team = { id: "team", key: "WG", name: "Work", viewer: "me", ready: "ready", todo: "todo" };
  const run = () => createStarter(workspace, team, body, "actor", key, query);
  await expect(run()).rejects.toThrow("interrupted");
  const [result, concurrent] = await Promise.all([run(), run()]);
  expect(concurrent).toEqual(result);
  expect(saved.size).toBe(10);
  expect(cards.map(card => parseCard(card)?.kind)).toEqual(["task", "merge-point", "ship-point"]);
  expect(Object.keys(result.keymap.nodes)).toEqual(["first", "merge", "ship"]);
  const checked = spawnSync("python3", ["-c",
    `import json, sys, wg
p, km, objects = json.load(sys.stdin)
wg.validate_shared_plan(p, p["effort"]["name"])
wg.fetch_nodes = lambda _: objects
wg.project_entries = lambda *_: [objects[km["milestones"]["1"]]]
wg.gql = lambda _, variables: {"comment": objects[variables["id"]]}
wg.validate_shared_mapping({"nodes": {}, "milestones": {}}, km, "second", km["project"]["id"], p, {})
`],
  { cwd: "skills/work-graph/scripts", input: JSON.stringify([result.plan, result.keymap, Object.fromEntries(saved)]), encoding: "utf8", env: { ...process.env, WG_CONFIG: "/nonexistent/work-graph-test-config" } });
  expect(checked.stderr).toBe("");
  expect(checked.status).toBe(0);
});
