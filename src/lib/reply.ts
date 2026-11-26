import { CARD_PREFIX } from "./graph";
import type { Ask } from "./link";
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
