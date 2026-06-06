import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgentCli } from "../src/agent/cli.js";
import { createChatDraft, createChatHandoff, enqueueChatMessage, queueChatReply } from "../src/agent/chat.js";
import { codexReplyOnce } from "../src/agent/codex-reply.js";
import { approveAgentTask, getAgentStatus, rejectAgentTask, runAgentOnce, submitAgentTask } from "../src/agent/orchestrator.js";
import { runPlanStep } from "../src/agent/worker.js";
import { readRuns, transitionTask, writeTask } from "../src/agent/tasks.js";
import { agentPaths } from "../src/agent/paths.js";
import { buildMemoryContextBlock } from "../src/agent/memory-adapter.js";
import { checkSafety, setDailyTokenBudget, setKillSwitch } from "../src/agent/safety.js";
import { approveDispatch, createDispatchApproval } from "../src/agent/dispatch.js";
import { statePaths } from "../src/lib/paths.js";
import { readJsonl, writeJsonl } from "../src/lib/jsonl.js";

test("agent submit creates a queued plan task", () => {
  const agentHome = makeAgentHome("codex-agent-submit-");
  const task = submitAgentTask({
    agentHome,
    repo: "/repo/memory-river",
    request: "Plan the smallest change.",
    mode: "plan",
  });

  assert.equal(task.status, "queued");
  assert.equal(task.mode, "plan");
  assert.equal(task.history[0].state, "queued");
  assert.equal(fs.existsSync(path.join(agentHome, "tasks", `${task.id}.json`)), true);
});

test("agent rejects execute mode in Phase B", () => {
  const agentHome = makeAgentHome("codex-agent-execute-reject-");

  assert.throws(
    () => submitAgentTask({
      agentHome,
      repo: "/repo/memory-river",
      request: "Change code.",
      mode: "execute",
    }),
    /Unsupported task mode/,
  );
});

test("agent run refuses non-plan tasks before invoking the runner", async () => {
  const agentHome = makeAgentHome("codex-agent-non-plan-run-");
  const task = fakeTask({ mode: "execute" });
  writeTask(agentHome, task);
  let invoked = false;

  const result = await runAgentOnce({
    agentHome,
    memoryStateHome: makeMemoryState("codex-agent-non-plan-memory-"),
    runner: async () => {
      invoked = true;
      return { text: "should not run", sessionPath: null, exit: 0, tokens: 5 };
    },
  });
  const status = getAgentStatus({ agentHome, id: task.id });

  assert.equal(invoked, false);
  assert.equal(result.advanced, 1);
  assert.equal(status.task.status, "failed");
  assert.match(status.task.history.at(-1).note, /unsupported mode: execute/);
  assert.equal(status.runs.length, 0);
});

test("agent run advances queued plan task to done and appends run log", async () => {
  const agentHome = makeAgentHome("codex-agent-run-");
  const memoryStateHome = makeMemoryState("codex-agent-memory-");
  const task = submitAgentTask({
    agentHome,
    repo: "/repo/memory-river",
    request: "Plan recall improvements.",
  });

  const result = await runAgentOnce({ agentHome, memoryStateHome });
  const status = getAgentStatus({ agentHome, id: task.id });
  const states = status.task.history.map((entry) => entry.state);

  assert.equal(result.advanced, 1);
  assert.equal(status.task.status, "done");
  assert.deepEqual(states, ["queued", "planning", "reporting", "done"]);
  assert.match(status.task.result.summary, /Plan for task_/);
  assert.equal(status.runs.length, 1);
  assert.equal(status.runs[0].step, "planning");
  assert.equal(readJsonl(agentPaths(agentHome).cost).length, 1);
  assert.ok(getAgentStatus({ agentHome }).safety.today.tokens > 0);
});

test("agent run works without Memory River when memory is not enabled", async () => {
  const agentHome = makeAgentHome("codex-agent-run-no-memory-");
  const task = submitAgentTask({
    agentHome,
    repo: "/repo/memory-river",
    request: "Plan without memory.",
  });
  let prompt = "";

  const result = await runAgentOnce({
    agentHome,
    runner: async (args) => {
      prompt = args.prompt;
      return { text: "ok", sessionPath: null, exit: 0, tokens: 1 };
    },
  });

  assert.equal(result.advanced, 1);
  assert.doesNotMatch(prompt, /Codex Memory River context|Memory-backed planning context/);
  assert.equal(getAgentStatus({ agentHome, id: task.id }).task.status, "done");
});

test("plan prompt uses Traditional Chinese for owner-facing dispatch reports", async () => {
  const task = {
    id: "task_lang",
    repo: "/repo/agent-river",
    request: "Report the Opus review result to the owner.",
    source: "dispatch",
    chat_id: "123",
  };
  let prompt = "";

  await runPlanStep({
    task,
    contextBlock: "context",
    runner: async (args) => {
      prompt = args.prompt;
      return { text: "ok", sessionPath: null, exit: 0, tokens: 1 };
    },
  });

  assert.match(prompt, /Reply in the owner's language/);
  assert.match(prompt, /Traditional Chinese/);
  assert.match(prompt, /return that owner-facing report directly/i);
});

test("agent run skips tasks pending approval until approved", async () => {
  const agentHome = makeAgentHome("codex-agent-approval-pending-");
  const memoryStateHome = makeMemoryState("codex-agent-approval-pending-memory-");
  const task = fakeTask({ approval: "pending" });
  writeTask(agentHome, task);
  let invoked = false;

  const parked = await runAgentOnce({
    agentHome,
    memoryStateHome,
    runner: async () => {
      invoked = true;
      return { text: "should wait", sessionPath: null, exit: 0, tokens: 5 };
    },
  });
  approveAgentTask({ agentHome, id: task.id });
  const approved = await runAgentOnce({
    agentHome,
    memoryStateHome,
    runner: async () => ({ text: "approved plan", sessionPath: null, exit: 0, tokens: 5 }),
  });
  const status = getAgentStatus({ agentHome, id: task.id });

  assert.equal(invoked, false);
  assert.equal(parked.advanced, 0);
  assert.equal(approved.advanced, 1);
  assert.equal(status.task.approval, "approved");
  assert.equal(status.task.status, "done");
  assert.equal(status.runs.length, 1);
});

test("agent reject marks a task failed before it can run", async () => {
  const agentHome = makeAgentHome("codex-agent-approval-reject-");
  const memoryStateHome = makeMemoryState("codex-agent-approval-reject-memory-");
  const task = fakeTask({ approval: "pending" });
  writeTask(agentHome, task);

  const rejected = rejectAgentTask({ agentHome, id: task.id });
  const result = await runAgentOnce({
    agentHome,
    memoryStateHome,
    runner: async () => {
      throw new Error("runner should not be invoked");
    },
  });

  assert.equal(rejected.approval, "rejected");
  assert.equal(rejected.status, "failed");
  assert.equal(result.advanced, 0);
  assert.equal(readRuns(agentHome).length, 0);
});

test("agent approval commands are idempotent without duplicate history", () => {
  const agentHome = makeAgentHome("codex-agent-approval-idempotent-");
  const approveTask = fakeTask({ id: "task_approve_twice", approval: "pending" });
  const rejectTask = fakeTask({ id: "task_reject_twice", approval: "pending" });
  writeTask(agentHome, approveTask);
  writeTask(agentHome, rejectTask);

  approveAgentTask({ agentHome, id: approveTask.id });
  approveAgentTask({ agentHome, id: approveTask.id });
  rejectAgentTask({ agentHome, id: rejectTask.id });
  rejectAgentTask({ agentHome, id: rejectTask.id });

  const approved = getAgentStatus({ agentHome, id: approveTask.id }).task;
  const rejected = getAgentStatus({ agentHome, id: rejectTask.id }).task;

  assert.equal(approved.approval, "approved");
  assert.equal(approved.history.filter((entry) => /approved/.test(entry.note)).length, 1);
  assert.equal(rejected.approval, "rejected");
  assert.equal(rejected.history.filter((entry) => /rejected/.test(entry.note)).length, 1);
});

test("agent run does not add history noise for pending approvals", async () => {
  const agentHome = makeAgentHome("codex-agent-approval-no-history-noise-");
  const task = fakeTask({ approval: "pending" });
  writeTask(agentHome, task);

  await runAgentOnce({ agentHome, memoryStateHome: makeMemoryState("codex-agent-pending-noise-memory-") });
  await runAgentOnce({ agentHome, memoryStateHome: makeMemoryState("codex-agent-pending-noise-memory-") });

  const status = getAgentStatus({ agentHome, id: task.id });

  assert.equal(status.task.status, "queued");
  assert.equal(status.task.approval, "pending");
  assert.equal(status.task.history.length, 1);
});

test("agent worker prompt includes memory context block", async () => {
  const agentHome = makeAgentHome("codex-agent-context-");
  const memoryStateHome = makeMemoryState("codex-agent-context-memory-");
  const task = submitAgentTask({
    agentHome,
    repo: "/repo/memory-river",
    request: "Plan with memory.",
  });
  let capturedPrompt = "";

  await runAgentOnce({
    agentHome,
    memoryStateHome,
    runner: async ({ prompt }) => {
      capturedPrompt = prompt;
      return { text: "planned", sessionPath: null, exit: 0, tokens: 5 };
    },
  });

  assert.match(capturedPrompt, /Codex Memory River context/);
  assert.match(capturedPrompt, /Memory-backed planning context/);
  assert.match(capturedPrompt, /Plan with memory/);
  assert.equal(readRuns(agentHome).length, 1);
  assert.equal(getAgentStatus({ agentHome, id: task.id }).task.status, "done");
});

test("agent run records worker failures", async () => {
  const agentHome = makeAgentHome("codex-agent-worker-failure-");
  const memoryStateHome = makeMemoryState("codex-agent-worker-failure-memory-");
  const task = submitAgentTask({
    agentHome,
    repo: "/repo/memory-river",
    request: "Plan failure handling.",
  });

  const result = await runAgentOnce({
    agentHome,
    memoryStateHome,
    runner: async () => ({ text: "boom", sessionPath: null, exit: 1, tokens: 3 }),
  });
  const status = getAgentStatus({ agentHome, id: task.id });

  assert.equal(result.advanced, 1);
  assert.equal(status.task.status, "failed");
  assert.equal(status.task.attempts, 1);
  assert.equal(status.task.cost.tokens, 3);
  assert.equal(status.runs[0].error, "boom");
  assert.equal(readJsonl(agentPaths(agentHome).cost)[0].tokens, 3);
});

test("agent run marks interrupted non-terminal tasks failed even when safety guard is closed", async () => {
  const agentHome = makeAgentHome("codex-agent-interrupted-");
  const task = submitAgentTask({
    agentHome,
    repo: "/repo/memory-river",
    request: "Plan interrupted recovery.",
  });
  transitionTask(agentHome, task, "planning", "Planning started.");
  setDailyTokenBudget(agentHome, 0);

  const result = await runAgentOnce({ agentHome, memoryStateHome: makeMemoryState("codex-agent-interrupted-memory-") });
  const status = getAgentStatus({ agentHome, id: task.id });

  assert.equal(result.advanced, 1);
  assert.equal(status.task.status, "failed");
  assert.match(status.task.history.at(-1).note, /interrupted while planning/);
  assert.equal(status.runs.length, 0);
});

test("agent cost guard parks queued work without invoking the runner", async () => {
  const agentHome = makeAgentHome("codex-agent-budget-");
  const memoryStateHome = makeMemoryState("codex-agent-budget-memory-");
  const task = submitAgentTask({
    agentHome,
    repo: "/repo/memory-river",
    request: "Plan budget handling.",
  });
  setDailyTokenBudget(agentHome, 0);
  let invoked = false;

  const result = await runAgentOnce({
    agentHome,
    memoryStateHome,
    runner: async () => {
      invoked = true;
      return { text: "planned", sessionPath: null, exit: 0, tokens: 5 };
    },
  });
  const status = getAgentStatus({ agentHome, id: task.id });

  assert.equal(invoked, false);
  assert.equal(result.advanced, 0);
  assert.equal(status.task.status, "queued");
  assert.match(status.task.history.at(-1).note, /daily_token_budget/);
  assert.equal(readRuns(agentHome).length, 0);
});

test("agent safety parking is idempotent for repeated runs", async () => {
  const agentHome = makeAgentHome("codex-agent-budget-idempotent-");
  const memoryStateHome = makeMemoryState("codex-agent-budget-idempotent-memory-");
  const task = submitAgentTask({
    agentHome,
    repo: "/repo/memory-river",
    request: "Plan repeated budget handling.",
  });
  setDailyTokenBudget(agentHome, 0);

  await runAgentOnce({ agentHome, memoryStateHome });
  await runAgentOnce({ agentHome, memoryStateHome });
  await runAgentOnce({ agentHome, memoryStateHome });

  const status = getAgentStatus({ agentHome, id: task.id });

  assert.equal(status.task.status, "queued");
  assert.equal(status.task.history.filter((entry) => /daily_token_budget/.test(entry.note)).length, 1);
});

test("agent queued task can resume after safety parking", async () => {
  const agentHome = makeAgentHome("codex-agent-resume-after-park-");
  const memoryStateHome = makeMemoryState("codex-agent-resume-after-park-memory-");
  const task = submitAgentTask({
    agentHome,
    repo: "/repo/memory-river",
    request: "Plan resume after budget handling.",
  });
  setDailyTokenBudget(agentHome, 0);

  await runAgentOnce({ agentHome, memoryStateHome });
  setDailyTokenBudget(agentHome, 20);
  const result = await runAgentOnce({
    agentHome,
    memoryStateHome,
    runner: async () => ({ text: "planned after budget raise", sessionPath: null, exit: 0, tokens: 5 }),
  });
  const status = getAgentStatus({ agentHome, id: task.id });

  assert.equal(result.advanced, 1);
  assert.equal(status.task.status, "done");
  assert.equal(status.runs.length, 1);
  assert.equal(readJsonl(agentPaths(agentHome).cost).length, 1);
});

test("agent budget ledger blocks later tasks in the same run", async () => {
  const agentHome = makeAgentHome("codex-agent-partial-budget-");
  const memoryStateHome = makeMemoryState("codex-agent-partial-budget-memory-");
  const first = submitAgentTask({
    agentHome,
    repo: "/repo/one",
    request: "Plan first budget task.",
  });
  const second = submitAgentTask({
    agentHome,
    repo: "/repo/two",
    request: "Plan second budget task.",
  });
  setDailyTokenBudget(agentHome, 5);

  const result = await runAgentOnce({
    agentHome,
    memoryStateHome,
    runner: async () => ({ text: "planned", sessionPath: null, exit: 0, tokens: 5 }),
  });
  const statuses = [
    getAgentStatus({ agentHome, id: first.id }).task.status,
    getAgentStatus({ agentHome, id: second.id }).task.status,
  ].sort();

  assert.equal(result.advanced, 1);
  assert.deepEqual(statuses, ["done", "queued"]);
  assert.equal(readJsonl(agentPaths(agentHome).cost).length, 1);
});

test("agent kill switch halts queued work without invoking the runner", async () => {
  const agentHome = makeAgentHome("codex-agent-kill-switch-");
  const memoryStateHome = makeMemoryState("codex-agent-kill-switch-memory-");
  const task = submitAgentTask({
    agentHome,
    repo: "/repo/memory-river",
    request: "Plan kill switch handling.",
  });
  setKillSwitch(agentHome, true);
  let invoked = false;

  const result = await runAgentOnce({
    agentHome,
    memoryStateHome,
    runner: async () => {
      invoked = true;
      return { text: "planned", sessionPath: null, exit: 0, tokens: 5 };
    },
  });
  const status = getAgentStatus({ agentHome, id: task.id });

  assert.equal(invoked, false);
  assert.equal(result.advanced, 0);
  assert.equal(status.task.status, "queued");
  assert.match(status.task.history.at(-1).note, /kill_switch/);
  assert.equal(readRuns(agentHome).length, 0);
});

test("agent safety config fails closed when config is corrupt", async () => {
  const agentHome = makeAgentHome("codex-agent-corrupt-config-");
  const memoryStateHome = makeMemoryState("codex-agent-corrupt-config-memory-");
  const task = submitAgentTask({
    agentHome,
    repo: "/repo/memory-river",
    request: "Plan corrupt config handling.",
  });
  fs.writeFileSync(agentPaths(agentHome).config, "{not json");
  let invoked = false;

  const result = await runAgentOnce({
    agentHome,
    memoryStateHome,
    runner: async () => {
      invoked = true;
      return { text: "planned", sessionPath: null, exit: 0, tokens: 5 };
    },
  });
  const status = getAgentStatus({ agentHome });

  assert.equal(invoked, false);
  assert.equal(result.advanced, 0);
  assert.equal(getAgentStatus({ agentHome, id: task.id }).task.status, "queued");
  assert.equal(status.safety.config.kill_switch, true);
  assert.equal(status.safety.config.config_error, "corrupt_config");
});

test("agent safety config fails closed when config is non-object JSON", async () => {
  const agentHome = makeAgentHome("codex-agent-invalid-config-");
  const memoryStateHome = makeMemoryState("codex-agent-invalid-config-memory-");
  const task = submitAgentTask({
    agentHome,
    repo: "/repo/memory-river",
    request: "Plan invalid config handling.",
  });
  fs.writeFileSync(agentPaths(agentHome).config, "42\n");
  let invoked = false;

  const result = await runAgentOnce({
    agentHome,
    memoryStateHome,
    runner: async () => {
      invoked = true;
      return { text: "planned", sessionPath: null, exit: 0, tokens: 5 };
    },
  });
  const status = getAgentStatus({ agentHome });

  assert.equal(invoked, false);
  assert.equal(result.advanced, 0);
  assert.equal(getAgentStatus({ agentHome, id: task.id }).task.status, "queued");
  assert.equal(status.safety.config.kill_switch, true);
  assert.equal(status.safety.config.config_error, "invalid_config");
});

test("agent rejects invalid budget values", () => {
  const agentHome = makeAgentHome("codex-agent-invalid-budget-");

  assert.throws(
    () => setDailyTokenBudget(agentHome, -1),
    /non-negative number or disabled/,
  );
});

test("agent daily token budget can be disabled", async () => {
  const agentHome = makeAgentHome("codex-agent-budget-disabled-");
  const memoryStateHome = makeMemoryState("codex-agent-budget-disabled-memory-");
  const task = submitAgentTask({
    agentHome,
    repo: "/repo/memory-river",
    request: "Plan with budget disabled.",
  });
  setDailyTokenBudget(agentHome, "disabled");

  const result = await runAgentOnce({
    agentHome,
    memoryStateHome,
    runner: async () => ({ text: "planned without budget guard", sessionPath: null, exit: 0, tokens: 5 }),
  });
  const status = getAgentStatus({ agentHome, id: task.id });
  const fullStatus = getAgentStatus({ agentHome });

  assert.equal(result.advanced, 1);
  assert.equal(status.task.status, "done");
  assert.equal(fullStatus.safety.config.daily_token_budget, Number.MAX_SAFE_INTEGER);
});

test("agent budget disable aliases off/none/unlimited all store the disabled sentinel", () => {
  for (const alias of ["off", "none", "unlimited", "DISABLED", "Off"]) {
    const agentHome = makeAgentHome(`codex-agent-budget-alias-${alias}-`);
    const config = setDailyTokenBudget(agentHome, alias);
    assert.equal(config.daily_token_budget, Number.MAX_SAFE_INTEGER, `alias ${alias}`);
  }
});

test("kill switch still blocks when the daily token budget is disabled", () => {
  const agentHome = makeAgentHome("codex-agent-budget-disabled-killswitch-");
  setDailyTokenBudget(agentHome, "disabled");
  setKillSwitch(agentHome, true);

  const guard = checkSafety(agentHome);

  assert.equal(guard.ok, false);
  assert.equal(guard.reason, "kill_switch");
});

test("agent run advances at most one queued task per repo", async () => {
  const agentHome = makeAgentHome("codex-agent-repo-lock-");
  const memoryStateHome = makeMemoryState("codex-agent-repo-lock-memory-");
  const first = submitAgentTask({
    agentHome,
    repo: "/repo/memory-river",
    request: "Plan first same-repo task.",
  });
  const second = submitAgentTask({
    agentHome,
    repo: "/repo/memory-river",
    request: "Plan second same-repo task.",
  });
  const third = submitAgentTask({
    agentHome,
    repo: "/repo/other",
    request: "Plan different-repo task.",
  });

  const result = await runAgentOnce({ agentHome, memoryStateHome });
  const sameRepoStatuses = [
    getAgentStatus({ agentHome, id: first.id }).task.status,
    getAgentStatus({ agentHome, id: second.id }).task.status,
  ].sort();

  assert.equal(result.advanced, 2);
  assert.deepEqual(sameRepoStatuses, ["done", "queued"]);
  assert.equal(getAgentStatus({ agentHome, id: third.id }).task.status, "done");
});

test("agent CLI wires submit status and run", async () => {
  const agentHome = makeAgentHome("codex-agent-cli-");
  const memoryStateHome = makeMemoryState("codex-agent-cli-memory-");
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));

  try {
    await runAgentCli([
      "submit",
      "--state",
      agentHome,
      "--repo",
      "/repo/memory-river",
      "--request",
      "Plan CLI wiring.",
    ]);
    await runAgentCli(["run", "--state", agentHome, "--memory-state", memoryStateHome]);
    await runAgentCli(["status", "--state", agentHome]);
  } finally {
    console.log = originalLog;
  }

  const submitted = JSON.parse(lines[0]);
  const run = JSON.parse(lines[1]);
  const status = JSON.parse(lines[2]);

  assert.equal(submitted.task.status, "queued");
  assert.equal(run.advanced, 1);
  assert.equal(status.tasks[0].status, "done");
});

test("agent CLI approves and rejects tasks", async () => {
  const agentHome = makeAgentHome("codex-agent-cli-approval-");
  const approveTask = fakeTask({ id: "task_cli_approve", approval: "pending" });
  const rejectTask = fakeTask({ id: "task_cli_reject", approval: "pending" });
  writeTask(agentHome, approveTask);
  writeTask(agentHome, rejectTask);
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));

  try {
    await runAgentCli(["approve", "--state", agentHome, approveTask.id]);
    await runAgentCli(["reject", "--state", agentHome, rejectTask.id]);
  } finally {
    console.log = originalLog;
  }

  const approved = JSON.parse(lines[0]);
  const rejected = JSON.parse(lines[1]);

  assert.equal(approved.task.approval, "approved");
  assert.equal(approved.task.status, "queued");
  assert.equal(rejected.task.approval, "rejected");
  assert.equal(rejected.task.status, "failed");
});

test("agent CLI lists inbox messages and queues manual replies", async () => {
  const agentHome = makeAgentHome("codex-agent-cli-inbox-");
  setAllowlistedConfig(agentHome, "user-chat");
  const chat = enqueueChatMessage({
    agentHome,
    channel: "telegram",
    userId: "user-chat",
    chatId: "456",
    text: "hello bridge",
  });
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));

  try {
    await runAgentCli(["inbox", "--state", agentHome]);
    await runAgentCli(["reply", "--state", agentHome, "--id", chat.id, "--text", "manual reply"]);
  } finally {
    console.log = originalLog;
  }

  const inbox = JSON.parse(lines[0]);
  const reply = JSON.parse(lines[1]);

  assert.equal(inbox.messages.length, 1);
  assert.equal(inbox.latest_inbox_id, chat.id);
  assert.equal(inbox.messages[0].text, "hello bridge");
  assert.equal(reply.reply.inbox_id, chat.id);
  assert.equal(reply.reply.text, "manual reply");
});

test("agent CLI queues a reply to the latest inbox entry", async () => {
  const agentHome = makeAgentHome("codex-agent-cli-reply-latest-");
  setAllowlistedConfig(agentHome, "user-chat");
  const first = enqueueChatMessage({
    agentHome,
    channel: "telegram",
    userId: "user-chat",
    chatId: "111",
    text: "first",
  });
  const latest = enqueueChatMessage({
    agentHome,
    channel: "telegram",
    userId: "user-chat",
    chatId: "222",
    text: "latest",
  });
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));

  try {
    await runAgentCli(["reply-latest", "--state", agentHome, "--text", "latest reply"]);
  } finally {
    console.log = originalLog;
  }

  const reply = JSON.parse(lines[0]);

  assert.notEqual(reply.reply.inbox_id, first.id);
  assert.equal(reply.reply.inbox_id, latest.id);
  assert.equal(reply.reply.chat_id, "222");
});

test("agent CLI creates chat drafts and reports chat status", async () => {
  const agentHome = makeAgentHome("codex-agent-cli-draft-");
  setAllowlistedConfig(agentHome, "user-chat");
  const chat = enqueueChatMessage({
    agentHome,
    channel: "telegram",
    userId: "user-chat",
    chatId: "456",
    text: "please draft this",
  });
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));

  try {
    await runAgentCli(["draft", "--state", agentHome, "--id", chat.id]);
    await runAgentCli(["chat-status", "--state", agentHome]);
  } finally {
    console.log = originalLog;
  }

  const draft = JSON.parse(lines[0]);
  const status = JSON.parse(lines[1]);
  const draftText = fs.readFileSync(draft.draft.path, "utf8");

  assert.equal(draft.draft.inbox_id, chat.id);
  assert.match(draftText, /please draft this/);
  assert.match(draftText, /Do not claim autonomous execution/);
  assert.equal(status.inbox_count, 1);
  assert.equal(status.latest_inbox_id, chat.id);
  assert.equal(status.pending_replies, 0);
  assert.equal(status.sent_replies, 0);
  assert.equal(status.latest_draft, draft.draft.path);
  assert.equal(status.pending_handoffs, 0);
  assert.equal(status.latest_handoff_id, null);
  assert.equal(status.latest_pending_handoff_id, null);
});

test("agent CLI drafts latest and replies from file", async () => {
  const agentHome = makeAgentHome("codex-agent-cli-draft-latest-");
  const replyFile = path.join(agentHome, "reply.txt");
  setAllowlistedConfig(agentHome, "user-chat");
  enqueueChatMessage({
    agentHome,
    channel: "telegram",
    userId: "user-chat",
    chatId: "111",
    text: "older",
  });
  const latest = enqueueChatMessage({
    agentHome,
    channel: "telegram",
    userId: "user-chat",
    chatId: "222",
    text: "newer",
  });
  fs.writeFileSync(replyFile, "reply from file\n");
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));

  try {
    await runAgentCli(["draft-latest", "--state", agentHome]);
    await runAgentCli(["reply-latest", "--state", agentHome, "--from-file", replyFile]);
  } finally {
    console.log = originalLog;
  }

  const draft = JSON.parse(lines[0]);
  const reply = JSON.parse(lines[1]);

  assert.equal(draft.draft.inbox_id, latest.id);
  assert.equal(reply.reply.inbox_id, latest.id);
  assert.equal(reply.reply.text, "reply from file");
});

test("agent CLI from-file replies still reject secrets and empty text", async () => {
  const agentHome = makeAgentHome("codex-agent-cli-from-file-guard-");
  const secretFile = path.join(agentHome, "secret.txt");
  const emptyFile = path.join(agentHome, "empty.txt");
  setAllowlistedConfig(agentHome, "user-chat");
  const chat = enqueueChatMessage({
    agentHome,
    channel: "telegram",
    userId: "user-chat",
    chatId: "222",
    text: "guard this",
  });
  fs.writeFileSync(secretFile, "token = sk-123456789012345678901234567890\n");
  fs.writeFileSync(emptyFile, "\n  \n");

  await assert.rejects(
    () => runAgentCli(["reply", "--state", agentHome, "--id", chat.id, "--from-file", secretFile]),
    /Reply may contain a secret/,
  );
  await assert.rejects(
    () => runAgentCli(["reply", "--state", agentHome, "--id", chat.id, "--from-file", emptyFile]),
    /Reply text is empty/,
  );
});

test("agent chat status folds pending and sent replies", async () => {
  const agentHome = makeAgentHome("codex-agent-cli-chat-status-replies-");
  setAllowlistedConfig(agentHome, "user-chat");
  const chat = enqueueChatMessage({
    agentHome,
    channel: "telegram",
    userId: "user-chat",
    chatId: "222",
    text: "status counts",
  });
  let lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));

  try {
    await runAgentCli(["reply", "--state", agentHome, "--id", chat.id, "--text", "pending"]);
    await runAgentCli(["chat-status", "--state", agentHome]);
  } finally {
    console.log = originalLog;
  }

  const reply = JSON.parse(lines[0]);
  const pending = JSON.parse(lines[1]);
  markReplySentForTest(agentHome, reply.reply.id);
  lines = [];
  console.log = (value) => lines.push(String(value));
  try {
    await runAgentCli(["chat-status", "--state", agentHome]);
  } finally {
    console.log = originalLog;
  }
  const sent = JSON.parse(lines[0]);

  assert.equal(pending.pending_replies, 1);
  assert.equal(pending.sent_replies, 0);
  assert.equal(sent.pending_replies, 0);
  assert.equal(sent.sent_replies, 1);
});

test("agent CLI creates and completes chat handoffs", async () => {
  const agentHome = makeAgentHome("codex-agent-cli-handoff-");
  const replyFile = path.join(agentHome, "handoff-reply.txt");
  setAllowlistedConfig(agentHome, "user-chat");
  const chat = enqueueChatMessage({
    agentHome,
    channel: "telegram",
    userId: "user-chat",
    chatId: "222",
    text: "handoff this",
  });
  fs.writeFileSync(replyFile, "handoff reply\n");
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));

  try {
    await runAgentCli(["handoff", "--state", agentHome, "--id", chat.id]);
    await runAgentCli(["handoff-status", "--state", agentHome]);
    const handoff = JSON.parse(lines[0]).handoff;
    await runAgentCli(["handoff-complete", "--state", agentHome, "--id", handoff.id, "--from-file", replyFile]);
    await runAgentCli(["handoff-status", "--state", agentHome]);
  } finally {
    console.log = originalLog;
  }

  const created = JSON.parse(lines[0]).handoff;
  const pending = JSON.parse(lines[1]);
  const completed = JSON.parse(lines[2]);
  const finalStatus = JSON.parse(lines[3]);
  const handoffText = fs.readFileSync(created.path, "utf8");

  assert.equal(created.inbox_id, chat.id);
  assert.equal(created.status, "pending");
  assert.match(handoffText, /handoff this/);
  assert.match(handoffText, /Do not call tools/);
  assert.equal(pending.pending, 1);
  assert.equal(pending.latest_handoff_id, created.id);
  assert.equal(pending.latest_pending_handoff_id, created.id);
  assert.equal(completed.handoff.id, created.id);
  assert.equal(completed.reply.inbox_id, chat.id);
  assert.equal(completed.reply.text, "handoff reply");
  assert.equal(finalStatus.pending, 0);
  assert.equal(finalStatus.completed, 1);
  assert.equal(finalStatus.latest_completed_handoff_id, created.id);
});

test("agent CLI creates handoffs for the latest inbox entry and prevents double completion", async () => {
  const agentHome = makeAgentHome("codex-agent-cli-handoff-latest-");
  const replyFile = path.join(agentHome, "reply.txt");
  setAllowlistedConfig(agentHome, "user-chat");
  enqueueChatMessage({
    agentHome,
    channel: "telegram",
    userId: "user-chat",
    chatId: "111",
    text: "older",
  });
  const latest = enqueueChatMessage({
    agentHome,
    channel: "telegram",
    userId: "user-chat",
    chatId: "222",
    text: "latest handoff",
  });
  fs.writeFileSync(replyFile, "done once\n");
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));

  try {
    await runAgentCli(["handoff-latest", "--state", agentHome]);
    const handoff = JSON.parse(lines[0]).handoff;
    await runAgentCli(["handoff-complete", "--state", agentHome, "--id", handoff.id, "--from-file", replyFile]);
    await assert.rejects(
      () => runAgentCli(["handoff-complete", "--state", agentHome, "--id", handoff.id, "--from-file", replyFile]),
      /Handoff is not pending/,
    );
  } finally {
    console.log = originalLog;
  }

  const handoff = JSON.parse(lines[0]).handoff;
  const completed = JSON.parse(lines[1]);

  assert.equal(handoff.inbox_id, latest.id);
  assert.equal(completed.reply.chat_id, "222");
  assert.equal(readJsonl(agentPaths(agentHome).chatReplies).filter((entry) => entry.status === "queued").length, 1);
});

test("agent handoff complete rejects secret replies and remains pending", async () => {
  const agentHome = makeAgentHome("codex-agent-cli-handoff-secret-");
  const replyFile = path.join(agentHome, "secret-reply.txt");
  setAllowlistedConfig(agentHome, "user-chat");
  enqueueChatMessage({
    agentHome,
    channel: "telegram",
    userId: "user-chat",
    chatId: "222",
    text: "secret handoff",
  });
  fs.writeFileSync(replyFile, "token = sk-123456789012345678901234567890\n");
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));

  try {
    await runAgentCli(["handoff-latest", "--state", agentHome]);
    const handoff = JSON.parse(lines[0]).handoff;
    await assert.rejects(
      () => runAgentCli(["handoff-complete", "--state", agentHome, "--id", handoff.id, "--from-file", replyFile]),
      /Reply may contain a secret/,
    );
    await runAgentCli(["handoff-status", "--state", agentHome]);
  } finally {
    console.log = originalLog;
  }

  const status = JSON.parse(lines[1]);

  assert.equal(status.pending, 1);
  assert.equal(status.completed, 0);
  assert.equal(readJsonl(agentPaths(agentHome).chatReplies).length, 0);
});

test("agent handoff status folds one pending and one completed handoff", async () => {
  const agentHome = makeAgentHome("codex-agent-cli-handoff-status-");
  const replyFile = path.join(agentHome, "reply.txt");
  setAllowlistedConfig(agentHome, "user-chat");
  const firstChat = enqueueChatMessage({
    agentHome,
    channel: "telegram",
    userId: "user-chat",
    chatId: "111",
    text: "complete me",
  });
  const latestChat = enqueueChatMessage({
    agentHome,
    channel: "telegram",
    userId: "user-chat",
    chatId: "222",
    text: "leave pending",
  });
  fs.writeFileSync(replyFile, "completed reply\n");
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));

  try {
    await runAgentCli(["handoff", "--state", agentHome, "--id", firstChat.id]);
    const first = JSON.parse(lines.at(-1)).handoff;
    await runAgentCli(["handoff-latest", "--state", agentHome]);
    await runAgentCli(["handoff-complete", "--state", agentHome, "--id", first.id, "--from-file", replyFile]);
    await runAgentCli(["handoff-status", "--state", agentHome]);
  } finally {
    console.log = originalLog;
  }

  const status = JSON.parse(lines.at(-1));

  assert.equal(status.pending, 1);
  assert.equal(status.completed, 1);
  assert.equal(status.handoffs.find((handoff) => handoff.status === "pending").inbox_id, latestChat.id);
  assert.ok(status.latest_handoff_id);
});

test("agent CLI completes the latest pending handoff", async () => {
  const agentHome = makeAgentHome("codex-agent-cli-handoff-complete-latest-");
  const replyFile = path.join(agentHome, "reply.txt");
  setAllowlistedConfig(agentHome, "user-chat");
  const first = enqueueChatMessage({
    agentHome,
    channel: "telegram",
    userId: "user-chat",
    chatId: "111",
    text: "first pending",
  });
  const second = enqueueChatMessage({
    agentHome,
    channel: "telegram",
    userId: "user-chat",
    chatId: "222",
    text: "second pending",
  });
  fs.writeFileSync(replyFile, "latest pending reply\n");
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));

  try {
    await runAgentCli(["handoff", "--state", agentHome, "--id", first.id]);
    await runAgentCli(["handoff", "--state", agentHome, "--id", second.id]);
    await runAgentCli(["handoff-complete-latest", "--state", agentHome, "--from-file", replyFile]);
    await runAgentCli(["handoff-status", "--state", agentHome]);
  } finally {
    console.log = originalLog;
  }

  const firstHandoff = JSON.parse(lines[0]).handoff;
  const secondHandoff = JSON.parse(lines[1]).handoff;
  const completed = JSON.parse(lines[2]);
  const status = JSON.parse(lines[3]);

  assert.equal(completed.handoff.id, secondHandoff.id);
  assert.equal(completed.reply.chat_id, "222");
  assert.equal(status.pending, 1);
  assert.equal(status.completed, 1);
  assert.equal(status.latest_pending_handoff_id, firstHandoff.id);
});

test("agent CLI reports when no pending handoff exists", async () => {
  await assert.rejects(
    () => runAgentCli(["handoff-complete-latest", "--state", makeAgentHome("codex-agent-cli-no-pending-handoff-"), "--text", "reply"]),
    /No pending handoff/,
  );
});

test("agent CLI prunes old raw chat stores without dropping queued replies", async () => {
  const agentHome = makeAgentHome("codex-agent-chat-prune-");
  const oldDate = "2026-01-01T00:00:00.000Z";
  setAllowlistedConfig(agentHome, "user-chat");
  const oldChat = enqueueChatMessage({
    agentHome,
    channel: "telegram",
    userId: "user-chat",
    chatId: "111",
    text: "old raw text",
  });
  const newChat = enqueueChatMessage({
    agentHome,
    channel: "telegram",
    userId: "user-chat",
    chatId: "222",
    text: "new raw text",
  });
  writeJsonl(agentPaths(agentHome).chatInbox, readJsonl(agentPaths(agentHome).chatInbox).map((entry) => (
    entry.id === oldChat.id ? { ...entry, created_at: oldDate } : entry
  )));
  const oldDraft = createChatDraft({ agentHome, inboxId: oldChat.id });
  const newDraft = createChatDraft({ agentHome, inboxId: newChat.id });
  const oldHandoff = createChatHandoff({ agentHome, inboxId: oldChat.id });
  const newHandoff = createChatHandoff({ agentHome, inboxId: newChat.id });
  writeJsonl(agentPaths(agentHome).handoffs, readJsonl(agentPaths(agentHome).handoffs).map((entry) => (
    entry.id === oldHandoff.id ? { ...entry, created_at: oldDate } : entry
  )));
  const oldReply = queueChatReply({ agentHome, inboxId: oldChat.id, text: "old reply" });
  const newReply = queueChatReply({ agentHome, inboxId: newChat.id, text: "new reply" });
  const oldQueuedReply = queueChatReply({ agentHome, inboxId: oldChat.id, text: "old queued reply" });
  markReplySentForTest(agentHome, oldReply.id);
  writeJsonl(agentPaths(agentHome).chatReplies, readJsonl(agentPaths(agentHome).chatReplies).map((entry) => (
    (entry.id === oldReply.id || entry.id === oldQueuedReply.id) && entry.created_at ? { ...entry, created_at: oldDate } : entry
  )));
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));

  try {
    await runAgentCli(["chat-prune", "--state", agentHome, "--days", "30"]);
  } finally {
    console.log = originalLog;
  }

  const result = JSON.parse(lines[0]);
  const inbox = readJsonl(agentPaths(agentHome).chatInbox);
  const replies = readJsonl(agentPaths(agentHome).chatReplies);
  const handoffs = readJsonl(agentPaths(agentHome).handoffs);

  assert.equal(result.pruned_inbox, 1);
  assert.equal(result.pruned_drafts, 1);
  assert.equal(result.pruned_handoff_files, 1);
  assert.equal(result.expired_handoffs, 1);
  assert.equal(result.pruned_sent_replies, 1);
  assert.deepEqual(inbox.map((entry) => entry.id), [newChat.id]);
  assert.equal(fs.existsSync(oldDraft.path), false);
  assert.equal(fs.existsSync(newDraft.path), true);
  assert.equal(fs.existsSync(oldHandoff.path), false);
  assert.equal(fs.existsSync(newHandoff.path), true);
  assert.equal(replies.some((entry) => entry.id === oldReply.id), false);
  assert.equal(replies.some((entry) => entry.id === newReply.id), true);
  assert.equal(replies.some((entry) => entry.id === oldQueuedReply.id && entry.status === "queued"), true);
  assert.equal(handoffs.some((entry) => entry.id === oldHandoff.id && entry.status === "expired"), true);
});

test("agent CLI exchanges messages through claim and reply ledgers", async () => {
  const agentHome = makeAgentHome("codex-agent-exchange-");
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));

  try {
    await runAgentCli(["agent-enable", "--state", agentHome, "--agent", "codex", "--kind", "coding"]);
    await runAgentCli(["agent-enable", "--state", agentHome, "--agent", "claude", "--kind", "coding"]);
    await runAgentCli(["exchange-submit", "--state", agentHome, "--from", "human", "--to", "codex", "--text", "inspect mailbox"]);
    const message = JSON.parse(lines[2]).message;
    await runAgentCli(["exchange-inbox", "--state", agentHome, "--agent", "codex"]);
    await runAgentCli(["exchange-claim", "--state", agentHome, "--id", message.id, "--agent", "codex"]);
    await assert.rejects(
      () => runAgentCli(["exchange-claim", "--state", agentHome, "--id", message.id, "--agent", "claude"]),
      /addressed to codex|already claimed/,
    );
    await runAgentCli(["exchange-reply", "--state", agentHome, "--id", message.id, "--agent", "codex", "--text", "claimed and handled"]);
    await runAgentCli(["exchange-status", "--state", agentHome]);
  } finally {
    console.log = originalLog;
  }

  const submitted = JSON.parse(lines[2]).message;
  const inbox = JSON.parse(lines[3]);
  const claimed = JSON.parse(lines[4]).message;
  const replied = JSON.parse(lines[5]);
  const status = JSON.parse(lines[6]);
  const claims = readJsonl(agentPaths(agentHome).exchangeClaims);

  assert.equal(submitted.to, "codex");
  assert.equal(submitted.text_hash.length, 16);
  assert.equal(inbox.messages[0].id, submitted.id);
  assert.equal(claimed.claim.agent_id, "codex");
  assert.equal(replied.reply.message_id, submitted.id);
  assert.equal(replied.reply.agent_id, "codex");
  assert.equal(status.messages, 1);
  assert.equal(status.open, 0);
  assert.equal(status.claimed, 0);
  assert.equal(status.completed, 1);
  assert.deepEqual(claims.map((entry) => entry.status), ["claimed", "completed"]);
});

test("agent CLI exchange supports any-target inbox and from-file guards", async () => {
  const agentHome = makeAgentHome("codex-agent-exchange-any-");
  const replyFile = path.join(agentHome, "reply.txt");
  const secretFile = path.join(agentHome, "secret.txt");
  fs.writeFileSync(replyFile, "reply from exchange file\n");
  fs.writeFileSync(secretFile, "token = sk-123456789012345678901234567890\n");
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));

  try {
    await runAgentCli(["agent-enable", "--state", agentHome, "--agent", "claude", "--kind", "coding"]);
    await runAgentCli(["exchange-submit", "--state", agentHome, "--from", "human", "--to", "any", "--channel", "telegram", "--thread", "thread-1", "--text", "route this"]);
    const message = JSON.parse(lines[1]).message;
    await runAgentCli(["exchange-inbox", "--state", agentHome, "--agent", "claude"]);
    await runAgentCli(["exchange-claim", "--state", agentHome, "--id", message.id, "--agent", "claude"]);
    await assert.rejects(
      () => runAgentCli(["exchange-reply", "--state", agentHome, "--id", message.id, "--agent", "claude", "--from-file", secretFile]),
      /Exchange reply may contain a secret/,
    );
    await runAgentCli(["exchange-reply", "--state", agentHome, "--id", message.id, "--agent", "claude", "--from-file", replyFile]);
  } finally {
    console.log = originalLog;
  }

  const submitted = JSON.parse(lines[1]).message;
  const inbox = JSON.parse(lines[2]);
  const replied = JSON.parse(lines[4]);

  assert.equal(submitted.channel, "telegram");
  assert.equal(submitted.thread_id, "thread-1");
  assert.equal(inbox.messages[0].id, submitted.id);
  assert.equal(replied.reply.text, "reply from exchange file");
  assert.equal(readJsonl(agentPaths(agentHome).exchangeReplies).length, 1);
});

test("agent CLI exchange rejects second claims and non-claiming replies", async () => {
  const agentHome = makeAgentHome("codex-agent-exchange-claim-guard-");
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));

  try {
    await runAgentCli(["agent-enable", "--state", agentHome, "--agent", "codex", "--kind", "coding"]);
    await runAgentCli(["agent-enable", "--state", agentHome, "--agent", "claude", "--kind", "coding"]);
    await runAgentCli(["exchange-submit", "--state", agentHome, "--from", "human", "--to", "any", "--text", "claim once"]);
    const message = JSON.parse(lines[2]).message;
    await runAgentCli(["exchange-claim", "--state", agentHome, "--id", message.id, "--agent", "codex"]);
    await assert.rejects(
      () => runAgentCli(["exchange-claim", "--state", agentHome, "--id", message.id, "--agent", "claude"]),
      /already claimed by codex/,
    );
    await assert.rejects(
      () => runAgentCli(["exchange-reply", "--state", agentHome, "--id", message.id, "--agent", "claude", "--text", "wrong agent"]),
      /not claimed by claude/,
    );
    await runAgentCli(["exchange-reply", "--state", agentHome, "--id", message.id, "--agent", "codex", "--text", "right agent"]);
    await assert.rejects(
      () => runAgentCli(["exchange-claim", "--state", agentHome, "--id", message.id, "--agent", "codex"]),
      /already completed/,
    );
  } finally {
    console.log = originalLog;
  }

  assert.equal(readJsonl(agentPaths(agentHome).exchangeReplies).length, 1);
});

test("agent CLI exchange rejects empty submit and reply text", async () => {
  const agentHome = makeAgentHome("codex-agent-exchange-empty-");
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));

  try {
    await runAgentCli(["agent-enable", "--state", agentHome, "--agent", "codex", "--kind", "coding"]);
    await assert.rejects(
      () => runAgentCli(["exchange-submit", "--state", agentHome, "--from", "human", "--to", "codex", "--text", "  "]),
      /Exchange message text is empty/,
    );
    await runAgentCli(["exchange-submit", "--state", agentHome, "--from", "human", "--to", "codex", "--text", "nonempty"]);
    const message = JSON.parse(lines[1]).message;
    await runAgentCli(["exchange-claim", "--state", agentHome, "--id", message.id, "--agent", "codex"]);
    await assert.rejects(
      () => runAgentCli(["exchange-reply", "--state", agentHome, "--id", message.id, "--agent", "codex", "--text", "  "]),
      /Exchange reply text is empty/,
    );
  } finally {
    console.log = originalLog;
  }
});

test("agent CLI exchange requires enabled agents", async () => {
  const agentHome = makeAgentHome("codex-agent-exchange-agent-registry-");
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));

  try {
    await runAgentCli(["exchange-submit", "--state", agentHome, "--from", "human", "--to", "codex", "--text", "registered only"]);
    const message = JSON.parse(lines[0]).message;
    await assert.rejects(
      () => runAgentCli(["exchange-claim", "--state", agentHome, "--id", message.id, "--agent", "codex"]),
      /Exchange agent is not enabled: codex/,
    );
    await runAgentCli(["agent-enable", "--state", agentHome, "--agent", "codex", "--kind", "coding"]);
    await runAgentCli(["exchange-claim", "--state", agentHome, "--id", message.id, "--agent", "codex"]);
    await runAgentCli(["agent-disable", "--state", agentHome, "--agent", "codex"]);
    await assert.rejects(
      () => runAgentCli(["exchange-reply", "--state", agentHome, "--id", message.id, "--agent", "codex", "--text", "disabled"]),
      /Exchange agent is not enabled: codex/,
    );
  } finally {
    console.log = originalLog;
  }

  const enabled = JSON.parse(lines[1]).config.exchange_agents[0];
  const claims = readJsonl(agentPaths(agentHome).exchangeClaims);

  assert.equal(enabled.agent_id, "codex");
  assert.equal(enabled.kind, "coding");
  assert.deepEqual(claims.map((entry) => entry.status), ["claimed"]);
});

test("agent CLI exchange rejects replies after disabling a claiming agent", async () => {
  const agentHome = makeAgentHome("codex-agent-exchange-disable-after-claim-");
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));

  try {
    await runAgentCli(["agent-enable", "--state", agentHome, "--agent", "codex"]);
    await runAgentCli(["exchange-submit", "--state", agentHome, "--from", "human", "--to", "codex", "--text", "disable after claim"]);
    const message = JSON.parse(lines[1]).message;
    await runAgentCli(["exchange-claim", "--state", agentHome, "--id", message.id, "--agent", "codex"]);
    await runAgentCli(["agent-disable", "--state", agentHome, "--agent", "codex"]);
    await assert.rejects(
      () => runAgentCli(["exchange-reply", "--state", agentHome, "--id", message.id, "--agent", "codex", "--text", "disabled reply"]),
      /Exchange agent is not enabled: codex/,
    );
  } finally {
    console.log = originalLog;
  }

  assert.equal(readJsonl(agentPaths(agentHome).exchangeReplies).length, 0);
});

test("agent CLI exchange releases and reclaims messages", async () => {
  const agentHome = makeAgentHome("codex-agent-exchange-release-");
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));

  try {
    await runAgentCli(["agent-enable", "--state", agentHome, "--agent", "codex"]);
    await runAgentCli(["agent-enable", "--state", agentHome, "--agent", "claude"]);
    await runAgentCli(["exchange-submit", "--state", agentHome, "--from", "human", "--to", "any", "--text", "release me"]);
    const message = JSON.parse(lines[2]).message;
    await runAgentCli(["exchange-claim", "--state", agentHome, "--id", message.id, "--agent", "codex"]);
    await runAgentCli(["exchange-release", "--state", agentHome, "--id", message.id, "--agent", "codex"]);
    await runAgentCli(["exchange-claim", "--state", agentHome, "--id", message.id, "--agent", "claude"]);
    await runAgentCli(["exchange-status", "--state", agentHome]);
  } finally {
    console.log = originalLog;
  }

  const status = JSON.parse(lines.at(-1));
  const claims = readJsonl(agentPaths(agentHome).exchangeClaims);

  assert.equal(status.open, 0);
  assert.equal(status.claimed, 1);
  assert.equal(status.released, 0);
  assert.deepEqual(claims.map((entry) => entry.status), ["claimed", "released", "claimed"]);
  assert.equal(claims.at(-1).agent_id, "claude");
});

test("agent CLI exchange expired leases return to open", async () => {
  const agentHome = makeAgentHome("codex-agent-exchange-lease-");
  const oldLease = "2026-01-01T00:00:00.000Z";
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));

  try {
    await runAgentCli(["agent-enable", "--state", agentHome, "--agent", "codex"]);
    await runAgentCli(["agent-enable", "--state", agentHome, "--agent", "claude"]);
    await runAgentCli(["exchange-submit", "--state", agentHome, "--from", "human", "--to", "any", "--text", "lease me"]);
    const message = JSON.parse(lines[2]).message;
    await runAgentCli(["exchange-claim", "--state", agentHome, "--id", message.id, "--agent", "codex", "--lease-seconds", "1"]);
    writeJsonl(agentPaths(agentHome).exchangeClaims, readJsonl(agentPaths(agentHome).exchangeClaims).map((entry) => (
      entry.message_id === message.id ? { ...entry, lease_expires_at: oldLease } : entry
    )));
    await runAgentCli(["exchange-status", "--state", agentHome]);
    await assert.rejects(
      () => runAgentCli(["exchange-reply", "--state", agentHome, "--id", message.id, "--agent", "codex", "--text", "too late"]),
      /not claimed by codex/,
    );
    await runAgentCli(["exchange-claim", "--state", agentHome, "--id", message.id, "--agent", "claude"]);
  } finally {
    console.log = originalLog;
  }

  const status = JSON.parse(lines[4]);
  const claims = readJsonl(agentPaths(agentHome).exchangeClaims);

  assert.equal(status.open, 1);
  assert.equal(status.expired, 1);
  assert.equal(status.claimed, 0);
  assert.equal(claims.at(-1).agent_id, "claude");
});

test("agent CLI exchange prunes completed raw message and reply text", async () => {
  const agentHome = makeAgentHome("codex-agent-exchange-prune-");
  const oldDate = "2026-01-01T00:00:00.000Z";
  const lines = [];
  let oldMessage;
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));

  try {
    await runAgentCli(["agent-enable", "--state", agentHome, "--agent", "codex"]);
    await runAgentCli(["agent-enable", "--state", agentHome, "--agent", "claude"]);
    await runAgentCli(["exchange-submit", "--state", agentHome, "--from", "human", "--to", "codex", "--text", "old exchange raw"]);
    oldMessage = JSON.parse(lines[2]).message;
    await runAgentCli(["exchange-claim", "--state", agentHome, "--id", oldMessage.id, "--agent", "codex"]);
    await runAgentCli(["exchange-reply", "--state", agentHome, "--id", oldMessage.id, "--agent", "codex", "--text", "old exchange reply"]);
    await runAgentCli(["exchange-submit", "--state", agentHome, "--from", "human", "--to", "codex", "--text", "new exchange raw"]);
    await runAgentCli(["exchange-submit", "--state", agentHome, "--from", "human", "--to", "any", "--text", "old claimed survivor"]);
    const claimedSurvivor = JSON.parse(lines[6]).message;
    await runAgentCli(["exchange-claim", "--state", agentHome, "--id", claimedSurvivor.id, "--agent", "claude"]);
    await runAgentCli(["exchange-submit", "--state", agentHome, "--from", "human", "--to", "any", "--text", "old released survivor"]);
    const releasedSurvivor = JSON.parse(lines[8]).message;
    await runAgentCli(["exchange-claim", "--state", agentHome, "--id", releasedSurvivor.id, "--agent", "claude"]);
    await runAgentCli(["exchange-release", "--state", agentHome, "--id", releasedSurvivor.id, "--agent", "claude"]);
    writeJsonl(agentPaths(agentHome).exchangeMessages, readJsonl(agentPaths(agentHome).exchangeMessages).map((entry) => (
      [oldMessage.id, claimedSurvivor.id, releasedSurvivor.id].includes(entry.id) ? { ...entry, created_at: oldDate } : entry
    )));
    await runAgentCli(["exchange-prune", "--state", agentHome, "--days", "30"]);
  } finally {
    console.log = originalLog;
  }

  const result = JSON.parse(lines.at(-1));
  const messages = readJsonl(agentPaths(agentHome).exchangeMessages);
  const claims = readJsonl(agentPaths(agentHome).exchangeClaims);
  const replies = readJsonl(agentPaths(agentHome).exchangeReplies);

  assert.equal(result.pruned_messages, 1);
  assert.equal(result.pruned_claim_events, 2);
  assert.equal(result.pruned_replies, 1);
  assert.equal(messages.some((entry) => entry.text === "old exchange raw"), false);
  assert.equal(messages.some((entry) => entry.text === "new exchange raw"), true);
  assert.equal(messages.some((entry) => entry.text === "old claimed survivor"), true);
  assert.equal(messages.some((entry) => entry.text === "old released survivor"), true);
  assert.equal(claims.some((entry) => entry.message_id === oldMessage.id), false);
  assert.equal(replies.length, 0);
});

test("agent CLI exchange lets requesters read completed replies and threads", async () => {
  const agentHome = makeAgentHome("codex-agent-exchange-replies-");
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));

  try {
    await runAgentCli(["agent-enable", "--state", agentHome, "--agent", "opus"]);
    await runAgentCli(["exchange-submit", "--state", agentHome, "--from", "codex", "--to", "opus", "--thread", "review-1", "--text", "Please review DS7-A"]);
    const message = JSON.parse(lines[1]).message;
    await runAgentCli(["exchange-claim", "--state", agentHome, "--id", message.id, "--agent", "opus"]);
    await runAgentCli(["exchange-reply", "--state", agentHome, "--id", message.id, "--agent", "opus", "--text", "No findings"]);
    await runAgentCli(["exchange-inbox", "--state", agentHome, "--agent", "opus"]);
    await runAgentCli(["exchange-replies", "--state", agentHome, "--agent", "codex"]);
    await runAgentCli(["exchange-replies", "--state", agentHome, "--agent", "codex", "--thread", "review-1"]);
    await runAgentCli(["exchange-thread", "--state", agentHome, "--id", message.id]);
    await runAgentCli(["exchange-status", "--state", agentHome]);
  } finally {
    console.log = originalLog;
  }

  const inboxAfterReply = JSON.parse(lines[4]);
  const replies = JSON.parse(lines[5]).replies;
  const threadReplies = JSON.parse(lines[6]).replies;
  const thread = JSON.parse(lines[7]);
  const status = JSON.parse(lines[8]);

  assert.equal(inboxAfterReply.messages.length, 0);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].from, "codex");
  assert.equal(replies[0].responder, "opus");
  assert.equal(replies[0].request_text, "Please review DS7-A");
  assert.equal(replies[0].reply_text, "No findings");
  assert.equal(threadReplies[0].thread_id, "review-1");
  assert.equal(thread.message.text, "Please review DS7-A");
  assert.equal(thread.replies[0].reply_text, "No findings");
  assert.equal(status.completed, 1);
});

test("agent CLI exchange reply reads are scoped and non-mutating", async () => {
  const agentHome = makeAgentHome("codex-agent-exchange-replies-scoped-");
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));

  try {
    await runAgentCli(["agent-enable", "--state", agentHome, "--agent", "opus"]);
    await runAgentCli(["exchange-submit", "--state", agentHome, "--from", "codex", "--to", "opus", "--thread", "codex-thread", "--text", "codex request"]);
    const codexMessage = JSON.parse(lines[1]).message;
    await runAgentCli(["exchange-submit", "--state", agentHome, "--from", "human", "--to", "opus", "--thread", "human-thread", "--text", "human request"]);
    const humanMessage = JSON.parse(lines[2]).message;
    await runAgentCli(["exchange-claim", "--state", agentHome, "--id", codexMessage.id, "--agent", "opus"]);
    await runAgentCli(["exchange-reply", "--state", agentHome, "--id", codexMessage.id, "--agent", "opus", "--text", "codex reply"]);
    await runAgentCli(["exchange-claim", "--state", agentHome, "--id", humanMessage.id, "--agent", "opus"]);
    await runAgentCli(["exchange-reply", "--state", agentHome, "--id", humanMessage.id, "--agent", "opus", "--text", "human reply"]);
    const claimsBefore = readJsonl(agentPaths(agentHome).exchangeClaims);
    await runAgentCli(["exchange-replies", "--state", agentHome, "--agent", "codex"]);
    await runAgentCli(["exchange-replies", "--state", agentHome, "--agent", "codex", "--thread", "missing-thread"]);
    const claimsAfter = readJsonl(agentPaths(agentHome).exchangeClaims);
    assert.deepEqual(claimsAfter, claimsBefore);
  } finally {
    console.log = originalLog;
  }

  const replies = JSON.parse(lines[7]).replies;
  const emptyThread = JSON.parse(lines[8]).replies;

  assert.equal(replies.length, 1);
  assert.equal(replies[0].request_text, "codex request");
  assert.equal(replies[0].reply_text, "codex reply");
  assert.equal(emptyThread.length, 0);
});

test("agent CLI exchange redacts secret-bearing submit text instead of rejecting", async () => {
  const agentHome = makeAgentHome("codex-agent-exchange-submit-secret-");
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));

  try {
    await runAgentCli(["exchange-submit", "--state", agentHome, "--from", "codex", "--to", "opus", "--text", "review token = abcdefghijklmnopqrstuvwxyz please"]);
  } finally {
    console.log = originalLog;
  }
  const message = JSON.parse(lines[0]).message;
  const stored = readJsonl(agentPaths(agentHome).exchangeMessages);

  assert.equal(stored.length, 1);
  assert.equal(message.text.includes("[redacted:"), true);
  assert.equal(message.text.includes("abcdefghijklmnopqrstuvwxyz"), false);
  assert.equal(stored[0].text_hash, message.text_hash);
  // No raw secret anywhere in the persisted record (text, hash, or id).
  assert.equal(JSON.stringify(stored[0]).includes("abcdefghijklmnopqrstuvwxyz"), false);
});

test("agent CLI exchange from-file submit is accepted and persisted redacted", async () => {
  const agentHome = makeAgentHome("codex-agent-exchange-submit-file-secret-");
  const submitFile = path.join(agentHome, "request.txt");
  fs.writeFileSync(submitFile, "please review Authorization: Bearer abcdefghijklmnop now\n");
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));

  try {
    await runAgentCli(["exchange-submit", "--state", agentHome, "--from", "codex", "--to", "opus", "--from-file", submitFile]);
  } finally {
    console.log = originalLog;
  }
  const stored = readJsonl(agentPaths(agentHome).exchangeMessages);

  assert.equal(stored.length, 1);
  assert.equal(stored[0].text.includes("[redacted:"), true);
  assert.equal(stored[0].text.includes("abcdefghijklmnop"), false);
  assert.equal(JSON.stringify(stored[0]).includes("abcdefghijklmnop"), false);
});

test("agent CLI exchange-replies includes any-target messages from the requester", async () => {
  const agentHome = makeAgentHome("codex-agent-exchange-any-from-");
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));

  try {
    await runAgentCli(["agent-enable", "--state", agentHome, "--agent", "opus"]);
    await runAgentCli(["exchange-submit", "--state", agentHome, "--from", "codex", "--to", "any", "--text", "review for anyone"]);
    const message = JSON.parse(lines[1]).message;
    await runAgentCli(["exchange-claim", "--state", agentHome, "--id", message.id, "--agent", "opus"]);
    await runAgentCli(["exchange-reply", "--state", agentHome, "--id", message.id, "--agent", "opus", "--text", "any reply"]);
    await runAgentCli(["exchange-replies", "--state", agentHome, "--agent", "codex"]);
  } finally {
    console.log = originalLog;
  }
  const replies = JSON.parse(lines[4]).replies;

  assert.equal(replies.length, 1);
  assert.equal(replies[0].to, "any");
  assert.equal(replies[0].reply_text, "any reply");
});

test("agent CLI exchange-thread returns empty replies for an unreplied message", async () => {
  const agentHome = makeAgentHome("codex-agent-exchange-thread-empty-");
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));

  try {
    await runAgentCli(["exchange-submit", "--state", agentHome, "--from", "codex", "--to", "opus", "--text", "no reply yet"]);
    const message = JSON.parse(lines[0]).message;
    await runAgentCli(["exchange-thread", "--state", agentHome, "--id", message.id]);
  } finally {
    console.log = originalLog;
  }
  const thread = JSON.parse(lines[1]);

  assert.equal(thread.message.text, "no reply yet");
  assert.deepEqual(thread.replies, []);
});

test("agent CLI exchange-thread rejects an unknown message id", async () => {
  const agentHome = makeAgentHome("codex-agent-exchange-thread-bogus-");

  await assert.rejects(
    () => runAgentCli(["exchange-thread", "--state", agentHome, "--id", "msg_does_not_exist"]),
    /Exchange message not found/,
  );
});

test("agent CLI exchange read commands do not mutate any ledger", async () => {
  const agentHome = makeAgentHome("codex-agent-exchange-read-nomutate-");
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));
  let message;

  try {
    await runAgentCli(["agent-enable", "--state", agentHome, "--agent", "opus"]);
    await runAgentCli(["exchange-submit", "--state", agentHome, "--from", "codex", "--to", "opus", "--thread", "t1", "--text", "request body"]);
    message = JSON.parse(lines[1]).message;
    await runAgentCli(["exchange-claim", "--state", agentHome, "--id", message.id, "--agent", "opus"]);
    await runAgentCli(["exchange-reply", "--state", agentHome, "--id", message.id, "--agent", "opus", "--text", "reply body"]);
  } finally {
    console.log = originalLog;
  }

  const paths = agentPaths(agentHome);
  const before = {
    messages: readJsonl(paths.exchangeMessages),
    claims: readJsonl(paths.exchangeClaims),
    replies: readJsonl(paths.exchangeReplies),
  };
  const restoreLog = console.log;
  console.log = () => {};
  try {
    await runAgentCli(["exchange-replies", "--state", agentHome, "--agent", "codex"]);
    await runAgentCli(["exchange-replies", "--state", agentHome, "--agent", "codex", "--thread", "t1"]);
    await runAgentCli(["exchange-thread", "--state", agentHome, "--id", message.id]);
  } finally {
    console.log = restoreLog;
  }
  const after = {
    messages: readJsonl(paths.exchangeMessages),
    claims: readJsonl(paths.exchangeClaims),
    replies: readJsonl(paths.exchangeReplies),
  };

  assert.deepEqual(after, before);
});

test("agent CLI lists and shows dispatch approvals", async () => {
  const agentHome = makeAgentHome("codex-agent-dispatch-cli-");
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));
  try {
    await runAgentCli(["agent-enable", "--state", agentHome, "--agent", "opus", "--kind", "review"]);
    const pending = createDispatchApproval({
      agentHome,
      proposedBy: "opus",
      proposal: {
        to: "codex",
        task: "Inspect the pending dispatch list command output.",
        reason: "Operator should see pending dispatches.",
        suggested_mode: "plan",
      },
      chatId: "456",
      now: 1000,
    }).approval;
    const approved = createDispatchApproval({
      agentHome,
      proposedBy: "codex",
      proposal: {
        to: "opus",
        task: "Review the approved dispatch show command output.",
        reason: "Operator should see the exchange outcome.",
        suggested_mode: "plan",
      },
      chatId: "456",
      now: 2000,
    }).approval;
    approveDispatch({ agentHome, id: approved.id, defaultRepo: "/repo/unused", now: 3000 });

    await runAgentCli(["dispatch-list", "--state", agentHome, "--status", "pending"]);
    await runAgentCli(["dispatch-list", "--state", agentHome, "--status", "approved"]);
    await runAgentCli(["dispatch-show", "--state", agentHome, "--id", approved.id]);
    await assert.rejects(
      () => runAgentCli(["dispatch-list", "--state", agentHome, "--status", "waiting"]),
      /Invalid dispatch status/,
    );

    const pendingList = JSON.parse(lines[1]);
    const approvedList = JSON.parse(lines[2]);
    const shown = JSON.parse(lines[3]).dispatch;
    assert.deepEqual(pendingList.dispatches.map((entry) => entry.id), [pending.id]);
    assert.deepEqual(approvedList.dispatches.map((entry) => entry.id), [approved.id]);
    assert.equal(shown.id, approved.id);
    assert.equal(shown.status, "approved");
    assert.equal(shown.outcome.type, "exchange");
  } finally {
    console.log = originalLog;
  }
});

test("agent CLI controls local kill switch and token budget", async () => {
  const agentHome = makeAgentHome("codex-agent-cli-safety-");
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));

  try {
    await runAgentCli(["budget", "--state", agentHome, "--tokens", "0"]);
    await runAgentCli(["budget", "--state", agentHome, "--tokens", "disabled"]);
    await runAgentCli(["pause", "--state", agentHome]);
    await runAgentCli(["resume", "--state", agentHome]);
    await runAgentCli(["status", "--state", agentHome]);
  } finally {
    console.log = originalLog;
  }

  const budget = JSON.parse(lines[0]);
  const disabled = JSON.parse(lines[1]);
  const paused = JSON.parse(lines[2]);
  const resumed = JSON.parse(lines[3]);
  const status = JSON.parse(lines[4]);

  assert.equal(budget.config.daily_token_budget, 0);
  assert.equal(disabled.config.daily_token_budget, Number.MAX_SAFE_INTEGER);
  assert.equal(paused.config.kill_switch, true);
  assert.equal(resumed.config.kill_switch, false);
  assert.equal(status.safety.config.daily_token_budget, Number.MAX_SAFE_INTEGER);
});

test("codex-reply-once still uses the manual draft prompt", async () => {
  const agentHome = makeAgentHome("codex-agent-reply-once-manual-prompt-");
  setAllowlistedConfig(agentHome, "user-chat");
  enqueueChatMessage({ agentHome, channel: "telegram", userId: "user-chat", chatId: "456", text: "你好" });
  let seenPrompt = "";

  await codexReplyOnce({
    agentHome,
    runner: async ({ prompt }) => { seenPrompt = prompt; return "drafted reply"; },
  });

  assert.match(seenPrompt, /drafting a conservative manual reply/);
  assert.doesNotMatch(seenPrompt, /replying directly to a Telegram user/);
});

test("codex-reply-once queues a fake-runner reply for the latest inbox entry", async () => {
  const agentHome = makeAgentHome("codex-agent-reply-once-latest-");
  setAllowlistedConfig(agentHome, "user-chat");
  enqueueChatMessage({ agentHome, channel: "telegram", userId: "user-chat", chatId: "111", text: "older message" });
  const latest = enqueueChatMessage({ agentHome, channel: "telegram", userId: "user-chat", chatId: "222", text: "reply to me" });
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));

  try {
    await runAgentCli(["codex-reply-once", "--state", agentHome]);
  } finally {
    console.log = originalLog;
  }

  const result = JSON.parse(lines[0]);
  const replies = readJsonl(agentPaths(agentHome).chatReplies);

  assert.equal(result.inbox_id, latest.id);
  assert.equal(result.queued, true);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].id, result.reply_id);
  assert.equal(replies[0].inbox_id, latest.id);
  assert.equal(replies[0].chat_id, "222");
  assert.equal(replies[0].status, "queued");
  assert.match(replies[0].text, /fake runner/i);
});

test("codex-reply-once --id targets the specified inbox entry", async () => {
  const agentHome = makeAgentHome("codex-agent-reply-once-id-");
  setAllowlistedConfig(agentHome, "user-chat");
  const target = enqueueChatMessage({ agentHome, channel: "telegram", userId: "user-chat", chatId: "111", text: "target this" });
  enqueueChatMessage({ agentHome, channel: "telegram", userId: "user-chat", chatId: "222", text: "newer message" });
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));

  try {
    await runAgentCli(["codex-reply-once", "--state", agentHome, "--id", target.id]);
  } finally {
    console.log = originalLog;
  }

  const result = JSON.parse(lines[0]);
  assert.equal(result.inbox_id, target.id);
  assert.equal(result.queued, true);
  assert.equal(readJsonl(agentPaths(agentHome).chatReplies)[0].chat_id, "111");
});

test("codex-reply-once fails cleanly for a nonexistent inbox id", async () => {
  const agentHome = makeAgentHome("codex-agent-reply-once-missing-");
  setAllowlistedConfig(agentHome, "user-chat");

  await assert.rejects(
    () => codexReplyOnce({ agentHome, inboxId: "chat_does_not_exist" }),
    /Chat message not found/,
  );
  assert.equal(readJsonl(agentPaths(agentHome).chatReplies).length, 0);
});

test("codex-reply-once rejects secret-like fake runner output", async () => {
  const agentHome = makeAgentHome("codex-agent-reply-once-secret-");
  setAllowlistedConfig(agentHome, "user-chat");
  enqueueChatMessage({ agentHome, channel: "telegram", userId: "user-chat", chatId: "222", text: "give me a key" });

  await assert.rejects(
    () => codexReplyOnce({
      agentHome,
      runner: async () => "token = sk-123456789012345678901234567890",
    }),
    /Reply may contain a secret/,
  );
  assert.equal(readJsonl(agentPaths(agentHome).chatReplies).length, 0);
});

test("codex-reply-once introduces no shell/network/exec and package exposes codex-agent without hard Memory River dependency", async () => {
  const source = fs.readFileSync(new URL("../src/agent/codex-reply.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /child_process|node:http|node:https|node:net|globalThis\.fetch|\bfetch\(|\bspawn\(|\bexecFile\(/);
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.bin["codex-agent"], "bin/codex-agent.js");
  assert.equal(pkg.dependencies?.["codex-memory-river"], undefined);
});

test("memory adapter skips Memory River when disabled and fails closed when unavailable", async () => {
  const disabled = await buildMemoryContextBlock({
    enabled: false,
    repo: "/repo/memory-river",
    importImpl: async () => {
      throw new Error("should not import");
    },
  });
  assert.equal(disabled, "");

  await assert.rejects(
    () => buildMemoryContextBlock({
      enabled: true,
      repo: "/repo/memory-river",
      memoryStateHome: "/state/missing",
      importImpl: async () => {
        throw new Error("Cannot find package");
      },
    }),
    (error) => {
      assert.equal(error.reason, "memory_unavailable");
      assert.match(error.message, /Memory River unavailable/);
      return true;
    },
  );

  await assert.rejects(
    () => buildMemoryContextBlock({
      enabled: true,
      repo: "/repo/memory-river",
      memoryStateHome: "/state/broken",
      preflightImpl: async () => {
        throw new Error("preflight failed");
      },
      contextBlockImpl: () => "unused",
    }),
    (error) => {
      assert.equal(error.reason, "memory_context_failed");
      return true;
    },
  );
});

function makeAgentHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeMemoryState(prefix) {
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  writeJsonl(statePaths(stateHome).memories, [{
    id: "mem_agent_context",
    scope: "repo:/repo/memory-river",
    type: "workflow_rule",
    content: "Memory-backed planning context should be included.",
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

function setAllowlistedConfig(agentHome, userId) {
  fs.mkdirSync(agentHome, { recursive: true });
  fs.writeFileSync(path.join(agentHome, "config.json"), `${JSON.stringify({
    kill_switch: false,
    daily_token_budget: 20000,
    gateway_allowlist: [userId],
  })}\n`);
}

function markReplySentForTest(agentHome, id) {
  writeJsonl(agentPaths(agentHome).chatReplies, [
    ...readJsonl(agentPaths(agentHome).chatReplies),
    { id, status: "sent", sent_at: new Date().toISOString() },
  ]);
}

function fakeTask({ id = `task_${Date.now()}_fake`, mode = "plan", status = "queued", approval = "not_required" } = {}) {
  const now = new Date().toISOString();
  return {
    id,
    source: "test",
    requester: "local",
    repo: "/repo/memory-river",
    request: "Synthetic task",
    mode,
    status,
    approval,
    worktree: null,
    attempts: 0,
    max_attempts: 2,
    cost: { tokens: 0, usd_estimate: 0 },
    created_at: now,
    updated_at: now,
    history: [{ ts: now, state: status, note: "Task submitted.", codex_session: null }],
    result: { summary: null, diff_ref: null, tests: null, artifacts: [] },
  };
}
