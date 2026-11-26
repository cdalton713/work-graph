import { CARD_PREFIX } from "./graph";
import { AGENT_REPLY_NOT_CONFIRMED, AGENT_REPLY_NOT_TAKEN, agentsFresh, type AgentReplyResult, type AgentRow, type Agents, type Ask } from "./link";
import type { YourMove } from "./overview";
import type { Comment } from "./types";

export type InboxReply = { kind: "worker"; ask: Ask } | { kind: "issue"; issueId: string; sent: boolean };

export function inboxReply(move: YourMove, readOnly: boolean): InboxReply | null {
  if (readOnly) return null;
  if (move.workerAsk) return { kind: "worker", ask: move.workerAsk };
  return move.answer ? { kind: "issue", ...move.answer } : null;
}

export function latestReplyPrompt(comments: Comment[]): string | undefined {
  let latest: Comment | undefined;
  for (const comment of comments) {
    if (comment.body.startsWith(CARD_PREFIX)) continue;
    if (!latest || comment.createdAt >= latest.createdAt) latest = comment;
  }
  return latest?.body;
}

export interface AgentReplyReceipt {
  id: string;
  agent: string;
  sentAt: number;
  result?: AgentReplyResult;
}

export function canReplyToAgent(row: Pick<AgentRow, "id" | "state">, report: Agents | undefined, now: number, owner: boolean): boolean {
  return owner && row.state === "done" && /^(?:orca_session_id:)?[A-Za-z0-9_-]{1,180}$/.test(row.id)
    && agentsFresh(report, now) && report.replies === true;
}

export function applyAgentReplyResult(receipt: AgentReplyReceipt, result: AgentReplyResult): AgentReplyReceipt {
  if (receipt.result || receipt.id !== result.id || receipt.agent !== result.agent) return receipt;
  return { ...receipt, result };
}

/** Give the server thirty seconds after its two-minute deadline to report the result. */
export function agentReplyPending(receipt: AgentReplyReceipt, now: number): boolean {
  return !receipt.result && now - receipt.sentAt < 150_000;
}

export function agentReplyLine(receipt: AgentReplyReceipt, now: number): { text: string; signal: "idle" | "done" | "stop" } {
  const { result } = receipt;
  if (!result) return agentReplyPending(receipt, now) ? { text: "sent", signal: "idle" }
    : { text: "no result: check Orca before you reply again", signal: "stop" };
  if (result.status === "delivered") return { text: "delivered", signal: "done" };
  if (result.status === "unconfirmed") return { text: `not confirmed · ${result.reason}`, signal: "stop" };
  // The server knows whether the watcher took the reply before its two-minute deadline.
  const text = result.reason === AGENT_REPLY_NOT_TAKEN ? "not delivered: wg agents does not run"
    : result.reason === AGENT_REPLY_NOT_CONFIRMED ? "not confirmed" : result.reason;
  return { text, signal: "stop" };
}
