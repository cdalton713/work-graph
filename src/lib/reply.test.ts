import { describe, expect, it } from "vitest";
import { inboxReply, latestReplyPrompt } from "./reply";
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
});
