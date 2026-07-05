import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgentCli } from "../src/agent/cli.js";
import { dashboardOnce } from "../src/agent/dashboard/bot.js";
import { initializeDashboardCursor } from "../src/agent/dashboard/feed.js";
import { kickoffSession, submitExchangeMessage } from "../src/agent/exchange.js";
import { runExecRunnerOnce, pickEligibleExecMessage } from "../src/agent/exec-runner.js";
import { agentPaths } from "../src/agent/paths.js";
import { setTelegramCodexPolicy } from "../src/agent/safety.js";
import { openSession } from "../src/agent/sessions.js";
import { buildExecRunnerService } from "../src/agent/service.js";
import { readJsonl } from "../src/lib/jsonl.js";

test("exec join approval stores command, dashboard feed shows command, and no token is written", async () => {
  const agentHome = makeAgentHome("u7-exec-join-");
  const command = catCommand();
  setTelegramCodexPolicy(agentHome, { direct_send_user_add: "123", exchange_notify_chat_id: "456" });
  initializeDashboardCursor(agentHome);

  await runCli([
    "agent-join", "--state", agentHome,
    "--name", "echo",
    "--style", "exec",
    "--exec", command,
    "--exec-timeout-seconds", "7",
  ]);
  const pending = JSON.parse(fs.readFileSync(agentPaths(agentHome).agentRegistry, "utf8"));
  assert.equal(pending.agents.echo.style, "exec");
  assert.equal(pending.agents.echo.exec_command, command);
  assert.equal(pending.agents.echo.exec_timeout_seconds, 7);
  assert.deepEqual(pending.agents.echo.capabilities, ["read"]);

  const feedCalls = [];
  await dashboardOnce({
    agentHome,
    token: "test-token",
    fetchImpl: sequencedTelegramFetch(feedCalls, [[]]),
  });
  const joinMessage = feedCalls.find((call) => call.method === "sendMessage" && /agent join pending echo/.test(call.body.text));
  assert.ok(joinMessage.body.text.includes(command), "join feed must include the full exec command");

  const callbackCalls = [];
  await dashboardOnce({
    agentHome,
    token: "test-token",
    fetchImpl: sequencedTelegramFetch(callbackCalls, [[
      telegramCallbackUpdate({ updateId: 10, fromId: 123, chatId: 456, data: "join:approve:echo" }),
    ]]),
  });
  const registry = JSON.parse(fs.readFileSync(agentPaths(agentHome).agentRegistry, "utf8"));
  const answers = callbackCalls.filter((call) => call.method === "answerCallbackQuery").map((call) => call.body.text);

  assert.equal(registry.agents.echo.status, "active");
  assert.equal(fs.existsSync(path.join(agentPaths(agentHome).agentTokensDir, "echo.token")), false);
  assert.match(answers[0], /Node 代管,不產 token/);
});

test("exec runner processes a session message through stdin/stdout and relays the reply", async () => {
  const agentHome = makeAgentHome("u7-exec-session-");
  await approveExecAgent(agentHome, "echo", catCommand());
  const session = await openSession({
    agentHome,
    initiator: "owner",
    participants: "codex,echo",
    budgetMessages: 6,
    topic: "U7 exec session topic reaches stdin.",
  });
  kickoffSession({ agentHome, session });

  const result = await runExecRunnerOnce({ agentHome, repoDir: process.cwd() });
  const replies = readJsonl(agentPaths(agentHome).exchangeReplies);
  const messages = readJsonl(agentPaths(agentHome).exchangeMessages);
  const relayed = messages.find((row) => row.id === result.results[0].relay_message_id);
  const envelope = JSON.parse(replies[0].text);

  assert.equal(result.results[0].reason, "replied");
  assert.equal(replies.length, 1);
  assert.equal(replies[0].agent_id, "echo");
  assert.equal(envelope.sender, "owner");
  assert.equal(envelope.session_topic, "U7 exec session topic reaches stdin.");
  assert.equal(envelope.text, "U7 exec session topic reaches stdin.");
  assert.equal(relayed.from, "echo");
  assert.equal(relayed.to, "codex");
});

test("exec runner times out a real detached process group and releases the claim", async () => {
  const agentHome = makeAgentHome("u7-exec-timeout-");
  const marker = path.join(agentHome, "term-marker");
  const code = [
    "const fs=require('node:fs');",
    `process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(marker)},'term');process.exit(0);});`,
    "setInterval(()=>{},1000);",
  ].join("");
  await approveExecAgent(agentHome, "sleepy", `${sh(process.execPath)} -e ${sh(code)}`, { timeoutSeconds: 1 });
  const message = submitExchangeMessage({
    agentHome,
    from: "codex",
    to: "sleepy",
    channel: "telegram",
    text: "U7 timeout should release claim.",
  });

  const result = await runExecRunnerOnce({ agentHome, repoDir: process.cwd() });
  const claims = readJsonl(agentPaths(agentHome).exchangeClaims).filter((row) => row.message_id === message.id);
  const dispatch = readJsonl(agentPaths(agentHome).execRunnerDispatch).at(-1);

  assert.equal(result.results[0].reason, "timed_out_released");
  assert.equal(claims.at(-1).status, "released");
  assert.equal(dispatch.agent, "sleepy");
  assert.equal(dispatch.outcome, "timed_out_released");
  assert.equal(fs.readFileSync(marker, "utf8"), "term");
});

test("exec runner truncates stdout to 64KB before writing the reply", async () => {
  const agentHome = makeAgentHome("u7-exec-truncate-");
  await approveExecAgent(agentHome, "bigout", "dd if=/dev/zero bs=1024 count=70 2>/dev/null | tr '\\0' X");
  submitExchangeMessage({
    agentHome,
    from: "codex",
    to: "bigout",
    channel: "telegram",
    text: "U7 truncate stdout.",
  });

  const result = await runExecRunnerOnce({ agentHome, repoDir: process.cwd() });
  const reply = readJsonl(agentPaths(agentHome).exchangeReplies)[0];

  assert.equal(result.results[0].reason, "replied");
  assert.equal(Buffer.byteLength(reply.text, "utf8"), 64 * 1024);
  assert.equal(reply.text, "X".repeat(64 * 1024));
});

test("exec runner stops picking a message after two failed attempts", async () => {
  const agentHome = makeAgentHome("u7-exec-attempts-");
  await approveExecAgent(agentHome, "failbot", `${sh(process.execPath)} -e ${sh("process.exit(2)")}`);
  const message = submitExchangeMessage({
    agentHome,
    from: "codex",
    to: "failbot",
    channel: "telegram",
    text: "U7 fail twice then stop.",
  });

  const first = await runExecRunnerOnce({ agentHome, repoDir: process.cwd() });
  const second = await runExecRunnerOnce({ agentHome, repoDir: process.cwd() });
  const third = await runExecRunnerOnce({ agentHome, repoDir: process.cwd() });
  const dispatch = readJsonl(agentPaths(agentHome).execRunnerDispatch)
    .filter((row) => row.agent === "failbot" && row.message_id === message.id);
  const claims = readJsonl(agentPaths(agentHome).exchangeClaims).filter((row) => row.message_id === message.id);

  assert.equal(first.results[0].attempt, 1);
  assert.equal(second.results[0].attempt, 2);
  assert.equal(third.results[0].reason, "no_eligible_message");
  assert.equal(pickEligibleExecMessage(agentHome, "failbot"), null);
  assert.deepEqual(dispatch.map((row) => row.outcome), ["failed_released", "failed_released"]);
  assert.equal(claims.at(-1).status, "released");
});

test("exec runner service generator writes a 90 second timer unit", () => {
  const agentHome = makeAgentHome("u7-exec-service-");
  const built = buildExecRunnerService({ agentHome, repoDir: process.cwd() });

  assert.equal(built.unit_name, "codex-agent-exec-runner.service");
  assert.equal(built.timer_name, "codex-agent-exec-runner.timer");
  assert.equal(built.interval_seconds, 90);
  assert.match(built.unit, /exec-runner-once/);
  assert.match(built.timer, /OnUnitActiveSec=90s/);
  assert.doesNotMatch(built.unit, /systemctl/);
});

async function approveExecAgent(agentHome, name, command, { timeoutSeconds = 5 } = {}) {
  setTelegramCodexPolicy(agentHome, { direct_send_user_add: "123" });
  await runCli([
    "agent-join", "--state", agentHome,
    "--name", name,
    "--style", "exec",
    "--exec", command,
    "--exec-timeout-seconds", String(timeoutSeconds),
  ]);
  await dashboardOnce({
    agentHome,
    token: "test-token",
    fetchImpl: sequencedTelegramFetch([], [[
      telegramCallbackUpdate({ updateId: 1, fromId: 123, chatId: 456, data: `join:approve:${name}` }),
    ]]),
  });
}

async function runCli(argv) {
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));
  try {
    await runAgentCli(argv);
  } finally {
    console.log = originalLog;
  }
  return lines[0] ? JSON.parse(lines[0]) : null;
}

function makeAgentHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function catCommand() {
  return "cat";
}

function sh(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
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
