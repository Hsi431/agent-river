import { chatStatus, inboxSummary } from "./chat.js";
import { pollTelegramOnce } from "./telegram.js";

export async function runBridgeOnce({
  agentHome,
  transport = "fetch",
  memoryStateHome,
  token,
  fetchImpl,
  execFileImpl,
  requestImpl,
  runner,
} = {}) {
  const telegram = await pollTelegramOnce({
    agentHome,
    transport,
    token,
    fetchImpl,
    execFileImpl,
    requestImpl,
    memoryStateHome,
    runner,
  });
  const inbox = inboxSummary(agentHome);
  const status = chatStatus(agentHome);
  return {
    telegram,
    inbox: {
      latest_inbox_id: inbox.latest_inbox_id,
      count: inbox.messages.length,
      latest: inbox.messages.at(-1) || null,
    },
    chat: status,
  };
}
