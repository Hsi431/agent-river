import { execFile } from "node:child_process";
import path from "node:path";
import { formatContextBlock } from "codex-memory-river/src/context-block.js";
import { preflight } from "codex-memory-river/src/preflight.js";
import { resolveStateHome } from "codex-memory-river/src/paths.js";
import {
  appendRun,
  approveTask,
  createTask,
  listTasks,
  recordTaskEvent,
  readRuns,
  readTask,
  rejectTask,
  transitionTask,
} from "./tasks.js";
import { runEditStep, runPlanStep } from "./worker.js";
import { appendCost, checkSafety, getSafetyStatus, getTelegramCodexPolicy } from "./safety.js";
import { makeOpusEditRunner } from "./exchange-runner.js";
import { redactSecrets, scanSecrets } from "codex-memory-river/src/secret-scan.js";

export const EDIT_VERIFY_COMMAND = ["npm", "test"];

export function submitAgentTask({ agentHome, repo, request, mode = "plan", approval = "not_required", executor = "codex", chatId = null, source = "cli", requester = "local" }) {
  return createTask({ agentHome, repo, request, mode, approval, executor, chatId, source, requester });
}

export function approveAgentTask({ agentHome, id }) {
  return approveTask(agentHome, id);
}

export function rejectAgentTask({ agentHome, id }) {
  return rejectTask(agentHome, id);
}

export function getAgentStatus({ agentHome, id } = {}) {
  if (id) {
    const task = readTask(agentHome, id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }
    return { task, runs: readRuns(agentHome).filter((run) => run.task_id === id) };
  }
  return { tasks: listTasks(agentHome), runs: readRuns(agentHome), safety: getSafetyStatus(agentHome) };
}

export async function runAgentOnce({ agentHome, memoryStateHome, runner, taskId, execFileImpl } = {}) {
  const runnable = listTasks(agentHome)
    .filter((task) => !taskId || task.id === taskId)
    .filter((task) => isAdvanceable(task.status));
  const lockedRepos = new Set();
  const results = [];
  let advanced = 0;
  for (const task of runnable) {
    if (task.mode !== "plan" && task.mode !== "edit") {
      results.push(rejectNonPlanTask(agentHome, task));
      advanced += 1;
      continue;
    }
    if (!isApprovalRunnable(task.approval)) {
      continue;
    }
    if (task.status !== "queued") {
      results.push(recoverInterruptedTask(agentHome, task));
      advanced += 1;
      continue;
    }
    if (lockedRepos.has(task.repo)) {
      continue;
    }
    const guard = checkSafety(agentHome);
    if (!guard.ok) {
      results.push(parkTask(agentHome, task, guard.reason));
      continue;
    }
    lockedRepos.add(task.repo);
    if (task.mode === "edit") {
      results.push(await runEditTask({ agentHome, memoryStateHome, task, runner, execFileImpl }));
    } else {
      results.push(await runPlanOnlyTask({ agentHome, memoryStateHome, task, runner }));
    }
    advanced += 1;
  }
  return { advanced, tasks: results, safety: getSafetyStatus(agentHome) };
}

function isAdvanceable(status) {
  return status === "queued" || status === "planning" || status === "reporting";
}

function isApprovalRunnable(approval) {
  return approval === "not_required" || approval === "approved";
}

function recoverInterruptedTask(agentHome, task) {
  return transitionTask(agentHome, task, "failed", `Task was interrupted while ${task.status}.`);
}

function rejectNonPlanTask(agentHome, task) {
  return transitionTask(agentHome, task, "failed", `Refusing to run unsupported mode: ${task.mode}.`);
}

function parkTask(agentHome, task, reason) {
  const note = `Safety guard parked task: ${reason}.`;
  if (task.history.at(-1)?.note === note) {
    return task;
  }
  return recordTaskEvent(agentHome, task, note);
}

async function runPlanOnlyTask({ agentHome, memoryStateHome, task, runner }) {
  let current = transitionTask(agentHome, task, "planning", "Planning started.");
  const startedAt = new Date().toISOString();

  let contextBlock;
  let workerResult;
  try {
    contextBlock = await buildContextBlock({ memoryStateHome, repo: current.repo });
    workerResult = await runPlanStep({ task: current, contextBlock, runner });
  } catch (error) {
    // A throw (e.g. preflight or the runner failing) must not strand the task in
    // "planning". Record a sanitized run error and transition it to failed.
    appendRun(agentHome, {
      task_id: current.id,
      step: "planning",
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      exit: 1,
      codex_session: null,
      tokens: 0,
      usd_estimate: 0,
      error: redactSecrets(String(error?.message ?? "Planning threw an error.")),
    });
    return transitionTask(agentHome, current, "failed", "Planning threw an error.", {
      patch: { attempts: current.attempts + 1 },
    });
  }
  const endedAt = new Date().toISOString();

  appendRun(agentHome, {
    task_id: current.id,
    step: "planning",
    started_at: startedAt,
    ended_at: endedAt,
    exit: workerResult.exit,
    codex_session: workerResult.sessionPath,
    tokens: workerResult.tokens,
    usd_estimate: 0,
    error: workerResult.exit === 0 ? null : redactSecrets(String(workerResult.text ?? "")),
  });
  appendCost(agentHome, {
    task_id: current.id,
    step: "planning",
    tokens: workerResult.tokens,
    usd_estimate: 0,
  });

  if (workerResult.exit !== 0) {
    return transitionTask(agentHome, current, "failed", "Planning failed.", {
      codexSession: workerResult.sessionPath,
      patch: {
        attempts: current.attempts + 1,
        cost: { ...current.cost, tokens: current.cost.tokens + workerResult.tokens },
      },
    });
  }

  current = transitionTask(agentHome, current, "reporting", "Planning completed.", {
    codexSession: workerResult.sessionPath,
    patch: {
      cost: { ...current.cost, tokens: current.cost.tokens + workerResult.tokens },
      result: { ...current.result, summary: redactSecrets(String(workerResult.text ?? "")) },
    },
  });
  return transitionTask(agentHome, current, "done", "Plan-only task done.");
}

async function runEditTask({ agentHome, memoryStateHome, task, runner, execFileImpl: execFileImplArg }) {
  // Repo allowlist: only run against the policy-configured default_repo.
  const policy = getTelegramCodexPolicy(agentHome);
  const allowedRepo = policy.default_repo ? path.resolve(policy.default_repo) : null;
  if (!allowedRepo || path.resolve(task.repo) !== allowedRepo) {
    return transitionTask(agentHome, task, "failed", "Edit task repo is not in the allowlist.");
  }

  let current = transitionTask(agentHome, task, "planning", "Edit task started.");
  const startedAt = new Date().toISOString();
  const execImpl = execFileImplArg || execFile;
  // executor=opus runs via a tool-restricted headless Claude (edit-capable
  // settings, same per-chat session). executor=codex keeps the injected/default
  // runner. An injected runner (tests) always wins for either executor.
  const effectiveRunner = runner ?? (task.executor === "opus"
    ? makeOpusEditRunner({ agentHome, execFileImpl: execImpl })
    : undefined);
  const headBefore = await captureGitHead(current.repo, execImpl);

  let contextBlock;
  let workerResult;
  try {
    contextBlock = await buildContextBlock({ memoryStateHome, repo: current.repo });
    workerResult = await runEditStep({ task: current, contextBlock, runner: effectiveRunner });
  } catch (error) {
    const diffStat = await captureGitDiff(current.repo, execImpl);
    if (diffStat && isNoReplyError(error)) {
      workerResult = {
        text: "Edit changed files, but Codex produced no final reply. Wrapper verification captured the resulting diff.",
        sessionPath: null,
        exit: 0,
        tokens: 0,
      };
    } else {
      appendRun(agentHome, {
        task_id: current.id,
        step: "editing",
        started_at: startedAt,
        ended_at: new Date().toISOString(),
        exit: 1,
        codex_session: null,
        tokens: 0,
        usd_estimate: 0,
        error: redactSecrets(String(error?.message ?? "Edit task threw an error.")),
      });
      return transitionTask(agentHome, current, "failed", "Edit task threw an error.", {
        patch: { attempts: current.attempts + 1 },
      });
    }
  }
  const tests = workerResult.exit === 0
    ? await runEditVerification({ repoDir: current.repo, execImpl })
    : null;
  // Capture git state after verification so owner sees the complete worktree,
  // including any side effects from the fixed verification command.
  const headAfter = await captureGitHead(current.repo, execImpl);
  const headChanged = Boolean(headBefore && headAfter && headBefore !== headAfter);
  const diffStat = await captureGitDiff(current.repo, execImpl);
  const endedAt = new Date().toISOString();

  appendRun(agentHome, {
    task_id: current.id,
    step: "editing",
    started_at: startedAt,
    ended_at: endedAt,
    exit: headChanged ? 1 : workerResult.exit,
    codex_session: workerResult.sessionPath,
    tokens: workerResult.tokens,
    usd_estimate: 0,
    error: headChanged
      ? "Edit task changed git HEAD; commits are not allowed."
      : (workerResult.exit === 0 ? null : redactSecrets(String(workerResult.text ?? ""))),
  });
  appendCost(agentHome, {
    task_id: current.id,
    step: "editing",
    tokens: workerResult.tokens,
    usd_estimate: 0,
  });

  if (headChanged || workerResult.exit !== 0) {
    return transitionTask(agentHome, current, "failed", "Edit task failed.", {
      codexSession: workerResult.sessionPath,
      patch: {
        attempts: current.attempts + 1,
        cost: { ...current.cost, tokens: current.cost.tokens + workerResult.tokens },
        result: { ...current.result, diff_stat: diffStat || null, tests },
      },
    });
  }

  current = transitionTask(agentHome, current, "reporting", "Edit task completed.", {
    codexSession: workerResult.sessionPath,
    patch: {
      cost: { ...current.cost, tokens: current.cost.tokens + workerResult.tokens },
      result: {
        ...current.result,
        summary: redactSecrets(String(workerResult.text ?? "")),
        diff_stat: diffStat || null,
        tests,
      },
    },
  });
  return transitionTask(agentHome, current, "done", "Edit task done.");
}

function isNoReplyError(error) {
  return /Codex produced no reply/i.test(String(error?.message ?? ""));
}

function captureGitDiff(repoDir, execImpl = execFile) {
  return new Promise((resolve) => {
    execImpl("git", ["diff", "HEAD", "--stat"], { cwd: repoDir, timeout: 10000 }, (error, stdout) => {
      const raw = String(stdout || "").trim();
      // Withhold diff if it contains secret-like patterns.
      resolve(raw && scanSecrets(raw).length === 0 ? raw : "");
    });
  });
}

function captureGitHead(repoDir, execImpl = execFile) {
  return new Promise((resolve) => {
    execImpl("git", ["rev-parse", "HEAD"], { cwd: repoDir, timeout: 10000 }, (error, stdout) => {
      resolve(error ? "" : String(stdout || "").trim());
    });
  });
}

function runEditVerification({ repoDir, execImpl = execFile }) {
  const [file, ...args] = EDIT_VERIFY_COMMAND;
  const startedAt = new Date().toISOString();
  return new Promise((resolve) => {
    execImpl(file, args, {
      cwd: repoDir,
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolve({
        command: [file, ...args],
        exit: error ? (Number.isInteger(error.code) ? error.code : 1) : 0,
        passed: !error,
        stdout: safeOutput(stdout),
        stderr: safeOutput(stderr),
        started_at: startedAt,
        ended_at: new Date().toISOString(),
      });
    });
  });
}

function safeOutput(text, maxChars = 1200) {
  const raw = redactSecrets(String(text || "")).trim();
  if (!raw) {
    return "";
  }
  return raw.length > maxChars ? `${raw.slice(0, maxChars - 3)}...` : raw;
}

async function buildContextBlock({ memoryStateHome, repo }) {
  const stateHome = memoryStateHome || await resolveStateHome(undefined, { create: false });
  const result = await preflight({
    stateHome,
    repo,
    brief: true,
    maxRecent: 3,
  });
  return formatContextBlock(result, { brief: true });
}
