import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCodexExchangeRunnerOnce } from "../src/agent/codex-exchange-runner.js";
import { DISPATCH_CHANNEL } from "../src/agent/dispatch.js";
import { submitExchangeMessage } from "../src/agent/exchange.js";
import { runExecRunnerOnce } from "../src/agent/exec-runner.js";
import { agentPaths } from "../src/agent/paths.js";
import { approveAgentRegistration, joinAgentRegistry } from "../src/agent/registry.js";
import { enableExchangeAgent, setTelegramCodexPolicy } from "../src/agent/safety.js";
import { readJsonl } from "../src/lib/jsonl.js";

test("codex runner creates dispatch approval from a valid reply block", async () => {
  const agentHome = makeAgentHome("runner-dispatch-codex-");
  enableExchangeAgent(agentHome, { agentId: "codex", kind: "coding" });
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  setTelegramCodexPolicy(agentHome, { exchange_runner_enabled: true });
  const message = submitExchangeMessage({
    agentHome,
    from: "opus",
    to: "codex",
    channel: DISPATCH_CHANNEL,
    chatId: "chat_codex_dispatch",
    dispatch: { kind: "agent_dispatch", hop: 1, proposed_by: "opus" },
    text: "Ask codex to inspect the follow-up dispatch path.",
  });
  const replyText = dispatchReply({
    to: "opus",
    task: "Review CODEX_DISPATCH_APPROVAL_TOKEN in the codex reply proposal.",
    reason: "Opus should verify the proposal created by the codex lane.",
  });

  const result = await runCodexExchangeRunnerOnce({
    agentHome,
    repoDir: process.cwd(),
    codexRunnerImpl: async () => ({ ok: true, text: replyText }),
    now: 1000,
  });
  const approvals = readJsonl(agentPaths(agentHome).dispatchApprovals);

  assert.match(result.dispatch_approval_id, /^dispatch_/);
  assert.equal(result.dispatch_blocked_reason, null);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].status, "pending");
  assert.equal(approvals[0].proposed_by, "codex");
  assert.equal(approvals[0].to, "opus");
  assert.equal(approvals[0].parent_msg_id, message.id);
  assert.equal(approvals[0].parent_hop, 1);
  assert.equal(approvals[0].hop, 2);
  assert.equal(approvals[0].chat_id, "chat_codex_dispatch");
  assert.match(approvals[0].task, /CODEX_DISPATCH_APPROVAL_TOKEN/);
});

test("exec runner creates dispatch approval from a valid reply block", async () => {
  const agentHome = makeAgentHome("runner-dispatch-exec-");
  registerExecAgent(agentHome, "shellbot", printfCommand(dispatchReply({
    to: "codex",
    task: "Handle EXEC_DISPATCH_APPROVAL_TOKEN from the exec reply proposal.",
    reason: "Codex should receive the exec lane follow-up proposal.",
  })));
  const message = submitExchangeMessage({
    agentHome,
    from: "codex",
    to: "shellbot",
    channel: DISPATCH_CHANNEL,
    chatId: "chat_exec_dispatch",
    dispatch: { kind: "agent_dispatch", hop: 1, proposed_by: "codex" },
    text: "Ask shellbot to answer with a dispatch proposal.",
  });

  const result = await runExecRunnerOnce({ agentHome, repoDir: process.cwd(), now: 2000 });
  const approvals = readJsonl(agentPaths(agentHome).dispatchApprovals);
  const record = result.results[0];

  assert.match(record.dispatch_approval_id, /^dispatch_/);
  assert.equal(record.dispatch_blocked_reason, null);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].status, "pending");
  assert.equal(approvals[0].proposed_by, "shellbot");
  assert.equal(approvals[0].to, "codex");
  assert.equal(approvals[0].parent_msg_id, message.id);
  assert.equal(approvals[0].parent_hop, 1);
  assert.equal(approvals[0].hop, 2);
  assert.equal(approvals[0].chat_id, "chat_exec_dispatch");
  assert.match(approvals[0].task, /EXEC_DISPATCH_APPROVAL_TOKEN/);
});

test("exec runner without a reply block creates no dispatch approval", async () => {
  const agentHome = makeAgentHome("runner-dispatch-none-");
  registerExecAgent(agentHome, "plainbot", printfCommand("Plain reply without a dispatch block."));
  submitExchangeMessage({
    agentHome,
    from: "codex",
    to: "plainbot",
    channel: "telegram",
    chatId: "chat_no_dispatch",
    text: "Ask plainbot for a normal reply.",
  });

  const result = await runExecRunnerOnce({ agentHome, repoDir: process.cwd(), now: 3000 });
  const record = result.results[0];

  assert.equal(record.reason, "replied");
  assert.equal(record.dispatch_approval_id, null);
  assert.equal(record.dispatch_blocked_reason, null);
  assert.equal(readJsonl(agentPaths(agentHome).dispatchApprovals).length, 0);
});

function dispatchReply({ to, task, reason, mode = "plan" }) {
  return [
    "Reply complete.",
    "```agent-dispatch",
    JSON.stringify({ to, task, reason, mode }),
    "```",
  ].join("\n");
}

function registerExecAgent(agentHome, name, command) {
  joinAgentRegistry({
    agentHome,
    name,
    style: "exec",
    capabilities: "read",
    execCommand: command,
    execTimeoutSeconds: 5,
    now: new Date("2026-07-06T00:00:00.000Z"),
  });
  approveAgentRegistration({
    agentHome,
    name,
    now: new Date("2026-07-06T00:00:01.000Z"),
  });
}

function printfCommand(text) {
  return `printf '%s' ${sh(text)}`;
}

function makeAgentHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sh(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}
