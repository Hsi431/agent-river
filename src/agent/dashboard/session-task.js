import { readJsonl } from "../../lib/jsonl.js";
import { shortHash } from "../../lib/hash.js";
import { agentPaths } from "../paths.js";
import { submitAgentTask } from "../orchestrator.js";
import { getSession } from "../sessions.js";
import { getTelegramCodexPolicy } from "../safety.js";
import { listTasks } from "../tasks.js";
import { resolveRepo } from "../v2/repo-resolver.js";
import { lastSessionMail, writeSessionTranscript } from "./feed.js";

export async function submitSessionEditTask({ agentHome, sessionId, repo = null, execFileImpl, chatId = null, requester = "owner" } = {}) {
  const session = getSession(agentHome, sessionId);
  if (!session) {
    return { ok: false, reason: "session_not_found", text: "找不到 session" };
  }
  let taskRepo = session.repo || null;
  if (repo) {
    taskRepo = await resolveSessionRepo({ agentHome, repo, execFileImpl });
  }
  if (!taskRepo) {
    return {
      ok: false,
      reason: "missing_repo",
      text: `這場沒綁 repo,用 /task ${session.session_id} repo=<名> 指定`,
    };
  }
  const previous = findPreviousSessionTask(agentHome, session.session_id);
  const transcript = writeSessionTranscript(agentHome, session.session_id);
  const last = lastSessionMail(agentHome, session.session_id);
  const task = submitAgentTask({
    agentHome,
    repo: taskRepo,
    request: sessionTaskRequest({ session, lastText: last?.text || "", transcriptPath: transcript.path }),
    mode: "edit",
    executor: "codex",
    chatId,
    source: "session",
    requester,
  });
  return {
    ok: true,
    task,
    previousTaskId: previous?.id || null,
    text: previous
      ? `已建立 edit task ${task.id}\n注意:此 session 已轉過 ${previous.id}`
      : `已建立 edit task ${task.id}`,
  };
}

export function resolveAnySessionId(agentHome, input) {
  const raw = String(input || "").trim();
  return readJsonl(agentPaths(agentHome).sessions)
    .filter((row) => row.event === "session_opened" && row.session_id)
    .find((row) => row.session_id === raw || shortSession(row.session_id) === raw) || null;
}

function sessionTaskRequest({ session, lastText, transcriptPath }) {
  return [
    `session topic:\n${session.topic || ""}`,
    "",
    "結論(最後一封信):",
    lastText || "",
    "",
    `完整逐字稿:${transcriptPath}`,
    `[session:${session.session_id}]`,
  ].join("\n");
}

function findPreviousSessionTask(agentHome, sessionId) {
  const marker = `[session:${sessionId}]`;
  return listTasks(agentHome)
    .filter((task) => String(task.request || "").includes(marker))
    .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")))
    .at(-1) || null;
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
    const error = new Error(`Session repo could not be resolved: ${raw}`);
    error.code = "repo_resolve_failed";
    error.details = {
      repo: raw,
      reason: resolved.reason,
    };
    throw error;
  }
  return resolved.toplevel;
}

function shortSession(id) {
  return shortHash(String(id || "")).slice(0, 6);
}
