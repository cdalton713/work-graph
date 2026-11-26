import { CARD_PREFIX } from "./graph";
import { agentsFresh, type AgentReplyResult, type AgentRow, type Agents, type Ask } from "./link";
import type { YourMove } from "./overview";
import type { Comment } from "./types";

export type InboxReply = { kind: "worker"; ask: Ask } | { kind: "issue"; issueId: string; sent: boolean };

export function inboxReply(move: YourMove, readOnly: boolean): InboxReply | null {
  if (readOnly || move.agentWait) return null;
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

export function agentReplyLine({ result }: AgentReplyReceipt): { text: string; signal: "idle" | "done" | "stop" } {
  if (!result) return { text: "sent", signal: "idle" };
  if (result.status === "delivered") return { text: "delivered", signal: "done" };
  if (result.status === "unconfirmed") return { text: `not confirmed · ${result.reason}`, signal: "stop" };
  // The server knows whether the watcher took the reply before its two-minute deadline.
  const text = result.reason === "No agent watcher took the reply within two minutes" ? "not delivered: wg agents does not run"
    : result.reason === "Orca mail delivery was not confirmed" ? "not confirmed" : result.reason;
  return { text, signal: "stop" };
}
