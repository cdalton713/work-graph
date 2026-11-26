import { describe, expect, it } from "vitest";
import { agentReplyLine, applyAgentReplyResult, canReplyToAgent, inboxReply, latestReplyPrompt } from "./reply";
import type { YourMove } from "./overview";

const move: YourMove = { identifier: "WG-1", title: "Pick a table", why: "Which table?", pullRequests: [], updatedAt: "" };
const ask = { id: "q1", key: null, issue: "WG-1", from: "w", body: "Which table?\n\nUse the full name.", at: "" };

describe("inbox replies", () => {
  it("opens the full worker question and replies to the worker when both targets are present", () => {
    const row = { ...move, workerAsk: ask, answer: { issueId: "i1", sent: false } };
    expect(inboxReply(row, false)).toEqual({ kind: "worker", ask });
  });

  it("opens a waiting issue for an answer and keeps its sent status", () => {
    const answer = { issueId: "i1", sent: true };
    expect(inboxReply({ ...move, answer }, false)).toEqual({ kind: "issue", ...answer });
  });

  it("gives viewers and rows without an answer target no reply box", () => {
    expect(inboxReply({ ...move, workerAsk: ask }, true)).toBeNull();
    expect(inboxReply({ ...move, answer: { issueId: "i1", sent: false } }, true)).toBeNull();
    expect(inboxReply({ ...move, why: "Merge #7" }, false)).toBeNull();
    expect(inboxReply({ ...move, why: "Agent waits in Orca" }, false)).toBeNull();
  });

  it("shows the latest comment and skips the node card", () => {
    const comment = (id: string, body: string) => ({ id, body, createdAt: `2026-11-0${id}T00:00:00Z`, author: "Ada", parentId: null });
    expect(latestReplyPrompt([
      comment("2", "Use the full name.\n\nAre there two tables?"),
      comment("3", "**work-graph node card** `k`"),
      comment("1", "Which table?"),
    ])).toBe("Use the full name.\n\nAre there two tables?");
    expect(latestReplyPrompt([])).toBeUndefined();
  });
  it("sends an agent at a prompt back to Orca even when its issue has an answer target", () => {
    const agentWait = { id: "orca_session_id:abc", role: "worker" as const, key: "pick", issue: "WG-1",
      state: "blocked", agent: "codex", title: "Needs input", said: "Pick a table", at: null };
    expect(inboxReply({ ...move, agentWait, answer: { issueId: "i1", sent: false } }, false)).toBeNull();
  });

});

describe("agent replies", () => {
  const row = { id: "orca_session_id:abc", state: "done" };
  const sent = { id: "reply", agent: row.id };
  it("offers replies only to the owner for a done session with a fresh enabled watcher", () => {
    const now = Date.parse("2026-11-20T12:00:00Z");
    const report = { at: "2026-11-20T12:00:00Z", agents: [], replies: true } as const;
    const live = { ...report, agents: [] };
    expect(canReplyToAgent(row, live, now, true)).toBe(true);
    expect(canReplyToAgent(row, live, now, false)).toBe(false);
    expect(canReplyToAgent({ ...row, state: "blocked" }, live, now, true)).toBe(false);
    expect(canReplyToAgent({ ...row, state: "waiting" }, live, now, true)).toBe(false);
    expect(canReplyToAgent({ ...row, id: "tab:pane" }, live, now, true)).toBe(false);
    expect(canReplyToAgent(row, { ...live, replies: undefined }, now, true)).toBe(false);
    expect(canReplyToAgent(row, live, now + 180_000, true)).toBe(false);
  });

  it("shows the server result once per reply, including when it replays after reload", () => {
    const delivered = { ...sent, status: "delivered", messageId: "msg" } as const;
    expect(agentReplyLine(sent)).toEqual({ text: "sent", signal: "idle" });
    const received = applyAgentReplyResult(sent, delivered);
    expect(agentReplyLine(received)).toEqual({ text: "delivered", signal: "done" });
    const reloaded = JSON.parse(JSON.stringify(received));
    expect(applyAgentReplyResult(reloaded, delivered)).toBe(reloaded);
    expect(applyAgentReplyResult(sent, { ...delivered, id: "older" })).toBe(sent);
  });

  it("shows the refusal and the reason that confirmation failed", () => {
    expect(agentReplyLine(applyAgentReplyResult(sent, { ...sent, status: "refused", reason: "The agent works again" })))
      .toEqual({ text: "The agent works again", signal: "stop" });
    expect(agentReplyLine(applyAgentReplyResult(sent, { ...sent, status: "unconfirmed", reason: "Check Orca" })))
      .toEqual({ text: "not confirmed · Check Orca", signal: "stop" });
  });

  it("uses the server's two-minute result to tell a missed reply from an unconfirmed delivery", () => {
    expect(agentReplyLine(applyAgentReplyResult(sent, { ...sent, status: "refused", reason: "No agent watcher took the reply within two minutes" })))
      .toEqual({ text: "not delivered: wg agents does not run", signal: "stop" });
    expect(agentReplyLine(applyAgentReplyResult(sent, { ...sent, status: "refused", reason: "Orca mail delivery was not confirmed" })))
      .toEqual({ text: "not confirmed", signal: "stop" });
  });
});
