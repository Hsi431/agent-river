import fs from "node:fs";
import path from "node:path";
import { appendJsonl, readJsonl } from "../lib/jsonl.js";
import { shortHash } from "../lib/hash.js";
import { agentPaths } from "./paths.js";

export function createTask({
  agentHome,
  repo,
  request,
  mode = "plan",
  source = "cli",
  requester = "local",
  approval = "not_required",
  executor = "codex",
  chatId = null,
  userId = null,
  parentTaskId = null,
  planSummary = null,
}) {
  if (!repo) {
    throw new Error("Missing required --repo");
  }
  if (!request) {
    throw new Error("Missing required --request");
  }
  if (mode !== "plan" && mode !== "edit") {
    throw new Error(`Unsupported task mode: ${mode}`);
  }
  if (executor !== "codex" && executor !== "opus") {
    throw new Error(`Unsupported task executor: ${executor}`);
  }
  // Edit tasks always require explicit owner approval — enforce server-side so
  // callers cannot accidentally bypass the gate. Low-risk auto-execute paths
  // must still go through an explicit approveTask() call (which is audited),
  // never bypass this.
  if (mode === "edit") {
    approval = "pending";
  }

  const now = new Date().toISOString();
  const task = {
    id: `task_${Date.now()}_${shortHash(`${repo}:${request}`)}`,
    source,
    requester,
    repo: path.resolve(repo),
    request,
    mode,
    executor,
    chat_id: chatId ? String(chatId) : null,
    user_id: userId ? String(userId) : null,
    parent_task_id: parentTaskId ? String(parentTaskId) : null,
    plan_summary: planSummary ? String(planSummary) : null,
    status: "queued",
    approval,
    worktree: null,
    attempts: 0,
    max_attempts: 2,
    cost: { tokens: 0, usd_estimate: 0 },
    created_at: now,
    updated_at: now,
    history: [{
      ts: now,
      state: "queued",
      note: "Task submitted.",
      codex_session: null,
    }],
    result: {
      summary: null,
      diff_ref: null,
      tests: null,
      artifacts: [],
    },
  };

  writeTask(agentHome, task);
  return task;
}

export function listTasks(agentHome) {
  const { tasksDir } = agentPaths(agentHome);
  if (!fs.existsSync(tasksDir)) {
    return [];
  }
  return fs.readdirSync(tasksDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => readTask(agentHome, path.basename(name, ".json")))
    .filter(Boolean);
}

export function readTask(agentHome, id) {
  if (!id) {
    return null;
  }
  const filePath = taskPath(agentHome, id);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writeTask(agentHome, task) {
  const filePath = taskPath(agentHome, task.id);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(task, null, 2)}\n`);
}

export function transitionTask(agentHome, task, status, note, { codexSession = null, patch = {} } = {}) {
  const now = new Date().toISOString();
  const next = {
    ...task,
    ...patch,
    status,
    updated_at: now,
    history: [
      ...task.history,
      { ts: now, state: status, note, codex_session: codexSession },
    ],
  };
  writeTask(agentHome, next);
  return next;
}

export function recordTaskEvent(agentHome, task, note, { codexSession = null, patch = {} } = {}) {
  return transitionTask(agentHome, task, task.status, note, { codexSession, patch });
}

export function approveTask(agentHome, id) {
  const task = requireTask(agentHome, id);
  if (task.approval === "approved") {
    return task;
  }
  if (task.status !== "queued" || task.approval !== "pending") {
    throw new Error(`Task is not pending approval: ${id}`);
  }
  return recordTaskEvent(agentHome, task, "Task approved.", {
    patch: { approval: "approved" },
  });
}

export function rejectTask(agentHome, id) {
  const task = requireTask(agentHome, id);
  if (task.approval === "rejected") {
    return task;
  }
  if (task.status !== "queued" || task.approval !== "pending") {
    throw new Error(`Task is not pending approval: ${id}`);
  }
  return transitionTask(agentHome, task, "failed", "Task rejected.", {
    patch: { approval: "rejected" },
  });
}

export function appendRun(agentHome, run) {
  appendJsonl(agentPaths(agentHome).runs, {
    run_id: `run_${Date.now()}_${shortHash(`${run.task_id}:${run.step}`)}`,
    ...run,
  });
}

export function readRuns(agentHome) {
  return readJsonl(agentPaths(agentHome).runs);
}

function taskPath(agentHome, id) {
  return path.join(agentPaths(agentHome).tasksDir, `${id}.json`);
}

function requireTask(agentHome, id) {
  const task = readTask(agentHome, id);
  if (!task) {
    throw new Error(`Task not found: ${id}`);
  }
  return task;
}
