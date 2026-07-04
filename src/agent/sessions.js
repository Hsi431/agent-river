import { appendJsonl, readJsonl } from "../lib/jsonl.js";
import { shortHash } from "../lib/hash.js";
import { agentPaths } from "./paths.js";
import { getPrimaryAgentId, getTelegramCodexPolicy, readAgentConfig } from "./safety.js";
import { resolveRepo } from "./v2/repo-resolver.js";

const OWNER_DEFAULT_MESSAGES = 10;
const OWNER_DEFAULT_MINUTES = 30;
const AGENT_MAX_MESSAGES = 6;
const AGENT_MAX_MINUTES = 20;
const TOPIC_MIN = 20;
const TOPIC_MAX = 500;
const VALID_AGENT = /^[a-z][a-z0-9_-]*$/;
const VALID_STATES = new Set(["active", "closed_ok", "exhausted", "killed"]);

export async function openSession({
  agentHome,
  topic,
  initiator = "owner",
  participants,
  repo = null,
  budgetMessages,
  budgetMinutes,
  writeAccess,
  now = Date.now(),
  execFileImpl,
} = {}) {
  if (!agentHome) {
    throw new Error("Missing agentHome");
  }
  const normalizedInitiator = normalizeInitiator(initiator);
  const allowed = dispatchTargetAllowlist(agentHome);
  const names = normalizeParticipants(participants);
  if (normalizedInitiator.startsWith("agent:")) {
    names.add(normalizedInitiator.slice("agent:".length));
  }
  validateParticipants(names, allowed);
  const normalizedTopic = normalizeTopic(topic);
  const budget = normalizeBudget({ initiator: normalizedInitiator, budgetMessages, budgetMinutes });
  const normalizedWriteAccess = normalizeWriteAccess(writeAccess, {
    initiator: normalizedInitiator,
    participants: names,
  });
  const resolvedRepo = repo
    ? await resolveSessionRepo({ agentHome, repo, execFileImpl })
    : null;
  const sessionId = `sess_${now}_${shortHash(`${normalizedInitiator}:${normalizedTopic}:${[...names].sort().join(",")}`)}`;
  const event = {
    event: "session_opened",
    session_id: sessionId,
    topic: normalizedTopic,
    initiator: normalizedInitiator,
    participants: [...names].sort(),
    repo: resolvedRepo,
    budget: {
      max_messages: budget.max_messages,
      max_minutes: budget.max_minutes,
    },
    write_access: normalizedWriteAccess,
    state: "active",
    opened_at: new Date(now).toISOString(),
    ...(budget.clamped ? {
      budget_clamped: true,
      requested_budget: {
        max_messages: budget.requested_messages,
        max_minutes: budget.requested_minutes,
      },
    } : {}),
  };
  appendJsonl(agentPaths(agentHome).sessions, event);
  return foldSessionEvents([event]).get(sessionId);
}

export function getSession(agentHome, id, { now = Date.now() } = {}) {
  const session = foldSessions(agentHome).get(String(id || ""));
  if (!session) {
    return null;
  }
  return expireIfNeeded(agentHome, session, now);
}

export function listActiveSessions(agentHome, { now = Date.now() } = {}) {
  const sessions = Array.from(foldSessions(agentHome).values());
  const active = sessions
    .map((session) => expireIfNeeded(agentHome, session, now))
    .filter((session) => session.state === "active");
  return active.sort((a, b) => String(a.opened_at || "").localeCompare(String(b.opened_at || "")));
}

export function closeSession({ agentHome, id, reason = "ok", now = Date.now() } = {}) {
  const normalizedReason = normalizeCloseReason(reason);
  const session = foldSessions(agentHome).get(String(id || ""));
  if (!session) {
    throw new Error(`Session not found: ${id}`);
  }
  if (session.state !== "active") {
    return session;
  }
  appendSessionClosed(agentHome, session.session_id, normalizedReason, now);
  return foldSessions(agentHome).get(session.session_id);
}

export function killSession({ agentHome, id, now = Date.now() } = {}) {
  return closeSession({ agentHome, id, reason: "killed", now });
}

export function consumeBudget({
  agentHome,
  id,
  messageId = null,
  kind = "message",
  from = null,
  to = null,
  now = Date.now(),
} = {}) {
  const session = getSession(agentHome, id, { now });
  if (!session || session.state !== "active") {
    throw sessionError("session_not_active", `Session is not active: ${id}`);
  }
  if (session.messages_used >= session.budget.max_messages) {
    closeSession({ agentHome, id, reason: "exhausted", now });
    throw sessionError("budget_exhausted", `Session budget exhausted: ${id}`);
  }
  appendJsonl(agentPaths(agentHome).sessions, {
    event: "session_message",
    session_id: session.session_id,
    message_id: messageId ? String(messageId) : null,
    kind: String(kind || "message"),
    from: from ? String(from) : null,
    to: to ? String(to) : null,
    created_at: new Date(now).toISOString(),
  });
  const next = foldSessions(agentHome).get(session.session_id);
  if (next.messages_used >= next.budget.max_messages) {
    appendSessionClosed(agentHome, session.session_id, "exhausted", now);
    return foldSessions(agentHome).get(session.session_id);
  }
  return next;
}

export function assertSessionMessageAllowed({ agentHome, sessionId, from, to, now = Date.now() }) {
  if (!sessionId) {
    return null;
  }
  const session = getSession(agentHome, sessionId, { now });
  if (!session || session.state !== "active") {
    throw sessionError("session_not_active", `Session is not active: ${sessionId}`);
  }
  if (!session.participants.includes(String(from)) || !session.participants.includes(String(to))) {
    throw sessionError("not_participant", "Exchange sender and target must both be session participants");
  }
  if (session.messages_used >= session.budget.max_messages) {
    closeSession({ agentHome, id: session.session_id, reason: "exhausted", now });
    throw sessionError("budget_exhausted", `Session budget exhausted: ${sessionId}`);
  }
  return session;
}

export function isSessionExchangeEligible(agentHome, message, runnerAgent, { now = Date.now() } = {}) {
  if (!message?.session_id) {
    return { eligible: false, reason: "no_session" };
  }
  const session = getSession(agentHome, message.session_id, { now });
  if (!session || session.state !== "active") {
    return { eligible: false, reason: "session_not_active" };
  }
  if (!session.participants.includes(String(message.from)) || !session.participants.includes(String(runnerAgent))) {
    return { eligible: false, reason: "not_participant" };
  }
  if (session.messages_used >= session.budget.max_messages) {
    closeSession({ agentHome, id: session.session_id, reason: "exhausted", now });
    return { eligible: false, reason: "budget_exhausted" };
  }
  return { eligible: true, reason: null, session };
}

function foldSessions(agentHome) {
  return foldSessionEvents(readJsonl(agentPaths(agentHome).sessions));
}

function dispatchTargetAllowlist(agentHome) {
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

function foldSessionEvents(events) {
  const sessions = new Map();
  for (const event of events) {
    if (!event?.session_id) {
      continue;
    }
    const id = String(event.session_id);
    if (event.event === "session_opened") {
      sessions.set(id, {
        session_id: id,
        topic: String(event.topic || ""),
        initiator: String(event.initiator || ""),
        participants: Array.isArray(event.participants) ? event.participants.map(String).sort() : [],
        repo: event.repo || null,
        budget: {
          max_messages: Math.max(0, Number(event.budget?.max_messages) || 0),
          max_minutes: Math.max(0, Number(event.budget?.max_minutes) || 0),
        },
        write_access: Array.isArray(event.write_access) ? event.write_access.map(String).sort() : [],
        state: VALID_STATES.has(event.state) ? event.state : "active",
        opened_at: event.opened_at || event.created_at || null,
        closed_at: null,
        closed_reason: null,
        messages_used: 0,
        budget_clamped: Boolean(event.budget_clamped),
        requested_budget: event.requested_budget || null,
      });
      continue;
    }
    const session = sessions.get(id);
    if (!session) {
      continue;
    }
    if (event.event === "session_message") {
      session.messages_used += 1;
      session.last_message_id = event.message_id || session.last_message_id || null;
      session.last_message_at = event.created_at || session.last_message_at || null;
      continue;
    }
    if (event.event === "session_closed") {
      const reason = normalizeCloseReason(event.reason || "ok");
      session.state = stateForReason(reason);
      session.closed_reason = reason;
      session.closed_at = event.closed_at || event.created_at || null;
    }
  }
  return sessions;
}

function expireIfNeeded(agentHome, session, now) {
  if (session.state !== "active") {
    return session;
  }
  const opened = Date.parse(session.opened_at || "");
  const maxMinutes = Number(session.budget?.max_minutes) || 0;
  if (Number.isFinite(opened) && maxMinutes > 0 && now >= opened + maxMinutes * 60 * 1000) {
    appendSessionClosed(agentHome, session.session_id, "exhausted", now);
    return foldSessions(agentHome).get(session.session_id);
  }
  if (session.messages_used >= session.budget.max_messages) {
    appendSessionClosed(agentHome, session.session_id, "exhausted", now);
    return foldSessions(agentHome).get(session.session_id);
  }
  return session;
}

function appendSessionClosed(agentHome, id, reason, now) {
  appendJsonl(agentPaths(agentHome).sessions, {
    event: "session_closed",
    session_id: id,
    reason,
    state: stateForReason(reason),
    closed_at: new Date(now).toISOString(),
  });
}

async function resolveSessionRepo({ agentHome, repo, execFileImpl }) {
  const policy = getTelegramCodexPolicy(agentHome);
  const raw = String(repo || "").trim();
  if (!raw) {
    return null;
  }
  const input = raw.startsWith("repo=") ? raw : `repo=${raw}`;
  const resolved = await resolveRepo({
    workspaceRoot: policy.workspace_root,
    defaultRepo: policy.default_repo,
    input,
    execFileImpl,
  });
  if (!resolved.ok) {
    throw new Error(`session_repo_${resolved.reason}`);
  }
  return resolved.toplevel;
}

function normalizeInitiator(value) {
  const initiator = String(value || "owner").trim();
  if (initiator === "owner") {
    return initiator;
  }
  if (initiator.startsWith("agent:") && VALID_AGENT.test(initiator.slice("agent:".length))) {
    return initiator;
  }
  throw new Error("Invalid session initiator");
}

function normalizeParticipants(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(",");
  return new Set(raw.map((item) => String(item || "").trim()).filter(Boolean));
}

function validateParticipants(participants, allowed) {
  if (participants.size < 2) {
    throw new Error("Session requires at least two participants");
  }
  for (const name of participants) {
    if (!VALID_AGENT.test(name) || !allowed.has(name)) {
      throw new Error(`Session participant is not registered: ${name}`);
    }
  }
}

function normalizeTopic(value) {
  const topic = String(value || "").trim();
  if (topic.length < TOPIC_MIN || topic.length > TOPIC_MAX) {
    throw new Error(`Session topic must be ${TOPIC_MIN}-${TOPIC_MAX} characters`);
  }
  return topic;
}

function normalizeBudget({ initiator, budgetMessages, budgetMinutes }) {
  const isAgent = initiator.startsWith("agent:");
  const requestedMessages = budgetMessages === undefined ? (isAgent ? AGENT_MAX_MESSAGES : OWNER_DEFAULT_MESSAGES) : requirePositiveInteger(budgetMessages, "budget-messages");
  const requestedMinutes = budgetMinutes === undefined ? (isAgent ? AGENT_MAX_MINUTES : OWNER_DEFAULT_MINUTES) : requirePositiveInteger(budgetMinutes, "budget-minutes");
  if (!isAgent) {
    return {
      max_messages: requestedMessages,
      max_minutes: requestedMinutes,
      requested_messages: requestedMessages,
      requested_minutes: requestedMinutes,
      clamped: false,
    };
  }
  return {
    max_messages: Math.min(requestedMessages, AGENT_MAX_MESSAGES),
    max_minutes: Math.min(requestedMinutes, AGENT_MAX_MINUTES),
    requested_messages: requestedMessages,
    requested_minutes: requestedMinutes,
    clamped: requestedMessages > AGENT_MAX_MESSAGES || requestedMinutes > AGENT_MAX_MINUTES,
  };
}

function normalizeWriteAccess(value, { initiator, participants }) {
  if (initiator.startsWith("agent:")) {
    return [];
  }
  if (value === undefined || value === null || value === "") {
    return [];
  }
  const entries = Array.isArray(value) ? value : String(value).split(",");
  const normalized = entries.map((item) => String(item || "").trim()).filter(Boolean);
  for (const name of normalized) {
    if (!participants.has(name)) {
      throw new Error(`Session write_access must be a participant: ${name}`);
    }
  }
  return [...new Set(normalized)].sort();
}

function normalizeCloseReason(reason) {
  const normalized = String(reason || "ok").trim();
  if (!["ok", "exhausted", "killed"].includes(normalized)) {
    throw new Error("Invalid session close reason");
  }
  return normalized;
}

function stateForReason(reason) {
  if (reason === "ok") {
    return "closed_ok";
  }
  return reason;
}

function requirePositiveInteger(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return n;
}

function sessionError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}
