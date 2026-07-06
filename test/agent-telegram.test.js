import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgentCli } from "../src/agent/cli.js";
import { getTelegramCodexPolicy, setTelegramCodexPolicy } from "../src/agent/safety.js";
import { parseCodexTokenUsage, realCodexRunner, realEditRunner } from "../src/agent/codex-runner.js";
import { createTelegramRequest, handleTelegramUpdate, parseTelegramUpdateJson, pollTelegramOnce } from "../src/agent/telegram.js";
import { agentPaths } from "../src/agent/paths.js";
import { allowGatewayUser, enableExchangeAgent, setDailyTokenBudget, setKillSwitch, writeAgentConfig } from "../src/agent/safety.js";
import { writeTask } from "../src/agent/tasks.js";
import { createDispatchApproval, listDispatchApprovals } from "../src/agent/dispatch.js";
import { readJsonl, writeJsonl } from "../src/lib/jsonl.js";

test("telegram adapter maps allowed updates to gateway replies", async () => {
  const agentHome = makeAgentHome("codex-agent-telegram-allowed-");
  allowGatewayUser(agentHome, "123");

  const result = await handleTelegramUpdate({
    agentHome,
    update: telegramUpdate({ fromId: 123, chatId: 456, text: "agent status" }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.gateway.allowed, true);
  assert.deepEqual(result.payload, {
    method: "sendMessage",
    chat_id: 456,
    text: "Tasks: 0 queued=0 done=0 failed=0 runs=0 kill_switch=false remaining_tokens=20000",
  });
});

test("telegram adapter denies non-allowlisted Telegram users", async () => {
  const agentHome = makeAgentHome("codex-agent-telegram-denied-");

  const result = await handleTelegramUpdate({
    agentHome,
    update: telegramUpdate({
      fromId: 999,
      chatId: 456,
      text: 'agent submit --repo /repo/memory-river --request "Denied submit"',
    }),
  });
  const audit = readJsonl(agentPaths(agentHome).gatewayAudit);

  assert.equal(result.ok, true);
  assert.equal(result.gateway.allowed, false);
  assert.equal(result.payload.text, "Access denied.");
  assert.equal(audit[0].user_id, "999");
  assert.equal(fs.existsSync(agentPaths(agentHome).tasksDir), false);
});

test("telegram adapter keeps chat id separate from allowlisted user id", async () => {
  const agentHome = makeAgentHome("codex-agent-telegram-chat-user-");
  allowGatewayUser(agentHome, "123");

  const result = await handleTelegramUpdate({
    agentHome,
    update: telegramUpdate({ fromId: 123, chatId: -456, text: "agent status" }),
  });

  assert.equal(result.gateway.allowed, true);
  assert.equal(result.payload.chat_id, -456);
});
test("telegram adapter submits plan tasks through gateway core", async () => {
  const agentHome = makeAgentHome("codex-agent-telegram-submit-");
  allowGatewayUser(agentHome, "123");

  const result = await handleTelegramUpdate({
    agentHome,
    update: telegramUpdate({
      fromId: 123,
      chatId: 456,
      text: 'agent submit --repo /repo/memory-river --request "Plan Telegram adapter"',
    }),
  });

  assert.equal(result.gateway.ok, true);
  assert.match(result.payload.text, /Submitted plan task task_/);
  assert.equal(fs.readdirSync(agentPaths(agentHome).tasksDir).length, 1);
});

test("telegram adapter runs queued plan tasks through gateway core", async () => {
  const agentHome = makeAgentHome("codex-agent-telegram-run-");
  const memoryStateHome = undefined;
  allowGatewayUser(agentHome, "123");
  const submitted = await handleTelegramUpdate({
    agentHome,
    update: telegramUpdate({
      fromId: 123,
      chatId: 456,
      text: 'agent submit --repo /repo/memory-river --request "Plan Telegram run"',
    }),
  });
  // Gateway submissions are pending; an explicit approve is required before run.
  await handleTelegramUpdate({
    agentHome,
    update: telegramUpdate({ fromId: 123, chatId: 456, text: `agent approve ${submitted.gateway.task_id}` }),
  });

  const result = await handleTelegramUpdate({
    agentHome,
    update: telegramUpdate({ fromId: 123, chatId: 456, text: `agent run ${submitted.gateway.task_id}` }),
    memoryStateHome,
    runner: async () => ({ text: "planned from Telegram", sessionPath: null, exit: 0, tokens: 5 }),
  });

  assert.equal(result.gateway.ok, true);
  assert.match(result.payload.text, /Run: advanced=1/);
  assert.match(result.payload.text, /done=1/);
});

test("telegram adapter approves and rejects through gateway core", async () => {
  const agentHome = makeAgentHome("codex-agent-telegram-approval-");
  allowGatewayUser(agentHome, "123");
  const approveTask = fakeTask({ id: "task_telegram_approve", request: "Plan Telegram approval" });
  const rejectTask = fakeTask({ id: "task_telegram_reject", request: "Plan Telegram approval" });
  writeTask(agentHome, approveTask);
  writeTask(agentHome, rejectTask);

  const approved = await handleTelegramUpdate({
    agentHome,
    update: telegramUpdate({ fromId: 123, chatId: 456, text: `agent approve ${approveTask.id}` }),
  });
  const rejected = await handleTelegramUpdate({
    agentHome,
    update: telegramUpdate({ fromId: 123, chatId: 456, text: `agent reject ${rejectTask.id}` }),
  });

  assert.equal(approved.gateway.ok, true);
  assert.match(approved.payload.text, /Approved task task_/);
  assert.doesNotMatch(approved.payload.text, /Plan Telegram approval/);
  assert.equal(rejected.gateway.ok, true);
  assert.match(rejected.payload.text, /Rejected task task_/);
  assert.doesNotMatch(rejected.payload.text, /Plan Telegram approval/);
});

test("telegram adapter routes exchange ask through gateway core", async () => {
  const agentHome = makeAgentHome("codex-agent-telegram-exchange-ask-");
  allowGatewayUser(agentHome, "123");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });

  const result = await handleTelegramUpdate({
    agentHome,
    update: telegramUpdate({
      fromId: 123,
      chatId: 456,
      text: "@opus Review from Telegram",
    }),
  });
  const messages = readJsonl(agentPaths(agentHome).exchangeMessages);

  assert.equal(result.gateway.ok, true);
  assert.equal(result.gateway.command, "exchange_ask");
  assert.match(result.payload.text, /Sonnet 4\.6[\s\S]*msg_/);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].from, "codex");
  assert.equal(messages[0].to, "opus");
  assert.equal(messages[0].channel, "telegram");
});

test("telegram adapter routes exchange shortcut ask through gateway core", async () => {
  const agentHome = makeAgentHome("codex-agent-telegram-exchange-shortcut-ask-");
  allowGatewayUser(agentHome, "123");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });

  const mention = await handleTelegramUpdate({
    agentHome,
    update: telegramUpdate({ fromId: 123, chatId: 456, text: "@opus Review from shortcut" }),
  });
  const colon = await handleTelegramUpdate({
    agentHome,
    update: telegramUpdate({ fromId: 123, chatId: 456, text: "opus: Review from colon shortcut" }),
  });
  const messages = readJsonl(agentPaths(agentHome).exchangeMessages);

  assert.equal(mention.gateway.ok, true);
  assert.equal(mention.gateway.command, "exchange_ask");
  assert.match(mention.payload.text, /Sonnet 4\.6[\s\S]*msg_/);
  assert.equal(colon.gateway.ok, true);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].to, "opus");
  assert.equal(messages[0].text, "Review from shortcut");
  assert.equal(messages[1].text, "Review from colon shortcut");
});

test("telegram adapter routes @claude as an alias for the Opus mailbox", async () => {
  const agentHome = makeAgentHome("codex-agent-telegram-exchange-claude-alias-");
  allowGatewayUser(agentHome, "123");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });

  const result = await handleTelegramUpdate({
    agentHome,
    update: telegramUpdate({ fromId: 123, chatId: 456, text: "@claude Review from Claude alias" }),
  });
  const messages = readJsonl(agentPaths(agentHome).exchangeMessages);

  assert.equal(result.gateway.ok, true);
  assert.equal(result.gateway.command, "exchange_ask");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].to, "opus");
  assert.equal(messages[0].text, "Review from Claude alias");
});
test("telegram adapter denies non-allowlisted users on exchange shortcuts", async () => {
  const agentHome = makeAgentHome("codex-agent-telegram-exchange-shortcut-denied-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });

  const result = await handleTelegramUpdate({
    agentHome,
    update: telegramUpdate({ fromId: 999, chatId: 456, text: "@opus Review from denied user" }),
  });
  const audit = readJsonl(agentPaths(agentHome).gatewayAudit);

  assert.equal(result.gateway.ok, false);
  assert.equal(result.payload.text, "Access denied.");
  assert.equal(audit[0].command, "exchange_ask");
  assert.equal(audit[0].allowed, false);
  assert.equal(fs.existsSync(agentPaths(agentHome).exchangeMessages), false);
});

test("telegram adapter routes enabled non-canonical shortcut agents", async () => {
  const agentHome = makeAgentHome("codex-agent-telegram-exchange-shortcut-enabled-");
  allowGatewayUser(agentHome, "123");
  enableExchangeAgent(agentHome, { agentId: "mill", kind: "review" });

  const result = await handleTelegramUpdate({
    agentHome,
    update: telegramUpdate({ fromId: 123, chatId: 456, text: "mill: Review enabled shortcut" }),
  });
  const messages = readJsonl(agentPaths(agentHome).exchangeMessages);

  assert.equal(result.gateway.ok, true);
  assert.equal(result.gateway.command, "exchange_ask");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].to, "mill");
  assert.equal(messages[0].text, "Review enabled shortcut");
});

test("telegram adapter routes exchange read commands through gateway core", async () => {
  const agentHome = makeAgentHome("codex-agent-telegram-exchange-read-");
  allowGatewayUser(agentHome, "123");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  const ask = await handleTelegramUpdate({
    agentHome,
    update: telegramUpdate({ fromId: 123, chatId: 456, text: "@opus Review from Telegram" }),
  });
  const messageId = ask.payload.text.match(/msg_[A-Za-z0-9_-]+/)?.[0];
  await runAgentCli(["exchange-claim", "--state", agentHome, "--id", messageId, "--agent", "opus"]);
  await runAgentCli(["exchange-reply", "--state", agentHome, "--id", messageId, "--agent", "opus", "--text", "No findings"]);

  const inbox = await handleTelegramUpdate({
    agentHome,
    update: telegramUpdate({ fromId: 123, chatId: 456, text: "@opus inbox" }),
  });
  const replies = await handleTelegramUpdate({
    agentHome,
    update: telegramUpdate({ fromId: 123, chatId: 456, text: "@codex replies" }),
  });
  const thread = await handleTelegramUpdate({
    agentHome,
    update: telegramUpdate({ fromId: 123, chatId: 456, text: `agent thread ${messageId}` }),
  });

  assert.equal(inbox.gateway.ok, true);
  assert.match(inbox.payload.text, /Exchange inbox for opus: 0/);
  assert.equal(replies.gateway.ok, true);
  assert.match(replies.payload.text, /Exchange replies for codex: 1/);
  assert.match(replies.payload.text, /No findings/);
  assert.equal(thread.gateway.ok, true);
  assert.match(thread.payload.text, /Exchange thread msg_/);
  assert.match(thread.payload.text, /replies=1/);
});

test("telegram adapter routes exchange shortcut reads through gateway core", async () => {
  const agentHome = makeAgentHome("codex-agent-telegram-exchange-shortcut-read-");
  allowGatewayUser(agentHome, "123");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  const ask = await handleTelegramUpdate({
    agentHome,
    update: telegramUpdate({ fromId: 123, chatId: 456, text: "@opus Review shortcut reads" }),
  });
  const messageId = ask.payload.text.match(/msg_[A-Za-z0-9_-]+/)?.[0];
  await runAgentCli(["exchange-claim", "--state", agentHome, "--id", messageId, "--agent", "opus"]);
  await runAgentCli(["exchange-reply", "--state", agentHome, "--id", messageId, "--agent", "opus", "--text", "Shortcut read ok"]);

  const inbox = await handleTelegramUpdate({
    agentHome,
    update: telegramUpdate({ fromId: 123, chatId: 456, text: "@opus inbox" }),
  });
  const replies = await handleTelegramUpdate({
    agentHome,
    update: telegramUpdate({ fromId: 123, chatId: 456, text: "@codex replies" }),
  });

  assert.equal(inbox.gateway.ok, true);
  assert.match(inbox.payload.text, /Exchange inbox for opus: 0/);
  assert.equal(replies.gateway.ok, true);
  assert.match(replies.payload.text, /Exchange replies for codex: 1/);
  assert.match(replies.payload.text, /Shortcut read ok/);
});

test("telegram adapter ignores malformed or unsupported updates", async () => {
  const agentHome = makeAgentHome("codex-agent-telegram-malformed-");

  for (const update of [null, 5, []]) {
    assert.deepEqual(await handleTelegramUpdate({ agentHome, update }), {
      ok: false,
      payload: null,
      reason: "unsupported_update",
    });
  }
  assert.deepEqual(await handleTelegramUpdate({ agentHome, update: {} }), {
    ok: false,
    payload: null,
    reason: "unsupported_update",
  });
  assert.deepEqual(await handleTelegramUpdate({
    agentHome,
    update: { message: { from: { id: 123 }, chat: { id: 456 } } },
  }), {
    ok: false,
    payload: null,
    reason: "unsupported_update",
  });
  assert.deepEqual(await handleTelegramUpdate({
    agentHome,
    update: { edited_message: { from: { id: 123 }, chat: { id: 456 }, text: "agent status" } },
  }), {
    ok: false,
    payload: null,
    reason: "unsupported_update",
  });
  assert.deepEqual(await handleTelegramUpdate({
    agentHome,
    update: { channel_post: { chat: { id: 456 }, text: "agent status" } },
  }), {
    ok: false,
    payload: null,
    reason: "unsupported_update",
  });
});

test("telegram update JSON parser reports invalid JSON", () => {
  assert.deepEqual(parseTelegramUpdateJson('{"message":{"text":"agent status"}}'), {
    message: { text: "agent status" },
  });
  assert.throws(
    () => parseTelegramUpdateJson("{not json"),
    /Invalid Telegram update JSON/,
  );
});

test("telegram CLI smoke returns sendMessage payload", async () => {
  const agentHome = makeAgentHome("codex-agent-telegram-cli-");
  allowGatewayUser(agentHome, "123");
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));

  try {
    await runAgentCli([
      "telegram-update",
      "--state",
      agentHome,
      "--update-json",
      JSON.stringify(telegramUpdate({ fromId: 123, chatId: 456, text: "agent status" })),
    ]);
  } finally {
    console.log = originalLog;
  }

  const result = JSON.parse(lines[0]);

  assert.equal(result.ok, true);
  assert.equal(result.payload.method, "sendMessage");
  assert.equal(result.payload.chat_id, 456);
});

test("telegram poll fetches updates, sends replies, and stores the next offset", async () => {
  const agentHome = makeAgentHome("codex-agent-telegram-poll-");
  allowGatewayUser(agentHome, "123");
  const fetchCalls = [];
  const fetchImpl = fakeTelegramFetch(fetchCalls, [
    telegramUpdate({ updateId: 40, fromId: 123, chatId: 456, text: "agent status" }),
  ]);

  const result = await pollTelegramOnce({ agentHome, token: "test-token", fetchImpl });
  const state = JSON.parse(fs.readFileSync(agentPaths(agentHome).telegramState, "utf8"));

  assert.equal(result.updates, 1);
  assert.equal(result.next_offset, 41);
  assert.equal(result.handled[0].sent, true);
  assert.equal(state.next_offset, 41);
  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0].method, "getUpdates");
  assert.equal(fetchCalls[0].body.offset, undefined);
  assert.deepEqual(fetchCalls[0].body.allowed_updates, ["message", "callback_query"]);
  assert.equal(fetchCalls[1].method, "sendMessage");
  assert.equal(fetchCalls[1].body.chat_id, 456);
});

test("telegram poll resumes from stored offset", async () => {
  const agentHome = makeAgentHome("codex-agent-telegram-poll-offset-");
  fs.mkdirSync(agentHome, { recursive: true });
  fs.writeFileSync(agentPaths(agentHome).telegramState, `${JSON.stringify({ next_offset: 50 })}\n`);
  const fetchCalls = [];

  const result = await pollTelegramOnce({
    agentHome,
    token: "test-token",
    fetchImpl: fakeTelegramFetch(fetchCalls, []),
  });

  assert.equal(result.updates, 0);
  assert.equal(result.next_offset, 50);
  assert.equal(fetchCalls[0].method, "getUpdates");
  assert.equal(fetchCalls[0].body.offset, 50);
});

test("telegram poll advances unsupported updates without sending a reply", async () => {
  const agentHome = makeAgentHome("codex-agent-telegram-poll-unsupported-");
  const fetchCalls = [];

  const result = await pollTelegramOnce({
    agentHome,
    token: "test-token",
    fetchImpl: fakeTelegramFetch(fetchCalls, [{ update_id: 9, edited_message: { text: "agent status" } }]),
  });
  const state = JSON.parse(fs.readFileSync(agentPaths(agentHome).telegramState, "utf8"));

  assert.equal(result.updates, 1);
  assert.equal(result.handled[0].sent, false);
  assert.equal(result.handled[0].reason, "unsupported_update");
  assert.equal(state.next_offset, 10);
  assert.equal(fetchCalls.length, 1);
});

test("telegram poll answers invalid callback queries without sending a message", async () => {
  const agentHome = makeAgentHome("codex-agent-telegram-callback-invalid-");
  const fetchCalls = [];

  const result = await pollTelegramOnce({
    agentHome,
    token: "test-token",
    fetchImpl: fakeTelegramFetch(fetchCalls, [telegramCallbackUpdate({ updateId: 30, fromId: 123, chatId: 456, data: "bad:data" })]),
  });
  const audit = readJsonl(agentPaths(agentHome).gatewayAudit);

  assert.equal(result.updates, 1);
  assert.equal(result.handled[0].sent, true);
  assert.equal(result.handled[0].reason, "callback_invalid");
  assert.equal(fetchCalls[1].method, "answerCallbackQuery");
  assert.equal(fetchCalls[1].body.callback_query_id, "cb_30");
  assert.equal(fetchCalls[1].body.text, "Invalid action.");
  assert.equal(fetchCalls.some((call) => call.method === "sendMessage"), false);
  assert.equal(audit[0].command, "owner_callback");
  assert.equal(audit[0].allowed, false);
  assert.equal(audit[0].ok, false);
  assert.equal(audit[0].task_id, undefined);
  assert.equal(audit[0].reason, "callback_invalid");
  assert.equal(audit[0].text, undefined);
});

test("telegram poll answers missing-chat callbacks without enqueueing", async () => {
  const agentHome = makeAgentHome("codex-agent-telegram-callback-missing-chat-");
  setTelegramCodexPolicy(agentHome, { direct_send_user_add: "123", default_repo: "/repo/agent-river" });
  const created = createDispatchApproval({
    agentHome,
    proposedBy: "opus",
    proposal: {
      to: "codex",
      task: "Missing chat callback coverage.",
      reason: "Callback answer should fail closed.",
      suggested_mode: "plan",
    },
  });
  const fetchCalls = [];

  const result = await pollTelegramOnce({
    agentHome,
    token: "test-token",
    fetchImpl: fakeTelegramFetch(fetchCalls, [telegramCallbackUpdate({ updateId: 31, fromId: 123, chatId: null, data: `dispatch:approve:${created.approval.id}` })]),
  });
  const audit = readJsonl(agentPaths(agentHome).gatewayAudit);

  assert.equal(result.updates, 1);
  assert.equal(result.handled[0].sent, true);
  assert.equal(result.handled[0].reason, "callback_missing_chat");
  assert.equal(fetchCalls[1].method, "answerCallbackQuery");
  assert.equal(fetchCalls[1].body.text, "Missing chat.");
  assert.equal(audit[0].command, "owner_callback");
  assert.equal(audit[0].allowed, true);
  assert.equal(audit[0].ok, false);
  assert.equal(audit[0].dispatch_id, created.approval.id);
  assert.equal(audit[0].reason, "callback_missing_chat");
});
test("telegram poll sends pending dispatch approval with inline buttons", async () => {
  const agentHome = makeAgentHome("codex-agent-telegram-dispatch-notify-");
  allowGatewayUser(agentHome, "123");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  const created = createDispatchApproval({
    agentHome,
    proposedBy: "opus",
    proposal: {
      to: "codex",
      task: "Implement the dispatch notification test coverage.",
      reason: "Codex owns the Telegram notification path.",
      suggested_mode: "plan",
    },
    parentMsgId: "msg_parent",
    chatId: "456",
  });
  const calls = [];

  const result = await pollTelegramOnce({
    agentHome,
    token: "test-token",
    fetchImpl: sequencedFetch(calls, [[]]),
  });
  const sends = calls.filter((call) => call.method === "sendMessage");
  const approval = listDispatchApprovals(agentHome)[0];

  assert.equal(result.dispatch_notifications[0].id, created.approval.id);
  assert.equal(result.dispatch_notifications[0].sent, true);
  assert.equal(sends.length, 1);
  assert.match(sends[0].body.text, /待核准跨 agent 派工/);
  assert.deepEqual(sends[0].body.reply_markup.inline_keyboard[0].map((button) => button.callback_data), [
    `dispatch:approve:${created.approval.id}`,
    `dispatch:reject:${created.approval.id}`,
  ]);
  assert.ok(approval.notified_at);
});

test("dispatch approval callback to codex creates a pending task and no exchange message", async () => {
  const agentHome = makeAgentHome("codex-agent-telegram-dispatch-codex-");
  allowGatewayUser(agentHome, "123");
  setTelegramCodexPolicy(agentHome, { direct_send_user_add: "123", default_repo: "/repo/agent-river" });
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  const created = createDispatchApproval({
    agentHome,
    proposedBy: "opus",
    proposal: {
      to: "codex",
      task: "Implement the approved dispatch task path.",
      reason: "Codex owns the implementation.",
      suggested_mode: "edit",
    },
    chatId: "456",
  });
  const calls = [];

  const result = await pollTelegramOnce({
    agentHome,
    token: "test-token",
    fetchImpl: sequencedFetch(calls, [[telegramCallbackUpdate({ updateId: 32, fromId: 123, chatId: 456, data: `dispatch:approve:${created.approval.id}` })], []]),
  });
  const approvals = listDispatchApprovals(agentHome);
  const tasks = fs.readdirSync(agentPaths(agentHome).tasksDir);
  const task = JSON.parse(fs.readFileSync(path.join(agentPaths(agentHome).tasksDir, tasks[0]), "utf8"));

  assert.equal(result.handled[0].reason, "dispatch_approve");
  assert.equal(approvals[0].status, "approved");
  assert.equal(approvals[0].outcome.type, "task");
  assert.equal(task.id, approvals[0].outcome.id);
  assert.equal(task.executor, "codex");
  assert.equal(task.approval, "pending");
  assert.equal(readJsonl(agentPaths(agentHome).exchangeMessages).length, 0);
  assert.equal(calls.some((call) => call.method === "sendMessage"), false);
});

test("dispatch approval callback to opus creates a dispatch exchange message", async () => {
  const agentHome = makeAgentHome("codex-agent-telegram-dispatch-opus-");
  allowGatewayUser(agentHome, "123");
  setTelegramCodexPolicy(agentHome, { direct_send_user_add: "123", default_repo: "/repo/agent-river" });
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  const created = createDispatchApproval({
    agentHome,
    proposedBy: "codex",
    proposal: {
      to: "opus",
      task: "Review the approved dispatch exchange path.",
      reason: "Opus should review the safety boundary.",
      suggested_mode: "plan",
    },
    chatId: "456",
  });
  const calls = [];

  const result = await pollTelegramOnce({
    agentHome,
    token: "test-token",
    fetchImpl: sequencedFetch(calls, [[telegramCallbackUpdate({ updateId: 33, fromId: 123, chatId: 456, data: `dispatch:approve:${created.approval.id}` })], []]),
  });
  const message = readJsonl(agentPaths(agentHome).exchangeMessages)[0];

  assert.equal(result.handled[0].reason, "dispatch_approve");
  assert.equal(message.from, "codex");
  assert.equal(message.to, "opus");
  assert.equal(message.channel, "dispatch");
  assert.equal(message.dispatch.kind, "agent_dispatch");
  assert.equal(listDispatchApprovals(agentHome)[0].outcome.id, message.id);
});

test("dispatch reject callback creates no task or exchange message", async () => {
  const agentHome = makeAgentHome("codex-agent-telegram-dispatch-reject-");
  allowGatewayUser(agentHome, "123");
  setTelegramCodexPolicy(agentHome, { direct_send_user_add: "123", default_repo: "/repo/agent-river" });
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  const created = createDispatchApproval({
    agentHome,
    proposedBy: "opus",
    proposal: {
      to: "codex",
      task: "Implement this rejected dispatch request.",
      reason: "This should be rejected.",
      suggested_mode: "plan",
    },
    chatId: "456",
  });

  const result = await pollTelegramOnce({
    agentHome,
    token: "test-token",
    fetchImpl: sequencedFetch([], [[telegramCallbackUpdate({ updateId: 34, fromId: 123, chatId: 456, data: `dispatch:reject:${created.approval.id}` })], []]),
  });

  assert.equal(result.handled[0].reason, "dispatch_reject");
  assert.equal(listDispatchApprovals(agentHome)[0].status, "rejected");
  assert.equal(fs.existsSync(agentPaths(agentHome).tasksDir), false);
  assert.equal(readJsonl(agentPaths(agentHome).exchangeMessages).length, 0);
});

test("dispatch callback from non-owner is denied and does not mutate approval", async () => {
  const agentHome = makeAgentHome("codex-agent-telegram-dispatch-denied-");
  allowGatewayUser(agentHome, "123");
  setTelegramCodexPolicy(agentHome, { direct_send_user_add: "123", default_repo: "/repo/agent-river" });
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  const created = createDispatchApproval({
    agentHome,
    proposedBy: "opus",
    proposal: {
      to: "codex",
      task: "Implement this denied dispatch callback request.",
      reason: "Non-owner callbacks must not mutate state.",
      suggested_mode: "plan",
    },
    chatId: "456",
  });
  const calls = [];

  const result = await pollTelegramOnce({
    agentHome,
    token: "test-token",
    fetchImpl: sequencedFetch(calls, [[telegramCallbackUpdate({ updateId: 35, fromId: 999, chatId: 456, data: `dispatch:approve:${created.approval.id}` })], []]),
  });

  assert.equal(result.handled[0].reason, "callback_not_allowed");
  assert.equal(calls.find((call) => call.method === "answerCallbackQuery").body.text, "Not allowed.");
  assert.equal(listDispatchApprovals(agentHome)[0].status, "pending");
  assert.equal(fs.existsSync(agentPaths(agentHome).tasksDir), false);
  assert.equal(readJsonl(agentPaths(agentHome).exchangeMessages).length, 0);
});

test("telegram poll queues failed gateway replies without re-executing the command", async () => {
  const agentHome = makeAgentHome("codex-agent-telegram-send-failure-");
  allowGatewayUser(agentHome, "123");
  const firstCalls = [];
  const updates = [
    telegramUpdate({
      updateId: 20,
      fromId: 123,
      chatId: 456,
      text: 'agent submit --repo /repo/memory-river --request "Plan once"',
    }),
  ];

  const first = await pollTelegramOnce({
    agentHome,
    token: "test-token",
    fetchImpl: failingSendFetch(firstCalls, updates),
  });
  const state = JSON.parse(fs.readFileSync(agentPaths(agentHome).telegramState, "utf8"));
  const queued = readJsonl(agentPaths(agentHome).telegramOutbox);

  assert.equal(first.updates, 1);
  assert.equal(first.next_offset, 21);
  assert.equal(first.handled[0].sent, false);
  assert.equal(first.handled[0].send_error, "Telegram sendMessage request failed");
  assert.equal(first.gateway_replies[0].sent, false);
  assert.equal(state.next_offset, 21);
  assert.equal(queued[0].status, "queued");
  assert.equal(fs.readdirSync(agentPaths(agentHome).tasksDir).length, 1);

  const secondCalls = [];
  const second = await pollTelegramOnce({
    agentHome,
    token: "test-token",
    fetchImpl: sequencedFetch(secondCalls, [[]]),
  });

  assert.equal(second.updates, 0);
  assert.equal(second.gateway_replies[0].sent, true);
  assert.equal(secondCalls[0].body.offset, 21);
  assert.equal(secondCalls[1].method, "sendMessage");
  assert.equal(secondCalls[1].body.text.includes("Submitted plan task"), true);
  assert.equal(fs.readdirSync(agentPaths(agentHome).tasksDir).length, 1);
  assert.equal(readJsonl(agentPaths(agentHome).telegramOutbox).at(-1).status, "sent");
});

test("telegram poll advances past a failed reply that cannot enter the outbox", async () => {
  const agentHome = makeAgentHome("codex-agent-telegram-outbox-poison-");
  allowGatewayUser(agentHome, "123");
  const calls = [];

  const result = await pollTelegramOnce({
    agentHome,
    token: "test-token",
    fetchImpl: failingSendFetch(calls, [
      telegramUpdate({ updateId: 22, fromId: 123, chatId: 456, text: "agent status" }),
    ]),
    handleUpdateImpl: async () => ({
      ok: true,
      payload: { method: "sendMessage", chat_id: 456, text: "" },
    }),
  });

  const state = JSON.parse(fs.readFileSync(agentPaths(agentHome).telegramState, "utf8"));
  assert.equal(result.next_offset, 23);
  assert.equal(state.next_offset, 23);
  assert.equal(result.handled[0].sent, false);
  assert.match(result.handled[0].send_error, /outbox skipped/);
  assert.equal(readJsonl(agentPaths(agentHome).telegramOutbox).length, 0);
});

test("telegram poll sanitizes transport errors without exposing the token", async () => {
  const agentHome = makeAgentHome("codex-agent-telegram-fetch-error-");

  await assert.rejects(
    () => pollTelegramOnce({
      agentHome,
      token: "secret-token",
      fetchImpl: async () => {
        throw new Error("network failed for https://api.telegram.org/botsecret-token/getUpdates");
      },
    }),
    (error) => {
      assert.equal(error.message, "Telegram getUpdates request failed");
      assert.doesNotMatch(error.message, /secret-token/);
      return true;
    },
  );
});

test("telegram curl transport keeps token out of process arguments", async () => {
  const calls = [];
  const request = createTelegramRequest({
    transport: "curl",
    execFileImpl: fakeExecFile(calls, { ok: true, result: [] }),
  });

  const result = await request({
    token: "secret-token",
    method: "getUpdates",
    body: { timeout: 0 },
  });

  assert.deepEqual(result, []);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["-sS", "--config", "-"]);
  assert.doesNotMatch(calls[0].args.join(" "), /secret-token/);
  assert.match(calls[0].stdin, /header = "content-type: application\/json"/);
  assert.match(calls[0].stdin, /botsecret-token\/getUpdates/);
  assert.match(calls[0].stdin, /\\"timeout\\":0/);
});

test("telegram curl transport reports token-free request failures", async () => {
  const request = createTelegramRequest({
    transport: "curl",
    execFileImpl: fakeExecFileError(new Error("curl failed for secret-token")),
  });

  await assert.rejects(
    () => request({
      token: "secret-token",
      method: "getUpdates",
      body: { timeout: 0 },
    }),
    (error) => {
      assert.equal(error.message, "Telegram getUpdates request failed");
      assert.doesNotMatch(error.message, /secret-token/);
      return true;
    },
  );
});

test("telegram curl transport reports stdin write failures without leaking tokens", async () => {
  const request = createTelegramRequest({
    transport: "curl",
    execFileImpl: fakeExecFileThrowingStdin(),
  });

  await assert.rejects(
    () => request({
      token: "secret-token",
      method: "getUpdates",
      body: { timeout: 0 },
    }),
    (error) => {
      assert.equal(error.message, "Telegram getUpdates request failed");
      assert.doesNotMatch(error.message, /secret-token/);
      return true;
    },
  );
});

test("telegram curl transport reports malformed responses without token leakage", async () => {
  const malformed = createTelegramRequest({
    transport: "curl",
    execFileImpl: fakeExecFileStdout("not json"),
  });
  await assert.rejects(
    () => malformed({ token: "secret-token", method: "getUpdates", body: { timeout: 0 } }),
    /Telegram getUpdates response failed/,
  );

  const failedPayload = createTelegramRequest({
    transport: "curl",
    execFileImpl: fakeExecFileStdout(JSON.stringify({ ok: false, description: "bad token secret-token" })),
  });
  await assert.rejects(
    () => failedPayload({ token: "secret-token", method: "getUpdates", body: { timeout: 0 } }),
    (error) => {
      assert.equal(error.message, "Telegram getUpdates response failed");
      assert.doesNotMatch(error.message, /secret-token/);
      return true;
    },
  );
});

test("telegram curl transport safely escapes request bodies", async () => {
  const calls = [];
  const request = createTelegramRequest({
    transport: "curl",
    execFileImpl: fakeExecFile(calls, { ok: true, result: { message_id: 1 } }),
  });

  await request({
    token: "secret-token",
    method: "sendMessage",
    body: { chat_id: 123, text: 'a"b\\c' },
  });

  assert.match(calls[0].stdin, /a\\\\\\"b\\\\\\\\c/);
});

test("telegram poll supports injected curl transport", async () => {
  const agentHome = makeAgentHome("codex-agent-telegram-curl-transport-");
  allowGatewayUser(agentHome, "123");
  const calls = [];

  const result = await pollTelegramOnce({
    agentHome,
    token: "secret-token",
    transport: "curl",
    execFileImpl: fakeExecFileSequence(calls, [
      { ok: true, result: [telegramUpdate({ updateId: 60, fromId: 123, chatId: 456, text: "agent status" })] },
      { ok: true, result: { message_id: 99 } },
    ]),
  });

  assert.equal(result.next_offset, 61);
  assert.equal(result.handled[0].sent, true);
  assert.equal(calls.length, 2);
  assert.doesNotMatch(JSON.stringify(calls.map((call) => call.args)), /secret-token/);
});

test("telegram poll sends agent run summaries", async () => {
  const agentHome = makeAgentHome("codex-agent-telegram-poll-run-");
  const memoryStateHome = undefined;
  allowGatewayUser(agentHome, "123");
  const submitted = await handleTelegramUpdate({
    agentHome,
    update: telegramUpdate({
      fromId: 123,
      chatId: 456,
      text: 'agent submit --repo /repo/memory-river --request "Plan poll run"',
    }),
  });
  // Gateway submissions are pending; approve before the run can advance it.
  await handleTelegramUpdate({
    agentHome,
    update: telegramUpdate({ fromId: 123, chatId: 456, text: `agent approve ${submitted.gateway.task_id}` }),
  });
  const fetchCalls = [];

  const result = await pollTelegramOnce({
    agentHome,
    token: "test-token",
    memoryStateHome,
    runner: async () => ({ text: "planned from poll", sessionPath: null, exit: 0, tokens: 5 }),
    fetchImpl: fakeTelegramFetch(fetchCalls, [
      telegramUpdate({ updateId: 70, fromId: 123, chatId: 456, text: `agent run ${submitted.gateway.task_id}` }),
    ]),
  });

  assert.equal(result.handled[0].command, "agent_run");
  assert.equal(result.handled[0].sent, true);
  assert.match(fetchCalls[1].body.text, /Run: advanced=1/);
  assert.match(fetchCalls[1].body.text, /done=1/);
});
test("telegram exchange reply notifications are off by default", async () => {
  const agentHome = makeAgentHome("codex-agent-telegram-exchange-notify-off-");
  seedExchangeReplies(agentHome, [{ id: "msg_notify_off", replyId: "xreply_notify_off" }]);
  const fetchCalls = [];

  const result = await pollTelegramOnce({
    agentHome,
    token: "test-token",
    fetchImpl: fakeTelegramFetch(fetchCalls, []),
  });

  assert.equal(result.exchange_notifications.length, 0);
  assert.equal(fetchCalls.some((call) => call.method === "sendMessage"), false);
  assert.equal(readJsonl(agentPaths(agentHome).exchangeNotifications).length, 0);
});

test("telegram exchange reply notifications are gated, deduped, and send-only", async () => {
  const agentHome = makeAgentHome("codex-agent-telegram-exchange-notify-");
  setTelegramCodexPolicy(agentHome, {
    exchange_notify_enabled: true,
    exchange_notify_chat_id: "456",
  });
  seedExchangeReplies(agentHome, [
    { id: "msg_notify_ok", replyId: "xreply_notify_ok", replyText: "No findings." },
    { id: "msg_notify_cli", replyId: "xreply_notify_cli", channel: "cli", replyText: "CLI reply" },
    { id: "msg_notify_human", replyId: "xreply_notify_human", from: "human", replyText: "Human reply" },
  ]);
  const paths = agentPaths(agentHome);
  const beforeMessages = readJsonl(paths.exchangeMessages);
  const firstCalls = [];
  const secondCalls = [];

  const first = await pollTelegramOnce({
    agentHome,
    token: "test-token",
    fetchImpl: fakeTelegramFetch(firstCalls, []),
  });
  const second = await pollTelegramOnce({
    agentHome,
    token: "test-token",
    fetchImpl: fakeTelegramFetch(secondCalls, []),
  });
  const notifications = readJsonl(paths.exchangeNotifications);

  assert.equal(first.exchange_notifications.length, 1);
  assert.equal(first.exchange_notifications[0].reply_id, "xreply_notify_ok");
  assert.equal(firstCalls.filter((call) => call.method === "sendMessage").length, 1);
  const notifyText = firstCalls.find((call) => call.method === "sendMessage").body.text;
  assert.match(notifyText, /^Opus:/);
  assert.doesNotMatch(notifyText, /msg_/);
  assert.match(notifyText, /No findings\./);
  assert.doesNotMatch(notifyText, /Full: @codex replies/);
  assert.equal(second.exchange_notifications.length, 0);
  assert.equal(secondCalls.some((call) => call.method === "sendMessage"), false);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].reply_id, "xreply_notify_ok");
  assert.deepEqual(readJsonl(paths.exchangeMessages), beforeMessages);
});

test("telegram exchange notifications include dispatch lane and strip valid dispatch blocks", async () => {
  const agentHome = makeAgentHome("codex-agent-telegram-exchange-notify-dispatch-");
  setTelegramCodexPolicy(agentHome, {
    exchange_notify_enabled: true,
    exchange_notify_chat_id: "456",
  });
  seedExchangeReplies(agentHome, [{
    id: "msg_notify_dispatch",
    replyId: "xreply_notify_dispatch",
    channel: "dispatch",
    replyText: [
      "Review complete.",
      "```agent-dispatch",
      JSON.stringify({
        to: "codex",
        task: "Implement the notification strip regression test.",
        reason: "Codex owns the Telegram notification path.",
        mode: "plan",
      }),
      "```",
    ].join("\n"),
  }]);
  const calls = [];

  const result = await pollTelegramOnce({
    agentHome,
    token: "test-token",
    fetchImpl: fakeTelegramFetch(calls, []),
  });
  const send = calls.find((call) => call.method === "sendMessage");

  assert.equal(result.exchange_notifications.length, 1);
  assert.match(send.body.text, /Review complete\./);
  assert.doesNotMatch(send.body.text, /agent-dispatch/);
  assert.doesNotMatch(send.body.text, /Implement the notification strip/);
});

test("telegram exchange reply notifications honor restart ledger", async () => {
  const agentHome = makeAgentHome("codex-agent-telegram-exchange-notify-ledger-");
  setTelegramCodexPolicy(agentHome, {
    exchange_notify_enabled: true,
    exchange_notify_chat_id: "456",
  });
  seedExchangeReplies(agentHome, [{ id: "msg_notify_seen", replyId: "xreply_notify_seen" }]);
  writeJsonl(agentPaths(agentHome).exchangeNotifications, [{
    reply_id: "xreply_notify_seen",
    message_id: "msg_notify_seen",
    chat_id: "456",
    status: "sent",
    created_at: new Date().toISOString(),
  }]);
  const fetchCalls = [];

  const result = await pollTelegramOnce({
    agentHome,
    token: "test-token",
    fetchImpl: fakeTelegramFetch(fetchCalls, []),
  });

  assert.equal(result.exchange_notifications.length, 0);
  assert.equal(fetchCalls.some((call) => call.method === "sendMessage"), false);
});

test("telegram exchange reply notifications cap each cycle", async () => {
  const agentHome = makeAgentHome("codex-agent-telegram-exchange-notify-cap-");
  setTelegramCodexPolicy(agentHome, {
    exchange_notify_enabled: true,
    exchange_notify_chat_id: "456",
    exchange_notify_max_per_cycle: 2,
  });
  seedExchangeReplies(agentHome, [
    { id: "msg_notify_cap_1", replyId: "xreply_notify_cap_1" },
    { id: "msg_notify_cap_2", replyId: "xreply_notify_cap_2" },
    { id: "msg_notify_cap_3", replyId: "xreply_notify_cap_3" },
  ]);
  const firstCalls = [];
  const secondCalls = [];

  const first = await pollTelegramOnce({
    agentHome,
    token: "test-token",
    fetchImpl: fakeTelegramFetch(firstCalls, []),
  });
  const second = await pollTelegramOnce({
    agentHome,
    token: "test-token",
    fetchImpl: fakeTelegramFetch(secondCalls, []),
  });

  assert.equal(first.exchange_notifications.length, 2);
  assert.equal(firstCalls.filter((call) => call.method === "sendMessage").length, 2);
  assert.equal(second.exchange_notifications.length, 1);
  assert.equal(secondCalls.filter((call) => call.method === "sendMessage").length, 1);
});

test("telegram exchange reply notifications bound previews and withhold secret-like output", async () => {
  const agentHome = makeAgentHome("codex-agent-telegram-exchange-notify-preview-");
  setTelegramCodexPolicy(agentHome, {
    exchange_notify_enabled: true,
    exchange_notify_chat_id: "456",
    exchange_notify_max_per_cycle: 2,
  });
  seedExchangeReplies(agentHome, [
    { id: "msg_notify_long", replyId: "xreply_notify_long", replyText: "review ".repeat(100).trim() },
    { id: "msg_notify_secret", replyId: "xreply_notify_secret", replyText: "token = sk-123456789012345678901234567890" },
  ]);
  const fetchCalls = [];

  await pollTelegramOnce({
    agentHome,
    token: "test-token",
    fetchImpl: fakeTelegramFetch(fetchCalls, []),
  });
  const sends = fetchCalls.filter((call) => call.method === "sendMessage");

  // Long reply is split: multiple sends, first has "Opus:" header, full text delivered.
  const longSends = sends.filter((s) => s.body.text.startsWith("Opus:") || sends.indexOf(s) < sends.findIndex((s2) => s2.body.text.includes("withheld")));
  const fullText = longSends.map((s) => s.body.text).join("\n");
  assert.match(fullText, /^Opus:/);
  assert.doesNotMatch(fullText, /msg_notify_long/);
  assert.doesNotMatch(fullText, /Full: @codex replies/);
  // Each chunk must fit within Telegram limit.
  for (const s of longSends) {
    assert.ok(s.body.text.length <= 4096, `chunk too long: ${s.body.text.length}`);
  }
  // Full "review " * 100 text must be present across chunks.
  assert.ok(fullText.includes("review review"), "full text delivered");
  // Withheld notification: keeps msg/reply id for debugging, never leaks the secret.
  const withheld = sends.find((s) => s.body.text.includes("withheld"));
  assert.ok(withheld, "withheld send present");
  assert.match(withheld.body.text, /msg_notify_secret/);
  assert.doesNotMatch(withheld.body.text, /sk-123456789012345678901234567890/);
});

test("telegram exchange reply notifications scan full text before truncating", async () => {
  const agentHome = makeAgentHome("codex-agent-telegram-exchange-notify-secret-boundary-");
  setTelegramCodexPolicy(agentHome, {
    exchange_notify_enabled: true,
    exchange_notify_chat_id: "456",
  });
  const secret = "token = sk-123456789012345678901234567890";
  seedExchangeReplies(agentHome, [{
    id: "msg_notify_secret_boundary",
    replyId: "xreply_notify_secret_boundary",
    replyText: `${"x".repeat(295)} ${secret}`,
  }]);
  const fetchCalls = [];

  await pollTelegramOnce({
    agentHome,
    token: "test-token",
    fetchImpl: fakeTelegramFetch(fetchCalls, []),
  });
  const send = fetchCalls.find((call) => call.method === "sendMessage");

  assert.match(send.body.text, /withheld/);
  assert.doesNotMatch(send.body.text, /sk-123456789012345678901234567890/);
});

test("telegram exchange reply notifications retry after send failure", async () => {
  const agentHome = makeAgentHome("codex-agent-telegram-exchange-notify-retry-");
  setTelegramCodexPolicy(agentHome, {
    exchange_notify_enabled: true,
    exchange_notify_chat_id: "456",
  });
  seedExchangeReplies(agentHome, [{ id: "msg_notify_retry", replyId: "xreply_notify_retry" }]);
  const failedCalls = [];
  const retriedCalls = [];

  const failed = await pollTelegramOnce({
    agentHome,
    token: "test-token",
    fetchImpl: fakeTelegramFetch(failedCalls, [], { failSendAt: 1 }),
  });
  const afterFailed = readJsonl(agentPaths(agentHome).exchangeNotifications);
  const retried = await pollTelegramOnce({
    agentHome,
    token: "test-token",
    fetchImpl: fakeTelegramFetch(retriedCalls, []),
  });
  const notifications = readJsonl(agentPaths(agentHome).exchangeNotifications);

  assert.equal(failed.exchange_notifications[0].sent, false);
  assert.equal(failed.exchange_notifications[0].reply_id, "xreply_notify_retry");
  assert.equal(afterFailed.length, 0);
  assert.equal(retried.exchange_notifications[0].sent, true);
  assert.equal(retried.exchange_notifications[0].reply_id, "xreply_notify_retry");
  assert.equal(notifications[0].reply_id, "xreply_notify_retry");
});
test("telegram poll rejects unknown transports", async () => {
  await assert.rejects(
    () => pollTelegramOnce({
      agentHome: makeAgentHome("codex-agent-telegram-bad-transport-"),
      token: "test-token",
      transport: "carrier-pigeon",
    }),
    /Unknown Telegram transport/,
  );
});

test("telegram poll requires a bot token and fetch implementation", async () => {
  await assert.rejects(
    () => pollTelegramOnce({ agentHome: makeAgentHome("codex-agent-telegram-no-token-"), token: "", fetchImpl: async () => ({ ok: true }) }),
    /Missing TELEGRAM_BOT_TOKEN/,
  );
  await assert.rejects(
    () => pollTelegramOnce({ agentHome: makeAgentHome("codex-agent-telegram-no-fetch-"), token: "test-token", fetchImpl: null }),
    /Missing fetch implementation/,
  );
});

test("telegram poll reports Telegram API failures without storing token", async () => {
  const agentHome = makeAgentHome("codex-agent-telegram-api-failure-");

  await assert.rejects(
    () => pollTelegramOnce({
      agentHome,
      token: "secret-token",
      fetchImpl: async () => ({ ok: false, json: async () => ({ ok: false }) }),
    }),
    /Telegram getUpdates request failed/,
  );
  assert.equal(fs.existsSync(agentPaths(agentHome).telegramState), false);
});

function telegramUpdate({ updateId = 1, fromId, chatId, text }) {
  return {
    update_id: updateId,
    message: {
      message_id: 10,
      from: { id: fromId },
      chat: { id: chatId },
      text,
    },
  };
}

function telegramCallbackUpdate({ updateId = 1, fromId, chatId, data }) {
  const callback = {
    id: `cb_${updateId}`,
    from: { id: fromId },
    data,
  };
  if (chatId !== null) {
    callback.message = {
      message_id: 10,
      chat: { id: chatId },
    };
  }
  return {
    update_id: updateId,
    callback_query: callback,
  };
}

function seedExchangeReplies(agentHome, entries) {
  const now = new Date().toISOString();
  writeJsonl(agentPaths(agentHome).exchangeMessages, entries.map((entry) => ({
    id: entry.id,
    from: entry.from || "codex",
    to: entry.to || "opus",
    channel: entry.channel || "telegram",
    thread_id: entry.threadId || null,
    text: entry.requestText || "Review request",
    text_hash: `hash_${entry.id}`,
    created_at: now,
  })));
  writeJsonl(agentPaths(agentHome).exchangeReplies, entries.map((entry) => ({
    id: entry.replyId,
    message_id: entry.id,
    agent_id: entry.responder || "opus",
    text: entry.replyText || "No findings.",
    text_hash: `hash_${entry.replyId}`,
    created_at: now,
  })));
}
test("service module never invokes systemctl or a subprocess", () => {
  const src = fs.readFileSync(new URL("../src/agent/service.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /child_process|\bexecSync\(|\bspawn\(|\bexecFile\(/);
});

test("exchange-runner-service-print emits unit/timer with correct ExecStart and no bot token", async () => {
  const agentHome = makeAgentHome("codex-agent-runner-svc-print-");
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));
  try {
    await runAgentCli(["exchange-runner-service-print", "--state", agentHome]);
  } finally {
    console.log = originalLog;
  }
  const result = JSON.parse(lines[0]);
  assert.match(result.unit, /ExecStart=.*bin\/codex-agent\.js exchange-runner --agent opus --once/);
  assert.match(result.unit, /Type=oneshot/);
  assert.match(result.unit, /Environment=PATH=.*\.local\/bin.*\.npm-global\/bin/);
  assert.match(result.timer, /OnUnitActiveSec=90s/);
  assert.match(result.timer, /WantedBy=timers.target/);
  assert.doesNotMatch(`${result.unit}\n${result.timer}`, /TELEGRAM_BOT_TOKEN|EnvironmentFile/);
});

test("exchange-runner-service-write writes unit and timer to explicit dir and never enables", async () => {
  const agentHome = makeAgentHome("codex-agent-runner-svc-write-");
  const dir = path.join(agentHome, "systemd-user");
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));
  try {
    await runAgentCli(["exchange-runner-service-write", "--state", agentHome, "--dir", dir]);
  } finally {
    console.log = originalLog;
  }
  assert.equal(fs.existsSync(path.join(dir, "codex-agent-opus-runner.service")), true);
  assert.equal(fs.existsSync(path.join(dir, "codex-agent-opus-runner.timer")), true);
  const unit = fs.readFileSync(path.join(dir, "codex-agent-opus-runner.service"), "utf8");
  assert.match(unit, /exchange-runner --agent opus --once/);
  const result = JSON.parse(lines[0]);
  assert.match(result.note, /never runs systemctl/i);
});

test("exchange-runner-service-status reports missing, match, and drifted files", async () => {
  const agentHome = makeAgentHome("codex-agent-runner-svc-status-");
  const dir = path.join(agentHome, "systemd-user");
  const settingsPath = path.join(agentHome, "opus-runner-settings.json");
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));
  try {
    await runAgentCli(["exchange-runner-service-status", "--state", agentHome, "--dir", dir, "--settings", settingsPath]);
    await runAgentCli(["exchange-runner-service-write", "--state", agentHome, "--dir", dir]);
    await runAgentCli(["exchange-runner-settings-write", "--state", agentHome, "--settings", settingsPath]);
    await runAgentCli(["exchange-runner-service-status", "--state", agentHome, "--dir", dir, "--settings", settingsPath]);
    fs.writeFileSync(path.join(dir, "codex-agent-opus-runner.service"), "stale unit\n");
    fs.writeFileSync(settingsPath, `${JSON.stringify({ stale: true })}\n`);
    await runAgentCli(["exchange-runner-service-status", "--state", agentHome, "--dir", dir, "--settings", settingsPath]);
  } finally {
    console.log = originalLog;
  }
  const before = JSON.parse(lines[0]);
  const after = JSON.parse(lines[3]);
  const drifted = JSON.parse(lines[4]);
  assert.equal(before.unit.exists, false);
  assert.equal(before.timer.exists, false);
  assert.equal(before.unit.drift, "missing");
  assert.equal(before.timer.drift, "missing");
  assert.equal(before.settings.drift, "missing");
  assert.ok(typeof before.settings.path === "string", "settings path is reported");
  assert.equal(after.unit.exists, true);
  assert.equal(after.timer.exists, true);
  assert.equal(after.settings.exists, true);
  assert.equal(after.unit.drift, "match");
  assert.equal(after.timer.drift, "match");
  assert.equal(after.settings.drift, "match");
  assert.equal(drifted.unit.drift, "drifted");
  assert.equal(drifted.timer.drift, "match");
  assert.equal(drifted.settings.drift, "drifted");
});

test("exchange-runner-settings-print returns valid least-privilege permissions", async () => {
  const agentHome = makeAgentHome("codex-agent-runner-settings-print-");
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));
  try {
    await runAgentCli(["exchange-runner-settings-print", "--state", agentHome]);
  } finally {
    console.log = originalLog;
  }
  const result = JSON.parse(lines[0]);
  assert.ok(Array.isArray(result.permissions.allow));
  assert.ok(Array.isArray(result.permissions.deny));
  assert.ok(result.permissions.allow.includes("Read"));
  assert.equal(result.permissions.allow.includes("Write"), false);
  assert.equal(result.permissions.allow.some((entry) => entry.startsWith("Write")), false);
  assert.equal(result.permissions.allow.some((entry) => entry.includes("exchange-reply")), false);
  assert.ok(result.permissions.allow.some((entry) => entry.includes("exchange-runner-session-status")));
  assert.ok(result.permissions.deny.some((d) => d.startsWith("Bash(git commit")));
  assert.ok(result.permissions.deny.includes("Write"));
  assert.ok(result.permissions.deny.includes("Edit"));
  assert.ok(result.permissions.deny.includes("WebFetch"));
});

test("opus-edit-settings-print is edit-capable via acceptEdits but blocks dangerous commands", async () => {
  const agentHome = makeAgentHome("codex-agent-opus-edit-settings-print-");
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));
  try {
    await runAgentCli(["opus-edit-settings-print", "--state", agentHome, "--repo", "/home/x/repo"]);
  } finally {
    console.log = originalLog;
  }
  const result = JSON.parse(lines[0]);
  // acceptEdits is the only thing that actually permits headless file edits;
  // a regression to path-scoped Edit() globs silently breaks execution.
  assert.equal(result.permissions.defaultMode, "acceptEdits");
  assert.ok(result.permissions.allow.includes("Edit"));
  assert.ok(result.permissions.allow.includes("Write"));
  assert.equal(result.permissions.allow.some((entry) => entry.includes("exchange-reply")), false);
  // Envelope still closed: no commit/push/deploy/install, no network, no dispatch.
  assert.ok(result.permissions.deny.some((d) => d.startsWith("Bash(git commit")));
  assert.ok(result.permissions.deny.some((d) => d.startsWith("Bash(git push")));
  assert.ok(result.permissions.deny.some((d) => d.startsWith("Bash(npm install")));
  assert.ok(result.permissions.deny.some((d) => d.includes("exchange-submit")));
  assert.ok(result.permissions.deny.includes("WebFetch"));
});

test("exchange-runner-settings-write creates file once and does not overwrite existing", async () => {
  const agentHome = makeAgentHome("codex-agent-runner-settings-write-");
  const settingsPath = path.join(agentHome, "test-opus-settings.json");
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));
  try {
    await runAgentCli(["exchange-runner-settings-write", "--state", agentHome, "--settings", settingsPath]);
    await runAgentCli(["exchange-runner-settings-write", "--state", agentHome, "--settings", settingsPath]);
  } finally {
    console.log = originalLog;
  }
  const first = JSON.parse(lines[0]);
  const second = JSON.parse(lines[1]);
  assert.equal(first.written, true);
  assert.equal(second.written, false);
  assert.match(second.note, /Already exists/i);
  const content = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.ok(Array.isArray(content.permissions.allow));
});
test("pollTelegramOnce defaults to long-poll timeout 0", async () => {
  const agentHome = makeAgentHome("codex-agent-poll-timeout-default-");
  const bodies = [];
  await pollTelegramOnce({
    agentHome, token: "t",
    requestImpl: async ({ method, body }) => { bodies.push({ method, body }); return []; },
  });
  const getUpdates = bodies.find((b) => b.method === "getUpdates");
  assert.equal(getUpdates.body.timeout, 0);
});

test("pollTelegramOnce passes explicit longPollSeconds into getUpdates", async () => {
  const agentHome = makeAgentHome("codex-agent-poll-timeout-25-");
  const bodies = [];
  await pollTelegramOnce({
    agentHome, token: "t", longPollSeconds: 25,
    requestImpl: async ({ method, body }) => { bodies.push({ method, body }); return []; },
  });
  const getUpdates = bodies.find((b) => b.method === "getUpdates");
  assert.equal(getUpdates.body.timeout, 25);
});
test("real codex runner defaults cwd to process.cwd() and closes stdin", async () => {
  const state = {};
  const result = await realCodexRunner({
    prompt: "Reply with exactly: ok",
    execFileImpl: captureCodexExec(state, { writeOut: "ok\n" }),
  });
  assert.equal(result.text, "ok");
  assert.equal(state.cwd, process.cwd());
  assert.equal(state.args[state.args.indexOf("-C") + 1], process.cwd());
  assert.equal(state.stdinEnded, true);
});
test("real codex runner passes the prompt on stdin, not in argv", async () => {
  const state = {};
  const prompt = "Reply with exactly: stdin-only-prompt-text";
  await realCodexRunner({
    prompt,
    execFileImpl: captureCodexExec(state, { writeOut: "ok" }),
  });
  assert.equal(state.command, "codex");
  assert.equal(state.args.length, 8);
  assert.deepEqual(state.args.slice(0, 7), ["exec", "-C", process.cwd(), "--sandbox", "read-only", "--skip-git-repo-check", "-o"]);
  assert.equal(state.args.includes(prompt), false);
  assert.match(state.stdinData, /stdin-only-prompt-text/);
  assert.equal(state.stdinEnded, true);
});

test("real codex runner uses a generous exec buffer for verbose stderr", async () => {
  const state = {};
  await realCodexRunner({
    prompt: "Reply with exactly: ok",
    execFileImpl: captureCodexExec(state, { writeOut: "ok" }),
  });

  assert.ok(state.options.maxBuffer >= 16 * 1024 * 1024);
});

test("real codex runner passes --model only when configured", async () => {
  const unsetHome = makeAgentHome("codex-agent-codex-model-unset-");
  const unset = {};
  await realCodexRunner({
    agentHome: unsetHome,
    prompt: "Reply with exactly: default-model",
    execFileImpl: captureCodexExec(unset, { writeOut: "ok" }),
  });
  assert.equal(unset.args.includes("--model"), false);

  const setHome = makeAgentHome("codex-agent-codex-model-set-");
  setTelegramCodexPolicy(setHome, { codex_runner_model: "gpt-5-codex" });
  const configured = {};
  await realCodexRunner({
    agentHome: setHome,
    prompt: "Reply with exactly: configured-model",
    execFileImpl: captureCodexExec(configured, { writeOut: "ok" }),
  });
  const modelIndex = configured.args.indexOf("--model");
  assert.ok(modelIndex >= 0);
  assert.equal(configured.args[modelIndex + 1], "gpt-5-codex");

  const edit = {};
  await realEditRunner({
    agentHome: setHome,
    prompt: "Edit and report back.",
    task: { repo: "/repo/editable" },
    execFileImpl: captureCodexExec(edit, { writeOut: "edited" }),
  });
  const editModelIndex = edit.args.indexOf("--model");
  assert.ok(editModelIndex >= 0);
  assert.equal(edit.args[editModelIndex + 1], "gpt-5-codex");
});

test("codex runner model config can reset to default and rejects leading dash", () => {
  const agentHome = makeAgentHome("codex-agent-codex-model-config-");
  setTelegramCodexPolicy(agentHome, { codex_runner_model: "gpt-5-codex" });
  assert.equal(getTelegramCodexPolicy(agentHome).codex_runner_model, "gpt-5-codex");
  setTelegramCodexPolicy(agentHome, { codex_runner_model: "" });
  assert.equal(getTelegramCodexPolicy(agentHome).codex_runner_model, "");
  assert.throws(
    () => setTelegramCodexPolicy(agentHome, { codex_runner_model: "--foo" }),
    /invalid characters/,
  );
});

test("Claude runner model config can reset to default and rejects invalid values", () => {
  const agentHome = makeAgentHome("codex-agent-claude-model-config-");
  setTelegramCodexPolicy(agentHome, { exchange_runner_model: "opus" });
  assert.equal(getTelegramCodexPolicy(agentHome).exchange_runner_model, "opus");
  setTelegramCodexPolicy(agentHome, { exchange_runner_model: "" });
  assert.equal(getTelegramCodexPolicy(agentHome).exchange_runner_model, "");
  assert.throws(
    () => setTelegramCodexPolicy(agentHome, { exchange_runner_model: "opus-4.6" }),
    /default, sonnet, or opus/,
  );
});

test("real edit runner uses workspace-write sandbox", async () => {
  const state = {};
  const result = await realEditRunner({
    prompt: "Edit the file and report back.",
    task: { repo: "/repo/editable" },
    step: "editing",
    execFileImpl: captureCodexExec(state, { writeOut: "edited\n", stdout: "tokens used 11\n" }),
  });

  assert.equal(result.text, "edited");
  assert.equal(result.step, "editing");
  assert.equal(state.cwd, "/repo/editable");
  assert.deepEqual(state.args.slice(0, 7), ["exec", "-C", "/repo/editable", "--sandbox", "workspace-write", "--skip-git-repo-check", "-o"]);
});

test("parseCodexTokenUsage parses the codex usage line", () => {
  assert.equal(parseCodexTokenUsage("codex\nstdin-ok\ntokens used\n1,645\n"), 1645);
  assert.equal(parseCodexTokenUsage("tokens used 200"), 200);
  assert.equal(parseCodexTokenUsage("no usage here"), null);
  assert.equal(parseCodexTokenUsage("tokens used\nnope"), null);
  assert.equal(parseCodexTokenUsage(""), null);
});

function captureCodexExec(state, { writeOut, stdout = "", stderr = "", error = null } = {}) {
  return (command, args, options, callback) => {
    state.command = command;
    state.args = args;
    state.cwd = options.cwd;
    state.options = options;
    state.stdinData = "";
    const outFile = args[args.indexOf("-o") + 1];
    if (writeOut !== undefined) {
      fs.writeFileSync(outFile, writeOut);
    }
    callback(error, stdout, stderr);
    return {
      stdin: {
        on() {},
        write(chunk) { state.stdinData += String(chunk); },
        end() { state.stdinEnded = true; },
      },
    };
  };
}

function fakeCodexExec(options = {}) {
  return captureCodexExec({}, options);
}
test("real codex runner: outFile output wins over stdout", async () => {
  const result = await realCodexRunner({
    prompt: "Reply with exactly: from-file",
    execFileImpl: fakeCodexExec({ writeOut: "from-file\n", stdout: "from-stdout" }),
  });
  assert.equal(result.text, "from-file");
});

test("real codex runner: falls back to stdout when outFile is empty", async () => {
  const result = await realCodexRunner({
    prompt: "Reply with exactly: from-stdout",
    execFileImpl: fakeCodexExec({ writeOut: "   ", stdout: "from-stdout\n" }),
  });
  assert.equal(result.text, "from-stdout");
});

test("real codex runner parses token usage from stdout", async () => {
  const result = await realCodexRunner({
    prompt: "Reply with exactly: usage",
    execFileImpl: fakeCodexExec({ writeOut: "usage", stdout: "codex\nusage\ntokens used\n1,653\n" }),
  });
  assert.equal(result.text, "usage");
  assert.equal(result.tokens, 1653);
  assert.equal(result.usageParsed, true);
});

test("real codex runner parses token usage from stderr when stdout lacks it", async () => {
  const result = await realCodexRunner({
    prompt: "Reply with exactly: usage",
    execFileImpl: fakeCodexExec({ writeOut: "usage", stdout: "usage", stderr: "tokens used\n42\n" }),
  });
  assert.equal(result.tokens, 42);
  assert.equal(result.usageParsed, true);
});

test("real codex runner reports no usage when codex prints none", async () => {
  const result = await realCodexRunner({
    prompt: "Reply with exactly: usage",
    execFileImpl: fakeCodexExec({ writeOut: "usage", stdout: "usage" }),
  });
  assert.equal(result.tokens, null);
  assert.equal(result.usageParsed, false);
});

test("real codex runner: empty output throws a sanitized byte-count diagnostic", async () => {
  await assert.rejects(
    () => realCodexRunner({
      prompt: "Reply with exactly: hello",
      execFileImpl: fakeCodexExec({ writeOut: "", stdout: "", stderr: "warned" }),
    }),
    (error) => {
      assert.match(error.message, /Codex produced no reply/);
      assert.match(error.message, /outFile=0B, stdout=0B, stderr=6B, errored=false, timedOut=false/);
      assert.doesNotMatch(error.message, /hello/);
      return true;
    },
  );
});

test("real codex runner: exec error reports sanitized counts without prompt/output", async () => {
  const err = new Error("spawn codex ENOENT");
  err.killed = true;
  err.signal = "SIGTERM";
  await assert.rejects(
    () => realCodexRunner({
      prompt: "Reply with exactly: secret-ish content here",
      execFileImpl: fakeCodexExec({ writeOut: "partial", stdout: "noise", stderr: "boom", error: err }),
    }),
    (error) => {
      assert.match(error.message, /Codex exec failed/);
      assert.match(error.message, /errored=true, timedOut=true/);
      assert.match(error.message, /stderr=4B/);
      assert.doesNotMatch(error.message, /secret-ish|partial|noise|boom/);
      return true;
    },
  );
});

function sequencedFetch(calls, batches) {
  let index = 0;
  return async (url, options) => {
    const method = String(url).split("/").at(-1);
    const body = JSON.parse(options.body);
    if (Array.isArray(calls)) {
      calls.push({ method, body });
    }
    if (method === "getUpdates") {
      const result = batches[index] || [];
      index += 1;
      return { ok: true, json: async () => ({ ok: true, result }) };
    }
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 99 } }) };
  };
}

function failingSendFetch(calls, firstBatch) {
  let served = false;
  return async (url, options) => {
    const method = String(url).split("/").at(-1);
    const body = JSON.parse(options.body);
    if (Array.isArray(calls)) {
      calls.push({ method, body });
    }
    if (method === "getUpdates") {
      const result = served ? [] : (firstBatch || []);
      served = true;
      return { ok: true, json: async () => ({ ok: true, result }) };
    }
    // sendMessage always fails so queued replies stay queued.
    return { ok: false, json: async () => ({ ok: false }) };
  };
}

function fakeTelegramFetch(calls, updates, { failSendAt = null } = {}) {
  let sendCount = 0;
  return async (url, options) => {
    const method = String(url).split("/").at(-1);
    const body = JSON.parse(options.body);
    calls.push({ method, body });
    if (method === "getUpdates") {
      return { ok: true, json: async () => ({ ok: true, result: updates }) };
    }
    sendCount += 1;
    if (failSendAt === sendCount) {
      return { ok: false, json: async () => ({ ok: false }) };
    }
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 99 } }) };
  };
}

function fakeExecFile(calls, response) {
  return fakeExecFileSequence(calls, [response]);
}

function fakeExecFileStdout(stdout) {
  return (_command, _args, _options, callback) => {
    const child = { stdin: fakeStdin(() => callback(null, stdout, "")) };
    return child;
  };
}

function fakeExecFileError(error) {
  return (_command, _args, _options, callback) => {
    const child = { stdin: fakeStdin(() => callback(error, "", "")) };
    return child;
  };
}

function fakeExecFileThrowingStdin() {
  return () => ({
    stdin: {
      on() {},
      end() {
        throw new Error("EPIPE secret-token");
      },
    },
  });
}

function fakeExecFileSequence(calls, responses) {
  return (command, args, options, callback) => {
    const call = { command, args, options, stdin: "" };
    calls.push(call);
    const child = { stdin: fakeStdin((value) => {
      call.stdin = String(value || "");
      const response = responses.shift() || { ok: true, result: [] };
      callback(null, JSON.stringify(response), "");
    }) };
    return child;
  };
}

function fakeStdin(onEnd) {
  return {
    on() {},
    end(value) {
      onEnd(value);
    },
  };
}

function makeAgentHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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
