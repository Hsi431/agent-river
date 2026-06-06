import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  approveDispatch,
  createDispatchApproval,
  dispatchTargetAllowlist,
  listDispatchApprovals,
  parseDispatchProposal,
  rejectDispatch,
} from "../src/agent/dispatch.js";
import { agentPaths } from "../src/agent/paths.js";
import { enableExchangeAgent, writeAgentConfig } from "../src/agent/safety.js";
import { readJsonl } from "../src/lib/jsonl.js";

test("dispatch parser strips only a valid agent-dispatch block", () => {
  const parsed = parseDispatchProposal([
    "Review done.",
    "```agent-dispatch",
    JSON.stringify({
      to: "codex",
      task: "Implement the focused fix in src/agent/dispatch.js",
      reason: "Codex owns this implementation path.",
      mode: "plan",
    }),
    "```",
  ].join("\n"));

  assert.equal(parsed.valid, true);
  assert.equal(parsed.proposal.to, "codex");
  assert.equal(parsed.proposal.suggested_mode, "plan");
  assert.equal(parsed.displayText, "Review done.");
});

test("dispatch parser preserves invalid blocks as visible text", () => {
  const text = "Reply\n```agent-dispatch\n{not-json}\n```";
  const parsed = parseDispatchProposal(text);

  assert.equal(parsed.valid, false);
  assert.equal(parsed.reason, "invalid_json");
  assert.equal(parsed.displayText, text);
});

test("dispatch parser rejects agent-supplied identity fields", () => {
  const text = [
    "Reply",
    "```agent-dispatch",
    JSON.stringify({
      from: "opus",
      to: "codex",
      task: "Implement the focused dispatch identity validation test.",
      reason: "Node must own sender identity.",
      mode: "plan",
    }),
    "```",
  ].join("\n");
  const parsed = parseDispatchProposal(text);

  assert.equal(parsed.valid, false);
  assert.equal(parsed.reason, "unknown_field");
  assert.equal(parsed.displayText, text);
});

test("dispatch target allowlist comes from primary agent and enabled exchange agents", () => {
  const agentHome = makeAgentHome("agent-dispatch-allowlist-");
  writeAgentConfig(agentHome, {
    primary_agent_id: "codex",
    exchange_agents: [
      { agent_id: "opus", kind: "review", enabled: true },
      { agent_id: "disabled", kind: "review", enabled: false },
    ],
  });

  assert.deepEqual([...dispatchTargetAllowlist(agentHome)].sort(), ["codex", "opus"]);
});

test("dispatch approval to codex creates a pending codex task and no mailbox message", () => {
  const agentHome = makeAgentHome("agent-dispatch-codex-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  const created = createDispatchApproval({
    agentHome,
    proposedBy: "opus",
    proposal: {
      to: "codex",
      task: "Implement the dispatch approval callback test coverage.",
      reason: "Codex should own the task wiring.",
      suggested_mode: "edit",
    },
    parentMsgId: "msg_parent",
    chatId: "456",
    now: 1000,
  });

  const approved = approveDispatch({
    agentHome,
    id: created.approval.id,
    defaultRepo: "/repo/agent-river",
    now: 2000,
  });
  const tasks = fs.readdirSync(agentPaths(agentHome).tasksDir);

  assert.equal(approved.outcome.type, "task");
  assert.equal(tasks.length, 1);
  assert.equal(readJsonl(agentPaths(agentHome).exchangeMessages).length, 0);
  const task = JSON.parse(fs.readFileSync(path.join(agentPaths(agentHome).tasksDir, tasks[0]), "utf8"));
  assert.equal(task.executor, "codex");
  assert.equal(task.mode, "edit");
  assert.equal(task.approval, "pending");
  assert.equal(task.source, "dispatch");
  assert.equal(task.requester, "opus");
  assert.deepEqual(listDispatchApprovals(agentHome).at(-1).outcome, approved.outcome);
});

test("dispatch approval to opus creates a dispatch exchange message", () => {
  const agentHome = makeAgentHome("agent-dispatch-opus-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  const created = createDispatchApproval({
    agentHome,
    proposedBy: "codex",
    proposal: {
      to: "opus",
      task: "Review the Agent River dispatch implementation for loop risks.",
      reason: "Opus should review the safety boundary.",
      suggested_mode: "plan",
    },
    parentDispatch: { hop: 0 },
    parentMsgId: "msg_parent",
    chatId: "456",
    now: 1000,
  });

  const approved = approveDispatch({ agentHome, id: created.approval.id, defaultRepo: "/repo/unused", now: 2000 });
  const messages = readJsonl(agentPaths(agentHome).exchangeMessages);

  assert.equal(approved.outcome.type, "exchange");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].from, "codex");
  assert.equal(messages[0].to, "opus");
  assert.equal(messages[0].channel, "dispatch");
  assert.equal(messages[0].dispatch.kind, "agent_dispatch");
  assert.equal(messages[0].dispatch.hop, 1);
});

test("dispatch approval rejects self-dispatch and max hops", () => {
  const agentHome = makeAgentHome("agent-dispatch-blocks-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  const self = createDispatchApproval({
    agentHome,
    proposedBy: "opus",
    proposal: { to: "opus", task: "Review this request without crossing agents.", reason: "", suggested_mode: "plan" },
  });
  const hops = createDispatchApproval({
    agentHome,
    proposedBy: "opus",
    proposal: { to: "codex", task: "Implement this request after too many hops.", reason: "", suggested_mode: "plan" },
    parentDispatch: { hop: 2 },
  });

  assert.equal(self.blocked, true);
  assert.equal(self.reason, "self_dispatch");
  assert.equal(hops.blocked, true);
  assert.equal(hops.reason, "max_hops");
  assert.equal(readJsonl(agentPaths(agentHome).dispatchApprovals).length, 0);
});

test("dispatch reject is idempotent and creates no outcome", () => {
  const agentHome = makeAgentHome("agent-dispatch-reject-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  const created = createDispatchApproval({
    agentHome,
    proposedBy: "opus",
    proposal: { to: "codex", task: "Implement this rejected request in Codex.", reason: "", suggested_mode: "plan" },
  });

  const first = rejectDispatch({ agentHome, id: created.approval.id });
  const second = rejectDispatch({ agentHome, id: created.approval.id });

  assert.equal(first.already, false);
  assert.equal(second.already, true);
  assert.equal(listDispatchApprovals(agentHome)[0].status, "rejected");
  assert.equal(readJsonl(agentPaths(agentHome).exchangeMessages).length, 0);
  assert.equal(fs.existsSync(agentPaths(agentHome).tasksDir), false);
});

function makeAgentHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
