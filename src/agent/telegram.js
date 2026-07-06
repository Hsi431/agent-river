import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { shortHash } from "../lib/hash.js";
import { appendJsonl, readJsonl } from "../lib/jsonl.js";
import { scanSecrets, redactSecrets } from "../lib/secret-scan.js";
import { routeUpdate, handleV2Message, handleV2Stop, handleV2Status, latestV2Outbox, markV2OutboxSent } from "./v2/poller.js";
import { handleGatewayMessage } from "./gateway.js";
import { agentPaths } from "./paths.js";
import { checkSafety, getTelegramCodexPolicy, isExchangeAgentEnabled } from "./safety.js";
import { stopAllTurns } from "./v2/kill.js";
import {
  approveDispatch,
  DISPATCH_CHANNEL,
  dispatchApprovalMarkup,
  dispatchApprovalNotice,
  dispatchApproveNotice,
  dispatchRejectNotice,
  listPendingDispatchNotifications,
  markDispatchApprovalNotified,
  parseDispatchProposal,
  rejectDispatch,
} from "./dispatch.js";

export async function handleTelegramUpdate({ agentHome, update, memoryStateHome, runner, execFileImpl }) {
  const callback = extractCallbackQuery(update);
  if (callback) {
    return handleTelegramCallback({ agentHome, callback });
  }

  const message = extractMessage(update);
  if (!message) {
    return { ok: false, payload: null, reason: "unsupported_update" };
  }

  // v2 intercept (opt-in, owner-only): a single poller routes @agent / control
  // messages to the v2 path; everything else falls through to v1 unchanged.
  const v2 = await maybeHandleV2({ agentHome, message, execFileImpl });
  if (v2) {
    return v2;
  }

  if (!isGatewayText(message.text, agentHome)) {
    return {
      ok: false,
      payload: null,
      reason: "unsupported_message",
    };
  }

  const gateway = await handleGatewayMessage({
    agentHome,
    userId: String(message.from.id),
    chatId: String(message.chat.id),
    text: message.text,
    memoryStateHome,
    runner,
    execFileImpl,
  });

  return {
    ok: true,
    gateway,
    payload: {
      method: "sendMessage",
      chat_id: message.chat.id,
      text: gateway.reply,
      ...(gateway.reply_markup ? { reply_markup: gateway.reply_markup } : {}),
    },
  };
}

// v2 intercept: opt-in (policy.v2_enabled), owner-only. Routes `/stop`, `/status`,
// and `@agent ...` messages to the v2 path; returns null to fall through to v1.
// §15.A: agent turns now run in the BACKGROUND; this function returns the start
// ack immediately. Results arrive via the v2 outbox flushed by each poll cycle.
export async function maybeHandleV2({ agentHome, message, execFileImpl, requireOwnerPolicy = true, v2Options = {} }) {
  const policy = getTelegramCodexPolicy(agentHome);
  if (!policy.v2_enabled) {
    return null;
  }
  const ownerUserId = String(message.from.id);
  if (requireOwnerPolicy && !isPolicyOwner(policy, ownerUserId)) {
    return null; // v2 is owner-only; non-owners fall through to v1.
  }
  const chatId = String(message.chat.id);
  const text = String(message.text || "").trim();

  if (text === "/stop") {
    return v2Payload(message, (await handleV2Stop()).reply);
  }
  if (text === "/status" || text === "/context") {
    return v2Payload(message, handleV2Status(agentHome, { ownerUserId, chatId }).reply);
  }
  if (routeUpdate(text) !== "v2") {
    return null; // not a v2 @agent message; let v1 handle it.
  }

  // §15.A: handleV2Message now returns immediately with the ack; the background
  // turn runs independently and writes its result to the v2 outbox.
  const result = await handleV2Message({ agentHome, ownerUserId, chatId, text, execFileImpl, ...v2Options });
  if (!result || !result.handled) {
    return null;
  }
  // Return only the ack; the full result comes via the outbox.
  return v2Payload(message, result.reply, { v2: result });
}

function v2Payload(message, text, extra = {}) {
  return {
    ok: true,
    payload: { method: "sendMessage", chat_id: message.chat.id, text: redactSecrets(String(text || "")) },
    reason: "v2",
    ...extra,
  };
}

export function parseTelegramUpdateJson(text) {
  try {
    return JSON.parse(String(text || ""));
  } catch {
    throw new Error("Invalid Telegram update JSON");
  }
}

// ─── Poller lock (§15.H) ──────────────────────────────────────────────────────
// Acquire a cross-process lockfile when the poll loop starts. A second poller
// process refuses with a clear error.

export function acquirePollerLock(agentHome) {
  const lockPath = agentPaths(agentHome).v2PollerLock;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const content = JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() });
  // O_CREAT | O_EXCL: fails atomically if the file already exists.
  try {
    fs.writeFileSync(lockPath, content, { flag: "wx" });
  } catch (err) {
    if (err.code === "EEXIST") {
      // Check if the owning process is still alive.
      let existing = null;
      try {
        existing = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      } catch {
        // Corrupt lock file — overwrite.
        fs.writeFileSync(lockPath, content);
        return lockPath;
      }

      const lockPid = existing?.pid;
      if (!lockPid) {
        // No PID in lock — overwrite.
        fs.writeFileSync(lockPath, content);
        return lockPath;
      }

      // Check if the owning process is still alive (works for any PID including our own).
      let alive = false;
      try {
        process.kill(lockPid, 0);
        alive = true;
      } catch (killErr) {
        // ESRCH = process does not exist (stale lock). EPERM = exists but not our process.
        alive = killErr.code === "EPERM";
      }

      if (alive) {
        throw new Error(
          `v2 poller already running (pid ${lockPid}). Stop the other bridge process before starting a new one.`
        );
      }

      // Stale lock — reclaim.
      fs.writeFileSync(lockPath, content);
    } else {
      throw err;
    }
  }
  return lockPath;
}

export function releasePollerLock(agentHome) {
  try {
    fs.unlinkSync(agentPaths(agentHome).v2PollerLock);
  } catch { /* best-effort */ }
}

// ─── v2 outbox flush (§15.A) ──────────────────────────────────────────────────
// Flush any pending background turn results to Telegram each poll cycle.

export async function sendPendingV2Outbox({ agentHome, token, request, fetchImpl }) {
  // §15.B: each poll cycle, if kill switch is on, stop all running turns.
  if (agentHome && !checkSafety(agentHome).ok) {
    await stopAllTurns();
  }

  const sent = [];
  for (const entry of latestV2Outbox(agentHome).filter((e) => e.status === "queued")) {
    let send_error = null;
    try {
      await sendTelegramMessage({
        token,
        request,
        fetchImpl,
        chatId: entry.chat_id,
        text: String(entry.text || ""),
      });
      markV2OutboxSent(agentHome, entry.id);
    } catch (error) {
      send_error = error.message;
    }
    sent.push({ id: entry.id, sent: !send_error, send_error });
  }
  return sent;
}

export async function pollTelegramOnce({
  agentHome,
  token = process.env.TELEGRAM_BOT_TOKEN,
  transport = "fetch",
  fetchImpl,
  execFileImpl,
  requestImpl,
  handleUpdateImpl = handleTelegramUpdate,
  memoryStateHome,
  runner,
  longPollSeconds = 0,
} = {}) {
  if (!token) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN");
  }
  const request = requestImpl || createTelegramRequest({ transport, fetchImpl, execFileImpl });

  // Telegram long-poll: `timeout` is how many seconds getUpdates blocks waiting
  // for a new update. Defaults to 0 (return immediately) so existing single-shot
  // commands/tests are unchanged; the bridge passes ~25 for near-realtime receipt.
  const pollTimeout = Math.max(0, Number(longPollSeconds) || 0);
  const state = readTelegramState(agentHome);
  const updates = await request({
    token,
    method: "getUpdates",
    body: {
      timeout: pollTimeout,
      allowed_updates: ["message", "callback_query"],
      ...(state.next_offset === null ? {} : { offset: state.next_offset }),
    },
    fetchImpl,
  });

  const handled = [];
  let nextOffset = state.next_offset;
  for (const update of updates) {
    const result = await handleUpdateImpl({ agentHome, update, memoryStateHome, runner, execFileImpl });
    let sent = false;
    let send_error = null;
    if (result.payload) {
      try {
        await sendTelegramPayload({ token, request, payload: result.payload, fetchImpl });
        sent = true;
      } catch (error) {
        send_error = error.message;
        if (result.payload.method === "sendMessage") {
          try {
            queueTelegramOutboxPayload(agentHome, update?.update_id, result.payload);
          } catch (queueError) {
            send_error = `${send_error}; outbox skipped: ${queueError.message}`;
          }
        }
      }
    }
    if (Number.isInteger(update?.update_id)) {
      nextOffset = Math.max(nextOffset ?? 0, update.update_id + 1);
      writeTelegramState(agentHome, { next_offset: nextOffset });
    }
    handled.push({
      update_id: update?.update_id ?? null,
      ok: result.ok,
      sent,
      send_error,
      reason: result.reason || null,
      command: result.gateway?.command || null,
      allowed: result.gateway?.allowed ?? result.chat?.allowed ?? null,
    });
  }
  const gatewayReplies = await sendPendingTelegramOutbox({ agentHome, token, request, fetchImpl });
  const exchangeNotifications = await sendPendingExchangeNotifications({ agentHome, token, request, fetchImpl });
  const dispatchNotifications = await sendPendingDispatchNotifications({ agentHome, token, request, fetchImpl });
  // §15.A: flush v2 background turn results. Also sweeps kill switch (§15.B).
  const v2OutboxResults = await sendPendingV2Outbox({ agentHome, token, request, fetchImpl });

  return {
    updates: updates.length,
    handled,
    gateway_replies: gatewayReplies,
    exchange_notifications: exchangeNotifications,
    dispatch_notifications: dispatchNotifications,
    v2_outbox: v2OutboxResults,
    next_offset: nextOffset,
  };
}

export function createTelegramRequest({ transport = "fetch", fetchImpl, execFileImpl } = {}) {
  if (transport === "fetch") {
    return (request) => telegramFetchRequest({
      ...request,
      fetchImpl: fetchImpl === undefined ? globalThis.fetch : fetchImpl,
    });
  }
  if (transport === "curl") {
    return (request) => telegramCurlRequest({ ...request, execFileImpl: execFileImpl || execFile });
  }
  throw new Error(`Unknown Telegram transport: ${transport}`);
}

async function telegramRequest({ token, method, body, fetchImpl }) {
  return telegramFetchRequest({ token, method, body, fetchImpl });
}

async function telegramFetchRequest({ token, method, body, fetchImpl }) {
  if (!fetchImpl) {
    throw new Error("Missing fetch implementation");
  }
  let response;
  try {
    // Telegram requires the bot token in the URL path; never log this URL.
    response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(`Telegram ${method} request failed`);
  }
  if (!response?.ok) {
    throw new Error(`Telegram ${method} request failed`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Telegram ${method} response failed`);
  }
  if (!payload?.ok) {
    throw new Error(`Telegram ${method} response failed`);
  }
  return payload.result || [];
}

async function telegramCurlRequest({ token, method, body, execFileImpl }) {
  const stdout = await execCurlTelegram({ token, method, body, execFileImpl });
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new Error(`Telegram ${method} response failed`);
  }
  if (!payload?.ok) {
    throw new Error(`Telegram ${method} response failed`);
  }
  return payload.result || [];
}

function execCurlTelegram({ token, method, body, execFileImpl }) {
  return new Promise((resolve, reject) => {
    const child = execFileImpl("curl", [
      "-sS",
      "--config", "-",
    ], {
      maxBuffer: 1024 * 1024,
    }, (error, stdout) => {
      if (error) {
        reject(new Error(`Telegram ${method} request failed`));
        return;
      }
      resolve(stdout);
    });
    child.stdin.on("error", () => {});
    try {
      child.stdin.end([
        "request = POST",
        `header = ${curlConfigQuote("content-type: application/json")}`,
        `url = ${curlConfigQuote(`https://api.telegram.org/bot${token}/${method}`)}`,
        `data = ${curlConfigQuote(JSON.stringify(body))}`,
        "",
      ].join("\n"));
    } catch {
      reject(new Error(`Telegram ${method} request failed`));
    }
  });
}

function curlConfigQuote(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function readTelegramState(agentHome) {
  const filePath = agentPaths(agentHome).telegramState;
  if (!fs.existsSync(filePath)) {
    return { next_offset: null };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return {
      next_offset: Number.isInteger(parsed?.next_offset) ? parsed.next_offset : null,
    };
  } catch {
    return { next_offset: null };
  }
}

function writeTelegramState(agentHome, state) {
  const filePath = agentPaths(agentHome).telegramState;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

function queueTelegramOutboxPayload(agentHome, updateId, payload) {
  const text = String(payload.text || "");
  if (!text.trim() || scanSecrets(text).length > 0) {
    throw new Error("Telegram gateway reply is empty or may contain a secret");
  }
  const id = `gateway_reply_${Number.isInteger(updateId) ? updateId : shortHash(`${payload.chat_id}:${text}`)}`;
  appendJsonl(agentPaths(agentHome).telegramOutbox, {
    id,
    update_id: Number.isInteger(updateId) ? updateId : null,
    method: "sendMessage",
    chat_id: String(payload.chat_id),
    text,
    ...(payload.reply_markup ? { reply_markup: payload.reply_markup } : {}),
    status: "queued",
    created_at: new Date().toISOString(),
  });
}

async function sendPendingTelegramOutbox({ agentHome, token, request, fetchImpl }) {
  const sent = [];
  for (const entry of latestTelegramOutbox(agentHome).filter((item) => item.status === "queued")) {
    let send_error = null;
    try {
      await sendTelegramMessage({
        token,
        request,
        fetchImpl,
        chatId: entry.chat_id,
        text: entry.text,
        replyMarkup: entry.reply_markup,
      });
      appendJsonl(agentPaths(agentHome).telegramOutbox, {
        id: entry.id,
        status: "sent",
        sent_at: new Date().toISOString(),
      });
    } catch (error) {
      send_error = error.message;
    }
    sent.push({ id: entry.id, sent: !send_error, send_error });
  }
  return sent;
}

function latestTelegramOutbox(agentHome) {
  const latest = new Map();
  for (const entry of readJsonl(agentPaths(agentHome).telegramOutbox)) {
    if (entry.id) {
      latest.set(entry.id, { ...(latest.get(entry.id) || {}), ...entry });
    }
  }
  return Array.from(latest.values());
}

export async function sendPendingExchangeNotifications({ agentHome, token, request, fetchImpl }) {
  const policy = getTelegramCodexPolicy(agentHome);
  if (!policy.exchange_notify_enabled || !policy.exchange_notify_chat_id) {
    return [];
  }
  const paths = agentPaths(agentHome);
  const messagesById = new Map(readJsonl(paths.exchangeMessages).map((message) => [message.id, message]));
  const notified = new Set(readJsonl(paths.exchangeNotifications).map((entry) => entry.reply_id).filter(Boolean));
  const sent = [];
  const max = Math.max(1, Number(policy.exchange_notify_max_per_cycle) || 1);

  for (const reply of readJsonl(paths.exchangeReplies)) {
    if (sent.length >= max || notified.has(reply.id)) {
      continue;
    }
    const message = messagesById.get(reply.message_id);
    if (!message || (message.channel !== "telegram" && message.channel !== DISPATCH_CHANNEL) || message.from !== "codex") {
      continue;
    }
    if (scanSecrets(String(reply.text || "")).length > 0) {
      const withheld = `${titleCaseAgent(reply.agent_id)} reply withheld — it may contain a secret (msg ${message.id}, reply ${reply.id}).`;
      try {
        await request({ token, method: "sendMessage", body: { chat_id: policy.exchange_notify_chat_id, text: withheld }, fetchImpl });
      } catch (error) {
        sent.push({ reply_id: reply.id, message_id: message.id, sent: false, send_error: error.message });
        continue;
      }
    } else {
      const chunks = formatExchangeNotification({ reply });
      let sendError = null;
      for (const chunk of chunks) {
        try {
          await request({ token, method: "sendMessage", body: { chat_id: policy.exchange_notify_chat_id, text: chunk }, fetchImpl });
        } catch (error) {
          sendError = error.message;
          break;
        }
      }
      if (sendError) {
        sent.push({ reply_id: reply.id, message_id: message.id, sent: false, send_error: sendError });
        continue;
      }
    }
    appendJsonl(paths.exchangeNotifications, {
      reply_id: reply.id,
      message_id: message.id,
      chat_id: String(policy.exchange_notify_chat_id),
      status: "sent",
      created_at: new Date().toISOString(),
    });
    sent.push({ reply_id: reply.id, message_id: message.id, sent: true });
  }
  return sent;
}

export async function sendPendingDispatchNotifications({ agentHome, token, request, fetchImpl }) {
  const sent = [];
  for (const approval of listPendingDispatchNotifications(agentHome)) {
    let send_error = null;
    try {
      await sendTelegramMessage({
        token,
        request,
        fetchImpl,
        chatId: approval.chat_id,
        text: dispatchApprovalNotice(approval),
        replyMarkup: dispatchApprovalMarkup(approval.id),
      });
      markDispatchApprovalNotified(agentHome, approval.id);
    } catch (error) {
      send_error = error.message;
    }
    sent.push({ id: approval.id, sent: !send_error, send_error });
  }
  return sent;
}

const TELEGRAM_MAX_CHARS = 3800;

async function sendTelegramPayload({ token, request, payload, fetchImpl }) {
  const body = payload.body || {
    chat_id: payload.chat_id,
    text: payload.text,
    ...(payload.reply_markup ? { reply_markup: payload.reply_markup } : {}),
  };
  if (payload.method !== "sendMessage") {
    await request({ token, method: payload.method, body, fetchImpl });
    return;
  }
  await sendTelegramMessage({
    token,
    request,
    fetchImpl,
    chatId: body.chat_id,
    text: body.text,
    replyMarkup: body.reply_markup,
  });
}

async function sendTelegramMessage({ token, request, fetchImpl, chatId, text, replyMarkup }) {
  const chunks = splitForTelegram(String(text || ""), TELEGRAM_MAX_CHARS);
  for (const [index, chunk] of chunks.entries()) {
    await request({
      token,
      method: "sendMessage",
      body: {
        chat_id: chatId,
        text: chunk,
        ...(index === 0 && replyMarkup ? { reply_markup: replyMarkup } : {}),
      },
      fetchImpl,
    });
  }
}

// Returns an array of Telegram messages: first has the "Opus:" header, rest
// are plain continuations. Splits at paragraph → line → word boundaries to
// avoid cutting mid-sentence. No truncation — full reply is always delivered.
function formatExchangeNotification({ reply }) {
  // Display cleanup only; approval creation happens in the runner reply path.
  const parsed = parseDispatchProposal(reply.text);
  const full = String(parsed.valid ? parsed.displayText : reply.text || "").trim();
  const header = `${titleCaseAgent(reply.agent_id)}:`;
  const first = `${header}\n${full}`;
  if (first.length <= TELEGRAM_MAX_CHARS) {
    return [first];
  }
  const chunks = splitForTelegram(full, TELEGRAM_MAX_CHARS - header.length - 1);
  return chunks.map((chunk, i) => (i === 0 ? `${header}\n${chunk}` : chunk));
}

function splitForTelegram(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxChars) { chunks.push(remaining); break; }
    let at = remaining.lastIndexOf("\n\n", maxChars);
    if (at < maxChars * 0.4) at = remaining.lastIndexOf("\n", maxChars);
    if (at < maxChars * 0.4) at = remaining.lastIndexOf(" ", maxChars);
    if (at <= 0) at = maxChars;
    chunks.push(remaining.slice(0, at).trimEnd());
    remaining = remaining.slice(at).trimStart();
  }
  return chunks;
}

function titleCaseAgent(agent) {
  const name = String(agent || "agent");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function shortLine(text, maxChars) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  const max = Math.max(1, Number(maxChars) || 1);
  return raw.length > max ? `${raw.slice(0, Math.max(0, max - 3))}...` : raw;
}

function extractMessage(update) {
  const message = update?.message;
  if (!message?.text || !message?.chat?.id || !message?.from?.id) {
    return null;
  }
  return message;
}

function extractCallbackQuery(update) {
  const callback = update?.callback_query;
  if (!callback?.id || !callback?.from?.id || !callback?.data) {
    return null;
  }
  return callback;
}

function handleTelegramCallback({ agentHome, callback }) {
  const parsed = parseTelegramCallbackData(callback.data);
  const policy = getTelegramCodexPolicy(agentHome);
  const allowedOwner = isPolicyOwner(policy, callback.from.id);
  if (!parsed || !allowedOwner) {
    appendCallbackAudit({
      agentHome,
      callback,
      parsed,
      allowed: allowedOwner,
      ok: false,
      reason: parsed ? "callback_not_allowed" : "callback_invalid",
    });
    return {
      ok: false,
      payload: {
        method: "answerCallbackQuery",
        body: {
          callback_query_id: callback.id,
          text: parsed ? "Not allowed." : "Invalid action.",
          show_alert: false,
        },
      },
      reason: parsed ? "callback_not_allowed" : "callback_invalid",
    };
  }
  const message = callback.message;
  const chatId = message?.chat?.id;
  if (!chatId) {
    appendCallbackAudit({
      agentHome,
      callback,
      parsed,
      allowed: true,
      ok: false,
      reason: "callback_missing_chat",
    });
    return {
      ok: false,
      payload: {
        method: "answerCallbackQuery",
        body: {
          callback_query_id: callback.id,
          text: "Missing chat.",
          show_alert: false,
        },
      },
      reason: "callback_missing_chat",
    };
  }
  let notice = parsed.action === "approve" ? "無法核准這個派工。" : "無法拒絕這個派工。";
  let ok = false;
  try {
    if (parsed.action === "approve") {
      const result = approveDispatch({
        agentHome,
        id: parsed.dispatchId,
        approvedBy: "owner",
        defaultRepo: policy.default_repo,
      });
      notice = dispatchApproveNotice(result);
    } else {
      const result = rejectDispatch({ agentHome, id: parsed.dispatchId, rejectedBy: "owner" });
      notice = dispatchRejectNotice(result.approval);
    }
    ok = true;
  } catch {
    // keep failure notice
  }
  return {
    ok,
    payload: {
      method: "answerCallbackQuery",
      body: {
        callback_query_id: callback.id,
        text: notice,
        show_alert: false,
      },
    },
    reason: `dispatch_${parsed.action}`,
  };
}

function appendCallbackAudit({ agentHome, callback, parsed, allowed, ok, reason }) {
  appendJsonl(agentPaths(agentHome).gatewayAudit, {
    user_id: String(callback.from?.id || ""),
    text_hash: shortHash(String(callback.data || "")),
    command: "owner_callback",
    allowed,
    ok,
    dispatch_id: parsed?.dispatchId || null,
    reason,
    created_at: new Date().toISOString(),
  });
}

function parseTelegramCallbackData(data) {
  const dispatch = String(data || "").match(/^dispatch:(approve|reject):(dispatch_[A-Za-z0-9_-]+)$/);
  if (dispatch) {
    return { kind: "dispatch", action: dispatch[1], dispatchId: dispatch[2] };
  }
  return null;
}

function isGatewayText(text, agentHome) {
  const trimmed = String(text || "").trim();
  return trimmed === "status" || trimmed.startsWith("agent ") || isGatewayShortcutText(trimmed, agentHome);
}

function isPolicyOwner(policy, userId) {
  const id = String(userId || "");
  return Array.isArray(policy.direct_send_user_allowlist) && policy.direct_send_user_allowlist.includes(id);
}

function isGatewayShortcutText(text, agentHome) {
  const mention = text.match(/^@([a-z][a-z0-9_-]*)\s+\S/);
  if (mention) {
    return isShortcutAgentName(mention[1], agentHome);
  }
  const colon = text.match(/^([a-z][a-z0-9_-]*):\s*\S/);
  if (!colon) {
    return false;
  }
  return isShortcutAgentName(colon[1], agentHome);
}

function isShortcutAgentName(agent, agentHome) {
  const id = agent === "claude" ? "opus" : agent;
  return id === "codex" || id === "opus" || isExchangeAgentEnabled(agentHome, id);
}
