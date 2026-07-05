import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgentCli } from "../src/agent/cli.js";
import { agentPaths } from "../src/agent/paths.js";
import { allowGatewayUser, enableExchangeAgent, setTelegramCodexPolicy } from "../src/agent/safety.js";
import { openSession } from "../src/agent/sessions.js";
import { claimExchangeMessage, replyExchangeMessage, submitExchangeMessage } from "../src/agent/exchange.js";
import { createDispatchApproval } from "../src/agent/dispatch.js";
import { createTask, readTask } from "../src/agent/tasks.js";
import { readJsonl } from "../src/lib/jsonl.js";
import { acquireDashboardLock, dashboardOnce, releaseDashboardLock } from "../src/agent/dashboard/bot.js";
import { initializeDashboardCursor } from "../src/agent/dashboard/feed.js";
import { buildDashboardService } from "../src/agent/service.js";
import { appendV2Outbox, latestV2Outbox } from "../src/agent/v2/poller.js";

test("dashboard feed cursor sends new session, exchange, and gate events once", async () => {
  const agentHome = makeAgentHome("codex-agent-dashboard-feed-");
  setTelegramCodexPolicy(agentHome, { direct_send_user_add: "123", exchange_notify_chat_id: "456" });
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  initializeDashboardCursor(agentHome);

  const session = await openSession({
    agentHome,
    initiator: "owner",
    participants: "codex,opus",
    budgetMessages: 6,
    budgetMinutes: 20,
    topic: "U2 dashboard feed token unique session opening.",
  });
  const message = submitExchangeMessage({
    agentHome,
    from: "codex",
    to: "opus",
    sessionId: session.session_id,
    text: "U2_DASHBOARD_FEED_MESSAGE_TOKEN request body",
  });
  claimExchangeMessage({ agentHome, id: message.id, agent: "opus" });
  replyExchangeMessage({
    agentHome,
    id: message.id,
    agent: "opus",
    text: "U2_DASHBOARD_FEED_REPLY_TOKEN response body",
  });
  const task = createTask({
    agentHome,
    repo: process.cwd(),
    request: "U2_DASHBOARD_GATE_TOKEN approve this edit gate.",
    mode: "edit",
  });

  const firstCalls = [];
  const first = await dashboardOnce({
    agentHome,
    token: "test-token",
    fetchImpl: sequencedTelegramFetch(firstCalls, [[]]),
  });
  const sentTexts = firstCalls.filter((call) => call.method === "sendMessage").map((call) => call.body.text);

  assert.equal(first.feed.length, 4);
  assert.equal(sentTexts.some((text) => /開場/.test(text)), true);
  assert.equal(sentTexts.some((text) => /U2_DASHBOARD_FEED_MESSAGE_TOKEN/.test(text)), true);
  assert.equal(sentTexts.some((text) => /U2_DASHBOARD_FEED_REPLY_TOKEN/.test(text)), true);
  assert.equal(sentTexts.some((text) => text.includes(task.id) && /U2_DASHBOARD_GATE_TOKEN/.test(text)), true);
  assert.equal(firstCalls.find((call) => call.body.reply_markup)?.body.reply_markup.inline_keyboard[0][0].callback_data, `gate:approve:${task.id}`);

  const secondCalls = [];
  const second = await dashboardOnce({
    agentHome,
    token: "test-token",
    fetchImpl: sequencedTelegramFetch(secondCalls, [[]]),
  });
  assert.equal(second.feed.length, 0);
  assert.equal(secondCalls.filter((call) => call.method === "sendMessage").length, 0);

  const restartCalls = [];
  const restart = await dashboardOnce({
    agentHome,
    token: "test-token",
    fetchImpl: sequencedTelegramFetch(restartCalls, [[]]),
  });
  assert.equal(restart.feed.length, 0);
  assert.equal(restartCalls.filter((call) => call.method === "sendMessage").length, 0);
});

test("dashboard /session command opens real session ledger rows with accepted separators", async () => {
  const agentHome = makeAgentHome("codex-agent-dashboard-session-");
  setTelegramCodexPolicy(agentHome, { direct_send_user_add: "123" });
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  const calls = [];

  const result = await dashboardOnce({
    agentHome,
    token: "test-token",
    fetchImpl: sequencedTelegramFetch(calls, [[
      telegramMessageUpdate({
        updateId: 10,
        fromId: 123,
        chatId: 456,
        text: "/session codex,opus budget=3/9 write=codex -- U2_DASHBOARD_SESSION_OPEN_TOKEN topic body.",
      }),
      telegramMessageUpdate({
        updateId: 11,
        fromId: 123,
        chatId: 456,
        text: "/session codex,opus — U6_DASHBOARD_SESSION_EM_DASH topic body.",
      }),
      telegramMessageUpdate({
        updateId: 12,
        fromId: 123,
        chatId: 456,
        text: "/session codex,opus – U6_DASHBOARD_SESSION_EN_DASH topic body.",
      }),
    ]]),
  });
  const rows = readJsonl(agentPaths(agentHome).sessions);
  const opened = rows.filter((row) => row.event === "session_opened");
  const kickoffRows = rows.filter((row) => row.event === "session_message");
  const replies = calls.filter((call) => call.method === "sendMessage").map((call) => call.body.text);

  assert.equal(result.updates, 3);
  assert.equal(replies.every((reply) => /session #[a-f0-9]{6} 開場/.test(reply)), true);
  assert.equal(replies.every((reply) => /已開球 2 封\(2\//.test(reply)), true);
  assert.equal(opened.length, 3);
  assert.equal(opened[0].topic, "U2_DASHBOARD_SESSION_OPEN_TOKEN topic body.");
  assert.deepEqual(opened[0].write_access, ["codex"]);
  assert.deepEqual(opened[0].budget, { max_messages: 3, max_minutes: 9 });
  assert.equal(opened[1].topic, "U6_DASHBOARD_SESSION_EM_DASH topic body.");
  assert.equal(opened[2].topic, "U6_DASHBOARD_SESSION_EN_DASH topic body.");
  assert.equal(kickoffRows.length, 6);
  assert.equal(kickoffRows.every((row) => row.from === "owner"), true);
});

test("dashboard rejects non-owner messages and strict parser failures", async () => {
  const agentHome = makeAgentHome("codex-agent-dashboard-deny-");
  setTelegramCodexPolicy(agentHome, { direct_send_user_add: "123" });
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  const calls = [];

  await dashboardOnce({
    agentHome,
    token: "test-token",
    fetchImpl: sequencedTelegramFetch(calls, [[
      telegramMessageUpdate({ updateId: 20, fromId: 999, chatId: 456, text: "/sessions" }),
      telegramMessageUpdate({ updateId: 21, fromId: 123, chatId: 456, text: "/session codex,opus missing separator" }),
      telegramMessageUpdate({ updateId: 22, fromId: 123, chatId: 456, text: "old v1 text" }),
    ]]),
  });
  const sent = calls.filter((call) => call.method === "sendMessage").map((call) => call.body.text);

  assert.equal(sent[0], "唯讀");
  assert.match(sent[1], /^找不到題目分隔符,參與者後面接 ` -- `\(兩個減號\)再接題目;直接打 — 也可以\n用法:\/session/);
  assert.equal(sent[2], "這是 v3 看板,指令:/session /sessions /kill /agents /model");
  assert.equal(fs.existsSync(agentPaths(agentHome).sessions), false);
});

test("dashboard /session reports validation errors with concrete details", async () => {
  const agentHome = makeAgentHome("codex-agent-dashboard-session-errors-");
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-session-ws-"));
  setTelegramCodexPolicy(agentHome, {
    direct_send_user_add: "123",
    workspace_root: workspace,
  });
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  const calls = [];

  await dashboardOnce({
    agentHome,
    token: "test-token",
    fetchImpl: sequencedTelegramFetch(calls, [[
      telegramMessageUpdate({ updateId: 23, fromId: 123, chatId: 456, text: "/session codex,opus -- abcd" }),
      telegramMessageUpdate({ updateId: 24, fromId: 123, chatId: 456, text: "/session codex,foo -- abcde" }),
      telegramMessageUpdate({ updateId: 25, fromId: 123, chatId: 456, text: "/session codex,opus budget=bad -- abcde" }),
      telegramMessageUpdate({ updateId: 26, fromId: 123, chatId: 456, text: "/session codex,opus repo=missing -- abcde" }),
      telegramMessageUpdate({ updateId: 27, fromId: 123, chatId: 456, text: "/session  -- abcde" }),
      telegramMessageUpdate({ updateId: 28, fromId: 123, chatId: 456, text: "/session codex,opus nope=1 -- abcde" }),
    ]]),
  });
  const sent = calls.filter((call) => call.method === "sendMessage").map((call) => call.body.text);

  assert.match(sent[0], /^題目太短:4 字,owner 開場至少 5 字\n用法:\/session/);
  assert.match(sent[1], /^參與者 foo 未註冊,現有:codex,opus\n用法:\/session/);
  assert.match(sent[2], /^預算格式錯誤:bad,請用 N\/M\n用法:\/session/);
  assert.match(sent[3], /^repo 解析失敗:missing,原因:找不到 repo\n用法:\/session/);
  assert.match(sent[4], /^缺參與者,範例:\/session codex,opus -- 題目\n用法:\/session/);
  assert.match(sent[5], /^看不懂的選項:nope=1,可用:repo= budget= write=\n用法:\/session/);
  assert.equal(fs.existsSync(agentPaths(agentHome).sessions), false);
});

test("dashboard /model displays and updates runner policy for owners only", async () => {
  const agentHome = makeAgentHome("codex-agent-dashboard-model-");
  setTelegramCodexPolicy(agentHome, { direct_send_user_add: "123" });
  const calls = [];

  await dashboardOnce({
    agentHome,
    token: "test-token",
    fetchImpl: sequencedTelegramFetch(calls, [[
      telegramMessageUpdate({ updateId: 27, fromId: 123, chatId: 456, text: "/model" }),
      telegramMessageUpdate({ updateId: 28, fromId: 123, chatId: 456, text: "/model claude sonnet" }),
      telegramMessageUpdate({ updateId: 29, fromId: 123, chatId: 456, text: "/model codex gpt-5-codex" }),
      telegramMessageUpdate({ updateId: 30, fromId: 999, chatId: 456, text: "/model claude opus" }),
      telegramMessageUpdate({ updateId: 31, fromId: 123, chatId: 456, text: "/model opus opus" }),
      telegramMessageUpdate({ updateId: 32, fromId: 123, chatId: 456, text: "/model claude llama" }),
      telegramMessageUpdate({ updateId: 33, fromId: 123, chatId: 456, text: "/model" }),
    ]]),
  });
  const sent = calls.filter((call) => call.method === "sendMessage").map((call) => call.body.text);
  const config = JSON.parse(fs.readFileSync(agentPaths(agentHome).config, "utf8"));

  assert.equal(sent[0], "claude runner(信箱名 opus): sonnet\ncodex runner: (codex CLI 預設)");
  assert.equal(sent[1], "claude runner 已設為 sonnet");
  assert.equal(sent[2], "codex runner 已設為 gpt-5-codex");
  assert.equal(sent[3], "唯讀");
  assert.equal(sent[4], "claude runner 已設為 opus");
  assert.match(sent[5], /^設定失敗:--exchange-runner-model must be default, sonnet, or opus/);
  assert.equal(sent[6], "claude runner(信箱名 opus): opus\ncodex runner: gpt-5-codex");
  assert.equal(config.telegram_codex_policy.exchange_runner_model, "opus");
  assert.equal(config.telegram_codex_policy.codex_runner_model, "gpt-5-codex");
});

test("dashboard routes owner @agent messages through v2 and flushes the background outbox", async () => {
  const agentHome = makeAgentHome("codex-agent-dashboard-v2-");
  setTelegramCodexPolicy(agentHome, {
    direct_send_user_add: "123",
    default_repo: process.cwd(),
    v2_enabled: true,
  });
  const calls = [];
  const backgroundRuns = [];

  const result = await dashboardOnce({
    agentHome,
    token: "test-token",
    fetchImpl: sequencedTelegramFetch(calls, [[telegramMessageUpdate({
      updateId: 23,
      fromId: 123,
      chatId: 456,
      text: "@claude -- DASHBOARD_V2_PROMPT_TOKEN",
    })]]),
    v2Options: {
      adapters: {
        claude: {
          async run(args) {
            assert.equal(args.prompt, "DASHBOARD_V2_PROMPT_TOKEN");
            return {
              ok: true,
              text: "DASHBOARD_V2_OUTBOX_TOKEN",
              sessionId: "dash_v2_session",
              tokens: 7,
              outcome: "ok",
            };
          },
        },
      },
      backgroundImpl(fn) {
        backgroundRuns.push(fn());
      },
    },
  });
  await Promise.all(backgroundRuns);
  const sent = calls.filter((call) => call.method === "sendMessage").map((call) => call.body.text);

  assert.equal(result.handled[0].reason, "v2");
  assert.equal(result.v2_outbox.length, 1);
  assert.match(sent[0], /claude.*mode=read.*session=new/s);
  assert.equal(sent[1], "DASHBOARD_V2_OUTBOX_TOKEN");
  assert.equal(latestV2Outbox(agentHome).filter((entry) => entry.status === "queued").length, 0);
});

test("dashboard rejects gateway-only users for commands and gate callbacks", async () => {
  const agentHome = makeAgentHome("codex-agent-dashboard-gateway-only-");
  setTelegramCodexPolicy(agentHome, { direct_send_user_add: "123" });
  allowGatewayUser(agentHome, "999");
  const task = createTask({
    agentHome,
    repo: process.cwd(),
    request: "U2_DASHBOARD_GATEWAY_ONLY_TOKEN edit task.",
    mode: "edit",
  });
  const before = readTask(agentHome, task.id);
  const calls = [];

  await dashboardOnce({
    agentHome,
    token: "test-token",
    fetchImpl: sequencedTelegramFetch(calls, [[
      telegramMessageUpdate({ updateId: 25, fromId: 999, chatId: 456, text: "/sessions" }),
      telegramCallbackUpdate({ updateId: 26, fromId: 999, chatId: 456, data: `gate:approve:${task.id}` }),
    ]]),
  });
  const sent = calls.filter((call) => call.method === "sendMessage").map((call) => call.body.text);
  const answers = calls.filter((call) => call.method === "answerCallbackQuery").map((call) => call.body.text);
  const after = readTask(agentHome, task.id);

  assert.equal(sent[0], "唯讀");
  assert.equal(answers[0], "唯讀");
  assert.equal(after.status, before.status);
  assert.equal(after.approval, before.approval);
});

test("dashboard gate callbacks approve tasks and reject non-owner callbacks", async () => {
  const agentHome = makeAgentHome("codex-agent-dashboard-callback-");
  setTelegramCodexPolicy(agentHome, { direct_send_user_add: "123" });
  const approved = createTask({
    agentHome,
    repo: process.cwd(),
    request: "U2_DASHBOARD_CALLBACK_APPROVE_TOKEN edit task.",
    mode: "edit",
  });
  const rejected = createTask({
    agentHome,
    repo: process.cwd(),
    request: "U2_DASHBOARD_CALLBACK_REJECT_TOKEN edit task.",
    mode: "edit",
  });
  const calls = [];

  await dashboardOnce({
    agentHome,
    token: "test-token",
    fetchImpl: sequencedTelegramFetch(calls, [[
      telegramCallbackUpdate({ updateId: 30, fromId: 999, chatId: 456, data: `gate:approve:${approved.id}` }),
      telegramCallbackUpdate({ updateId: 31, fromId: 123, chatId: 456, data: `gate:approve:${approved.id}` }),
      telegramCallbackUpdate({ updateId: 32, fromId: 123, chatId: 456, data: `gate:reject:${rejected.id}` }),
    ]]),
  });
  const answers = calls.filter((call) => call.method === "answerCallbackQuery").map((call) => call.body.text);

  assert.equal(answers[0], "唯讀");
  assert.match(answers[1], /已放行/);
  assert.match(answers[2], /已拒絕/);
  assert.equal(readTask(agentHome, approved.id).approval, "approved");
  assert.equal(readTask(agentHome, rejected.id).approval, "rejected");
});

test("dashboard cycle flushes v2, exchange, and dispatch notifications from real ledgers", async () => {
  const agentHome = makeAgentHome("codex-agent-dashboard-flush-");
  setTelegramCodexPolicy(agentHome, {
    direct_send_user_add: "123",
    exchange_notify_enabled: true,
    exchange_notify_chat_id: "456",
  });
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  appendV2Outbox(agentHome, {
    id: "v2_dashboard_flush",
    chat_id: "456",
    text: "DASHBOARD_FLUSH_V2_TOKEN",
    status: "queued",
    created_at: new Date().toISOString(),
  });
  const message = submitExchangeMessage({
    agentHome,
    from: "codex",
    to: "opus",
    channel: "telegram",
    chatId: "456",
    text: "DASHBOARD_FLUSH_EXCHANGE_REQUEST_TOKEN",
  });
  claimExchangeMessage({ agentHome, id: message.id, agent: "opus" });
  replyExchangeMessage({
    agentHome,
    id: message.id,
    agent: "opus",
    text: "DASHBOARD_FLUSH_EXCHANGE_REPLY_TOKEN",
  });
  const dispatch = createDispatchApproval({
    agentHome,
    proposedBy: "opus",
    proposal: {
      to: "codex",
      task: "Implement the dashboard dispatch flush regression coverage.",
      reason: "Dashboard now owns Telegram notification flushing.",
      suggested_mode: "plan",
    },
    parentMsgId: "msg_parent",
    chatId: "456",
  });
  initializeDashboardCursor(agentHome);
  const calls = [];

  const result = await dashboardOnce({
    agentHome,
    token: "test-token",
    fetchImpl: sequencedTelegramFetch(calls, [[]]),
  });
  const sent = calls.filter((call) => call.method === "sendMessage");
  const texts = sent.map((call) => call.body.text);

  assert.equal(result.v2_outbox[0].id, "v2_dashboard_flush");
  assert.equal(result.v2_outbox[0].sent, true);
  assert.equal(result.exchange_notifications[0].message_id, message.id);
  assert.equal(result.exchange_notifications[0].sent, true);
  assert.equal(result.dispatch_notifications[0].id, dispatch.approval.id);
  assert.equal(result.dispatch_notifications[0].sent, true);
  assert.equal(texts.some((text) => text === "DASHBOARD_FLUSH_V2_TOKEN"), true);
  assert.equal(texts.some((text) => /DASHBOARD_FLUSH_EXCHANGE_REPLY_TOKEN/.test(text)), true);
  assert.equal(texts.some((text) => /待核准跨 agent 派工/.test(text)), true);
  assert.equal(readJsonl(agentPaths(agentHome).exchangeNotifications).length, 1);
  assert.equal(readJsonl(agentPaths(agentHome).dispatchApprovals).at(-1).notified_at !== undefined, true);
  assert.equal(latestV2Outbox(agentHome).find((entry) => entry.id === "v2_dashboard_flush").status, "sent");
});

test("dashboard service generator writes only a unit and dashboard lock refuses a live second owner", async () => {
  const agentHome = makeAgentHome("codex-agent-dashboard-service-");
  const built = buildDashboardService({ agentHome, repoDir: process.cwd(), longPollSeconds: 7 });

  assert.equal(built.unit_name, "codex-agent-dashboard.service");
  assert.match(built.unit, /dashboard-bridge/);
  assert.match(built.unit, /--long-poll-seconds 7/);
  assert.doesNotMatch(built.unit, /systemctl/);

  const lockPath = acquireDashboardLock(agentHome);
  assert.equal(lockPath, agentPaths(agentHome).dashboardLock);
  assert.throws(() => acquireDashboardLock(agentHome), /already running/);
  releaseDashboardLock(agentHome);
  assert.equal(fs.existsSync(lockPath), false);
});

test("dashboard CLI exposes dashboard-once and service-write", async () => {
  const agentHome = makeAgentHome("codex-agent-dashboard-cli-");
  const serviceDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agent-dashboard-service-dir-"));
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));
  try {
    await runAgentCli([
      "dashboard-service-write",
      "--state", agentHome,
      "--dir", serviceDir,
      "--repo", process.cwd(),
      "--long-poll-seconds", "8",
    ]);
  } finally {
    console.log = originalLog;
  }
  const result = JSON.parse(lines[0]);

  assert.equal(result.unit_name, "codex-agent-dashboard.service");
  assert.equal(fs.existsSync(path.join(serviceDir, "codex-agent-dashboard.service")), true);
  assert.equal(fs.existsSync(path.join(serviceDir, "codex-agent-dashboard.timer")), false);
});

function makeAgentHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function telegramMessageUpdate({ updateId = 1, fromId, chatId, text }) {
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
  return {
    update_id: updateId,
    callback_query: {
      id: `cb_${updateId}`,
      from: { id: fromId },
      data,
      message: { message_id: 10, chat: { id: chatId } },
    },
  };
}

function sequencedTelegramFetch(calls, updateBatches) {
  let index = 0;
  return async (url, options) => {
    const method = String(url).split("/").at(-1);
    const body = JSON.parse(options.body);
    calls.push({ method, body });
    if (method === "getUpdates") {
      const result = updateBatches[Math.min(index, updateBatches.length - 1)] || [];
      index += 1;
      return { ok: true, json: async () => ({ ok: true, result }) };
    }
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 99 } }) };
  };
}
