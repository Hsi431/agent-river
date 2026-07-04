import fs from "node:fs";
import { shortHash } from "../../lib/hash.js";
import { redactSecrets } from "../../lib/secret-scan.js";
import { agentPaths } from "../paths.js";
import { getTelegramCodexPolicy } from "../safety.js";
import { killSession, listActiveSessions, openSession } from "../sessions.js";

const DASHBOARD_HINT = "這是 v3 看板,指令:/session /sessions /kill /agents";
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
    } catch {
      return SESSION_USAGE;
    }
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
    const registry = readAgentRegistry(agentHome);
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
        throw new Error("bad_budget");
      }
      out.budgetMessages = match[1];
      out.budgetMinutes = match[2];
    } else {
      throw new Error("bad_option");
    }
  }
  return out;
}

function resolveSessionId(agentHome, input) {
  const raw = String(input || "").trim();
  return listActiveSessions(agentHome).find((session) => session.session_id === raw || shortSession(session.session_id) === raw) || null;
}

function readAgentRegistry(agentHome) {
  const file = agentPaths(agentHome).agentRegistry;
  if (!file || !fs.existsSync(file)) {
    return [];
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const rows = Array.isArray(parsed) ? parsed : Object.values(parsed?.agents || {});
    return rows
      .map((item) => ({
        name: String(item?.name || item?.agent_id || "").trim(),
        status: String(item?.status || item?.state || "").trim(),
      }))
      .filter((item) => item.name);
  } catch {
    return [];
  }
}

function shortSession(id) {
  return shortHash(String(id || "")).slice(0, 6);
}

function shortLine(text, maxChars) {
  const raw = redactSecrets(String(text || "").replace(/\s+/g, " ").trim());
  return raw.length > maxChars ? `${raw.slice(0, Math.max(0, maxChars - 3))}...` : raw;
}
