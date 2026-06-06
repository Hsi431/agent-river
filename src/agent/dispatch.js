import { appendJsonl, readJsonl } from "../lib/jsonl.js";
import { shortHash } from "../lib/hash.js";
import { scanSecrets } from "../lib/secret-scan.js";
import { submitExchangeMessage } from "./exchange.js";
import { agentPaths } from "./paths.js";
import { getPrimaryAgentId, readAgentConfig } from "./safety.js";
import { createTask } from "./tasks.js";

export const DISPATCH_CHANNEL = "dispatch";
export const DISPATCH_MAX_HOPS = 2;
export const DISPATCH_MIN_TASK_CHARS = 20;
export const DISPATCH_MAX_TASK_CHARS = 1000;
const VALID_MODES = new Set(["plan", "edit"]);

export function parseDispatchProposal(text) {
  const raw = String(text || "");
  const match = raw.match(/```agent-dispatch\s*\n([\s\S]*?)\n```/);
  if (!match) {
    return { proposal: null, displayText: raw, valid: false, reason: "missing" };
  }
  let data;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return { proposal: null, displayText: raw, valid: false, reason: "invalid_json" };
  }
  const keys = Object.keys(data || {}).sort();
  const allowedKeys = ["mode", "reason", "task", "to"];
  if (keys.some((key) => !allowedKeys.includes(key))) {
    return { proposal: null, displayText: raw, valid: false, reason: "unknown_field" };
  }
  const proposal = {
    to: String(data?.to || "").trim(),
    task: String(data?.task || "").trim(),
    reason: String(data?.reason || "").trim(),
    suggested_mode: String(data?.mode || "plan").trim(),
  };
  if (!proposal.to || !proposal.task || !VALID_MODES.has(proposal.suggested_mode)) {
    return { proposal: null, displayText: raw, valid: false, reason: "invalid_shape" };
  }
  if (proposal.task.length < DISPATCH_MIN_TASK_CHARS || proposal.task.length > DISPATCH_MAX_TASK_CHARS) {
    return { proposal: null, displayText: raw, valid: false, reason: "invalid_task_length" };
  }
  if (scanSecrets(`${proposal.task}\n${proposal.reason}`).length > 0) {
    return { proposal: null, displayText: raw, valid: false, reason: "secret_like" };
  }
  return {
    proposal,
    displayText: stripRange(raw, match.index, match.index + match[0].length).trimEnd(),
    valid: true,
    reason: null,
  };
}

export function dispatchTargetAllowlist(agentHome) {
  const config = readAgentConfig(agentHome);
  const targets = new Set([getPrimaryAgentId(agentHome)]);
  for (const agent of config.exchange_agents || []) {
    if (agent?.enabled && agent.agent_id && agent.agent_id !== "any") {
      targets.add(String(agent.agent_id));
    }
  }
  targets.delete("any");
  return targets;
}

export function createDispatchApproval({
  agentHome,
  proposedBy,
  proposal,
  parentMsgId = null,
  parentDispatch = null,
  chatId = null,
  now = Date.now(),
}) {
  const from = requireAgentName(proposedBy, "proposedBy");
  const target = requireAgentName(proposal?.to, "to");
  if (target === from) {
    return { approval: null, blocked: true, reason: "self_dispatch" };
  }
  if (!dispatchTargetAllowlist(agentHome).has(target)) {
    return { approval: null, blocked: true, reason: "target_not_allowed" };
  }
  const hop = Number(parentDispatch?.hop || 0) + 1;
  if (hop > DISPATCH_MAX_HOPS) {
    return { approval: null, blocked: true, reason: "max_hops" };
  }
  const task = String(proposal.task || "").trim();
  if (task.length < DISPATCH_MIN_TASK_CHARS || task.length > DISPATCH_MAX_TASK_CHARS) {
    return { approval: null, blocked: true, reason: "invalid_task_length" };
  }
  const reason = String(proposal.reason || "").trim();
  const mode = VALID_MODES.has(proposal.suggested_mode) ? proposal.suggested_mode : "plan";
  const id = `dispatch_${now}_${shortHash(`${from}:${target}:${task}`)}`;
  const approval = {
    id,
    status: "pending",
    proposed_by: from,
    to: target,
    task,
    reason,
    suggested_mode: mode,
    parent_msg_id: parentMsgId,
    parent_hop: Number(parentDispatch?.hop || 0),
    hop,
    chat_id: chatId ? String(chatId) : null,
    outcome: null,
    created_at: new Date(now).toISOString(),
  };
  appendJsonl(agentPaths(agentHome).dispatchApprovals, approval);
  return { approval, blocked: false, reason: null };
}

export function listDispatchApprovals(agentHome) {
  return latestDispatchApprovals(agentHome);
}

export function getDispatchApproval(agentHome, id) {
  return requireDispatchApproval(agentHome, id);
}

export function listPendingDispatchNotifications(agentHome) {
  return latestDispatchApprovals(agentHome)
    .filter((approval) => approval.status === "pending")
    .filter((approval) => approval.chat_id)
    .filter((approval) => !approval.notified_at);
}

export function markDispatchApprovalNotified(agentHome, id, now = Date.now()) {
  const approval = requireDispatchApproval(agentHome, id);
  const event = {
    id: approval.id,
    status: approval.status,
    notified_at: new Date(now).toISOString(),
  };
  appendJsonl(agentPaths(agentHome).dispatchApprovals, event);
  return { ...approval, ...event };
}

export function approveDispatch({ agentHome, id, approvedBy = "owner", defaultRepo, now = Date.now() }) {
  const approval = requireDispatchApproval(agentHome, id);
  if (approval.status === "approved") {
    return { approval, already: true };
  }
  if (approval.status !== "pending") {
    throw new Error(`Dispatch approval is not pending: ${id}`);
  }
  const dispatch = {
    kind: "agent_dispatch",
    parent_msg_id: approval.parent_msg_id || null,
    proposed_by: approval.proposed_by,
    approved_by: String(approvedBy || "owner"),
    approved_at: new Date(now).toISOString(),
    hop: approval.hop,
  };
  let outcome;
  if (approval.to === getPrimaryAgentId(agentHome)) {
    if (!defaultRepo) {
      throw new Error("Missing default repo for codex dispatch");
    }
    const task = createTask({
      agentHome,
      repo: defaultRepo,
      request: approval.task,
      mode: approval.suggested_mode === "edit" ? "edit" : "plan",
      source: "dispatch",
      requester: approval.proposed_by,
      approval: "pending",
      executor: "codex",
      chatId: approval.chat_id,
    });
    outcome = { type: "task", id: task.id };
  } else {
    const message = submitExchangeMessage({
      agentHome,
      from: approval.proposed_by,
      to: approval.to,
      channel: DISPATCH_CHANNEL,
      threadId: approval.parent_msg_id,
      chatId: approval.chat_id,
      text: approval.task,
      dispatch,
    });
    outcome = { type: "exchange", id: message.id };
  }
  const event = {
    id,
    status: "approved",
    approved_by: String(approvedBy || "owner"),
    approved_at: new Date(now).toISOString(),
    outcome,
  };
  appendJsonl(agentPaths(agentHome).dispatchApprovals, event);
  return { approval: { ...approval, ...event }, outcome, already: false };
}

export function rejectDispatch({ agentHome, id, rejectedBy = "owner", now = Date.now() }) {
  const approval = requireDispatchApproval(agentHome, id);
  if (approval.status === "rejected") {
    return { approval, already: true };
  }
  if (approval.status !== "pending") {
    throw new Error(`Dispatch approval is not pending: ${id}`);
  }
  const event = {
    id,
    status: "rejected",
    rejected_by: String(rejectedBy || "owner"),
    rejected_at: new Date(now).toISOString(),
  };
  appendJsonl(agentPaths(agentHome).dispatchApprovals, event);
  return { approval: { ...approval, ...event }, already: false };
}

export function dispatchApprovalMarkup(id) {
  return {
    inline_keyboard: [[
      { text: "Approve", callback_data: `dispatch:approve:${id}` },
      { text: "Reject", callback_data: `dispatch:reject:${id}` },
    ]],
  };
}

export function dispatchApprovalNotice(approval) {
  return [
    `待核准跨 agent 派工（${approval.id}）`,
    `from: ${approval.proposed_by} -> ${approval.to}`,
    `task: ${oneLine(approval.task, 220)}`,
    approval.reason ? `reason: ${oneLine(approval.reason, 220)}` : null,
    "核准後只會建立派工；若需要修改檔案，仍會再要求 execution approval。",
  ].filter(Boolean).join("\n");
}

export function dispatchApproveNotice(result) {
  const outcome = result?.outcome;
  if (!outcome) {
    return "已核准派工。";
  }
  return outcome.type === "task"
    ? `已核准派工，並建立待核准 Codex 任務（${outcome.id}）。`
    : `已核准派工，並送出 exchange message（${outcome.id}）。`;
}

export function dispatchRejectNotice(approval) {
  return `已拒絕跨 agent 派工（${approval.id}）。`;
}

function latestDispatchApprovals(agentHome) {
  const latest = new Map();
  for (const entry of readJsonl(agentPaths(agentHome).dispatchApprovals)) {
    if (entry.id) {
      latest.set(entry.id, { ...(latest.get(entry.id) || {}), ...entry });
    }
  }
  return Array.from(latest.values());
}

function requireDispatchApproval(agentHome, id) {
  const approval = latestDispatchApprovals(agentHome).find((entry) => entry.id === id);
  if (!approval) {
    throw new Error(`Dispatch approval not found: ${id}`);
  }
  return approval;
}

function requireAgentName(value, label) {
  const normalized = String(value || "").trim();
  if (!/^[a-z][a-z0-9_-]*$/.test(normalized) || normalized === "any") {
    throw new Error(`Invalid dispatch ${label}`);
  }
  return normalized;
}

function stripRange(text, start, end) {
  return `${text.slice(0, start)}${text.slice(end)}`;
}

function oneLine(text, maxChars) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  return raw.length > maxChars ? `${raw.slice(0, maxChars - 3)}...` : raw;
}
