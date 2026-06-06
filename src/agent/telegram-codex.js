import fs from "node:fs";
import path from "node:path";
import { appendJsonl, readJsonl } from "../lib/jsonl.js";
import { chatReplyStateForInbox, inboxSummary, queueChatReply } from "./chat.js";
import { buildTelegramReplyPrompt } from "./reply-context.js";
import { realCodexRunner, realEditRunner, realPlanRunner, estimateReplyTokens } from "./codex-runner.js";
import { approveReply, createReplyApproval, rejectReply } from "./reply-approval.js";
import { canBuildDirectSendPrompt, evaluateDirectSend, recordDirectSendAttempt } from "./direct-send.js";
import { scanSecrets } from "../lib/secret-scan.js";
import { pollTelegramOnce } from "./telegram.js";
import { agentPaths } from "./paths.js";
import { appendCost, checkSafety, getSafetyStatus, getTelegramCodexPolicy } from "./safety.js";
import { createTask, readTask, writeTask } from "./tasks.js";
import { approveAgentTask, rejectAgentTask, runAgentOnce } from "./orchestrator.js";
import {
  classifyOwnerInbound,
  isMalformedOwnerTaskCommand,
  isOwner,
  OWNER_APPROVE_FAILED_NOTICE,
  OWNER_BLOCKED_NOTICE,
  OWNER_COMMAND_UNRECOGNIZED_NOTICE,
  OWNER_DANGEROUS_ACTION_NOTICE,
  OWNER_NO_REPO_NOTICE,
  OWNER_QA_FALLBACK_NOTICE,
  OWNER_REPLY_APPROVE_FAILED_NOTICE,
  OWNER_REPLY_REJECT_FAILED_NOTICE,
  OWNER_REPLY_REJECTED_NOTICE,
  OWNER_REJECT_FAILED_NOTICE,
  ownerApproveEditNotice,
  ownerApproveNotice,
  ownerActionNotice,
  ownerAutoPlanNotice,
  ownerEditActionNotice,
  ownerReplyApprovalMarkup,
  ownerRejectNotice,
  ownerStatusNotice,
  ownerTaskReplyMarkup,
  parseOwnerReplyApprovalCommand,
  parseOwnerTaskCommand,
  recordOwnerDecision,
} from "./owner-mode.js";

// Single-shot manual Telegram <-> Codex reply cycle. Explicit, gated, no loop.
// Idempotent + retry-safe per inbox entry, with per-chat and global rate guards
// (intervals from the local policy), a single-process run lock, and an optional
// approval-before-send mode. `runner` is injectable for tests; the production
// default is the real Codex runner and only runs with allowRealCodex.

const DEFAULT_LOCK_TTL_SECONDS = 600;

export async function telegramCodexOnce({
  agentHome,
  transport = "fetch",
  memoryStateHome,
  token,
  fetchImpl,
  execFileImpl,
  requestImpl,
  allowRealCodex = false,
  runner,
  inboxId,
  requireReplyApproval = false,
  perChatIntervalSeconds,
  globalIntervalSeconds,
  replyContextImpl,
  longPollSeconds = 0,
  lockTtlSeconds = DEFAULT_LOCK_TTL_SECONDS,
  now = Date.now(),
} = {}) {
  if (!allowRealCodex) {
    throw new Error("Refusing to run: pass --allow-real-codex to enable real Codex invocation");
  }

  // Local single-process lock: refuse to poll/model/send while another run holds
  // a fresh lock; break a stale one (crash safety). Always released in finally.
  if (!acquireLock(agentHome, lockTtlSeconds, now)) {
    return {
      received: 0, inbox_id: null, reply_id: null, queued: false,
      reason: "locked", sent: [], safety: getSafetyStatus(agentHome),
    };
  }

  const policy = getTelegramCodexPolicy(agentHome);
  const perChatInterval = perChatIntervalSeconds ?? policy.per_chat_interval_seconds;
  const globalInterval = globalIntervalSeconds ?? policy.global_interval_seconds;

  try {
    return await runCycle({
      agentHome, transport, memoryStateHome, token, fetchImpl, execFileImpl, requestImpl,
      runner, inboxId, requireReplyApproval, perChatInterval, globalInterval, policy, replyContextImpl, longPollSeconds, now,
    });
  } finally {
    releaseLock(agentHome);
  }
}

async function runCycle({
  agentHome, transport, memoryStateHome, token, fetchImpl, execFileImpl, requestImpl,
  runner, inboxId, requireReplyApproval, perChatInterval, globalInterval, policy, replyContextImpl, longPollSeconds, now,
}) {
  const poll = (extra = {}) => pollTelegramOnce({
    agentHome, transport, token, fetchImpl, execFileImpl, requestImpl, memoryStateHome, ...extra,
  });

  // Snapshot inbox before polling so we can tell which entry (if any) this run
  // actually received. Only allowlisted free-form messages create inbox rows.
  const before = new Set(inboxSummary(agentHome).messages.map((entry) => entry.id));

  // First (receive) poll: receive new messages AND flush any already-queued
  // replies. Only this poll long-polls; the later send-only polls use timeout 0
  // so a queued reply is delivered immediately and the cycle returns promptly.
  const received = await poll({ longPollSeconds });

  const messages = inboxSummary(agentHome).messages;
  let targets;
  if (inboxId) {
    // With --id: explicitly retry one existing inbox entry (consumed offset /
    // prior failure), regardless of whether it was received in this poll.
    const found = messages.find((entry) => entry.id === inboxId);
    if (!found) {
      return summary({ agentHome, received, inbox_id: null, reply_id: null, queued: false, reason: "inbox_not_found", sent: received.replies });
    }
    targets = [found];
  } else {
    // Process EVERY new inbox entry from this poll, oldest -> newest, so a batch
    // with multiple messages never silently drops all but the last. Entries that
    // existed before this poll are left untouched (no stale-backlog sweep).
    targets = messages.filter((entry) => !before.has(entry.id));
    if (targets.length === 0) {
      return summary({ agentHome, received, inbox_id: null, reply_id: null, queued: false, reason: "no_new_inbox_entry", sent: received.replies });
    }
  }

  const processed = new Set();
  let last = null;
  while (targets.length > 0) {
    const latest = targets.shift();
    processed.add(latest.id);
    last = await processInboxEntry({
      agentHome, poll, memoryStateHome, execFileImpl, runner, requireReplyApproval,
      perChatInterval, globalInterval, policy, replyContextImpl, now, received, latest,
    });
    targets = inboxSummary(agentHome).messages
      .filter((entry) => !before.has(entry.id) && !processed.has(entry.id));
  }
  return last;
}

async function processInboxEntry({
  agentHome, poll, memoryStateHome, execFileImpl, runner, requireReplyApproval,
  perChatInterval, globalInterval, policy, replyContextImpl, now, received, latest,
}) {
  // Idempotency: do not invoke the model if a reply for this inbox already exists.
  const replyState = chatReplyStateForInbox(agentHome, latest.id);
  if (replyState.sent) {
    return summary({ agentHome, received, inbox_id: latest.id, reply_id: replyState.reply?.id || null, queued: false, reason: "already_replied", sent: received.replies });
  }
  if (replyState.queued) {
    // Reply already queued (e.g. a prior send failed). Re-send only, no model.
    const sendResult = await poll();
    return summary({ agentHome, received, inbox_id: latest.id, reply_id: replyState.reply?.id || null, queued: true, reason: "already_queued", sent: sendResult.replies });
  }

  const ownerMode = isOwner(latest, policy);

  // Owner task commands and approval-gated owner requests are control-plane
  // actions handled before model-reply rate/safety guards, so they are never
  // silently throttled before the owner can inspect/approve/reject work.
  if (ownerMode) {
    const handled = await handleOwnerTaskCommand({
      agentHome, poll, memoryStateHome, execFileImpl, runner, now, received, latest,
    });
    if (handled) {
      return handled;
    }
    const owner = classifyOwnerInbound(latest.text, policy);
    const handledOwnerControl = await handleOwnerControlRequest({
      agentHome, poll, now, received, latest, owner, policy,
    });
    if (handledOwnerControl) {
      return handledOwnerControl;
    }
  }

  // Phase B seatbelts before any model invocation.
  const guard = checkSafety(agentHome);
  if (!guard.ok) {
    return summary({ agentHome, received, inbox_id: latest.id, reply_id: null, queued: false, reason: guard.reason, sent: received.replies });
  }

  // Per-chat rate guard on model-generated replies.
  if (isRateLimited(agentHome, latest.chat_id, perChatInterval, now)) {
    return summary({ agentHome, received, inbox_id: latest.id, reply_id: null, queued: false, reason: "rate_limited", rate: { scope: "per_chat", interval_seconds: perChatInterval }, sent: received.replies });
  }

  // Global rate guard: throttle model-generated replies across all chats.
  if (isGloballyRateLimited(agentHome, globalInterval, now)) {
    return summary({ agentHome, received, inbox_id: latest.id, reply_id: null, queued: false, reason: "global_rate_limited", rate: { scope: "global", interval_seconds: globalInterval }, sent: received.replies });
  }

  let ownerQa = false;
  if (ownerMode) {
    const owner = classifyOwnerInbound(latest.text, policy);
    if (owner.kind === "low_risk_action") {
      if (!policy.default_repo) {
        const reply = queueChatReply({ agentHome, inboxId: latest.id, text: OWNER_NO_REPO_NOTICE, source: "owner_mode" });
        recordOwnerDecision({ agentHome, inbox: latest, kind: "owner_low_risk_action", decision: "blocked_with_notice", replyText: OWNER_NO_REPO_NOTICE, reasons: ["missing_default_repo"], now });
        recordModelReply(agentHome, latest, now);
        const sendResult = await poll();
        return summary({ agentHome, received, inbox_id: latest.id, reply_id: reply.id, queued: true, reason: "owner_action_no_repo", sent: sendResult.replies });
      }
      const created = createTask({ agentHome, repo: policy.default_repo, request: latest.text, mode: "plan", source: "telegram", requester: "owner" });
      const planRunner = runner || ((args) => realPlanRunner({ ...args, execFileImpl, agentHome }));
      let task = created;
      try {
        const run = await runAgentOnce({ agentHome, memoryStateHome, runner: planRunner, taskId: created.id, execFileImpl });
        task = run.tasks.find((entry) => entry.id === created.id)
          || readTask(agentHome, created.id) || created;
      } catch {
        task = readTask(agentHome, created.id) || created;
      }
      const notice = ownerAutoPlanNotice(task);
      const reply = queueChatReply({ agentHome, inboxId: latest.id, text: notice, source: "owner_mode" });
      recordOwnerDecision({ agentHome, inbox: latest, kind: "owner_low_risk_action", decision: "auto_plan", taskId: created.id, replyText: notice, reasons: owner.reasons, now });
      recordModelReply(agentHome, latest, now);
      const sendResult = await poll();
      return summary({ agentHome, received, inbox_id: latest.id, reply_id: reply.id, approval_id: created.id, queued: true, reason: "owner_low_risk_action", sent: sendResult.replies });
    }
    ownerQa = true;
  }

  // Assemble the direct-reply prompt: instructions + (optional) Memory River
  // context + recent same-chat thread + the incoming message.
  const directPrompt = canBuildDirectSendPrompt({ inbox: latest, policy });
  const memoryActive = Boolean((memoryStateHome || policy.memory_enabled) && policy.default_repo && !directPrompt);
  const buildPrompt = replyContextImpl || buildTelegramReplyPrompt;
  let prompt;
  try {
    prompt = await buildPrompt({
      agentHome,
      inbox: latest,
      historyMessages: policy.history_messages,
      maxChars: policy.context_max_chars,
      memory: memoryActive ? { repo: policy.default_repo, stateHome: memoryStateHome } : null,
    });
  } catch (error) {
    if (error?.reason === "memory_context_failed" || error?.reason === "memory_unavailable") {
      return summary({ agentHome, received, inbox_id: latest.id, reply_id: null, queued: false, reason: error.reason, sent: received.replies });
    }
    throw error;
  }
  if (scanSecrets(prompt).length > 0) {
    return summary({ agentHome, received, inbox_id: latest.id, reply_id: null, queued: false, reason: "prompt_secret", sent: received.replies });
  }

  const activeRunner = runner || ((args) => realCodexRunner({ ...args, execFileImpl, agentHome }));
  const { text: replyText, tokens: usageTokens } = normalizeRunnerResult(await activeRunner({ prompt, inbox: latest }));

  // Prefer real Codex token usage when the runner parsed it; otherwise estimate.
  const costSource = usageTokens != null ? "codex_usage" : "estimate";
  const tokens = usageTokens != null ? usageTokens : estimateReplyTokens(prompt, replyText);

  // The model ran (quota spent), so charge it regardless of the queue outcome.
  appendCost(agentHome, {
    task_id: latest.id,
    step: "telegram_codex_reply",
    tokens,
    usd_estimate: 0,
    cost_source: costSource,
  });

  const safety = getSafetyStatus(agentHome);
  const directDecision = evaluateDirectSend({ agentHome, inbox: latest, replyText, policy, safety, now, ownerQa });

  if (requireReplyApproval && directDecision.auto_send) {
    let reply;
    try {
      reply = queueChatReply({ agentHome, inboxId: latest.id, text: replyText, source: ownerQa ? "owner_mode" : "direct_send" });
    } catch (error) {
      return summary({ agentHome, received, inbox_id: latest.id, reply_id: null, queued: false, reason: "reply_rejected", error: error.message, cost_source: costSource, sent: received.replies });
    }
    if (ownerQa) {
      recordOwnerDecision({ agentHome, inbox: latest, kind: "owner_qa", decision: "auto_sent", replyText, now });
    } else {
      recordDirectSendAttempt({ agentHome, inbox: latest, replyText, policy, decision: directDecision, tokens, now });
    }
    recordModelReply(agentHome, latest, now);
    const sendResult = await poll();
    return summary({ agentHome, received, inbox_id: latest.id, reply_id: reply.id, queued: true, reason: "direct_sent", cost_source: costSource, sent: sendResult.replies });
  }

  // Approval-before-send mode: validate the reply, park it as a pending approval,
  // and send nothing this run. An operator approves it into the normal queue.
  if (requireReplyApproval) {
    let approval;
    try {
      approval = createReplyApproval({ agentHome, inboxId: latest.id, text: replyText });
    } catch (error) {
      return summary({ agentHome, received, inbox_id: latest.id, reply_id: null, queued: false, reason: "reply_rejected", error: error.message, cost_source: costSource, sent: received.replies });
    }
    if (ownerQa) {
      const notice = queueChatReply({
        agentHome,
        inboxId: latest.id,
        text: OWNER_QA_FALLBACK_NOTICE,
        source: "owner_mode",
        replyMarkup: ownerReplyApprovalMarkup(approval.id),
      });
      recordOwnerDecision({ agentHome, inbox: latest, kind: "owner_qa", decision: "approval_required", replyText, reasons: [...directDecision.output_reasons, ...directDecision.gate_reasons], now });
      recordModelReply(agentHome, latest, now);
      const sendResult = await poll();
      return summary({ agentHome, received, inbox_id: latest.id, reply_id: notice.id, approval_id: approval.id, queued: true, reason: "owner_qa_approval_required", cost_source: costSource, sent: sendResult.replies });
    }
    recordDirectSendAttempt({ agentHome, inbox: latest, replyText, policy, decision: directDecision, tokens, now });
    recordModelReply(agentHome, latest, now);
    return summary({ agentHome, received, inbox_id: latest.id, reply_id: null, approval_id: approval.id, queued: false, reason: "approval_required", cost_source: costSource, sent: received.replies });
  }

  let reply;
  try {
    reply = queueChatReply({ agentHome, inboxId: latest.id, text: replyText });
  } catch (error) {
    // Secret/empty rejection: report failure, do NOT mark the inbox replied.
    return summary({ agentHome, received, inbox_id: latest.id, reply_id: null, queued: false, reason: "reply_rejected", error: error.message, cost_source: costSource, sent: received.replies });
  }

  recordModelReply(agentHome, latest, now);

  const sendResult = await poll();
  return summary({ agentHome, received, inbox_id: latest.id, reply_id: reply.id, queued: true, reason: null, cost_source: costSource, sent: sendResult.replies });
}

// Owner task commands run before the rate/safety guards. Returns a cycle summary
// when the message is a task command (or a malformed one), or null to fall
// through to the owner free-text classifier. Only `approve` invokes the model, so
// only `approve` records a model reply for the rate guard.
async function handleOwnerTaskCommand({ agentHome, poll, memoryStateHome, execFileImpl, runner, now, received, latest }) {
  const replyCommand = parseOwnerReplyApprovalCommand(latest.text);
  if (replyCommand?.command === "approve") {
    let approved;
    try {
      approved = approveReply({ agentHome, id: replyCommand.approvalId });
    } catch {
      const reply = queueChatReply({ agentHome, inboxId: latest.id, text: OWNER_REPLY_APPROVE_FAILED_NOTICE, source: "owner_mode" });
      recordOwnerDecision({ agentHome, inbox: latest, kind: "owner_reply_approve", decision: "approve_failed", replyText: OWNER_REPLY_APPROVE_FAILED_NOTICE, now });
      const sendResult = await poll();
      return summary({ agentHome, received, inbox_id: latest.id, reply_id: reply.id, approval_id: replyCommand.approvalId, queued: true, reason: "owner_reply_approve_failed", sent: sendResult.replies });
    }
    const sendResult = await poll();
    return summary({ agentHome, received, inbox_id: latest.id, reply_id: approved.reply?.id || null, approval_id: replyCommand.approvalId, queued: Boolean(approved.reply), reason: "owner_reply_approve", sent: sendResult.replies });
  }

  if (replyCommand?.command === "reject") {
    let notice = OWNER_REPLY_REJECTED_NOTICE;
    let decision = "rejected";
    try {
      rejectReply({ agentHome, id: replyCommand.approvalId });
    } catch {
      notice = OWNER_REPLY_REJECT_FAILED_NOTICE;
      decision = "reject_failed";
    }
    const reply = queueChatReply({ agentHome, inboxId: latest.id, text: notice, source: "owner_mode" });
    recordOwnerDecision({ agentHome, inbox: latest, kind: "owner_reply_reject", decision, replyText: notice, now });
    const sendResult = await poll();
    return summary({ agentHome, received, inbox_id: latest.id, reply_id: reply.id, approval_id: replyCommand.approvalId, queued: true, reason: decision === "rejected" ? "owner_reply_reject" : "owner_reply_reject_failed", sent: sendResult.replies });
  }

  const taskCommand = parseOwnerTaskCommand(latest.text);

  if (taskCommand?.command === "status") {
    const task = readTask(agentHome, taskCommand.taskId);
    const notice = ownerStatusNotice(task);
    const reply = queueChatReply({ agentHome, inboxId: latest.id, text: notice, source: "owner_mode" });
    recordOwnerDecision({ agentHome, inbox: latest, kind: "owner_status", decision: task ? "reported" : "not_found", taskId: taskCommand.taskId, replyText: notice, now });
    const sendResult = await poll();
    return summary({ agentHome, received, inbox_id: latest.id, reply_id: reply.id, approval_id: taskCommand.taskId, queued: true, reason: "owner_status", sent: sendResult.replies });
  }

  if (taskCommand?.command === "reject") {
    let notice = OWNER_REJECT_FAILED_NOTICE;
    let decision = "reject_failed";
    try {
      const task = rejectAgentTask({ agentHome, id: taskCommand.taskId });
      notice = ownerRejectNotice(task);
      decision = "rejected";
    } catch {
      // keep failure notice
    }
    const reply = queueChatReply({ agentHome, inboxId: latest.id, text: notice, source: "owner_mode" });
    recordOwnerDecision({ agentHome, inbox: latest, kind: "owner_reject", decision, taskId: taskCommand.taskId, replyText: notice, now });
    const sendResult = await poll();
    return summary({ agentHome, received, inbox_id: latest.id, reply_id: reply.id, approval_id: taskCommand.taskId, queued: true, reason: decision === "rejected" ? "owner_reject" : "owner_reject_failed", sent: sendResult.replies });
  }

  if (taskCommand?.command === "approve") {
    // Approve first. A failure here means the task is not found or not pending,
    // so it was never started — the "still pending" notice is accurate.
    let approvedTask;
    try {
      approvedTask = approveAgentTask({ agentHome, id: taskCommand.taskId });
    } catch {
      const reply = queueChatReply({ agentHome, inboxId: latest.id, text: OWNER_APPROVE_FAILED_NOTICE, source: "owner_mode" });
      recordOwnerDecision({ agentHome, inbox: latest, kind: "owner_approve", decision: "approve_failed", taskId: taskCommand.taskId, replyText: OWNER_APPROVE_FAILED_NOTICE, now });
      const sendResult = await poll();
      return summary({ agentHome, received, inbox_id: latest.id, reply_id: reply.id, approval_id: taskCommand.taskId, queued: true, reason: "owner_approve_failed", sent: sendResult.replies });
    }
    // Approved: run only this task. In production no runner is injected, so fall
    // back to the real Codex runner for the task mode (read-only plan or
    // workspace-write edit), not worker.js's fakeRunner. runAgentOnce applies
    // its own safety guard and converts throws to failed tasks, so the notice
    // reflects the real status.
    // executor=opus edit tasks are executed by the headless Opus runner that
    // runAgentOnce/runEditTask builds itself — pass no runner so it is not
    // overridden by the Codex edit/plan runner.
    const taskRunner = runner || (approvedTask.executor === "opus"
      ? undefined
      : ((args) => (approvedTask.mode === "edit"
        ? realEditRunner({ ...args, execFileImpl, agentHome })
        : realPlanRunner({ ...args, execFileImpl, agentHome }))));
    let task = approvedTask;
    try {
      const run = await runAgentOnce({ agentHome, memoryStateHome, runner: taskRunner, taskId: taskCommand.taskId, execFileImpl });
      task = run.tasks.find((entry) => entry.id === taskCommand.taskId)
        || readTask(agentHome, taskCommand.taskId) || approvedTask;
    } catch {
      task = readTask(agentHome, taskCommand.taskId) || approvedTask;
    }
    const notice = task.mode === "edit" ? ownerApproveEditNotice(task) : ownerApproveNotice(task);
    const reply = queueChatReply({ agentHome, inboxId: latest.id, text: notice, source: "owner_mode" });
    recordOwnerDecision({ agentHome, inbox: latest, kind: "owner_approve", decision: "approved_and_ran", taskId: taskCommand.taskId, replyText: notice, now });
    recordModelReply(agentHome, latest, now);
    const sendResult = await poll();
    return summary({ agentHome, received, inbox_id: latest.id, reply_id: reply.id, approval_id: taskCommand.taskId, queued: true, reason: "owner_approve", sent: sendResult.replies });
  }

  if (isMalformedOwnerTaskCommand(latest.text)) {
    const reply = queueChatReply({ agentHome, inboxId: latest.id, text: OWNER_COMMAND_UNRECOGNIZED_NOTICE, source: "owner_mode" });
    recordOwnerDecision({ agentHome, inbox: latest, kind: "owner_command", decision: "unrecognized", replyText: OWNER_COMMAND_UNRECOGNIZED_NOTICE, reasons: ["malformed_task_command"], now });
    const sendResult = await poll();
    return summary({ agentHome, received, inbox_id: latest.id, reply_id: reply.id, queued: true, reason: "owner_command_unrecognized", sent: sendResult.replies });
  }

  return null;
}

async function handleOwnerControlRequest({ agentHome, poll, now, received, latest, owner, policy }) {
  if (owner.kind === "blocked") {
    const reply = queueChatReply({ agentHome, inboxId: latest.id, text: OWNER_BLOCKED_NOTICE, source: "owner_mode" });
    recordOwnerDecision({ agentHome, inbox: latest, kind: "blocked", decision: "blocked_with_notice", replyText: OWNER_BLOCKED_NOTICE, reasons: owner.reasons, now });
    recordModelReply(agentHome, latest, now);
    const sendResult = await poll();
    return summary({ agentHome, received, inbox_id: latest.id, reply_id: reply.id, queued: true, reason: "owner_blocked", sent: sendResult.replies });
  }

  if (owner.kind === "dangerous_request") {
    const reply = queueChatReply({ agentHome, inboxId: latest.id, text: OWNER_DANGEROUS_ACTION_NOTICE, source: "owner_mode" });
    recordOwnerDecision({ agentHome, inbox: latest, kind: "owner_dangerous", decision: "declined", replyText: OWNER_DANGEROUS_ACTION_NOTICE, reasons: owner.reasons, now });
    recordModelReply(agentHome, latest, now);
    const sendResult = await poll();
    return summary({ agentHome, received, inbox_id: latest.id, reply_id: reply.id, queued: true, reason: "owner_dangerous_declined", sent: sendResult.replies });
  }

  if (owner.kind === "edit_request") {
    if (!policy.default_repo) {
      const reply = queueChatReply({ agentHome, inboxId: latest.id, text: OWNER_NO_REPO_NOTICE, source: "owner_mode" });
      recordOwnerDecision({ agentHome, inbox: latest, kind: "owner_edit", decision: "blocked_with_notice", replyText: OWNER_NO_REPO_NOTICE, reasons: ["missing_default_repo"], now });
      recordModelReply(agentHome, latest, now);
      const sendResult = await poll();
      return summary({ agentHome, received, inbox_id: latest.id, reply_id: reply.id, queued: true, reason: "owner_edit_no_repo", sent: sendResult.replies });
    }
    const created = createTask({ agentHome, repo: policy.default_repo, request: latest.text, mode: "edit", source: "telegram", requester: "owner" });
    const notice = ownerEditActionNotice(created.id);
    const reply = queueChatReply({ agentHome, inboxId: latest.id, text: notice, source: "owner_mode", replyMarkup: ownerTaskReplyMarkup(created.id) });
    recordOwnerDecision({ agentHome, inbox: latest, kind: "owner_edit", decision: "approval_required", taskId: created.id, replyText: notice, reasons: owner.reasons, now });
    recordModelReply(agentHome, latest, now);
    const sendResult = await poll();
    return summary({ agentHome, received, inbox_id: latest.id, reply_id: reply.id, approval_id: created.id, queued: true, reason: "owner_edit_request", sent: sendResult.replies });
  }

  if (owner.kind === "action_request") {
    if (!policy.default_repo) {
      const reply = queueChatReply({ agentHome, inboxId: latest.id, text: OWNER_NO_REPO_NOTICE, source: "owner_mode" });
      recordOwnerDecision({ agentHome, inbox: latest, kind: "owner_action", decision: "blocked_with_notice", replyText: OWNER_NO_REPO_NOTICE, reasons: ["missing_default_repo"], now });
      recordModelReply(agentHome, latest, now);
      const sendResult = await poll();
      return summary({ agentHome, received, inbox_id: latest.id, reply_id: reply.id, queued: true, reason: "owner_action_no_repo", sent: sendResult.replies });
    }
    const created = createTask({ agentHome, repo: policy.default_repo, request: latest.text, mode: "plan", source: "telegram", requester: "owner" });
    const ts = new Date(now).toISOString();
    const task = {
      ...created,
      approval: "pending",
      history: [
        ...created.history,
        { ts, state: "queued", note: "Owner action request pending approval.", codex_session: null },
      ],
    };
    writeTask(agentHome, task);
    const notice = ownerActionNotice(task.id);
    const reply = queueChatReply({ agentHome, inboxId: latest.id, text: notice, source: "owner_mode", replyMarkup: ownerTaskReplyMarkup(task.id) });
    recordOwnerDecision({ agentHome, inbox: latest, kind: "owner_action", decision: "approval_required", taskId: task.id, replyText: notice, reasons: owner.reasons, now });
    recordModelReply(agentHome, latest, now);
    const sendResult = await poll();
    return summary({ agentHome, received, inbox_id: latest.id, reply_id: reply.id, approval_id: task.id, queued: true, reason: "owner_action", sent: sendResult.replies });
  }

  return null;
}

// Accept both a plain string reply (injected test runners, legacy) and a richer
// { text, tokens } object (real runner). tokens is real Codex usage when present.
function normalizeRunnerResult(result) {
  if (typeof result === "string") {
    return { text: result, tokens: null };
  }
  const text = String(result?.text ?? "");
  const tokens = Number.isFinite(result?.tokens) ? result.tokens : null;
  return { text, tokens };
}

function recordModelReply(agentHome, inbox, now) {
  // Record a successful model-generated reply for the per-chat rate guard.
  appendJsonl(agentPaths(agentHome).codexReplies, {
    inbox_id: inbox.id,
    chat_id: inbox.chat_id,
    created_at: new Date(now).toISOString(),
  });
}

function acquireLock(agentHome, ttlSeconds, now) {
  const file = agentPaths(agentHome).telegramCodexLock;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = `${JSON.stringify({ acquired_at: new Date(now).toISOString(), pid: process.pid })}\n`;
  try {
    fs.writeFileSync(file, payload, { flag: "wx" }); // atomic exclusive create
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }
  if (isLockFresh(file, ttlSeconds, now)) {
    return false;
  }
  // Stale (or unreadable) lock: break it and try once more.
  try {
    fs.unlinkSync(file);
  } catch {
    // someone else may have removed it; fall through
  }
  try {
    fs.writeFileSync(file, payload, { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

function isLockFresh(file, ttlSeconds, now) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const ts = Date.parse(data.acquired_at || "");
    return Number.isFinite(ts) && now - ts < Math.max(0, Number(ttlSeconds) || 0) * 1000;
  } catch {
    return false;
  }
}

function releaseLock(agentHome) {
  const file = agentPaths(agentHome).telegramCodexLock;
  if (fs.existsSync(file)) {
    try {
      fs.unlinkSync(file);
    } catch {
      // best-effort
    }
  }
}

function isRateLimited(agentHome, chatId, windowSeconds, now) {
  const windowMs = Math.max(0, Number(windowSeconds) || 0) * 1000;
  if (windowMs === 0) {
    return false;
  }
  return readJsonl(agentPaths(agentHome).codexReplies).some((entry) => {
    if (String(entry.chat_id) !== String(chatId)) {
      return false;
    }
    const ts = Date.parse(entry.created_at || "");
    return Number.isFinite(ts) && now - ts < windowMs;
  });
}

function isGloballyRateLimited(agentHome, windowSeconds, now) {
  const windowMs = Math.max(0, Number(windowSeconds) || 0) * 1000;
  if (windowMs === 0) {
    return false;
  }
  return readJsonl(agentPaths(agentHome).codexReplies).some((entry) => {
    const ts = Date.parse(entry.created_at || "");
    return Number.isFinite(ts) && now - ts < windowMs;
  });
}

// Reasons that should stop the bounded loop immediately (safety / contention).
const LOOP_STOP_REASONS = new Set(["kill_switch", "daily_token_budget", "locked"]);

// Bounded, manually-started loop. NOT a daemon/service: it runs a fixed number
// of telegram-codex-once iterations (always in approval-before-send mode) with
// an optional sleep between them, then exits. Refuses to start unless the policy
// has enabled=true AND require_approval=true, and --allow-real-codex is set.
export async function telegramCodexLoop({
  agentHome,
  transport = "fetch",
  memoryStateHome,
  token,
  fetchImpl,
  execFileImpl,
  requestImpl,
  allowRealCodex = false,
  runner,
  iterations,
  sleepSeconds,
  sleepImpl,
  onceImpl,
} = {}) {
  if (!allowRealCodex) {
    throw new Error("Refusing to run: pass --allow-real-codex to enable real Codex invocation");
  }
  const iters = Number(iterations);
  if (!Number.isInteger(iters) || iters <= 0) {
    throw new Error("--iterations must be a positive integer");
  }
  const policy = getTelegramCodexPolicy(agentHome);
  if (!policy.enabled) {
    throw new Error("Refusing to run: loop is disabled (telegram-codex-policy-set --enabled true)");
  }
  if (!policy.require_approval) {
    throw new Error("Refusing to run: loop requires approval mode (require_approval=true)");
  }
  const sleep = sleepSeconds === undefined ? policy.global_interval_seconds : Number(sleepSeconds);
  if (!Number.isFinite(sleep) || sleep < 0) {
    throw new Error("--sleep-seconds must be a non-negative number");
  }

  const runOnce = onceImpl || telegramCodexOnce;
  const doSleep = sleepImpl || defaultSleep;
  const results = [];
  let stoppedEarly = false;
  let stopReason = null;

  for (let i = 1; i <= iters; i += 1) {
    const result = await runOnce({
      agentHome, transport, memoryStateHome, token, fetchImpl, execFileImpl, requestImpl,
      allowRealCodex: true,
      requireReplyApproval: true,
      runner,
    });
    results.push({
      iteration: i,
      received: result.received,
      inbox_id: result.inbox_id ?? null,
      reason: result.reason ?? null,
      approval_id: result.approval_id ?? null,
      queued: Boolean(result.queued),
      sent_count: Array.isArray(result.sent) ? result.sent.length : 0,
      remaining_tokens: result.safety?.today?.remaining_tokens ?? null,
    });
    if (LOOP_STOP_REASONS.has(result.reason)) {
      stoppedEarly = true;
      stopReason = result.reason;
      break;
    }
    if (i < iters && sleep > 0) {
      await doSleep(sleep);
    }
  }

  return {
    requested_iterations: iters,
    iterations: results.length,
    stopped_early: stoppedEarly,
    stop_reason: stopReason,
    max_model_calls_per_run: policy.max_model_calls_per_run,
    results,
    safety: getSafetyStatus(agentHome),
  };
}

function defaultSleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

// Readiness diagnostic for a hypothetical future loop. NEVER polls Telegram,
// invokes Codex, or sends anything — it only reports current local state.
export function telegramCodexLoopDryRun({ agentHome, lockTtlSeconds = DEFAULT_LOCK_TTL_SECONDS, now = Date.now() } = {}) {
  const policy = getTelegramCodexPolicy(agentHome);
  const safety = getSafetyStatus(agentHome);
  const lockHeld = isLockFresh(agentPaths(agentHome).telegramCodexLock, lockTtlSeconds, now);
  const latest = inboxSummary(agentHome).messages.at(-1) || null;
  const replyState = latest ? chatReplyStateForInbox(agentHome, latest.id) : { exists: false };
  const globalWouldBlock = isGloballyRateLimited(agentHome, policy.global_interval_seconds, now);
  const perChatWouldBlock = latest ? isRateLimited(agentHome, latest.chat_id, policy.per_chat_interval_seconds, now) : false;
  const safetyOk = !safety.config.kill_switch && safety.today.remaining_tokens > 0;
  const inboxAvailable = Boolean(latest) && !replyState.exists;

  return {
    dry_run: true,
    note: "diagnostic only: no Telegram poll, no Codex call, no send",
    policy,
    loop_enabled: policy.enabled,
    require_approval: policy.require_approval,
    max_model_calls_per_run: policy.max_model_calls_per_run,
    lock_held: lockHeld,
    safety: { kill_switch: safety.config.kill_switch, remaining_tokens: safety.today.remaining_tokens },
    global_rate_would_block: globalWouldBlock,
    per_chat_rate_would_block: perChatWouldBlock,
    latest_inbox_id: latest?.id || null,
    latest_chat_id: latest?.chat_id || null,
    latest_inbox_has_reply: Boolean(replyState.exists),
    inbox_available: inboxAvailable,
    would_invoke_model: policy.enabled && !lockHeld && safetyOk && !globalWouldBlock && !perChatWouldBlock && inboxAvailable,
  };
}

function summary({ agentHome, received, inbox_id, reply_id, approval_id, queued, reason, error, cost_source, rate, sent }) {
  return {
    received: received.updates,
    inbox_id,
    reply_id,
    ...(approval_id ? { approval_id } : {}),
    queued,
    reason,
    ...(error ? { error } : {}),
    ...(cost_source ? { cost_source } : {}),
    ...(rate ? { rate } : {}),
    sent: sent || [],
    safety: getSafetyStatus(agentHome),
  };
}
