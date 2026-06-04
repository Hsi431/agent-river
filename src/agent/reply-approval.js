import { appendJsonl, readJsonl } from "codex-memory-river/src/jsonl.js";
import { shortHash } from "codex-memory-river/src/hash.js";
import { agentPaths } from "./paths.js";
import { assertChatReplyAllowed, queueChatReply } from "./chat.js";
import { pollTelegramOnce } from "./telegram.js";

// Local approval ledger for real-Codex replies. A pending approval holds the
// model output (local-only, under ~/.codex/agent) but is NOT in the sendable
// queue. Approving runs it through queueChatReply (the normal send path);
// rejecting is terminal. No prompt/model logs are stored — only the reply text.

export function createReplyApproval({ agentHome, inboxId, text }) {
  // Same guard as queueChatReply, so secret/empty output never becomes approvable.
  const { inbox, replyText } = assertChatReplyAllowed(agentHome, inboxId, text);
  const now = new Date().toISOString();
  const record = {
    id: `approval_${Date.now()}_${shortHash(`${inbox.id}:${replyText}`)}`,
    inbox_id: inbox.id,
    chat_id: inbox.chat_id,
    text: replyText,
    text_hash: shortHash(replyText),
    status: "pending",
    created_at: now,
  };
  appendJsonl(agentPaths(agentHome).replyApprovals, record);
  return record;
}

export function listPendingReplyApprovals(agentHome) {
  return latestReplyApprovals(agentHome).filter((approval) => approval.status === "pending");
}

export function approveReply({ agentHome, id }) {
  const approval = latestReplyApprovals(agentHome).find((entry) => entry.id === id);
  if (!approval) {
    throw new Error(`Reply approval not found: ${id}`);
  }
  if (approval.status === "approved") {
    // Idempotent: already approved/queued — do not queue (or send) a duplicate.
    return { approval, reply: null, already: true };
  }
  if (approval.status !== "pending") {
    throw new Error(`Reply approval is not pending: ${id}`);
  }
  const reply = queueChatReply({ agentHome, inboxId: approval.inbox_id, text: approval.text });
  const event = { id, status: "approved", reply_id: reply.id, approved_at: new Date().toISOString() };
  appendJsonl(agentPaths(agentHome).replyApprovals, event);
  return { approval: { ...approval, ...event }, reply, already: false };
}

export function rejectReply({ agentHome, id }) {
  const approval = latestReplyApprovals(agentHome).find((entry) => entry.id === id);
  if (!approval) {
    throw new Error(`Reply approval not found: ${id}`);
  }
  if (approval.status === "rejected") {
    return { approval, already: true };
  }
  if (approval.status !== "pending") {
    throw new Error(`Reply approval is not pending: ${id}`);
  }
  const event = { id, status: "rejected", rejected_at: new Date().toISOString() };
  appendJsonl(agentPaths(agentHome).replyApprovals, event);
  return { approval: { ...approval, ...event }, already: false };
}

// Operator convenience: approve a pending reply, then poll once to flush queued
// replies (i.e. send it). Never invokes Codex; still needs TELEGRAM_BOT_TOKEN for
// the send poll. Approval is idempotent, so this won't double-send.
export async function approveAndSendReply({
  agentHome, id, transport = "fetch", token, fetchImpl, execFileImpl, requestImpl, memoryStateHome,
} = {}) {
  const approved = approveReply({ agentHome, id });
  const sendResult = await pollTelegramOnce({
    agentHome, transport, token, fetchImpl, execFileImpl, requestImpl, memoryStateHome,
  });
  return {
    approval: approved.approval,
    reply: approved.reply,
    already: Boolean(approved.already),
    sent: sendResult.replies || [],
  };
}

function latestReplyApprovals(agentHome) {
  const latest = new Map();
  for (const entry of readJsonl(agentPaths(agentHome).replyApprovals)) {
    if (entry.id) {
      latest.set(entry.id, { ...(latest.get(entry.id) || {}), ...entry });
    }
  }
  return Array.from(latest.values());
}
