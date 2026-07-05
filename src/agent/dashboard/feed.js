import fs from "node:fs";
import path from "node:path";
import { readJsonl } from "../../lib/jsonl.js";
import { shortHash } from "../../lib/hash.js";
import { redactSecrets } from "../../lib/secret-scan.js";
import { agentPaths } from "../paths.js";
import { listRegisteredAgents } from "../registry.js";
import { getSession } from "../sessions.js";
import { listTasks } from "../tasks.js";

const SUMMARY_CHARS = 60;

export function loadDashboardCursor(agentHome) {
  const file = agentPaths(agentHome).dashboardCursor;
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    return normalizeCursor(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

export function saveDashboardCursor(agentHome, cursor) {
  const file = agentPaths(agentHome).dashboardCursor;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(normalizeCursor(cursor), null, 2)}\n`);
}

export function initializeDashboardCursor(agentHome) {
  const paths = agentPaths(agentHome);
  const cursor = {
    initialized: true,
    telegram_next_offset: null,
    ledgers: {
      sessions: fileSize(paths.sessions),
      exchange_messages: fileSize(paths.exchangeMessages),
      exchange_replies: fileSize(paths.exchangeReplies),
    },
    task_keys: taskKeys(agentHome),
    registry_keys: registryKeys(agentHome),
  };
  saveDashboardCursor(agentHome, cursor);
  return cursor;
}

export function collectDashboardFeed(agentHome, { cursor = loadDashboardCursor(agentHome) } = {}) {
  if (!cursor?.initialized) {
    const initialized = initializeDashboardCursor(agentHome);
    return { events: [], cursor: initialized };
  }
  const paths = agentPaths(agentHome);
  const messagesById = new Map(readJsonl(paths.exchangeMessages).map((message) => [message.id, message]));
  const next = normalizeCursor(cursor);
  const events = [
    ...sessionEvents(agentHome, paths.sessions, next),
    ...exchangeMessageEvents(agentHome, paths.exchangeMessages, next),
    ...exchangeReplyEvents(agentHome, paths.exchangeReplies, next, messagesById),
    ...gateEvents(agentHome, next),
    ...joinEvents(agentHome, next),
  ].sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
  next.ledgers.sessions = fileSize(paths.sessions);
  next.ledgers.exchange_messages = fileSize(paths.exchangeMessages);
  next.ledgers.exchange_replies = fileSize(paths.exchangeReplies);
  next.task_keys = taskKeys(agentHome);
  next.registry_keys = registryKeys(agentHome);
  return { events, cursor: next };
}

export function gateMarkup(taskId) {
  return {
    inline_keyboard: [[
      { text: "放行", callback_data: `gate:approve:${taskId}` },
      { text: "拒絕", callback_data: `gate:reject:${taskId}` },
    ]],
  };
}

export function joinMarkup(name) {
  return {
    inline_keyboard: [[
      { text: "核准", callback_data: `join:approve:${name}` },
      { text: "拒絕", callback_data: `join:reject:${name}` },
    ]],
  };
}

function sessionEvents(agentHome, file, cursor) {
  return readJsonlSince(file, cursor.ledgers.sessions)
    .filter((event) => event.event === "session_opened" || event.event === "session_closed")
    .map((event) => {
      const session = getSession(agentHome, event.session_id) || event;
      const code = shortSession(event.session_id);
      if (event.event === "session_opened") {
        return {
          kind: "session",
          created_at: event.opened_at || event.created_at || "",
          text: `session #${code} 開場 ${participants(session)} budget ${session.budget?.max_messages}/${session.budget?.max_minutes}${event.budget_clamped ? " clamped" : ""}${session.repo ? ` repo=${session.repo}` : ""}`,
        };
      }
      return {
        kind: "session",
        created_at: event.closed_at || event.created_at || "",
        text: `session #${code} 收場 reason=${event.reason || session.closed_reason || "ok"}`,
      };
    });
}

function exchangeMessageEvents(agentHome, file, cursor) {
  return readJsonlSince(file, cursor.ledgers.exchange_messages)
    .filter((message) => message.session_id)
    .map((message) => ({
      kind: "exchange",
      created_at: message.created_at || "",
      text: exchangeLine(agentHome, {
        sessionId: message.session_id,
        from: message.from,
        to: message.to,
        text: message.text,
      }),
    }));
}

function exchangeReplyEvents(agentHome, file, cursor, messagesById) {
  return readJsonlSince(file, cursor.ledgers.exchange_replies)
    .filter((reply) => reply.session_id || messagesById.get(reply.message_id)?.session_id)
    .map((reply) => {
      const message = messagesById.get(reply.message_id) || {};
      const sessionId = reply.session_id || message.session_id;
      return {
        kind: "exchange",
        created_at: reply.created_at || "",
        text: exchangeLine(agentHome, {
          sessionId,
          from: reply.agent_id,
          to: message.from || "unknown",
          text: reply.text,
        }),
      };
    });
}

function gateEvents(agentHome, cursor) {
  const previous = cursor.task_keys || {};
  return listTasks(agentHome)
    .filter((task) => task.mode === "edit" && task.status === "queued" && task.approval === "pending")
    .filter((task) => previous[task.id] !== taskKey(task))
    .map((task) => ({
      kind: "gate",
      task_id: task.id,
      created_at: task.updated_at || task.created_at || "",
      text: `硬閘 edit task ${task.id} pending repo=${task.repo}\n${oneLine(task.request, SUMMARY_CHARS)}`,
      reply_markup: gateMarkup(task.id),
    }));
}

function joinEvents(agentHome, cursor) {
  const previous = cursor.registry_keys || {};
  return listRegisteredAgents(agentHome)
    .filter((agent) => agent.status === "pending")
    .filter((agent) => previous[agent.name] !== registryKey(agent))
    .map((agent) => ({
      kind: "join",
      agent_name: agent.name,
      created_at: agent.requested_at || "",
      text: joinLine(agent),
      reply_markup: joinMarkup(agent.name),
    }));
}

function joinLine(agent) {
  const base = `agent join pending ${agent.name} style=${agent.style} capabilities=${agent.capabilities.join(",")}`;
  return agent.style === "exec"
    ? `${base} command=${agent.exec_command}`
    : base;
}

function exchangeLine(agentHome, { sessionId, from, to, text }) {
  const session = getSession(agentHome, sessionId) || {};
  return `#${shortSession(sessionId)} ${from || "unknown"}→${to || "unknown"}: ${oneLine(text, SUMMARY_CHARS)} (${session.messages_used ?? "?"}/${session.budget?.max_messages ?? "?"}封)`;
}

function readJsonlSince(file, offset) {
  if (!fs.existsSync(file)) {
    return [];
  }
  const start = Math.min(Math.max(0, Number(offset) || 0), fileSize(file));
  const buffer = fs.readFileSync(file);
  const text = buffer.subarray(start).toString("utf8");
  return text.split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function taskKeys(agentHome) {
  const out = {};
  for (const task of listTasks(agentHome)) {
    if (task?.id) {
      out[task.id] = taskKey(task);
    }
  }
  return out;
}

function registryKeys(agentHome) {
  const out = {};
  for (const agent of listRegisteredAgents(agentHome)) {
    out[agent.name] = registryKey(agent);
  }
  return out;
}

function taskKey(task) {
  return `${task.status}:${task.approval}:${task.updated_at || ""}`;
}

function registryKey(agent) {
  return `${agent.status}:${agent.requested_at || ""}:${agent.approved_at || ""}`;
}

function normalizeCursor(value) {
  return {
    initialized: Boolean(value?.initialized),
    telegram_next_offset: Number.isInteger(value?.telegram_next_offset) ? value.telegram_next_offset : null,
    ledgers: {
      sessions: Math.max(0, Number(value?.ledgers?.sessions) || 0),
      exchange_messages: Math.max(0, Number(value?.ledgers?.exchange_messages) || 0),
      exchange_replies: Math.max(0, Number(value?.ledgers?.exchange_replies) || 0),
    },
    task_keys: value?.task_keys && typeof value.task_keys === "object" && !Array.isArray(value.task_keys)
      ? Object.fromEntries(Object.entries(value.task_keys).map(([key, val]) => [String(key), String(val)]))
      : {},
    registry_keys: value?.registry_keys && typeof value.registry_keys === "object" && !Array.isArray(value.registry_keys)
      ? Object.fromEntries(Object.entries(value.registry_keys).map(([key, val]) => [String(key), String(val)]))
      : {},
  };
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function shortSession(id) {
  return shortHash(String(id || "")).slice(0, 6);
}

function participants(session) {
  return Array.isArray(session.participants) ? session.participants.join(",") : "";
}

function oneLine(text, maxChars) {
  const raw = redactSecrets(String(text || "").replace(/\s+/g, " ").trim());
  return raw.length > maxChars ? `${raw.slice(0, Math.max(0, maxChars - 3))}...` : raw;
}
