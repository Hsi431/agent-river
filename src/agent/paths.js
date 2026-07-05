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
    exchangeMessages: path.join(agentHome, "exchange-messages.jsonl"),
    exchangeClaims: path.join(agentHome, "exchange-claims.jsonl"),
    exchangeReplies: path.join(agentHome, "exchange-replies.jsonl"),
    exchangeNotifications: path.join(agentHome, "exchange-notifications.jsonl"),
    sessions: path.join(agentHome, "sessions.jsonl"),
    dashboardCursor: path.join(agentHome, "dashboard-cursor.json"),
    dashboardLock: path.join(agentHome, "dashboard.lock"),
    agentRegistry: path.join(agentHome, "agent-registry.json"),
    agentTokensDir: path.join(agentHome, "agent-tokens"),
    exchangeRunnerDispatch: path.join(agentHome, "exchange-runner-dispatch.jsonl"),
    exchangeRunnerLock: path.join(agentHome, "exchange-runner.lock"),
    exchangeRunnerLogsDir: path.join(agentHome, "exchange-runner-logs"),
    exchangeRunnerSessions: path.join(agentHome, "exchange-runner-sessions.json"),
    dispatchApprovals: path.join(agentHome, "dispatch-approvals.jsonl"),
    v2PollerLock: path.join(agentHome, "v2-poller.lock"),
    v2Outbox: path.join(agentHome, "v2-outbox.jsonl"),
    codexExchangeRunnerDispatch: path.join(agentHome, "codex-exchange-runner-dispatch.jsonl"),
    codexExchangeRunnerLock: path.join(agentHome, "codex-exchange-runner.lock"),
    codexExchangeRunnerLogsDir: path.join(agentHome, "codex-exchange-runner-logs"),
    execRunnerDispatch: path.join(agentHome, "exec-runner-dispatch.jsonl"),
    execRunnerLock: path.join(agentHome, "exec-runner.lock"),
  };
}
