import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgentCli } from "../src/agent/cli.js";
import { handleGatewayMessage, parseGatewayCommand, safeGatewayReply } from "../src/agent/gateway.js";
import { agentPaths } from "../src/agent/paths.js";
import { allowGatewayUser, enableExchangeAgent, setDailyTokenBudget, setKillSwitch, setTelegramCodexPolicy } from "../src/agent/safety.js";
import { listTasks, writeTask } from "../src/agent/tasks.js";
import { statePaths } from "codex-memory-river/src/paths.js";
import { readJsonl, writeJsonl } from "codex-memory-river/src/jsonl.js";

test("gateway parses status and submit commands", () => {
  assert.deepEqual(parseGatewayCommand("status"), {
    command: "agent_status",
    args: { id: null },
  });
  assert.deepEqual(parseGatewayCommand("agent status task_123"), {
    command: "agent_status",
    args: { id: "task_123" },
  });
  assert.deepEqual(parseGatewayCommand("agent help"), {
    command: "agent_help",
    args: {},
  });
  assert.deepEqual(parseGatewayCommand("agent help extra"), {
    command: "unknown",
    args: {},
  });
  assert.deepEqual(parseGatewayCommand("agent status ../../x"), {
    command: "unknown",
    args: {},
  });
  assert.deepEqual(parseGatewayCommand("agent run"), {
    command: "invalid_run",
    args: {},
  });
  assert.deepEqual(parseGatewayCommand("agent run task_123"), {
    command: "agent_run",
    args: { id: "task_123" },
  });
  assert.deepEqual(parseGatewayCommand("agent run now"), {
    command: "unknown",
    args: {},
  });
  assert.deepEqual(parseGatewayCommand("agent run task_123 extra"), {
    command: "unknown",
    args: {},
  });
  assert.deepEqual(parseGatewayCommand("agent run ../../x"), {
    command: "unknown",
    args: {},
  });
  assert.deepEqual(parseGatewayCommand("agent run task_bad!"), {
    command: "unknown",
    args: {},
  });
  assert.deepEqual(parseGatewayCommand("agent approve task_123"), {
    command: "agent_approve",
    args: { id: "task_123" },
  });
  assert.deepEqual(parseGatewayCommand("agent approve ../../x"), {
    command: "unknown",
    args: {},
  });
  assert.deepEqual(parseGatewayCommand("agent reject task_123"), {
    command: "agent_reject",
    args: { id: "task_123" },
  });
  assert.deepEqual(parseGatewayCommand("agent reject ../../x"), {
    command: "unknown",
    args: {},
  });
  assert.deepEqual(parseGatewayCommand("@opus Review this patch"), {
    command: "exchange_ask",
    args: { agent: "opus", text: "Review this patch", threadId: null },
  });
  assert.deepEqual(parseGatewayCommand("opus: Review this patch"), {
    command: "exchange_ask",
    args: { agent: "opus", text: "Review this patch", threadId: null },
  });
  assert.deepEqual(parseGatewayCommand("@opus inbox"), {
    command: "exchange_inbox",
    args: { agent: "opus" },
  });
  assert.deepEqual(parseGatewayCommand("@codex replies"), {
    command: "exchange_replies",
    args: { agent: "codex", threadId: null },
  });
  assert.deepEqual(parseGatewayCommand("@any broadcast"), {
    command: "unknown",
    args: {},
  });
  assert.deepEqual(parseGatewayCommand("agent config opus-model opus"), {
    command: "agent_config",
    args: { key: "opus-model", value: "opus" },
  });
  assert.deepEqual(parseGatewayCommand("agent config opus-model sonnet"), {
    command: "agent_config",
    args: { key: "opus-model", value: "sonnet" },
  });
  assert.deepEqual(parseGatewayCommand("agent config opus-model gpt4"), {
    command: "invalid_config",
    args: {},
  });
  assert.deepEqual(parseGatewayCommand("agent thread msg_123"), {
    command: "exchange_thread",
    args: { id: "msg_123" },
  });
  assert.deepEqual(parseGatewayCommand("agent claim msg_123"), {
    command: "unknown",
    args: {},
  });
  assert.deepEqual(parseGatewayCommand("agent reply msg_123"), {
    command: "unknown",
    args: {},
  });
  assert.deepEqual(parseGatewayCommand("agent release msg_123"), {
    command: "unknown",
    args: {},
  });
  assert.deepEqual(parseGatewayCommand('agent submit --repo /repo/memory-river --request "Plan gateway core"'), {
    command: "agent_submit",
    args: { repo: "/repo/memory-river", request: "Plan gateway core" },
  });
  assert.deepEqual(parseGatewayCommand('agent submit --request "Plan gateway core" --repo /repo/memory-river'), {
    command: "agent_submit",
    args: { repo: "/repo/memory-river", request: "Plan gateway core" },
  });
  assert.deepEqual(parseGatewayCommand("agent submit --repo /repo/memory-river"), {
    command: "invalid_submit",
    args: {},
  });
  assert.deepEqual(parseGatewayCommand("agent submit /repo/memory-river Plan gateway core"), {
    command: "invalid_submit",
    args: {},
  });
});

test("gateway help returns command usage", async () => {
  const agentHome = makeAgentHome("codex-agent-gateway-help-");
  allowGatewayUser(agentHome, "user-allowed");

  const result = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: "agent help",
  });

  assert.equal(result.ok, true);
  assert.match(result.reply, /agent submit --repo/);
  assert.match(result.reply, /agent run task_/);
  const audit = readJsonl(agentPaths(agentHome).gatewayAudit);
  assert.equal(audit[0].command, "agent_help");
  assert.equal(audit[0].allowed, true);
  assert.equal(audit[0].ok, true);
});

test("gateway routes exchange ask only to enabled agents and redacts stored text", async () => {
  const agentHome = makeAgentHome("codex-agent-gateway-exchange-ask-");
  allowGatewayUser(agentHome, "user-allowed");

  const denied = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: "@opus Review this",
  });
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  const allowed = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: "@opus Review token = abcdefghijklmnopqrstuvwxyz",
  });
  const messages = readJsonl(agentPaths(agentHome).exchangeMessages);

  assert.equal(denied.ok, false);
  assert.match(denied.reply, /not enabled/);
  assert.equal(allowed.ok, true);
  assert.match(allowed.reply, /Opus[\s\S]*msg_/);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].from, "codex");
  assert.equal(messages[0].to, "opus");
  assert.equal(messages[0].channel, "telegram");
  assert.equal(messages[0].thread_id, null);
  assert.match(messages[0].text, /\[redacted:/);
  assert.equal(JSON.stringify(messages[0]).includes("abcdefghijklmnopqrstuvwxyz"), false);
});

test("gateway routes exchange shortcut ask and reads", async () => {
  const agentHome = makeAgentHome("codex-agent-gateway-exchange-shortcut-");
  allowGatewayUser(agentHome, "user-allowed");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });

  const sent = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: "@opus Review the shortcut path",
  });
  const messageId = sent.reply.match(/msg_[A-Za-z0-9_-]+/)?.[0];
  await runAgentCli(["exchange-claim", "--state", agentHome, "--id", messageId, "--agent", "opus"]);
  await runAgentCli(["exchange-reply", "--state", agentHome, "--id", messageId, "--agent", "opus", "--text", "Shortcut looks fine"]);
  const inbox = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: "@opus inbox",
  });
  const replies = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: "@codex replies",
  });
  const messages = readJsonl(agentPaths(agentHome).exchangeMessages);

  assert.equal(sent.ok, true);
  assert.match(sent.reply, /Opus[\s\S]*msg_/);
  assert.equal(messages[0].text, "Review the shortcut path");
  assert.match(inbox.reply, /Exchange inbox for opus: 0/);
  assert.match(replies.reply, /Exchange replies for codex: 1/);
  assert.match(replies.reply, /Shortcut looks fine/);
});

test("gateway @opus exchange ask triggers the runner in-process", async () => {
  const agentHome = makeAgentHome("codex-agent-gateway-runner-trigger-");
  allowGatewayUser(agentHome, "user-allowed");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  let triggeredWith = null;
  const runnerTrigger = (params) => { triggeredWith = params; };

  const result = await handleGatewayMessage({ agentHome, userId: "user-allowed", text: "@opus Review this", runnerTrigger });

  assert.equal(result.ok, true);
  assert.match(result.reply, /Opus[\s\S]*msg_/);
  assert.equal(result.runner_triggered, true);
  assert.equal(triggeredWith?.agentHome, agentHome);
});

test("gateway @opus ask still succeeds when the runner trigger throws", async () => {
  const agentHome = makeAgentHome("codex-agent-gateway-runner-trigger-fail-");
  allowGatewayUser(agentHome, "user-allowed");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  const runnerTrigger = () => { throw new Error("runner boom"); };

  const result = await handleGatewayMessage({ agentHome, userId: "user-allowed", text: "@opus Review this", runnerTrigger });

  assert.equal(result.ok, true);
  assert.match(result.reply, /Opus[\s\S]*msg_/);
  assert.equal(result.runner_triggered, false);
  assert.equal(readJsonl(agentPaths(agentHome).exchangeMessages).length, 1);
});

test("owner @opus dangerous request is declined, no task, no submit", async () => {
  const agentHome = makeAgentHome("codex-agent-gateway-opus-dangerous-");
  allowGatewayUser(agentHome, "123");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  makeOwner(agentHome, "123", "/repo/x");

  const result = await handleGatewayMessage({ agentHome, userId: "123", text: "@opus push to main", runnerTrigger: () => {} });

  assert.match(result.reply, /本機手動執行/);
  assert.equal(listTasks(agentHome).length, 0);
  assert.equal(fs.existsSync(agentPaths(agentHome).exchangeMessages), false);
});

test("owner @opus edit request (broad) creates a pending opus edit task with buttons, does not run", async () => {
  const agentHome = makeAgentHome("codex-agent-gateway-opus-edit-approve-");
  allowGatewayUser(agentHome, "123");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  makeOwner(agentHome, "123", "/repo/x");
  let ran = false;

  const result = await handleGatewayMessage({
    agentHome, userId: "123", text: "@opus 幫我重構整個 exchange 模組",
    runner: async () => { ran = true; return { text: "x", exit: 0, tokens: 1 }; },
    runnerTrigger: () => {},
  });
  const tasks = listTasks(agentHome);

  assert.equal(ran, false);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].mode, "edit");
  assert.equal(tasks[0].executor, "opus");
  assert.equal(tasks[0].approval, "pending");
  assert.match(result.reply, /待批准 edit 任務/);
  assert.deepEqual(result.reply_markup.inline_keyboard[0].map((b) => b.callback_data), [
    `owner:approve:${tasks[0].id}`,
    `owner:reject:${tasks[0].id}`,
    `owner:status:${tasks[0].id}`,
  ]);
});

test("owner @opus low-risk edit auto-approves, runs opus executor, reports", async () => {
  const agentHome = makeAgentHome("codex-agent-gateway-opus-edit-auto-");
  allowGatewayUser(agentHome, "123");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  makeOwner(agentHome, "123", "/repo/x");
  const execCalls = [];

  const result = await handleGatewayMessage({
    agentHome, userId: "123", text: "@opus fix the typo in utils.js",
    runner: async () => ({ text: "Fixed the typo.", sessionPath: null, exit: 0, tokens: 4 }),
    execFileImpl: stubEditExec({ diffStat: " utils.js | 2 +-\n", calls: execCalls }),
    runnerTrigger: () => {},
  });
  const task = listTasks(agentHome)[0];

  assert.equal(task.mode, "edit");
  assert.equal(task.executor, "opus");
  assert.equal(task.approval, "approved");
  assert.equal(task.status, "done");
  assert.equal(task.result.summary, "Fixed the typo.");
  assert.match(result.reply, /已核准並完成 edit 任務/);
  assert.match(result.reply, /utils\.js/);
});

test("@opus ack tells the truth when the runner is not ready (no false promise)", async () => {
  const agentHome = makeAgentHome("codex-agent-gateway-opus-not-ready-");
  allowGatewayUser(agentHome, "user-allowed");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  // exchange_runner_enabled defaults to false → not ready.

  const result = await handleGatewayMessage({ agentHome, userId: "user-allowed", text: "@opus review this", runnerTrigger: () => {} });

  assert.match(result.reply, /不會自動回覆/);
  assert.match(result.reply, /runner 未啟用/);
  // Message is still queued so a later-fixed config (or the timer) can pick it up.
  assert.equal(readJsonl(agentPaths(agentHome).exchangeMessages).length, 1);
});

test("owner @opus review request falls through to the read-only mailbox lane", async () => {
  const agentHome = makeAgentHome("codex-agent-gateway-opus-review-");
  allowGatewayUser(agentHome, "123");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  makeOwner(agentHome, "123", "/repo/x");

  const result = await handleGatewayMessage({ agentHome, userId: "123", text: "@opus review the latest patch", runnerTrigger: () => {} });

  assert.match(result.reply, /Opus[\s\S]*msg_/);
  assert.equal(listTasks(agentHome).length, 0);
  assert.equal(readJsonl(agentPaths(agentHome).exchangeMessages).length, 1);
});

test("non-owner @opus edit intent does not create a task (read-only lane)", async () => {
  const agentHome = makeAgentHome("codex-agent-gateway-opus-nonowner-edit-");
  allowGatewayUser(agentHome, "999");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  // owner_mode not enabled for 999 → not an owner.

  const result = await handleGatewayMessage({ agentHome, userId: "999", text: "@opus fix the bug in utils.js", runnerTrigger: () => {} });

  assert.match(result.reply, /Opus[\s\S]*msg_/);
  assert.equal(listTasks(agentHome).length, 0);
  assert.equal(readJsonl(agentPaths(agentHome).exchangeMessages).length, 1);
});

test("gateway non-opus exchange ask does not trigger the runner", async () => {
  const agentHome = makeAgentHome("codex-agent-gateway-runner-nonopus-");
  allowGatewayUser(agentHome, "user-allowed");
  enableExchangeAgent(agentHome, { agentId: "reviewbot", kind: "review" });
  let triggered = false;
  const runnerTrigger = () => { triggered = true; };

  const result = await handleGatewayMessage({ agentHome, userId: "user-allowed", text: "@reviewbot Review this", runnerTrigger });

  assert.equal(result.ok, true);
  assert.match(result.reply, /Sent exchange message msg_/);
  assert.equal(triggered, false);
  assert.equal(result.runner_triggered, null);
});

test("gateway exchange reads do not trigger the runner", async () => {
  const agentHome = makeAgentHome("codex-agent-gateway-runner-reads-");
  allowGatewayUser(agentHome, "user-allowed");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  let triggered = false;
  const runnerTrigger = () => { triggered = true; };

  await handleGatewayMessage({ agentHome, userId: "user-allowed", text: "@opus inbox", runnerTrigger });
  await handleGatewayMessage({ agentHome, userId: "user-allowed", text: "@codex replies", runnerTrigger });

  assert.equal(triggered, false);
});

test("gateway denied user @opus ask does not trigger the runner or submit", async () => {
  const agentHome = makeAgentHome("codex-agent-gateway-runner-denied-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  let triggered = false;
  const runnerTrigger = () => { triggered = true; };

  const result = await handleGatewayMessage({ agentHome, userId: "user-denied", text: "@opus Review this", runnerTrigger });

  assert.equal(result.allowed, false);
  assert.equal(triggered, false);
  assert.equal(fs.existsSync(agentPaths(agentHome).exchangeMessages), false);
});

test("gateway rejects exchange ask to reserved any target even when enabled", async () => {
  const agentHome = makeAgentHome("codex-agent-gateway-exchange-ask-any-");
  allowGatewayUser(agentHome, "user-allowed");
  enableExchangeAgent(agentHome, { agentId: "any", kind: "broadcast" });

  const result = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: 'agent ask any --text "broadcast"',
  });

  assert.equal(result.ok, false);
  assert.equal(result.command, "unknown");
  assert.equal(fs.existsSync(agentPaths(agentHome).exchangeMessages), false);
});

test("gateway routes exchange inbox replies and thread without mutating ledgers", async () => {
  const agentHome = makeAgentHome("codex-agent-gateway-exchange-read-");
  allowGatewayUser(agentHome, "user-allowed");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  const sent = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: "@opus Review mailbox",
  });
  const messageId = sent.reply.match(/msg_[A-Za-z0-9_-]+/)?.[0];
  await runAgentCli(["exchange-claim", "--state", agentHome, "--id", messageId, "--agent", "opus"]);
  await runAgentCli(["exchange-reply", "--state", agentHome, "--id", messageId, "--agent", "opus", "--text", "No findings"]);
  const paths = agentPaths(agentHome);
  const before = {
    messages: readJsonl(paths.exchangeMessages),
    claims: readJsonl(paths.exchangeClaims),
    replies: readJsonl(paths.exchangeReplies),
  };

  const inbox = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: "@opus inbox",
  });
  const replies = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: "@codex replies",
  });
  const thread = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: `agent thread ${messageId}`,
  });
  const after = {
    messages: readJsonl(paths.exchangeMessages),
    claims: readJsonl(paths.exchangeClaims),
    replies: readJsonl(paths.exchangeReplies),
  };

  assert.match(inbox.reply, /Exchange inbox for opus: 0/);
  assert.match(replies.reply, /Exchange replies for codex: 1/);
  assert.match(replies.reply, /No findings/);
  assert.match(thread.reply, /Exchange thread msg_/);
  assert.match(thread.reply, /replies=1/);
  assert.deepEqual(after, before);
});

test("gateway exchange reads work for unenabled agent names", async () => {
  const agentHome = makeAgentHome("codex-agent-gateway-exchange-unenabled-read-");
  allowGatewayUser(agentHome, "user-allowed");

  const inbox = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: "@opus inbox",
  });
  const replies = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: "@codex replies",
  });

  assert.equal(inbox.ok, true);
  assert.match(inbox.reply, /Exchange inbox for opus: 0/);
  assert.equal(replies.ok, true);
  assert.match(replies.reply, /Exchange replies for codex: 0/);
});

test("gateway exchange listings with secret-like content are withheld", async () => {
  const agentHome = makeAgentHome("codex-agent-gateway-exchange-secret-list-");
  allowGatewayUser(agentHome, "user-allowed");
  writeJsonl(agentPaths(agentHome).exchangeMessages, [
    {
      id: "msg_secret",
      from: "codex",
      to: "opus",
      text: "token = abcdefghijklmnopqrstuvwxyz",
      created_at: new Date().toISOString(),
    },
  ]);

  const inbox = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: "@opus inbox",
  });
  const thread = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: "agent thread msg_secret",
  });

  assert.equal(inbox.reply, "Response withheld because it may contain a secret.");
  assert.equal(thread.reply, "Response withheld because it may contain a secret.");
});

test("gateway exchange listings cap entry counts and line lengths", async () => {
  const agentHome = makeAgentHome("codex-agent-gateway-exchange-truncate-");
  allowGatewayUser(agentHome, "user-allowed");
  const longText = "review ".repeat(80).trim();
  const messages = Array.from({ length: 7 }, (_, index) => ({
    id: `msg_long_${index}`,
    from: "codex",
    to: "opus",
    text: longText,
    created_at: new Date().toISOString(),
  }));
  const replies = Array.from({ length: 5 }, (_, index) => ({
    id: `xreply_long_${index}`,
    message_id: "msg_long_0",
    agent_id: "opus",
    text: longText,
    created_at: new Date().toISOString(),
  }));
  writeJsonl(agentPaths(agentHome).exchangeMessages, messages);
  writeJsonl(agentPaths(agentHome).exchangeReplies, replies);

  const inbox = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: "@opus inbox",
  });
  const thread = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: "agent thread msg_long_0",
  });

  assert.equal(inbox.reply.split("\n").length, 6);
  assert.equal(thread.reply.split("\n").length, 7);
  assert.match(inbox.reply, /\.\.\./);
  assert.match(thread.reply, /\.\.\./);
});

test("gateway denies non-allowlisted users and audits the attempt", async () => {
  const agentHome = makeAgentHome("codex-agent-gateway-deny-");

  const result = await handleGatewayMessage({
    agentHome,
    userId: "user-denied",
    text: "agent submit --repo /repo/memory-river --request denied",
  });
  const audit = readJsonl(agentPaths(agentHome).gatewayAudit);

  assert.equal(result.allowed, false);
  assert.equal(result.ok, false);
  assert.equal(result.reply, "Access denied.");
  assert.equal(fs.existsSync(agentPaths(agentHome).tasksDir), false);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].allowed, false);
  assert.equal(audit[0].command, "agent_submit");
  assert.equal(audit[0].text, undefined);
  assert.ok(audit[0].text_hash);
});

test("gateway denies empty user ids and audits the attempt", async () => {
  const agentHome = makeAgentHome("codex-agent-gateway-empty-user-");

  const result = await handleGatewayMessage({
    agentHome,
    userId: "",
    text: "agent status",
  });
  const audit = readJsonl(agentPaths(agentHome).gatewayAudit);

  assert.equal(result.allowed, false);
  assert.equal(result.ok, false);
  assert.equal(result.reply, "Access denied.");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].user_id, "");
});

test("gateway denied users cannot run queued tasks", async () => {
  const agentHome = makeAgentHome("codex-agent-gateway-deny-run-");
  const memoryStateHome = makeMemoryState("codex-agent-gateway-deny-run-memory-");
  allowGatewayUser(agentHome, "user-allowed");
  const submitted = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: 'agent submit --repo /repo/memory-river --request "Plan denied run"',
  });
  let invoked = false;

  const result = await handleGatewayMessage({
    agentHome,
    userId: "user-denied",
    text: `agent run ${submitted.task_id}`,
    memoryStateHome,
    runner: async () => {
      invoked = true;
      return { text: "should not run", sessionPath: null, exit: 0, tokens: 5 };
    },
  });
  const audit = readJsonl(agentPaths(agentHome).gatewayAudit);
  const status = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: "agent status",
  });

  assert.equal(invoked, false);
  assert.equal(result.allowed, false);
  assert.equal(result.ok, false);
  assert.equal(result.reply, "Access denied.");
  assert.equal(audit[1].allowed, false);
  assert.equal(audit[1].command, "agent_run");
  assert.match(status.reply, /queued=1/);
});

test("gateway allows submitted plan tasks for allowlisted users", async () => {
  const agentHome = makeAgentHome("codex-agent-gateway-submit-");
  allowGatewayUser(agentHome, "user-allowed");

  const result = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: 'agent submit --repo /repo/memory-river --request "Plan gateway core"',
  });
  const audit = readJsonl(agentPaths(agentHome).gatewayAudit);

  assert.equal(result.allowed, true);
  assert.equal(result.ok, true);
  assert.match(result.reply, /Submitted plan task task_/);
  assert.ok(result.task_id);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].allowed, true);
  assert.equal(audit[0].task_id, result.task_id);
});

test("gateway run advances queued plan tasks for allowlisted users", async () => {
  const agentHome = makeAgentHome("codex-agent-gateway-run-");
  const memoryStateHome = makeMemoryState("codex-agent-gateway-run-memory-");
  allowGatewayUser(agentHome, "user-allowed");
  const submitted = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: 'agent submit --repo /repo/memory-river --request "Plan gateway run"',
  });
  // Gateway submissions are pending; an explicit approve is required before run.
  await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: `agent approve ${submitted.task_id}`,
  });

  const result = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: `agent run ${submitted.task_id}`,
    memoryStateHome,
    runner: async () => ({ text: "planned from gateway", sessionPath: null, exit: 0, tokens: 5 }),
  });
  const audit = readJsonl(agentPaths(agentHome).gatewayAudit);

  assert.equal(result.allowed, true);
  assert.equal(result.ok, true);
  assert.equal(result.command, "agent_run");
  assert.match(result.reply, /Run: advanced=1/);
  assert.match(result.reply, /done=1/);
  assert.equal(audit.length, 3);
  assert.equal(audit[2].command, "agent_run");
  assert.equal(audit[2].task_id, submitted.task_id);
});

test("gateway run advances only the requested task", async () => {
  const agentHome = makeAgentHome("codex-agent-gateway-run-scoped-");
  const memoryStateHome = makeMemoryState("codex-agent-gateway-run-scoped-memory-");
  allowGatewayUser(agentHome, "user-allowed");
  const first = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: 'agent submit --repo /repo/memory-river --request "Plan target"',
  });
  const second = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: 'agent submit --repo /repo/memory-river --request "Plan competitor"',
  });
  await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: `agent approve ${first.task_id}`,
  });
  await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: `agent approve ${second.task_id}`,
  });

  const result = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: `agent run ${first.task_id}`,
    memoryStateHome,
    runner: async () => ({ text: "target plan", sessionPath: null, exit: 0, tokens: 5 }),
  });
  const tasks = listTasks(agentHome);
  const target = tasks.find((entry) => entry.id === first.task_id);
  const competitor = tasks.find((entry) => entry.id === second.task_id);

  assert.equal(result.ok, true);
  assert.equal(result.task_id, first.task_id);
  assert.match(result.reply, /advanced=1/);
  assert.equal(target.status, "done");
  assert.equal(competitor.status, "queued");
  assert.equal(competitor.approval, "approved");
});

test("gateway run requires a task id and does not sweep queued tasks", async () => {
  const agentHome = makeAgentHome("codex-agent-gateway-run-require-id-");
  const memoryStateHome = makeMemoryState("codex-agent-gateway-run-require-id-memory-");
  allowGatewayUser(agentHome, "user-allowed");
  const submitted = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: 'agent submit --repo /repo/memory-river --request "Plan no sweep"',
  });
  await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: `agent approve ${submitted.task_id}`,
  });
  let invoked = false;

  const result = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: "agent run",
    memoryStateHome,
    runner: async () => { invoked = true; return { text: "should not run", sessionPath: null, exit: 0, tokens: 1 }; },
  });
  const task = listTasks(agentHome).find((entry) => entry.id === submitted.task_id);

  assert.equal(result.ok, false);
  assert.equal(result.command, "invalid_run");
  assert.match(result.reply, /Usage: agent run task_id/);
  assert.equal(invoked, false);
  assert.equal(task.status, "queued");
  assert.equal(task.approval, "approved");
});

test("gateway run respects the kill switch", async () => {
  const agentHome = makeAgentHome("codex-agent-gateway-run-kill-");
  const memoryStateHome = makeMemoryState("codex-agent-gateway-run-kill-memory-");
  allowGatewayUser(agentHome, "user-allowed");
  const submitted = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: 'agent submit --repo /repo/memory-river --request "Plan parked run"',
  });
  await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: `agent approve ${submitted.task_id}`,
  });
  setKillSwitch(agentHome, true);

  const result = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: `agent run ${submitted.task_id}`,
    memoryStateHome,
    runner: async () => {
      throw new Error("runner should not be invoked");
    },
  });
  const status = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: "agent status",
  });

  assert.equal(result.ok, true);
  assert.match(result.reply, /advanced=0/);
  assert.match(result.reply, /queued=1/);
  assert.match(result.reply, /kill_switch=true/);
  assert.match(status.reply, /queued=1/);
});

test("gateway run respects the daily token budget", async () => {
  const agentHome = makeAgentHome("codex-agent-gateway-run-budget-");
  const memoryStateHome = makeMemoryState("codex-agent-gateway-run-budget-memory-");
  allowGatewayUser(agentHome, "user-allowed");
  const submitted = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: 'agent submit --repo /repo/memory-river --request "Plan budget run"',
  });
  await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: `agent approve ${submitted.task_id}`,
  });
  setDailyTokenBudget(agentHome, 0);

  const result = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: `agent run ${submitted.task_id}`,
    memoryStateHome,
    runner: async () => {
      throw new Error("runner should not be invoked");
    },
  });

  assert.equal(result.ok, true);
  assert.match(result.reply, /advanced=0/);
  assert.match(result.reply, /queued=1/);
  assert.match(result.reply, /remaining_tokens=0/);
});

test("gateway approves and rejects tasks without exposing request text", async () => {
  const agentHome = makeAgentHome("codex-agent-gateway-approval-");
  allowGatewayUser(agentHome, "user-allowed");
  const approveTask = fakeTask({ id: "task_gateway_approve", request: "Plan approval flow" });
  const rejectTask = fakeTask({ id: "task_gateway_reject", request: "Plan approval flow" });
  writeTask(agentHome, approveTask);
  writeTask(agentHome, rejectTask);

  const approved = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: `agent approve ${approveTask.id}`,
  });
  const rejected = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: `agent reject ${rejectTask.id}`,
  });
  const audit = readJsonl(agentPaths(agentHome).gatewayAudit);

  assert.equal(approved.ok, true);
  assert.match(approved.reply, /Approved task task_/);
  assert.doesNotMatch(approved.reply, /Plan approval flow/);
  assert.equal(rejected.ok, true);
  assert.match(rejected.reply, /Rejected task task_/);
  assert.doesNotMatch(rejected.reply, /Plan approval flow/);
  assert.equal(audit[0].command, "agent_approve");
  assert.equal(audit[0].task_id, approveTask.id);
  assert.equal(audit[1].command, "agent_reject");
  assert.equal(audit[1].task_id, rejectTask.id);
});

test("gateway denied users cannot approve or reject tasks", async () => {
  const agentHome = makeAgentHome("codex-agent-gateway-deny-approval-");
  allowGatewayUser(agentHome, "user-allowed");
  const task = fakeTask({ id: "task_gateway_denied_approval", request: "Plan denied approval" });
  writeTask(agentHome, task);

  const deniedApprove = await handleGatewayMessage({
    agentHome,
    userId: "user-denied",
    text: `agent approve ${task.id}`,
  });
  const deniedReject = await handleGatewayMessage({
    agentHome,
    userId: "user-denied",
    text: `agent reject ${task.id}`,
  });
  const status = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: `agent status ${task.id}`,
  });

  assert.equal(deniedApprove.allowed, false);
  assert.equal(deniedApprove.ok, false);
  assert.equal(deniedReject.allowed, false);
  assert.equal(deniedReject.ok, false);
  assert.match(status.reply, /queued/);
});

test("gateway failed approve attempts are audited", async () => {
  const agentHome = makeAgentHome("codex-agent-gateway-invalid-approval-");
  allowGatewayUser(agentHome, "user-allowed");
  const task = fakeTask({
    id: "task_gateway_invalid_approval",
    request: "Plan invalid approval",
  });
  task.approval = "not_required";
  writeTask(agentHome, task);

  const result = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: `agent approve ${task.id}`,
  });
  const audit = readJsonl(agentPaths(agentHome).gatewayAudit);

  assert.equal(result.allowed, true);
  assert.equal(result.ok, false);
  assert.equal(result.reply, "Command failed.");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].command, "agent_approve");
  assert.equal(audit[0].allowed, true);
  assert.equal(audit[0].ok, false);
  assert.equal(audit[0].task_id, null);
});

test("gateway status returns summaries without raw run logs", async () => {
  const agentHome = makeAgentHome("codex-agent-gateway-status-");
  allowGatewayUser(agentHome, "user-allowed");
  await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: 'agent submit --repo /repo/memory-river --request "Plan gateway status"',
  });

  const result = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: "agent status",
  });

  assert.equal(result.ok, true);
  assert.match(result.reply, /Tasks: 1/);
  assert.match(result.reply, /queued=1/);
  assert.doesNotMatch(result.reply, /Plan gateway status/);
});

test("gateway command failures are safe and audited", async () => {
  const agentHome = makeAgentHome("codex-agent-gateway-error-audit-");
  allowGatewayUser(agentHome, "user-allowed");

  const result = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: "agent status task_does_not_exist",
  });
  const audit = readJsonl(agentPaths(agentHome).gatewayAudit);

  assert.equal(result.allowed, true);
  assert.equal(result.ok, false);
  assert.equal(result.reply, "Command failed.");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].allowed, true);
  assert.equal(audit[0].ok, false);
  assert.equal(audit[0].command, "agent_status");
});

test("gateway invalid submit does not mutate task state", async () => {
  const agentHome = makeAgentHome("codex-agent-gateway-invalid-submit-");
  allowGatewayUser(agentHome, "user-allowed");

  const result = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: "agent submit --repo /repo/memory-river",
  });

  assert.equal(result.allowed, true);
  assert.equal(result.ok, false);
  assert.equal(result.command, "invalid_submit");
  assert.equal(fs.existsSync(agentPaths(agentHome).tasksDir), false);
});

test("gateway CLI manages allowlist and dispatches local text commands", async () => {
  const agentHome = makeAgentHome("codex-agent-gateway-cli-");
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));

  try {
    await runAgentCli(["allow-user", "--state", agentHome, "--user", "user-cli"]);
    await runAgentCli(["gateway", "--state", agentHome, "--from", "user-cli", "--text", "agent status"]);
    await runAgentCli(["deny-user", "--state", agentHome, "--user", "user-cli"]);
    await runAgentCli(["gateway", "--state", agentHome, "--from", "user-cli", "--text", "agent status"]);
  } finally {
    console.log = originalLog;
  }

  const allowed = JSON.parse(lines[1]);
  const denied = JSON.parse(lines[3]);

  assert.equal(allowed.allowed, true);
  assert.equal(allowed.ok, true);
  assert.equal(denied.allowed, false);
});

test("gateway egress withholds secret-like replies", () => {
  assert.equal(
    safeGatewayReply("token = sk-123456789012345678901234567890"),
    "Response withheld because it may contain a secret.",
  );
});

// M2: gateway submissions are pending and require an explicit approve; a
// gateway-allowlisted user cannot submit + run to bypass approval.
test("gateway submit creates a pending task that requires approval", async () => {
  const agentHome = makeAgentHome("codex-agent-gateway-submit-pending-");
  allowGatewayUser(agentHome, "user-allowed");

  const result = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: 'agent submit --repo /repo/memory-river --request "Plan pending submit"',
  });
  const tasks = listTasks(agentHome);

  assert.equal(result.ok, true);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].approval, "pending");
  assert.match(result.reply, /approval: pending/);
});

test("gateway run does not advance a pending submitted task (no approval bypass)", async () => {
  const agentHome = makeAgentHome("codex-agent-gateway-run-pending-");
  const memoryStateHome = makeMemoryState("codex-agent-gateway-run-pending-memory-");
  allowGatewayUser(agentHome, "user-allowed");
  const submitted = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: 'agent submit --repo /repo/memory-river --request "Plan no bypass"',
  });
  let invoked = false;

  const result = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: `agent run ${submitted.task_id}`,
    memoryStateHome,
    runner: async () => { invoked = true; return { text: "should not run", sessionPath: null, exit: 0, tokens: 1 }; },
  });
  const task = listTasks(agentHome).find((entry) => entry.id === submitted.task_id);

  assert.equal(invoked, false);
  assert.match(result.reply, /advanced=0/);
  assert.equal(task.status, "queued");
  assert.equal(task.approval, "pending");
});

// M3: gateway run with no injected runner must use the real Codex plan runner,
// not worker.js's fakeRunner.
test("gateway run with no injected runner uses the real plan runner, not fakeRunner", async () => {
  const agentHome = makeAgentHome("codex-agent-gateway-run-realrunner-");
  const memoryStateHome = makeMemoryState("codex-agent-gateway-run-realrunner-memory-");
  allowGatewayUser(agentHome, "user-allowed");
  const submitted = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: 'agent submit --repo /repo/memory-river --request "Plan real runner"',
  });
  await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: `agent approve ${submitted.task_id}`,
  });

  const result = await handleGatewayMessage({
    agentHome,
    userId: "user-allowed",
    text: `agent run ${submitted.task_id}`,
    memoryStateHome,
    // No runner injected: must fall back to realPlanRunner, driven here by a fake
    // codex exec rather than worker.js's fakeRunner.
    execFileImpl: fakeCodexExec("GATEWAY_REAL_PLAN_OUTPUT"),
  });
  const task = listTasks(agentHome).find((entry) => entry.id === submitted.task_id);

  assert.match(result.reply, /advanced=1/);
  assert.equal(task.status, "done");
  assert.equal(task.result.summary, "GATEWAY_REAL_PLAN_OUTPUT");
  assert.equal(task.result.summary.includes("smallest scoped change"), false);
});

function fakeCodexExec(planText) {
  return (file, args, options, callback) => {
    const outIndex = args.indexOf("-o");
    const outFile = outIndex >= 0 ? args[outIndex + 1] : null;
    if (outFile) {
      fs.writeFileSync(outFile, planText);
    }
    callback(null, "tokens used 5\n", "");
    return { stdin: { on() {}, write() {}, end() {} } };
  };
}

function makeAgentHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeOwner(agentHome, userId, repo) {
  setTelegramCodexPolicy(agentHome, {
    direct_send_enabled: true,
    direct_send_user_add: userId,
    owner_mode_enabled: true,
    default_repo: repo,
  });
}

// Stubs git + npm for runEditTask without a real repo: stable HEAD (no commit),
// a canned diff stat, and a passing verify command.
function stubEditExec({ diffStat = "", verifyExit = 0, calls = [] } = {}) {
  return (file, args, options, callback) => {
    calls.push({ file, args });
    const a = args.join(" ");
    if (file === "git" && a === "rev-parse HEAD") { callback(null, "hash1\n", ""); }
    else if (file === "git" && a === "diff HEAD --stat") { callback(null, diffStat, ""); }
    else if (file === "npm" && a === "test") {
      callback(verifyExit === 0 ? null : Object.assign(new Error("npm test failed"), { code: verifyExit }), "ok\n", "");
    } else { callback(null, "", ""); }
    return { stdin: { on() {}, write() {}, end() {} } };
  };
}

function makeMemoryState(prefix) {
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  writeJsonl(statePaths(stateHome).memories, [{
    id: "mem_gateway_context",
    scope: "repo:/repo/memory-river",
    type: "workflow_rule",
    content: "Gateway run tests should use memory context.",
    status: "active",
    confidence: "high",
    evidence: ["/tmp/session.jsonl:1"],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    supersedes: [],
    superseded_by: null,
    tags: [],
  }]);
  writeJsonl(statePaths(stateHome).chunks, []);
  return stateHome;
}

function fakeTask({ id, request }) {
  const now = new Date().toISOString();
  return {
    id,
    source: "test",
    requester: "local",
    repo: "/repo/memory-river",
    request,
    mode: "plan",
    status: "queued",
    approval: "pending",
    worktree: null,
    attempts: 0,
    max_attempts: 2,
    cost: { tokens: 0, usd_estimate: 0 },
    created_at: now,
    updated_at: now,
    history: [{ ts: now, state: "queued", note: "Task submitted.", codex_session: null }],
    result: { summary: null, diff_ref: null, tests: null, artifacts: [] },
  };
}
