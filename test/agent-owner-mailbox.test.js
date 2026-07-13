import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleGatewayMessage } from "../src/agent/gateway.js";
import { submitOwnerMailboxMessage } from "../src/agent/owner-mailbox.js";
import { agentPaths } from "../src/agent/paths.js";
import { allowGatewayUser, enableExchangeAgent, writeAgentConfig } from "../src/agent/safety.js";
import { readJsonl } from "../src/lib/jsonl.js";

test("owner mailbox submission rejects disabled targets without writing a ledger", () => {
  const agentHome = makeAgentHome();

  const result = submitOwnerMailboxMessage({ agentHome, to: "opus", text: "Review this request." });

  assert.deepEqual(result, { ok: false, reason: "agent_not_enabled", message: null });
  assert.equal(fs.existsSync(agentPaths(agentHome).exchangeMessages), false);
});

test("owner mailbox submission writes the canonical redacted Telegram envelope", () => {
  const agentHome = makeAgentHome();
  writeAgentConfig(agentHome, { primary_agent_id: "river" });
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });

  const result = submitOwnerMailboxMessage({
    agentHome,
    to: "opus",
    text: "Review token = abcdefghijklmnopqrstuvwxyz",
    threadId: "thread-1",
    chatId: "456",
  });
  const stored = readJsonl(agentPaths(agentHome).exchangeMessages);

  assert.equal(result.ok, true);
  assert.equal(stored.length, 1);
  assert.deepEqual(result.message, stored[0]);
  assert.equal(stored[0].from, "river");
  assert.equal(stored[0].to, "opus");
  assert.equal(stored[0].channel, "telegram");
  assert.equal(stored[0].thread_id, "thread-1");
  assert.equal(stored[0].chat_id, "456");
  assert.match(stored[0].text, /\[redacted:/);
  assert.equal(JSON.stringify(stored[0]).includes("abcdefghijklmnopqrstuvwxyz"), false);
});

test("gateway keeps the existing Telegram acknowledgement and runner trigger contract", async () => {
  const agentHome = makeAgentHome();
  allowGatewayUser(agentHome, "owner-1");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  let trigger = null;

  const result = await handleGatewayMessage({
    agentHome,
    userId: "owner-1",
    chatId: "456",
    text: "@opus Review through the shared owner mailbox path",
    runnerTrigger: (value) => { trigger = value; },
  });
  const stored = readJsonl(agentPaths(agentHome).exchangeMessages);

  assert.equal(result.ok, true);
  assert.equal(result.command, "exchange_ask");
  assert.match(result.reply, /^已收到並放進 Sonnet 4\.6 信箱 \(msg_[^)]+\),但目前不會自動回覆\(runner 未啟用\)。$/);
  assert.equal(result.runner_triggered, true);
  assert.equal(trigger?.agentHome, agentHome);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].chat_id, "456");
});

function makeAgentHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-owner-mailbox-"));
}
