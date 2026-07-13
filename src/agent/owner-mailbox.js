import { submitExchangeMessage } from "./exchange.js";
import { getRegisteredAgent } from "./registry.js";
import { getPrimaryAgentId, isExchangeAgentEnabled, readAgentConfig } from "./safety.js";

const OWNER_MAILBOX_CHANNELS = new Set(["telegram", "web"]);

// Surface adapters authenticate the owner before calling this function. This
// shared domain path owns target eligibility and the canonical mailbox envelope.
export function submitOwnerMailboxMessage({ agentHome, to, text, subject = null, channel = "telegram", threadId = null, chatId = null, repo = null, allowPrimary = false, requireActiveTarget = false }) {
  if (!isOwnerMailboxTargetEligible(agentHome, to, { allowPrimary, requireActiveTarget })) {
    return { ok: false, reason: "agent_not_enabled", message: null };
  }
  const message = submitExchangeMessage({
    agentHome,
    from: getPrimaryAgentId(agentHome),
    to,
    channel,
    threadId,
    chatId,
    text,
    subject,
    repo,
  });
  return { ok: true, reason: null, message };
}

export function isOwnerMailboxTargetEligible(agentHome, target, { allowPrimary = false, requireActiveTarget = false } = {}) {
  const name = String(target || "");
  if (allowPrimary && name === "codex" && name === getPrimaryAgentId(agentHome)) return true;
  if (!isExchangeAgentEnabled(agentHome, name)) return false;
  if (!requireActiveTarget) return true;
  const registered = getRegisteredAgent(agentHome, name);
  if (registered) return registered.status === "active";
  const route = (readAgentConfig(agentHome).exchange_agents || []).find((agent) => agent.agent_id === name);
  return route?.kind === "manual";
}

export function isOwnerMailboxChannel(channel) {
  return OWNER_MAILBOX_CHANNELS.has(String(channel || ""));
}
