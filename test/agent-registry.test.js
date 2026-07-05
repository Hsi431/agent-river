import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgentCli } from "../src/agent/cli.js";
import { agentPaths } from "../src/agent/paths.js";
import { verifyAgentToken } from "../src/agent/registry.js";
import { enableExchangeAgent, setTelegramCodexPolicy } from "../src/agent/safety.js";
import { readJsonl } from "../src/lib/jsonl.js";
import { dashboardOnce } from "../src/agent/dashboard/bot.js";
import { initializeDashboardCursor } from "../src/agent/dashboard/feed.js";

test("agent join flows through dashboard approval to an active registry row and token file", async () => {
  const agentHome = makeAgentHome("u3-join-approve-");
  setTelegramCodexPolicy(agentHome, { direct_send_user_add: "123", exchange_notify_chat_id: "456" });
  initializeDashboardCursor(agentHome);

  await runCli(["agent-join", "--state", agentHome, "--name", "otter", "--style", "poll", "--capabilities", "read,write"]);
  const pending = JSON.parse(fs.readFileSync(agentPaths(agentHome).agentRegistry, "utf8"));
  assert.equal(pending.agents.otter.status, "pending");
  assert.equal(pending.agents.otter.style, "poll");

  await assert.rejects(
    () => runCli(["agent-join", "--state", agentHome, "--name", "writer", "--style", "poll", "--capabilities", "write"]),
    /--capabilities must be read or read,write/,
  );
  await assert.rejects(
    () => runCli(["agent-join", "--state", agentHome, "--name", "otter", "--style", "poll", "--capabilities", "read"]),
    /already registered/,
  );

  const feedCalls = [];
  const first = await dashboardOnce({
    agentHome,
    token: "test-token",
    fetchImpl: sequencedTelegramFetch(feedCalls, [[]]),
  });
  const joinMessage = feedCalls.find((call) => call.method === "sendMessage" && /agent join pending otter/.test(call.body.text));
  assert.equal(first.feed.some((event) => event.kind === "join" && event.task_id === null), true);
  assert.equal(joinMessage.body.reply_markup.inline_keyboard[0][0].callback_data, "join:approve:otter");
  assert.equal(joinMessage.body.reply_markup.inline_keyboard[0][1].callback_data, "join:reject:otter");

  const callbackCalls = [];
  await dashboardOnce({
    agentHome,
    token: "test-token",
    fetchImpl: sequencedTelegramFetch(callbackCalls, [[
      telegramCallbackUpdate({ updateId: 10, fromId: 999, chatId: 456, data: "join:approve:otter" }),
      telegramCallbackUpdate({ updateId: 11, fromId: 123, chatId: 456, data: "join:approve:otter" }),
    ]]),
  });
  const answers = callbackCalls.filter((call) => call.method === "answerCallbackQuery").map((call) => call.body.text);
  assert.equal(answers[0], "唯讀");
  assert.match(answers[1], /已核准 otter, token 已落檔/);

  const registry = JSON.parse(fs.readFileSync(agentPaths(agentHome).agentRegistry, "utf8"));
  const tokenFile = path.join(agentPaths(agentHome).agentTokensDir, "otter.token");
  assert.equal(registry.agents.otter.status, "active");
  assert.equal(typeof registry.agents.otter.approved_at, "string");
  assert.equal(fs.existsSync(tokenFile), true);
  assert.equal(fs.statSync(agentPaths(agentHome).agentTokensDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(registry).includes(fs.readFileSync(tokenFile, "utf8").trim()), false);
  assert.equal(JSON.stringify(callbackCalls).includes(fs.readFileSync(tokenFile, "utf8").trim()), false);
  assert.equal(verifyAgentToken(agentHome, "otter", "short"), false);
});

test("poll agents need a valid token for submit and agent-opened sessions", async () => {
  const agentHome = makeAgentHome("u3-token-gate-");
  const tokenFile = await approvePollAgent(agentHome, "otter");
  const badToken = path.join(agentHome, "bad.token");
  fs.writeFileSync(badToken, "not-the-token\n");

  await assert.rejects(
    () => runCli(["exchange-submit", "--state", agentHome, "--from", "otter", "--to", "codex", "--text", "U3 missing token submit."]),
    (error) => error.code === "bad_agent_token",
  );
  await assert.rejects(
    () => runCli(["exchange-submit", "--state", agentHome, "--from", "otter", "--to", "codex", "--token-file", badToken, "--text", "U3 bad token submit."]),
    (error) => error.code === "bad_agent_token",
  );
  assert.equal(readJsonl(agentPaths(agentHome).exchangeMessages).length, 0);

  const submitted = await runCli(["exchange-submit", "--state", agentHome, "--from", "otter", "--to", "codex", "--token-file", tokenFile, "--text", "U3 valid token submit."]);
  assert.equal(submitted.message.from, "otter");
  assert.equal(readJsonl(agentPaths(agentHome).exchangeMessages).length, 1);

  await assert.rejects(
    () => runCli([
      "session-open", "--state", agentHome,
      "--initiator", "agent:otter",
      "--participants", "codex",
      "--topic", "U3 missing token session open should fail.",
    ]),
    (error) => error.code === "bad_agent_token",
  );
  await assert.rejects(
    () => runCli([
      "session-open", "--state", agentHome,
      "--initiator", "agent:ghost",
      "--participants", "codex",
      "--topic", "U3 unregistered session open should fail.",
    ]),
    (error) => error.code === "agent_not_registered",
  );
  assert.equal(readJsonl(agentPaths(agentHome).sessions).length, 0);

  const session = await runCli([
    "session-open", "--state", agentHome,
    "--initiator", "agent:otter",
    "--participants", "codex",
    "--token-file", tokenFile,
    "--topic", "U3 valid token session open succeeds.",
  ]);
  assert.deepEqual(session.session.participants, ["codex", "otter"]);
});

test("poll agents need a valid token for inbox claim and reply", async () => {
  const agentHome = makeAgentHome("u3-token-mailbox-");
  const tokenFile = await approvePollAgent(agentHome, "otter");
  const badToken = path.join(agentHome, "bad.token");
  fs.writeFileSync(badToken, "bad\n");
  const message = await runCli(["exchange-submit", "--state", agentHome, "--from", "owner", "--to", "otter", "--text", "U3 mailbox token test."]);

  await assert.rejects(
    () => runCli(["exchange-inbox", "--state", agentHome, "--agent", "otter", "--token-file", badToken]),
    (error) => error.code === "bad_agent_token",
  );
  const inbox = await runCli(["exchange-inbox", "--state", agentHome, "--agent", "otter", "--token-file", tokenFile]);
  assert.equal(inbox.messages.length, 1);

  await assert.rejects(
    () => runCli(["exchange-claim", "--state", agentHome, "--id", message.message.id, "--agent", "otter"]),
    (error) => error.code === "bad_agent_token",
  );
  const claimed = await runCli(["exchange-claim", "--state", agentHome, "--id", message.message.id, "--agent", "otter", "--token-file", tokenFile]);
  assert.equal(claimed.message.claim.agent_id, "otter");

  await assert.rejects(
    () => runCli(["exchange-reply", "--state", agentHome, "--id", message.message.id, "--agent", "otter", "--token-file", badToken, "--text", "bad token reply"]),
    (error) => error.code === "bad_agent_token",
  );
  const replied = await runCli(["exchange-reply", "--state", agentHome, "--id", message.message.id, "--agent", "otter", "--token-file", tokenFile, "--text", "valid token reply"]);
  assert.equal(replied.reply.agent_id, "otter");
});

test("registry-seeded spawn agents and owner paths do not require tokens", async () => {
  const agentHome = makeAgentHome("u3-spawn-owner-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });

  const seeded = await runCli(["registry-seed", "--state", agentHome]);
  assert.deepEqual(seeded.seeded, ["codex", "opus"]);
  assert.equal(fs.existsSync(path.join(agentPaths(agentHome).agentTokensDir, "codex.token")), false);

  const ownerMessage = await runCli(["exchange-submit", "--state", agentHome, "--from", "codex", "--to", "opus", "--text", "U3 spawn submit no token."]);
  const claimed = await runCli(["exchange-claim", "--state", agentHome, "--id", ownerMessage.message.id, "--agent", "opus"]);
  assert.equal(claimed.message.claim.agent_id, "opus");

  const session = await runCli([
    "session-open", "--state", agentHome,
    "--initiator", "owner",
    "--participants", "codex,opus",
    "--topic", "U3 owner session with seeded spawn agents.",
  ]);
  assert.deepEqual(session.session.participants, ["codex", "opus"]);
});

async function approvePollAgent(agentHome, name) {
  setTelegramCodexPolicy(agentHome, { direct_send_user_add: "123" });
  await runCli(["agent-join", "--state", agentHome, "--name", name, "--style", "poll", "--capabilities", "read,write"]);
  await dashboardOnce({
    agentHome,
    token: "test-token",
    fetchImpl: sequencedTelegramFetch([], [[telegramCallbackUpdate({ updateId: 1, fromId: 123, chatId: 456, data: `join:approve:${name}` })]]),
  });
  return path.join(agentPaths(agentHome).agentTokensDir, `${name}.token`);
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
