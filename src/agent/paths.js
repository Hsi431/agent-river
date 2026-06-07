import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandHome } from "../lib/paths.js";

export function defaultAgentHome() {
  return path.join(os.homedir(), ".codex", "agent");
}

export function resolveAgentHome(input, { create = true } = {}) {
  const resolved = path.resolve(expandHome(input || process.env.CODEX_AGENT_HOME || defaultAgentHome()));
  if (create) {
    fs.mkdirSync(resolved, { recursive: true });
  }
  return resolved;
}

export function agentPaths(agentHome) {
  return {
    tasksDir: path.join(agentHome, "tasks"),
    runs: path.join(agentHome, "runs.jsonl"),
    cost: path.join(agentHome, "cost.jsonl"),
    config: path.join(agentHome, "config.json"),
    gatewayAudit: path.join(agentHome, "gateway-audit.jsonl"),
    telegramState: path.join(agentHome, "telegram-state.json"),
    telegramOutbox: path.join(agentHome, "telegram-outbox.jsonl"),
    chatInbox: path.join(agentHome, "chat-inbox.jsonl"),
    chatReplies: path.join(agentHome, "chat-replies.jsonl"),
    draftsDir: path.join(agentHome, "drafts"),
    handoffs: path.join(agentHome, "handoffs.jsonl"),
    handoffsDir: path.join(agentHome, "handoffs"),
    exchangeMessages: path.join(agentHome, "exchange-messages.jsonl"),
    exchangeClaims: path.join(agentHome, "exchange-claims.jsonl"),
    exchangeReplies: path.join(agentHome, "exchange-replies.jsonl"),
    exchangeNotifications: path.join(agentHome, "exchange-notifications.jsonl"),
    exchangeRunnerDispatch: path.join(agentHome, "exchange-runner-dispatch.jsonl"),
    exchangeRunnerLock: path.join(agentHome, "exchange-runner.lock"),
    exchangeRunnerLogsDir: path.join(agentHome, "exchange-runner-logs"),
    exchangeRunnerSessions: path.join(agentHome, "exchange-runner-sessions.json"),
    codexReplies: path.join(agentHome, "codex-replies.jsonl"),
    telegramCodexLock: path.join(agentHome, "telegram-codex.lock"),
    replyApprovals: path.join(agentHome, "reply-approvals.jsonl"),
    dispatchApprovals: path.join(agentHome, "dispatch-approvals.jsonl"),
    directSendAudit: path.join(agentHome, "direct-send-audit.jsonl"),
    ownerModeAudit: path.join(agentHome, "owner-mode-audit.jsonl"),
    bridgeStatus: path.join(agentHome, "telegram-codex-bridge-status.json"),
    v2PollerLock: path.join(agentHome, "v2-poller.lock"),
    v2Outbox: path.join(agentHome, "v2-outbox.jsonl"),
  };
}
