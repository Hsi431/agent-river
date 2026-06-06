import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { shortHash } from "../lib/hash.js";
import { appendJsonl, readJsonl } from "../lib/jsonl.js";
import { scanSecrets } from "../lib/secret-scan.js";
import { enqueueChatMessage, listPendingChatReplies, markChatReplySent } from "./chat.js";
import { handleGatewayMessage } from "./gateway.js";
import { agentPaths } from "./paths.js";
import { getSafetyStatus, getTelegramCodexPolicy, isExchangeAgentEnabled, setTelegramCodexPolicy } from "./safety.js";
import { isOwner, ownerTaskReplyMarkup } from "./owner-mode.js";
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
import { queueChatReply } from "./chat.js";

export async function handleTelegramUpdate({ agentHome, update, memoryStateHome, runner, execFileImpl }) {
  const callback = extractCallbackQuery(update);
  if (callback) {
    return handleTelegramCallback({ agentHome, callback });
  }

  const message = extractMessage(update);
  if (!message) {
    return { ok: false, payload: null, reason: "unsupported_update" };
  }

  if (!isGatewayText(message.text, agentHome)) {
    const chat = enqueueChatMessage({
      agentHome,
      channel: "telegram",
      userId: String(message.from.id),
      chatId: String(message.chat.id),
      text: message.text,
    });
    return {
      ok: chat.allowed,
      chat,
      payload: chat.allowed
        ? null
        : { method: "sendMessage", chat_id: message.chat.id, text: "Access denied." },
      reason: chat.allowed ? "chat_queued" : "access_denied",
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
      ...(gateway.command === "agent_models" && isOwner({ user_id: String(message.from.id) }, getTelegramCodexPolicy(agentHome))
        ? { reply_markup: modelControlsMarkup() }
        : {}),
      ...(gateway.reply_markup ? { reply_markup: gateway.reply_markup } : {}),
    },
  };
}

export function parseTelegramUpdateJson(text) {
  try {
    return JSON.parse(String(text || ""));
  } catch {
    throw new Error("Invalid Telegram update JSON");
  }
}

export async function pollTelegramOnce({
  agentHome,
  token = process.env.TELEGRAM_BOT_TOKEN,
  transport = "fetch",
  fetchImpl,
  execFileImpl,
  requestImpl,
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
    const result = await handleTelegramUpdate({ agentHome, update, memoryStateHome, runner, execFileImpl });
    if (Number.isInteger(update?.update_id)) {
      nextOffset = Math.max(nextOffset ?? 0, update.update_id + 1);
      writeTelegramState(agentHome, { next_offset: nextOffset });
    }
    let sent = false;
    let send_error = null;
    if (result.payload) {
      try {
        await sendTelegramPayload({ token, request, payload: result.payload, fetchImpl });
        sent = true;
      } catch (error) {
        send_error = error.message;
      }
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
  const replies = await sendPendingTelegramReplies({ agentHome, token, request, fetchImpl });
  const exchangeNotifications = await sendPendingExchangeNotifications({ agentHome, token, request, fetchImpl });
  const dispatchNotifications = await sendPendingDispatchNotifications({ agentHome, token, request, fetchImpl });

  return { updates: updates.length, handled, replies, exchange_notifications: exchangeNotifications, dispatch_notifications: dispatchNotifications, next_offset: nextOffset };
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

async function sendPendingTelegramReplies({ agentHome, token, request, fetchImpl }) {
  const replies = [];
  for (const reply of listPendingChatReplies(agentHome, { channel: "telegram" })) {
    let sent = false;
    let send_error = null;
    try {
      await sendTelegramMessage({
        token,
        request,
        fetchImpl,
        chatId: reply.chat_id,
        text: reply.text,
        replyMarkup: reply.reply_markup,
      });
      markChatReplySent(agentHome, reply.id);
      sent = true;
    } catch (error) {
      send_error = error.message;
    }
    replies.push({ id: reply.id, sent, send_error });
  }
  return replies;
}

async function sendPendingExchangeNotifications({ agentHome, token, request, fetchImpl }) {
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

async function sendPendingDispatchNotifications({ agentHome, token, request, fetchImpl }) {
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
  const parsed = parseOwnerCallbackData(callback.data);
  const policy = getTelegramCodexPolicy(agentHome);
  const inboxLike = { user_id: String(callback.from.id) };
  const allowedOwner = isOwner(inboxLike, policy);
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
  if (parsed.kind === "dispatch") {
    let notice = parsed.action === "approve" ? "無法核准這個派工。" : "無法拒絕這個派工。";
    let ok = false;
    let replyMarkup = null;
    try {
      if (parsed.action === "approve") {
        const result = approveDispatch({
          agentHome,
          id: parsed.dispatchId,
          approvedBy: "owner",
          defaultRepo: policy.default_repo,
        });
        notice = dispatchApproveNotice(result);
        if (result.outcome?.type === "task") {
          replyMarkup = ownerTaskReplyMarkup(result.outcome.id);
        }
      } else {
        const result = rejectDispatch({ agentHome, id: parsed.dispatchId, rejectedBy: "owner" });
        notice = dispatchRejectNotice(result.approval);
      }
      ok = true;
    } catch {
      // keep failure notice
    }
    const chat = enqueueChatMessage({
      agentHome,
      channel: "telegram",
      userId: String(callback.from.id),
      chatId: String(chatId),
      text: `dispatch-${parsed.action} ${parsed.dispatchId}`,
    });
    if (chat.allowed) {
      queueChatReply({ agentHome, inboxId: chat.id, text: notice, source: "dispatch", replyMarkup });
    }
    return {
      ok: chat.allowed && ok,
      chat,
      payload: {
        method: "answerCallbackQuery",
        body: {
          callback_query_id: callback.id,
          text: chat.allowed ? "Received." : "Access denied.",
          show_alert: false,
        },
      },
      reason: chat.allowed ? `dispatch_${parsed.action}` : "access_denied",
    };
  }
  if (parsed.kind === "model") {
    let notice = "無法更新模型設定。";
    try {
      if (parsed.agent === "claude") {
        setTelegramCodexPolicy(agentHome, { exchange_runner_model: parsed.model === "default" ? "" : parsed.model });
      } else {
        setTelegramCodexPolicy(agentHome, { codex_runner_model: parsed.model === "default" ? "" : parsed.model });
      }
      notice = `已更新模型設定。\n${formatTelegramModelStatus(agentHome)}`;
    } catch {
      // keep failure notice
    }
    const chat = enqueueChatMessage({
      agentHome,
      channel: "telegram",
      userId: String(callback.from.id),
      chatId: String(chatId),
      text: `model-${parsed.agent} ${parsed.model}`,
    });
    if (chat.allowed) {
      queueChatReply({ agentHome, inboxId: chat.id, text: notice, source: "model_control" });
    }
    return {
      ok: chat.allowed,
      chat,
      payload: {
        method: "answerCallbackQuery",
        body: {
          callback_query_id: callback.id,
          text: chat.allowed ? "Received." : "Access denied.",
          show_alert: false,
        },
      },
      reason: chat.allowed ? "model_callback" : "access_denied",
    };
  }

  const chat = enqueueChatMessage({
    agentHome,
    channel: "telegram",
    userId: String(callback.from.id),
    chatId: String(chatId),
    text: parsed.kind === "reply_approval"
      ? `reply-${parsed.action} ${parsed.approvalId}`
      : `${parsed.action} ${parsed.taskId}`,
  });
  return {
    ok: chat.allowed,
    chat,
    payload: {
      method: "answerCallbackQuery",
      body: {
        callback_query_id: callback.id,
        text: chat.allowed ? "Received." : "Access denied.",
        show_alert: false,
      },
    },
    reason: chat.allowed ? "callback_queued" : "access_denied",
  };
}

function appendCallbackAudit({ agentHome, callback, parsed, allowed, ok, reason }) {
  appendJsonl(agentPaths(agentHome).gatewayAudit, {
    user_id: String(callback.from?.id || ""),
    text_hash: shortHash(String(callback.data || "")),
    command: "owner_callback",
    allowed,
    ok,
    task_id: parsed?.taskId || null,
    approval_id: parsed?.approvalId || null,
    dispatch_id: parsed?.dispatchId || null,
    reason,
    created_at: new Date().toISOString(),
  });
}

function parseOwnerCallbackData(data) {
  const task = String(data || "").match(/^owner:(approve|reject|status):(task_[A-Za-z0-9_-]+)$/);
  if (task) {
    return { kind: "task", action: task[1], taskId: task[2] };
  }
  const reply = String(data || "").match(/^owner_reply:(approve|reject):(approval_[A-Za-z0-9_-]+)$/);
  if (reply) {
    return { kind: "reply_approval", action: reply[1], approvalId: reply[2] };
  }
  const dispatch = String(data || "").match(/^dispatch:(approve|reject):(dispatch_[A-Za-z0-9_-]+)$/);
  if (dispatch) {
    return { kind: "dispatch", action: dispatch[1], dispatchId: dispatch[2] };
  }
  const model = String(data || "").match(/^model:(claude|opus|codex):([A-Za-z0-9][A-Za-z0-9._:/-]*|default)$/);
  if (model) {
    return { kind: "model", agent: model[1] === "opus" ? "claude" : model[1], model: model[2] };
  }
  return null;
}

function modelControlsMarkup() {
  return {
    inline_keyboard: [
      [
        { text: "Claude Default", callback_data: "model:claude:default" },
        { text: "Sonnet 4.6", callback_data: "model:claude:sonnet" },
        { text: "Opus 4.8", callback_data: "model:claude:opus" },
      ],
      [
        { text: "Codex Default", callback_data: "model:codex:default" },
        { text: "GPT-5.5", callback_data: "model:codex:gpt-5.5" },
      ],
      [
        { text: "GPT-5.4", callback_data: "model:codex:gpt-5.4" },
        { text: "GPT-5.4 mini", callback_data: "model:codex:gpt-5.4-mini" },
      ],
    ],
  };
}

function formatTelegramModelStatus(agentHome) {
  const policy = getTelegramCodexPolicy(agentHome);
  const status = getSafetyStatus(agentHome);
  const budget = status.config.daily_token_budget;
  const budgetText = budget === Number.MAX_SAFE_INTEGER ? "disabled" : String(budget);
  const remainingText = budget === Number.MAX_SAFE_INTEGER ? "n/a" : String(status.today.remaining_tokens);
  return [
    "Local accounting only; not official account usage.",
    `claude_model=${policy.exchange_runner_model || "default"} (${claudeModelLabel(policy.exchange_runner_model)})`,
    `codex_model=${policy.codex_runner_model || "default"}${policy.codex_runner_model ? "" : " (effective=gpt-5.5)"}`,
    `local_tokens_today=${status.today.tokens}`,
    `local_budget=${budgetText}`,
    `local_remaining=${remainingText}`,
  ].join("\n");
}

function claudeModelLabel(model) {
  if (model === "sonnet") return "Sonnet 4.6";
  if (model === "opus") return "Opus 4.8";
  return "Claude Code default";
}

function isGatewayText(text, agentHome) {
  const trimmed = String(text || "").trim();
  return trimmed === "status" || trimmed.startsWith("agent ") || isGatewayShortcutText(trimmed, agentHome);
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
