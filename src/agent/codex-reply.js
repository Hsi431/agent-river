import { listChatInbox, queueChatReply } from "./chat.js";

// Fake-runner only. This module NEVER calls real `codex exec`, a shell, or the
// network. It builds a conservative reply prompt, hands it to an injectable
// runner (production default is a clearly-marked local fake), and queues the
// result through queueChatReply so the existing empty/secret/allowlist guards
// apply. The queued reply is still sent manually by bridge-once / telegram-poll.

export async function codexReplyOnce({ agentHome, inboxId, runner = fakeCodexRunner }) {
  const inbox = selectInbox(agentHome, inboxId);
  const prompt = buildReplyPrompt(inbox);
  const draft = await runner({ prompt, inbox });
  const reply = queueChatReply({ agentHome, inboxId: inbox.id, text: draft });
  return { inbox_id: inbox.id, reply_id: reply.id, queued: true };
}

// Manual draft mode: codex-reply-once produces a draft for a human to review
// before sending, so the prompt frames it as drafting advice.
export function buildReplyPrompt(inbox) {
  return [
    "You are drafting a conservative manual reply to a Telegram message.",
    "Do not claim autonomous execution. Do not run commands or tools. Do not include secrets.",
    "If action is needed, suggest the next local command for the operator instead of acting.",
    "",
    `Channel: ${inbox.channel}`,
    `Received at: ${inbox.created_at}`,
    "",
    "Incoming message:",
    inbox.text,
  ].join("\n");
}

// Direct reply mode: telegram-codex-once sends the model output straight to the
// Telegram user, so the prompt must produce the reply itself, with no meta
// commentary or "draft" framing. Shared by the context-assembling builder.
export function directReplyInstructionLines() {
  return [
    "You are replying directly to a Telegram user. Your entire output is sent to them verbatim.",
    "Write only the reply message itself.",
    "Do not prefix or wrap it with meta commentary such as \"可以回\", \"你可以回\", \"建議回覆\", \"Draft:\", or \"Reply:\".",
    "Do not claim autonomous actions, tool execution, file edits, or background work. If something needs doing, say what can be done next — do not claim it is done.",
    "Do not include secrets. Keep it concise and reply in the same language as the incoming message.",
  ];
}

export function buildDirectTelegramReplyPrompt(inbox) {
  return [
    ...directReplyInstructionLines(),
    "",
    "Incoming message:",
    inbox.text,
  ].join("\n");
}

async function fakeCodexRunner() {
  // Deliberately does not echo raw inbound text, call any model, or run anything.
  return [
    "[codex-reply-once draft — fake runner, not a real Codex reply. Review before sending.]",
    "Your message was received and is queued for manual review.",
  ].join("\n");
}

function selectInbox(agentHome, inboxId) {
  const messages = listChatInbox(agentHome);
  if (inboxId) {
    const found = messages.find((entry) => entry.id === inboxId);
    if (!found) {
      throw new Error(`Chat message not found: ${inboxId}`);
    }
    return found;
  }
  const latest = messages.at(-1);
  if (!latest) {
    throw new Error("Chat inbox is empty");
  }
  return latest;
}
