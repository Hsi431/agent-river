import fs from "node:fs";
import path from "node:path";
import { redactSecrets } from "../../lib/secret-scan.js";
import { agentPaths } from "../paths.js";
import { approveAgentRegistration, rejectAgentRegistration } from "../registry.js";
import { getTelegramCodexPolicy } from "../safety.js";
import { approveAgentTask, rejectAgentTask } from "../orchestrator.js";
import {
  maybeHandleV2,
  sendPendingDispatchNotifications,
  sendPendingExchangeNotifications,
  sendPendingV2Outbox,
} from "../telegram.js";
import { collectDashboardFeed, initializeDashboardCursor, loadDashboardCursor, saveDashboardCursor } from "./feed.js";
import { createDashboardTelegramClient } from "./client.js";
import { dashboardHint, handleDashboardCommand, isDashboardOwner } from "./commands.js";

const DEFAULT_LONG_POLL_SECONDS = 25;
const DEFAULT_SLEEP_SECONDS = 1;

export async function dashboardOnce(options = {}) {
  const client = options.client || createDashboardTelegramClient({
    token: options.token || process.env.TELEGRAM_BOT_TOKEN,
    transport: options.transport || "fetch",
    fetchImpl: options.fetchImpl,
    execFileImpl: options.execFileImpl,
  });
  return runDashboardCycle({ ...options, client });
}

export async function dashboardBridge({
  agentHome,
  maxCycles,
  sleepSeconds = DEFAULT_SLEEP_SECONDS,
  abortSignal,
  sleepImpl = sleep,
  ...rest
} = {}) {
  const cyclesLimit = maxCycles === undefined ? null : Number(maxCycles);
  if (cyclesLimit !== null && (!Number.isInteger(cyclesLimit) || cyclesLimit <= 0)) {
    throw new Error("--max-cycles must be a positive integer");
  }
  acquireDashboardLock(agentHome);
  let cycles = 0;
  try {
    while (!abortSignal?.aborted) {
      if (cyclesLimit !== null && cycles >= cyclesLimit) {
        break;
      }
      cycles += 1;
      await dashboardOnce({ agentHome, ...rest });
      if (cyclesLimit === null || cycles < cyclesLimit) {
        await sleepImpl(Number(sleepSeconds) || DEFAULT_SLEEP_SECONDS, abortSignal);
      }
    }
  } finally {
    releaseDashboardLock(agentHome);
  }
  return { stopped: true, cycles };
}

export function acquireDashboardLock(agentHome) {
  const lockPath = agentPaths(agentHome).dashboardLock;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const content = JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() });
  try {
    fs.writeFileSync(lockPath, content, { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
    let existing = null;
    try {
      existing = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    } catch {
      fs.writeFileSync(lockPath, content);
      return lockPath;
    }
    if (isPidAlive(existing?.pid)) {
      throw new Error(`dashboard bridge already running (pid ${existing.pid})`);
    }
    fs.writeFileSync(lockPath, content);
  }
  return lockPath;
}

export function releaseDashboardLock(agentHome) {
  try {
    fs.unlinkSync(agentPaths(agentHome).dashboardLock);
  } catch { /* best-effort */ }
}

async function runDashboardCycle({
  agentHome,
  client,
  longPollSeconds = 0,
  dashboardChatId,
  execFileImpl,
  token,
  fetchImpl,
  v2Options,
} = {}) {
  const cursor = loadDashboardCursor(agentHome) || initializeDashboardCursor(agentHome);
  const pollTimeout = Math.max(0, Number(longPollSeconds) || 0);
  const updates = await client.getUpdates({
    timeout: pollTimeout,
    allowed_updates: ["message", "callback_query"],
    ...(cursor?.telegram_next_offset === null || cursor?.telegram_next_offset === undefined ? {} : { offset: cursor.telegram_next_offset }),
  });
  let nextCursor = loadDashboardCursor(agentHome);
  let nextOffset = nextCursor?.telegram_next_offset ?? null;
  const handled = [];
  const skipOpenedSessionIds = [];
  for (const update of updates) {
    const result = await handleDashboardUpdate({ agentHome, client, update, execFileImpl, v2Options });
    if (Number.isInteger(update?.update_id)) {
      nextOffset = Math.max(nextOffset ?? 0, update.update_id + 1);
    }
    if (result.opened_session_id) {
      skipOpenedSessionIds.push(result.opened_session_id);
    }
    handled.push({ update_id: update?.update_id ?? null, ...result });
  }
  nextCursor = loadDashboardCursor(agentHome) || { initialized: false };
  nextCursor.telegram_next_offset = nextOffset;

  const feed = collectDashboardFeed(agentHome, { cursor: nextCursor, skipOpenedSessionIds });
  const chatId = dashboardChatId || getTelegramCodexPolicy(agentHome).exchange_notify_chat_id;
  const sentFeed = [];
  if (chatId) {
    for (const event of feed.events) {
      await sendSafe(client, { chatId, text: event.text, replyMarkup: event.reply_markup });
      sentFeed.push({ kind: event.kind, task_id: event.task_id || null });
    }
  }
  const request = createDashboardFlushRequest(client);
  const v2OutboxResults = await sendPendingV2Outbox({ agentHome, token, request, fetchImpl });
  const exchangeNotifications = await sendPendingExchangeNotifications({ agentHome, token, request, fetchImpl });
  const dispatchNotifications = await sendPendingDispatchNotifications({ agentHome, token, request, fetchImpl });
  feed.cursor.telegram_next_offset = nextOffset;
  saveDashboardCursor(agentHome, feed.cursor);
  return {
    updates: updates.length,
    handled,
    feed: sentFeed,
    v2_outbox: v2OutboxResults,
    exchange_notifications: exchangeNotifications,
    dispatch_notifications: dispatchNotifications,
    next_offset: nextOffset,
  };
}

async function handleDashboardUpdate({ agentHome, client, update, execFileImpl, v2Options }) {
  const callback = update?.callback_query;
  if (callback?.id && callback?.from?.id && callback?.data) {
    return handleDashboardCallback({ agentHome, client, callback });
  }
  const message = update?.message;
  if (!message?.text || !message?.from?.id || !message?.chat?.id) {
    return { ok: false, reason: "unsupported_update" };
  }
  const chatId = message.chat.id;
  if (!isDashboardOwner(agentHome, message.from.id)) {
    await sendSafe(client, { chatId, text: "唯讀" });
    return { ok: false, reason: "not_owner" };
  }
  const text = String(message.text || "");
  let reply;
  if (text.startsWith("/")) {
    reply = await handleDashboardCommand({ agentHome, text, execFileImpl });
    const payload = typeof reply === "object" && reply !== null ? reply : { text: reply };
    await sendSafe(client, { chatId, text: payload.text });
    return { ok: true, reason: "message", ...(payload.opened_session_id ? { opened_session_id: payload.opened_session_id } : {}) };
  } else if (text.trim().startsWith("@")) {
    const v2 = await maybeHandleV2({
      agentHome,
      message,
      execFileImpl,
      requireOwnerPolicy: false,
      v2Options,
    });
    if (v2?.payload?.method === "sendMessage") {
      await sendSafe(client, { chatId, text: v2.payload.text, replyMarkup: v2.payload.reply_markup });
      return { ok: true, reason: "v2" };
    }
    reply = dashboardHint();
  } else {
    reply = dashboardHint();
  }
  await sendSafe(client, { chatId, text: reply });
  return { ok: true, reason: "message" };
}

function createDashboardFlushRequest(client) {
  return async ({ method, body }) => {
    if (method !== "sendMessage") {
      throw new Error(`Unsupported dashboard flush method: ${method}`);
    }
    return client.sendMessage({
      chatId: body.chat_id,
      text: body.text,
      replyMarkup: body.reply_markup,
    });
  };
}

async function handleDashboardCallback({ agentHome, client, callback }) {
  const parsed = parseDashboardCallback(callback.data);
  if (!parsed) {
    await answerSafe(client, { callbackQueryId: callback.id, text: "Invalid action." });
    return { ok: false, reason: "callback_invalid" };
  }
  if (!isDashboardOwner(agentHome, callback.from.id)) {
    await answerSafe(client, { callbackQueryId: callback.id, text: "唯讀" });
    return { ok: false, reason: "not_owner" };
  }
  let notice;
  try {
    if (parsed.kind === "join") {
      notice = handleJoinCallback({ agentHome, action: parsed.action, name: parsed.name });
    } else {
      const task = parsed.action === "approve"
        ? approveAgentTask({ agentHome, id: parsed.taskId })
        : rejectAgentTask({ agentHome, id: parsed.taskId });
      notice = parsed.action === "approve"
        ? `已放行 ${task.id}`
        : `已拒絕 ${task.id}`;
    }
  } catch {
    if (parsed.kind === "join") {
      notice = parsed.action === "approve" ? "無法核准" : "無法拒絕";
    } else {
      notice = parsed.action === "approve" ? "無法放行" : "無法拒絕";
    }
  }
  await answerSafe(client, { callbackQueryId: callback.id, text: notice });
  const chatId = callback.message?.chat?.id;
  if (chatId) {
    await sendSafe(client, { chatId, text: notice });
  }
  return { ok: true, reason: `${parsed.kind}_${parsed.action}` };
}

function handleJoinCallback({ agentHome, action, name }) {
  if (action === "approve") {
    const approved = approveAgentRegistration({ agentHome, name });
    return approved.agent.style === "poll"
      ? `已核准 ${name}, token 已落檔`
      : `已核准 ${name}, ${approved.agent.style} 型由 Node 代管,不產 token`;
  }
  rejectAgentRegistration({ agentHome, name });
  return `已拒絕 ${name}`;
}

async function sendSafe(client, { chatId, text, replyMarkup }) {
  await client.sendMessage({ chatId, text: redactSecrets(String(text || "")), replyMarkup });
}

async function answerSafe(client, { callbackQueryId, text }) {
  await client.answerCallback({ callbackQueryId, text: redactSecrets(String(text || "")) });
}

function parseDashboardCallback(data) {
  const raw = String(data || "");
  const gate = raw.match(/^gate:(approve|reject):(task_[A-Za-z0-9_-]+)$/);
  if (gate) {
    return { kind: "gate", action: gate[1], taskId: gate[2] };
  }
  const join = raw.match(/^join:(approve|reject):([a-z][a-z0-9_-]*)$/);
  return join ? { kind: "join", action: join[1], name: join[2] } : null;
}

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) {
    return false;
  }
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function sleep(seconds, abortSignal) {
  return new Promise((resolve) => {
    if (abortSignal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, Math.max(0, seconds) * 1000);
    abortSignal?.addEventListener?.("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
