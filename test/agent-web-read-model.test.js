import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { approveDispatch, createDispatchApproval, rejectDispatch } from "../src/agent/dispatch.js";
import { claimExchangeMessage, replyExchangeMessage, submitExchangeMessage } from "../src/agent/exchange.js";
import { agentPaths } from "../src/agent/paths.js";
import { joinAgentRegistry, seedSpawnAgents } from "../src/agent/registry.js";
import { closeSession, openSession } from "../src/agent/sessions.js";
import { appendCost, enableExchangeAgent, setDailyTokenBudget, setTelegramCodexPolicy } from "../src/agent/safety.js";
import { createTask, transitionTask } from "../src/agent/tasks.js";
import { appendJsonl } from "../src/lib/jsonl.js";
import {
  getInboxItem,
  getWebSession,
  listArchiveItems,
  listDispatchItems,
  listInboxItems,
  listWebAgents,
  listWebSessions,
  readWebSafety,
  readWebStatus,
} from "../src/web/read-model.js";

test("web read model normalizes existing mailbox, dispatch, session, and registry state", async () => {
  const agentHome = makeAgentHome();
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  seedSpawnAgents({ agentHome, now: new Date("2026-07-13T00:00:00.000Z") });
  setTelegramCodexPolicy(agentHome, {
    direct_send_user_add: "owner-123",
    workspace_root: "/workspace",
    default_repo: "/workspace/repo",
    v2_enabled: true,
  });
  const session = await openSession({
    agentHome,
    initiator: "owner",
    participants: "codex,opus",
    topic: "Review the truthful web read model.",
    budgetMessages: 5,
    budgetMinutes: 30,
    now: Date.parse("2026-07-13T00:01:00.000Z"),
  });
  const message = submitExchangeMessage({
    agentHome,
    from: "codex",
    to: "opus",
    sessionId: session.session_id,
    text: "Inspect the current implementation.",
  });
  claimExchangeMessage({ agentHome, id: message.id, agent: "opus" });
  replyExchangeMessage({ agentHome, id: message.id, agent: "opus", text: "The projection is grounded in persisted state." });
  closeSession({ agentHome, id: session.session_id, now: Date.parse("2026-07-13T00:05:00.000Z") });
  const { approval } = createDispatchApproval({
    agentHome,
    proposedBy: "codex",
    proposal: {
      to: "opus",
      task: "Review the read model normalization tests.",
      reason: "Independent verification",
      suggested_mode: "plan",
    },
    parentMsgId: message.id,
    now: Date.parse("2026-07-13T00:03:00.000Z"),
  });
  rejectDispatch({ agentHome, id: approval.id, now: Date.parse("2026-07-13T00:04:00.000Z") });
  const { approval: taskApproval } = createDispatchApproval({
    agentHome,
    proposedBy: "opus",
    proposal: {
      to: "codex",
      task: "Produce the completed read model verification report.",
      reason: "Owner requested a durable result",
      suggested_mode: "plan",
    },
    now: Date.parse("2026-07-13T00:06:00.000Z"),
  });
  const approved = approveDispatch({
    agentHome,
    id: taskApproval.id,
    defaultRepo: "/workspace/repo",
    now: Date.parse("2026-07-13T00:07:00.000Z"),
  });
  const completedTask = JSON.parse(fs.readFileSync(path.join(agentPaths(agentHome).tasksDir, `${approved.outcome.id}.json`), "utf8"));
  transitionTask(agentHome, completedTask, "done", "Task completed.", {
    patch: { result: { ...completedTask.result, summary: "Verification complete." } },
  });
  createTask({
    agentHome,
    repo: "/workspace/repo",
    request: "Pending edit approval for status count coverage.",
    mode: "edit",
  });
  joinAgentRegistry({ agentHome, name: "otter", style: "poll", capabilities: "read" });

  const inbox = listInboxItems(agentHome);
  const exchange = getInboxItem(agentHome, message.id);
  const standaloneReply = inbox.find((item) => item.type === "exchange_reply" && item.sourceMessageId === message.id);
  const dispatches = listDispatchItems(agentHome);
  const sessions = listWebSessions(agentHome);
  const detail = getWebSession(agentHome, session.session_id);
  const agents = listWebAgents(agentHome);
  const safety = readWebSafety(agentHome);
  const status = readWebStatus(agentHome);
  const completedItem = getInboxItem(agentHome, approved.outcome.id);

  assert.equal(inbox.some((item) => item.id === message.id), true);
  assert.equal(exchange.status, "completed");
  assert.equal(exchange.replyCount, 1);
  assert.equal(standaloneReply.status, "completed");
  assert.equal(standaloneReply.sender, "opus");
  assert.equal(standaloneReply.recipient, "codex");
  assert.equal(standaloneReply.sessionId, session.session_id);
  assert.equal(dispatches.find((item) => item.id === approval.id).status, "rejected");
  assert.equal(dispatches.find((item) => item.id === approval.id).parentMessageId, message.id);
  assert.equal(dispatches.find((item) => item.id === taskApproval.id).dispatchId, taskApproval.id);
  assert.equal(completedItem.type, "task_result");
  assert.equal(completedItem.dispatchId, taskApproval.id);
  assert.equal(listArchiveItems(agentHome).some((item) => item.id === completedTask.id && item.type === "task_result"), true);
  assert.equal(sessions[0].status, "closed_ok");
  assert.equal(sessions[0].transcriptPath, null);
  assert.deepEqual(new Set(detail.timeline.map((row) => row.type)), new Set(["session_opened", "message", "reply", "session_closed"]));
  assert.equal(agents.find((agent) => agent.name === "opus").routingEnabled, true);
  assert.equal(agents.find((agent) => agent.name === "opus").runnerStatus, null);
  assert.equal(typeof agents.find((agent) => agent.name === "opus").eligibleWorkCount, "number");
  assert.equal(safety.ownerAllowlist.telegramCount, 1);
  assert.equal(safety.raw.telegram_codex_policy.direct_send_user_allowlist.count, 1);
  assert.equal(JSON.stringify(safety).includes("owner-123"), false);
  assert.equal(status.activeSessions, 0);
  assert.equal(status.pendingApprovals, 2);
});

test("archive is a terminal projection and local raw records are recursively redacted", () => {
  const agentHome = makeAgentHome();
  const paths = agentPaths(agentHome);
  const secret = "sk-123456789012345678901234567890";
  appendJsonl(paths.exchangeMessages, {
    id: "msg_secret",
    from: "codex",
    to: "opus",
    text: `credential ${secret}`,
    metadata: { api_token: "hidden-value" },
    created_at: "2026-07-13T00:00:00.000Z",
  });
  appendJsonl(paths.exchangeClaims, {
    message_id: "msg_secret",
    agent_id: "opus",
    status: "completed",
    completed_at: "2026-07-13T00:01:00.000Z",
  });
  appendJsonl(paths.codexExchangeRunnerDispatch, {
    message_id: "msg_secret",
    attempt: 2,
    outcome: "blocked_terminal",
    error: `runner failed near ${secret}`,
    created_at: "2026-07-13T00:02:00.000Z",
  });

  const item = getInboxItem(agentHome, "msg_secret");
  const alert = listInboxItems(agentHome).find((entry) => entry.type === "system_alert");
  const archive = listArchiveItems(agentHome);
  const serialized = JSON.stringify(item);

  assert.equal(item.status, "completed");
  assert.equal(archive.some((entry) => entry.id === "msg_secret"), true);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("hidden-value"), false);
  assert.match(item.raw.message.text, /\[redacted:openai_like_key\]/);
  assert.equal(item.raw.message.metadata.api_token, "[redacted]");
  assert.equal(alert.sender, "codex");
  assert.equal(alert.sourceMessageId, "msg_secret");
  assert.equal(alert.status, "failed");
  assert.equal(JSON.stringify(alert).includes(secret), false);
});

test("read model treats absent and corrupt optional state as empty", () => {
  const agentHome = makeAgentHome();
  const paths = agentPaths(agentHome);
  fs.writeFileSync(paths.sessions, "not-json\n");
  fs.writeFileSync(paths.agentRegistry, "not-json\n");
  fs.mkdirSync(paths.tasksDir, { recursive: true });
  fs.writeFileSync(path.join(paths.tasksDir, "broken.json"), "not-json\n");

  assert.deepEqual(listInboxItems(agentHome), []);
  assert.deepEqual(listDispatchItems(agentHome), []);
  assert.deepEqual(listWebSessions(agentHome), []);
  assert.equal(listWebAgents(agentHome).length, 1);
  assert.deepEqual(listArchiveItems(agentHome), []);
});

test("status uses the safety gate and session expiry projection never mutates the ledger", async () => {
  const agentHome = makeAgentHome();
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  const openedAt = Date.parse("2026-07-13T00:00:00.000Z");
  const session = await openSession({
    agentHome,
    initiator: "owner",
    participants: "codex,opus",
    topic: "Verify a read-only effective expiry projection.",
    budgetMessages: 5,
    budgetMinutes: 1,
    now: openedAt,
  });
  const sessionsFile = agentPaths(agentHome).sessions;
  const before = fs.readFileSync(sessionsFile);
  const projected = listWebSessions(agentHome, { now: openedAt + 61_000 }).find((item) => item.id === session.session_id);
  const detail = getWebSession(agentHome, session.session_id, { now: openedAt + 61_000 });
  const after = fs.readFileSync(sessionsFile);

  assert.equal(projected.status, "exhausted");
  assert.equal(projected.sourceStatus, "active");
  assert.equal(detail.status, "exhausted");
  assert.deepEqual(after, before);

  setDailyTokenBudget(agentHome, 1);
  appendCost(agentHome, { task_id: "task_budget", step: "run", tokens: 1 });
  const safety = readWebSafety(agentHome);
  const status = readWebStatus(agentHome);
  assert.equal(safety.ok, false);
  assert.equal(safety.blockedReason, "daily_token_budget");
  assert.equal(status.system, "stopped");
});

function makeAgentHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-web-read-model-"));
}
