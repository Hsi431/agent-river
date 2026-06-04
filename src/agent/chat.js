import fs from "node:fs";
import path from "node:path";
import { appendJsonl, readJsonl, writeJsonl } from "codex-memory-river/src/jsonl.js";
import { scanSecrets } from "codex-memory-river/src/secret-scan.js";
import { shortHash } from "codex-memory-river/src/hash.js";
import { agentPaths } from "./paths.js";
import { isGatewayUserAllowed } from "./safety.js";

export function enqueueChatMessage({ agentHome, channel, userId, chatId, text }) {
  const allowed = isGatewayUserAllowed(agentHome, userId);
  const now = new Date().toISOString();
  const entry = {
    id: allowed ? `chat_${Date.now()}_${shortHash(`${channel}:${userId}:${chatId}:${text}`)}` : null,
    channel,
    user_id: String(userId || ""),
    chat_id: String(chatId || ""),
    text: allowed ? String(text || "") : null,
    text_hash: shortHash(String(text || "")),
    allowed,
    created_at: now,
  };
  if (allowed) {
    appendJsonl(agentPaths(agentHome).chatInbox, entry);
  }
  appendJsonl(agentPaths(agentHome).gatewayAudit, {
    user_id: entry.user_id,
    text_hash: entry.text_hash,
    command: "chat_inbox",
    allowed,
    ok: allowed,
    task_id: null,
    created_at: now,
  });
  return entry;
}

export function listChatInbox(agentHome) {
  return readJsonl(agentPaths(agentHome).chatInbox);
}

export function inboxSummary(agentHome) {
  const messages = listChatInbox(agentHome);
  return {
    messages,
    latest_inbox_id: messages.at(-1)?.id || null,
  };
}

export function chatStatus(agentHome) {
  const inbox = listChatInbox(agentHome);
  const replies = latestChatReplies(agentHome);
  const drafts = listDraftFiles(agentHome);
  const handoffs = latestHandoffs(agentHome);
  return {
    inbox_count: inbox.length,
    latest_inbox_id: inbox.at(-1)?.id || null,
    pending_replies: replies.filter((reply) => reply.status === "queued").length,
    sent_replies: replies.filter((reply) => reply.status === "sent").length,
    latest_draft: drafts.at(-1) || null,
    pending_handoffs: handoffs.filter((handoff) => handoff.status === "pending").length,
    latest_handoff_id: handoffs.at(-1)?.id || null,
    latest_pending_handoff_id: latestHandoffId(handoffs, "pending"),
  };
}

export function pruneChatState({ agentHome, days }) {
  const cutoff = cutoffFromDays(days);
  const paths = agentPaths(agentHome);
  const inbox = listChatInbox(agentHome);
  const prunedInboxIds = new Set(inbox.filter((entry) => isOlderThan(entry.created_at, cutoff)).map((entry) => entry.id));

  const prunedDrafts = pruneDraftFiles(agentHome, prunedInboxIds);
  const prunedHandoffs = pruneHandoffFiles(agentHome, cutoff, prunedInboxIds);
  const expiredHandoffs = expirePendingHandoffs(agentHome, prunedHandoffs.expiredIds);
  const prunedSentReplies = pruneSentReplies(agentHome, cutoff);
  const keptInbox = inbox.filter((entry) => !prunedInboxIds.has(entry.id));
  writeJsonl(paths.chatInbox, keptInbox);

  return {
    cutoff: cutoff.toISOString(),
    pruned_inbox: inbox.length - keptInbox.length,
    pruned_drafts: prunedDrafts,
    pruned_handoff_files: prunedHandoffs.count,
    expired_handoffs: expiredHandoffs,
    pruned_sent_replies: prunedSentReplies,
  };
}

// Shared reply guard: inbox exists + allowlisted + non-empty + no secrets.
// Used by queueChatReply and by the approval path so the same checks gate a
// reply before it can be queued or made approvable. Throws on violation.
export function assertChatReplyAllowed(agentHome, inboxId, text) {
  const inbox = listChatInbox(agentHome).find((entry) => entry.id === inboxId);
  if (!inbox) {
    throw new Error(`Chat message not found: ${inboxId}`);
  }
  if (!inbox.allowed) {
    throw new Error(`Chat message is not from an allowed user: ${inboxId}`);
  }
  const replyText = String(text || "");
  if (!replyText.trim()) {
    throw new Error("Reply text is empty");
  }
  if (scanSecrets(replyText).length > 0) {
    throw new Error("Reply may contain a secret");
  }
  return { inbox, replyText };
}

export function queueChatReply({ agentHome, inboxId, text, source, replyMarkup }) {
  const { inbox, replyText } = assertChatReplyAllowed(agentHome, inboxId, text);
  const now = new Date().toISOString();
  const reply = {
    id: `reply_${Date.now()}_${shortHash(`${inboxId}:${text}`)}`,
    inbox_id: inbox.id,
    channel: inbox.channel,
    chat_id: inbox.chat_id,
    text: replyText,
    text_hash: shortHash(replyText),
    status: "queued",
    ...(source ? { source: String(source) } : {}),
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    created_at: now,
  };
  appendJsonl(agentPaths(agentHome).chatReplies, reply);
  return reply;
}

export function queueLatestChatReply({ agentHome, text }) {
  const latest = listChatInbox(agentHome).at(-1);
  if (!latest) {
    throw new Error("Chat inbox is empty");
  }
  return queueChatReply({ agentHome, inboxId: latest.id, text });
}

export function createChatDraft({ agentHome, inboxId }) {
  const inbox = listChatInbox(agentHome).find((entry) => entry.id === inboxId);
  if (!inbox) {
    throw new Error(`Chat message not found: ${inboxId}`);
  }
  const filePath = draftPath(agentHome, inbox.id);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, renderDraft(inbox));
  return {
    inbox_id: inbox.id,
    path: filePath,
  };
}

export function createLatestChatDraft(agentHome) {
  const latest = listChatInbox(agentHome).at(-1);
  if (!latest) {
    throw new Error("Chat inbox is empty");
  }
  return createChatDraft({ agentHome, inboxId: latest.id });
}

export function createChatHandoff({ agentHome, inboxId }) {
  const inbox = listChatInbox(agentHome).find((entry) => entry.id === inboxId);
  if (!inbox) {
    throw new Error(`Chat message not found: ${inboxId}`);
  }
  const now = new Date().toISOString();
  const id = `handoff_${Date.now()}_${shortHash(inbox.id)}`;
  const filePath = handoffPath(agentHome, id);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, renderHandoff({ id, inbox }));
  const handoff = {
    id,
    inbox_id: inbox.id,
    channel: inbox.channel,
    chat_id: inbox.chat_id,
    status: "pending",
    path: filePath,
    created_at: now,
  };
  appendJsonl(agentPaths(agentHome).handoffs, handoff);
  return handoff;
}

export function createLatestChatHandoff(agentHome) {
  const latest = listChatInbox(agentHome).at(-1);
  if (!latest) {
    throw new Error("Chat inbox is empty");
  }
  return createChatHandoff({ agentHome, inboxId: latest.id });
}

export function handoffStatus(agentHome) {
  const handoffs = latestHandoffs(agentHome);
  return {
    handoffs,
    pending: handoffs.filter((handoff) => handoff.status === "pending").length,
    completed: handoffs.filter((handoff) => handoff.status === "completed").length,
    latest_handoff_id: handoffs.at(-1)?.id || null,
    latest_pending_handoff_id: latestHandoffId(handoffs, "pending"),
    latest_completed_handoff_id: latestHandoffId(handoffs, "completed"),
  };
}

export function completeChatHandoff({ agentHome, id, text }) {
  const handoff = latestHandoffs(agentHome).find((entry) => entry.id === id);
  if (!handoff) {
    throw new Error(`Handoff not found: ${id}`);
  }
  if (handoff.status !== "pending") {
    throw new Error(`Handoff is not pending: ${id}`);
  }
  const reply = queueChatReply({ agentHome, inboxId: handoff.inbox_id, text });
  appendJsonl(agentPaths(agentHome).handoffs, {
    id,
    status: "completed",
    reply_id: reply.id,
    completed_at: new Date().toISOString(),
  });
  return { handoff: { ...handoff, status: "completed", reply_id: reply.id }, reply };
}

export function completeLatestChatHandoff({ agentHome, text }) {
  const handoff = latestHandoffs(agentHome).filter((entry) => entry.status === "pending").at(-1);
  if (!handoff) {
    throw new Error("No pending handoff");
  }
  return completeChatHandoff({ agentHome, id: handoff.id, text });
}

export function listPendingChatReplies(agentHome, { channel } = {}) {
  return latestChatReplies(agentHome)
    .filter((reply) => reply.status === "queued")
    .filter((reply) => !channel || reply.channel === channel);
}

// Folded reply records (queued/sent), for context assembly and status.
export function listChatReplies(agentHome) {
  return latestChatReplies(agentHome);
}

// Folded reply state for a single inbox entry. Used by idempotent callers to
// decide whether a reply already exists (queued or sent) for that inbox.
export function chatReplyStateForInbox(agentHome, inboxId) {
  const replies = latestChatReplies(agentHome).filter((reply) => reply.inbox_id === inboxId);
  if (replies.length === 0) {
    return { exists: false, queued: false, sent: false, reply: null };
  }
  const sent = replies.find((reply) => reply.status === "sent");
  if (sent) {
    return { exists: true, queued: false, sent: true, reply: sent };
  }
  return { exists: true, queued: true, sent: false, reply: replies.at(-1) };
}

export function markChatReplySent(agentHome, id) {
  appendJsonl(agentPaths(agentHome).chatReplies, {
    id,
    status: "sent",
    sent_at: new Date().toISOString(),
  });
}

function draftPath(agentHome, inboxId) {
  return path.join(agentPaths(agentHome).draftsDir, `${inboxId}.md`);
}

function handoffPath(agentHome, id) {
  return path.join(agentPaths(agentHome).handoffsDir, `${id}.md`);
}

function listDraftFiles(agentHome) {
  const { draftsDir } = agentPaths(agentHome);
  if (!fs.existsSync(draftsDir)) {
    return [];
  }
  return fs.readdirSync(draftsDir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => path.join(draftsDir, name));
}

function pruneDraftFiles(agentHome, prunedInboxIds) {
  let count = 0;
  for (const filePath of listDraftFiles(agentHome)) {
    const inboxId = path.basename(filePath, ".md");
    if (prunedInboxIds.has(inboxId)) {
      fs.unlinkSync(filePath);
      count += 1;
    }
  }
  return count;
}

function pruneHandoffFiles(agentHome, cutoff, prunedInboxIds) {
  let count = 0;
  const expiredIds = new Set();
  for (const handoff of latestHandoffs(agentHome)) {
    const expired = isOlderThan(handoff.created_at, cutoff) || prunedInboxIds.has(handoff.inbox_id);
    if (!expired) {
      continue;
    }
    if (handoff.status === "pending") {
      expiredIds.add(handoff.id);
    }
    if (handoff.path && fs.existsSync(handoff.path)) {
      fs.unlinkSync(handoff.path);
      count += 1;
    }
  }
  return { count, expiredIds };
}

function expirePendingHandoffs(agentHome, ids) {
  let count = 0;
  for (const id of ids) {
    appendJsonl(agentPaths(agentHome).handoffs, {
      id,
      status: "expired",
      expired_at: new Date().toISOString(),
    });
    count += 1;
  }
  return count;
}

function pruneSentReplies(agentHome, cutoff) {
  const rows = readJsonl(agentPaths(agentHome).chatReplies);
  const latest = latestChatReplies(agentHome);
  const prunedIds = new Set(
    latest
      .filter((reply) => reply.status === "sent")
      .filter((reply) => isOlderThan(reply.created_at, cutoff))
      .map((reply) => reply.id),
  );
  if (prunedIds.size === 0) {
    return 0;
  }
  writeJsonl(agentPaths(agentHome).chatReplies, rows.filter((entry) => !prunedIds.has(entry.id)));
  return prunedIds.size;
}

function cutoffFromDays(days) {
  const parsed = Number(days);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("Prune days must be a non-negative number");
  }
  return new Date(Date.now() - parsed * 24 * 60 * 60 * 1000);
}

function isOlderThan(value, cutoff) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) && time < cutoff.getTime();
}

function renderDraft(inbox) {
  return [
    "# Telegram Manual Reply Draft",
    "",
    "You are drafting a concise manual reply to a Telegram message.",
    "Do not claim autonomous execution. Do not include secrets. If action is needed, suggest the next local command.",
    "",
    `Inbox id: ${inbox.id}`,
    `Channel: ${inbox.channel}`,
    `User id: ${inbox.user_id}`,
    `Chat id: ${inbox.chat_id}`,
    `Received at: ${inbox.created_at}`,
    "",
    "Incoming message:",
    "",
    "```text",
    inbox.text,
    "```",
    "",
    "Draft a reply that can be sent with:",
    "",
    "```sh",
    `node bin/codex-agent.js reply --state ~/.codex/agent --id ${inbox.id} --text "..."`,
    "```",
    "",
  ].join("\n");
}

function renderHandoff({ id, inbox }) {
  return [
    "# Telegram Handoff",
    "",
    "This is a manual operator handoff. Do not call tools, execute commands, or send Telegram replies automatically.",
    "Draft a reply for the operator to review. Keep it concise and avoid secrets.",
    "",
    `Handoff id: ${id}`,
    `Inbox id: ${inbox.id}`,
    `Channel: ${inbox.channel}`,
    `User id: ${inbox.user_id}`,
    `Chat id: ${inbox.chat_id}`,
    `Received at: ${inbox.created_at}`,
    "",
    "Incoming message:",
    "",
    "```text",
    inbox.text,
    "```",
    "",
    "After the operator prepares a reply file, complete the handoff with:",
    "",
    "```sh",
    `node bin/codex-agent.js handoff-complete --state ~/.codex/agent --id ${id} --from-file /tmp/reply.txt`,
    "```",
    "",
  ].join("\n");
}

function latestHandoffs(agentHome) {
  const latest = new Map();
  for (const entry of readJsonl(agentPaths(agentHome).handoffs)) {
    if (!entry.id) {
      continue;
    }
    latest.set(entry.id, { ...(latest.get(entry.id) || {}), ...entry });
  }
  return Array.from(latest.values());
}

function latestHandoffId(handoffs, status) {
  return handoffs.filter((handoff) => handoff.status === status).at(-1)?.id || null;
}

function latestChatReplies(agentHome) {
  const latest = new Map();
  for (const entry of readJsonl(agentPaths(agentHome).chatReplies)) {
    if (!entry.id) {
      continue;
    }
    latest.set(entry.id, { ...(latest.get(entry.id) || {}), ...entry });
  }
  return Array.from(latest.values());
}
