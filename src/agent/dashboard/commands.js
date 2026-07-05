import { shortHash } from "../../lib/hash.js";
import { redactSecrets } from "../../lib/secret-scan.js";
import { listRegisteredAgents } from "../registry.js";
import { getTelegramCodexPolicy, setTelegramCodexPolicy } from "../safety.js";
import { killSession, listActiveSessions, openSession } from "../sessions.js";

const DASHBOARD_HINT = "這是 v3 看板,指令:/session /sessions /kill /agents /model";
const SESSION_USAGE = "用法:/session <a,b[,c]> [repo=<名>] [budget=<N>/<M>] [write=<agent>] -- <題目>";

export async function handleDashboardCommand({ agentHome, text, execFileImpl } = {}) {
  const raw = String(text || "").trim();
  if (raw.startsWith("/session ")) {
    try {
      const parsed = parseSessionCommand(raw);
      const session = await openSession({
        agentHome,
        initiator: "owner",
        participants: parsed.participants,
        repo: parsed.repo,
        budgetMessages: parsed.budgetMessages,
        budgetMinutes: parsed.budgetMinutes,
        writeAccess: parsed.writeAccess,
        topic: parsed.topic,
        execFileImpl,
      });
      return `session #${shortSession(session.session_id)} 開場(${session.participants.join(",")}/預算 ${session.budget.max_messages}/${session.budget.max_minutes}${session.repo ? `/repo ${session.repo}` : ""})`;
    } catch (error) {
      const line = describeSessionError(error);
      return line ? `${line}\n${SESSION_USAGE}` : SESSION_USAGE;
    }
  }
  if (raw === "/model" || raw.startsWith("/model ")) {
    return handleModelCommand(agentHome, raw);
  }
  if (raw === "/sessions") {
    const sessions = listActiveSessions(agentHome);
    if (sessions.length === 0) {
      return "目前沒有 active session";
    }
    return sessions.map((session) => `#${shortSession(session.session_id)} ${session.participants.join(",")} ${session.messages_used}/${session.budget.max_messages} ${shortLine(session.topic, 60)}`).join("\n");
  }
  if (raw.startsWith("/kill ")) {
    const id = raw.slice("/kill ".length).trim();
    if (!id) {
      return "用法:/kill <id或短碼>";
    }
    const found = resolveSessionId(agentHome, id);
    if (!found) {
      return "找不到 session";
    }
    const session = killSession({ agentHome, id: found.session_id });
    return `session #${shortSession(session.session_id)} killed`;
  }
  if (raw === "/agents") {
    const registry = listRegisteredAgents(agentHome);
    if (!registry.length) {
      return "尚無註冊 agent";
    }
    return registry.map((agent) => `${agent.name} ${agent.status || "unknown"}`).join("\n");
  }
  return DASHBOARD_HINT;
}

export function isDashboardOwner(agentHome, userId) {
  const id = String(userId || "");
  const policy = getTelegramCodexPolicy(agentHome);
  return Array.isArray(policy.direct_send_user_allowlist) && policy.direct_send_user_allowlist.includes(id);
}

export function dashboardHint() {
  return DASHBOARD_HINT;
}

function parseSessionCommand(raw) {
  const sep = raw.indexOf(" -- ");
  if (sep === -1) {
    throw new Error("missing_topic_separator");
  }
  const head = raw.slice("/session ".length, sep).trim();
  const topic = raw.slice(sep + 4).trim();
  const parts = head.split(/\s+/).filter(Boolean);
  const participants = parts.shift();
  if (!participants) {
    throw new Error("missing_participants");
  }
  const out = { participants, repo: null, budgetMessages: undefined, budgetMinutes: undefined, writeAccess: undefined, topic };
  for (const item of parts) {
    const [key, ...rest] = item.split("=");
    const value = rest.join("=");
    if (!key || !value) {
      throw new Error("bad_option");
    }
    if (key === "repo") {
      out.repo = value;
    } else if (key === "write") {
      out.writeAccess = value;
    } else if (key === "budget") {
      const match = value.match(/^(\d+)(?:封)?\/(\d+)(?:分)?$/);
      if (!match) {
        throw commandError("budget_format", "Bad budget format", { value });
      }
      out.budgetMessages = match[1];
      out.budgetMinutes = match[2];
    } else {
      throw new Error("bad_option");
    }
  }
  return out;
}

function handleModelCommand(agentHome, raw) {
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    const policy = getTelegramCodexPolicy(agentHome);
    return [
      `opus runner: ${policy.exchange_runner_model}`,
      `codex runner: ${policy.codex_runner_model || "(codex CLI 預設)"}`,
    ].join("\n");
  }
  if (parts.length !== 3 || !["opus", "codex"].includes(parts[1])) {
    return "用法:/model [opus|codex <值>]";
  }
  const target = parts[1];
  const value = parts[2] === "default" ? "" : parts[2];
  try {
    const policy = setTelegramCodexPolicy(agentHome, target === "opus"
      ? { exchange_runner_model: value }
      : { codex_runner_model: value });
    if (target === "opus") {
      return `opus runner 已設為 ${policy.telegram_codex_policy.exchange_runner_model || "(Claude Code 預設)"}`;
    }
    return `codex runner 已設為 ${policy.telegram_codex_policy.codex_runner_model || "(codex CLI 預設)"}`;
  } catch (error) {
    return `設定失敗:${error?.message || "未知錯誤"}`;
  }
}

function describeSessionError(error) {
  const details = error?.details || {};
  if (error?.code === "topic_length") {
    const length = Number(details.length) || 0;
    const min = Number(details.min) || 0;
    const max = Number(details.max) || 0;
    const label = String(details.initiator || "").startsWith("agent:") ? "agent 發起" : "owner 開場";
    if (length < min) {
      return `題目太短:${length} 字,${label}至少 ${min} 字`;
    }
    return `題目太長:${length} 字,最多 ${max} 字`;
  }
  if (error?.code === "participant_not_registered") {
    const allowed = Array.isArray(details.allowed) && details.allowed.length ? details.allowed.join(",") : "(無)";
    return `參與者 ${details.participant || ""} 未註冊,現有:${allowed}`;
  }
  if (error?.code === "budget_format") {
    return `預算格式錯誤:${details.value || ""},請用 N/M`;
  }
  if (error?.code === "repo_resolve_failed") {
    return `repo 解析失敗:${details.repo || ""},原因:${repoReasonText(details.reason)}`;
  }
  return null;
}

function repoReasonText(reason) {
  return ({
    missing_workspace_root: "未設定 workspace_root/default_repo",
    invalid_input: "格式必須是 repo=<名> 或絕對路徑",
    repo_not_found: "找不到 repo",
    repo_access_denied: "不是可存取的 git repo",
    repo_outside_workspace: "超出 workspace_root",
  })[reason] || String(reason || "未知");
}

function commandError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function resolveSessionId(agentHome, input) {
  const raw = String(input || "").trim();
  return listActiveSessions(agentHome).find((session) => session.session_id === raw || shortSession(session.session_id) === raw) || null;
}

function shortSession(id) {
  return shortHash(String(id || "")).slice(0, 6);
}

function shortLine(text, maxChars) {
  const raw = redactSecrets(String(text || "").replace(/\s+/g, " ").trim());
  return raw.length > maxChars ? `${raw.slice(0, Math.max(0, maxChars - 3))}...` : raw;
}
