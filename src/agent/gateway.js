import { appendJsonl } from "codex-memory-river/src/jsonl.js";
import { scanSecrets } from "codex-memory-river/src/secret-scan.js";
import { shortHash } from "codex-memory-river/src/hash.js";
import { agentPaths } from "./paths.js";
import { approveAgentTask, getAgentStatus, rejectAgentTask, runAgentOnce, submitAgentTask } from "./orchestrator.js";
import { createTask, readTask } from "./tasks.js";
import { realPlanRunner } from "./codex-runner.js";
import { getExchangeThread, listExchangeInbox, listExchangeReplies, submitExchangeMessage } from "./exchange.js";
import { getPrimaryAgentId, getTelegramCodexPolicy, isExchangeAgentEnabled, isGatewayUserAllowed, setTelegramCodexPolicy } from "./safety.js";
import { runExchangeRunnerOnce, defaultRunnerSettingsPath } from "./exchange-runner.js";
import fs from "node:fs";
import {
  classifyOpusAsk,
  isOwner,
  ownerApproveEditNotice,
  ownerEditActionNotice,
  ownerTaskReplyMarkup,
  OWNER_BLOCKED_NOTICE,
  OWNER_DANGEROUS_ACTION_NOTICE,
  OWNER_NO_REPO_NOTICE,
} from "./owner-mode.js";

// Fire-and-forget: start the runner in the background without blocking the
// Telegram long-poll loop. Never awaited, never throws into the caller.
function defaultRunnerTrigger({ agentHome }) {
  runExchangeRunnerOnce({ agentHome }).catch(() => {});
}

// Synchronous preflight so an @opus ack never falsely promises a reply: the
// runner only processes when it is enabled AND its restricted settings file
// exists (fail-closed). Mirrors the runner's own gates without spawning.
function opusRunnerReadiness(agentHome) {
  const policy = getTelegramCodexPolicy(agentHome);
  if (!policy.exchange_runner_enabled) {
    return { ready: false, reason: "runner 未啟用" };
  }
  if (!fs.existsSync(defaultRunnerSettingsPath())) {
    return { ready: false, reason: "runner 設定檔不存在" };
  }
  return { ready: true, reason: null };
}

export async function handleGatewayMessage({ agentHome, userId, chatId, text, memoryStateHome, runner, execFileImpl, runnerTrigger }) {
  const parsed = parseGatewayCommand(text);
  const allowed = isGatewayUserAllowed(agentHome, userId);
  let taskId = null;
  let reply = "Access denied.";
  let ok = false;
  let runnerTriggered = null;

  let replyMarkup = null;
  if (allowed) {
    try {
      const result = await executeGatewayCommand({ agentHome, parsed, userId, chatId, memoryStateHome, runner, execFileImpl, runnerTrigger: runnerTrigger ?? defaultRunnerTrigger });
      ok = result.ok;
      reply = result.reply;
      taskId = result.taskId || null;
      runnerTriggered = result.runnerTriggered ?? null;
      replyMarkup = result.reply_markup ?? null;
    } catch {
      reply = "Command failed.";
    }
  }

  const safeReply = safeGatewayReply(reply);
  appendGatewayAudit(agentHome, {
    user_id: String(userId || ""),
    text_hash: shortHash(String(text || "")),
    command: parsed.command,
    allowed,
    ok,
    task_id: taskId,
  });

  return {
    ok,
    allowed,
    command: parsed.command,
    reply: safeReply,
    task_id: taskId,
    runner_triggered: runnerTriggered,
    reply_markup: replyMarkup,
  };
}

export function parseGatewayCommand(text) {
  const raw = String(text || "").trim();
  const shortcut = parseGatewayShortcut(raw);
  if (shortcut) {
    return shortcut;
  }
  const tokens = tokenize(raw);
  if (tokens.length === 0) {
    return { command: "empty", args: {} };
  }
  if (tokens[0] === "status") {
    return { command: tokens.length === 1 ? "agent_status" : "unknown", args: { id: null } };
  }
  if (tokens[0] !== "agent") {
    return { command: "unknown", args: {} };
  }
  if (tokens[1] === "help" && tokens.length === 2) {
    return { command: "agent_help", args: {} };
  }
  if (tokens[1] === "status" && tokens.length === 2) {
    return { command: "agent_status", args: { id: null } };
  }
  if (tokens[1] === "status" && tokens.length === 3 && isTaskId(tokens[2])) {
    return { command: "agent_status", args: { id: tokens[2] || null } };
  }
  if (tokens[1] === "run" && tokens.length === 2) {
    return { command: "invalid_run", args: {} };
  }
  if (tokens[1] === "run" && tokens.length === 3 && isTaskId(tokens[2])) {
    return { command: "agent_run", args: { id: tokens[2] } };
  }
  if (tokens[1] === "approve" && tokens.length === 3 && isTaskId(tokens[2])) {
    return { command: "agent_approve", args: { id: tokens[2] } };
  }
  if (tokens[1] === "reject" && tokens.length === 3 && isTaskId(tokens[2])) {
    return { command: "agent_reject", args: { id: tokens[2] } };
  }
  if (tokens[1] === "thread" && tokens.length === 3 && isMessageId(tokens[2])) {
    return { command: "exchange_thread", args: { id: tokens[2] } };
  }
  if (tokens[1] === "submit") {
    return parseSubmitCommand(tokens.slice(2));
  }
  if (tokens[1] === "config") {
    return parseConfigCommand(tokens.slice(2));
  }
  return { command: "unknown", args: {} };
}

export function parseGatewayShortcut(text) {
  const raw = String(text || "").trim();
  let match = raw.match(/^@([a-z][a-z0-9_-]*)\s+(.+)$/);
  if (!match) {
    match = raw.match(/^([a-z][a-z0-9_-]*):\s*(.+)$/);
  }
  if (!match) {
    return null;
  }
  const agent = match[1];
  const body = match[2].trim();
  if (!body || agent === "any") {
    return { command: "unknown", args: {} };
  }
  if (body === "inbox") {
    return { command: "exchange_inbox", args: { agent } };
  }
  if (body === "replies") {
    return { command: "exchange_replies", args: { agent, threadId: null } };
  }
  return { command: "exchange_ask", args: { agent, text: body, threadId: null } };
}

export function safeGatewayReply(text) {
  if (scanSecrets(String(text || "")).length > 0) {
    return "Response withheld because it may contain a secret.";
  }
  return String(text || "");
}

async function executeGatewayCommand({ agentHome, parsed, userId, chatId, memoryStateHome, runner, execFileImpl, runnerTrigger }) {
  switch (parsed.command) {
    case "agent_help":
      return { ok: true, reply: formatAgentHelp() };
    case "agent_status":
      return { ok: true, reply: formatAgentStatus(getAgentStatus({ agentHome, id: parsed.args.id })) };
    case "agent_run":
      return {
        ok: true,
        // Remote gateway runs with no injected runner must use the real Codex
        // plan runner, never worker.js's fakeRunner. A planning throw is handled
        // by runPlanOnlyTask (task -> failed), not left stranded.
        reply: formatAgentRun(await runAgentOnce({
          agentHome,
          memoryStateHome,
          taskId: parsed.args.id,
          runner: runner || ((args) => realPlanRunner({ ...args, execFileImpl })),
        })),
        taskId: parsed.args.id,
      };
    case "agent_approve": {
      const task = approveAgentTask({ agentHome, id: parsed.args.id });
      return {
        ok: true,
        taskId: task.id,
        reply: `Approved task ${task.id}: ${task.approval}`,
      };
    }
    case "agent_reject": {
      const task = rejectAgentTask({ agentHome, id: parsed.args.id });
      return {
        ok: true,
        taskId: task.id,
        reply: `Rejected task ${task.id}: ${task.status}`,
      };
    }
    case "agent_submit": {
      // Remote gateway submissions require an explicit approval before they can
      // run (mirrors DS owner action tasks); `agent run` will not advance them.
      const task = submitAgentTask({
        agentHome,
        repo: parsed.args.repo,
        request: parsed.args.request,
        mode: "plan",
        approval: "pending",
      });
      return {
        ok: true,
        taskId: task.id,
        reply: `Submitted plan task ${task.id}: ${task.status} (approval: ${task.approval})`,
      };
    }
    case "exchange_ask": {
      if (!isExchangeAgentEnabled(agentHome, parsed.args.agent)) {
        return { ok: false, reply: `Exchange agent is not enabled: ${parsed.args.agent}` };
      }
      // Owner @opus messages can drive plan/execute, not only review. Edit
      // intent becomes a bounded edit task (executor=opus); dangerous intent is
      // declined; conversation/plan/review falls through to the read-only
      // mailbox lane below. Non-owners always stay on the read-only lane.
      if (parsed.args.agent === "opus" && isOwner({ user_id: userId }, getTelegramCodexPolicy(agentHome))) {
        const routed = await routeOwnerOpusAsk({ agentHome, chatId, text: parsed.args.text, memoryStateHome, runner, execFileImpl });
        if (routed) {
          return routed;
        }
      }
      const message = submitExchangeMessage({
        agentHome,
        from: getPrimaryAgentId(agentHome),
        to: parsed.args.agent,
        channel: "telegram",
        threadId: parsed.args.threadId,
        chatId,
        text: parsed.args.text,
      });
      if (parsed.args.agent !== "opus") {
        return { ok: true, reply: `Sent exchange message ${message.id} to ${message.to}.` };
      }
      // Kick the runner directly in the background so the message is picked up
      // immediately without waiting for the 90s timer. Fire-and-forget: never
      // awaited, never throws into the long-poll loop. Timer stays as fallback.
      let runnerTriggered = null;
      try { runnerTrigger({ agentHome }); runnerTriggered = true; } catch { runnerTriggered = false; }
      // Honest ack: only promise a reply if the runner can actually process it.
      // Otherwise tell the owner why it will stay silent (no false promise). The
      // msg id is kept parenthetically for debugging / follow-up reads.
      const readiness = opusRunnerReadiness(agentHome);
      const reply = readiness.ready
        ? `Opus 收到,正在處理,完成後回你。(${message.id})`
        : `已收到並放進 Opus 信箱 (${message.id}),但目前不會自動回覆(${readiness.reason})。`;
      return { ok: true, reply, runnerTriggered };
    }
    case "exchange_inbox":
      return { ok: true, reply: formatExchangeInbox(listExchangeInbox(agentHome, { agent: parsed.args.agent }), parsed.args.agent) };
    case "exchange_replies":
      return { ok: true, reply: formatExchangeReplies(listExchangeReplies(agentHome, { agent: parsed.args.agent, threadId: parsed.args.threadId }), parsed.args.agent) };
    case "exchange_thread":
      return { ok: true, reply: formatExchangeThread(getExchangeThread(agentHome, parsed.args.id)) };
    case "agent_config": {
      const { key, value } = parsed.args;
      if (key === "opus-model") {
        setTelegramCodexPolicy(agentHome, { exchange_runner_model: value });
        return { ok: true, reply: `Opus runner model set to: ${value}` };
      }
      return { ok: false, reply: "Unknown config key." };
    }
    case "empty":
      return { ok: false, reply: "Empty command." };
    case "invalid_run":
      return { ok: false, reply: "Usage: agent run task_id." };
    case "invalid_config":
      return { ok: false, reply: "Usage: agent config opus-model sonnet|opus" };
    default:
      return { ok: false, reply: "Unknown command." };
  }
}

// Routes an owner @opus message that wants more than conversation. Returns a
// gateway result, or null to fall through to the read-only mailbox lane.
async function routeOwnerOpusAsk({ agentHome, chatId, text, memoryStateHome, runner, execFileImpl }) {
  const policy = getTelegramCodexPolicy(agentHome);
  const decision = classifyOpusAsk(text, policy);

  if (decision.lane === "conversation") {
    return null;
  }
  if (decision.lane === "blocked") {
    return { ok: false, reply: OWNER_BLOCKED_NOTICE };
  }
  if (decision.lane === "dangerous") {
    return { ok: true, reply: OWNER_DANGEROUS_ACTION_NOTICE };
  }
  // edit lanes need a repo to operate in.
  if (!policy.default_repo) {
    return { ok: false, reply: OWNER_NO_REPO_NOTICE };
  }
  const created = createTask({
    agentHome,
    repo: policy.default_repo,
    request: text,
    mode: "edit",
    executor: "opus",
    chatId,
    source: "telegram",
    requester: "owner",
  });

  if (decision.lane === "edit_approve") {
    return {
      ok: true,
      taskId: created.id,
      reply: ownerEditActionNotice(created.id),
      reply_markup: ownerTaskReplyMarkup(created.id),
    };
  }

  // edit_auto: low-risk — approve and run now. Still fully bounded (repo
  // allowlist, no commit/push, verify wrapper, diff report). runner is passed
  // through for tests; production passes none so runEditTask builds the Opus
  // edit runner itself.
  approveAgentTask({ agentHome, id: created.id });
  let task = created;
  try {
    const run = await runAgentOnce({ agentHome, memoryStateHome, taskId: created.id, runner, execFileImpl });
    task = run.tasks.find((entry) => entry.id === created.id) || readTask(agentHome, created.id) || created;
  } catch {
    task = readTask(agentHome, created.id) || created;
  }
  return { ok: true, taskId: created.id, reply: ownerApproveEditNotice(task) };
}

function formatAgentHelp() {
  return [
    "Commands:",
    "  @opus <message>             → send message to Opus",
    "  @opus inbox                 → list pending Opus messages",
    "  agent status [task_id]",
    "  agent submit --repo /path --request \"...\"",
    "  agent approve task_...",
    "  agent reject task_...",
    "  agent run task_...",
    "  agent thread msg_...        → show exchange thread",
    "  agent config opus-model sonnet|opus",
  ].join("\n");
}

function parseExchangeAskCommand(tokens) {
  if (tokens.length < 3 || !isExchangeName(tokens[0]) || tokens[0] === "any") {
    return { command: "unknown", args: {} };
  }
  const textIndex = tokens.indexOf("--text");
  const threadIndex = tokens.indexOf("--thread");
  if (textIndex === -1 || isFlagValueMissing(tokens, textIndex)) {
    return { command: "invalid_exchange_ask", args: {} };
  }
  if (threadIndex !== -1 && isFlagValueMissing(tokens, threadIndex)) {
    return { command: "invalid_exchange_ask", args: {} };
  }
  if (hasUnexpectedExchangeAskTokens(tokens, textIndex, threadIndex)) {
    return { command: "invalid_exchange_ask", args: {} };
  }
  return {
    command: "exchange_ask",
    args: {
      agent: tokens[0],
      text: tokens[textIndex + 1],
      threadId: threadIndex === -1 ? null : tokens[threadIndex + 1],
    },
  };
}

function parseExchangeRepliesCommand(tokens) {
  if ((tokens.length !== 1 && tokens.length !== 3) || !isExchangeName(tokens[0])) {
    return { command: "unknown", args: {} };
  }
  if (tokens.length === 1) {
    return { command: "exchange_replies", args: { agent: tokens[0], threadId: null } };
  }
  if (tokens[1] !== "--thread" || !tokens[2]) {
    return { command: "unknown", args: {} };
  }
  return { command: "exchange_replies", args: { agent: tokens[0], threadId: tokens[2] } };
}

function parseSubmitCommand(tokens) {
  const repoIndex = tokens.indexOf("--repo");
  const requestIndex = tokens.indexOf("--request");
  if (repoIndex === -1 || requestIndex === -1 || isFlagValueMissing(tokens, repoIndex) || isFlagValueMissing(tokens, requestIndex)) {
    return { command: "invalid_submit", args: {} };
  }
  if (hasUnexpectedSubmitTokens(tokens, repoIndex, requestIndex)) {
    return { command: "invalid_submit", args: {} };
  }
  return {
    command: "agent_submit",
    args: {
      repo: tokens[repoIndex + 1],
      request: tokens[requestIndex + 1],
    },
  };
}

function hasUnexpectedExchangeAskTokens(tokens, textIndex, threadIndex) {
  const allowed = new Set([0, textIndex, textIndex + 1]);
  if (threadIndex !== -1) {
    allowed.add(threadIndex);
    allowed.add(threadIndex + 1);
  }
  for (let index = 0; index < tokens.length; index += 1) {
    if (!allowed.has(index)) {
      return true;
    }
  }
  return false;
}

function isFlagValueMissing(tokens, index) {
  return !tokens[index + 1] || tokens[index + 1].startsWith("--");
}

function hasUnexpectedSubmitTokens(tokens, repoIndex, requestIndex) {
  const allowed = new Set([repoIndex, repoIndex + 1, requestIndex, requestIndex + 1]);
  for (let index = 0; index < tokens.length; index += 1) {
    if (!allowed.has(index)) {
      return true;
    }
  }
  return false;
}

const VALID_RUNNER_MODELS = new Set(["sonnet", "opus"]);

function parseConfigCommand(tokens) {
  if (tokens[0] === "opus-model" && tokens.length === 2 && VALID_RUNNER_MODELS.has(tokens[1])) {
    return { command: "agent_config", args: { key: "opus-model", value: tokens[1] } };
  }
  return { command: "invalid_config", args: {} };
}

function isTaskId(value) {
  return /^task_[A-Za-z0-9_-]+$/.test(String(value || ""));
}

function isExchangeName(value) {
  return /^(?:[a-z][a-z0-9_-]*|any)$/.test(String(value || ""));
}

function isMessageId(value) {
  return /^msg_[A-Za-z0-9_-]+$/.test(String(value || ""));
}

function formatExchangeInbox(messages, agent) {
  const head = `Exchange inbox for ${agent}: ${messages.length}`;
  return [head, ...messages.slice(0, 5).map((message) => (
    `${message.id} from=${message.from} thread=${message.thread_id || "none"} claim=${message.claim?.status || "open"} text=${shortLine(message.text)}`
  ))].join("\n");
}

function formatExchangeReplies(replies, agent) {
  const head = `Exchange replies for ${agent}: ${replies.length}`;
  return [head, ...replies.slice(0, 5).map((reply) => (
    `${reply.message_id} from=${reply.responder} thread=${reply.thread_id || "none"} reply=${shortLine(reply.reply_text)}`
  ))].join("\n");
}

function formatExchangeThread(thread) {
  return [
    `Exchange thread ${thread.message.id}`,
    `from=${thread.message.from} to=${thread.message.to} thread=${thread.message.thread_id || "none"}`,
    `request=${shortLine(thread.message.text)}`,
    `replies=${thread.replies.length}`,
    ...thread.replies.slice(0, 3).map((reply) => `${reply.responder}: ${shortLine(reply.reply_text)}`),
  ].join("\n");
}

function shortLine(text) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  return raw.length > 180 ? `${raw.slice(0, 177)}...` : raw;
}

function formatAgentRun(result) {
  const counts = countTasks(result.tasks);
  return [
    `Run: advanced=${result.advanced}`,
    `tasks=${result.tasks.length}`,
    `queued=${counts.queued}`,
    `done=${counts.done}`,
    `failed=${counts.failed}`,
    `kill_switch=${result.safety.config.kill_switch}`,
    `remaining_tokens=${result.safety.today.remaining_tokens}`,
  ].join(" ");
}

function formatAgentStatus(status) {
  if (status.task) {
    return `Task ${status.task.id}: ${status.task.status}`;
  }
  const counts = countTasks(status.tasks);
  return [
    `Tasks: ${status.tasks.length}`,
    `queued=${counts.queued}`,
    `done=${counts.done}`,
    `failed=${counts.failed}`,
    `runs=${status.runs.length}`,
    `kill_switch=${status.safety.config.kill_switch}`,
    `remaining_tokens=${status.safety.today.remaining_tokens}`,
  ].join(" ");
}

function countTasks(tasks) {
  const counts = { queued: 0, done: 0, failed: 0 };
  for (const task of tasks) {
    if (Object.hasOwn(counts, task.status)) {
      counts[task.status] += 1;
    }
  }
  return counts;
}

function appendGatewayAudit(agentHome, entry) {
  appendJsonl(agentPaths(agentHome).gatewayAudit, {
    ...entry,
    created_at: new Date().toISOString(),
  });
}

function tokenize(text) {
  const tokens = [];
  const regex = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match = regex.exec(text);
  while (match) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
    match = regex.exec(text);
  }
  return tokens;
}
