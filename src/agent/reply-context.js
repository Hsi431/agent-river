import { directReplyInstructionLines } from "./codex-reply.js";
import { listChatInbox, listChatReplies } from "./chat.js";
import { buildMemoryContextBlock } from "./memory-adapter.js";

const PER_MESSAGE_CHARS = 1000;

// Assembles the direct-reply prompt for telegram-codex: direct-reply instructions
// + optional Memory River context block + recent SAME-CHAT thread (capped) +
// the incoming message. Only allowlisted same-chat history is included; tool
// logs and gateway audits are never read. The caller still secret-scans the
// final prompt before invoking Codex.
export async function buildTelegramReplyPrompt({
  agentHome,
  inbox,
  historyMessages = 8,
  maxChars = 6000,
  memory = null,
  preflightImpl,
  contextBlockImpl,
  importImpl,
} = {}) {
  const parts = [...directReplyInstructionLines(), ""];

  if (memory && memory.repo) {
    const block = await buildMemoryContextBlock({
      enabled: true,
      memoryStateHome: memory.stateHome,
      repo: memory.repo,
      preflightImpl,
      contextBlockImpl,
      importImpl,
    });
    if (block && block.trim()) {
      parts.push("Codex Memory River context:", block, "");
    }
  }

  const thread = buildThread(agentHome, inbox, historyMessages, maxChars);
  if (thread.length > 0) {
    parts.push("Recent conversation in this chat (oldest first):", ...thread, "");
  }

  parts.push("Incoming message:", String(inbox.text ?? ""));
  return parts.join("\n");
}

function buildThread(agentHome, inbox, historyMessages, maxChars) {
  const chatId = String(inbox.chat_id);
  const inbound = listChatInbox(agentHome)
    .filter((m) => m.allowed && String(m.chat_id) === chatId && m.id !== inbox.id)
    .map((m) => ({ role: "user", text: String(m.text ?? ""), ts: m.created_at }));
  const replies = listChatReplies(agentHome)
    .filter((r) => r.status === "sent" && String(r.chat_id) === chatId)
    .map((r) => ({ role: "assistant", text: String(r.text ?? ""), ts: r.created_at }));

  const entries = [...inbound, ...replies]
    .sort((a, b) => String(a.ts ?? "").localeCompare(String(b.ts ?? "")))
    .slice(-Math.max(0, Number(historyMessages) || 0));

  const lines = entries.map((e) => `${e.role === "user" ? "User" : "Assistant"}: ${truncate(e.text, PER_MESSAGE_CHARS)}`);
  // Hard char cap: drop oldest lines until under the budget.
  const cap = Math.max(0, Number(maxChars) || 0);
  while (lines.length > 0 && lines.join("\n").length > cap) {
    lines.shift();
  }
  return lines;
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
