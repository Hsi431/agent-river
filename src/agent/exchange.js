import { appendJsonl, readJsonl, writeJsonl } from "codex-memory-river/src/jsonl.js";
import { redactSecrets, scanSecrets } from "codex-memory-river/src/secret-scan.js";
import { shortHash } from "codex-memory-river/src/hash.js";
import { agentPaths } from "./paths.js";
import { isExchangeAgentEnabled } from "./safety.js";

const VALID_TARGET = /^[a-z][a-z0-9_-]*$|^any$/;
const DEFAULT_LEASE_SECONDS = 3600;

export function submitExchangeMessage({ agentHome, from, to = "any", channel = "cli", threadId, chatId, text }) {
  const sender = requireName(from, "from");
  const target = requireName(to, "to");
  const body = String(text || "");
  if (!body.trim()) {
    throw new Error("Exchange message text is empty");
  }
  // Redact (not reject) secret-like content so legitimate code-review requests
  // are not blocked. Only the redacted text is persisted — raw secret text never
  // reaches the message record (id hash, text, or text_hash).
  const redacted = redactSecrets(body);
  const now = new Date().toISOString();
  const message = {
    id: `msg_${Date.now()}_${shortHash(`${sender}:${target}:${redacted}`)}`,
    from: sender,
    to: target,
    channel: String(channel || "cli"),
    thread_id: threadId ? String(threadId) : null,
    chat_id: chatId ? String(chatId) : null,
    text: redacted,
    text_hash: shortHash(redacted),
    created_at: now,
  };
  appendJsonl(agentPaths(agentHome).exchangeMessages, message);
  return message;
}

export function listExchangeInbox(agentHome, { agent } = {}) {
  const messages = readJsonl(agentPaths(agentHome).exchangeMessages);
  const claims = latestExchangeClaims(agentHome);
  return messages
    .filter((message) => !agent || message.to === "any" || message.to === agent)
    .filter((message) => !isTerminalClaim(claims.get(message.id)))
    .map((message) => ({ ...message, claim: visibleClaim(claims.get(message.id)) }));
}

export function claimExchangeMessage({ agentHome, id, agent, leaseSeconds = DEFAULT_LEASE_SECONDS }) {
  const agentId = requireEnabledAgent(agentHome, agent);
  const message = findExchangeMessage(agentHome, id);
  if (message.to !== "any" && message.to !== agentId) {
    throw new Error(`Exchange message is addressed to ${message.to}`);
  }
  const claim = latestExchangeClaims(agentHome).get(id);
  if (isActiveClaim(claim)) {
    throw new Error(`Exchange message already claimed by ${claim.agent_id}`);
  }
  if (claim?.status === "completed") {
    throw new Error(`Exchange message already completed: ${id}`);
  }
  const lease = normalizeLeaseSeconds(leaseSeconds);
  const now = new Date();
  const event = {
    message_id: id,
    agent_id: agentId,
    status: "claimed",
    claimed_at: now.toISOString(),
    lease_expires_at: new Date(now.getTime() + lease * 1000).toISOString(),
  };
  appendJsonl(agentPaths(agentHome).exchangeClaims, event);
  return { ...message, claim: event };
}

export function releaseExchangeClaim({ agentHome, id, agent }) {
  const agentId = requireEnabledAgent(agentHome, agent);
  const claim = latestExchangeClaims(agentHome).get(id);
  if (!isActiveClaim(claim) || claim.agent_id !== agentId) {
    throw new Error(`Exchange message is not actively claimed by ${agentId}: ${id}`);
  }
  const event = {
    message_id: id,
    agent_id: agentId,
    status: "released",
    released_at: new Date().toISOString(),
  };
  appendJsonl(agentPaths(agentHome).exchangeClaims, event);
  return { message: findExchangeMessage(agentHome, id), claim: event };
}

export function replyExchangeMessage({ agentHome, id, agent, text }) {
  const agentId = requireEnabledAgent(agentHome, agent);
  const message = findExchangeMessage(agentHome, id);
  const claim = latestExchangeClaims(agentHome).get(id);
  if (!isActiveClaim(claim) || claim.agent_id !== agentId) {
    throw new Error(`Exchange message is not claimed by ${agentId}: ${id}`);
  }
  const body = String(text || "");
  if (!body.trim()) {
    throw new Error("Exchange reply text is empty");
  }
  if (scanSecrets(body).length > 0) {
    throw new Error("Exchange reply may contain a secret");
  }
  const reply = {
    id: `xreply_${Date.now()}_${shortHash(`${id}:${agentId}:${body}`)}`,
    message_id: id,
    agent_id: agentId,
    text: body,
    text_hash: shortHash(body),
    created_at: new Date().toISOString(),
  };
  appendJsonl(agentPaths(agentHome).exchangeReplies, reply);
  appendJsonl(agentPaths(agentHome).exchangeClaims, {
    message_id: id,
    agent_id: agentId,
    status: "completed",
    reply_id: reply.id,
    completed_at: new Date().toISOString(),
  });
  return { message, reply };
}

export function listExchangeReplies(agentHome, { agent, threadId } = {}) {
  const requester = requireName(agent, "agent");
  const messages = readJsonl(agentPaths(agentHome).exchangeMessages);
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  return readJsonl(agentPaths(agentHome).exchangeReplies)
    .map((reply) => {
      const message = messagesById.get(reply.message_id);
      if (!message || message.from !== requester) {
        return null;
      }
      if (threadId && message.thread_id !== String(threadId)) {
        return null;
      }
      return formatExchangeReply(message, reply);
    })
    .filter(Boolean);
}

export function getExchangeThread(agentHome, id) {
  const message = findExchangeMessage(agentHome, id);
  const replies = readJsonl(agentPaths(agentHome).exchangeReplies)
    .filter((reply) => reply.message_id === message.id)
    .map((reply) => formatExchangeReply(message, reply));
  return { message, replies };
}

export function exchangeStatus(agentHome) {
  const messages = readJsonl(agentPaths(agentHome).exchangeMessages);
  const claims = latestExchangeClaims(agentHome);
  const replies = readJsonl(agentPaths(agentHome).exchangeReplies);
  const open = messages.filter((message) => isOpenClaim(claims.get(message.id))).length;
  const claimed = messages.filter((message) => isActiveClaim(claims.get(message.id))).length;
  const expired = messages.filter((message) => claimStatus(claims.get(message.id)) === "expired").length;
  const released = messages.filter((message) => claims.get(message.id)?.status === "released").length;
  const completed = messages.filter((message) => claims.get(message.id)?.status === "completed").length;
  return {
    messages: messages.length,
    open,
    claimed,
    expired,
    released,
    completed,
    replies: replies.length,
    latest_message_id: messages.at(-1)?.id || null,
  };
}

export function pruneExchangeState({ agentHome, days }) {
  const cutoff = cutoffFromDays(days);
  const paths = agentPaths(agentHome);
  const messages = readJsonl(paths.exchangeMessages);
  const claims = latestExchangeClaims(agentHome);
  const prunedIds = new Set(
    messages
      .filter((message) => claims.get(message.id)?.status === "completed")
      .filter((message) => isOlderThan(message.created_at, cutoff))
      .map((message) => message.id),
  );
  if (prunedIds.size === 0) {
    return {
      cutoff: cutoff.toISOString(),
      pruned_messages: 0,
      pruned_claim_events: 0,
      pruned_replies: 0,
    };
  }
  const claimRows = readJsonl(paths.exchangeClaims);
  const replyRows = readJsonl(paths.exchangeReplies);
  writeJsonl(paths.exchangeMessages, messages.filter((message) => !prunedIds.has(message.id)));
  writeJsonl(paths.exchangeClaims, claimRows.filter((claim) => !prunedIds.has(claim.message_id)));
  writeJsonl(paths.exchangeReplies, replyRows.filter((reply) => !prunedIds.has(reply.message_id)));
  return {
    cutoff: cutoff.toISOString(),
    pruned_messages: prunedIds.size,
    pruned_claim_events: claimRows.length - readJsonl(paths.exchangeClaims).length,
    pruned_replies: replyRows.length - readJsonl(paths.exchangeReplies).length,
  };
}

function findExchangeMessage(agentHome, id) {
  const message = readJsonl(agentPaths(agentHome).exchangeMessages).find((entry) => entry.id === id);
  if (!message) {
    throw new Error(`Exchange message not found: ${id}`);
  }
  return message;
}

function formatExchangeReply(message, reply) {
  return {
    message_id: message.id,
    thread_id: message.thread_id || null,
    from: message.from,
    to: message.to,
    responder: reply.agent_id,
    request_text: message.text,
    reply_id: reply.id,
    reply_text: reply.text,
    created_at: reply.created_at,
  };
}

function latestExchangeClaims(agentHome) {
  const latest = new Map();
  for (const entry of readJsonl(agentPaths(agentHome).exchangeClaims)) {
    if (entry.message_id) {
      latest.set(entry.message_id, { ...(latest.get(entry.message_id) || {}), ...entry });
    }
  }
  return latest;
}

function isTerminalClaim(claim) {
  return claim?.status === "completed";
}

function isOpenClaim(claim) {
  return !claim || claim.status === "released" || claimStatus(claim) === "expired";
}

function isActiveClaim(claim) {
  return claimStatus(claim) === "claimed";
}

function visibleClaim(claim) {
  if (!claim) {
    return null;
  }
  const status = claimStatus(claim);
  return status === claim.status ? claim : { ...claim, status };
}

function claimStatus(claim) {
  if (!claim) {
    return null;
  }
  if (claim.status === "claimed" && isLeaseExpired(claim)) {
    return "expired";
  }
  return claim.status;
}

function isLeaseExpired(claim) {
  const expires = Date.parse(claim.lease_expires_at || "");
  return Number.isFinite(expires) && expires <= Date.now();
}

function normalizeLeaseSeconds(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("Exchange claim lease must be a positive number");
  }
  return Math.floor(parsed);
}

function requireEnabledAgent(agentHome, agent) {
  const agentId = requireName(agent, "agent");
  if (!isExchangeAgentEnabled(agentHome, agentId)) {
    throw new Error(`Exchange agent is not enabled: ${agentId}`);
  }
  return agentId;
}

function cutoffFromDays(days) {
  const parsed = Number(days);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("Exchange prune days must be a non-negative number");
  }
  return new Date(Date.now() - parsed * 24 * 60 * 60 * 1000);
}

function isOlderThan(value, cutoff) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) && time < cutoff.getTime();
}

function requireName(value, name) {
  const normalized = String(value || "").trim();
  if (!VALID_TARGET.test(normalized)) {
    throw new Error(`Invalid exchange ${name}`);
  }
  return normalized;
}
