import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleTelegramUpdate } from "../src/agent/telegram.js";
import { makeClaudeAdapter, makeCodexAdapter } from "../src/agent/v2/agent-adapter.js";
import { setTelegramCodexPolicy } from "../src/agent/safety.js";

function makeAgentHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function msgUpdate({ updateId = 1, fromId, chatId, text }) {
  return { update_id: updateId, message: { message_id: 5, from: { id: fromId }, chat: { id: chatId }, text } };
}

function makeOwner(agentHome, userId, extra = {}) {
  setTelegramCodexPolicy(agentHome, {
    direct_send_enabled: true,
    direct_send_user_add: String(userId),
    owner_mode_enabled: true,
    ...extra,
  });
}

// §12.2 — the spawn must put the agent in its own process group so abort /
// kill-switch can SIGTERM the whole group, not just the direct child.
test("v2 Claude adapter spawns detached (own process group)", async () => {
  let opts = null;
  const fakeExec = (file, args, options, cb) => {
    opts = options;
    cb(null, JSON.stringify({ result: "ok", session_id: "s1" }), "");
    return { stdin: { on() {}, end() {} } };
  };
  const adapter = makeClaudeAdapter({ agentHome: makeAgentHome("v2-detached-claude-") });
  await adapter.run({ repoToplevel: "/tmp/x", mode: "read", prompt: "hi", execFileImpl: fakeExec });
  assert.equal(opts.detached, true);
});

test("v2 Codex adapter spawns detached (own process group)", async () => {
  let opts = null;
  const fakeExec = (file, args, options, cb) => {
    opts = options;
    cb(null, "", "");
    return { stdin: { on() {}, write() {}, end() {} } };
  };
  const adapter = makeCodexAdapter({ agentHome: makeAgentHome("v2-detached-codex-") });
  await adapter.run({ repoToplevel: "/tmp/x", mode: "read", prompt: "hi", execFileImpl: fakeExec });
  assert.equal(opts.detached, true);
});

test("v2 off: @agent message falls through to v1", async () => {
  const agentHome = makeAgentHome("v2-wire-off-");
  makeOwner(agentHome, "123", { v2_enabled: false });
  const result = await handleTelegramUpdate({ agentHome, update: msgUpdate({ fromId: 123, chatId: 456, text: "@claude hi" }) });
  assert.notEqual(result.reason, "v2");
});

test("v2 on: non-owner @agent message falls through to v1", async () => {
  const agentHome = makeAgentHome("v2-wire-nonowner-");
  makeOwner(agentHome, "123", { v2_enabled: true });
  const result = await handleTelegramUpdate({ agentHome, update: msgUpdate({ fromId: 999, chatId: 456, text: "@claude hi" }) });
  assert.notEqual(result.reason, "v2");
});

test("v2 on: owner @agent without a resolvable repo routes to v2 and fails closed", async () => {
  const agentHome = makeAgentHome("v2-wire-noresolve-");
  makeOwner(agentHome, "123", { v2_enabled: true });
  const result = await handleTelegramUpdate({ agentHome, update: msgUpdate({ fromId: 123, chatId: 456, text: "@claude hi" }) });
  assert.equal(result.reason, "v2");
  assert.match(result.payload.text, /workspace|repo|default/i);
});

test("v2 on: owner /status and /stop route to v2 without spawning", async () => {
  const agentHome = makeAgentHome("v2-wire-controls-");
  makeOwner(agentHome, "123", { v2_enabled: true });
  const status = await handleTelegramUpdate({ agentHome, update: msgUpdate({ fromId: 123, chatId: 456, text: "/status" }) });
  assert.equal(status.reason, "v2");
  const stop = await handleTelegramUpdate({ agentHome, update: msgUpdate({ updateId: 2, fromId: 123, chatId: 456, text: "/stop" }) });
  assert.equal(stop.reason, "v2");
  assert.match(stop.payload.text, /no active|stop/i);
});
