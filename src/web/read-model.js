import fs from "node:fs";
import path from "node:path";
import { listDispatchApprovals } from "../agent/dispatch.js";
import { agentPaths } from "../agent/paths.js";
import { listRegisteredAgents } from "../agent/registry.js";
import { listSessions } from "../agent/sessions.js";
import { checkSafety, getSafetyStatus } from "../agent/safety.js";
import { codexRunnerServiceStatus, dashboardServiceStatus, execRunnerServiceStatus, opusRunnerServiceStatus, webServiceStatus } from "../agent/service.js";
import { readJsonl } from "../lib/jsonl.js";
import { redactSecrets } from "../lib/secret-scan.js";
import { isOwnerMailboxTargetEligible } from "../agent/owner-mailbox.js";

const TERMINAL_TASK_STATES = new Set(["done", "failed", "rejected", "cancelled"]);
const TERMINAL_SESSION_STATES = new Set(["closed_ok", "exhausted", "killed"]);

export function readWebStatus(agentHome, options = {}) {
  const inbox = listInboxItems(agentHome, options);
  const dispatches = listDispatchItems(agentHome);
  const sessions = listWebSessions(agentHome, options);
  const agents = listWebAgents(agentHome, options);
  const archive = listArchiveItems(agentHome, options);
  const safety = readWebSafety(agentHome, options);
  return {
    system: safety.ok ? "available" : "stopped",
    activeAgents: agents.filter((agent) => agent.status === "active").length,
    activeSessions: sessions.filter((session) => session.status === "active").length,
    pendingApprovals: dispatches.filter((dispatch) => dispatch.status === "pending").length
      + inbox.filter((item) => item.type === "task" && item.status === "needs_approval").length
      + agents.filter((agent) => agent.status === "pending").length,
    openInboxItems: inbox.filter((item) => item.status === "open" || item.status === "working").length,
    recentCompletions: archive.slice(0, 10),
    warnings: safety.warnings,
  };
}

export function listInboxItems(agentHome, { now = Date.now() } = {}) {
  const paths = agentPaths(agentHome);
  const claims = latestBy(readJsonl(paths.exchangeClaims), "message_id");
  const replies = groupBy(readJsonl(paths.exchangeReplies), "message_id");
  const messages = readJsonl(paths.exchangeMessages);
  const dispatchModels = normalizedDispatches(agentHome);
  const taskDispatches = new Map(dispatchModels
    .filter((dispatch) => dispatch.outcome?.type === "task" && dispatch.outcome.id)
    .map((dispatch) => [dispatch.outcome.id, dispatch.id]));
  const exchange = messages.map((message) => {
    const claim = claims.get(message.id) || null;
    const messageReplies = replies.get(message.id) || [];
    const status = exchangeStatus(claim, now);
    return {
      id: message.id,
      type: "exchange_message",
      title: message.subject ? redactSecrets(String(message.subject)) : `Message from ${message.from || "unknown"}`,
      sender: message.from || null,
      recipient: message.to || null,
      repo: message.repo || null,
      sessionId: message.session_id || null,
      dispatchId: message.dispatch?.id || null,
      status,
      priority: null,
      createdAt: message.created_at || null,
      updatedAt: latestTimestamp(message.created_at, claimTimestamp(claim), ...messageReplies.map((reply) => reply.created_at)),
      summary: summarize(message.text),
      rawPath: paths.exchangeMessages,
      replyCount: messageReplies.length,
      raw: sanitizeRaw({ message, claim, replies: messageReplies }),
    };
  });
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  const exchangeReplies = [...replies.values()].flat().map((reply) => {
    const source = messagesById.get(reply.message_id) || null;
    return {
      id: reply.id,
      type: "exchange_reply",
      title: `Reply from ${reply.agent_id || "unknown"}`,
      sender: reply.agent_id || null,
      recipient: source?.from || null,
      repo: source?.repo || null,
      sessionId: reply.session_id || source?.session_id || null,
      dispatchId: null,
      status: "completed",
      priority: null,
      createdAt: reply.created_at || null,
      updatedAt: reply.created_at || null,
      summary: summarize(reply.text),
      rawPath: paths.exchangeReplies,
      sourceMessageId: reply.message_id || null,
      raw: sanitizeRaw({ reply, source_message: source }),
    };
  });
  const alerts = runnerAlerts(paths, messagesById);
  const dispatch = dispatchModels.map((approval) => ({
    ...approval,
    type: "dispatch_request",
    title: `Dispatch ${approval.sender || "unknown"} to ${approval.recipient || "unknown"}`,
  }));
  const tasks = readTasks(paths.tasksDir).map((task) => ({
    id: task.id,
    type: task.status === "done" ? "task_result" : "task",
    title: `${task.executor || "agent"} ${task.mode || "task"}`,
    sender: task.executor || null,
    recipient: task.requester || "owner",
    repo: task.repo || null,
    sessionId: task.session_id || null,
    dispatchId: taskDispatches.get(task.id) || null,
    status: TERMINAL_TASK_STATES.has(task.status) ? task.status : task.approval === "pending" ? "needs_approval" : task.status || null,
    priority: null,
    createdAt: task.created_at || null,
    updatedAt: task.updated_at || task.created_at || null,
    summary: summarize(task.result?.summary || task.request),
    rawPath: path.join(paths.tasksDir, `${task.id}.json`),
    raw: sanitizeRaw(task),
  }));
  return [...exchange, ...exchangeReplies, ...dispatch, ...tasks, ...alerts].sort(newestFirst);
}

export function getInboxItem(agentHome, id, options = {}) {
  return listInboxItems(agentHome, options).find((item) => item.id === String(id || "")) || null;
}

export function listDispatchItems(agentHome) {
  return normalizedDispatches(agentHome).sort(newestFirst);
}

export function listWebSessions(agentHome, { now = Date.now() } = {}) {
  const paths = agentPaths(agentHome);
  return listSessions(agentHome).map((session) => {
    const status = effectiveSessionStatus(session, now);
    return {
      id: session.session_id,
      sessionId: session.session_id,
      topic: redactSecrets(session.topic || ""),
      initiator: session.initiator || null,
      agents: session.participants || [],
      repo: session.repo || null,
      status,
      sourceStatus: session.state,
      messageCount: session.messages_used,
      budget: sanitizeRaw(session.budget),
      writeAccess: session.write_access || [],
      startedAt: session.opened_at || null,
      lastActivity: session.last_message_at || session.closed_at || session.opened_at || null,
      closedAt: session.closed_at || null,
      closedReason: session.closed_reason || null,
      transcriptPath: transcriptPath(paths, session.session_id),
      rawPath: paths.sessions,
      raw: sanitizeRaw(session),
    };
  });
}

export function getWebSession(agentHome, id, options = {}) {
  const session = listSessions(agentHome).find((item) => item.session_id === String(id || ""));
  if (!session) {
    return null;
  }
  const normalized = listWebSessions(agentHome, options).find((item) => item.id === session.session_id);
  return { ...normalized, timeline: sessionTimeline(agentHome, session.session_id) };
}

export function listWebAgents(agentHome, { now = Date.now() } = {}) {
  const paths = agentPaths(agentHome);
  const registry = new Map(listRegisteredAgents(agentHome).map((agent) => [agent.name, agent]));
  const safety = getSafetyStatus(agentHome);
  const configured = new Map((safety.config.exchange_agents || []).map((agent) => [agent.agent_id, agent]));
  const primary = safety.config.primary_agent_id;
  const claims = readJsonl(paths.exchangeClaims);
  const messages = readJsonl(paths.exchangeMessages);
  const latestClaims = latestBy(claims, "message_id");
  const names = new Set([...registry.keys(), ...configured.keys(), primary]);
  return [...names].sort().map((name) => {
    const agent = registry.get(name) || null;
    const route = configured.get(name) || null;
    const agentClaims = claims.filter((claim) => claim.agent_id === name);
    const eligibleWorkCount = messages.filter((message) => {
      if (message.to !== name && message.to !== "any") return false;
      return exchangeStatus(latestClaims.get(message.id), now) !== "completed";
    }).length;
    return {
      name,
      kind: route?.kind || null,
      style: agent?.style || null,
      capabilities: agent?.capabilities || [],
      status: agent?.status || null,
      routingConfigured: name === primary ? true : configured.has(name),
      routingEnabled: name === primary ? true : route?.enabled ?? null,
      primary: name === primary,
      runnerStatus: null,
      lastClaimAt: latestTimestamp(...agentClaims.map(claimTimestamp)),
      eligibleWorkCount,
      requestedAt: agent?.requested_at || null,
      approvedAt: agent?.approved_at || null,
      rawPath: agent ? paths.agentRegistry : paths.config,
      raw: sanitizeRaw({ registry: agent, routing: route }),
    };
  });
}

export function listWebRequestTargets(agentHome) {
  return listWebAgents(agentHome)
    .filter((agent) => isOwnerMailboxTargetEligible(agentHome, agent.name, { allowPrimary: true, requireActiveTarget: true }))
    .map((agent) => ({ name: agent.name, kind: agent.kind, style: agent.style, primary: agent.primary }));
}

export function readWebSafety(agentHome, { now = new Date(), repoDir = process.cwd(), systemdDir, webPort = 4310 } = {}) {
  const paths = agentPaths(agentHome);
  const status = getSafetyStatus(agentHome, now instanceof Date ? now : new Date(now));
  const guard = checkSafety(agentHome, now instanceof Date ? now : new Date(now));
  const policy = status.config.telegram_codex_policy || {};
  const services = {
    dashboard: unitFileStatus(dashboardServiceStatus({ agentHome, dir: systemdDir, repoDir }).unit),
    opus: unitFileStatus(opusRunnerServiceStatus({ dir: systemdDir, repoDir }).unit),
    codex: unitFileStatus(codexRunnerServiceStatus({ dir: systemdDir, repoDir }).unit),
    exec: unitFileStatus(execRunnerServiceStatus({ agentHome, dir: systemdDir, repoDir }).unit),
    web: unitFileStatus(webServiceStatus({ agentHome, dir: systemdDir, repoDir, port: webPort }).unit),
  };
  const warnings = [];
  if (status.config.kill_switch) warnings.push("Kill switch is enabled");
  if (status.config.config_error) warnings.push(`Configuration is fail-closed: ${status.config.config_error}`);
  if (status.today.remaining_tokens === 0) warnings.push("Daily token budget is exhausted");
  return {
    ok: guard.ok,
    blockedReason: guard.reason,
    killSwitch: status.config.kill_switch,
    ownerAllowlist: {
      gatewayCount: status.config.gateway_allowlist?.length || 0,
      gatewayConfigured: Boolean(status.config.gateway_allowlist?.length),
      telegramCount: policy.direct_send_user_allowlist?.length || 0,
      telegramOwnerConfigured: Boolean(policy.direct_send_user_allowlist?.length),
      configured: Boolean((status.config.gateway_allowlist?.length || 0) + (policy.direct_send_user_allowlist?.length || 0)),
    },
    v2RoutingEnabled: policy.v2_enabled,
    workspaceRoot: policy.workspace_root || null,
    defaultRepo: policy.default_repo || null,
    dailyBudget: status.config.daily_token_budget,
    today: status.today,
    exchangeRunnerEnabled: policy.exchange_runner_enabled,
    secretScanStatus: null,
    dashboardLockPresent: fs.existsSync(paths.dashboardLock),
    runnerLocks: {
      opus: fs.existsSync(paths.exchangeRunnerLock),
      codex: fs.existsSync(paths.codexExchangeRunnerLock),
      exec: fs.existsSync(paths.execRunnerLock),
    },
    serviceUnitFiles: services,
    warnings,
    rawPath: paths.config,
    raw: sanitizeRaw({
      ...status.config,
      gateway_allowlist: { count: status.config.gateway_allowlist?.length || 0 },
      telegram_codex_policy: {
        ...policy,
        direct_send_user_allowlist: { count: policy.direct_send_user_allowlist?.length || 0 },
        exchange_notify_chat_id: policy.exchange_notify_chat_id ? "[configured]" : null,
      },
    }),
  };
}

function unitFileStatus(unit) {
  return { name: unit.name, path: unit.path, exists: unit.exists, drift: unit.drift };
}

export function listArchiveItems(agentHome, options = {}) {
  const inbox = listInboxItems(agentHome, options)
    .filter((item) => item.status === "completed" || item.status === "approved" || item.status === "rejected" || TERMINAL_TASK_STATES.has(item.status));
  const sessions = listWebSessions(agentHome, options)
    .filter((session) => TERMINAL_SESSION_STATES.has(session.status))
    .map((session) => ({ ...session, type: "session" }));
  return [...inbox, ...sessions].sort(newestFirst);
}

function normalizedDispatches(agentHome) {
  const paths = agentPaths(agentHome);
  return listDispatchApprovals(agentHome).map((approval) => ({
    id: approval.id,
    dispatchId: approval.id,
    sender: approval.proposed_by || null,
    recipient: approval.to || null,
    reason: redactSecrets(approval.reason || ""),
    task: redactSecrets(approval.task || ""),
    repo: approval.repo || null,
    requestedMode: approval.suggested_mode || null,
    riskLevel: null,
    budgetImpact: null,
    status: approval.status,
    parentMessageId: approval.parent_msg_id || null,
    hop: approval.hop ?? null,
    createdAt: approval.created_at || null,
    updatedAt: latestTimestamp(approval.rejected_at, approval.approved_at, approval.notified_at, approval.created_at),
    outcome: sanitizeRaw(approval.outcome || null),
    summary: summarize(approval.task),
    rawPath: paths.dispatchApprovals,
    raw: sanitizeRaw(approval),
  }));
}

function sessionTimeline(agentHome, sessionId) {
  const paths = agentPaths(agentHome);
  const messages = readJsonl(paths.exchangeMessages);
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  const rows = [];
  for (const event of readJsonl(paths.sessions).filter((event) => event.session_id === sessionId)) {
    if (event.event === "session_opened" || event.event === "session_closed") {
      rows.push({
        id: `${event.event}:${event.opened_at || event.closed_at || ""}`,
        type: event.event,
        from: event.initiator || null,
        to: event.participants || null,
        text: event.event === "session_opened" ? redactSecrets(event.topic || "") : null,
        createdAt: event.opened_at || event.closed_at || event.created_at || null,
        raw: sanitizeRaw(event),
      });
    }
  }
  for (const message of messages.filter((message) => message.session_id === sessionId)) {
    rows.push({
      id: message.id,
      type: "message",
      from: message.from || null,
      to: message.to || null,
      text: redactSecrets(message.text || ""),
      createdAt: message.created_at || null,
      raw: sanitizeRaw(message),
    });
  }
  for (const reply of readJsonl(paths.exchangeReplies)) {
    const source = messagesById.get(reply.message_id);
    if ((reply.session_id || source?.session_id) !== sessionId) continue;
    rows.push({
      id: reply.id,
      type: "reply",
      from: reply.agent_id || null,
      to: source?.from || null,
      text: redactSecrets(reply.text || ""),
      createdAt: reply.created_at || null,
      raw: sanitizeRaw(reply),
    });
  }
  return rows.sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
}

function runnerAlerts(paths, messagesById) {
  const rows = [
    ...readJsonl(paths.exchangeRunnerDispatch)
      .filter((row) => row.outcome === "blocked_terminal")
      .map((row) => ({ agent: "opus", row, rawPath: paths.exchangeRunnerDispatch })),
    ...readJsonl(paths.codexExchangeRunnerDispatch)
      .filter((row) => row.outcome === "blocked_terminal")
      .map((row) => ({ agent: "codex", row, rawPath: paths.codexExchangeRunnerDispatch })),
    ...readJsonl(paths.execRunnerDispatch)
      .filter((row) => (row.outcome === "failed_released" || row.outcome === "timed_out_released") && Number(row.attempt) >= 2)
      .map((row) => ({ agent: row.agent || "exec", row, rawPath: paths.execRunnerDispatch })),
  ];
  return rows.map(({ agent, row, rawPath }) => {
    const source = messagesById.get(row.message_id) || null;
    return {
      id: `runner:${agent}:${row.message_id || "unknown"}:${row.attempt ?? "unknown"}:${row.created_at || "unknown"}`,
      type: "system_alert",
      title: `${agent} runner terminal failure`,
      sender: agent,
      recipient: "owner",
      repo: source?.repo || null,
      sessionId: source?.session_id || null,
      dispatchId: null,
      status: "failed",
      priority: null,
      createdAt: row.created_at || null,
      updatedAt: row.created_at || null,
      summary: summarize(row.error || row.outcome),
      rawPath,
      sourceMessageId: row.message_id || null,
      raw: sanitizeRaw({ dispatch: row, source_message: source }),
    };
  });
}

function readTasks(tasksDir) {
  try {
    return fs.readdirSync(tasksDir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .flatMap((name) => {
        try {
          const value = JSON.parse(fs.readFileSync(path.join(tasksDir, name), "utf8"));
          return value && typeof value === "object" && value.id ? [value] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function transcriptPath(paths, sessionId) {
  const file = path.join(paths.sessionTranscriptsDir, `${sessionId}.md`);
  return fs.existsSync(file) ? file : null;
}

function effectiveSessionStatus(session, now) {
  if (session.state !== "active") return session.state;
  if (session.messages_used >= session.budget?.max_messages) return "exhausted";
  const openedAt = Date.parse(session.opened_at || "");
  const maxMinutes = Number(session.budget?.max_minutes) || 0;
  return Number.isFinite(openedAt) && maxMinutes > 0 && Number(now) >= openedAt + maxMinutes * 60 * 1000
    ? "exhausted"
    : session.state;
}

function latestBy(rows, key) {
  const latest = new Map();
  for (const row of rows) {
    if (row?.[key]) latest.set(row[key], { ...(latest.get(row[key]) || {}), ...row });
  }
  return latest;
}

function groupBy(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    if (!row?.[key]) continue;
    groups.set(row[key], [...(groups.get(row[key]) || []), row]);
  }
  return groups;
}

function exchangeStatus(claim, now) {
  if (claim?.status === "completed") return "completed";
  if (claim?.status === "claimed" && Date.parse(claim.lease_expires_at || "") > Number(now)) return "working";
  return "open";
}

function claimTimestamp(claim) {
  return claim?.completed_at || claim?.released_at || claim?.claimed_at || null;
}

function summarize(value, max = 160) {
  const text = redactSecrets(String(value || "").replace(/\s+/g, " ").trim());
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function latestTimestamp(...values) {
  return values.filter(Boolean).sort().at(-1) || null;
}

function newestFirst(a, b) {
  return String(b.updatedAt || b.lastActivity || b.createdAt || "")
    .localeCompare(String(a.updatedAt || a.lastActivity || a.createdAt || ""));
}

function sanitizeRaw(value, key = "") {
  if (isSensitiveKey(key)) return value === null || value === undefined ? value : "[redacted]";
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeRaw(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, sanitizeRaw(child, childKey)]));
}

function isSensitiveKey(key) {
  return /(?:^|_)(?:api_key|token|secret|password|credential|authorization)(?:$|_)/i.test(key)
    && !/(?:budget|count|usage)/i.test(key);
}
