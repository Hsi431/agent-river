import { submitExchangeMessage } from "./exchange.js";
import { getPrimaryAgentId, isExchangeAgentEnabled } from "./safety.js";

// Surface adapters authenticate the owner before calling this function. This
// shared domain path owns target eligibility and the canonical mailbox envelope.
export function submitOwnerMailboxMessage({ agentHome, to, text, channel = "telegram", threadId = null, chatId = null }) {
  if (!isExchangeAgentEnabled(agentHome, to)) {
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
  });
  return { ok: true, reason: null, message };
}
